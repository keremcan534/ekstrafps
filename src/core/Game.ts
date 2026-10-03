import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { GROUPS, Physics } from './Physics';
import { Input } from './Input';
import { DEG, controlPreference, hfovToVfov, isTouchDevice } from './math';
import { HELP_TEXT, loadSettings, saveSettings } from './LabTools';
import { playerConfig } from '../player/PlayerConfig';
import { PlayerController } from '../player/PlayerController';
import { PlayerCamera } from '../player/PlayerCamera';
import { Arena } from '../world/Arena';
import { Site9 } from '../world/Site9';
import type { GameMap } from '../world/GameMap';
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
import type { PlayerTarget, SoldierDeps } from '../enemies/Soldier';
import { TeamAgent, agentBySoldier, randomPersonality, type Combatant } from '../game/TeamAgent';
import { SIDEARM, planErrand } from '../game/Errands';
import { planFor } from '../game/Plans';
import { assignRevives } from '../game/AITeam';
import { TeamMatch } from '../game/TeamMatch';
import { RogueRobot } from '../enemies/RogueRobot';
import { AI_TUNING } from '../ai/Tuning';
import { skinDetail } from '../enemies/SoldierSkin';
import { aiWorld } from '../ai/World';
import { SquadBrain } from '../ai/Squad';
import { AIDebug } from '../ai/AIDebug';
import { coverRegistry } from '../ai/Cover';
import type { Bot } from '../ai/Bot';
import { AITest } from '../ai/AITest';
import { START_POINTS, Survival } from '../game/Survival';
import { SurvivalHUD } from '../ui/SurvivalHUD';
import { MapOverlay, type MapState } from '../ui/MapOverlay';
import { ScreenGrade } from '../fx/ScreenGrade';
import { MuzzleLights } from '../fx/MuzzleLights';
import { Lighting } from '../game/Lighting';
import { buildWeaponModel } from '../weapons/WeaponModels';
import { WeaponLights, weaponLight } from '../fx/WeaponLights';
import { VIEW_DISTANCE, loadGraphics, type GraphicsSettings } from '../config/Graphics';
import { DustMotes } from '../fx/DustMotes';
import { Ambience } from '../audio/Ambience';
import { raid } from '../game/Progress';
import { Inhabitants } from '../game/Inhabitants';
import type { ShowcaseDeps } from '../ui/Showcase';

const FIXED_DT = 1 / 120;

/** Small tileable monochrome noise for the film-grain overlay. */
function grainDataUrl(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}
const MAX_STEPS = 6;

/**
 * Trailer capture (?trailer): a director drives frames on a fixed clock, can
 * script input, override the camera after the gameplay camera runs, and take
 * over the final render (post chain). All hooks are inert without a director.
 */
export interface FrameDirector {
  input(input: Input, dt: number): void;
  afterCamera(dt: number): void;
  render(): boolean;
}

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
  /** The loaded map (?map=site9 → Site-9, default: Weapon Lab arena). */
  arena!: GameMap;
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
  squads: BlackDivision[] = [];
  survival: Survival | null = null;
  /** Hired contractors (your team). */
  allies: TeamAgent[] = [];
  /** Site-9 team race (?mode=teams, the default there). */
  match: TeamMatch | null = null;
  /** Match over: the end screen owns the mouse. */
  ended = false;
  /** Everyone who fights this frame: you, allies, AI teams, raiders, robots. */
  private world: Combatant[] = [];
  private playerC!: Combatant;
  private robotC = new Map<RogueRobot, Combatant>();
  private playerRevive = {
    pos: new THREE.Vector3(),
    revive: () => this.health.revive(),
    downed: false,
  };
  private giveUpBtn: HTMLButtonElement | null = null;
  /** Facility power + flashlight (Site-9). */
  lighting: Lighting | null = null;
  /** Lab staff and The Choir (Site-9). */
  inhabitants: Inhabitants | null = null;
  private prey = { feet: new THREE.Vector3(), eye: new THREE.Vector3(), look: new THREE.Vector3(0, 0, -1), alive: true };
  /** You picking a downed operator up. */
  private reviving: { a: TeamAgent; t: number } | null = null;
  private reviveBar: HTMLDivElement | null = null;
  /** free: your operators farm, buy and open doors on their own (staying within reach); follow: they stick to you. */
  squadMode: 'free' | 'follow' = new URLSearchParams(location.search).get('mode') === 'solo' ? 'follow' : 'free';
  private planTimer = 1;
  private stepDist = 0;
  private squadBtn: HTMLButtonElement | null = null;
  /** Your operators' shared priority target. */
  /** Your squad's tactical brain (you are its leader). */
  allySquad: SquadBrain | null = null;
  /** AI debug view (F4 with ?dev, or ?aidebug). */
  aiDebug!: AIDebug;
  /** ?aitest=A..J: controlled AI scenarios (Weapon Lab). */
  aiTest: AITest | null = null;
  /** Spectating an AI test: free camera, no weapon. */
  spectator = false;
  /** Physics step (120 Hz; 60 Hz on phones). */
  private fixedDt = FIXED_DT;
  /** Phones: dynamic resolution (fraction of the quality preset's pixel ratio). */
  private dyn = { t: 0, acc: 0, n: 0, cooldown: 2, scale: 1 };
  /** Frame cap: earliest timestamp for the next frame. */
  private nextFrameAt = 0;
  private prevWeaponState = '';
  private lastImpactShare = 0;
  /** Your squad: name, role, money, weapon. */
  private squadEl: HTMLDivElement | null = null;
  private squadTimer = 0;
  private errandTimer = 0;
  /** The three operators you start with (they come back when you redeploy, or as reinforcements). */
  private core: TeamAgent[] = [];
  private coreDeadTime = new Map<TeamAgent, number>();
  private soldierDeps!: SoldierDeps;
  private muzzleLights!: MuzzleLights;
  private weaponLights!: WeaponLights;
  private grade: ScreenGrade | null = null;
  mapOverlay: MapOverlay | null = null;
  private mapState: MapState | null = null;
  private target: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: true,
  };
  /** Lab slow motion (Z). */
  timeScale = 1;
  /** ?trailer: capture mode (deterministic clock, no HUD); the director attaches here. */
  readonly trailer = new URLSearchParams(location.search).has('trailer');
  director: FrameDirector | null = null;
  /** Scripted camera (extraction cinematic): the view follows it; your input, hands and HUD are off. */
  cinematic: ((dt: number) => { pos: THREE.Vector3; target: THREE.Vector3; fov: number }) | null = null;

  private accumulator = 0;
  private lastTime = 0;
  private fps = 60;
  private frameMs = 16;
  private started = false;
  /** ?nolock: run without pointer lock (automated testing / screenshots). */
  private noLock = new URLSearchParams(location.search).has('nolock') || new URLSearchParams(location.search).has('trailer');
  private quality: { pixelRatio: number; shadows: boolean };
  /** Settings → Graphics (applyGraphics). */
  private gfx: GraphicsSettings;
  /** Image-based lighting (lighting: full) and its cheap stand-in (lighting: fast). */
  private env: THREE.Texture | null = null;
  private probe = new THREE.LightProbe(undefined, 0);
  private fpsEl: HTMLDivElement | null = null;
  /** Dust hanging in the air around you. */
  private dust!: DustMotes;
  /** Room tone, machines, wind; the building creaking in the dark. */
  private ambience: Ambience | null = null;
  private prevBroken = 0;
  private fpsTimer = 0;
  private stationIndex = 0;
  private helpEl!: HTMLPreElement;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private right = new THREE.Vector3();
  private aimDir = new THREE.Vector3();

  constructor(private container: HTMLElement) {
    const pref = controlPreference();
    const params = new URLSearchParams(location.search);
    this.mobile = params.has('touch') || (!params.has('mouse') && (pref === 'mobile' || (pref === 'auto' && isTouchDevice())));
    // Phones: no realtime sun shadows by default (the shadow pass costs a draw per caster;
    // contact shadows still ground everything). Tuning panel can turn them back on.
    this.gfx = loadGraphics(this.mobile);
    this.quality = { pixelRatio: this.gfx.resolution, shadows: this.gfx.shadows !== 'off' };
    if (this.mobile) {
      // Phones: cheaper characters, 60 Hz physics, a lighter AI schedule.
      skinDetail.low = true;
      this.fixedDt = 1 / 60;
      AI_TUNING.rayBudgetPerFrame = 40;
      AI_TUNING.perceptionInterval = 0.15;
      AI_TUNING.decisionInterval = 0.28;
      AI_TUNING.squadInterval = 0.6;
    }
    const antialias = params.has('trailer') ? !this.mobile : this.gfx.antialias;
    this.renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('trailer') });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = this.mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
  }

  async init(onProgress: (msg: string) => void): Promise<void> {
    onProgress('Starting physics…');
    this.physics = await Physics.create(this.fixedDt);
    this.input = new Input(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    this.env = env;
    // Lighting "fast": the same room light as spherical harmonics (a few multiply-adds per
    // pixel instead of cube-map lookups). Same fill, no reflections.
    const cube = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType });
    new THREE.CubeCamera(0.1, 100, cube).update(this.renderer, room);
    this.probe.copy(await LightProbeGenerator.fromCubeRenderTarget(this.renderer, cube));
    cube.dispose();
    this.scene.add(this.probe);
    this.scene.environment = this.gfx.lighting === 'full' ? env : null;
    this.scene.environmentIntensity = 0.35;

    onProgress('Building map…');
    const mapId = new URLSearchParams(location.search).get('map');
    this.arena = mapId === 'site9' ? new Site9(this.physics, this.mobile) : new Arena(this.physics, this.mobile);
    this.scene.add(this.arena.group);
    this.arena.sun.castShadow = this.quality.shadows;
    this.scene.background = new THREE.Color(this.arena.skyColor);
    this.renderer.toneMappingExposure = this.arena.exposure ?? 1.05;
    // View distance: fewer distant rooms drawn, a closer haze hides where they stop.
    const vd = VIEW_DISTANCE[this.gfx.viewDistance];
    this.scene.fog = new THREE.Fog(this.arena.skyColor, vd.fogNear, vd.fogFar);
    this.dust = new DustMotes(this.mobile ? 220 : 600);
    this.scene.add(this.dust.points);

    onProgress('Rendering placeholder audio…');
    this.audio = new AudioSystem();
    await this.audio.init();
    // Sound through walls: one ray from your ear to the source (a little above it, so a
    // waist-high counter doesn't count as a wall).
    const occ = new THREE.Vector3();
    this.audio.occlusion = (at) => (this.physics.lineOfSight(this.camera.eye, occ.copy(at).setY(Math.max(at.y, 0.6) + 0.4), GROUPS.sight) ? 0 : 1);

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

    this.player = new PlayerController(this.physics, this.arena.spawn, this.arena.spawnYaw);
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

    // Subtle camera look: vignette + animated film grain (pure CSS, no post pass).
    const post = document.createElement('div');
    post.className = 'post-fx';
    post.style.backgroundImage = `url(${grainDataUrl()})`;
    this.container.appendChild(post);
    const vignette = document.createElement('div');
    vignette.className = 'post-vignette';
    this.container.appendChild(vignette);
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
    if (this.arena instanceof Site9) this.initSurvival(ui, this.arena);
    this.applyGraphics(this.gfx);
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
        onUse: this.survival ? () => this.useAction() : undefined,
        onMap: this.mapOverlay ? () => this.mapOverlay?.toggle() : undefined,
      }, !!this.survival);
      this.mapOverlay?.onMiniTap(() => this.mapOverlay?.toggle());
    }

    // Restore lab conveniences from the last session.
    const s = loadSettings();
    this.debugDraw.enabled = !!s.rays;
    this.weapons.laser.enabled = !!s.laser;
    const dev = new URLSearchParams(location.search).has('dev');
    this.debug.setVisible(dev && (s.debugHud ?? true));
    this.helpEl.classList.toggle('show', dev && (s.help ?? true));
    if (!this.weapons.owned && s.weapon && s.weapon > 0 && s.weapon < this.weapons.weapons.length) this.weapons.requestSwitch(s.weapon);

    // Tactical AI: who owns a bullet, what's lit, and the debug view.
    aiWorld.resolveOwner = (owner) => this.resolveOwner(owner);
    aiWorld.isLit = (c) => c === this.playerC && !!this.lighting?.flashlightOn;
    this.aiDebug = new AIDebug(ui, this.camera.camera, () => this.allBots());
    if (new URLSearchParams(location.search).has('aidebug')) this.aiDebug.toggle();
    if (!this.survival && new URLSearchParams(location.search).has('aitest')) {
      this.aiTest = new AITest(this.aiTestDeps(), new URLSearchParams(location.search).get('aitest') || 'A');
    }

    this.input.onKey = (code) => this.onKey(code);
    this.input.onLockFailed = () =>
      this.hud.toast('Mouse capture unavailable: free-mouse look. Click the game to try again.', 4);
    window.addEventListener('resize', () => this.onResize());

    // Compile all shaders up front so the first shot never hitches.
    onProgress('Compiling shaders…');
    // Every weapon model an AI might buy, compiled now instead of on the first purchase.
    const warm = new THREE.Group();
    for (const w of this.weapons.weapons) warm.add(buildWeaponModel(w.data.model).root);
    warm.position.copy(this.camera.eye).y -= 50;
    this.scene.add(warm);
    // compile() skips invisible objects: pooled robots, muzzle flashes and culled
    // rooms would otherwise compile on first sight (a visible hitch mid-fight).
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.camera.camera);
    // compile() doesn't build the shadow-map (depth) programs or the final lit
    // variants with shadows: one real render while everything is visible does.
    this.camera.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera.camera);
    for (const o of hidden) o.visible = false;
    this.scene.remove(warm);
    this.renderer.compile(this.weapons.viewmodel.scene, this.weapons.viewmodel.camera);
    (window as unknown as { __lab: Game }).__lab = this;
  }

  /** Enemy squad, navigation, player hitbox + damage feedback. */
  private initBlackDivision(): void {
    const [x0, z0, x1, z1] = this.arena.navBounds;
    const blockers = this.arena.robotSpawns.filter((r) => !r.rail && r.position.y < 0.5).map((r) => ({ pos: r.position, radius: 0.45 }));
    this.nav = new NavGrid(this.physics, x0, z0, x1, z1, 0.5, 0.32, blockers);
    this.muzzleLights = new MuzzleLights(this.mobile ? 0 : 2);
    this.scene.add(this.muzzleLights.group);
    // Black Division rifle lights: a fixed pool of real spots (phones: beams only).
    this.weaponLights = new WeaponLights(this.mobile ? 0 : 4);
    this.scene.add(this.weaponLights.group);
    this.soldierDeps = {
      muzzleLights: this.muzzleLights,
      listener: this.camera.eye,
      physics: this.physics,
      nav: this.nav,
      projectiles: this.weapons.projectiles,
      impacts: this.impacts,
      shells: this.shells,
      audio: this.audio,
      scene: this.scene,
      lowSpec: this.mobile,
      weaponData: (id) => this.weapons.weapons.find((w) => w.data.id === id)?.data,
    };
    for (const spawn of this.arena.squads) {
      const squad = new BlackDivision(
        this.soldierDeps,
        spawn.route,
        spawn.spawnIndex,
        () => this.camera.eye,
      );
      squad.onRadio = (text) => this.status.radio(text);
      this.squads.push(squad);
    }
    this.weapons.onPlayerShot = (pos, suppressed) => {
      aiWorld.emit(suppressed ? 'gunshot_sup' : 'gunshot', pos, 'alpha', this.player);
      if (feel.enemyAI && !this.health.dead) for (const s of this.squads) s.hearShot(pos, suppressed);
      this.survival?.hearShot(pos, suppressed);
      if (!suppressed) this.match?.playerShot(pos);
    };

    // Your rounds landing: your squad looks there (rate limited).
    this.weapons.projectiles.onPlayerImpact = (point, owner) => {
      if (!this.allySquad || aiWorld.time - this.lastImpactShare < 0.4) return;
      this.lastImpactShare = aiWorld.time;
      const who = aiWorld.resolveOwner(owner ?? null);
      this.allySquad.playerFiresAt(point, who && who.team !== 'alpha' ? who : null);
    };

    // The player's capsule takes enemy rounds.
    const from = new THREE.Vector3();
    this.physics.receivers.set(this.player.colliderHandle, {
      surface: 'player',
      owner: this.player,
      allowDecals: false,
      onBulletHit: (hit, out) => {
        from.copy(hit.point).addScaledVector(hit.direction, -Math.max(2, hit.distance));
        const wasUp = !this.health.downed && !this.health.dead;
        out.damage = this.hurtPlayer(hit.damage, from);
        // Your squad hears you taking fire (and roughly from where).
        if (out.damage > 0) this.allySquad?.playerHurt(from, aiWorld.resolveOwner(hit.owner ?? null));
        if (this.survival && hit.team && hit.team !== 'alpha' && out.damage > 0) {
          const dropped = wasUp && (this.health.downed || this.health.dead);
          this.survival.award(hit.team, dropped ? 150 : 10);
          if (dropped) this.match?.feedPlayer(hit.team);
        }
        out.health = this.health.health;
        out.maxHealth = this.health.max;
        out.killed = this.health.dead;
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
      this.status.setDowned(-1);
      this.camera.die();
      for (const s of this.squads) s.onPlayerKilled();
    };
    this.health.onRespawn = () => {
      this.status.setDead(false);
      this.camera.revive();
      this.player.teleport(this.arena.spawn, this.arena.spawnYaw);
      this.weapons.refillAll();
    };
  }

  /** One HUD line for all squads: operators alive and the most alert state. */
  private squadStatus(): string {
    if (!this.squads.length) return '';
    let alive = 0;
    let total = 0;
    for (const s of this.squads) {
      alive += s.aliveCount;
      total += s.soldiers.length;
    }
    const state = this.squads.some((s) => s.state === 'combat') ? 'COMBAT' : this.squads.some((s) => s.state === 'search') ? 'SEARCH' : 'PATROL';
    return `BLACK DIVISION ${alive}/${total} · ${state}`;
  }

  /** Damage the player with all the feedback (vignette, direction, aim punch, sound). */
  hurtPlayer(damage: number, from: THREE.Vector3): number {
    const dealt = this.health.damage(damage);
    if (dealt <= 0) return 0;
    this.status.damaged(dealt, from);
    this.audio.play('player.hurt', { volume: 0.6 + dealt / 60 });
    // Being hit knocks the aim (aim punch) and shakes the view.
    const side = Math.random() < 0.5 ? -1 : 1;
    this.player.pitch += 0.012 + Math.random() * 0.012;
    this.player.yaw += side * (0.008 + Math.random() * 0.01);
    this.camera.addPunch(0.05, side * 0.03, side * 0.06);
    this.camera.addShake(0.35);
    Haptics.pulse(70);
    this.survival?.onPlayerDamaged(dealt);
    return dealt;
  }

  /** Site-9: Zombies economy + Left 4 Dead director, map + minimap. */
  private initSurvival(ui: HTMLElement, map: Site9): void {
    const hud = new SurvivalHUD(ui, this.mobile);
    const teams = new URLSearchParams(location.search).get('mode') !== 'solo';
    this.playerC = this.makePlayerC();
    // Your squad's tactical brain: you lead it (formation around you, out of your fire lane).
    this.allySquad = new SquadBrain('alpha', true, this.nav, () => ({
      pos: this.player.feet,
      yaw: this.player.yaw + Math.PI,
      speed: this.player.horizontalSpeed,
      alive: !this.health.dead,
    }));
    this.lighting = new Lighting(this.scene, map, this.camera.eye, (out) => this.camera.getAimDirection(this.player, out), () => !this.health.dead, this.mobile ? 2 : 4);
    this.survival = new Survival({
      lighting: this.lighting,
      world: () => this.world,
      toast: (t) => this.hud.toast(t, 2.2),
      onPowerRestored: () => this.match?.powerRestored(),
      map,
      physics: this.physics,
      scene: this.scene,
      nav: this.nav,
      weapons: this.weapons,
      player: this.player,
      health: this.health,
      audio: this.audio,
      impacts: this.impacts,
      hud,
      mobile: this.mobile,
      hurtPlayer: (d, from) => this.hurtPlayer(d, from),
      hireAlly: (at) => this.hireAlly(at),
      mode: teams ? 'teams' : 'solo',
      startZones: teams ? ['hangar', 'barracks', 'power'] : [],
      focusProvider: teams ? () => this.match?.foci() ?? [] : undefined,
      onRaid: (team) => this.match?.startRaid(team),
      onWin: (team) => this.match?.win(team),
      members: (team) => {
        if (team === 'alpha') return [this.survival!.playerWallet, ...this.allies.filter((a) => a.alive)];
        const t = this.match?.teams.find((x) => x.def.id === team);
        return t ? t.agents.filter((a) => a.alive) : [];
      },
      walletOf: (owner) => (owner === this.player ? this.survival!.playerWallet : (agentBySoldier.get(owner) ?? null)),
    });
    this.inhabitants = new Inhabitants({
      physics: this.physics,
      scene: this.scene,
      nav: this.nav,
      map,
      audio: this.audio,
      lighting: this.lighting,
      survival: this.survival,
      mobile: this.mobile,
      prey: this.prey,
      hurtPlayer: (d, from) => this.hurtPlayer(d, from),
      jolt: () => {
        this.camera.addPunch(0.09, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.2);
        this.camera.addShake(0.9);
        Haptics.pulse(120);
      },
      toast: (t) => this.hud.toast(t, 2),
      radio: (t) => this.status.radio(t, 'VANTA OPS', true),
    });
    this.health.autoRespawn = false;
    const onDeath = this.health.onDeath;
    this.health.onDeath = () => {
      onDeath?.();
      this.survival?.onPlayerDeath();
      this.survival?.builder.exit();
      // Once the exits are open there's no coming back.
      if (this.match?.extracting) this.health.autoRespawn = false;
      this.match?.playerDied();
    };
    // Last stand: with a living teammate you go down instead of dying.
    this.health.canGoDown = () => this.allies.some((a) => a.alive && !a.downed);
    this.giveUpBtn = document.createElement('button');
    this.giveUpBtn.className = 'giveup-btn';
    this.giveUpBtn.textContent = this.mobile ? 'GIVE UP' : 'GIVE UP [X]';
    this.giveUpBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.health.giveUp();
    });
    ui.appendChild(this.giveUpBtn);
    if (teams) {
      // Team race: no game over. You come back somewhere random after a few seconds.
      this.health.autoRespawn = true;
      this.health.respawnDelay = 7;
      this.health.onRespawn = () => {
        this.status.setDead(false);
        this.camera.revive();
        this.camera.downedTarget = 0;
        const mate = this.allies.find((a) => a.alive && !a.downed);
        const at = mate
          ? (this.nav.nearestWalkable(mate.soldier.pos.x + 1.2, mate.soldier.pos.z + 1.2, new THREE.Vector3(), 3) ?? mate.soldier.pos.clone())
          : (this.match?.respawnPoint() ?? this.arena.spawn);
        this.player.teleport(at.clone().setY(at.y + 0.2), Math.random() * Math.PI * 2);
        this.weapons.refillAll();
        this.health.armor = 0;
        // The core squad comes back with you (bought guns are lost, money is kept).
        this.allies = this.allies.filter((a) => a.alive || this.core.includes(a));
        this.core.forEach((a, i) => {
          if (a.alive) return;
          const p = this.nav.nearestWalkable(at.x + (i - 1) * 1.4, at.z - 1.5, new THREE.Vector3(), 4) ?? at;
          a.spawn(p, this.player.yaw);
          a.arm(SIDEARM);
        });
        this.hud.toast(mate ? 'Redeployed with your squad' : 'Squad wiped: redeployed', 1.8);
      };
      this.match = new TeamMatch({
        ui,
        scene: this.scene,
        map,
        survival: this.survival,
        soldierDeps: this.soldierDeps,
        weaponData: (id) => this.weapons.weapons.find((w) => w.data.id === id)?.data,
        audio: this.audio,
        status: this.status,
        hud: this.hud,
        svHud: hud,
        eye: this.camera.eye,
        lighting: this.lighting,
        shake: (at) => this.camera.addShake(Math.max(0, 1 - at.distanceTo(this.player.feet) / 60) * 0.9),
        allies: () => this.allies,
        playerAlive: () => !this.health.dead,
        playerPos: this.player.feet,
        mobile: this.mobile,
        playerWeapon: () => this.weapons.current.data.id,
        cinematic: (fn) => {
          this.cinematic = fn;
          document.body.classList.toggle('cinematic', !!fn);
          if (fn) feel.godMode = true; // you're aboard: nothing can hurt you in the cutscene
        },
      }, () => this.world);
      this.match.onEnd = () => {
        this.ended = true;
        document.exitPointerLock();
      };
      // Everyone starts four strong: you and three operators on pistols.
      for (let i = 0; i < 3; i++) {
        const at = this.nav.nearestWalkable(this.arena.spawn.x + (i - 1) * 1.6, this.arena.spawn.z + 2.2, new THREE.Vector3(), 4) ?? this.arena.spawn.clone();
        this.core.push(this.addAlly(at, false));
      }
    }
    this.squadEl = document.createElement('div');
    this.squadEl.className = 'squad-panel';
    ui.appendChild(this.squadEl);
    this.health.onDowned = () => {
      this.camera.downedTarget = 1;
      this.audio.play('player.death', { volume: 0.6 });
      this.hud.toast('DOWNED: your squad is coming', 2.5);
    };
    this.health.onRevived = () => {
      this.camera.downedTarget = 0;
      this.status.setDowned(-1);
      this.audio.play('bd.contact', { pitch: 1.12 });
      this.hud.toast('Back on your feet', 1.6);
    };
    this.mapOverlay = new MapOverlay(ui, {
      rooms: map.rooms, walls: map.layout.wallRuns, doors: map.doors, wallBuys: map.wallBuys, terminals: map.terminals, bounds: map.layout.bounds,
    });
    const survival = this.survival;
    this.mapState = {
      player: { x: 0, z: 0, yaw: 0 },
      unlocked: survival.unlocked,
      isOpen: (d) => survival.isDoorOpen(d),
      robots: [],
      allies: [],
      enemies: [],
      utilities: survival.utilities?.markers ?? [],
      lightsOut: () => this.lighting?.dark ?? false,
    };
    this.reviveBar = document.createElement('div');
    this.reviveBar.className = 'revive-bar';
    ui.appendChild(this.reviveBar);
    if (this.mobile) {
      const fl = document.createElement('button');
      fl.className = 'flash-btn';
      fl.textContent = '🔦';
      fl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        fl.classList.toggle('on', this.lighting?.toggleFlashlight() ?? false);
      });
      ui.appendChild(fl);
      this.squadBtn = document.createElement('button');
      this.squadBtn.className = 'squad-btn';
      this.squadBtn.textContent = 'SQUAD';
      this.squadBtn.classList.toggle('on', this.squadMode === 'free');
      this.squadBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.toggleSquadMode();
      });
      ui.appendChild(this.squadBtn);
      const bb = document.createElement('button');
      bb.className = 'build-btn';
      bb.textContent = 'BUILD';
      bb.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.survival?.builder.cycle();
      });
      ui.appendChild(bb);
      if (this.survival) this.survival.builder.onChange = () => {
        const m = this.survival!.builder.mode;
        bb.textContent = m ? m.toUpperCase() : 'BUILD';
        bb.classList.toggle('on', !!m);
      };
    }
  }

  toggleSquadMode(): void {
    this.squadMode = this.squadMode === 'free' ? 'follow' : 'free';
    for (const a of this.allies) a.plan = null;
    this.hud.toast(this.squadMode === 'free' ? 'Squad: free roam (they farm, buy and open doors on their own)' : 'Squad: follow me', 2.2);
    this.squadBtn?.classList.toggle('on', this.squadMode === 'free');
  }

  /** F / USE: pick up a downed squadmate if one is right here, else buy / use. */
  private useAction(): void {
    if (this.survival?.builder.active && !this.health.downed && !this.health.dead) {
      this.survival.builder.place();
      return;
    }
    const a = this.downedAllyNear();
    if (a && !this.health.downed && !this.health.dead) {
      this.reviving = { a, t: 0 };
      return;
    }
    this.survival?.interact();
  }

  private downedAllyNear(): TeamAgent | null {
    for (const a of this.allies) if (a.alive && a.downed && a.distTo(this.player.feet) < 2.2) return a;
    return null;
  }

  /** You, as the AI sees you (identity for contacts; positions only through its senses). */
  makePlayerC(): Combatant {
    const pl = this.player;
    return {
      team: 'alpha',
      kind: 'player',
      pos: pl.feet,
      aim: this.target.chest,
      head: this.target.head,
      alive: true,
      downed: false,
      hit: (d, from) => this.hurtPlayer(d, from),
      ref: pl,
      vel: pl.velocity,
      crouch: () => (pl.crouching ? 1 : 0),
    };
  }

  /** Bullet / noise owner → combatant (player, an operator, a robot). */
  private resolveOwner(owner: object | null): Combatant | null {
    if (!owner) return null;
    if (owner === this.player) return this.playerC ?? null;
    const a = agentBySoldier.get(owner);
    if (a) return a.self;
    if (owner instanceof RogueRobot) return this.robotCombatant(owner);
    return this.aiTest?.resolveOwner(owner) ?? null;
  }

  /** Every tactical bot in play (debug view). */
  private *allBots(): Generator<Bot> {
    for (const a of this.allies) yield a.bot;
    if (this.match) for (const a of this.match.agents()) yield a.bot;
    if (this.aiTest) yield* this.aiTest.bots();
  }

  /** What the AI test harness needs from the game. */
  private aiTestDeps(): ConstructorParameters<typeof AITest>[0] {
    if (!this.playerC) this.playerC = this.makePlayerC();
    return {
      soldierDeps: this.soldierDeps,
      nav: this.nav,
      physics: this.physics,
      player: this.player,
      playerC: this.playerC,
      health: this.health,
      weaponData: (id) => this.weapons.weapons.find((w) => w.data.id === id)?.data,
      status: this.status,
      hud: this.hud,
      setSpectator: (on) => (this.spectator = on),
      clearLab: () => {
        for (const sq of this.squads) for (const so of sq.soldiers) so.body.setActive(false);
        this.squads.length = 0;
        for (const r of this.robots) r.body.setActive(false);
        this.robots.length = 0;
      },
    };
  }

  /** Robots as combatants (cached per pooled robot). */
  private robotCombatant(r: RogueRobot): Combatant {
    let c = this.robotC.get(r);
    if (!c) {
      c = {
        team: 'robots',
        kind: 'robot',
        pos: r.pos,
        aim: new THREE.Vector3(),
        head: new THREE.Vector3(),
        get alive() {
          return r.alive;
        },
        downed: false,
        hit: () => {},
      };
      this.robotC.set(r, c);
    }
    c.aim.copy(r.body.part('torso').worldPos).y += 0.3;
    c.head.copy(r.body.part('head').worldPos);
    return c;
  }

  /** Allies, AI teams and raiders all fight over one combatant list. */
  private updateTeams(dt: number): void {
    const sv = this.survival!;
    const w = this.world;
    w.length = 0;
    const pc = this.playerC;
    pc.alive = !this.health.dead;
    pc.downed = this.health.downed;
    w.push(pc);
    for (const a of this.allies) {
      a.refreshSelf();
      if (a.alive) w.push(a.self);
    }
    this.match?.pushCombatants(w);
    for (const r of sv.robots) if (r.alive) w.push(this.robotCombatant(r));
    // Lab staff and The Choir (they come out in the dark).
    const prey = this.prey;
    prey.feet.copy(this.player.feet);
    prey.eye.copy(this.camera.eye);
    this.camera.getAimDirection(this.player, prey.look);
    prey.alive = !this.health.dead;
    this.inhabitants?.update(dt);
    this.inhabitants?.combatants(w);

    // Your squad's brain; your spot counts as taken (they don't stand on you).
    this.allySquad?.update(dt);
    if (!this.health.dead) coverRegistry.reserve(this.player, this.player.feet, aiWorld.time, 0.5);

    // Downed: the nearest standing ally comes to pick you up; allies pick each other up too.
    const rv = this.playerRevive;
    rv.pos.copy(this.player.feet);
    rv.downed = this.health.downed;
    for (const a of this.allies) if (a.reviveTarget === rv && !rv.downed) a.reviveTarget = null;
    let reviver = this.allies.find((a) => a.reviveTarget === rv) ?? null;
    if (rv.downed && !reviver) {
      let best = Infinity;
      for (const a of this.allies) {
        if (!a.alive || a.downed) continue;
        const d = a.distTo(this.player.feet);
        if (d < best) {
          best = d;
          reviver = a;
        }
      }
      if (reviver) reviver.reviveTarget = rv;
    }
    assignRevives(this.allies);
    // You reviving someone: stay close for 3 s.
    const rvg = this.reviving;
    if (rvg && (!rvg.a.alive || !rvg.a.downed || rvg.a.distTo(this.player.feet) > 2.6 || this.health.downed || this.health.dead)) this.reviving = null;
    if (this.reviving) {
      this.reviving.t += dt;
      if (this.reviving.t >= 3) {
        this.reviving.a.soldier.body.revive();
        this.hud.toast(`${this.reviving.a.personality.name} is back up`, 1.5);
        this.reviving = null;
      }
    }
    if (this.reviveBar) {
      this.reviveBar.classList.toggle('show', !!this.reviving);
      if (this.reviving) this.reviveBar.innerHTML = `REVIVING ${this.reviving.a.personality.name.toUpperCase()}<i style="transform:scaleX(${(this.reviving.t / 3).toFixed(3)})"></i>`;
    }
    const near = !this.reviving && !this.health.downed ? this.downedAllyNear() : null;
    sv.overridePrompt = near ? `Revive ${near.personality.name}` : null;
    if (this.health.downed) this.status.setDowned(this.health.bleed, reviver ? Math.min(1, reviver.reviveTime / 4) : 0);
    this.giveUpBtn?.classList.toggle('show', this.health.downed);

    // Between fights your operators shop for themselves: guns, ammo, doors near you.
    this.errandTimer -= dt;
    if (this.errandTimer <= 0 && this.arena instanceof Site9) {
      this.errandTimer = 2;
      for (const a of this.allies) {
        if (a.target || a.reviveTarget || this.health.downed) continue;
        const e = planErrand(a, sv, this.arena, { maxDist: 40, doorsNear: this.player.feet, doorDist: 45, doorKeep: 250 });
        if (e) a.errand = e;
      }
    }
    // Free roam: each operator works toward their own goal (gun, door, farm, push), within reach of you.
    this.planTimer -= dt;
    if (this.planTimer <= 0 && this.arena instanceof Site9) {
      this.planTimer = 2.5;
      for (const a of this.allies) {
        if (this.squadMode === 'follow') {
          a.plan = null;
          continue;
        }
        if (!a.alive || a.downed || a.plan || a.errand || a.target || a.reviveTarget || this.health.downed) continue;
        a.plan = planFor(a, {
          sv, map: this.arena, robots: sv.robots, pool: this.allies, intel: this.match?.intel('alpha') ?? [],
          anchor: this.player.feet, leash: 55,
        });
      }
    }
    const mates = this.allies.map((a) => a.soldier);
    for (const a of this.allies) a.update(dt, w, mates);
    // Fallen core operators come back as reinforcements after a minute (behind you, out of the fight).
    for (const a of this.core) {
      if (a.alive) {
        this.coreDeadTime.delete(a);
        continue;
      }
      const t = (this.coreDeadTime.get(a) ?? 0) + dt;
      this.coreDeadTime.set(a, t);
      if (t > 60 && !this.health.dead && !this.health.downed) {
        const back = this.tmp.set(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw)).multiplyScalar(5).add(this.player.feet);
        const p = this.nav.nearestWalkable(back.x, back.z, new THREE.Vector3(), 4);
        if (p) {
          a.spawn(p, this.player.yaw);
          a.arm(SIDEARM);
          this.coreDeadTime.delete(a);
          this.hud.toast(`${a.personality.name} is back`, 1.6);
        }
      }
    }
    this.squadTimer -= dt;
    if (this.squadTimer <= 0) {
      this.squadTimer = 0.3;
      this.updateSquadPanel();
    }
    // Every gun dry and no money for ammo: you still have your sidearm.
    const wc = this.weapons;
    if (wc.owned && !wc.owned.some((i) => wc.weapons[i].ammo > 0 || wc.weapons[i].reserve > 0)) {
      wc.giveWeapon(SIDEARM);
      this.hud.toast('Out of ammo: sidearm drawn', 2);
    }
    this.match?.update(dt, w);

    // Robots go for every soldier on the map; hazards hurt them all.
    const bodies = sv.extraTargets;
    bodies.length = 0;
    for (const c of w) if (c.kind === 'soldier') bodies.push(c);
    sv.allyBodies = bodies;
    this.inhabitants?.meleeTargets(bodies);
  }

  /** Vanta contractor from the security terminal (max 3 alive). */
  private hireAlly(at: THREE.Vector3): boolean {
    this.allies = this.allies.filter((a) => a.alive || this.core.includes(a));
    const hired = this.allies.filter((a) => !this.core.includes(a) && a.alive).length;
    if (hired >= 3 || this.allies.filter((a) => a.alive).length >= 5) {
      this.hud.toast('Squad full');
      return false;
    }
    const ally = this.addAlly(at, true);
    this.audio.play('bd.moving', { position: at, pitch: 1.15 });
    this.hud.toast(`Contractor ${ally.personality.name} hired (${ally.personality.role})`);
    return true;
  }

  /** A Vanta operator on your team: follows you, fights, revives, shops with their own money. */
  private addAlly(at: THREE.Vector3, hired: boolean): TeamAgent {
    const p = randomPersonality(0);
    const ally = new TeamAgent(this.soldierDeps, 'alpha', 10 + this.allies.length, p, 'vanta', {
      onHit: (_a, info, killed) => {
        // (The hit operator radios what it felt to the squad itself.)
        this.survival?.onSoldierHit('alpha', info, killed);
      },
      onKilled: () => this.audio.play('bd.man_down', { pitch: 1.12 }),
    });
    ally.soldier.body.friendly = true;
    ally.soldier.body.canGoDown = () => !this.health.dead || this.allies.some((a) => a !== ally && a.alive && !a.downed);
    ally.armory = (id) => this.weapons.weapons.find((w) => w.data.id === id)?.data;
    this.allySquad?.add(ally.bot);
    ally.points = hired ? 0 : START_POINTS;
    ally.spawn(at, this.player.yaw);
    // Contractors arrive armed; the starting squad has pistols like you.
    ally.arm(hired ? (p.role === 'marksman' ? 'mosin' : p.role === 'assault' ? 'ppsh' : 'ak47') : SIDEARM);
    ally.order = { kind: 'follow', leader: () => (this.health.dead ? null : { pos: this.player.feet, yaw: this.player.yaw + Math.PI, speed: this.player.horizontalSpeed }) };
    ally.soldier.skill = 1.35;
    ally.soldier.avoid = this.player.feet;
    ally.onSay = (a, text) => this.status.radio(text, a.personality.name.toUpperCase(), true);
    this.allies.push(ally);
    return ally;
  }

  /** Squad panel: who's with you, their role, money and gun. */
  private updateSquadPanel(): void {
    if (!this.squadEl) return;
    const short = (id: string) => this.weapons.weapons.find((w) => w.data.id === id)?.data.short ?? id;
    this.squadEl.innerHTML = this.allies
      .map((a) => {
        const st = !a.alive ? 'dead' : a.downed ? 'down' : a.errand ? a.errand.kind : a.plan ? a.plan.status : a.target ? 'fighting' : '';
        return `<div class="sq-row ${a.alive ? '' : 'dead'}"><b>${a.personality.name}</b><i>${a.personality.role}</i><span>${a.alive ? short(a.soldier.weaponId) : '✕'}</span><em>${a.points}</em>${st && a.alive ? `<u>${st === 'down' ? 'DOWN' : st}</u>` : ''}</div>`;
      })
      .join('');
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
      this.survival?.applyCareer();
      this.lastTime = performance.now();
      this.renderer.setAnimationLoop((t) => {
        // Frame cap (phones default to 60: 90/120 Hz screens would otherwise run the whole
        // game up to twice per 60 Hz frame, heat the phone and get throttled).
        const cap = this.trailer ? 0 : this.gfx.fpsCap;
        if (cap > 0) {
          const step = 1000 / cap;
          if (t < this.nextFrameAt - Math.min(4, step * 0.25)) return;
          this.nextFrameAt = Math.max(this.nextFrameAt + step, t);
        }
        this.frame(t);
      });
    }
  }

  /** What the main-menu unit showcase builds its lineups from. */
  showcaseDeps(): ShowcaseDeps {
    return { soldierDeps: this.soldierDeps, physics: this.physics, nav: this.nav, weapon: (id) => this.weapons.weapons.find((w) => w.data.id === id)?.data };
  }

  /** The game loop is running (PLAY was pressed at least once). */
  get running(): boolean {
    return this.started;
  }

  get isPaused(): boolean {
    return !this.mobile && !this.input.mouseActive && !this.noLock;
  }

  /** ?dev: developer tools (debug HUD, tuning panel, aim rays, god mode, AI toggle, F8...). */
  readonly dev = new URLSearchParams(location.search).has('dev');

  private onKey(code: string): void {
    const w = this.weapons;
    const devOnly = ['KeyH', 'Tab', 'KeyP', 'F1', 'Slash', 'KeyG', 'KeyJ', 'KeyO', 'KeyU', 'F2', 'F4', 'F8'];
    // J is build mode on Site-9 (a player key there), the debug crosshair elsewhere.
    if (!this.dev && devOnly.includes(code) && !(code === 'KeyJ' && this.survival)) return;
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
      case 'F4':
        this.hud.toast(`AI debug ${this.aiDebug.toggle() ? 'on' : 'off'}`);
        break;
      case 'KeyN':
        feel.damageNumbers = !feel.damageNumbers;
        this.hud.toast(`Damage numbers ${feel.damageNumbers ? 'on' : 'off'}`);
        break;
      case 'KeyG':
        this.hud.toast(`Aim rays ${this.toggleRays() ? 'on' : 'off'}`);
        break;
      case 'KeyL':
        if (this.lighting) this.hud.toast(`Flashlight ${this.lighting.toggleFlashlight() ? 'on' : 'off'}`, 1);
        else this.hud.toast(`Laser ${this.toggleLaser() ? 'on' : 'off'}`);
        break;
      case 'KeyJ':
        // Site-9: build mode. Elsewhere: the debug crosshair.
        if (this.survival) {
          this.survival.builder.cycle();
          break;
        }
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
        if (this.mapOverlay) this.mapOverlay.toggle();
        else this.gotoStation(this.stationIndex + 1);
        break;
      case 'F2':
        this.gotoStation(this.stationIndex + 1);
        break;
      case 'F8':
        // Dev: open extraction now (Site-9 team race).
        this.match?.forceExtraction();
        break;
      case 'KeyF':
        this.useAction();
        break;
      case 'KeyY':
        if (this.survival) this.toggleSquadMode();
        else {
          for (const s of this.squads) s.spawn();
          this.hud.toast('Black Division respawned');
        }
        break;
      case 'KeyX':
        if (this.health.downed) this.health.giveUp();
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
    const stations = this.arena.stations;
    this.stationIndex = ((i % stations.length) + stations.length) % stations.length;
    const st = stations[this.stationIndex];
    this.player.teleport(new THREE.Vector3(...st.pos), st.yaw);
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

  /**
   * Settings → Graphics. Everything applies live except antialiasing (the
   * framebuffer is created with the renderer: next start).
   */
  applyGraphics(s: GraphicsSettings): void {
    this.gfx = s;
    if (!s.dynamicResolution) this.dyn.scale = 1;
    this.nextFrameAt = 0;
    // Shadows: map size first (a new size needs a new shadow map), then on/off.
    const size = s.shadows === 'high' ? 2048 : 1024;
    const sh = this.arena.sun.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
    }
    // Lighting: full image-based lighting, or the probe (frame loop sets its intensity).
    const env = s.lighting === 'full' ? this.env : null;
    if (this.scene.environment !== env) this.scene.environment = env;
    this.probe.intensity = env ? 0 : this.scene.environmentIntensity * 1.1;
    // View distance: haze, camera far plane, how deep rooms are drawn.
    const vd = VIEW_DISTANCE[s.viewDistance];
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = vd.fogNear;
      fog.far = vd.fogFar;
    }
    this.camera.camera.far = vd.fogFar + 30;
    this.camera.camera.updateProjectionMatrix();
    if (this.arena instanceof Site9) this.arena.setViewDepth(vd.rooms, vd.roomFar);
    // Post effects: colour grade pass (Site-9) + grain / vignette overlay.
    if (s.postFx && !this.grade && !this.trailer && this.arena instanceof Site9) this.grade = new ScreenGrade(this.renderer);
    else if (!s.postFx && this.grade) {
      this.grade.target.dispose();
      this.grade = null;
    }
    document.body.classList.toggle('no-postfx', !s.postFx);
    // Fps readout.
    if (s.showFps && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-meter';
      this.container.appendChild(this.fpsEl);
    }
    if (this.fpsEl) this.fpsEl.style.display = s.showFps ? '' : 'none';
    this.setQuality(s.resolution, s.shadows !== 'off');
  }

  setQuality(pixelRatio: number, shadows: boolean): void {
    this.quality.pixelRatio = pixelRatio;
    this.quality.shadows = shadows;
    this.renderer.setPixelRatio(pixelRatio * this.dyn.scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.grade?.resize();
    if (this.renderer.shadowMap.enabled === shadows && this.arena.sun.castShadow === shadows) return;
    this.renderer.shadowMap.enabled = shadows;
    this.arena.sun.castShadow = shadows;
    // Shadow receivers need new shaders.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  /**
   * Dynamic resolution: hold the frame cap by trading resolution. Every second, if
   * frames ran slower than ~70 % of the cap the render scale drops 12 % (down to 55 %);
   * with headroom it creeps back up toward the setting. Hysteresis + cooldown: no pumping.
   */
  private dynamicResolution(rawDt: number): void {
    const d = this.dyn;
    if (rawDt > 0.25) return; // tab switch / hitch: not a measurement
    d.acc += rawDt;
    d.n++;
    d.t += rawDt;
    d.cooldown -= rawDt;
    if (d.t < 1) return;
    const avg = d.acc / d.n;
    d.t = d.acc = d.n = 0;
    if (d.cooldown > 0) return;
    let s = d.scale;
    // Aim for the frame cap (60 when uncapped): drop below ~70 % of it, recover above ~95 %.
    const target = this.gfx.fpsCap || 60;
    if (avg > 1 / (target * 0.7)) s = Math.max(0.55, s * 0.88);
    else if (avg < 1 / (target * 0.95)) s = Math.min(1, s * 1.06);
    if (Math.abs(s - d.scale) < 0.01) return;
    d.scale = s;
    d.cooldown = 1.5;
    this.renderer.setPixelRatio(this.quality.pixelRatio * s);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.grade?.resize();
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.grade?.resize();
    this.camera.camera.aspect = w / h;
    this.camera.camera.updateProjectionMatrix();
    this.weapons.viewmodel.setAspect(w / h);
  }

  /** One frame at an explicit timestamp (trailer capture drives the clock). */
  stepFrame(now: number): void {
    if (!this.started) {
      this.started = true;
      this.lastTime = now;
    }
    this.frame(now);
  }

  private frame(now: number): void {
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp: never negative (clock hiccups) and never huge (tab switch, breakpoints).
    const realDt = Math.min(Math.max(rawDt, 0), 0.1);
    const dt = realDt * this.timeScale;
    this.fps += (1 / Math.max(rawDt, 1e-4) - this.fps) * 0.05;
    if (this.gfx.dynamicResolution && !this.trailer) this.dynamicResolution(rawDt);
    this.frameMs += (rawDt * 1000 - this.frameMs) * 0.05;
    if (this.fpsEl && this.gfx.showFps && (this.fpsTimer -= rawDt) <= 0) {
      this.fpsTimer = 0.25;
      const c = this.renderer.domElement;
      this.fpsEl.textContent = `${Math.round(this.fps)} FPS · ${this.frameMs.toFixed(1)} ms · ${c.width}×${c.height}`;
    }

    const input = this.input;
    input.mouseSensitivity = playerConfig.mouseSensitivity;
    input.beginFrame();
    this.director?.input(input, dt);
    if (this.health.downed) {
      // On the floor: look and shoot (last stand), no moving.
      input.moveX = input.moveY = 0;
      input.jumpPressed = false;
      input.sprintHeld = false;
    }
    if (this.isPaused || (this.input.lockFailed && this.tuning.visible) || this.health.dead || this.cinematic) {
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
    while (this.accumulator >= this.fixedDt - 1e-6 && steps < MAX_STEPS) {
      this.player.fixedUpdate(this.fixedDt, input);
      for (const r of this.robots) r.fixedUpdate(this.fixedDt);
      this.physics.step();
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    const alpha = Math.min(1, Math.max(0, this.accumulator / this.fixedDt));
    this.physics.syncObjects();

    // --- Camera first, then aim the physical weapon, then fire from its muzzle ---
    const w = this.weapons.current;
    this.weapons.updateState(dt, input);
    this.camera.update(dt, alpha, this.player, this.weapons.adsAmount, w.data.sight.adsFov);
    this.camera.camera.updateMatrixWorld();
    this.director?.afterCamera(dt);
    if (this.cinematic) {
      const c = this.cinematic(dt);
      const cam = this.camera.camera;
      cam.position.copy(c.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(c.target);
      cam.fov = c.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
    // Look deltas are per real frame; in slow motion the weapon sees the same turn rate.
    this.weapons.updatePose(dt, yaw * this.timeScale, pitch * this.timeScale);
    this.weapons.updateFire(dt, input);

    // --- World ---
    this.nav.beginFrame();
    aiWorld.beginFrame(dt);
    aiWorld.darkness = this.lighting ? this.lighting.darkness * 0.7 + 0.3 : this.arena instanceof Site9 ? 0.3 : 0.25;
    this.arena.update(dt, this.player.feet);
    this.lighting?.update(dt);
    // The probe stands in for the image-based fill (and dims with it in a blackout).
    this.probe.intensity = this.scene.environment ? 0 : this.scene.environmentIntensity * 1.1;
    // Lights out: muzzle flashes light the room (and give shooters away).
    const darkness = this.lighting?.darkness ?? 0;
    this.dust.update(dt, this.camera.eye, darkness);
    if (!this.ambience && this.audio.ready && !this.trailer) this.ambience = new Ambience(this.audio);
    this.ambience?.update(dt, this.arena instanceof Site9 ? this.arena.ambienceAt(this.player.feet.x, this.player.feet.z) : null, darkness, this.camera.eye);
    if (this.survival && !this.health.dead && !this.ended) raid.alive += dt;
    // Broken lamps spark when they stutter back on (only the ones near you).
    if (this.arena instanceof Site9) {
      const lvl = this.arena.brokenLevel;
      if (lvl > 0.6 && this.prevBroken < 0.3) for (const p of this.arena.brokenLamps) if (p.distanceToSquared(this.player.feet) < 30 * 30) this.impacts.shortOut(p, false);
      this.prevBroken = lvl;
    }
    this.muzzleLights.boost = 1 + 3 * darkness;
    this.weapons.flashBoost = 1 + 2 * darkness;
    if (this.arena instanceof Site9) {
      const map = this.arena;
      const s = this.survival;
      map.updateVisibility(this.player.feet.x, this.player.feet.z, (l) => (s ? s.isLinkOpen(l) : true));
      // Characters in rooms that aren't drawn don't need drawing either.
      if (s) for (const r of s.robots) if (r.active) r.body.root.visible = map.isVisibleAt(r.pos.x, r.pos.z);
      // Short view distance: far operators are a few pixels in the haze; skip drawing them.
      const far2 = VIEW_DISTANCE[this.gfx.viewDistance].characters ** 2;
      const f = this.player.feet;
      const show = (p: THREE.Vector3) => map.isVisibleAt(p.x, p.z) && (p.x - f.x) ** 2 + (p.z - f.z) ** 2 < far2;
      for (const a of this.allies) a.soldier.body.root.visible = !a.gone && show(a.soldier.pos);
      if (this.match) for (const a of this.match.agents()) a.soldier.body.root.visible = !a.gone && show(a.soldier.pos);
    }
    for (const r of this.robots) r.update(dt);
    const t = this.target;
    t.feet.copy(this.player.feet);
    t.head.copy(this.camera.eye);
    t.chest.set(t.feet.x, t.feet.y + this.player.eyeHeight - 0.42, t.feet.z);
    t.velocity.copy(this.player.velocity);
    t.sprinting = this.player.sprinting;
    t.crouching = this.player.crouching;
    t.alive = !this.health.dead;
    for (const s of this.squads) s.update(dt, t, feel.enemyAI);
    this.aiTest?.update(dt);
    if (this.survival) this.updateTeams(dt);
    this.survival?.update(dt);
    if (this.mapOverlay && this.mapState && this.survival) {
      const ms = this.mapState;
      ms.player.x = this.player.feet.x;
      ms.player.z = this.player.feet.z;
      ms.player.yaw = this.player.yaw;
      ms.robots.length = 0;
      for (const r of this.survival.robots) if (r.aggro) ms.robots.push({ x: r.pos.x, z: r.pos.z });
      ms.enemies.length = 0;
      for (const sq of this.squads) for (const s of sq.soldiers) if (s.alive) ms.enemies.push({ x: s.pos.x, z: s.pos.z });
      if (this.match) for (const t of this.match.raiders) for (const a of t.agents) if (a.alive) ms.enemies.push({ x: a.soldier.pos.x, z: a.soldier.pos.z });
      ms.allies.length = 0;
      for (const a of this.allies) if (a.alive) ms.allies.push({ x: a.soldier.pos.x, z: a.soldier.pos.z });
      // Gunfire gives enemy operators away for a moment.
      this.match?.loud(ms.enemies, 'alpha');
      if (this.match?.extracting && !ms.exits) ms.exits = this.match.exits.map((e) => ({ x: e.pos.x, z: e.pos.z, name: e.name }));
      this.mapOverlay.update(realDt, ms);
    }
    this.health.update(dt);
    this.muzzleLights.update(dt);
    // Their lights come on in the dark: blackouts on Site-9, always in the night yard.
    // Site-9 runs at night: BD weapon lights stay on (stronger once the power dies).
    weaponLight.level = this.lighting ? Math.max(0.6, Math.min(1, this.lighting.darkness * 1.3)) : 1;
    this.weaponLights.update(this.camera.camera.position);
    this.shells.update(dt);
    this.impacts.update(dt);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.camera.quaternion);
    this.audio.setListener(this.camera.camera.position, this.right);
    // Your footsteps: gear rustle every stride.
    const pl = this.player;
    const spd = pl.horizontalSpeed;
    if (pl.grounded && spd > 0.6 && !this.health.dead && !this.health.downed) {
      this.stepDist += spd * dt;
      const stride = pl.sprinting ? 1.1 : pl.crouching ? 0.6 : 0.8;
      if (this.stepDist >= stride) {
        this.stepDist = 0;
        this.audio.play('foley.step', { volume: (pl.sprinting ? 0.38 : pl.crouching ? 0.08 : 0.14) * (0.8 + Math.random() * 0.4) });
        aiWorld.emit(pl.sprinting ? 'sprint' : 'step', pl.feet, 'alpha', pl, pl.crouching ? 0.35 : 1);
      }
    } else this.stepDist = 0.5;
    if (this.arena instanceof Site9) {
      // Tails and reverb follow the room you're in: offices are tight, the hangar rolls on.
      const f = this.player.feet;
      const room = this.arena.rooms.find((r) => f.x >= r.rect[0] && f.x <= r.rect[2] && f.z >= r.rect[1] && f.z <= r.rect[3]);
      const want = room ? Math.min(1, Math.max(0, (room.h - 5) / 11)) : 0.5;
      this.audio.space += (want - this.audio.space) * Math.min(1, dt * 2);
    }

    // --- UI ---
    const cw = this.weapons.current;
    const reload = cw.state === 'reloading' ? (cw.data.reload.kind === 'magazine' ? cw.stateProgress : cw.ammo / cw.data.magazineSize) : -1;
    if (cw.state === 'reloading' && this.prevWeaponState !== 'reloading') aiWorld.emit('reload', this.player.feet, 'alpha', this.player);
    this.prevWeaponState = cw.state;
    this.hud.updateAmmo(cw.data.name, cw.ammo, cw.chambered && cw.data.closedBolt, cw.reserve === Infinity ? cw.data.magazineSize : cw.reserve, `${cw.fireMode.toUpperCase()} · ${this.weapons.ammo.caliber}`, reload, cw.data.magazineSize);
    this.hud.updateCrosshair(this.weapons.handling.dispersionDeg * 0.5, this.camera.currentFov, this.weapons.adsAmount, cw.state !== 'ready' || this.player.sprinting);
    this.hud.update(realDt, this.camera.camera);
    this.status.update(realDt, this.health.health, this.health.max, this.camera.camera);
    this.status.setArmor(this.health.armor / this.health.maxArmor);
    this.status.setSquadLine(this.squadStatus());
    this.tuning.syncWeapon();
    this.touch?.sync(input.adsHeld, this.weapons.currentIndex, this.weapons.owned);
    if (this.touch && this.survival) {
      const p = this.survival.builder.prompt ?? this.survival.prompt;
      this.touch.setUse(p ? p.label : null, p?.cost ?? 0, p?.affordable ?? true);
    }

    // --- Render: world, then the weapon on top, then debug lines over everything ---
    this.renderer.info.reset();
    if (!this.director?.render()) {
      if (this.grade) {
        this.grade.mood = 0.35 + 0.65 * (this.lighting?.darkness ?? 0);
        this.grade.begin();
      }
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera.camera);
      this.renderer.clearDepth();
      if (!this.health.dead && !this.cinematic && !this.spectator) this.renderer.render(this.weapons.viewmodel.scene, this.weapons.viewmodel.camera);
      this.debugDraw.flush(realDt);
      if (this.debugDraw.enabled) this.renderer.render(this.debugDraw.scene, this.camera.camera);
      this.aiDebug.update(realDt);
      if (this.aiDebug.enabled) this.renderer.render(this.aiDebug.draw.scene, this.camera.camera);
      this.grade?.end();
    }

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
    for (const sq of this.squads) for (const s of sq.soldiers) if (s.alive) points.push(s.chestPos.clone());
    for (const c of this.world) if (c.team !== 'alpha' && c.alive && !c.downed) points.push(c.aim);
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
