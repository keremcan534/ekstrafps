import * as THREE from 'three';
import gunHands from '../config/gunhands.json';
import { gripQuaternion, type WeaponHands } from './HandPose';
import { isV2, modelToWeaponPoint, modelToWeaponQuat, resolveHands, type AnyWeaponHands, type PartHandDef, type ResolvedHands } from './hands/HandProfile';
import type { WeaponRig } from './WeaponModels';

/**
 * A weapon's hands as nodes on its rig: the weapon defines where the hands belong, and the
 * hands follow it.
 *
 *   RightHandTarget / LeftHandTarget   Object3Ds under the WeaponInstance (or under the moving
 *       part the hand point hangs from: a shotgun's pump), so every motion of the weapon (sway,
 *       walk, inertia, recoil, aim, sprint, draw) carries them; the arms read them after all of
 *       it. Schema 2: each is the WRIST's place and turn. Schema 1: the palm's (palmGrip).
 *   LeftHandMagazineTarget / LeftHandChargingHandleTarget   (schema 2, when the profile has
 *       them) the support hand's wrist on the magazine and on the charging handle, children of
 *       those parts: a reload's hand rides on them, turning with them.
 *
 * A profiled weapon's hands come from its view profile (model space, `toRig` = its
 * OrientationRoot), a weapon on the old placement from src/config/gunhands.json (rig space),
 * keyed by its model (else its builder). The animated hand points (rig.leftHand / rightHand)
 * rest on the targets, position and turn.
 */
export interface RigHands {
  def: AnyWeaponHands;
  /** The definition resolved for the runtime (poses, corrections), redone at every layout. */
  resolved: ResolvedHands;
  right: THREE.Object3D;
  left: THREE.Object3D;
  magazine: THREE.Object3D | null;
  chargingHandle: THREE.Object3D | null;
  /** The hand points' rest turn (their parent's space): the targets'. */
  restQ: { right: THREE.Quaternion; left: THREE.Quaternion };
  /**
   * Written by the animator every frame: whether the hand point carries the hand's turn as well
   * as its place (schema 2 at rest and riding on a part). If not, the arms turn the hand by
   * what it is doing (on the magazine, on the bolt), eased.
   */
  oriented: { right: boolean; left: boolean };
  /** Definition space → rig space. */
  toRig: THREE.Matrix4;
}

const procedural = gunHands as unknown as Record<string, AnyWeaponHands>;

/** A weapon's hands on the old placement (by model or builder key), if set. */
export function proceduralHands(builder: string): AnyWeaponHands | undefined {
  return procedural[builder];
}

/** Put `def`'s targets on `rig` (or re-place them after an edit). `toRig`: definition space → rig space. */
export function attachHands(rig: WeaponRig, def: AnyWeaponHands, toRig = new THREE.Matrix4()): void {
  if (!rig.hands) {
    const right = new THREE.Object3D();
    right.name = 'RightHandTarget';
    const left = new THREE.Object3D();
    left.name = 'LeftHandTarget';
    // A target rides on what its hand point hangs from (a shotgun's pump): it moves with it.
    (rig.rightHand.parent ?? rig.root).add(right);
    (rig.leftHand.parent ?? rig.root).add(left);
    rig.hands = {
      def,
      resolved: resolveHands(def, toRig, rig.root.name),
      right,
      left,
      magazine: null,
      chargingHandle: null,
      restQ: { right: new THREE.Quaternion(), left: new THREE.Quaternion() },
      oriented: { right: false, left: false },
      toRig: new THREE.Matrix4(),
    };
  }
  rig.hands.def = def;
  rig.hands.toRig.copy(toRig);
  layoutHands(rig);
}

const P = new THREE.Vector3();
const Q = new THREE.Quaternion();
const M = new THREE.Matrix4();
const M2 = new THREE.Matrix4();
const S = new THREE.Vector3();

/** `node` at a weapon-space place and turn, expressed in its parent's space. */
function place(rig: WeaponRig, node: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion): void {
  node.position.copy(pos);
  node.quaternion.copy(quat);
  const parent = node.parent;
  if (parent && parent !== rig.root) {
    // parent ← weapon: parent.matrixWorld⁻¹ · root.matrixWorld
    M.copy(parent.matrixWorld).invert().multiply(rig.root.matrixWorld).decompose(P, Q, S);
    node.position.applyMatrix4(M);
    node.quaternion.premultiply(Q);
  }
}

/** A schema-2 target on a moving part (made, moved under the part, or removed). */
function partTarget(rig: WeaponRig, part: THREE.Object3D | null, name: string, def: PartHandDef | undefined, node: THREE.Object3D | null): THREE.Object3D | null {
  if (!def || !part) {
    node?.removeFromParent();
    return null;
  }
  const n = node ?? new THREE.Object3D();
  n.name = name;
  if (n.parent !== part) part.add(n);
  // The part is at rest while the rig is laid out: its local frame from the weapon one.
  const h = rig.hands!;
  M2.compose(modelToWeaponPoint(def.position, h.toRig, P), modelToWeaponQuat(def.quaternion, h.toRig, Q), S.set(1, 1, 1));
  M.copy(part.matrixWorld).invert().multiply(rig.root.matrixWorld).multiply(M2).decompose(n.position, n.quaternion, S);
  return n;
}

/** Place the targets from the definition, and rest the animated hand points on them. */
export function layoutHands(rig: WeaponRig): void {
  const h = rig.hands;
  if (!h) return;
  h.resolved = resolveHands(h.def, h.toRig, rig.root.name);
  rig.root.updateMatrixWorld(true);
  const def = h.def;
  if (isV2(def)) {
    const t = def.handTargets;
    place(rig, h.right, modelToWeaponPoint(t.rightPosition, h.toRig, new THREE.Vector3()), modelToWeaponQuat(t.rightQuaternion, h.toRig, new THREE.Quaternion()));
    place(rig, h.left, modelToWeaponPoint(t.leftPosition, h.toRig, new THREE.Vector3()), modelToWeaponQuat(t.leftQuaternion, h.toRig, new THREE.Quaternion()));
    h.magazine = partTarget(rig, rig.mag, 'LeftHandMagazineTarget', def.reload?.magazine, h.magazine);
    h.chargingHandle = partTarget(rig, rig.bolt, 'LeftHandChargingHandleTarget', def.reload?.chargingHandle, h.chargingHandle);
  } else {
    const v1 = def as WeaponHands;
    for (const [node, g] of [
      [h.right, v1.rightGrip],
      [h.left, v1.leftGrip],
    ] as const) {
      place(rig, node, new THREE.Vector3(g.position[0], g.position[1], g.position[2]).applyMatrix4(h.toRig), gripQuaternion(g.rotation, new THREE.Quaternion()));
    }
    h.magazine = partTarget(rig, null, '', undefined, h.magazine);
    h.chargingHandle = partTarget(rig, null, '', undefined, h.chargingHandle);
  }
  // The hand points may hang under a moving part: their rest is in their parent's space.
  rig.root.updateMatrixWorld(true);
  const oriented = isV2(def);
  const rest = (hand: THREE.Object3D, target: THREE.Object3D, out: THREE.Vector3, outQ: THREE.Quaternion) => {
    (hand.parent ?? rig.root).worldToLocal(target.getWorldPosition(out));
    hand.position.copy(out);
    // Schema 2: the point carries the hand's turn too (same parent as its target, made so
    // above). Schema 1 points keep their own turn (an old rig may hang a held shell on one).
    if (oriented) hand.quaternion.copy(target.parent === hand.parent ? target.quaternion : Q.identity());
    outQ.copy(hand.quaternion);
  };
  rest(rig.rightHand, h.right, rig.rightHandRest, h.restQ.right);
  rest(rig.leftHand, h.left, rig.leftHandRest, h.restQ.left);
}
