import * as THREE from 'three';
import { PoseSpring, Spring, tuneSpring } from '../../core/Spring';
import { Noise1D } from '../../core/Noise';
import { DEG, clamp, damp, smoothstep } from '../../core/math';
import type { WeaponState } from '../Weapon';
import { motionTuning } from './MotionTuning';
import { MotionOffset, type MotionFrame } from './MotionTypes';

/**
 * 0 → 1, starting and ending at rest, fastest early (12x(1-x)² speed: the arm swings it up,
 * then brings it in); `over` lets it swing a little past first (a hand stopping a mass).
 */
function arrive(p: number, over: number): number {
  const x = clamp(p / 0.82, 0, 1);
  const u = clamp((p - 0.45) / 0.55, 0, 1);
  return 1 - (1 - x) ** 3 * (1 + 3 * x) + 2 * over * Math.sin(Math.PI * u) ** 2 * (1 - u);
}

/**
 * The gun's own moves between states, all offsets that end at exactly nothing:
 *
 *   sprint     the sprint pose blend is a spring (it swings into the carry and back with a
 *              little overshoot) and its speed throws the gun a little behind it
 *   ADS        the path dips and cants on the way, the muzzle trails, the hands start it
 *              with a small pull and the stock lands in the shoulder (an impulse along the
 *              sight line, which leaves the sight picture whole)
 *   draw       out of the carry, low and turned; position first, rotation catching up with
 *   holster    a small overshoot; then the grab settles it. Down and away, rotation leading.
 *   reload     the support hand's pulls and pushes reach the gun, the arms keep it moving
 *              a little, and it settles into the ready position at the end
 *
 * The weapon's animation pose (WeaponAnimator) stays primary; this only adds to it.
 */
export class Transitions {
  readonly own = new MotionOffset();
  /** Sprint pose share 0..1 (the base pose blend). */
  sprintBlend = 0;
  private sprint = new Spring(81, 13);
  private settle = new PoseSpring(18, 0.55, 20, 0.5);
  private reaction = new PoseSpring(16, 0.6);
  private prevState: WeaponState = 'holstered';
  private prevAdsTarget = 0;
  private prevAds = 0;
  private hands = [new THREE.Vector3(), new THREE.Vector3()];
  private handVel = [new THREE.Vector3(), new THREE.Vector3()];
  private handsPrimed = false;
  private dv = new THREE.Vector3();
  private dd = new THREE.Vector3();
  private v = new THREE.Vector3();
  private reloadWeight = 0;
  private nX = new Noise1D(141);
  private nY = new Noise1D(149);
  private nZ = new Noise1D(157);
  private nP = new Noise1D(163);

  update(f: MotionFrame): void {
    const dt = f.dt;
    const mass = f.cls.mass;
    const { K, ads, weapon } = f;
    const o = this.own.clear();

    // --- Sprint pose: a spring with momentum, not a fade ---
    const S = motionTuning.sprint;
    tuneSpring(this.sprint, Math.max(1, S.enterSpeed * f.cls.response), clamp(S.enterDamping, 0.1, 2));
    this.sprint.target = f.player.sprinting && weapon.state !== 'reloading' ? 1 : 0;
    this.sprint.update(dt);
    this.sprintBlend = clamp(this.sprint.value, 0, 1);
    const sv = this.sprint.velocity * S.momentum * mass * (1 - ads);
    o.rot.x += 0.006 * sv;
    o.rot.z -= 0.008 * sv;
    o.pos.y -= 0.002 * sv;

    // --- ADS: the path between hip and the eye ---
    const A = motionTuning.ads;
    const arc = Math.sin(Math.PI * f.adsEase);
    // The trail fades out over the last stretch: once on the eye, the sight picture holds
    // while the ADS spring settles its last fraction.
    const av = Math.abs(f.adsVel) * (1 - f.adsEase ** 6);
    o.pos.y -= A.arcDip * arc;
    o.pos.z -= A.push * av;
    o.rot.x -= A.leadPitch * DEG * av;
    o.rot.z += A.arcRoll * DEG * arc;
    const hand = A.handImpulse * mass;
    if (f.adsTarget > this.prevAdsTarget) this.settle.kick(0, -0.0015 * hand, 0.001 * hand, -0.25 * DEG * hand, 0, 0.3 * DEG * hand);
    else if (f.adsTarget < this.prevAdsTarget) this.settle.kick(0, -0.002 * hand, 0, -0.35 * DEG * hand, 0, -0.3 * DEG * hand);
    if (this.prevAds < 0.985 && f.adsRaw >= 0.985 && f.adsVel > 0) {
      const s = A.settleImpulse * mass * Math.min(1.5, f.adsVel / 3);
      // Along the sight line only: the picture grows and settles, it does not move.
      this.settle.kick(0, 0, 0.0015 * s, 0, 0, 0);
    }
    this.prevAdsTarget = f.adsTarget;
    this.prevAds = f.adsRaw;

    // --- Draw / holster: a carried object, not a fade ---
    const W = motionTuning.switching;
    const p = weapon.stateProgress;
    let ePos = 0;
    let eRot = 0;
    if (weapon.state === 'holstering') {
      ePos = p * p;
      eRot = smoothstep(p * 1.3);
    } else if (weapon.state === 'holstered') {
      ePos = eRot = 1;
    } else if (weapon.state === 'equipping') {
      const over = W.overshoot * mass;
      ePos = 1 - arrive(p, over);
      eRot = 1 - arrive(Math.max(0, (p - 0.06) / 0.94), over * 1.4);
    }
    o.pos.x += 0.04 * W.sweep * ePos;
    o.pos.y -= W.drop * ePos;
    o.pos.z += 0.04 * ePos;
    o.rot.x -= 0.9 * eRot;
    o.rot.y += 0.15 * W.sweep * eRot;
    o.rot.z += 0.35 * W.sweep * eRot;

    // --- Arrivals: the hands take the weight ---
    const state = weapon.state;
    if (state !== this.prevState && state === 'ready') {
      const w = W.settleImpulse * mass * (this.prevState === 'equipping' ? 1 : this.prevState === 'reloading' ? 0.6 : 0);
      if (w > 0) this.settle.kick(0, -0.0012 * w, 0, -0.3 * DEG * w, 0, 0.15 * DEG * w);
    }
    this.prevState = state;

    // --- Reload: the hands push and pull the gun, the arms keep it alive ---
    const R = motionTuning.reload;
    this.handReaction(f, R.handReaction);
    this.reloadWeight += ((state === 'reloading' ? 1 : 0) - this.reloadWeight) * damp(4, dt);
    const rw = this.reloadWeight * R.microMotion;
    const t = f.time;

    this.settle.update(dt);
    this.reaction.update(dt);
    const poseTurn = 1 - K.poseTurn * ads;
    const poseShift = 1 - K.poseShift * ads;
    const settleTurn = 1 - K.jolt * ads;
    const settleShift = 1 - K.inertiaShift * ads;
    const sp = this.settle.pos.value;
    const sr = this.settle.rot.value;
    const rp = this.reaction.pos.value;
    const rr = this.reaction.rot.value;
    const pose = f.pose;
    o.pos.x += sp.x * settleShift + (pose.pos.x + rp.x + rw * 0.0015 * this.nP.sample(t * 0.5)) * poseShift;
    o.pos.y += sp.y * settleShift + (pose.pos.y + rp.y + rw * 0.0015 * this.nP.sample(t * 0.43 + 9)) * poseShift;
    o.pos.z += sp.z + (pose.pos.z + rp.z) * poseShift;
    o.rot.x += sr.x * settleTurn + (pose.rot.x + rr.x + rw * 0.35 * DEG * this.nX.sample(t * 0.6)) * poseTurn;
    o.rot.y += sr.y * settleTurn + (pose.rot.y + rr.y + rw * 0.3 * DEG * this.nY.sample(t * 0.5 + 3)) * poseTurn;
    o.rot.z += sr.z * settleTurn + (pose.rot.z + rr.z + rw * 0.5 * DEG * this.nZ.sample(t * 0.4 + 6)) * poseTurn;
  }

  /** The hands' acceleration (rig space) reaches the gun they hold or brace against. */
  private handReaction(f: MotionFrame, gain: number): void {
    const rig = f.rig;
    const pts = [rig.leftHand.position, rig.rightHand.position];
    const rests = [rig.leftHandRest, rig.rightHandRest];
    const invDt = 1 / Math.max(f.dt, 1 / 240);
    for (let i = 0; i < 2; i++) {
      const off = this.v.copy(pts[i]).sub(rests[i]);
      if (this.handsPrimed) {
        const vel = this.dv.copy(off).sub(this.hands[i]).multiplyScalar(invDt);
        const d = this.dd.copy(vel).sub(this.handVel[i]);
        this.handVel[i].copy(vel);
        const len = d.length();
        if (len > 2) d.multiplyScalar(2 / len);
        const g = gain * (i === 0 ? 1 : 0.6) / Math.sqrt(f.cls.mass);
        if (g > 0 && len > 1e-5) this.reaction.kick(d.x * 0.004 * g, d.y * 0.004 * g, d.z * 0.003 * g, d.y * 0.5 * DEG * g, -d.x * 0.3 * DEG * g, d.x * 0.6 * DEG * g);
      }
      this.hands[i].copy(off);
    }
    this.handsPrimed = true;
  }

  /** A new weapon in hand: its hands start where they are. */
  onWeapon(): void {
    this.handsPrimed = false;
    this.handVel[0].set(0, 0, 0);
    this.handVel[1].set(0, 0, 0);
    this.reaction.reset();
  }

  /** An impulse into the gun's own settle spring (reload stages, interactions). */
  nudge(px: number, py: number, pz: number, rx: number, ry: number, rz: number): void {
    this.settle.kick(px, py, pz, rx, ry, rz);
  }
}
