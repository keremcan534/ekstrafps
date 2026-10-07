import * as THREE from 'three';
import { Spring, Spring3 } from '../core/Spring';
import { DEG, damp, clamp, hfovToVfov } from '../core/math';
import { playerConfig as cfg } from './PlayerConfig';
import { LEAN_ANGLE, type PlayerController } from './PlayerController';

/**
 * Composes the final render camera from independent layers:
 *   base look (player yaw/pitch)
 * + aim displacement (recoil that moves where bullets go)
 * + view punch (visual-only spring kick, bullets ignore it)
 * + landing dip / pitch, walk bob, strafe roll, trauma shake
 * + FOV: base -> sprint -> ADS, plus a tiny firing FOV punch.
 */
export class PlayerCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Aim displacement from recoil (radians). Bullets follow this. */
  aimPitch = 0;
  aimYaw = 0;
  /** The view's roll from recoil (radians, visual only). */
  recoilRoll = 0;

  /** Visual-only punch (x = pitch, y = yaw, z = roll), radians. */
  readonly punch = new Spring3(180, 18);
  readonly fovPunch = new Spring(260, 22);
  private landingDip = new Spring(140, 16);
  private landingPitch = new Spring(120, 14);
  private trauma = 0;
  private shakeTime = Math.random() * 100;
  private roll = 0;
  private fov = cfg.baseFov;
  private sprintBlend = 0;

  readonly eye = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private aimQuat = new THREE.Quaternion();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(hfovToVfov(cfg.baseFov), aspect, 0.03, 400);
  }

  addPunch(pitch: number, yaw: number, roll: number): void {
    this.punch.impulse(pitch, yaw, roll);
  }

  addFovPunch(amount: number): void {
    this.fovPunch.impulse(amount);
  }

  /** Trauma-style shake, 0..1. Shake = trauma² so small hits stay subtle. */
  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * cfg.cameraShakeScale);
  }

  landingImpact(fallSpeed: number): void {
    const dip = clamp((fallSpeed - 2) * cfg.landingDipScale, 0, cfg.landingDipMax);
    this.landingDip.impulse(-dip * 14);
    this.landingPitch.impulse(-cfg.landingPitchKick * DEG * clamp(fallSpeed / 10, 0.2, 1.5) * 10);
    if (fallSpeed > 9) this.addShake(0.15);
  }

  /** 1 while downed (last stand): head near the floor. */
  downedTarget = 0;
  private downedBlend = 0;
  /** Seconds since death (-1 = alive): the camera drops to the floor and rolls onto its side. */
  deadTime = -1;
  private deathSide = 1;

  die(): void {
    this.deadTime = 0;
    this.deathSide = Math.random() < 0.5 ? -1 : 1;
    this.addShake(0.5);
  }

  revive(): void {
    this.deadTime = -1;
    this.downedTarget = 0;
  }

  /** `hipFov`: the weapon's own hip FOV (horizontal deg), null for the player's setting. */
  update(dt: number, alpha: number, player: PlayerController, adsAmount: number, adsFov: number, hipFov: number | null = null): void {
    this.punch.update(dt);
    this.fovPunch.update(dt);
    this.landingDip.update(dt);
    this.landingPitch.update(dt);

    // --- Position ---
    player.getEyePosition(alpha, this.eye);
    const bobScale = cfg.cameraBobAmount * clamp(player.speedRatio, 0, 1.6) * (player.grounded ? 1 : 0) * (1 - 0.8 * adsAmount);
    const bobY = Math.abs(Math.sin(player.bobPhase)) * bobScale - bobScale * 0.5;
    const bobX = Math.cos(player.bobPhase) * bobScale * 0.35;
    const right = Math.cos(player.yaw);
    const rightZ = -Math.sin(player.yaw);
    // Lean: the head swings around the hips, so it moves sideways AND a little down.
    const leanA = player.lean * LEAN_ANGLE;
    const leanR = player.eyeHeight - player.leanPivotHeight;
    const leanX = Math.sin(leanA) * leanR;
    const leanY = (Math.cos(leanA) - 1) * leanR;
    this.camera.position.set(
      this.eye.x + right * (bobX + leanX),
      this.eye.y + bobY + this.landingDip.value + leanY,
      this.eye.z + rightZ * (bobX + leanX),
    );
    // Bullets and aim use the leaned eye too.
    this.eye.x += right * leanX;
    this.eye.y += leanY;
    this.eye.z += rightZ * leanX;

    // Downed / dead: the body drops (gravity-like ease-in) and the head rolls to the side.
    this.downedBlend += (this.downedTarget - this.downedBlend) * damp(5, dt);
    let drop = this.downedBlend * (player.eyeHeight - 0.55);
    let deathRoll = 0;
    let deathPitch = 0;
    if (this.deadTime >= 0) {
      this.deadTime += dt;
      const k = Math.min(1, this.deadTime / 0.8);
      const fall = k * k;
      const settle = this.deadTime > 0.8 ? Math.sin(Math.min(1, (this.deadTime - 0.8) / 0.25) * Math.PI) * 0.04 : 0;
      drop = Math.max(drop, fall * (player.eyeHeight - 0.2) - settle);
      deathRoll = fall * 1.3 * this.deathSide;
      deathPitch = fall * 0.12;
      this.camera.position.x += right * fall * 0.3 * this.deathSide;
      this.camera.position.z += rightZ * fall * 0.3 * this.deathSide;
    }
    this.camera.position.y -= drop;
    this.eye.y -= drop;

    // --- Shake (smooth pseudo-noise) ---
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.shakeTime += dt * 28;
    const s = this.trauma * this.trauma;
    const t = this.shakeTime;
    const shakePitch = s * 1.6 * DEG * (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.7) * 0.5);
    const shakeYaw = s * 1.6 * DEG * (Math.sin(t * 1.3 + 4.1) + Math.sin(t * 2.9 + 0.3) * 0.5);
    const shakeRoll = s * 2.2 * DEG * Math.sin(t * 0.9 + 2.2);

    // --- Strafe roll ---
    const lateral = player.velocity.x * Math.cos(player.yaw) - player.velocity.z * Math.sin(player.yaw);
    const targetRoll = -(lateral / cfg.walkSpeed) * cfg.cameraRollOnStrafe * DEG * (1 - adsAmount);
    this.roll += (targetRoll - this.roll) * damp(8, dt);

    // --- Rotation ---
    this.euler.set(
      player.pitch + this.aimPitch + this.punch.value.x + this.landingPitch.value + shakePitch + deathPitch,
      player.yaw + this.aimYaw + this.punch.value.y + shakeYaw,
      this.punch.value.z + this.recoilRoll + this.roll + shakeRoll - leanA * 0.9 + deathRoll + this.downedBlend * 0.18,
    );
    this.camera.quaternion.setFromEuler(this.euler);

    // --- FOV ---
    this.sprintBlend += ((player.sprinting ? 1 : 0) - this.sprintBlend) * damp(cfg.fovLerpSpeed, dt);
    const hip = (hipFov ?? cfg.baseFov) + cfg.sprintFovAdd * this.sprintBlend;
    const targetFov = hip + (adsFov - hip) * adsAmount;
    this.fov += (targetFov - this.fov) * damp(cfg.fovLerpSpeed * 2, dt);
    const finalFov = hfovToVfov(this.fov + this.fovPunch.value);
    if (Math.abs(this.camera.fov - finalFov) > 0.001) {
      this.camera.fov = finalFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Direction bullets travel: base look + aim displacement (no punch/shake/bob). */
  getAimDirection(player: PlayerController, out: THREE.Vector3): THREE.Vector3 {
    this.aimEuler.set(player.pitch + this.aimPitch, player.yaw + this.aimYaw, 0);
    this.aimQuat.setFromEuler(this.aimEuler);
    return out.set(0, 0, -1).applyQuaternion(this.aimQuat);
  }

  getAimQuaternion(): THREE.Quaternion {
    return this.aimQuat;
  }

  /** Current vertical FOV in degrees (what the renderer uses). */
  get currentFov(): number {
    return this.camera.fov;
  }
}
