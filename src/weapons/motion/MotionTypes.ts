import * as THREE from 'three';
import type { Weapon } from '../Weapon';
import type { Handling } from '../Handling';
import type { PoseOffset } from '../WeaponAnimator';
import type { WeaponRig } from '../WeaponModels';
import type { ViewmodelPlayer } from '../Viewmodel';
import type { ClassTuning } from './MotionTuning';

/**
 * One motion layer's contribution: a position offset (m) and a small rotation offset
 * (rad: x pitch, y yaw, z roll), both in aim space. Layers write these; the viewmodel sums
 * them and places the weapon once.
 */
export class MotionOffset {
  readonly pos = new THREE.Vector3();
  readonly rot = new THREE.Vector3();

  clear(): this {
    this.pos.set(0, 0, 0);
    this.rot.set(0, 0, 0);
    return this;
  }

  add(o: MotionOffset, posScale = 1, rotScale = 1): this {
    this.pos.addScaledVector(o.pos, posScale);
    this.rot.addScaledVector(o.rot, rotScale);
    return this;
  }
}

/** Limit smoothly toward ±max (no hard stop the eye could catch). */
export const softClamp = (v: number, max: number): number => (max > 0 ? max * Math.tanh(v / max) : 0);

/**
 * Share of each motion layer taken away at full ADS (0 keeps all of it, 1 none).
 * LEGACY is the old behaviour, kept for weapons without a view profile.
 * PROFILED: aimed, the gun turns about the eye (rear and front sight stay lined up, the
 * whole picture moves a little) and hardly shifts sideways (a shift splits rear from
 * front sight), so the sight stays usable on every weapon. Global on purpose: a weapon's
 * own taste is its profile's motion multipliers, not a different aimed behaviour.
 */
export interface AdsCut {
  inertia: number;
  inertiaRoll: number;
  inertiaShift: number;
  strafeRoll: number;
  linear: number;
  sway: number;
  bobTurn: number;
  bobShift: number;
  landing: number;
  jolt: number;
  recoilShift: number;
  recoilRoll: number;
  /** The weapon's own animation pose (bolt work, reloads): its turn and its shift. */
  poseTurn: number;
  poseShift: number;
  air: number;
}
export const LEGACY_CUT: AdsCut = { inertia: 0.35, inertiaRoll: 0, inertiaShift: 0, strafeRoll: 0.8, linear: 0, sway: 0.55, bobTurn: 0.8, bobShift: 0.8, landing: 0, jolt: 0, recoilShift: 0, recoilRoll: 0, poseTurn: 0, poseShift: 0, air: 0 };
export const PROFILED_CUT: AdsCut = { inertia: 0.85, inertiaRoll: 0.9, inertiaShift: 0.95, strafeRoll: 0.95, linear: 0.97, sway: 0.6, bobTurn: 0.85, bobShift: 0.95, landing: 0.7, jolt: 0.6, recoilShift: 0.8, recoilRoll: 0.7, poseTurn: 0.95, poseShift: 0.95, air: 0.9 };

/** A profile's taste on the shared layers (1 = as its handling gives). */
export interface MotionTaste {
  sway: number;
  inertia: number;
  bob: number;
  recoil: number;
}
export const NEUTRAL_TASTE: MotionTaste = { sway: 1, inertia: 1, bob: 1, recoil: 1 };

/** Everything a layer may read this frame. Filled once by the stack. */
export interface MotionFrame {
  dt: number;
  time: number;
  player: ViewmodelPlayer;
  weapon: Weapon;
  rig: WeaponRig;
  handling: Handling;
  cls: ClassTuning;
  taste: MotionTaste;
  K: AdsCut;
  /** ADS 0..1 (clamped), its eased blend, the ADS spring's velocity (1/s) and the wish. */
  ads: number;
  adsEase: number;
  adsRaw: number;
  adsVel: number;
  adsTarget: number;
  /** Smoothed look rate (rad/s): x pitch, y yaw. */
  lookRate: THREE.Vector2;
  /** 0 fresh .. 1 exhausted arms. */
  fatigue: number;
  /** The weapon's own animation pose (reloads, bolt / pump work) from WeaponAnimator. */
  pose: PoseOffset;

  // Player motion in the view's frame (m/s): +forward, +right, +up (0 on the ground).
  fwdVel: number;
  latVel: number;
  upVel: number;
  speed: number;
  /** Eye height change rate (m/s): crouching / standing up. */
  eyeVel: number;
  /** Smoothed 0..1: on the ground, sprint pose, crouched. */
  grounded: number;
  sprint: number;
  crouch: number;
}
