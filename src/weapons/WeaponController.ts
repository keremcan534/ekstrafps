import * as THREE from 'three';
import { clamp, moveTowards } from '../core/math';
import type { Input } from '../core/Input';
import { Haptics } from '../core/Haptics';
import { feel } from '../config/Feel';
import type { AudioSystem } from '../audio/AudioSystem';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { Shells } from '../fx/Shells';
import type { HUD } from '../ui/HUD';
import type { PlayerCamera } from '../player/PlayerCamera';
import type { PlayerController } from '../player/PlayerController';
import { Weapon, type WeaponListener } from './Weapon';
import type { WeaponData } from './WeaponData';
import { RecoilSystem } from './RecoilSystem';
import { Viewmodel } from './Viewmodel';
import { Hitscan, type ShotResult } from './Hitscan';
import type { Physics } from '../core/Physics';
import type { DebugDraw } from '../fx/DebugDraw';
import { Laser } from '../fx/Laser';

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

const HAPTIC_MS: Record<WeaponData['model'], number> = { rifle: 7, pistol: 16, shotgun: 32 };

/**
 * Owns the player's weapons and wires one shot through every feedback layer:
 * muzzle hitscan → recoil (aim) → camera punch → weapon kick → flash/smoke/shell/tracer
 * → audio → hit markers. Also handles switching, ADS blending and sprint rules.
 *
 * Per frame (order matters):
 *   updateState()  switching, ADS / sprint rules
 *   updatePose()   after the camera: aim the physical weapon, compute the muzzle ray
 *   updateFire()   weapon logic; shots leave the real muzzle along the bore
 */
export class WeaponController implements WeaponListener {
  readonly weapons: Weapon[];
  readonly recoil = new RecoilSystem();
  readonly viewmodel: Viewmodel;
  readonly hitscan: Hitscan;
  current: Weapon;
  currentIndex = 0;
  adsAmount = 0;

  // Debug stats
  currentSpread = 0;
  lastHitDistance = -1;
  lastDamage = '-';
  lastTargetHealth = '-';
  /** Angle between the camera aim ray and the bore (deg). */
  aimErrorDeg = 0;
  readonly laser = new Laser();
  /** Live muzzle ray, refreshed every frame in updatePose(). */
  readonly muzzleWorld = new THREE.Vector3();
  readonly muzzleDir = new THREE.Vector3();
  /** Camera aim (intent) direction this frame. */
  get cameraAimDir(): THREE.Vector3 {
    return this.aim;
  }

  private pendingIndex = -1;
  private lastIndex = 1;
  private worldFlash: THREE.PointLight;
  private worldFlashLife = 0;
  private pendingShells: PendingShell[] = Array.from({ length: 8 }, () => ({ time: 0, active: false }));
  private aimPoint = new THREE.Vector3();
  private laserFrom = new THREE.Vector3();
  private laserDir = new THREE.Vector3();
  private rayEnd = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private toMuzzle = new THREE.Vector3();
  private eject = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private q2 = new THREE.Quaternion();

  constructor(defs: WeaponData[], aspect: number, private deps: WeaponControllerDeps) {
    this.weapons = defs.map((d) => new Weapon(d, this));
    this.viewmodel = new Viewmodel(aspect, defs);
    this.hitscan = new Hitscan(deps.physics, deps.impacts);
    this.worldFlash = new THREE.PointLight(0xffaa55, 0, 9, 2);
    deps.worldScene.add(this.worldFlash, this.laser.group);
    this.hitscan.onPellet = (from, to) => deps.debugDraw.persistent(from, to, 0xff8a2a, 2.5);
    this.current = this.weapons[0];
    this.activate(0);
  }

  private activate(index: number): void {
    this.currentIndex = index;
    this.current = this.weapons[index];
    this.current.equip();
    this.recoil.setWeapon(this.current.data);
    this.viewmodel.setWeapon(this.current);
    this.viewmodel.onMechanical('equip');
    for (const s of this.pendingShells) s.active = false;
  }

  requestSwitch(index: number): void {
    if (index < 0 || index >= this.weapons.length) return;
    if (index === this.currentIndex && this.pendingIndex < 0) return;
    if (index === this.currentIndex) {
      // Changed mind mid-holster: bring the same gun back up.
      this.pendingIndex = -1;
      this.current.equip();
      return;
    }
    this.pendingIndex = index;
    if (this.current.state !== 'holstering' && this.current.state !== 'holstered') this.current.holster();
  }

  updateState(dt: number, input: Input): void {
    const { player } = this.deps;

    // --- Switching ---
    if (input.slotPressed >= 0) this.requestSwitch(input.slotPressed);
    if (input.cyclePressed === -2) this.requestSwitch(this.lastIndex);
    else if (input.cyclePressed !== 0) {
      const n = this.weapons.length;
      this.requestSwitch((this.currentIndex + input.cyclePressed + n) % n);
    }
    if (this.pendingIndex >= 0 && this.current.state === 'holstered') {
      this.lastIndex = this.currentIndex;
      const next = this.pendingIndex;
      this.pendingIndex = -1;
      this.adsAmount = 0;
      this.activate(next);
    }

    const w = this.current;

    // --- Sprint / ADS rules ---
    const wantsFire = input.fireHeld || input.firePressed;
    const canAds = w.state === 'ready' || (w.state === 'equipping' && w.stateProgress > 0.6);
    const adsTarget = input.adsHeld && canAds ? 1 : 0;
    // Firing or aiming always wins over sprinting.
    player.sprintBlocked = adsTarget > 0 || (wantsFire && w.state === 'ready');
    this.adsAmount = moveTowards(this.adsAmount, adsTarget, w.data.ads.speed * dt);
    player.adsAmount = this.adsAmount;
  }

  /**
   * Aim the physical weapon. Must run after the camera has its final transform.
   * The weapon points at the camera's aim ray at the convergence distance (hip)
   * or zero distance (ADS); inertia, bob, recoil etc. then move it off that line.
   */
  updatePose(dt: number, lookYaw: number, lookPitch: number): void {
    const { player, camera, physics, debugDraw } = this.deps;
    const d = this.current.data;
    const cam = camera.camera;

    camera.getAimDirection(player, this.aim);
    const dist = d.aim.hipConvergence + (d.aim.zeroDistance - d.aim.hipConvergence) * this.adsAmount;
    this.aimPoint.copy(camera.eye).addScaledVector(this.aim, dist);
    cam.worldToLocal(this.aimPoint);
    this.viewmodel.update(dt, { player, lookYaw, lookPitch, adsAmount: this.adsAmount, aimPoint: this.aimPoint, mainCamera: cam });

    const rig = this.viewmodel.activeRig!;
    this.viewmodel.toWorld(rig.muzzle, cam, this.muzzleWorld);
    this.viewmodel.forwardWorld(rig.muzzle, cam, this.muzzleDir);
    this.aimErrorDeg = Math.acos(Math.min(1, this.muzzleDir.dot(this.aim))) * (180 / Math.PI);

    // Test laser: parallel to the bore, from the emitter under the barrel.
    if (this.laser.enabled) {
      this.viewmodel.toWorld(rig.laser, cam, this.laserFrom);
      this.viewmodel.forwardWorld(rig.laser, cam, this.laserDir);
      const hit = physics.raycast(this.laserFrom, this.laserDir, 200);
      this.rayEnd.copy(this.laserFrom).addScaledVector(this.laserDir, hit ? hit.distance : 200);
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
      // Weapon aim ray (bore line): yellow
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
    const { player, camera } = this.deps;
    const w = this.current;

    // --- Weapon logic (may call onShot) ---
    this.current.update(dt, {
      fireHeld: input.fireHeld,
      firePressed: input.firePressed,
      reloadPressed: input.reloadPressed,
      sprinting: player.sprinting,
    });
    if (w.state === 'reloading' && input.adsHeld && w.data.reload.kind === 'magazine') {
      // ADS is dropped during magazine reloads (prevents pose conflicts).
      this.adsAmount = moveTowards(this.adsAmount, 0, w.data.ads.speed * dt * 2);
    }

    this.currentSpread = this.computeSpread();
    this.recoil.update(dt, camera);

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
      this.worldFlash.intensity = Math.max(0, this.worldFlashLife / 0.06) * 25;
    } else {
      this.worldFlash.intensity = 0;
    }
  }

  computeSpread(): number {
    const d = this.current.data;
    const p = this.deps.player;
    const ads = this.adsAmount;
    const base = d.spread.hip + (d.spread.ads - d.spread.hip) * ads;
    const moving = d.spread.moving * clamp(p.speedRatio, 0, 1.3) * (1 - 0.6 * ads);
    const air = p.grounded ? 0 : d.spread.air * (1 - 0.4 * ads);
    const crouch = p.crouching ? d.spread.crouchMultiplier : 1;
    return (base + this.current.bloom * (1 - 0.5 * ads) + moving + air) * crouch;
  }

  // ---------------- WeaponListener ----------------

  onShot(weapon: Weapon): void {
    const { camera, audio, impacts, hud, physics } = this.deps;
    const d = weapon.data;
    const ads = this.adsAmount;

    // Shots leave the real muzzle along the bore. If the muzzle pokes through
    // geometry (eye -> muzzle blocked), the shot starts at the obstruction instead.
    this.origin.copy(this.muzzleWorld);
    this.toMuzzle.subVectors(this.muzzleWorld, camera.eye);
    const reach = this.toMuzzle.length();
    const blocked = reach > 1e-4 ? physics.raycast(camera.eye, this.toMuzzle.divideScalar(reach), reach) : null;
    if (blocked) this.origin.copy(blocked.point).addScaledVector(this.toMuzzle, -0.02);

    const spread = this.computeSpread();
    const result = this.hitscan.fire(d, this.origin, this.muzzleDir, spread, this.muzzleWorld, weapon.totalShots);

    // Recoil layers (independent): aim displacement, camera punch, viewmodel kick.
    this.recoil.onShot(d, weapon.shotIndex, ads);
    this.recoil.applyCameraKick(d, camera, ads);
    this.viewmodel.onShot(d, ads);

    audio.play(d.audio.fire);
    Haptics.pulse(HAPTIC_MS[d.model]);
    if (feel.muzzleFlash) {
      this.worldFlash.position.copy(this.muzzleWorld);
      this.worldFlashLife = 0.06 * d.fx.muzzleFlashScale;
    }
    impacts.muzzleSmoke(this.muzzleWorld, this.muzzleDir, d.fx.smoke);

    // Shell ejection (shotgun ejects on the pump stroke)
    const slot = this.pendingShells.find((s) => !s.active);
    if (slot && feel.shells) {
      slot.active = true;
      slot.time = d.fx.shellEjectDelay;
    }

    this.handleResult(result, hud);
  }

  private handleResult(result: ShotResult, hud: HUD): void {
    const { audio } = this.deps;
    if (result.distance >= 0) this.lastHitDistance = result.distance;
    if (result.kind === 'miss') return;
    hud.showHit(result.kind);
    hud.damageNumber(result.point, result.damage, result.kind);
    this.lastDamage = `${result.damage.toFixed(0)}${result.kind === 'crit' ? ' (crit)' : result.kind === 'kill' ? ' (kill)' : ''}`;
    this.lastTargetHealth = result.targetHealth >= 0 ? `${result.targetHealth.toFixed(0)} / ${result.targetMaxHealth}` : '-';
    if (result.kind === 'kill') {
      audio.play('ui.kill');
      Haptics.pulse(40);
    } else if (result.kind === 'crit') {
      audio.play('ui.crit');
    } else {
      audio.play('ui.hit');
    }
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
    // Right, up and slightly back in camera space.
    this.vel.set(speed * (0.9 + Math.random() * 0.3), speed * (0.55 + Math.random() * 0.3), speed * 0.15).applyQuaternion(camera.camera.quaternion);
    this.vel.add(player.velocity);
    this.e.set(Math.random() * 0.4, Math.PI / 2 + Math.random() * 0.4, 0);
    this.q.copy(camera.camera.quaternion).multiply(this.q2.setFromEuler(this.e));
    shells.eject(rig.shellType, this.eject, this.vel, this.q);
  }

  refillAll(): void {
    for (const w of this.weapons) w.refill();
  }
}
