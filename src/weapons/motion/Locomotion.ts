import { PoseSpring } from '../../core/Spring';
import { Noise1D } from '../../core/Noise';
import { DEG, clamp, damp, lerp } from '../../core/math';
import { playerConfig } from '../../player/PlayerConfig';
import { motionTuning } from './MotionTuning';
import { MotionOffset, type MotionFrame } from './MotionTypes';

/**
 * The body walks underneath a gun the arms are carrying. Not one sine wave: several layers
 * on the walk cycle (bobPhase advances with distance, so the rate follows the speed):
 *
 *   body step      vertical, twice a stride, lowest just after each foot plant
 *   shoulders      sideways once a stride, with a roll and a twist that trail it
 *   pitch          a small nod against the step
 *   hand control   slow coherent noise: the hands keeping the muzzle on line
 *   footfalls      every plant is an impulse into a quick spring (down, toward that
 *                  foot, a little roll): what makes a sprint feel like running
 *
 * Every stride is a little different (coherent noise on amplitude and timing per step).
 * Amplitude grows faster than speed: still → nothing, slow → controlled, sprint → strong.
 */
export class Locomotion {
  readonly out = new MotionOffset();
  private step = new PoseSpring(26, 0.42, 22, 0.45);
  private gait = 0;
  private ground = 1;
  private back = 0;
  private lastStep = NaN;
  private nAmp = new Noise1D(71);
  private nTime = new Noise1D(83);
  private nCx = new Noise1D(97);
  private nCy = new Noise1D(109);

  update(f: MotionFrame): void {
    const W = motionTuning.walking;
    const S = motionTuning.sprint;
    const dt = f.dt;
    const walk = Math.max(0.5, playerConfig.walkSpeed);
    this.gait += (clamp(f.speed / walk, 0, 1.7) - this.gait) * damp(6, dt);
    this.ground += ((f.player.grounded ? 1 : 0) - this.ground) * damp(10, dt);
    this.back += ((f.fwdVel < -0.5 ? 1 : 0) - this.back) * damp(5, dt);
    const gait = this.gait;
    const sprint = f.sprint;
    const taste = f.cls.bob * f.taste.bob * (1 - 0.3 * this.back) * (1 - 0.35 * f.crouch);

    const ph = f.player.bobPhase;
    const stepT = ph / Math.PI;
    const vary = 1 + W.variation * this.nAmp.sample(stepT * 0.73);
    const phi = ph + W.variation * 0.6 * this.nTime.sample(stepT * 0.41);
    const a = W.amplitude * taste * Math.pow(gait, 1.25) * this.ground * lerp(1, S.amplitude, sprint) * vary;

    const pv = phi - 0.35;
    const y = a * W.vertical * (-0.5 * Math.cos(2 * pv) + 0.14 * Math.sin(4 * pv + 0.8)) * (1 + 0.4 * sprint);
    const x = a * W.horizontal * (Math.sin(phi) + 0.15 * Math.sin(3 * phi + 0.4)) * (1 + 0.3 * sprint);
    const roll = a * W.roll * DEG * Math.sin(phi + 0.35) * (1 + 0.8 * sprint);
    const yaw = a * W.yaw * DEG * Math.sin(phi - 0.3) * (1 + 0.5 * sprint);
    let pitch = a * W.pitch * DEG * Math.cos(2 * phi + 0.6);
    const c = W.handCorrection * DEG * Math.min(1, gait) * this.ground * taste;
    pitch += c * this.nCy.sample(f.time * 0.9);
    const yawC = yaw + c * this.nCx.sample(f.time * 0.8 + 30);

    // Footfalls: one impulse per plant (bobPhase passes a multiple of π).
    const idx = Math.floor(stepT);
    if (idx !== this.lastStep && Number.isFinite(this.lastStep) && this.ground > 0.5 && gait > 0.05) {
      const foot = idx & 1 ? 1 : -1;
      const s = W.stepImpulse * lerp(1, S.stepImpulse, sprint) * gait * gait * vary * taste;
      this.step.kick(foot * 0.0006 * s, -0.0012 * s, 0.0003 * s, -0.25 * DEG * s, foot * 0.2 * DEG * s, foot * 0.35 * DEG * s);
    }
    this.lastStep = idx;
    this.step.update(dt);

    const { K, ads } = f;
    const shift = 1 - K.bobShift * ads;
    const turn = 1 - K.bobTurn * ads;
    const sp = this.step.pos.value;
    const sr = this.step.rot.value;
    this.out.pos.set((x + sp.x) * shift, (y + sp.y) * shift, sp.z * shift);
    this.out.rot.set((pitch + sr.x) * turn, (yawC + sr.y) * turn, (roll + sr.z) * turn);
  }

  reset(): void {
    this.step.reset();
    this.lastStep = NaN;
    this.out.clear();
  }
}
