import { PoseSpring, Spring } from '../../core/Spring';
import { DEG, clamp } from '../../core/math';
import { motionTuning } from './MotionTuning';
import { MotionOffset, type MotionFrame } from './MotionTypes';

export type MechanicalEvent = 'magIn' | 'boltForward' | 'shellInsert' | 'pump' | 'magOut' | 'equip';

/** Contact impulses (velocities: m/s, rad/s) per mechanical event. */
const EVENTS: Record<MechanicalEvent, { rot: [number, number, number]; pos: [number, number, number] }> = {
  // Magazine seated: up into the gun, a small turn, a quick recovery.
  magIn: { rot: [0.35, 0, 0.2], pos: [0, 0.18, 0.08] },
  // Bolt / charging handle released: forward slam.
  boltForward: { rot: [-0.25, 0.08, -0.3], pos: [0, 0, -0.2] },
  shellInsert: { rot: [0.18, 0, 0.08], pos: [0, 0.06, 0.03] },
  pump: { rot: [-0.12, 0.05, 0.2], pos: [0, 0, -0.05] },
  magOut: { rot: [-0.1, 0, -0.1], pos: [0, -0.05, 0] },
  equip: { rot: [0.3, 0, -0.2], pos: [0, 0, 0] },
};

/**
 * Impacts from outside the steady motion: mechanical contact (magazine seated, bolt
 * released, shell pushed in, pump racked), landing (bigger the harder the fall) and the
 * take-off of a jump. Fast springs: felt as contact, gone in a moment.
 */
export class Interaction {
  readonly out = new MotionOffset();
  private jolt = new PoseSpring(20, 0.55, 14.8, 0.54);
  private land = new Spring(160, 13);
  private landRot = new Spring(140, 12);

  mechanical(kind: MechanicalEvent, mass: number): void {
    const e = EVENTS[kind];
    const m = 1 / Math.sqrt(Math.max(0.3, mass));
    this.jolt.rot.impulse(e.rot[0] * m, e.rot[1] * m, e.rot[2] * m);
    this.jolt.pos.impulse(e.pos[0] * m, e.pos[1] * m, e.pos[2] * m);
  }

  onLand(fallSpeed: number, mass: number): void {
    const L = motionTuning.landing;
    const hard = 1 + Math.max(0, fallSpeed - 8) * 0.1;
    const s = L.strength * Math.sqrt(mass) * hard;
    this.land.impulse(-clamp(fallSpeed * L.dip * s, 0, 0.7));
    this.landRot.impulse(-clamp(fallSpeed * 0.06 * s, 0, 0.9));
  }

  onJump(): void {
    this.land.impulse(-0.08 * motionTuning.landing.strength);
  }

  update(f: MotionFrame): void {
    this.jolt.update(f.dt);
    const y = this.land.update(f.dt);
    const pitch = this.landRot.update(f.dt) * DEG * motionTuning.landing.pitch;
    const { K, ads } = f;
    const turn = 1 - K.jolt * ads;
    const shift = 1 - K.recoilShift * ads;
    const land = 1 - K.landing * ads;
    const jp = this.jolt.pos.value;
    const jr = this.jolt.rot.value;
    this.out.pos.set(clamp(jp.x, -0.01, 0.01) * shift, clamp(jp.y, -0.015, 0.015) * shift + y * land, clamp(jp.z, -0.02, 0.02));
    this.out.rot.set(jr.x * turn + pitch * land, jr.y * turn, jr.z * turn);
  }

  reset(): void {
    this.jolt.reset();
  }
}
