import * as THREE from 'three';
import { Spring3, tuneSpring } from '../../core/Spring';
import { DEG, clamp } from '../../core/math';
import { motionTuning } from './MotionTuning';
import { MotionOffset, softClamp, type MotionFrame } from './MotionTypes';

/**
 * The camera is the eye; the weapon is an object in the hands. Turning the view drags the
 * gun after it through the arms:
 *
 *   - steady turn: it trails by turn rate × lag time (a heavier, longer gun trails more)
 *   - a change of turn rate reaches it as momentum (an impulse), so a flick starts with the
 *     gun hanging back and a sudden stop carries it past centre before it settles
 *
 * Yaw lag also rolls the gun and shifts it sideways; pitch lag shifts it vertically. Purely
 * visual: the aim never moves with it (the shot follows the gun only through the
 * viewmodel's own shot-direction rule, as before).
 */
export class CameraInertia {
  readonly out = new MotionOffset();
  /** Rotation lag (rad): x pitch, y yaw. */
  private spring = new Spring3(100, 12);
  private prevRate = new THREE.Vector2();
  private primed = false;

  update(f: MotionFrame): void {
    const T = motionTuning.cameraInertia;
    const h = f.handling;
    const wn = Math.max(1, h.followFreq * T.springStrength * f.cls.response);
    tuneSpring(this.spring, wn, clamp(h.followZeta * T.springDamping, 0.05, 2));
    const lagTime = h.inertiaTime * T.rotationLag * f.cls.mass;
    const r = f.lookRate;
    this.spring.target.set(-r.x * lagTime, -r.y * lagTime, 0);
    if (this.primed) {
      const g = lagTime * wn * T.overshootStrength;
      this.spring.impulse(-(r.x - this.prevRate.x) * g, -(r.y - this.prevRate.y) * g, 0);
    }
    this.prevRate.copy(r);
    this.primed = true;
    const v = this.spring.update(f.dt);

    const maxR = T.maxRotationOffset * DEG;
    const maxP = T.maxPositionOffset;
    const { K, ads } = f;
    const turn = f.taste.inertia * (1 - K.inertia * ads);
    const pitch = softClamp(v.x, maxR) * turn;
    const yaw = softClamp(v.y, maxR) * turn;
    const roll = 1 - K.inertiaRoll * ads;
    const shift = 1 - K.inertiaShift * ads;
    this.out.rot.set(pitch, yaw, yaw * T.rollFromYaw * roll);
    this.out.pos.set(softClamp(yaw * T.positionLag, maxP) * shift, softClamp(pitch * T.positionLag * 0.85, maxP) * shift, 0);
  }

  /** Current lag before ADS reduction (rad). */
  get lag(): THREE.Vector3 {
    return this.spring.value;
  }

  reset(): void {
    this.spring.reset();
    this.primed = false;
    this.out.clear();
  }
}
