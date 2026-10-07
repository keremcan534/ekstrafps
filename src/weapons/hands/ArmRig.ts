import * as THREE from 'three';

/**
 * The canonical first-person arm skeleton: ONE bone layout that every glove / arm model is
 * skinned to. The visual mesh may change; these names and axes don't.
 *
 *   <S>UpperArm → <S>ForeArm → <S>Hand → <S>Thumb01..03, <S>Index01..03, <S>Middle01..03,
 *                                         <S>Ring01..03, <S>Pinky01..03        (S = Right | Left)
 *
 * There is no clavicle: the shoulder is a pivot point (hands.json `shoulder`), the upper arm a
 * bone the IK turns (the glove mesh ends at the elbow; a sleeve tube is drawn over it).
 *
 * Bone axes (scripts/rig-arms.mjs writes them so): +Y along the bone toward its child, +Z toward
 * the palm side, X = Y × Z. A positive turn about +X curls a finger into the palm on either hand.
 * The left hand is the mirror image of the right, so a finger pose authored for the right hand
 * lands on the left as (x, −y, −z, w) (GripPoses.ts).
 *
 * The bones are looked up once, here, and checked: a missing bone is an error (no arms, with
 * the names that were found), a bone off the axis convention or without skin is a warning that
 * names the asset problem. Nothing is looked up by name per frame.
 */
export type Side = 'right' | 'left';
export const SIDES: readonly Side[] = ['right', 'left'];
export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const FINGER_KEY: Record<FingerName, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };

/** Side-agnostic finger bone keys (the pose library's keys), base → tip, thumb → pinky. */
export const FINGER_BONES = FINGERS.flatMap((f) => [1, 2, 3].map((j) => `${FINGER_KEY[f]}0${j}`)) as readonly string[];
/** Index of a finger's joint `j` (0 base … 2 tip) in FINGER_BONES. */
export const fingerBoneIndex = (f: FingerName, j: number): number => FINGERS.indexOf(f) * 3 + j;
/** The trigger finger's bones (FINGER_BONES indices). */
export const INDEX_BONES: readonly number[] = [0, 1, 2].map((j) => fingerBoneIndex('index', j));

export const sidePrefix = (s: Side): string => (s === 'right' ? 'Right' : 'Left');
/** A canonical bone's full name: boneName('left', 'Index02') = 'LeftIndex02'. */
export const boneName = (s: Side, key: string): string => `${sidePrefix(s)}${key}`;

export interface ArmBones {
  upper: THREE.Bone;
  fore: THREE.Bone;
  hand: THREE.Bone;
  /** FINGER_BONES order. */
  fingers: THREE.Bone[];
  /** Bind-pose local rotations, FINGER_BONES order. */
  fingerRest: THREE.Quaternion[];
  /** Shoulder → elbow, elbow → wrist (m), from the bind pose. */
  upperLen: number;
  foreLen: number;
}

export interface ArmRig {
  bones: Record<Side, ArmBones>;
  mesh: THREE.SkinnedMesh;
}

export interface ArmRigReport {
  errors: string[];
  warnings: string[];
}

/** Finger bones with fewer vertices than this mostly theirs have no real skin. */
const MIN_SKIN = 40;

/**
 * Bind the canonical skeleton on a loaded arms model (once). Null, with `report.errors`
 * saying why, when the model can't be used: missing bones, or no skinned mesh on them.
 */
export function bindArmRig(model: THREE.Object3D, report: ArmRigReport = { errors: [], warnings: [] }): ArmRig | null {
  const byName = new Map<string, THREE.Bone>();
  let mesh: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  const required = SIDES.flatMap((s) => ['UpperArm', 'ForeArm', 'Hand', ...FINGER_BONES].map((k) => boneName(s, k)));
  const missing = required.filter((n) => !byName.has(n));
  if (missing.length) {
    report.errors.push(`missing canonical bones: ${missing.join(', ')} (the model has: ${[...byName.keys()].join(', ') || 'no bones'})`);
    return null;
  }
  const skinned = mesh as THREE.SkinnedMesh | null;
  if (!skinned) {
    report.errors.push('no SkinnedMesh: the glove is a static mesh. Code cannot bend an unskinned mesh; skin it to the canonical skeleton (scripts/rig-arms.mjs or Blender)');
    return null;
  }
  const inSkeleton = new Set(skinned.skeleton.bones.map((b) => b.name));
  const unskinned = required.filter((n) => !inSkeleton.has(n));
  if (unskinned.length) {
    report.errors.push(`the glove's skin doesn't use ${unskinned.join(', ')}: re-skin it to the canonical skeleton`);
    return null;
  }

  model.updateMatrixWorld(true);
  const get = (n: string) => byName.get(n)!;
  const bones = {} as Record<Side, ArmBones>;
  for (const s of SIDES) {
    const fingers = FINGER_BONES.map((k) => get(boneName(s, k)));
    const fore = get(boneName(s, 'ForeArm'));
    const hand = get(boneName(s, 'Hand'));
    bones[s] = {
      upper: get(boneName(s, 'UpperArm')),
      fore,
      hand,
      fingers,
      fingerRest: fingers.map((b) => b.quaternion.clone()),
      upperLen: fore.position.length(),
      foreLen: hand.position.length(),
    };
    checkAxes(s, bones[s], report);
  }
  checkSkin(skinned, report);
  return { bones, mesh: skinned };
}

const az = new THREE.Vector3();
const handZ = new THREE.Vector3();

/** The axis convention: each child along its parent's +Y; each finger's +Z on the palm side. */
function checkAxes(s: Side, b: ArmBones, report: ArmRigReport): void {
  const offAxis: string[] = [];
  for (const bone of [b.fore, b.hand, ...b.fingers.filter((_, i) => i % 3 !== 0)]) {
    const p = bone.position;
    const deg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(p.y / Math.max(1e-9, p.length()), -1, 1)));
    if (deg > 10) offAxis.push(`${bone.name} (${deg.toFixed(0)}°)`);
  }
  if (offAxis.length) report.warnings.push(`${sidePrefix(s)}: bones not along their parent's +Y: ${offAxis.join(', ')} — poses will turn about the wrong axes; re-export with +Y along the bone`);
  handZ.setFromMatrixColumn(b.hand.matrixWorld, 2).normalize();
  const flipped: string[] = [];
  for (let i = 0; i < b.fingers.length; i++) {
    if (i < 3) continue; // the thumb's pad faces across the palm, not along its normal
    az.setFromMatrixColumn(b.fingers[i].matrixWorld, 2).normalize();
    if (az.dot(handZ) < 0.3) flipped.push(b.fingers[i].name);
  }
  if (flipped.length) report.warnings.push(`${sidePrefix(s)}: finger bones whose +Z doesn't face the palm: ${flipped.join(', ')} — a curl would bend them sideways or backwards`);
}

/** Skin weights: every finger bone should move a real part of the glove. */
function checkSkin(mesh: THREE.SkinnedMesh, report: ArmRigReport): void {
  const bones = mesh.skeleton.bones;
  const si = mesh.geometry.getAttribute('skinIndex');
  const sw = mesh.geometry.getAttribute('skinWeight');
  if (!si || !sw) {
    report.errors.push('the glove has no skin weights (asset problem)');
    return;
  }
  const own = new Uint32Array(bones.length);
  for (let i = 0; i < si.count; i++) {
    let best = 0;
    let bj = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > best) [best, bj] = [w, si.getComponent(i, k)];
    }
    own[bj]++;
  }
  const thin = bones.filter((b, j) => /(Thumb|Index|Middle|Ring|Pinky)0\d$/.test(b.name) && own[j] < MIN_SKIN).map((b) => `${b.name} (${own[bones.indexOf(b)]})`);
  if (thin.length) report.warnings.push(`asset problem: finger bones with almost no skin (vertices mostly theirs): ${thin.join(', ')} — those joints won't bend the glove; repaint the weights`);
}
