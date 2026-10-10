import { DEG } from '../core/math';
import { feel } from '../config/Feel';
import type { PlayerCamera } from '../player/PlayerCamera';
import type { PlayerController } from '../player/PlayerController';
import type { TarkovRecoil } from './TarkovRecoil';

/**
 * The VIEW side of recoil, Tarkov's way (the model is TarkovRecoil, kicked by the weapon's
 * recoil layer): the view carries its share of the hands' turn (RecoilCamera, following at
 * CameraSnap) and rolls with the per-shot camera curve. Bullets follow it plus the gun's own
 * turn. How much of the climb the view carries is the platform's feel profile (recoilFeel():
 * a small share, so the sights rise on screen and the screen stays put); with the profile's
 * `settle` off a string of fire leaves nothing in the look, the hands come back to where they
 * were aimed. Nothing absorbs the player's pull against recoil: pull down through a burst and
 * the hands' return carries the aim below once it stops.
 */
export class RecoilSystem {
  private model: TarkovRecoil | null = null;
  /** Share of the view kick that reaches the view (touch aim assist lowers it on a target). */
  viewScale = 1;

  /** The recoil model the weapon kicks (the viewmodel's recoil layer). */
  attach(model: TarkovRecoil): void {
    this.model = model;
  }

  /** The player's look input, as it should reach the base view: unchanged (Tarkov has no absorption). */
  absorb(lookYaw: number, lookPitch: number): [number, number] {
    return [lookYaw, lookPitch];
  }

  update(_dt: number, camera: PlayerCamera, player: PlayerController): void {
    const m = this.model;
    if (!m) return;
    const [px, py] = m.takeSettled();
    if (px || py) player.updateLook(-py * DEG, px * DEG);
    const s = feel.cameraRecoilScale * this.viewScale;
    camera.aimPitch = m.cam.x * s * DEG;
    camera.aimYaw = -m.cam.y * s * DEG;
    camera.recoilRoll = -m.cameraRoll * feel.cameraRecoilScale * DEG;
  }

  reset(): void {
    this.model?.reset();
  }
}
