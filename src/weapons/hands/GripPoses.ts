import * as THREE from 'three';
import file from '../../config/gripposes.json';
import { FINGER_BONES } from './ArmRig';

/**
 * The grip pose library (src/config/gripposes.json): reusable finger poses shared by every
 * weapon. A weapon names the poses it uses (RifleRightGrip, RifleLeftGrip, ...) and may add a
 * few tiny per-bone corrections; it never stores a whole hand of its own.
 *
 * A pose stores, for the finger bones it cares about (side-agnostic keys Thumb01 … Pinky03),
 * the bone's LOCAL rotation away from the glove's bind pose, as a quaternion [x, y, z, w] in the
 * bone's own canonical frame (ArmRig.ts): bone.quaternion = bind ⊗ q. A bone the pose leaves out
 * stays at its bind rotation. Poses are written for the right hand; the left hand wears the
 * mirror image (x, −y, −z, w), so the same numbers curl the same way on both hands.
 *
 * The calibration page shows a joint as [curl, spread, twist] degrees (Euler ZXY: curl about X
 * closes the finger, spread about Z turns it toward the little finger, twist about Y turns it
 * about itself); everything is stored and blended as quaternions.
 */
export type Q4 = [number, number, number, number];

export interface GripPoseData {
  /** What it is for (the editor shows it). */
  note?: string;
  bones: Record<string, Q4>;
}
export interface GripPoseFile {
  poses: Record<string, GripPoseData>;
}

/** The trigger finger's three states (index bones only), and the hand poses the animation names. */
export const TRIGGER_POSES = { safe: 'TriggerSafe', ready: 'TriggerReady', press: 'TriggerPress' } as const;
export const ACTION_POSES = { open: 'OpenHand', reload: 'MagazineHold', interaction: 'ChargingHandle' } as const;

/** A pose for the runtime: one rotation per finger bone (FINGER_BONES order), identity = bind. */
export type ResolvedPose = readonly THREE.Quaternion[];

/** The library as loaded; the calibration page edits it in place (poseChanged) and saves it. */
const library = structuredClone(file) as unknown as GripPoseFile;
const cache = new Map<string, THREE.Quaternion[]>();
const warned = new Set<string>();

const identityPose = (): THREE.Quaternion[] => FINGER_BONES.map(() => new THREE.Quaternion());

/** Pose data → rotations (into `out`, which keeps its identity: rigs holding it see the change). */
export function resolvePoseData(data: Readonly<GripPoseData>, out: THREE.Quaternion[] = identityPose()): THREE.Quaternion[] {
  for (let i = 0; i < FINGER_BONES.length; i++) {
    const q = data.bones[FINGER_BONES[i]];
    if (q) out[i].set(q[0], q[1], q[2], q[3]).normalize();
    else out[i].identity();
  }
  return out;
}

/** A library pose by name (shared: never mutate it), or null with one warning naming what exists. */
export function gripPose(name: string): ResolvedPose | null {
  const hit = cache.get(name);
  if (hit) return hit;
  const data = library.poses[name];
  if (!data) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[hands] no grip pose "${name}" in src/config/gripposes.json (it has: ${Object.keys(library.poses).join(', ')})`);
    }
    return null;
  }
  const unknown = Object.keys(data.bones).filter((k) => !FINGER_BONES.includes(k));
  if (unknown.length) console.warn(`[hands] grip pose "${name}": unknown bones ${unknown.join(', ')} (keys are ${FINGER_BONES.join(', ')})`);
  const pose = resolvePoseData(data);
  cache.set(name, pose);
  return pose;
}

/** Every pose name in the library. */
export const gripPoseNames = (): string[] => Object.keys(library.poses);

/** The live library (calibration page: edit, then poseChanged and save). */
export const poseLibrary = (): GripPoseFile => library;

/** A library pose was edited: every rig using it sees the new rotations at once. */
export function poseChanged(name: string): void {
  const data = library.poses[name];
  const pose = cache.get(name);
  if (data && pose) resolvePoseData(data, pose);
}

const D = THREE.MathUtils.DEG2RAD;
const eu = new THREE.Euler(0, 0, 0, 'ZXY');

/** A joint's [curl, spread, twist] (deg) as a rotation (editor controls → runtime). */
export function jointQuaternion(curl: number, spread: number, twist: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(eu.set(curl * D, twist * D, spread * D, 'ZXY'));
}

/**
 * A joint's rotation as [curl, spread, twist] (deg) (runtime → editor controls). Euler ZXY keeps
 * its middle angle (the curl) within ±90°; a joint curled further (a trigger finger's middle
 * joint) comes back on the other branch (180 − curl, spread and twist ± 180): the one with the
 * smaller spread and twist is the joint as authored.
 */
export function jointAngles(q: THREE.Quaternion): [number, number, number] {
  eu.setFromQuaternion(q, 'ZXY');
  let curl = eu.x / D;
  let spread = eu.z / D;
  let twist = eu.y / D;
  if (Math.abs(spread) > 90 && Math.abs(twist) > 90) {
    curl = (curl >= 0 ? 180 : -180) - curl;
    spread -= Math.sign(spread) * 180;
    twist -= Math.sign(twist) * 180;
  }
  return [curl, spread, twist];
}

/** The left hand's rotation for a right-hand one (the mirror across the bone's YZ plane). */
export function mirrorLeft(q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.set(q.x, -q.y, -q.z, q.w);
}

/** A rotation as stored (5 decimals). */
export function toQ4(q: THREE.Quaternion): Q4 {
  const r = (v: number) => +v.toFixed(5) + 0;
  return [r(q.x), r(q.y), r(q.z), r(q.w)];
}

/** The library as a file: two-space JSON, each quaternion on one line. */
export function formatPoseLibrary(): string {
  return JSON.stringify(library, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`) + '\n';
}

// A running game keeps the library it loaded (the calibration page saves through the dev server).
if (import.meta.hot) import.meta.hot.accept(() => {});
