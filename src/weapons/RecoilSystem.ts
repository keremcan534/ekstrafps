import { DEG, damp } from '../core/math';
import { feel } from '../config/Feel';
import type { WeaponData } from './WeaponData';
import type { PlayerCamera } from '../player/PlayerCamera';
import type { PlayerController } from '../player/PlayerController';
import { rearwardShare, type RecoilKick } from './Viewmodel';

/**
 * The VIEW side of recoil. The weapon's own kick lives in the Viewmodel springs
 * (it rotates around the shoulder and physically moves the sights off target).
 * Here, part of that kick reaches the shooter's view:
 *
 *   transfer = kick × cameraTransfer
 *     keep part  → added to the base look permanently (the player must pull down)
 *     rest       → a recovering offset that drifts back at cameraRecovery
 *
 * Camera recovery is deliberately restrained: it never snaps back to the
 * original pixel. Pulling the mouse against recoil first eats into the
 * recovering offset, so compensation never overshoots.
 */
/** Share of each weapon's cameraKeep (permanent climb) that stays; the rest recovers. */
const KEEP_SCALE = 0.6;

export class RecoilSystem {
  private recoverPitch = 0;
  private recoverYaw = 0;
  private currentPitch = 0;
  private currentYaw = 0;
  private keepPitch = 0;
  private keepYaw = 0;
  private sinceShot = 99;
  private data: WeaponData | null = null;
  /** Share of the view kick that reaches the view (touch aim assist lowers it on a target). */
  viewScale = 1;

  setWeapon(data: WeaponData): void {
    this.data = data;
  }

  onShot(data: WeaponData, kick: RecoilKick, camera: PlayerCamera, adsAmount: number): void {
    const r = data.recoil;
    // Recoil convergence: the more the view has already climbed in this string of
    // fire, the harder the shooter fights it, so sustained fire climbs fast at first
    // and then levels off instead of rising forever.
    const cap = Math.max(0.5, r.vertical * 2.5) * DEG;
    const soft = Math.exp(-Math.max(0, this.recoverPitch) / cap);
    // Aimed: the weapon barely flips (it drives back), so the view takes over most of
    // the climb. Overall difficulty stays similar; what you see is the world moving,
    // not the sights jumping off the screen.
    const rw = rearwardShare(adsAmount);
    const t = (r.cameraTransfer + 0.42 * rw) * feel.cameraRecoilScale * soft * this.viewScale;
    const v = kick.vertical * t * DEG;
    const h = kick.horizontal * t * 0.6 * DEG;
    // Like Tarkov's re-levelling, most of the climb comes back on its own: only part of
    // the weapon's "keep" stays in the view for the player to pull down.
    const keep = r.cameraKeep * KEEP_SCALE;
    this.keepPitch += v * keep;
    this.keepYaw -= h * keep;
    this.recoverPitch += v * (1 - keep);
    this.recoverYaw -= h * (1 - keep);
    this.sinceShot = 0;

    // Small visual-only punch: the gun moving dominates, the view barely flinches.
    const s = Math.sqrt(camera.punch.stiffness) * 1.9 * DEG * feel.cameraRecoilScale * (1 - 0.4 * adsAmount - 0.35 * rw);
    camera.addPunch(r.punch * s, r.punch * 0.3 * s * (Math.random() * 2 - 1), r.punch * 0.8 * s * (Math.random() < 0.5 ? -1 : 1));
    camera.addShake(Math.min(0.35, kick.vertical * 0.012 + r.punch * 0.06) * feel.cameraRecoilScale);
    // Brief FOV kick sells the blast of big cartridges from the hip. None when aimed: a
    // zoom pulse there reads as the sights swelling and shrinking every shot.
    camera.addFovPunch(r.punch * 25 * (1 - adsAmount) * feel.cameraRecoilScale);
  }

  /**
   * Absorb player look input that opposes the recovering offset.
   * Returns the look deltas that should still be applied to the base view.
   */
  absorb(lookYaw: number, lookPitch: number): [number, number] {
    if (lookPitch < 0 && this.recoverPitch > 0) {
      const a = Math.min(-lookPitch, this.recoverPitch);
      this.recoverPitch -= a;
      this.currentPitch -= a;
      lookPitch += a;
    }
    if (lookYaw !== 0 && Math.sign(lookYaw) === -Math.sign(this.recoverYaw)) {
      const a = Math.min(Math.abs(lookYaw), Math.abs(this.recoverYaw));
      const s = Math.sign(this.recoverYaw);
      this.recoverYaw -= a * s;
      this.currentYaw -= a * s;
      lookYaw += a * s;
    }
    return [lookYaw, lookPitch];
  }

  update(dt: number, camera: PlayerCamera, player: PlayerController): void {
    const d = this.data;
    if (!d) return;
    this.sinceShot += dt;

    // Permanent part flows smoothly into the base look (no snapping).
    const k = damp(30, dt);
    const kp = this.keepPitch * k;
    const ky = this.keepYaw * k;
    this.keepPitch -= kp;
    this.keepYaw -= ky;
    player.updateLook(ky, kp);

    // Recovering part: shove up quickly, drift back slowly once firing stops.
    if (this.sinceShot > 0.1) {
      const rk = damp(d.recoil.cameraRecovery, dt);
      this.recoverPitch -= this.recoverPitch * rk;
      this.recoverYaw -= this.recoverYaw * rk;
    }
    const s = damp(28, dt);
    this.currentPitch += (this.recoverPitch - this.currentPitch) * s;
    this.currentYaw += (this.recoverYaw - this.currentYaw) * s;
    camera.aimPitch = this.currentPitch;
    camera.aimYaw = this.currentYaw;
  }

  reset(): void {
    this.recoverPitch = this.recoverYaw = this.currentPitch = this.currentYaw = 0;
    this.keepPitch = this.keepYaw = 0;
  }
}
