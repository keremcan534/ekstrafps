import { DEG, damp } from '../core/math';
import { feel } from '../config/Feel';
import type { WeaponData } from './WeaponData';
import type { PlayerCamera } from '../player/PlayerCamera';

/**
 * Aim displacement + recovery. This is the recoil that actually moves where
 * bullets go, kept separate from the visual camera punch and weapon-model kick.
 *
 *  target  – where recoil wants the aim to be (accumulates kicks, recovers to 0)
 *  current – follows target with `snappiness` so kicks feel like a fast shove, not a teleport
 *
 * Learnable: vertical climb + a deterministic horizontal pattern, with only a
 * small random component. Consecutive shots build "heat" which scales recoil, so
 * holding full-auto climbs harder than tap-firing.
 *
 * Player compensation is absorbed: pulling the mouse against recoil eats into the
 * recoil offset instead of the base look, so recovery never overshoots below the
 * original point of aim.
 */
export class RecoilSystem {
  private targetPitch = 0;
  private targetYaw = 0;
  private currentPitch = 0;
  private currentYaw = 0;
  private sinceShot = 99;
  heat = 0;
  private data: WeaponData | null = null;

  setWeapon(data: WeaponData): void {
    this.data = data;
  }

  onShot(data: WeaponData, shotIndex: number, adsAmount: number): void {
    const r = data.recoil;
    if (shotIndex === 0) this.heat = 0;
    const first = shotIndex === 0 ? r.firstShotMultiplier : 1;
    const adsMult = 1 + (r.adsMultiplier - 1) * adsAmount;
    const mult = first * (1 + this.heat) * adsMult * feel.recoilScale;

    const pattern = r.horizontalBias + Math.sin(shotIndex * r.patternFrequency) * r.patternAmplitude;
    const random = (Math.random() * 2 - 1) * r.horizontal;

    this.targetPitch += r.vertical * mult * DEG;
    this.targetYaw -= (pattern + random) * mult * DEG; // + bias = drift right (negative yaw)
    this.heat = Math.min(r.buildUpMax, this.heat + r.buildUpPerShot);
    this.sinceShot = 0;
  }

  /**
   * Absorb player look input that opposes the recoil offset.
   * Returns the look deltas that should still be applied to the base view.
   */
  absorb(lookYaw: number, lookPitch: number): [number, number] {
    if (lookPitch < 0 && this.targetPitch > 0) {
      const a = Math.min(-lookPitch, this.targetPitch);
      this.targetPitch -= a;
      this.currentPitch -= a;
      lookPitch += a;
    }
    if (lookYaw !== 0 && Math.sign(lookYaw) === -Math.sign(this.targetYaw)) {
      const a = Math.min(Math.abs(lookYaw), Math.abs(this.targetYaw));
      const s = Math.sign(this.targetYaw);
      this.targetYaw -= a * s;
      this.currentYaw -= a * s;
      lookYaw += a * s;
    }
    return [lookYaw, lookPitch];
  }

  update(dt: number, camera: PlayerCamera): void {
    const d = this.data;
    if (!d) return;
    this.sinceShot += dt;
    const r = d.recoil;

    if (this.sinceShot > r.recoveryDelay) {
      const k = damp(r.recoverySpeed, dt);
      this.targetPitch -= this.targetPitch * k;
      this.targetYaw -= this.targetYaw * k;
      // Heat cools off once you stop firing; tapping keeps it low.
      this.heat = Math.max(0, this.heat - dt * 2.5);
    }
    const s = damp(r.snappiness, dt);
    this.currentPitch += (this.targetPitch - this.currentPitch) * s;
    this.currentYaw += (this.targetYaw - this.currentYaw) * s;

    camera.aimPitch = this.currentPitch;
    camera.aimYaw = this.currentYaw;
  }

  /** Visual camera punch + FOV punch + shake for a shot (bullets ignore these). */
  applyCameraKick(data: WeaponData, camera: PlayerCamera, adsAmount: number): void {
    const c = data.cameraRecoil;
    camera.punch.stiffness = c.stiffness;
    camera.punch.damping = c.damping;
    const scale = feel.cameraRecoilScale * (1 - 0.35 * adsAmount);
    // Convert "degrees of kick" into a spring impulse that peaks roughly at that angle.
    const w = Math.sqrt(c.stiffness) * 1.9 * DEG * scale;
    const side = Math.random() < 0.5 ? -1 : 1;
    camera.addPunch(c.pitch * w, c.yaw * w * (Math.random() * 2 - 1), c.roll * w * side);
    camera.addFovPunch(c.fovPunch * Math.sqrt(camera.fovPunch.stiffness) * 1.9 * (1 - 0.5 * adsAmount));
    camera.addShake(c.shake * (1 - 0.5 * adsAmount));
  }

  reset(): void {
    this.targetPitch = this.targetYaw = this.currentPitch = this.currentYaw = 0;
    this.heat = 0;
  }
}
