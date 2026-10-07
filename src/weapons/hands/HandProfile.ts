import * as THREE from 'three';
import { FINGER_BONES, fingerBoneIndex, sidePrefix, type Side } from './ArmRig';
import { ACTION_POSES, TRIGGER_POSES, gripPose, jointAngles, jointQuaternion, toQ4, type Q4, type ResolvedPose } from './GripPoses';
import { handConfig } from './HandsConfig';
import { FINGER_NAMES, gripQuaternion, rotationOfGrip, type FingerPose, type HandPose, type WeaponHands } from '../HandPose';

type V3 = [number, number, number];

/**
 * How the first-person hands hold a weapon, SCHEMA 2: the weapon says where each wrist belongs
 * and which library poses the fingers take; the arms do the rest.
 *
 *   handTargets      RightHandTarget / LeftHandTarget: each hand's WRIST (the Hand bone's
 *                    origin) and orientation (the canonical hand frame: +Y wrist → knuckles,
 *                    +Z out of the palm), in the weapon model's own space like the profile's
 *                    other points, so they ride on the model whatever its placement. (Not moved
 *                    by `widthAlong`: they are set on the gun as it is drawn.)
 *   gripPoses        library poses (src/config/gripposes.json) for each hand's fingers.
 *   gripCorrections  optional and small: a few finger bones turned a little further after the
 *                    pose (key: the full bone name, RightThumb01; value: a local rotation in the
 *                    poses' side-agnostic convention). Big ones mean the wrong base pose or a
 *                    misplaced target.
 *   triggerPose      the right index finger's SAFE / TRIGGER_READY / TRIGGER_PRESS poses
 *                    (default TriggerSafe / TriggerReady / TriggerPress).
 *   reload           the support hand on moving parts while reloading, as wrist targets that
 *                    ride on them (model space, the part at rest): `magazine` (holding it) and
 *                    `chargingHandle` (racking it), each with its finger pose.
 *
 * Schema 1 (`rightGrip`, every finger of every pose stored per weapon, the palm on the grip)
 * still loads through resolveHands, for the weapons not moved over yet.
 */
export interface PartHandDef {
  position: V3;
  quaternion: Q4;
  pose?: string;
}
export interface WeaponHandsV2 {
  handTargets: { rightPosition: V3; rightQuaternion: Q4; leftPosition: V3; leftQuaternion: Q4 };
  gripPoses: { right: string; left: string };
  gripCorrections?: Record<string, Q4>;
  triggerPose?: { safe: string; ready: string; press: string };
  reload?: { magazine?: PartHandDef; chargingHandle?: PartHandDef };
}
export type AnyWeaponHands = WeaponHands | WeaponHandsV2;
export const isV2 = (h: AnyWeaponHands): h is WeaponHandsV2 => 'handTargets' in h;

export interface ResolvedHand {
  grip: ResolvedPose;
  /** The grip pose's library name ('' for a schema-1 weapon's own pose). */
  gripName: string;
  /** Per finger bone (FINGER_BONES order), applied after the grip pose; identity where none. */
  correction: THREE.Quaternion[];
}

/** A weapon's hands as the runtime uses them (resolved once per layout, never per frame). */
export interface ResolvedHands {
  schema: 1 | 2;
  /** The point a target stands for, in hand space: the wrist (0) for schema 2, the palm for 1. */
  palm: THREE.Vector3;
  right: ResolvedHand;
  left: ResolvedHand;
  /** The trigger finger's states (index bones used). */
  trigger: { safe: ResolvedPose; ready: ResolvedPose; press: ResolvedPose };
  /** The poses an animation names: open hand, on the magazine, on the charging handle / bolt. */
  open: ResolvedPose;
  reload: ResolvedPose;
  interaction: ResolvedPose;
  /** Weapon space: the hand's orientation on the magazine / the charging handle, for an
   * animation that moves a hand point without turning it. */
  turn: { reload: THREE.Quaternion; interaction: THREE.Quaternion };
}

/** Corrections larger than this (deg) get a warning: pick another pose or move the target. */
export const BIG_CORRECTION_DEG = 20;

const IDENTITY_POSE: ResolvedPose = FINGER_BONES.map(() => new THREE.Quaternion());
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();

// --- Spaces -------------------------------------------------------------------------------
// model   the weapon model file's own space (profile points); `toWeapon` (the OrientationRoot's
//         matrix, identity for a procedural gun) takes it to
// weapon  the WeaponInstance (rig.root): metres, -Z along the barrel, +Y up.
// Targets are placed in weapon space (or their moving part's), the arms read them in arm space.

/** The rotation part of a model → weapon matrix (scale left out). */
export function orientationOf(toWeapon: THREE.Matrix4, out: THREE.Quaternion): THREE.Quaternion {
  toWeapon.decompose(_p, out, _s);
  return out;
}
/** A model-space point in weapon space. */
export function modelToWeaponPoint(p: readonly number[], toWeapon: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p[0], p[1], p[2]).applyMatrix4(toWeapon);
}
/** A model-space orientation in weapon space. */
export function modelToWeaponQuat(q: readonly number[], toWeapon: THREE.Matrix4, out: THREE.Quaternion): THREE.Quaternion {
  return orientationOf(toWeapon, out).multiply(_q.set(q[0], q[1], q[2], q[3]).normalize());
}
/** A weapon-space point as stored (model space, 4 decimals). */
export function weaponToModelPoint(p: THREE.Vector3, toWeapon: THREE.Matrix4): V3 {
  const m = _p.copy(p).applyMatrix4(new THREE.Matrix4().copy(toWeapon).invert());
  return [m.x, m.y, m.z].map((v) => +v.toFixed(4) + 0) as V3;
}
/** A weapon-space orientation as stored (model space). */
export function weaponToModelQuat(q: THREE.Quaternion, toWeapon: THREE.Matrix4): Q4 {
  return toQ4(orientationOf(toWeapon, new THREE.Quaternion()).invert().multiply(q));
}

// --- Resolving ----------------------------------------------------------------------------

/** A schema-1 degree pose as rotations (FINGER_BONES order). */
export const poseQuats = (pose: Readonly<HandPose>): THREE.Quaternion[] =>
  FINGER_BONES.map((_, i) => {
    const f = FINGER_NAMES[Math.floor(i / 3)];
    const [curl, spread, twist] = pose[f][i % 3];
    return jointQuaternion(curl, spread, twist, new THREE.Quaternion());
  });

/** A schema-1 trigger pose (the index finger alone) as a pose. */
const indexOnly = (finger: Readonly<FingerPose>): THREE.Quaternion[] =>
  FINGER_BONES.map((_, i) => {
    const j = i - fingerBoneIndex('index', 0);
    return j >= 0 && j < 3 ? jointQuaternion(finger[j][0], finger[j][1], finger[j][2], new THREE.Quaternion()) : new THREE.Quaternion();
  });

const library = (name: string, fallback: string): ResolvedPose => gripPose(name) ?? gripPose(fallback) ?? IDENTITY_POSE;

/**
 * A weapon's hands (either schema) for the runtime. `toWeapon`: model → weapon space (only the
 * rotation is used: schema-2 orientations are stored in model space).
 */
export function resolveHands(def: AnyWeaponHands, toWeapon: THREE.Matrix4, id = ''): ResolvedHands {
  const c = handConfig();
  const correction = () => FINGER_BONES.map(() => new THREE.Quaternion());
  if (!isV2(def)) {
    return {
      schema: 1,
      palm: new THREE.Vector3(...c.legacy.palmGrip),
      right: { grip: poseQuats(def.rightPose), gripName: '', correction: correction() },
      left: { grip: poseQuats(def.leftPose), gripName: '', correction: correction() },
      trigger: { safe: indexOnly(def.trigger.safe), ready: indexOnly(def.trigger.ready), press: indexOnly(def.trigger.pull) },
      open: library(ACTION_POSES.open, ACTION_POSES.open),
      reload: def.reload ? poseQuats(def.reload.pose) : library(ACTION_POSES.reload, ACTION_POSES.open),
      interaction: def.interaction ? poseQuats(def.interaction.pose) : library(ACTION_POSES.interaction, ACTION_POSES.open),
      turn: {
        reload: gripQuaternion(def.reload?.rotation ?? c.legacy.reloadRotation, new THREE.Quaternion()),
        interaction: gripQuaternion(def.interaction?.rotation ?? c.legacy.interactionRotation, new THREE.Quaternion()),
      },
    };
  }
  const right: ResolvedHand = { grip: library(def.gripPoses.right, ACTION_POSES.open), gripName: def.gripPoses.right, correction: correction() };
  const left: ResolvedHand = { grip: library(def.gripPoses.left, ACTION_POSES.open), gripName: def.gripPoses.left, correction: correction() };
  for (const [key, q] of Object.entries(def.gripCorrections ?? {})) {
    const side: Side | null = key.startsWith('Right') ? 'right' : key.startsWith('Left') ? 'left' : null;
    const i = side ? FINGER_BONES.indexOf(key.slice(sidePrefix(side).length)) : -1;
    if (!side || i < 0) {
      console.warn(`[hands] ${id}: gripCorrections key "${key}" is no finger bone (RightThumb01 … LeftPinky03)`);
      continue;
    }
    const r = (side === 'right' ? right : left).correction[i].set(q[0], q[1], q[2], q[3]).normalize();
    const deg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(r.w))));
    if (deg > BIG_CORRECTION_DEG) console.warn(`[hands] ${id}: ${key} corrected by ${deg.toFixed(0)}°: a correction this big means the base pose or the target is wrong`);
  }
  const t = def.triggerPose ?? TRIGGER_POSES;
  const mag = def.reload?.magazine;
  const handle = def.reload?.chargingHandle;
  return {
    schema: 2,
    palm: new THREE.Vector3(),
    right,
    left,
    trigger: { safe: library(t.safe, TRIGGER_POSES.safe), ready: library(t.ready, TRIGGER_POSES.ready), press: library(t.press, TRIGGER_POSES.press) },
    open: library(ACTION_POSES.open, ACTION_POSES.open),
    reload: library(mag?.pose ?? ACTION_POSES.reload, ACTION_POSES.open),
    interaction: library(handle?.pose ?? ACTION_POSES.interaction, ACTION_POSES.open),
    turn: {
      reload: mag ? modelToWeaponQuat(mag.quaternion, toWeapon, new THREE.Quaternion()) : gripQuaternion(c.legacy.reloadRotation, new THREE.Quaternion()),
      interaction: handle ? modelToWeaponQuat(handle.quaternion, toWeapon, new THREE.Quaternion()) : gripQuaternion(c.legacy.interactionRotation, new THREE.Quaternion()),
    },
  };
}

// --- Between the schemas (calibration page: migrating a weapon, autoHands templates) ---------

/**
 * Schema 1 → 2: the same hands' wrists as targets (where the palm offset put them; `placed` is
 * the schema-1 definition as it is drawn, after widthAlong), the fingers on library poses.
 */
export function migrateHands(placed: Readonly<WeaponHands>, toWeapon: THREE.Matrix4, poses: { right: string; left: string }): WeaponHandsV2 {
  const palm = new THREE.Vector3(...handConfig().legacy.palmGrip);
  const target = (g: WeaponHands['rightGrip']) => {
    const q = gripQuaternion(g.rotation, new THREE.Quaternion());
    const wrist = modelToWeaponPoint(g.position, toWeapon, new THREE.Vector3()).sub(palm.clone().applyQuaternion(q));
    return { position: weaponToModelPoint(wrist, toWeapon), quaternion: weaponToModelQuat(q, toWeapon) };
  };
  const r = target(placed.rightGrip);
  const l = target(placed.leftGrip);
  return {
    handTargets: { rightPosition: r.position, rightQuaternion: r.quaternion, leftPosition: l.position, leftQuaternion: l.quaternion },
    gripPoses: { ...poses },
  };
}

/** A pose as schema-1 degrees (corrections folded in when given). */
export const poseDegrees = (pose: ResolvedPose, correction?: readonly THREE.Quaternion[]): HandPose => {
  const out = {} as HandPose;
  for (const f of FINGER_NAMES) {
    out[f] = [0, 1, 2].map((j) => {
      const i = fingerBoneIndex(f, j);
      const q = _q.copy(pose[i]);
      if (correction) q.multiply(correction[i]);
      return jointAngles(q).map((v) => +v.toFixed(2)) as V3;
    }) as FingerPose;
  }
  return out;
};

/** Schema 2 → 1 (the same hands in the old shape: what the autoHands search starts from). */
export function legacyHands(h: Readonly<WeaponHandsV2>, toWeapon: THREE.Matrix4): WeaponHands {
  const r = resolveHands(h, toWeapon);
  const palm = new THREE.Vector3(...handConfig().legacy.palmGrip);
  const grip = (pos: V3, q4: Q4) => {
    const q = modelToWeaponQuat(q4, toWeapon, new THREE.Quaternion());
    const at = modelToWeaponPoint(pos, toWeapon, new THREE.Vector3()).add(palm.clone().applyQuaternion(q));
    return { position: weaponToModelPoint(at, toWeapon), rotation: rotationOfGrip(q) };
  };
  const index = (pose: ResolvedPose): FingerPose => poseDegrees(pose).index;
  return {
    rightGrip: grip(h.handTargets.rightPosition, h.handTargets.rightQuaternion),
    leftGrip: grip(h.handTargets.leftPosition, h.handTargets.leftQuaternion),
    rightPose: poseDegrees(r.right.grip, r.right.correction),
    leftPose: poseDegrees(r.left.grip, r.left.correction),
    trigger: { safe: index(r.trigger.safe), ready: index(r.trigger.ready), pull: index(r.trigger.press) },
  };
}

