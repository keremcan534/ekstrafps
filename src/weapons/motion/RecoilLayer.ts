import * as THREE from 'three';
import { Spring3, tuneSpring } from '../../core/Spring';
import { Noise1D } from '../../core/Noise';
import { DEG, clamp, randSign } from '../../core/math';
import { feel } from '../../config/Feel';
import type { WeaponData } from '../WeaponData';
import type { AmmoData } from '../AmmoData';
import type { Handling } from '../Handling';
import { motionTuning } from './MotionTuning';

/** Effective vertical / horizontal kick of a shot (deg), for the camera transfer. */
export interface RecoilKick {
  vertical: number;
  horizontal: number;
}

/** How much of the aimed recoil goes rearward instead of flipping the muzzle (0..1). */
export const rearwardShare = (ads: number): number => feel.adsRecoilRearward * ads * ads;

/**
 * The weapon's own recoil, in its frame: a rotation (climb, sideways, roll about the
 * shoulder) and a position (mostly straight back into it), each an impulse into a spring,
 * so tap fire, bursts and full auto feel different without shot tables.
 *
 * On top: the arms. A slower spring takes part of every shot and gives it back late (a
 * two-stage recovery, hands then shoulder), and sustained fire heats up: the sideways
 * scatter and roll grow and a slow coherent wander builds, so a long burst gets less
 * steady instead of repeating the same kick. Visual only: the camera transfer (what moves
 * the aim) gets exactly the kick it always did.
 */
export class RecoilLayer {
  /** Rotation (rad: x climb, y sideways, z roll) and position (m) this frame, clamped. */
  readonly rr = new THREE.Vector3();
  readonly rp = new THREE.Vector3();
  private rot = new Spring3(170, 16);
  private pos = new Spring3(270, 22);
  private arms = new Spring3(81, 15);
  private heat = 0;
  private shots = 0;
  private nWander = new Noise1D(131);

  kick(data: WeaponData, ammo: AmmoData, crouching: boolean, h: Handling, ads: number, side: number, response: number): RecoilKick {
    const r = data.recoil;
    const R = motionTuning.recoil;
    const scale = feel.recoilScale * ammo.recoilModifier * h.recoilMass * (crouching ? 0.9 : 1) * (1 - 0.1 * ads);
    const k = r.shoulder;
    this.rot.stiffness = k;
    this.rot.damping = 2 * r.damping * Math.sqrt(k);
    this.pos.stiffness = k * 1.6;
    this.pos.damping = 2 * 0.7 * Math.sqrt(k * 1.6);
    const w = Math.sqrt(k) * 1.9 * DEG;
    const vertical = r.vertical * scale * (0.9 + Math.random() * 0.2);
    const horizontal = (r.horizontalBias + (Math.random() * 2 - 1) * r.horizontal) * scale;
    // Sustained fire: more scatter and a slow wander (the weapon only; the view gets `horizontal`).
    const inst = R.instability * (1 - Math.exp(-this.heat / 3));
    const loose = (Math.random() * 2 - 1) * r.horizontal * 2 * inst + this.nWander.sample(this.shots * 0.37) * r.horizontal * 2 * inst;
    const hz = horizontal + loose * scale;
    // Aimed recoil "rework": when shouldered and aimed, the gun drives straight back
    // into the shoulder instead of flipping the sights out of view; the climb is
    // carried by the view instead (RecoilSystem), so the dot stays on the target.
    const rw = rearwardShare(ads);
    this.rot.impulse(vertical * w * (1 - 0.85 * rw), -hz * w * side * (1 - 0.6 * rw), randSign() * r.roll * scale * w * (1 - 0.5 * rw) * (1 + inst));
    const wp = Math.sqrt(k * 1.6) * 1.9;
    this.pos.impulse((Math.random() * 2 - 1) * r.back * 0.1 * wp, r.back * (0.15 - 0.1 * rw) * wp, r.back * scale * wp * (1 + 0.9 * rw));
    // The arms: part of the climb and the wander, returned slowly.
    const wa = 9 * response;
    tuneSpring(this.arms, wa, 0.85);
    const a = R.drift * R.handResponse * wa * DEG;
    this.arms.impulse(vertical * a * (1 - 0.85 * rw), -hz * a * side * (1 - 0.6 * rw), 0);
    this.heat += 1;
    this.shots++;
    return { vertical, horizontal };
  }

  update(dt: number, ads: number): void {
    this.heat *= Math.exp(-motionTuning.recoil.heatDecay * dt);
    this.rp.copy(this.pos.update(dt));
    const rr = this.rr.copy(this.rot.update(dt)).add(this.arms.update(dt));
    rr.x = clamp(rr.x, -6 * DEG, (14 - 10 * rearwardShare(ads)) * DEG);
    rr.y = clamp(rr.y, -6 * DEG, 6 * DEG);
  }

  reset(): void {
    this.rot.reset();
    this.pos.reset();
    this.arms.reset();
    this.heat = 0;
  }
}
