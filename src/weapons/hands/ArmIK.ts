import * as THREE from 'three';
import type { ArmSettings } from './HandsConfig';

/**
 * Analytic two-bone arm IK: shoulder → elbow → wrist, solved exactly in one pass.
 *
 * Not CCDIKSolver (three/addons/animation/CCDIKSolver.js): it moves an effector to a POSITION
 * only (the wrist's orientation is the point of a hand on a grip), has no pole (the elbow goes
 * wherever the iterations leave it and can flip between frames), iterates (jitter frame to
 * frame) and needs the target to be a bone of the skeleton. Two bones with a known wrist
 * transform have a closed-form answer; the one free choice, the plane the elbow bends in, is
 * made explicitly here.
 *
 *   1. Reach: past `softReach` of the arm's length the elbow stops straightening (a soft curve:
 *      it never snaps straight) and the upper arm takes the rest (it is a sleeve tube with
 *      nothing skinned to it): the hand always lands on its target.
 *   2. The elbow's plane (pole): the preferred direction (`elbow`), turned by `natural` toward
 *      where the forearm would continue the hand (less wrist bend), kept below `elbowUp` by a
 *      continuous clamp onto the allowed arc, then eased (`smooth`) so it cannot flip in a frame.
 *   3. Bones: the hand exactly on the target, position and orientation; the forearm from the
 *      elbow to the wrist, rolled with the hand (the wrist bends, never twists); the upper arm
 *      from the shoulder to the elbow, bending in the pole's plane.
 *
 * Everything is in arm space (the space holding the arms: the aim space, mirrored to the
 * shoulder side). No allocations per solve.
 */
export interface ArmSolveStats {
  /** Angle between forearm and hand (deg), and any twist between them (deg; 0 by design). */
  wristBendDeg: number;
  wristTwistDeg: number;
  /** How much longer than the soft reach the target is (m): the upper arm's sleeve takes it. */
  reachM: number;
  /** How far the elbow's direction turned in this solve (deg). */
  poleTurnDeg: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class TwoBoneArmIK {
  /** The elbow's direction: unit, square to the shoulder → wrist line. */
  readonly pole = new THREE.Vector3();
  /** The preferred direction this solve (unit, square to the line; debug). */
  readonly hint = new THREE.Vector3();
  readonly shoulder = new THREE.Vector3();
  readonly elbow = new THREE.Vector3();
  readonly wrist = new THREE.Vector3();
  /** Bone frames: the upper arm (its origin moved out along it when stretched) and the forearm. */
  readonly upperM = new THREE.Matrix4();
  readonly foreM = new THREE.Matrix4();
  readonly stats: ArmSolveStats = { wristBendDeg: 0, wristTwistDeg: 0, reachM: 0, poleTurnDeg: 0 };
  private hasPole = false;
  private t = {
    v: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    n: new THREE.Vector3(),
    p: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    hx: new THREE.Vector3(),
    hy: new THREE.Vector3(),
    hz: new THREE.Vector3(),
    fx: new THREE.Vector3(),
    fy: new THREE.Vector3(),
    fz: new THREE.Vector3(),
    ux: new THREE.Vector3(),
    uy: new THREE.Vector3(),
    uz: new THREE.Vector3(),
    y: new THREE.Vector3(),
    x: new THREE.Vector3(),
    a: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    sc: new THREE.Vector3(),
  };

  constructor(
    readonly upperLen: number,
    readonly foreLen: number,
  ) {}

  /** Forget the elbow's history (a new weapon, a jump cut): the next solve takes its pole at once. */
  reset(): void {
    this.hasPole = false;
  }

  /**
   * Solve for the hand frame `hand` (arm space; its translation is the wrist) from shoulder `S`.
   * `smooth`: share of the way the elbow's direction goes to its new one this solve (1: at once).
   */
  solve(S: THREE.Vector3, hand: THREE.Matrix4, c: Readonly<ArmSettings>, softReach: number, smooth: number): void {
    const t = this.t;
    const a = this.upperLen;
    const b = this.foreLen;
    const L = a + b;
    const W = this.wrist.setFromMatrixPosition(hand);
    this.shoulder.copy(S);
    let d = t.v.subVectors(W, S).length();
    const dir = t.dir.copy(t.v).multiplyScalar(1 / Math.max(d, 1e-9));

    // 1. Reach: the joints solve for a soft distance that never reaches L; the upper arm takes the rest.
    const Ls = L * softReach;
    let stretch = 0;
    if (d > Ls) {
      const span = L - Ls;
      stretch = d - (Ls + span * (1 - Math.exp(-(d - Ls) / span)));
    }
    this.stats.reachM = stretch;
    d = Math.max(d, Math.abs(a - b) + 1e-3);
    const ua = a + stretch;

    // 2. The elbow's plane.
    const had = this.hasPole;
    t.prev.copy(this.pole);
    const hint = this.hint.set(c.elbow[0], c.elbow[1], c.elbow[2]);
    if (!square(hint, dir)) {
      // The arm points along the preferred direction: last frame's pole, else down, else sideways.
      if (had) hint.copy(this.pole);
      else hint.set(0, -1, 0);
      if (!square(hint, dir)) {
        hint.set(1, 0, 0);
        square(hint, dir);
      }
    }
    // Where the forearm would continue the hand (its natural line out of the wrist).
    const n = t.n.set(c.forearm[0], c.forearm[1], c.forearm[2]).transformDirection(hand).multiplyScalar(b).add(W).sub(S);
    const p = t.p.copy(hint);
    if (square(n, dir)) turnToward(p, n, c.natural, dir);
    clampUp(p, dir, c.elbowUp, had ? t.prev : hint, t.y, t.x);
    if (!had || smooth >= 1) {
      this.pole.copy(p);
      this.hasPole = true;
    } else {
      // Last frame's direction, made square to this frame's line, eased toward the new one.
      const q = this.pole;
      if (!square(q, dir)) q.copy(p);
      turnToward(q, p, smooth, dir);
    }
    this.stats.poleTurnDeg = had ? THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(t.prev.dot(this.pole), -1, 1))) : 0;
    const pole = this.pole;

    // The elbow.
    const cosA = THREE.MathUtils.clamp((ua * ua + d * d - b * b) / (2 * ua * d), -1, 1);
    const E = this.elbow.copy(S).addScaledVector(dir, ua * cosA).addScaledVector(pole, ua * Math.sqrt(1 - cosA * cosA));

    // 3. Bone frames. Hand axes are the columns of its matrix.
    const hx = t.hx.setFromMatrixColumn(hand, 0);
    const hy = t.hy.setFromMatrixColumn(hand, 1);
    const hz = t.hz.setFromMatrixColumn(hand, 2);
    // Forearm: elbow → wrist, rolled with the hand.
    const fy = t.fy.subVectors(W, E).normalize();
    const fz = t.fz.copy(hz).addScaledVector(fy, -hz.dot(fy));
    if (fz.lengthSq() < 0.09) fz.crossVectors(hx, fy);
    fz.normalize();
    const fx = t.fx.crossVectors(fy, fz);
    this.foreM.makeBasis(fx, fy, fz).setPosition(E);
    // Upper arm: shoulder → elbow, bending in the pole's plane.
    const uy = t.uy.subVectors(E, S).normalize();
    const uz = t.uz.copy(pole).addScaledVector(uy, -pole.dot(uy));
    if (uz.lengthSq() < 1e-6) uz.copy(hint).addScaledVector(uy, -hint.dot(uy));
    uz.normalize();
    const ux = t.ux.crossVectors(uy, uz);
    this.upperM.makeBasis(ux, uy, uz).setPosition(t.a.copy(E).addScaledVector(uy, -a));

    this.stats.wristBendDeg = THREE.MathUtils.radToDeg(fy.angleTo(hy));
    const pz = t.a.copy(hz).addScaledVector(fy, -hz.dot(fy));
    this.stats.wristTwistDeg = pz.lengthSq() > 1e-6 ? THREE.MathUtils.radToDeg(pz.angleTo(fz)) : 0;
  }

  /**
   * Write the solve into the bones' local transforms. `upperParentInv`: the inverse of the
   * upper arm's parent frame in arm space (identity for a model hung straight in arm space).
   */
  apply(upper: THREE.Bone, fore: THREE.Bone, handBone: THREE.Bone, hand: THREE.Matrix4, upperParentInv: THREE.Matrix4): void {
    const t = this.t;
    t.m.multiplyMatrices(upperParentInv, this.upperM).decompose(upper.position, upper.quaternion, t.sc);
    t.m.copy(this.upperM).invert().multiply(this.foreM).decompose(fore.position, fore.quaternion, t.sc);
    t.m.copy(this.foreM).invert().multiply(hand).decompose(handBone.position, handBone.quaternion, t.sc);
  }
}

/** `v` made square to the unit `axis` and unit; false when it lies along it (then `v` is ~0: replace it). */
function square(v: THREE.Vector3, axis: THREE.Vector3): boolean {
  v.addScaledVector(axis, -v.dot(axis));
  const l = v.length();
  if (l < 1e-6) return false;
  v.multiplyScalar(1 / l);
  return true;
}

const cr = new THREE.Vector3();

/**
 * Turn the unit `v` (square to `axis`) a share `k` of the way toward the unit `to` (also square),
 * about `axis`: continuous in both. Exactly opposite there is no shorter way: `v` stays.
 */
function turnToward(v: THREE.Vector3, to: THREE.Vector3, k: number, axis: THREE.Vector3): void {
  const ang = Math.atan2(cr.crossVectors(v, to).dot(axis), v.dot(to));
  if (Math.abs(ang) > Math.PI * 0.985 || k <= 0) return;
  const a = ang * Math.min(1, k);
  cr.crossVectors(axis, v);
  v.multiplyScalar(Math.cos(a)).addScaledVector(cr, Math.sin(a)).normalize();
}

/**
 * Keep the unit `p` (square to the unit `dir`) from pointing higher than `up` (its y): the
 * nearest direction on the allowed arc. Continuous; the side is `p`'s own (or `side`'s when `p`
 * points straight up).
 */
function clampUp(p: THREE.Vector3, dir: THREE.Vector3, up: number, side: THREE.Vector3, y: THREE.Vector3, x: THREE.Vector3): void {
  // World up, square to the line: the direction on the circle that rises fastest.
  y.copy(UP).addScaledVector(dir, -dir.y);
  const r = y.length();
  if (r < 1e-4) return; // the line is vertical: every direction is level
  y.multiplyScalar(1 / r);
  const m = up / r;
  if (m >= 1 || p.dot(y) <= m) return;
  if (m <= -1) {
    p.copy(y).negate();
    return;
  }
  x.crossVectors(dir, y);
  const px = p.dot(x);
  const sgn = Math.abs(px) > 1e-6 ? Math.sign(px) : side.dot(x) >= 0 ? 1 : -1;
  p.copy(y).multiplyScalar(m).addScaledVector(x, sgn * Math.sqrt(1 - m * m));
}
