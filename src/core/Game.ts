import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Physics } from './Physics';
import { Input } from './Input';
import { DEG, hfovToVfov, isTouchDevice } from './math';
import { HELP_TEXT, STATIONS, loadSettings, saveSettings, stationPosition } from './LabTools';
import { playerConfig } from '../player/PlayerConfig';
import { PlayerController } from '../player/PlayerController';
import { PlayerCamera } from '../player/PlayerCamera';
import { Arena } from '../world/Arena';
import { RobotTarget } from '../targets/RobotTarget';
import { AudioSystem } from '../audio/AudioSystem';
import { ImpactSystem } from '../fx/ImpactSystem';
import { Shells } from '../fx/Shells';
import { DebugDraw } from '../fx/DebugDraw';
import { WeaponController } from '../weapons/WeaponController';
import { createWeaponDefs } from '../weapons/WeaponData';
import { HUD } from '../ui/HUD';
import { DebugHUD } from '../ui/DebugHUD';
import { TuningPanel } from '../ui/TuningPanel';
import { TouchControls } from '../ui/TouchControls';
import { feel } from '../config/Feel';
import { Haptics } from './Haptics';
import { PlayerHealth } from '../player/PlayerHealth';
import { StatusHUD } from '../ui/StatusHUD';
import { NavGrid } from '../ai/NavGrid';
import { BlackDivision } from '../enemies/BlackDivision';
import type { PlayerTarget } from '../enemies/Soldier';

const FIXED_DT = 1 / 120;
const MAX_STEPS = 6;

/**
 * Bootstraps every system and runs the frame loop.
 *
 * Per frame: input → look (+aim assist, recoil absorption) → fixed-step
 * movement & physics (120 Hz) → camera → physical weapon pose → fire from the
 * muzzle → projectiles → fx → UI → render (world, weapon, debug overlay).
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly mobile: boolean;
  readonly debugDraw = new DebugDraw();
  physics!: Physics;
  input!: Input;
  player!: PlayerController;
  camera!: PlayerCamera;
  arena!: Arena;
  robots: RobotTarget[] = [];
  audio!: AudioSystem;
  impacts!: ImpactSystem;
  shells!: Shells;
  weapons!: WeaponController;
  hud!: HUD;
  debug!: DebugHUD;
  tuning!: TuningPanel;
  touch: TouchControls | null = null;
  health = new PlayerHealth();
  status!: StatusHUD;
  nav!: NavGrid;
  squad!: BlackDivision;
  private target: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: true,
  };
  /** Lab slow motion (Z). */
  timeScale = 1;

  private accumulator = 0;
  private lastTime = 0;
  private fps = 60;
  private frameMs = 16;
  private started = false;
  /** ?nolock: run without pointer lock (automated testing / screenshots). */
  private noLock = new URLSearchParams(location.search).has('nolock');
  private quality: { pixelRatio: number; shadows: boolean };
  private stationIndex = 0;
  private helpEl!: HTMLPreElement;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private right = new THREE.Vector3();
  private aimDir = new THREE.Vector3();

  constructor(private container: HTMLElement) {
    this.mobile = isTouchDevice() || new URLSearchParams(location.search).has('touch');
    this.quality = { pixelRatio: Math.min(window.devicePixelRatio, this.mobile ? 1.5 : 2), shadows: true };
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = this.mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
  }

  async init(onProgress: (msg: string) => void): Promise<void> {
    onProgress('Starting physics…');
    this.physics = await Physics.create(FIXED_DT);
    this.input = new Input(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x15171a);
    this.scene.fog = new THREE.Fog(0x15171a, 90, 200);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.35;

    onProgress('Building arena…');
    this.arena = new Arena(this.physics, this.mobile);
    this.scene.add(this.arena.group);

    onProgress('Rendering placeholder audio…');
    this.audio = new AudioSystem();
    await this.audio.init();

    this.impacts = new ImpactSystem(this.audio, this.mobile);
    this.scene.add(this.impacts.group);
    this.shells = new Shells(this.physics, this.mobile ? 16 : 30);
    this.scene.add(this.shells.group);
    this.shells.onClink = (type, pos) => this.audio.play(type === 'shotgun' ? 'shell.plastic' : 'shell.brass', { position: pos });

    for (const opts of this.arena.robotSpawns) {
      this.robots.push(
        new RobotTarget(this.physics, this.scene, opts, {
          onDeath: (_r, at) => {
            this.audio.play('robot.death', { position: at });
            this.impacts.robotDeath(at);
            const dist = at.distanceTo(this.camera.eye);
            this.camera.addShake(Math.max(0, 0.25 - dist * 0.01));
          },
          onRespawn: (r) => this.audio.play('robot.boot', { position: r.root.position }),
          onThud: (at, strength) => this.audio.play('robot.fall', { position: at, volume: 0.35 + 0.65 * strength }),
          onStagger: (at, strength) => this.audio.play('robot.stagger', { position: at, volume: 0.5 + 0.5 * strength }),
        }),
      );
    }

    this.player = new PlayerController(this.physics, this.arena.spawn, 0);
    this.camera = new PlayerCamera(window.innerWidth / window.innerHeight);
    this.player.onLand = (speed) => {
      this.camera.landingImpact(speed);
      this.weapons.viewmodel.onLand(speed);
      this.audio.play('player.land', { volume: Math.min(1, speed / 12) });
    };
    this.player.onJump = () => {
      this.weapons.viewmodel.onJump();
      this.audio.play('player.jump');
    };

    const ui = document.createElement('div');
    ui.className = 'ui-layer';
    this.container.appendChild(ui);
    this.hud = new HUD(ui);
    this.debug = new DebugHUD(ui);
    this.helpEl = document.createElement('pre');
    this.helpEl.className = 'help';
    this.helpEl.textContent = HELP_TEXT;
    ui.appendChild(this.helpEl);

    this.weapons = new WeaponController(createWeaponDefs(), window.innerWidth / window.innerHeight, {
      physics: this.physics,
      player: this.player,
      camera: this.camera,
      audio: this.audio,
      impacts: this.impacts,
      shells: this.shells,
      hud: this.hud,
      worldScene: this.scene,
      debugDraw: this.debugDraw,
    });
    this.weapons.viewmodel.scene.environment = env;
    this.status = new StatusHUD(ui);
    this.initBlackDivision();
    this.weapons.viewmodel.scene.environmentIntensity = 0.6;

    this.tuning = new TuningPanel({
      getWeapon: () => this.weapons.current.data,
      getAmmoId: () => this.weapons.current.data.ammo,
      onWeaponTuned: () => this.weapons.refreshHandling(),
      onFeelChanged: () => this.audio.setVolume(feel.masterVolume),
      refillAmmo: () => this.weapons.refillAll(),
      setQuality: (pr, shadows) => this.setQuality(pr, shadows),
      quality: this.quality,
    });
    this.tuning.syncWeapon();

    if (this.mobile) {
      this.touch = new TouchControls(ui, this.input, this.weapons.weapons.map((w) => w.data.short), {
        onTune: () => this.tuning.toggle(),
        onDebug: () => this.debug.toggle(),
        onRays: () => this.toggleRays(),
        onLaser: () => this.toggleLaser(),
        onFireMode: () => this.weapons.cycleFireMode(),
      });
    }

    // Restore lab conveniences from the last session.
    const s = loadSettings();
    this.debugDraw.enabled = !!s.rays;
    this.weapons.laser.enabled = !!s.laser;
    this.debug.setVisible(s.debugHud ?? !this.mobile);
    this.helpEl.classList.toggle('show', s.help ?? true);
    if (s.weapon && s.weapon > 0 && s.weapon < this.weapons.weapons.length) this.weapons.requestSwitch(s.weapon);

    this.input.onKey = (code) => this.onKey(code);
    this.input.onLockFailed = () =>
      this.hud.toast('Mouse lock unavailable here: free-mouse mode (move mouse to look, click to fire). For best control open http://localhost:5173 in Chrome/Edge.', 6);
    window.addEventListener('resize', () => this.onResize());

    // Compile all shaders up front so the first shot never hitches.
    onProgress('Compiling shaders…');
    this.renderer.compile(this.scene, this.camera.camera);
    this.renderer.compile(this.weapons.viewmodel.scene, this.weapons.viewmodel.camera);
    (window as unknown as { __lab: Game }).__lab = this;
  }

  /** Enemy squad, navigation, player hitbox + damage feedback. */
  private initBlackDivision(): void {
    const [x0, z0, x1, z1] = this.arena.navBounds;
    const blockers = this.arena.robotSpawns.filter((r) => !r.rail && r.position.y < 0.5).map((r) => ({ pos: r.position, radius: 0.45 }));
    this.nav = new NavGrid(this.physics, x0, z0, x1, z1, 0.5, 0.32, blockers);
    this.squad = new BlackDivision(
      {
        physics: this.physics,
        nav: this.nav,
        projectiles: this.weapons.projectiles,
        impacts: this.impacts,
        shells: this.shells,
        audio: this.audio,
        scene: this.scene,
      },
      this.arena.patrolRoute,
      this.arena.squadSpawnIndex,
      () => this.camera.eye,
    );
    this.squad.onRadio = (text) => this.status.radio(text);
    this.weapons.onPlayerShot = (pos, suppressed) => {
      if (feel.enemyAI && !this.health.dead) this.squad.hearShot(pos, suppressed);
    };

    // The player's capsule takes enemy rounds.
    const from = new THREE.Vector3();
    this.physics.receivers.set(this.player.colliderHandle, {
      surface: 'player',
      owner: this.player,
      allowDecals: false,
      onBulletHit: (hit, out) => {
        const dealt = this.health.damage(hit.damage);
        out.damage = dealt;
        out.health = this.health.health;
        out.maxHealth = this.health.max;
        out.killed = this.health.dead;
        if (dealt <= 0) return;
        from.copy(hit.point).addScaledVector(hit.direction, -Math.max(2, hit.distance));
        this.status.damaged(dealt, from);
        this.audio.play('player.hurt', { volume: 0.6 + dealt / 60 });
        // Being hit knocks the aim (aim punch) and shakes the view.
        const side = Math.random() < 0.5 ? -1 : 1;
        this.player.pitch += 0.012 + Math.random() * 0.012;
        this.player.yaw += side * (0.008 + Math.random() * 0.01);
        this.camera.addPunch(0.05, side * 0.03, side * 0.06);
        this.camera.addShake(0.35);
        Haptics.pulse(70);
      },
    });
    this.weapons.projectiles.listener = this.camera.eye;
    this.weapons.projectiles.onFlyby = (_point, dist, speed) => {
      const k = 1 - dist / 2.6;
      this.audio.play(speed > 340 ? 'bullet.flyby' : 'bullet.whizz', { volume: 0.5 + 0.5 * k });
      this.status.suppress(0.18 + 0.3 * k);
      this.camera.addShake(0.05 + 0.08 * k);
    };
    this.health.onDeath = () => {
      this.audio.play('player.death');
      this.status.setDead(true);
      this.camera.addShake(0.6);
      this.squad.onPlayerKilled();
    };
    this.health.onRespawn = () => {
      this.status.setDead(false);
      this.player.teleport(this.arena.spawn, 0);
      this.weapons.refillAll();
    };
  }

  /** Called from the start overlay click/tap/Enter (a user gesture). */
  start(): void {
    this.audio.unlock();
    if (!this.mobile) this.input.requestPointerLock();
    else {
      const el = document.documentElement;
      el.requestFullscreen?.().catch(() => {});
      (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }
    if (!this.started) {
      this.started = true;
      this.lastTime = performance.now();
      this.renderer.setAnimationLoop((t) => this.frame(t));
    }
  }

  get isPaused(): boolean {
    return !this.mobile && !this.input.mouseActive && !this.noLock;
  }

  private onKey(code: string): void {
    const w = this.weapons;
    switch (code) {
      case 'KeyH':
        this.debug.toggle();
        break;
      case 'Tab':
      case 'KeyP':
        if (this.tuning.toggle()) document.exitPointerLock();
        else this.input.requestPointerLock();
        break;
      case 'F1':
      case 'Slash':
        this.helpEl.classList.toggle('show');
        break;
      case 'KeyN':
        feel.damageNumbers = !feel.damageNumbers;
        this.hud.toast(`Damage numbers ${feel.damageNumbers ? 'on' : 'off'}`);
        break;
      case 'KeyG':
        this.hud.toast(`Aim rays ${this.toggleRays() ? 'on' : 'off'}`);
        break;
      case 'KeyL':
        this.hud.toast(`Laser ${this.toggleLaser() ? 'on' : 'off'}`);
        break;
      case 'KeyJ':
        feel.debugCrosshair = !feel.debugCrosshair;
        this.hud.toast(`Debug crosshair ${feel.debugCrosshair ? 'on' : 'off'}`);
        break;
      case 'KeyB':
        w.cycleFireMode();
        break;
      case 'KeyV':
        w.toggleShoulder();
        break;
      case 'KeyT':
        w.inspect();
        break;
      case 'BracketLeft':
        w.adjustZero(-1);
        break;
      case 'BracketRight':
        w.adjustZero(1);
        break;
      case 'KeyZ':
        this.timeScale = this.timeScale === 1 ? 0.25 : 1;
        this.hud.toast(this.timeScale === 1 ? 'Normal speed' : 'Slow motion x0.25');
        break;
      case 'KeyI':
        feel.infiniteAmmo = !feel.infiniteAmmo;
        if (feel.infiniteAmmo) w.refillAll();
        this.hud.toast(`Infinite ammo ${feel.infiniteAmmo ? 'on' : 'off'}`);
        break;
      case 'KeyK':
        for (const r of this.robots) r.forceRespawn();
        this.hud.toast('Robots reset');
        break;
      case 'KeyM':
        this.gotoStation(this.stationIndex + 1);
        break;
      case 'KeyY':
        this.squad.spawn();
        this.hud.toast('Black Division squad respawned (yard)');
        break;
      case 'KeyO':
        feel.godMode = !feel.godMode;
        this.hud.toast(`God mode ${feel.godMode ? 'on' : 'off'}`);
        break;
      case 'KeyU':
        feel.enemyAI = !feel.enemyAI;
        this.hud.toast(`Enemy AI ${feel.enemyAI ? 'on' : 'ignores you'}`);
        break;
    }
    this.persist();
  }

  gotoStation(i: number): void {
    this.stationIndex = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length;
    const st = STATIONS[this.stationIndex];
    this.player.teleport(stationPosition(this.stationIndex), st.yaw);
    this.hud.toast(`Station: ${st.name}`);
  }

  private persist(): void {
    saveSettings({
      rays: this.debugDraw.enabled,
      laser: this.weapons.laser.enabled,
      debugHud: this.debug.visible,
      weapon: this.weapons.currentIndex,
      help: this.helpEl.classList.contains('show'),
    });
  }

  /** Debug aim rays: camera ray, bore ray, muzzle vector, wall probes, bullet paths. */
  toggleRays(): boolean {
    this.debugDraw.enabled = !this.debugDraw.enabled;
    this.persist();
    return this.debugDraw.enabled;
  }

  toggleLaser(): boolean {
    this.weapons.laser.enabled = !this.weapons.laser.enabled;
    this.persist();
    return this.weapons.laser.enabled;
  }

  private setQuality(pixelRatio: number, shadows: boolean): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = shadows;
    this.arena.sun.castShadow = shadows;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.camera.aspect = w / h;
    this.camera.camera.updateProjectionMatrix();
    this.weapons.viewmodel.setAspect(w / h);
  }

  private frame(now: number): void {
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp: never negative (clock hiccups) and never huge (tab switch, breakpoints).
    const realDt = Math.min(Math.max(rawDt, 0), 0.1);
    const dt = realDt * this.timeScale;
    this.fps += (1 / Math.max(rawDt, 1e-4) - this.fps) * 0.05;
    this.frameMs += (rawDt * 1000 - this.frameMs) * 0.05;

    const input = this.input;
    input.mouseSensitivity = playerConfig.mouseSensitivity;
    input.beginFrame();
    if (this.isPaused || (this.input.lockFailed && this.tuning.visible) || this.health.dead) {
      // Mouse released (Esc / tuning panel): freeze the player, keep the world simulating.
      input.moveX = input.moveY = 0;
      input.fireHeld = input.firePressed = false;
      input.lookYaw = input.lookPitch = 0;
    }

    // --- Look: ADS sensitivity scaling, touch aim assist, recoil absorption ---
    const fovScale = Math.tan((this.camera.currentFov * DEG) / 2) / Math.tan((hfovToVfov(playerConfig.baseFov) * DEG) / 2);
    let yaw = input.lookYaw * fovScale;
    let pitch = input.lookPitch * fovScale;
    if (input.lookFromTouch) [yaw, pitch] = this.applyAimAssist(yaw, pitch);
    [yaw, pitch] = this.weapons.recoil.absorb(yaw, pitch);
    this.player.updateLook(yaw, pitch);
    this.player.bufferInput(input);

    // --- Fixed-step simulation ---
    this.accumulator += dt;
    let steps = 0;
    // Small tolerance: at 60 fps two 120 Hz steps fit exactly; float error must not
    // turn that into an alternating 1-step / 3-step pattern (visible micro-stutter).
    while (this.accumulator >= FIXED_DT - 1e-6 && steps < MAX_STEPS) {
      this.player.fixedUpdate(FIXED_DT, input);
      for (const r of this.robots) r.fixedUpdate(FIXED_DT);
      this.physics.step();
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    const alpha = Math.min(1, Math.max(0, this.accumulator / FIXED_DT));
    this.physics.syncObjects();

    // --- Camera first, then aim the physical weapon, then fire from its muzzle ---
    const w = this.weapons.current;
    this.weapons.updateState(dt, input);
    this.camera.update(dt, alpha, this.player, this.weapons.adsAmount, w.data.sight.adsFov);
    this.camera.camera.updateMatrixWorld();
    // Look deltas are per real frame; in slow motion the weapon sees the same turn rate.
    this.weapons.updatePose(dt, yaw * this.timeScale, pitch * this.timeScale);
    this.weapons.updateFire(dt, input);

    // --- World ---
    this.arena.update();
    for (const r of this.robots) r.update(dt);
    const t = this.target;
    t.feet.copy(this.player.feet);
    t.head.copy(this.camera.eye);
    t.chest.set(t.feet.x, t.feet.y + this.player.eyeHeight - 0.42, t.feet.z);
    t.velocity.copy(this.player.velocity);
    t.sprinting = this.player.sprinting;
    t.crouching = this.player.crouching;
    t.alive = !this.health.dead;
    this.squad.update(dt, t, feel.enemyAI);
    this.health.update(dt);
    this.shells.update(dt);
    this.impacts.update(dt);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.camera.quaternion);
    this.audio.setListener(this.camera.camera.position, this.right);

    // --- UI ---
    const cw = this.weapons.current;
    const reload = cw.state === 'reloading' ? (cw.data.reload.kind === 'magazine' ? cw.stateProgress : cw.ammo / cw.data.magazineSize) : -1;
    this.hud.updateAmmo(cw.data.name, cw.ammo, cw.chambered && cw.data.closedBolt, cw.data.magazineSize, `${cw.fireMode.toUpperCase()} · ${this.weapons.ammo.caliber}`, reload);
    this.hud.updateCrosshair(this.weapons.handling.dispersionDeg * 0.5, this.camera.currentFov, this.weapons.adsAmount, cw.state !== 'ready' || this.player.sprinting);
    this.hud.update(realDt, this.camera.camera);
    this.status.update(realDt, this.health.health, this.health.max, this.camera.camera);
    this.status.setSquadLine(this.squad.statusText);
    this.tuning.syncWeapon();
    this.touch?.sync(input.adsHeld, this.weapons.currentIndex);

    // --- Render: world, then the weapon on top, then debug lines over everything ---
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.weapons.viewmodel.scene, this.weapons.viewmodel.camera);
    this.debugDraw.flush(realDt);
    if (this.debugDraw.enabled) this.renderer.render(this.debugDraw.scene, this.camera.camera);

    if (this.debug.visible) {
      const h = cw.data.handling;
      const p = this.player;
      this.debug.update(realDt, {
        fps: this.fps,
        frameMs: this.frameMs,
        weapon: cw.data.name,
        state: cw.state + (cw.state === 'reloading' && cw.reloadEmpty ? ' (empty)' : ''),
        ammo: `${cw.ammo}${cw.data.closedBolt && cw.chambered ? '+1' : ''} / ${cw.data.magazineSize}`,
        fireMode: cw.fireMode,
        ammoType: this.weapons.ammo.name,
        rpm: cw.data.fireRate,
        weight: h.weight,
        length: h.length,
        ergonomics: h.ergonomics,
        moment: this.weapons.handling.moment,
        stamina: this.weapons.stamina,
        adsTime: this.weapons.viewmodel.adsTimeNow,
        ads: this.weapons.adsAmount,
        cameraDir: this.weapons.cameraAimDir,
        muzzleDir: this.weapons.muzzleDir,
        aimError: this.weapons.aimErrorDeg,
        recoil: this.weapons.viewmodel.recoilDeg,
        inertia: this.weapons.viewmodel.inertiaDeg,
        sway: this.weapons.viewmodel.swayDeg,
        speed: p.horizontalSpeed,
        grounded: p.grounded,
        stance: `${p.crouching ? 'crouch' : 'stand'}${Math.abs(p.lean) > 0.05 ? ` lean ${p.lean > 0 ? 'R' : 'L'} ${(Math.abs(p.lean) * 100).toFixed(0)}%` : ''}${this.weapons.shoulder < 0 ? ' L-shoulder' : ''}`,
        moa: cw.data.accuracy.moa * this.weapons.ammo.accuracyModifier,
        muzzleVelocity: this.weapons.lastMuzzleVelocity,
        impactSpeed: this.weapons.projectiles.lastImpactSpeed,
        zero: cw.data.aim.zeroDistance,
        wall: this.weapons.wallState,
        hitDistance: this.weapons.lastHitDistance,
        lastDamage: this.weapons.lastDamage,
        targetHealth: this.weapons.lastTargetHealth,
        drawCalls: this.renderer.info.render.calls,
        particles: this.impacts.sparks.alive + this.impacts.dust.alive,
        projectiles: this.weapons.projectiles.active,
        timeScale: this.timeScale,
      });
    }

    input.endFrame();
  }

  /**
   * Touch aim assist: slows look speed when the camera is over a robot
   * ("friction"). Mouse input is never assisted.
   */
  private applyAimAssist(yaw: number, pitch: number): [number, number] {
    const strength = playerConfig.touchAimAssist;
    if (strength <= 0) return [yaw, pitch];
    this.camera.getAimDirection(this.player, this.aimDir);
    const eye = this.camera.eye;
    let best = 0;
    const points: THREE.Vector3[] = [];
    for (const r of this.robots) if (r.alive) points.push(r.chestPoint.getWorldPosition(new THREE.Vector3()));
    for (const s of this.squad.soldiers) if (s.alive) points.push(s.chestPos.clone());
    for (const p of points) {
      this.tmp.copy(p);
      const toTarget = this.tmp2.subVectors(this.tmp, eye);
      const dist = toTarget.length();
      if (dist > 60) continue;
      toTarget.divideScalar(dist);
      const angle = Math.acos(Math.min(1, toTarget.dot(this.aimDir)));
      const radius = Math.max(2.5 * DEG, Math.atan(0.7 / dist));
      if (angle < radius) best = Math.max(best, 1 - angle / radius);
    }
    const friction = 1 - best * strength * 0.6;
    return [yaw * friction, pitch * friction];
  }
}
