import * as THREE from 'three';
import { SIDES, type MasterRig, type Side } from './MasterRig';
import data from './masterRig.json';

/**
 * The arms' twist bones, set every frame after the animation and the IK (masterRig.json `twist`):
 *
 *   ForearmTwist (leaf child of Forearm, on its axis) turns about its +Y by α × the hand's roll
 *   about the forearm: the hand's local rotation away from its rest, swing-twist decomposed about
 *   +Y. The forearm bone itself stays in the elbow's hinge frame; the skin between elbow and wrist
 *   (weighted Forearm → ForearmTwist → Hand) spreads the roll instead of wrapping at the wrist.
 *   UpperArmTwist (leaf child of UpperArm) turns about its +Y by −β × the upper arm's own roll
 *   (its local rotation away from rest, decomposed the same way): the shoulder's skin gives back
 *   part of the turn the IK put into the upper arm.
 *
 * The same α and β for every character: no per-character values. No allocations per frame.
 */
export interface TwistStats {
  /** The hand's roll about the forearm, away from rest (deg). */
  handTwistDeg: number;
  /** ForearmTwist's turn about its axis (deg). */
  foreTwistDeg: number;
  /** The upper arm's roll about itself, away from rest (deg). */
  upperTwistDeg: number;
  /** UpperArmTwist's turn about its axis (deg). */
  upperArmTwistDeg: number;
}

/** A rotation's twist about its local +Y (rad, −π … π]: the swing-twist decomposition's twist angle. */
export function twistAboutY(q: THREE.Quaternion): number {
  return wrapPi(2 * Math.atan2(q.y, q.w));
}

/** An angle wrapped into (−π, π]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a <= 0) a += 2 * Math.PI;
  return a - Math.PI;
}

const Y = new THREE.Vector3(0, 1, 0);

export class TwistSolver {
  readonly stats: Record<Side, TwistStats> = {
    R: { handTwistDeg: 0, foreTwistDeg: 0, upperTwistDeg: 0, upperArmTwistDeg: 0 },
    L: { handTwistDeg: 0, foreTwistDeg: 0, upperTwistDeg: 0, upperArmTwistDeg: 0 },
  };
  private d = new THREE.Quaternion();
  private t = new THREE.Quaternion();

  constructor(
    private rig: MasterRig,
    readonly alpha = data.twist.forearm,
    readonly beta = data.twist.upperArm,
  ) {}

  /** Set both arms' twist bones from the hands' and upper arms' current local rotations. */
  update(): void {
    const r2d = THREE.MathUtils.radToDeg;
    for (const s of SIDES) {
      const a = this.rig.arms[s];
      const st = this.stats[s];
      const hand = this.twistOf(a.hand);
      this.rig.arms[s].foreTwist.quaternion.copy(this.restQ(a.foreTwist)).multiply(this.t.setFromAxisAngle(Y, this.alpha * hand));
      const upper = this.twistOf(a.upper);
      a.upperTwist.quaternion.copy(this.restQ(a.upperTwist)).multiply(this.t.setFromAxisAngle(Y, -this.beta * upper));
      st.handTwistDeg = r2d(hand);
      st.foreTwistDeg = r2d(this.alpha * hand);
      st.upperTwistDeg = r2d(upper);
      st.upperArmTwistDeg = r2d(-this.beta * upper);
    }
  }

  /** A bone's twist about its own +Y, away from its rest (rad). */
  private twistOf(b: THREE.Bone): number {
    return twistAboutY(this.d.copy(this.restQ(b)).invert().multiply(b.quaternion));
  }

  private restQ(b: THREE.Bone): THREE.Quaternion {
    return this.rig.rest.get(b.name)!.quaternion;
  }
}
