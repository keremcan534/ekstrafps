import * as THREE from 'three';
import { gripPose, type ResolvedPose } from '../../weapons/hands/GripPoses';
import { FINGER_KEYS, type MasterArm } from './MasterRig';
import data from './masterRig.json';

/**
 * A master humanoid's fingers in a grip pose from the shared library (src/config/gripposes.json,
 * the first-person hands' poses: one library for both views).
 *
 * The library stores each finger bone's turn away from the first-person glove's bind pose, in the
 * canonical finger frame (+Y along the bone, +Z the palm side) that the master's fingers share.
 * The glove's bind finger rotations are kept as data (masterRig.json `fingerBasis`), so a pose
 * lands on the master as an absolute local rotation: basis ⊗ pose (left hand: basis.left ⊗
 * mirror(pose)), the first-person FingerPoser's rule on the glove's own basis. Where the
 * master's hand needs it (its palm and thumb are not the glove's), masterRig.json
 * `gripCorrections.<pose>` turns a few bones a little further: basis ⊗ pose ⊗ correction,
 * canonical (every character on the skeleton), never per character. No allocations per frame.
 */
type Q4 = readonly number[];
const BASIS: Record<'R' | 'L', THREE.Quaternion[]> = {
  R: FINGER_KEYS.map((k) => new THREE.Quaternion().fromArray((data.fingerBasis.right as Record<string, Q4>)[k] as number[]).normalize()),
  L: FINGER_KEYS.map((k) => new THREE.Quaternion().fromArray((data.fingerBasis.left as Record<string, Q4>)[k] as number[]).normalize()),
};
const IDENTITY: ResolvedPose = FINGER_KEYS.map(() => new THREE.Quaternion());
/** The index finger's bones (FINGER_KEYS indices): the trigger finger. */
export const INDEX_KEYS: readonly number[] = [3, 4, 5];

/** A library pose by name (identity, with the library's own warning, when it has none). */
export const libraryPose = (name: string): ResolvedPose => gripPose(name) ?? IDENTITY;

const corrections = new Map<string, THREE.Quaternion[]>();
/** The master's corrections for library pose `name` (FINGER_KEYS order, identity where none; live: edits show at once). */
export function masterCorrection(name: string): ResolvedPose {
  let out = corrections.get(name);
  if (!out) corrections.set(name, (out = FINGER_KEYS.map(() => new THREE.Quaternion())));
  const set = (data.gripCorrections as Record<string, Record<string, number[]>>)[name];
  for (let i = 0; i < FINGER_KEYS.length; i++) {
    const q = set?.[FINGER_KEYS[i]];
    if (q) out[i].fromArray(q).normalize();
    else out[i].identity();
  }
  return out;
}

export class MasterFingers {
  private q = new THREE.Quaternion();

  constructor(readonly arm: MasterArm) {}

  /**
   * Every finger in `pose` (FINGER_KEYS order, right-hand convention); the bones listed in `only`
   * (FINGER_KEYS indices) take `override` instead (the trigger finger).
   */
  apply(pose: ResolvedPose, override?: ResolvedPose, only: readonly number[] = INDEX_KEYS, correction?: ResolvedPose): void {
    const basis = BASIS[this.arm.side];
    for (let i = 0; i < FINGER_KEYS.length; i++) {
      const p = override && only.includes(i) ? override[i] : pose[i];
      const b = this.arm.fingers[i];
      this.q.copy(p);
      if (correction) this.q.multiply(correction[i]);
      if (this.arm.side === 'L') this.q.set(this.q.x, -this.q.y, -this.q.z, this.q.w);
      b.quaternion.copy(basis[i]).multiply(this.q);
    }
  }
}
