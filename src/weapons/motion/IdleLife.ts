import { Noise1D } from '../../core/Noise';
import { DEG } from '../../core/math';
import { motionTuning } from './MotionTuning';
import { MotionOffset, type MotionFrame } from './MotionTypes';

/**
 * A held gun is never still. Breathing (its rate and depth drift, inhale quicker than
 * exhale), muscle tremor, slow drift, a little roll and the odd small correction of the
 * hands. All coherent noise, no frame-to-frame randomness: felt more than seen.
 *
 * This is the viewmodel's "sway": aimed it is reduced, never removed, and it is the one
 * layer allowed to stay when everything else has settled (the aimed alignment check
 * measures the rest without it).
 */
export class IdleLife {
  readonly out = new MotionOffset();
  private phase = 0;
  private nRate = new Noise1D(5);
  private nDepth = new Noise1D(7);
  private nTremorX = new Noise1D(11);
  private nTremorY = new Noise1D(23);
  private nDriftX = new Noise1D(37);
  private nDriftY = new Noise1D(51);
  private nRoll = new Noise1D(61);
  private nPosX = new Noise1D(67);
  private nPosY = new Noise1D(73);
  private nFixX = new Noise1D(79);
  private nFixY = new Noise1D(89);

  update(f: MotionFrame): void {
    const B = motionTuning.breathing;
    const N = motionTuning.idleNoise;
    const t = f.time;
    const fat = f.fatigue;
    const stance = f.player.crouching ? 0.7 : 1;
    const base = f.handling.swayScale * stance * f.taste.sway;
    const turn = base * (1 - f.K.sway * f.ads);
    const shift = base * (1 - f.K.bobShift * f.ads);

    // Breathing: about 13 breaths a minute rested, faster and deeper tired.
    const rate = (B.rate + 0.25 * fat) * (1 + B.variation * this.nRate.sample(t * 0.07));
    this.phase += Math.PI * 2 * rate * f.dt;
    const ph = this.phase;
    const depth = B.amplitude * (1 + B.variation * this.nDepth.sample(t * 0.05 + 7)) * (1 + 1.6 * fat);
    const b = ((Math.sin(ph) + 0.22 * Math.sin(2 * ph - 0.6)) / 1.15) * depth;
    const bYaw = Math.sin(ph * 0.5 + 1.3) * 0.4 * depth;

    // Muscles: tremor (faster settling after ADS motion), slow drift, roll, small fixes.
    const settle = 1 + Math.min(3, Math.abs(f.adsVel) * 0.6);
    const tremor = N.tremor * (1 + 3 * fat * fat) * settle;
    // Aimed, the hands settle: less drift and fewer corrections (the sight picture holds).
    const drift = N.drift * (0.85 + 0.75 * (1 - f.ads));
    const fix = (n: number) => Math.sign(n) * Math.max(0, Math.abs(n) - 0.5) * 2;
    const fixAmp = N.correction * (1 - 0.75 * f.ads);
    const fx = fix(this.nFixX.sample(t * 0.45)) * fixAmp;
    const fy = fix(this.nFixY.sample(t * 0.41 + 20)) * fixAmp;
    const a = N.amplitude;

    this.out.rot.set(
      (b * B.pitch + a * (this.nTremorX.sample(t * 2.6) * tremor + this.nDriftX.sample(t * 0.18) * drift + fy)) * DEG * turn,
      (bYaw * B.pitch + a * (this.nTremorY.sample(t * 2.9 + 40) * tremor + this.nDriftY.sample(t * 0.16 + 80) * drift + fx)) * DEG * turn,
      a * N.roll * this.nRoll.sample(t * 0.21) * DEG * turn,
    );
    this.out.pos.set(
      a * N.position * this.nPosX.sample(t * 0.33) * shift,
      (b * B.lift + a * N.position * this.nPosY.sample(t * 0.29 + 50)) * shift,
      -0.3 * b * B.lift * shift,
    );
  }
}
