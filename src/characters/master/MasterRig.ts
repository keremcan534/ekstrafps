import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import spec from '../../../scripts/blender/canonical_skeleton.json';
import data from './masterRig.json';

/**
 * MASTER_HUMANOID_RIG: the one humanoid skeleton every character uses (the spec is
 * scripts/blender/canonical_skeleton.json; this file expands its mirror rule and checks a loaded
 * model against it). Factions change the mesh, never these bones, names, axes or rest frames.
 *
 *   Root → Hips → Spine1 → Spine2 → Spine3 → Neck → Head
 *   Spine3 → Clavicle_S → UpperArm_S → Forearm_S → Hand_S → Thumb|Index|Middle|Ring|Pinky 1..3 _S
 *            UpperArm_S → UpperArmTwist_S (leaf),  Forearm_S → ForearmTwist_S (leaf)
 *   Hips → Thigh_S → Calf_S → Foot_S → Toe_S                                 (S = R | L)
 *   sockets (non-deforming): RightHandWeaponSocket / LeftHandWeaponSocket (Hand), Head-, Face-,
 *   Chest-, BackSocket, BeltSocket_S, ThighSocket_S
 *
 * Axes (every bone): +Y toward its child; arm, hand and finger bones +Z toward the palm side
 * (thumb: its pad), spine, neck, head, clavicles and legs +Z forward, feet and toes +Z up;
 * X = Y × Z. The left side is the exact mirror of the right: a local pose (x, y, z, w) on a right
 * bone is (x, −y, −z, w) on its left twin, a local position (x, y, z) is (−x, y, z).
 * glTF: Y up, the character faces +Z, its right is −X, metres, origin on the floor.
 *
 * Binding (once): every canonical bone must exist (missing = error, nothing is guessed); a bone
 * whose rest axes break the convention, a left bone that isn't its right twin's mirror, a twist
 * bone off its parent's axis or a socket off its data is a warning that names the asset problem.
 * Socket transforms are canonical data (masterRig.json `sockets`), written onto the socket bones.
 */
export type Side = 'R' | 'L';
export const SIDES: readonly Side[] = ['R', 'L'];
type Roll = 'forward' | 'palm' | 'thumbpad' | 'up';

export interface MasterBoneSpec {
  name: string;
  parent: string | null;
  deform: boolean;
  socket: boolean;
  twist: boolean;
  roll: Roll;
}

interface SpecBone {
  name: string;
  parent: string | null;
  deform?: boolean;
  socket?: boolean;
  twist?: boolean;
  roll: string;
}

const NAME_MIRROR = new Map<string, string>();
for (const [r, l] of spec.mirror.names) {
  NAME_MIRROR.set(r, l);
  NAME_MIRROR.set(l, r);
}

/** A bone's twin on the other side (itself on the centre line). */
export function mirrorName(name: string): string {
  const named = NAME_MIRROR.get(name);
  if (named) return named;
  if (name.endsWith('_R')) return name.slice(0, -2) + '_L';
  if (name.endsWith('_L')) return name.slice(0, -2) + '_R';
  return name;
}

/** A side's bone: sided('Hand', 'L') = 'Hand_L'. */
export const sided = (base: string, s: Side): string => `${base}_${s}`;

/** The mirror of a local rotation between twin bones (in place or into `out`). */
export function mirrorQuat(q: THREE.Quaternion, out = q): THREE.Quaternion {
  return out.set(q.x, -q.y, -q.z, q.w);
}

/** The full canonical bone list: the spec's right and centre bones, plus the mirrored left ones. */
export const MASTER_BONES: readonly MasterBoneSpec[] = (() => {
  const out: MasterBoneSpec[] = [];
  const add = (b: SpecBone, name: string, parent: string | null) =>
    out.push({ name, parent, deform: b.deform !== false, socket: !!b.socket, twist: !!b.twist, roll: b.roll as Roll });
  for (const b of spec.bones as SpecBone[]) add(b, b.name, b.parent);
  for (const b of spec.bones as SpecBone[]) {
    const m = mirrorName(b.name);
    if (m !== b.name) add(b, m, b.parent ? mirrorName(b.parent) : null);
  }
  return out;
})();

export const DIGITS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type Digit = (typeof DIGITS)[number];
/** Side-agnostic finger keys, base → tip, thumb → pinky ('Thumb1' … 'Pinky3'). */
export const FINGER_KEYS: readonly string[] = DIGITS.flatMap((d) => [1, 2, 3].map((j) => `${d}${j}`));

export interface RestLocal {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface MasterArm {
  side: Side;
  clavicle: THREE.Bone;
  upper: THREE.Bone;
  upperTwist: THREE.Bone;
  fore: THREE.Bone;
  foreTwist: THREE.Bone;
  hand: THREE.Bone;
  /** FINGER_KEYS order. */
  fingers: THREE.Bone[];
  socket: THREE.Bone;
  /** Shoulder → elbow, elbow → wrist (m), from the rest pose. */
  upperLen: number;
  foreLen: number;
}

export interface MasterRigReport {
  errors: string[];
  warnings: string[];
  /** Measurements worth knowing that break no rule (rest elbow bend, wrist deviation, ...). */
  info: string[];
}

export interface MasterRig {
  /** The loaded model (the glTF scene). */
  model: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  bones: Map<string, THREE.Bone>;
  /** Rest local transforms (the file's, sockets as the data sets them). */
  rest: Map<string, RestLocal>;
  arms: Record<Side, MasterArm>;
  report: MasterRigReport;
  bone(name: string): THREE.Bone;
}

/** Load a master rig GLB and bind it. Rejects (with the report's errors) when it can't be used. */
export async function loadMasterRig(url: string): Promise<MasterRig> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return bindMasterRig(gltf.scene);
}

/** Bind the canonical skeleton on a loaded model (once). Throws, naming every error, when unusable. */
export function bindMasterRig(model: THREE.Object3D): MasterRig {
  const report: MasterRigReport = { errors: [], warnings: [], info: [] };
  const bones = new Map<string, THREE.Bone>();
  let mesh: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  const missing = MASTER_BONES.filter((b) => !bones.has(b.name)).map((b) => b.name);
  if (missing.length) report.errors.push(`missing canonical bones: ${missing.join(', ')}`);
  const wrongParent = MASTER_BONES.filter((b) => b.parent && bones.has(b.name) && bones.get(b.name)!.parent?.name !== b.parent).map(
    (b) => `${b.name} (under ${bones.get(b.name)!.parent?.name}, not ${b.parent})`,
  );
  if (wrongParent.length) report.errors.push(`bones under the wrong parent: ${wrongParent.join(', ')}`);
  const skinned = mesh as THREE.SkinnedMesh | null;
  if (!skinned) report.errors.push('no SkinnedMesh on the skeleton');
  else {
    const inSkin = new Set(skinned.skeleton.bones.map((b) => b.name));
    const unskinned = MASTER_BONES.filter((b) => b.deform && !inSkin.has(b.name)).map((b) => b.name);
    if (unskinned.length) report.errors.push(`deforming bones missing from the skin: ${unskinned.join(', ')}`);
  }
  if (report.errors.length) throw new Error(`MASTER_HUMANOID_RIG: ${report.errors.join('; ')}`);

  const rest = new Map<string, RestLocal>();
  for (const b of MASTER_BONES) {
    const bone = bones.get(b.name)!;
    rest.set(b.name, { position: bone.position.clone(), quaternion: bone.quaternion.clone() });
  }
  const bone = (name: string): THREE.Bone => {
    const b = bones.get(name);
    if (!b) throw new Error(`MASTER_HUMANOID_RIG: no bone ${name}`);
    return b;
  };
  const arm = (s: Side): MasterArm => {
    const fore = bone(sided('Forearm', s));
    const hand = bone(sided('Hand', s));
    return {
      side: s,
      clavicle: bone(sided('Clavicle', s)),
      upper: bone(sided('UpperArm', s)),
      upperTwist: bone(sided('UpperArmTwist', s)),
      fore,
      foreTwist: bone(sided('ForearmTwist', s)),
      hand,
      fingers: FINGER_KEYS.map((k) => bone(sided(k, s))),
      socket: bone(s === 'R' ? 'RightHandWeaponSocket' : 'LeftHandWeaponSocket'),
      upperLen: fore.position.length(),
      foreLen: hand.position.length(),
    };
  };
  const rig: MasterRig = { model, mesh: skinned!, bones, rest, arms: { R: arm('R'), L: arm('L') }, report, bone };
  model.updateMatrixWorld(true);
  checkConvention(rig);
  applySockets(rig);
  return rig;
}

/**
 * Write the canonical socket transforms (masterRig.json `sockets`; the left hand's is the
 * right's mirror) onto the socket bones, and make them the rest.
 */
export function applySockets(rig: MasterRig): void {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (const [name, s] of Object.entries(data.sockets)) {
    for (const n of [name, mirrorName(name)]) {
      const b = rig.bones.get(n);
      if (!b) continue;
      p.fromArray(s.position);
      q.fromArray(s.quaternion).normalize();
      if (n !== name) {
        p.x = -p.x;
        mirrorQuat(q);
      }
      if (b.parent?.name !== s.parent && b.parent?.name !== mirrorName(s.parent)) rig.report.warnings.push(`${n}: data says under ${s.parent}, the rig has it under ${b.parent?.name}`);
      const before = b.position.distanceTo(p) * 1000;
      const turn = THREE.MathUtils.radToDeg(b.quaternion.angleTo(q));
      if (before > 1 || turn > 1) rig.report.info.push(`${n}: the file's socket is ${before.toFixed(0)} mm / ${turn.toFixed(0)}° off the canonical data (bake masterRig.json sockets into the skeleton)`);
      b.position.copy(p);
      b.quaternion.copy(q);
      rig.rest.get(n)?.position.copy(p);
      rig.rest.get(n)?.quaternion.copy(q);
    }
  }
  rig.model.updateMatrixWorld(true);
}

/** Bones the +Y check follows: a bone's chain child (the one its tail is). */
const CHAIN_CHILD: Record<string, string> = { Root: 'Hips', Hips: 'Spine1', Spine3: 'Neck', Hand_R: 'Middle1_R', Hand_L: 'Middle1_L' };

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const deg = (a: THREE.Vector3, b: THREE.Vector3) => THREE.MathUtils.radToDeg(a.angleTo(b));

/** Rest-pose checks of the axis convention, the mirror and the twist bones (warnings, info). */
function checkConvention(rig: MasterRig): void {
  const { report, bones } = rig;
  const W = (n: string) => bones.get(n)!.matrixWorld;
  const ax = (n: string, i: number) => new THREE.Vector3().setFromMatrixColumn(W(n), i).normalize();
  const offY: string[] = [];
  const offZ: string[] = [];
  for (const b of MASTER_BONES) {
    if (b.socket) continue;
    // +Y toward the chain child.
    const kids = MASTER_BONES.filter((c) => c.parent === b.name && !c.socket && !c.twist);
    const childName = CHAIN_CHILD[b.name] ?? (kids.length === 1 ? kids[0].name : undefined);
    if (childName) {
      const p = bones.get(childName)!.position;
      const d = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(p.y / Math.max(1e-9, p.length()), -1, 1)));
      if (d > 5) offY.push(`${b.name} (${d.toFixed(0)}° off +Y to ${childName})`);
    }
    // +Z: the convention's reference direction, made square to the bone's +Y.
    const y = ax(b.name, 1);
    const z = ax(b.name, 2);
    const s = b.name.endsWith('_L') ? -1 : 1;
    // Thumb: the convention's own definition in the hand's frame - pad = 0.7 palm - 0.7 radial,
    // radial = the hand's +X on the right, -X on the left (a world-space guess is off by the
    // hand's ~45 deg outward hang in the A-pose).
    const hand = b.name.endsWith('_L') ? 'Hand_L' : 'Hand_R';
    const ref =
      b.roll === 'forward'
        ? FWD.clone()
        : b.roll === 'up'
          ? UP.clone()
          : b.roll === 'palm'
            ? new THREE.Vector3(s, 0, 0)
            : ax(hand, 2).multiplyScalar(0.7).addScaledVector(ax(hand, 0), -0.7 * s);
    ref.addScaledVector(y, -ref.dot(y)).normalize();
    const tol = b.roll === 'thumbpad' ? 10 : b.name.startsWith('Root') ? 5 : 20;
    const d = deg(z, ref);
    if (d > tol) offZ.push(`${b.name} (+Z ${d.toFixed(0)}° from ${b.roll})`);
  }
  if (offY.length) report.warnings.push(`bones whose +Y doesn't point at their child: ${offY.join(', ')}`);
  if (offZ.length) report.warnings.push(`bones whose rest +Z breaks the convention (A-pose: palms to the thighs, thumbs forward): ${offZ.join(', ')}`);

  // The left side is the right side's mirror (world rest frames, x flipped).
  const asym: string[] = [];
  for (const b of MASTER_BONES) {
    if (!b.name.endsWith('_L') && b.name !== 'LeftHandWeaponSocket') continue;
    const r = mirrorName(b.name);
    const pl = new THREE.Vector3().setFromMatrixPosition(W(b.name));
    const pr = new THREE.Vector3().setFromMatrixPosition(W(r));
    pr.x = -pr.x;
    const yr = ax(r, 1);
    yr.x = -yr.x;
    const zr = ax(r, 2);
    zr.x = -zr.x;
    const dp = pl.distanceTo(pr) * 1000;
    const da = Math.max(deg(ax(b.name, 1), yr), deg(ax(b.name, 2), zr));
    if (dp > 1 || da > 1) asym.push(`${b.name} (${dp.toFixed(1)} mm, ${da.toFixed(1)}°)`);
  }
  if (asym.length) report.warnings.push(`left bones that aren't their right twin's mirror: ${asym.join(', ')}`);

  // Twist bones: leaf children on their parent's axis, no rest turn.
  for (const s of SIDES) {
    for (const t of ['UpperArmTwist', 'ForearmTwist']) {
      const b = bones.get(sided(t, s))!;
      const off = Math.hypot(b.position.x, b.position.z) * 1000;
      const turn = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(b.quaternion.w))));
      if (off > 1 || turn > 1 || b.children.some((c) => (c as THREE.Bone).isBone)) report.warnings.push(`${b.name}: not a leaf on its parent's axis (${off.toFixed(1)} mm off, ${turn.toFixed(1)}° turned)`);
    }
    // Measurements: the rest elbow (flexion about Z vs the carrying angle about X) and the wrist.
    const fq = bones.get(sided('Forearm', s))!.quaternion;
    const hq = bones.get(sided('Hand', s))!.quaternion;
    const e = new THREE.Euler().setFromQuaternion(fq, 'ZXY');
    const h = new THREE.Euler().setFromQuaternion(hq, 'ZXY');
    const r2d = THREE.MathUtils.radToDeg;
    report.info.push(
      `${s}: rest elbow ${r2d(2 * Math.acos(Math.min(1, Math.abs(fq.w)))).toFixed(1)}° (about Z ${r2d(e.z).toFixed(1)}°, carrying angle about X ${r2d(e.x).toFixed(1)}°); ` +
        `rest wrist ${r2d(2 * Math.acos(Math.min(1, Math.abs(hq.w)))).toFixed(1)}° (deviation about Z ${r2d(h.z).toFixed(1)}°, flexion about X ${r2d(h.x).toFixed(1)}°)`,
    );
  }
  const a = rig.arms.R;
  report.info.push(`arm: upper ${(a.upperLen * 1000).toFixed(0)} mm, forearm ${(a.foreLen * 1000).toFixed(0)} mm, wrist → middle knuckle ${(bones.get('Middle1_R')!.position.length() * 1000).toFixed(0)} mm`);
}
