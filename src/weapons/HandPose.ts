import * as THREE from 'three';
import { poseQuaternion } from './ViewProfile';

type V3 = [number, number, number];

/**
 * How the first-person hands hold a weapon: the data. A weapon's view profile carries its
 * `hands` (WeaponHands); the arms (FirstPersonHands.ts) put the glove's skeleton on it.
 *
 *   rightGrip / leftGrip   RightHandGrip / LeftHandGrip: where each hand holds the weapon.
 *                          `position` (model space, like the profile's other points) is the
 *                          centre of what the hand closes on (the pistol grip, the handguard):
 *                          the glove's `palmGrip` point lands on it. `rotation` (deg, weapon
 *                          space, YXZ like the hip pose) turns the hand from flat on top of the
 *                          weapon (fingers toward the muzzle, palm down).
 *   rightPose / leftPose   the fingers on those grips.
 *   trigger                the right index finger: `safe` (along the receiver, off the
 *                          trigger), `ready` (on it), `pull` (pressed: while firing).
 *   reload                 the left hand on the magazine during a reload (rotation, fingers).
 *   interaction            the right hand on the bolt / charging handle.
 *
 * A finger pose is three joints, base → tip, each [curl, spread, twist] in degrees from the
 * glove's open hand: curl closes the finger into the palm, spread turns it toward the little
 * finger (negative: toward the thumb), twist turns it about itself. The same numbers mean the
 * same movement on either hand.
 */
export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export const FINGER_NAMES: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export type FingerPose = [V3, V3, V3];
export type HandPose = Record<FingerName, FingerPose>;
export interface HandGripDef {
  position: V3;
  rotation: V3;
}
export interface WeaponHands {
  rightGrip: HandGripDef;
  leftGrip: HandGripDef;
  rightPose: HandPose;
  leftPose: HandPose;
  trigger: { safe: FingerPose; ready: FingerPose; pull: FingerPose };
  reload?: { rotation: V3; pose: HandPose };
  interaction?: { rotation: V3; pose: HandPose };
}
/** What a hand is doing (WeaponAnimator → the arms): its fingers blend between these. */
export type HandAction = 'grip' | 'open' | 'reload' | 'interaction';

/**
 * Hand axes (X = Y × Z, Y wrist → knuckles, Z out of the palm) → weapon axes, at rotation
 * [0, 0, 0]: knuckles toward the muzzle (−Z), palm down (−Y).
 */
const BASE = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)));

/** A grip's rotation (deg) as the hand's orientation in weapon space. */
export function gripQuaternion(rotation: readonly number[], out: THREE.Quaternion): THREE.Quaternion {
  return poseQuaternion(rotation, out).multiply(BASE);
}

/** The rotation (deg) that points the knuckles along `forward` and the palm along `palm` (weapon space). */
export function gripRotation(forward: THREE.Vector3, palm: THREE.Vector3): V3 {
  const y = forward.clone().normalize();
  const z = palm.clone().addScaledVector(y, -palm.dot(y)).normalize();
  const x = y.clone().cross(z);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).multiply(BASE.clone().invert());
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return [e.x, e.y, e.z].map((v) => +THREE.MathUtils.radToDeg(v).toFixed(2)) as V3;
}

/** A fresh pose: every joint at `curl`. */
export function flatPose(curl = 0): HandPose {
  const f = (): FingerPose => [[curl, 0, 0], [curl, 0, 0], [curl, 0, 0]];
  return { thumb: f(), index: f(), middle: f(), ring: f(), pinky: f() };
}

export function copyPose(from: Readonly<HandPose>, to: HandPose): HandPose {
  for (const n of FINGER_NAMES) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) to[n][j][k] = from[n][j][k];
  return to;
}

/** to += (target − to) · k, every angle. */
export function approachPose(to: HandPose, target: Readonly<HandPose>, k: number): void {
  for (const n of FINGER_NAMES) for (let j = 0; j < 3; j++) for (let a = 0; a < 3; a++) to[n][j][a] += (target[n][j][a] - to[n][j][a]) * k;
}

export function lerpFinger(a: Readonly<FingerPose>, b: Readonly<FingerPose>, t: number, out: FingerPose): FingerPose {
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[j][k] = a[j][k] + (b[j][k] - a[j][k]) * t;
  return out;
}
