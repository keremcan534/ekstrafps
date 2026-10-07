import * as THREE from 'three';
import gunHands from '../config/gunhands.json';
import { gripQuaternion, type WeaponHands } from './HandPose';
import type { WeaponRig } from './WeaponModels';

/**
 * A weapon's hands as nodes on its rig: RightHandGrip / LeftHandGrip (where each hand holds
 * it, HandPose.ts), with the hands' definition. A profiled weapon takes them from its view
 * profile (positions in its model file's space), a weapon on the old placement from
 * src/config/gunhands.json (positions in the rig's own space, metres), keyed by its model
 * (else its builder). The animated hand points (rig.leftHand / rig.rightHand) rest on the grips.
 */
export interface RigHands {
  def: WeaponHands;
  right: THREE.Object3D;
  left: THREE.Object3D;
  /** Definition space → rig space. */
  toRig: THREE.Matrix4;
}

const procedural = gunHands as unknown as Record<string, WeaponHands>;

/** A weapon's hands on the old placement (by model or builder key), if set. */
export function proceduralHands(builder: string): WeaponHands | undefined {
  return procedural[builder];
}

/** Put `def`'s grips on `rig` (or re-place them after an edit). `toRig`: definition space → rig space. */
export function attachHands(rig: WeaponRig, def: WeaponHands, toRig = new THREE.Matrix4()): void {
  if (!rig.hands) {
    const right = new THREE.Object3D();
    right.name = 'RightHandGrip';
    const left = new THREE.Object3D();
    left.name = 'LeftHandGrip';
    // A grip rides on what its hand point hangs from (a shotgun's pump): it moves with it.
    (rig.rightHand.parent ?? rig.root).add(right);
    (rig.leftHand.parent ?? rig.root).add(left);
    rig.hands = { def, right, left, toRig: new THREE.Matrix4() };
  }
  rig.hands.def = def;
  rig.hands.toRig.copy(toRig);
  layoutHands(rig);
}

/** Place the grips from the definition, and rest the animated hand points on them. */
export function layoutHands(rig: WeaponRig): void {
  const h = rig.hands;
  if (!h) return;
  rig.root.updateMatrixWorld(true);
  const toParent = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (const [node, g] of [
    [h.right, h.def.rightGrip],
    [h.left, h.def.leftGrip],
  ] as const) {
    // Defined in the weapon's space; a grip on a moving part sits in that part's space.
    node.position.set(g.position[0], g.position[1], g.position[2]).applyMatrix4(h.toRig);
    gripQuaternion(g.rotation, node.quaternion);
    if (node.parent && node.parent !== rig.root) {
      toParent.copy(node.parent.matrixWorld).invert().multiply(rig.root.matrixWorld);
      node.position.applyMatrix4(toParent);
      node.quaternion.premultiply(q.setFromRotationMatrix(toParent));
    }
  }
  // The hand points may hang under a moving part: their rest is in their parent's space.
  rig.root.updateMatrixWorld(true);
  const rest = (hand: THREE.Object3D, grip: THREE.Object3D, out: THREE.Vector3) => {
    (hand.parent ?? rig.root).worldToLocal(grip.getWorldPosition(out));
    hand.position.copy(out);
  };
  rest(rig.rightHand, h.right, rig.rightHandRest);
  rest(rig.leftHand, h.left, rig.leftHandRest);
}
