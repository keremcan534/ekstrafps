import * as THREE from 'three';
import type { WeaponHands } from './HandPose';

type V3 = [number, number, number];

/** One of the model file's own axes. */
export type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/**
 * A first-person weapon's view profile: ONE file per weapon,
 * src/config/viewprofiles/<weapon id>.json, the only place its first-person placement
 * lives. Edited in weapon-calibration.html (dev server); the game reads it, freezes it
 * and never writes it. Recoil, sway, walking, reloads and the rest are motion layers on
 * top (Viewmodel.ts): they never change these numbers.
 *
 * Spaces:
 *   model   the packed model file (public/guns/fp/<model.key>.glb) as it is, its own units
 *           and axes. Reference points live here, so they stay on the model's sights
 *           whatever the orientation is set to.
 *   weapon  metres, barrel along -Z, +Y up, origin at the top of the pistol grip.
 *           model → weapon is `model.orientation` (the OrientationRoot).
 *   aim     the camera's aim axis: the eye at the origin, aiming along -Z, +Y up the
 *           screen. Hip and sprint poses place the weapon origin here.
 *
 * Aimed, no pose is stored: the ADSPoint (rear sight → front sight) is solved onto the aim
 * axis, `ads.eyeRelief` in front of the eye, square to it (solveAdsPose). The model's own
 * pivot and the hip and sprint poses cannot move it.
 */
export interface ViewProfile {
  /** Weapon id (src/config/weapons/<id>.json). */
  id: string;
  model: {
    /** public/guns/fp/<key>.glb */
    key: string;
    /**
     * Model → weapon space. `forward` / `up`: the model's own axes along the barrel (toward
     * the muzzle) and up; then a small fine turn (deg [pitch, yaw, roll], yaw → pitch →
     * roll), a uniform scale, and the position (m) of the model's origin.
     */
    orientation: ViewOrientation;
    /** Moving pieces (reloads, bolt work). */
    parts: { mag?: ViewPart; bolt?: ViewPart };
  };
  /** Reference points, model space. */
  points: {
    /** Rear sight: top of the notch (centred) / centre of the peep / the optic's eyepiece. */
    sightRear: V3;
    /** Front sight: the post's tip / the optic's reticle. Rear → front is the sight line. */
    sightFront: V3;
    /** The bore: its muzzle end and a point further back on it (the direction). */
    muzzle: V3;
    boreRear: V3;
    /** Ejection port. */
    eject: V3;
    /** Stock's shoulder contact: hip recoil turns about it. */
    butt: V3;
  };
  ads: {
    /** Eye to rear sight along the sight line (m). */
    eyeRelief: number;
    /** Aimed horizontal FOV (deg, 16:9). */
    fov: number;
    /** A deliberate aimed offset (aim space, m) and cant (deg). Normally zero. */
    offset: V3;
    roll: number;
  };
  /**
   * How aiming works (default TrueADS). TrueADS: the ADSPoint is lined up with the camera
   * (sights that can be lined up). FocusAim: no sight alignment; the FOV narrows and the
   * gun comes in toward the centre, steadier (a model whose sights can't be lined up
   * stays usable). Both shoot along the camera's aim either way.
   */
  aim?: AimSettings;
  hip: ViewPose;
  sprint: ViewPose;
  /** This weapon's taste on the shared motion layers (1 = as its handling gives). */
  motion: { sway: number; inertia: number; bob: number; recoil: number };
  /** How the hands hold it: grips, finger poses, trigger finger (HandPose.ts). No arms without. */
  hands?: WeaponHands;
}

export type AimMode = 'TrueADS' | 'FocusAim';

export interface AimSettings {
  mode: AimMode;
  /** Horizontal FOV at the hip (deg); unset: the player's own FOV setting. */
  hipFOV?: number;
  /** FocusAim: aimed horizontal FOV (deg). (TrueADS uses `ads.fov`.) */
  aimFOV: number;
  /** FocusAim: the aimed pose from the hip pose: position (aim space, m) and turn (deg, added to the hip's). */
  aimWeaponPositionOffset: V3;
  aimWeaponRotationOffset: V3;
  /** FocusAim: what is left of sway, walking bob and visual inertia at full aim (0…1). */
  aimSwayMultiplier: number;
  aimBobMultiplier: number;
  aimInertiaMultiplier: number;
  /** Look sensitivity at full aim (either mode; on top of the FOV's own scaling). */
  aimSensitivityMultiplier: number;
}

/** FocusAim defaults: the gun a few centimetres in and up, upright, half as lively. */
export const FOCUS_DEFAULTS: Readonly<AimSettings> = {
  mode: 'FocusAim',
  aimFOV: 52,
  aimWeaponPositionOffset: [-0.055, 0.045, 0.04],
  aimWeaponRotationOffset: [1.5, 0, -5],
  aimSwayMultiplier: 0.4,
  aimBobMultiplier: 0.35,
  aimInertiaMultiplier: 0.5,
  aimSensitivityMultiplier: 0.9,
};

/** A profile's aim mode. */
export const aimMode = (p: Readonly<ViewProfile>): AimMode => p.aim?.mode ?? 'TrueADS';

/** A model file's own axes along the barrel and up, a small fine turn (deg), scale, position (m). */
export interface ViewOrientation {
  forward: Axis;
  up: Axis;
  rotation: V3;
  scale: number;
  /** Extra scale across the weapon (its X): a model built too slim. Default 1. */
  width?: number;
  /**
   * Scale across the weapon by region, about its centre line (the rear sight's): pairs of
   * [position along `forward` (model units), ×], linear between, held past the ends. A
   * model whose stock or handguard is slimmer than the real one, its receiver right.
   */
  widthAlong?: [number, number][];
  position: V3;
}

/**
 * A moving piece of the model: its bones / nodes by name (each with what hangs under it),
 * and/or the model's own loose pieces lying under the given points (model space: a model
 * without a skeleton, its bolt handle a separate piece). It turns about `pivot` (model
 * space; default its first named bone's head).
 */
export interface ViewPart {
  names?: string[];
  pieces?: V3[];
  /** Model space [min, max]: every triangle whose centre is inside (a part welded to the body). */
  box?: [V3, V3];
  pivot?: V3;
  /** A bolt handle's knob (model space): the firing hand reaches for it to work the bolt. */
  knob?: V3;
}

export interface ViewPose {
  /** Weapon origin in aim space (m), right shoulder. */
  position: V3;
  /** Degrees [pitch, yaw, roll], applied yaw → pitch → roll. */
  rotation: V3;
}

const DEG = Math.PI / 180;

const files = import.meta.glob<ViewProfile>('../config/viewprofiles/*.json', { eager: true, import: 'default' });

function freeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) freeze(v);
    Object.freeze(o);
  }
  return o;
}

const profiles = new Map<string, Readonly<ViewProfile>>();
for (const p of Object.values(files)) profiles.set(p.id, freeze(structuredClone(p)));

/** The weapon's view profile, or null (it still uses the old automatic placement). */
export const viewProfile = (id: string): Readonly<ViewProfile> | null => profiles.get(id) ?? null;

/** Ids of every weapon with a view profile. */
export const profiledIds = (): string[] => [...profiles.keys()];

// The calibration page saves through the dev server: a running game keeps what it loaded.
if (import.meta.hot) import.meta.hot.accept(() => {});

const euler = new THREE.Euler();

const AXIS: Record<Axis, readonly [number, number, number]> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

/** Model → weapon space (the OrientationRoot): axes, fine turn, scale, position. */
export function orientationMatrix(p: Readonly<ViewProfile>, out: THREE.Matrix4): THREE.Matrix4 {
  return orientMatrix(p.model.orientation, out);
}

/** A model file's own axes, fine turn, scale and position → our space (-Z forward, +Y up). */
export function orientMatrix(o: Readonly<ViewOrientation>, out: THREE.Matrix4): THREE.Matrix4 {
  // The weapon's axes in model space: -Z along the barrel, +Y up, +X = Y × Z.
  const z = new THREE.Vector3(...AXIS[o.forward]).negate();
  const y = new THREE.Vector3(...AXIS[o.up]);
  const x = y.clone().cross(z);
  const axes = x.lengthSq() > 0.5 ? new THREE.Matrix4().makeBasis(x, y, z).transpose() : new THREE.Matrix4();
  const fine = poseQuaternion(o.rotation, new THREE.Quaternion());
  return out.compose(new THREE.Vector3(...o.position), fine, new THREE.Vector3(o.scale * (o.width ?? 1), o.scale, o.scale)).multiply(axes);
}

/**
 * Model-space positions / normals (xyz triples) widened by the profile's `widthAlong`: each
 * point moved across the weapon, about its centre line, by the scale where it lies along
 * it; normals kept square to the widened surface. In place; nothing without `widthAlong`.
 */
export function widenModel(p: Readonly<ViewProfile>, positions: Float32Array, normals: Float32Array | null): void {
  const o = p.model.orientation;
  const w = o.widthAlong;
  if (!w?.length) return;
  const f = AXIS[o.forward];
  const u = AXIS[o.up];
  // Across the weapon (either sign: the scale is about the centre line).
  const s = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]];
  const r = p.points.sightRear;
  const centre = r[0] * s[0] + r[1] * s[1] + r[2] * s[2];
  const at = (x: number): number => {
    if (x <= w[0][0]) return w[0][1];
    for (let i = 1; i < w.length; i++) if (x <= w[i][0]) return w[i - 1][1] + ((w[i][1] - w[i - 1][1]) * (x - w[i - 1][0])) / (w[i][0] - w[i - 1][0]);
    return w[w.length - 1][1];
  };
  for (let i = 0; i < positions.length; i += 3) {
    const k = at(positions[i] * f[0] + positions[i + 1] * f[1] + positions[i + 2] * f[2]);
    if (k === 1) continue;
    const across = positions[i] * s[0] + positions[i + 1] * s[1] + positions[i + 2] * s[2] - centre;
    for (let c = 0; c < 3; c++) positions[i + c] += s[c] * across * (k - 1);
    if (!normals) continue;
    // Stretched k times across: the normal's part across shrinks k times.
    const na = normals[i] * s[0] + normals[i + 1] * s[1] + normals[i + 2] * s[2];
    for (let c = 0; c < 3; c++) normals[i + c] += s[c] * na * (1 / k - 1);
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    for (let c = 0; c < 3; c++) normals[i + c] /= len;
  }
}

/** A pose's rotation (deg [pitch, yaw, roll], yaw → pitch → roll). */
export function poseQuaternion(r: readonly number[], out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(euler.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'YXZ'));
}

/**
 * The ADSPoint in weapon space: origin on the rear sight, -Z along the sight line toward the
 * front sight, +Y the weapon's up made square to it.
 */
export function adsFrame(p: Readonly<ViewProfile>, out: THREE.Matrix4): THREE.Matrix4 {
  const O = orientationMatrix(p, new THREE.Matrix4());
  const rear = new THREE.Vector3(...p.points.sightRear).applyMatrix4(O);
  const front = new THREE.Vector3(...p.points.sightFront).applyMatrix4(O);
  const z = rear.clone().sub(front).normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  return out.makeBasis(x, y, z).setPosition(rear);
}

/** Where the ADSPoint must end up when aimed (aim space): on the axis, eyeRelief out, level. */
export function adsTarget(p: Readonly<ViewProfile>, out: THREE.Matrix4): THREE.Matrix4 {
  const a = p.ads;
  return out.compose(
    new THREE.Vector3(a.offset[0], a.offset[1], a.offset[2] - a.eyeRelief),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a.roll * DEG),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * The aimed pose (weapon origin in aim space) that lays the ADSPoint `frame` onto its
 * target: target · frame⁻¹. Solved from the sights every time, never stored.
 */
export function solveAdsPose(p: Readonly<ViewProfile>, frame: THREE.Matrix4, pos: THREE.Vector3, quat: THREE.Quaternion): void {
  adsTarget(p, new THREE.Matrix4())
    .multiply(frame.clone().invert())
    .decompose(pos, quat, new THREE.Vector3());
}
