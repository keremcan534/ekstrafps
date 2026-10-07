import * as THREE from 'three';
import { damp } from '../../core/math';
import type { Weapon } from '../Weapon';
import type { Handling } from '../Handling';
import type { PoseOffset } from '../WeaponAnimator';
import type { WeaponRig } from '../WeaponModels';
import type { ViewmodelPlayer } from '../Viewmodel';
import { motionClass, motionTuning } from './MotionTuning';
import { MotionOffset, type AdsCut, type MotionFrame, type MotionTaste } from './MotionTypes';
import { CameraInertia } from './CameraInertia';
import { BodyInertia } from './BodyInertia';
import { Locomotion } from './Locomotion';
import { IdleLife } from './IdleLife';
import { Transitions } from './Transitions';
import { Interaction } from './Interaction';
import { RecoilLayer } from './RecoilLayer';

export interface MotionStackInput {
  dt: number;
  time: number;
  player: ViewmodelPlayer;
  weapon: Weapon;
  rig: WeaponRig;
  handling: Handling;
  taste: MotionTaste;
  K: AdsCut;
  ads: number;
  adsEase: number;
  adsRaw: number;
  adsVel: number;
  adsTarget: number;
  lookRate: THREE.Vector2;
  fatigue: number;
  pose: PoseOffset;
}

/**
 * The first-person weapon's procedural motion, one layer per job:
 *
 *   world  pushes from outside the gun: camera inertia, body acceleration (start / stop /
 *          strafe / jump / crouch), walking and sprinting, impacts (landing, mechanical)
 *   sway   idle life: breathing and muscle noise (the one layer that never settles)
 *   own    the gun's own moves: its animation pose (reloads, bolt work), draw / holster,
 *          sprint and ADS transitions, arrival settles, reload hand reactions
 *   recoil the shot, in the gun's frame (placed about the shoulder by the viewmodel)
 *
 * Each layer writes a position and a rotation offset; the viewmodel sums them on top of
 * the base pose (hip / aimed / sprint) and places the weapon once. Every layer but sway
 * returns to exactly nothing, so the aimed pose ends on the calibrated sight line.
 */
export class WeaponMotionStack {
  readonly world = new MotionOffset();
  readonly sway = new MotionOffset();
  readonly own = new MotionOffset();

  readonly cameraInertia = new CameraInertia();
  readonly bodyInertia = new BodyInertia();
  readonly locomotion = new Locomotion();
  readonly idle = new IdleLife();
  readonly transitions = new Transitions();
  readonly interaction = new Interaction();
  readonly recoil = new RecoilLayer();

  private crouch = 0;
  private eyePrev = NaN;
  private eyeVel = 0;
  private f = { lookRate: new THREE.Vector2() } as MotionFrame;

  get sprintBlend(): number {
    return this.transitions.sprintBlend;
  }

  /** Mass / response / bob of the weapon in hand (by class). */
  classOf(weapon: Weapon) {
    return motionTuning.classes[motionClass(weapon.data)];
  }

  update(i: MotionStackInput): void {
    const f = this.f;
    const p = i.player;
    Object.assign(f, i);
    f.cls = this.classOf(i.weapon);
    const cy = Math.cos(p.yaw);
    const sy = Math.sin(p.yaw);
    f.fwdVel = -p.velocity.x * sy - p.velocity.z * cy;
    f.latVel = p.velocity.x * cy - p.velocity.z * sy;
    f.upVel = p.grounded ? 0 : p.velocity.y;
    f.speed = Math.hypot(f.fwdVel, f.latVel);
    f.grounded = p.grounded ? 1 : 0;
    this.crouch += ((p.crouching ? 1 : 0) - this.crouch) * damp(10, i.dt);
    f.crouch = this.crouch;
    const eye = p.eyeHeight;
    if (eye !== undefined) {
      const raw = Number.isFinite(this.eyePrev) ? (eye - this.eyePrev) / Math.max(i.dt, 1 / 240) : 0;
      this.eyeVel += (raw - this.eyeVel) * damp(20, i.dt);
      this.eyePrev = eye;
    }
    f.eyeVel = this.eyeVel;

    // Transitions first: the sprint blend it springs is read by the locomotion.
    this.transitions.update(f);
    f.sprint = this.transitions.sprintBlend;
    this.cameraInertia.update(f);
    this.bodyInertia.update(f);
    this.locomotion.update(f);
    this.idle.update(f);
    this.interaction.update(f);
    this.recoil.update(i.dt, i.ads);

    this.world.clear().add(this.cameraInertia.out).add(this.bodyInertia.out).add(this.locomotion.out).add(this.interaction.out);
    this.sway.clear().add(this.idle.out);
    this.own.clear().add(this.transitions.own);
  }

  /** A new weapon in hand: no recoil or impacts carried over from the last one. */
  onWeapon(): void {
    this.recoil.reset();
    this.interaction.reset();
    this.transitions.onWeapon();
  }
}
