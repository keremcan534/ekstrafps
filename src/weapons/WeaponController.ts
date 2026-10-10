import { skillFx, skillRaid } from '../game/Skills';
import * as THREE from 'three';
import { DEG, clamp } from '../core/math';
import type { Input } from '../core/Input';
import { Haptics } from '../core/Haptics';
import { feel } from '../config/Feel';
import type { AudioSystem } from '../audio/AudioSystem';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { Shells } from '../fx/Shells';
import type { HUD, HitKind } from '../ui/HUD';
import type { PlayerCamera } from '../player/PlayerCamera';
import type { PlayerController } from '../player/PlayerController';
import type { Physics } from '../core/Physics';
import type { DebugDraw } from '../fx/DebugDraw';
import { Laser } from '../fx/Laser';
import { Trails } from '../fx/Trails';
import { Weapon, type WeaponListener } from './Weapon';
import { liveWeaponId, type WeaponData } from './WeaponData';
import { RecoilSystem } from './RecoilSystem';
import { recoilFeel } from './TarkovRecoil';
import { Viewmodel } from './Viewmodel';
import { ProjectileSystem, type ProjectileHitReport } from './Ballistics';
import { computeHandling, type Handling } from './Handling';
import { dragFactor, dropAt, getAmmo, muzzleVelocity, type AmmoData } from './AmmoData';

export interface WeaponControllerDeps {
  physics: Physics;
  player: PlayerController;
  camera: PlayerCamera;
  audio: AudioSystem;
  impacts: ImpactSystem;
  shells: Shells;
  hud: HUD;
  worldScene: THREE.Scene;
  debugDraw: DebugDraw;
}

interface PendingShell {
  time: number;
  active: boolean;
}

const HAPTIC_MS: Record<WeaponData['category'], number> = { rifle: 8, smg: 6, pistol: 16, shotgun: 32 };
const ZERO_STEPS = [25, 50, 100, 150, 200, 300];

/**
 * Owns the player's weapons and runs the physical gun-handling loop:
 *
 *   updateState()  switching, ADS intent, arm stamina, sprint rules
 *   updatePose()   after the camera: wall probes, aim the physical weapon, muzzle ray
 *   updateFire()   mechanism; projectiles leave the REAL muzzle along the bore,
 *                  recoil impulses go into the weapon and (partly) the view
 */
export class WeaponController implements WeaponListener {
  /** Touch aim assist's hit catch (m): a near miss this close to a body still lands (Game sets it). */
  touchHitAssist = 0;
  readonly weapons: Weapon[];
  readonly recoil = new RecoilSystem();
  readonly viewmodel: Viewmodel;
  readonly projectiles: ProjectileSystem;
  /** Every player shot (for AI hearing): muzzle position, suppressed. */
  onPlayerShot: ((pos: THREE.Vector3, suppressed: boolean) => void) | null = null;
  readonly laser = new Laser();
  readonly trails = new Trails();
  current: Weapon;
  currentIndex = 0;
  /** Survival loadout: indices of owned weapons (max 2). null = lab, every weapon. */
  owned: number[] | null = null;
  handling!: Handling;
  ammo!: AmmoData;

  /** Arm stamina 0..1 (drains while aiming heavy weapons). */
  stamina = 1;
  /** +1 right shoulder, -1 left. */
  shoulder = 1;
  wallTarget = 0;

  // Debug stats
  lastHitDistance = -1;
  lastDamage = '-';
  lastTargetHealth = '-';
  lastMuzzleVelocity = 0;
  aimErrorDeg = 0;
  readonly muzzleWorld = new THREE.Vector3();
  readonly muzzleDir = new THREE.Vector3();

  private pendingIndex = -1;
  private adsWanted = false;
  private sprintRecover = 0;
  private shotId = 0;
  private frameHitRank = 0;
  private frameHitPoint = new THREE.Vector3();
  private frameDamage = 0;
  private worldFlash: THREE.PointLight;
  private worldFlashLife = 0;
  private pendingShells: PendingShell[] = Array.from({ length: 8 }, () => ({ time: 0, active: false }));
  private aim = new THREE.Vector3();
  private aimPoint = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private pelletDir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private laserFrom = new THREE.Vector3();
  private laserDir = new THREE.Vector3();
  private rayEnd = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private probeFrom = new THREE.Vector3();
  private toMuzzle = new THREE.Vector3();
  private eject = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private e = new THREE.Euler();

  /** 1 normally, more in the dark: your muzzle flash lights the room. */
  flashBoost = 1;

  constructor(defs: WeaponData[], aspect: number, private deps: WeaponControllerDeps) {
    this.weapons = defs.map((d) => new Weapon(d, this));
    this.viewmodel = new Viewmodel(aspect, defs);
    this.recoil.attach(this.viewmodel.stack.recoil.tarkov);
    this.projectiles = new ProjectileSystem(deps.physics, deps.impacts, deps.impacts.sparks, deps.debugDraw, this.trails);
    this.projectiles.onHit = (r) => this.onProjectileHit(r);
    this.worldFlash = new THREE.PointLight(0xffaa55, 0, 9, 2);
    deps.worldScene.add(this.worldFlash, this.laser.group, this.trails.mesh);
    this.current = this.weapons[0];
    this.activate(0);
  }

  get adsAmount(): number {
    return this.viewmodel.adsAmount;
  }

  /** Aimed horizontal FOV of the weapon in hand (its view profile, or the old sight data). */
  get adsFov(): number {
    return this.viewmodel.adsFov;
  }

  /** The weapon in hand's own hip FOV, or null (the player's FOV setting). */
  get hipFov(): number | null {
    return this.viewmodel.hipFov;
  }

  /** Look sensitivity at full aim for the weapon in hand (on top of the FOV scaling). */
  get aimSensitivity(): number {
    return this.viewmodel.aimSensitivity;
  }

  /** Camera aim (intent) direction this frame. */
  get cameraAimDir(): THREE.Vector3 {
    return this.aim;
  }

  get wallState(): string {
    const c = this.viewmodel.wallCompression;
    return c < 0.02 ? 'clear' : c < 0.35 ? 'compressing' : c < 0.75 ? 'high ready' : 'blocked';
  }

  private activate(index: number): void {
    this.currentIndex = index;
    this.current = this.weapons[index];
    this.ammo = getAmmo(this.current.data.ammo);
    this.handling = computeHandling(this.current.data, this.ammo);
    this.current.raiseScale = this.handling.raiseScale;
    this.viewmodel.setWeapon(this.current, this.handling);
    this.current.equip();
    this.viewmodel.onMechanical('equip');
    for (const s of this.pendingShells) s.active = false;
  }

  /** Recompute derived handling (after tuning edits). */
  refreshHandling(): void {
    this.ammo = getAmmo(this.current.data.ammo);
    this.handling = computeHandling(this.current.data, this.ammo);
    this.current.raiseScale = this.handling.raiseScale;
    this.viewmodel.refresh(this.handling);
  }

  requestSwitch(index: number): void {
    if (index < 0 || index >= this.weapons.length) return;
    if (index === this.currentIndex && this.pendingIndex < 0) return;
    if (index === this.currentIndex) {
      this.pendingIndex = -1;
      this.current.equip();
      return;
    }
    this.pendingIndex = index;
    if (this.current.state !== 'holstering' && this.current.state !== 'holstered') this.current.holster();
  }

  cycleFireMode(): void {
    const w = this.current;
    if (w.data.fireModes.length < 2) {
      this.deps.hud.toast(`${w.data.short}: ${w.fireMode.toUpperCase()} only`);
      return;
    }
    const mode = w.cycleFireMode();
    this.deps.audio.play('ui.firemode');
    this.deps.hud.toast(`${w.data.short}: ${mode.toUpperCase()}`);
  }

  toggleShoulder(): void {
    this.shoulder = -this.shoulder;
    this.deps.hud.toast(this.shoulder > 0 ? 'Right shoulder' : 'Left shoulder');
  }

  adjustZero(dir: number): void {
    const a = this.current.data.aim;
    let i = ZERO_STEPS.findIndex((z) => z >= a.zeroDistance);
    if (i < 0) i = ZERO_STEPS.length - 1;
    i = clamp(i + dir, 0, ZERO_STEPS.length - 1);
    a.zeroDistance = ZERO_STEPS[i];
    this.deps.audio.play('ui.firemode');
    this.deps.hud.toast(`Zero: ${a.zeroDistance} m`);
  }

  /** Check weapon: fire mode, approximate magazine, chamber. */
  inspect(): void {
    const w = this.current;
    const frac = w.ammo / w.data.magazineSize;
    const mag = frac >= 0.95 ? 'full' : frac > 0.66 ? 'nearly full' : frac > 0.4 ? 'about half' : frac > 0.1 ? 'low' : frac > 0 ? 'almost empty' : 'empty';
    const chamber = w.data.closedBolt ? (w.chambered ? 'round chambered' : 'chamber EMPTY') : 'open bolt';
    this.deps.hud.toast(`${w.data.name} · ${w.fireMode.toUpperCase()} · mag ${mag} · ${chamber} · ${this.ammo.name}`, 2.5);
  }

  updateState(dt: number, input: Input): void {
    const { player } = this.deps;

    // --- Switching ---
    if (this.owned) {
      const o = this.owned;
      if (input.slotPressed >= 0 && input.slotPressed < o.length) this.requestSwitch(o[input.slotPressed]);
      if (input.cyclePressed !== 0 && o.length > 1) {
        const i = Math.max(0, o.indexOf(this.pendingIndex >= 0 ? this.pendingIndex : this.currentIndex));
        this.requestSwitch(o[(i + input.cyclePressed + o.length) % o.length]);
      }
    } else {
      if (input.slotPressed >= 0) {
        // Ten keys, more guns: the key of the gun in hand flips to its second page (1 → 11 → 1).
        const cur = this.pendingIndex >= 0 ? this.pendingIndex : this.currentIndex;
        let i = input.slotPressed;
        if (cur % 10 === i) i = cur < 10 && cur + 10 < this.weapons.length ? cur + 10 : i;
        this.requestSwitch(i);
      }
      if (input.cyclePressed !== 0) {
        const n = this.weapons.length;
        this.requestSwitch((this.currentIndex + input.cyclePressed + n) % n);
      }
    }
    if (this.pendingIndex >= 0 && this.current.state === 'holstered') {
      const next = this.pendingIndex;
      this.pendingIndex = -1;
      this.activate(next);
    }

    const w = this.current;
    const vm = this.viewmodel;

    // --- ADS intent: needs a ready gun, room in front of it, and no shoulder swap ---
    const canAds = w.aimable && vm.wallCompression < 0.5 && !vm.switchingShoulder;
    this.adsWanted = input.adsHeld && canAds;
    const wantsFire = input.fireHeld || input.firePressed;
    // Firing or aiming always wins over sprinting.
    player.sprintBlocked = this.adsWanted || (wantsFire && w.state === 'ready');
    player.adsAmount = this.adsAmount;

    // --- Arm stamina: holding a weapon up on target is tiring ---
    if (!feel.armStamina) this.stamina = 1;
    else if (this.adsAmount > 0.5) this.stamina = Math.max(0, this.stamina - this.handling.staminaDrain * skillFx.staminaDrain * dt * (player.crouching ? 0.75 : 1));
    else this.stamina = Math.min(1, this.stamina + this.handling.staminaRecover * skillFx.staminaRecover * dt);

    this.sprintRecover = player.sprinting ? w.data.sprintToFireTime : this.sprintRecover - dt;
  }

  /** Aim the physical weapon. Must run after the camera has its final transform. */
  updatePose(dt: number, lookYaw: number, lookPitch: number): void {
    const { player, camera, physics, debugDraw } = this.deps;
    const d = this.current.data;
    const cam = camera.camera;
    const vm = this.viewmodel;

    camera.getAimDirection(player, this.aim);

    // --- Wall / obstacle probes from the shoulder along the aim ---
    const reach = vm.restReach(this.adsAmount) + 0.04;
    const range = 0.55 * d.handling.length + 0.1;
    const hip = vm.hipPosition;
    let nearest = Infinity;
    for (let i = 0; i < 3; i++) {
      const ox = (hip[0] * 0.6 + (i === 2 ? 0.05 : 0)) * this.shoulder;
      const oy = hip[1] * 0.6 + (i === 1 ? 0.05 : 0);
      this.probeFrom.set(ox, oy, 0);
      cam.localToWorld(this.probeFrom);
      const hit = physics.raycast(this.probeFrom, this.aim, reach + 0.2);
      const dist = hit ? hit.distance : Infinity;
      nearest = Math.min(nearest, dist);
      if (debugDraw.enabled) {
        const c = clamp((reach - dist) / range, 0, 1);
        this.rayEnd.copy(this.probeFrom).addScaledVector(this.aim, Math.min(dist, reach));
        debugDraw.line(this.probeFrom, this.rayEnd, c <= 0 ? 0x44ff88 : c < 0.75 ? 0xffa030 : 0xff3030);
      }
    }
    this.wallTarget = clamp((reach - nearest) / range, 0, 1);

    // --- Aim solution: camera ray at convergence (hip) / zero (ADS), plus drop compensation ---
    const ads = this.adsAmount;
    const dist = d.aim.hipConvergence + (d.aim.zeroDistance - d.aim.hipConvergence) * ads;
    const v0 = muzzleVelocity(this.ammo, d.barrelLength);
    const dropAngle = Math.atan2(dropAt(dist, v0, dragFactor(this.ammo)), dist);
    this.aimPoint.copy(camera.eye).addScaledVector(this.aim, dist);
    cam.worldToLocal(this.aimPoint);

    vm.update(dt, {
      player,
      lookYaw,
      lookPitch,
      adsTarget: this.adsWanted ? 1 : 0,
      aimPoint: this.aimPoint,
      dropAngle,
      mainCamera: cam,
      stamina: this.stamina,
      wallTarget: this.wallTarget,
      shoulder: this.shoulder,
    });

    const rig = vm.activeRig!;
    vm.toWorld(rig.muzzle, cam, this.muzzleWorld);
    vm.shotDirection(cam, this.muzzleDir);
    this.aimErrorDeg = Math.acos(Math.min(1, this.muzzleDir.dot(this.aim))) / DEG;

    // Test laser: parallel to the bore, from the emitter under the barrel.
    if (this.laser.enabled) {
      vm.toWorld(rig.laser, cam, this.laserFrom);
      vm.forwardWorld(rig.laser, cam, this.laserDir);
      const hit = physics.raycast(this.laserFrom, this.laserDir, 250);
      this.rayEnd.copy(this.laserFrom).addScaledVector(this.laserDir, hit ? hit.distance : 250);
      this.laser.update(this.laserFrom, this.rayEnd, !!hit);
    } else {
      this.laser.update(this.laserFrom, this.laserFrom, false);
    }

    if (debugDraw.enabled) {
      // Camera aim ray (intent): cyan
      const ch = physics.raycast(camera.eye, this.aim, 300);
      this.rayEnd.copy(camera.eye).addScaledVector(this.aim, ch ? ch.distance : 300);
      debugDraw.line(this.tmpV.copy(camera.eye).addScaledVector(this.aim, 0.5), this.rayEnd, 0x2ad4ff);
      debugDraw.cross(this.rayEnd, 0.08, 0x2ad4ff);
      // Weapon aim ray (straight bore line): yellow
      const wh = physics.raycast(this.muzzleWorld, this.muzzleDir, 300);
      this.rayEnd.copy(this.muzzleWorld).addScaledVector(this.muzzleDir, wh ? wh.distance : 300);
      debugDraw.line(this.muzzleWorld, this.rayEnd, 0xffe14a);
      debugDraw.cross(this.rayEnd, 0.06, 0xffe14a);
      // Muzzle forward vector: red
      debugDraw.line(this.muzzleWorld, this.tmpV.copy(this.muzzleWorld).addScaledVector(this.muzzleDir, 0.6), 0xff3030);
      // Convergence / zero point: white
      debugDraw.cross(this.tmpV.copy(camera.eye).addScaledVector(this.aim, dist), 0.05, 0xffffff);
    }
  }

  updateFire(dt: number, input: Input): void {
    const { camera, player } = this.deps;
    const vm = this.viewmodel;

    this.frameHitRank = 0;
    this.frameDamage = 0;
    this.current.update(dt, {
      fireHeld: input.fireHeld,
      firePressed: input.firePressed,
      reloadPressed: input.reloadPressed,
      blocked: this.sprintRecover > 0 || vm.wallCompression > 0.75 || vm.switchingShoulder,
    });

    this.projectiles.update(dt);
    this.trails.update(dt);
    this.flushHits();
    this.recoil.update(dt, camera, player);

    // --- Delayed shell ejection (pump / bolt timing) ---
    for (const s of this.pendingShells) {
      if (!s.active) continue;
      s.time -= dt;
      if (s.time <= 0) {
        s.active = false;
        this.ejectShell();
      }
    }

    // --- World muzzle light ---
    if (this.worldFlashLife > 0) {
      this.worldFlashLife -= dt;
      this.worldFlash.intensity = Math.max(0, this.worldFlashLife / 0.06) * 25 * this.flashBoost;
      this.worldFlash.distance = 9 * (0.6 + 0.4 * this.flashBoost);
    } else {
      this.worldFlash.intensity = 0;
    }
  }

  // ---------------- WeaponListener ----------------

  onShot(weapon: Weapon): void {
    const { camera, audio, impacts, physics, player } = this.deps;
    const d = weapon.data;
    const ammo = this.ammo;
    const vm = this.viewmodel;

    // Shots leave the real muzzle along the bore. If the muzzle pokes through
    // geometry (eye -> muzzle blocked), the shot starts at the obstruction instead.
    this.origin.copy(this.muzzleWorld);
    this.toMuzzle.subVectors(this.muzzleWorld, camera.eye);
    const reach = this.toMuzzle.length();
    const blocked = reach > 1e-4 ? physics.raycast(camera.eye, this.toMuzzle.divideScalar(reach), reach) : null;
    if (blocked) this.origin.copy(blocked.point).addScaledVector(this.toMuzzle, -0.02);

    // Basis around the bore for dispersion.
    this.right.set(0, 1, 0).cross(this.muzzleDir);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.muzzleDir, this.right).normalize();

    // Mechanical dispersion (MOA cone). Like Tarkov, recoil adds none: rounds go where the
    // muzzle points, and recoil moves the muzzle. Standing still there is no hip-fire bloom:
    // aim comes from the weapon itself. On the move you can't hold it steady: running and
    // gunning from the hip scatters, aimed fire on the move a little, mid-air a lot.
    const moving = Math.min(1, Math.max(0, (this.deps.player.horizontalSpeed - 0.6) / 4));
    const moveDeg = (moving * (2.2 - 1.5 * this.adsAmount) + (this.deps.player.grounded ? 0 : 3)) * recoilFeel().moveSpread;
    const coneRad = (this.handling.dispersionDeg * 0.5 + moveDeg) * DEG;
    const v0 = muzzleVelocity(ammo, d.barrelLength);
    this.lastMuzzleVelocity = v0;
    const pellets = Math.max(1, ammo.pellets);
    const pelletRad = Math.tan(ammo.pelletSpread * DEG);
    const patternRot = Math.random() * Math.PI * 2;
    this.shotId++;
    const tracer = ammo.tracer || (d.fx.tracerEvery > 0 && weapon.totalShots % d.fx.tracerEvery === 0);
    for (let i = 0; i < pellets; i++) {
      // Gaussian-ish radius: most rounds land near the centre of the group.
      const a = Math.random() * Math.PI * 2;
      const r = Math.min(1, Math.sqrt(-2 * Math.log(Math.max(1e-6, Math.random()))) * 0.45) * Math.tan(coneRad);
      let ox = Math.cos(a) * r;
      let oy = Math.sin(a) * r;
      if (pellets > 1) {
        const ring = i === 0 ? 0 : i % 2 === 0 ? 1 : 0.55;
        const pa = patternRot + (i / (pellets - 1)) * Math.PI * 2;
        ox += (Math.cos(pa) * ring + (Math.random() - 0.5) * 0.3) * pelletRad;
        oy += (Math.sin(pa) * ring + (Math.random() - 0.5) * 0.3) * pelletRad;
      }
      this.pelletDir.copy(this.muzzleDir).addScaledVector(this.right, ox).addScaledVector(this.up, oy).normalize();
      // Bolt actions: a slightly wider "catch" (4 cm) so near misses on a body still land;
      // touch aim assist widens it for every gun (thumbs can't place a pistol tap that finely).
      const assist = Math.max(d.fireModes.includes('bolt') ? 0.04 : 0, this.touchHitAssist);
      this.projectiles.fire(this.origin, this.pelletDir, v0 * (0.985 + Math.random() * 0.03), ammo, this.shotId, tracer && i === 0, i < 3, null, false, false, 'alpha', assist);
    }

    // Recoil (Tarkov's model): the hands turn, the view carries its share (RecoilSystem).
    vm.kick(d, ammo, player.crouching);

    // Your own gun a little over everything else (+2 dB).
    audio.play(d.audio.fire, { volume: 1.25 });
    this.onPlayerShot?.(this.muzzleWorld, d.model === 'asval');
    Haptics.pulse(d.animSet === 'bolt' ? 35 : HAPTIC_MS[d.category]);
    if (feel.muzzleFlash && d.fx.muzzleFlashScale > 0.3) {
      this.worldFlash.position.copy(this.muzzleWorld);
      this.worldFlashLife = 0.06 * d.fx.muzzleFlashScale;
    }
    impacts.muzzleSmoke(this.muzzleWorld, this.muzzleDir, d.fx.smoke);
    if (feel.muzzleFlash) impacts.muzzleBlast(this.muzzleWorld, this.muzzleDir, d.fx.muzzleFlashScale * 0.6);

    const slot = this.pendingShells.find((s) => !s.active);
    if (slot && feel.shells) {
      slot.active = true;
      slot.time = d.fx.shellEjectDelay;
    }
  }

  private onProjectileHit(r: ProjectileHitReport): void {
    if (r.hostile) return;
    this.lastHitDistance = r.distance;
    if (r.kind === 'world') return;
    this.frameDamage += r.damage;
    const rank = r.kind === 'kill' ? 3 : r.kind === 'crit' ? 2 : 1;
    if (rank >= this.frameHitRank) {
      this.frameHitRank = rank;
      this.frameHitPoint.copy(r.point);
    }
    this.lastTargetHealth = r.targetHealth >= 0 ? `${r.targetHealth.toFixed(0)} / ${r.targetMaxHealth}` : '-';
  }

  /** One hit marker + sound per frame, even when nine pellets land together. */
  private flushHits(): void {
    if (this.frameHitRank === 0) return;
    const { hud, audio } = this.deps;
    const kind: HitKind = this.frameHitRank === 3 ? 'kill' : this.frameHitRank === 2 ? 'crit' : 'hit';
    hud.showHit(kind);
    // RECOIL CONTROL grows with hits that land (a crit or a kill counts double).
    skillRaid.add('recoil', kind === 'hit' ? 1 : 2);
    hud.damageNumber(this.frameHitPoint, this.frameDamage, kind);
    this.lastDamage = `${this.frameDamage.toFixed(0)}${kind === 'crit' ? ' (crit)' : kind === 'kill' ? ' (kill)' : ''}`;
    if (kind === 'kill') {
      audio.play('ui.kill');
      Haptics.pulse(40);
    } else audio.play(kind === 'crit' ? 'ui.crit' : 'ui.hit');
  }

  onDryFire(): void {
    this.viewmodel.onMechanical('magOut');
  }

  onSound(weapon: Weapon, key: keyof WeaponData['audio']): void {
    this.deps.audio.play(weapon.data.audio[key]);
    if (key === 'magIn' || key === 'boltForward' || key === 'shellInsert' || key === 'pump' || key === 'magOut') {
      this.viewmodel.onMechanical(key);
    }
  }

  private ejectShell(): void {
    const { camera, player, shells } = this.deps;
    const rig = this.viewmodel.activeRig;
    if (!rig) return;
    this.viewmodel.toWorld(rig.ejectPort, camera.camera, this.eject);
    const d = this.current.data;
    const speed = d.fx.shellEjectSpeed;
    // Out to the ejection side, up and slightly back, in camera space.
    this.vel.set(speed * (0.9 + Math.random() * 0.3) * this.shoulder, speed * (0.55 + Math.random() * 0.3), speed * 0.15).applyQuaternion(camera.camera.quaternion);
    this.vel.add(player.velocity);
    this.e.set(Math.random() * 0.4, Math.PI / 2 + Math.random() * 0.4, 0);
    this.q.copy(camera.camera.quaternion).multiply(this.q2.setFromEuler(this.e));
    shells.eject(rig.shellType, this.eject, this.vel, this.q);
  }

  indexOf(id: string): number {
    return this.weapons.findIndex((w) => w.data.id === liveWeaponId(id));
  }

  /** Survival: start with one weapon and limited spare ammo. */
  /** Weapons whose spare ammo never runs out (survival sidearm). */
  readonly infiniteReserve = new Set<string>();

  startLoadout(id: string): void {
    const i = this.indexOf(id);
    for (const w of this.weapons) {
      w.reserve = this.infiniteReserve.has(w.data.id) ? Infinity : w.maxReserve;
      w.refill();
    }
    this.owned = [i];
    this.requestSwitch(i);
  }

  /**
   * Survival purchase: a weapon you own gets its spare ammo refilled; a new one
   * fills a free slot or replaces the weapon in your hands.
   */
  giveWeapon(id: string): 'ammo' | 'new' {
    const i = this.indexOf(id);
    const o = this.owned ?? (this.owned = [this.currentIndex]);
    const w = this.weapons[i];
    const full = this.infiniteReserve.has(id) ? Infinity : w.maxReserve;
    if (o.includes(i)) {
      w.reserve = full;
      return 'ammo';
    }
    w.refill();
    w.reserve = full;
    if (o.length < 2) o.push(i);
    else o[Math.max(0, o.indexOf(this.currentIndex))] = i;
    this.requestSwitch(i);
    return 'new';
  }

  refillAll(): void {
    for (const w of this.weapons) w.refill();
  }
}
