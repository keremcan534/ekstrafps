import * as THREE from 'three';
import { smoothstep } from '../../core/math';
import { FINGER_BONES, INDEX_BONES, type ArmBones, type Side } from './ArmRig';
import { jointQuaternion, mirrorLeft, type ResolvedPose } from './GripPoses';
import { handConfig } from './HandsConfig';
import type { ResolvedHands } from './HandProfile';
import type { HandAction } from '../HandPose';

/** The trigger finger's state (readout). */
export type TriggerState = 'SAFE' | 'TRIGGER_READY' | 'TRIGGER_PRESS';

/**
 * One hand's fingers: authored library poses, blended as quaternions, never snapped.
 *
 * Each frame the hand's target per finger bone is
 *   holding the grip:  the weapon's grip pose, then its small correction; on the right hand the
 *                      index finger instead goes SAFE → TRIGGER_READY by `trigger` (it never
 *                      curls with the other fingers): knuckle first, lifting off the receiver,
 *                      the other joints after it (hands.json `trigger`), then the correction;
 *   otherwise:         the pose the animation names (open hand, on the magazine, on the
 *                      charging handle): the grip lets go while the animation has the hand;
 * and every bone slerps toward its target by the frame's easing share. A shot's press
 * (TRIGGER_PRESS) goes on top uneased: a trigger is quick.
 *
 * Rotations are kept in the right-hand convention and mirrored onto the left hand as they are
 * written: bone.quaternion = bind ⊗ q (left: bind ⊗ mirror(q)). Only the 15 finger bones are
 * touched; no allocations per frame.
 */
export class FingerPoser {
  /** The fingers as they are now (eased), FINGER_BONES order. */
  private cur = FINGER_BONES.map(() => new THREE.Quaternion());
  private tgt = new THREE.Quaternion();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private lift = new THREE.Quaternion();
  private readonly isIndex: readonly boolean[] = FINGER_BONES.map((_, i) => INDEX_BONES.includes(i));
  trigger: TriggerState = 'SAFE';

  constructor(
    readonly side: Side,
    private bones: ArmBones,
  ) {}

  /** Straight onto `pose` (calibration: no easing), bones written. */
  snap(pose: ResolvedPose): void {
    for (let i = 0; i < this.cur.length; i++) this.cur[i].copy(pose[i]);
    for (let i = 0; i < this.cur.length; i++) this.write(i, this.cur[i]);
  }

  /**
   * `k`: easing share this frame (0…1; 1 lands at once). `trigger`: 0 SAFE … 1 TRIGGER_READY
   * (eased by the caller); `press`: 0…1 the shot's press on top. Right hand only for both.
   */
  update(k: number, action: HandAction, hands: ResolvedHands, trigger: number, press: number): void {
    const H = this.side === 'right' ? hands.right : hands.left;
    const holding = action === 'grip';
    const base: ResolvedPose = holding ? H.grip : action === 'open' ? hands.open : action === 'reload' ? hands.reload : hands.interaction;
    const triggerHand = this.side === 'right' && holding;
    const T = hands.trigger;
    // The trigger finger's way between SAFE and READY: knuckle first, lifted off the receiver.
    const c = handConfig().trigger;
    const lead = smoothstep(Math.min(1, trigger / Math.max(1e-3, c.lead)));
    const follow = smoothstep(Math.max(0, (trigger - c.follow) / Math.max(1e-3, 1 - c.follow)));
    jointQuaternion(-c.lift * 4 * trigger * (1 - trigger), 0, 0, this.lift);
    for (let i = 0; i < this.cur.length; i++) {
      const t = this.tgt;
      if (triggerHand && this.isIndex[i]) {
        const knuckle = i === INDEX_BONES[0];
        t.slerpQuaternions(T.safe[i], T.ready[i], knuckle ? lead : follow);
        if (knuckle) t.multiply(this.lift);
      } else t.copy(base[i]);
      if (holding) t.multiply(H.correction[i]);
      this.cur[i].slerp(t, k);
      let q = this.cur[i];
      if (triggerHand && this.isIndex[i] && press > 0) q = this.q2.slerpQuaternions(q, this.q.copy(T.press[i]).multiply(H.correction[i]), press * trigger);
      this.write(i, q);
    }
    this.trigger = !triggerHand ? 'SAFE' : press * trigger > 0.5 ? 'TRIGGER_PRESS' : trigger > 0.5 ? 'TRIGGER_READY' : 'SAFE';
  }

  private write(i: number, q: THREE.Quaternion): void {
    const b = this.bones.fingers[i];
    b.quaternion.copy(this.bones.fingerRest[i]);
    if (this.side === 'left') b.quaternion.multiply(mirrorLeft(q, this.q));
    else b.quaternion.multiply(q);
  }
}
