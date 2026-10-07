import * as THREE from 'three';
import { PoseSpring } from '../../core/Spring';
import { DEG, clamp, damp } from '../../core/math';
import { playerConfig } from '../../player/PlayerConfig';
import { motionTuning } from './MotionTuning';
import { MotionOffset, softClamp, type MotionFrame } from './MotionTypes';

const MAX_TILT = 4 * DEG;

/**
 * The body accelerates, the gun in its hands follows a moment later. Every change of the
 * body's velocity (start, stop, strafe, turn of direction, jump, crouch) reaches the gun
 * as an impulse in the opposite direction; a spring brings it back. Acceleration drives
 * it, not speed: walking steadily the gun just rides along.
 *
 * Steady parts (spring targets): strafing rolls the gun into the move and shifts it a
 * little against it, walking backwards lifts the muzzle, rising and falling move it
 * against the vertical speed (it floats in a fall). Crouching lowers it.
 */
export class BodyInertia {
  readonly out = new MotionOffset();
  private spring = new PoseSpring(10, 0.55);
  /** Smoothed velocity in the view's frame: x right, y up, z forward (m/s). */
  private sv = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private prevEye = 0;
  private wasGrounded = true;
  private primed = false;

  update(f: MotionFrame): void {
    const T = motionTuning.acceleration;
    const L = motionTuning.landing;
    const wn = Math.max(1, f.handling.followFreq * 0.8 * T.springFrequency * f.cls.response);
    this.spring.tune(wn, T.damping, wn * 1.1, T.damping);

    // The player moves on the fixed step: smooth before differentiating, or the impulses
    // arrive in a staircase at the physics rate.
    const k = damp(30, f.dt);
    const sv = this.sv;
    sv.x += (f.latVel - sv.x) * k;
    sv.z += (f.fwdVel - sv.z) * k;
    sv.y += (f.upVel - sv.y) * k;
    // Touchdown: the landing impulse comes from onLand (scaled by the fall), not from here.
    const grounded = f.player.grounded;
    if (grounded && !this.wasGrounded) sv.y = this.prev.y = 0;
    this.wasGrounded = grounded;

    if (this.primed) {
      const g = T.strength * f.cls.mass * wn;
      const tilt = T.tilt * DEG * g;
      const dx = sv.x - this.prev.x;
      const dy = sv.y - this.prev.y;
      const dz = sv.z - this.prev.z;
      const de = f.eyeVel - this.prevEye;
      this.spring.pos.impulse(-T.lateral * dx * g, (-T.vertical * dy - L.crouchInertia * de) * g, T.forward * dz * g);
      this.spring.rot.impulse(-0.5 * dz * tilt - 0.4 * dy * tilt, dx * tilt, 1.2 * dx * tilt);
    }
    this.prev.copy(sv);
    this.prevEye = f.eyeVel;
    this.primed = true;

    const walk = Math.max(0.5, playerConfig.walkSpeed);
    const ads = f.ads;
    this.spring.pos.target.set(-sv.x * 0.001, clamp(-sv.y * 0.0012, -0.012, 0.015), 0);
    this.spring.rot.target.set(T.backwardPitch * DEG * clamp(-sv.z / walk, 0, 1), 0, -(sv.x / walk) * T.strafeRoll * DEG);
    this.spring.update(f.dt);

    const K = f.K;
    const m = f.taste.inertia;
    const lin = (1 - K.linear * ads) * m;
    const air = (1 - K.air * ads) * m;
    const roll = (1 - K.strafeRoll * ads) * m;
    const maxP = T.maxPositionOffset;
    const p = this.spring.pos.value;
    const r = this.spring.rot.value;
    // Crouched the gun rides a little lower (a posture: the crouch blend smooths it, the
    // eye's drop above gives it its inertia).
    this.out.pos.set(softClamp(p.x, maxP) * lin, softClamp(p.y, maxP) * air - 0.012 * f.crouch * (1 - ads), softClamp(p.z, maxP) * lin);
    this.out.rot.set(softClamp(r.x, MAX_TILT) * lin, softClamp(r.y, MAX_TILT) * lin, softClamp(r.z, MAX_TILT) * roll);
  }

  reset(): void {
    this.spring.reset();
    this.sv.set(0, 0, 0);
    this.prev.set(0, 0, 0);
    this.prevEye = 0;
    this.primed = false;
    this.out.clear();
  }
}
