import * as THREE from 'three';
import type { MasterArm } from './MasterRig';
import { twistAboutY } from './TwistSolver';
import data from './masterRig.json';

/**
 * Analytic two-bone IK for a master humanoid's arm (UpperArm → Forearm → Hand), the third-person
 * sibling of the first-person TwoBoneArmIK (src/weapons/hands/ArmIK.ts), changed where a body
 * differs from floating gloves:
 *
 *   - The shoulder is the skeleton's: UpperArm's head under the animated clavicle, read (with its
 *     parent's world frame) every solve. Out of reach the arm CLAMPS: it straightens toward the
 *     target and the hand stops short (no soft-reach stretch that would pull the shoulder off the
 *     body). Too close, the elbow stops folding at `maxFlexDeg`.
 *   - The elbow's plane comes from a pole POINT (a stance's, in chest space): the elbow bends
 *     toward it. Stateless: the same inputs give the same arm whatever came before, and nothing
 *     here depends on the character's world yaw.
 *   - Upper arm and forearm take the hinge plane's frame: +Y along the bone, +Z the hinge axis
 *     (the canonical elbow flexes about −Z on the right arm, +Z on the left), so the forearm
 *     never rolls (no candy-wrap). The hand lands exactly on the target's frame; its roll about
 *     the forearm stays in the Hand bone, and TwistSolver hands part of it to ForearmTwist.
 *
 * Only rotations are written (bone lengths are the skeleton's: an arm can't stretch). No
 * allocations per solve.
 */
export interface ArmIKStats {
  /** |shoulder → target| / (upper + forearm). */
  reach: number;
  /** How far short of its target the wrist stays (m): 0 when reached. */
  shortM: number;
  /** Elbow flexion (deg, 0 = straight). */
  flexDeg: number;
  /** The hand's +Y against the forearm's (deg). */
  wristBendDeg: number;
  /** The hand's roll about the forearm, away from rest (deg). */
  handTwistDeg: number;
  /** How far the clavicle turned toward a far target (deg). */
  clavicleDeg: number;
}

export class ThirdPersonArmIK {
  readonly shoulder = new THREE.Vector3();
  readonly elbow = new THREE.Vector3();
  readonly wrist = new THREE.Vector3();
  /** The elbow's direction this solve (unit, square to the shoulder → wrist line). */
  readonly pole = new THREE.Vector3();
  readonly stats: ArmIKStats = { reach: 0, shortM: 0, flexDeg: 0, wristBendDeg: 0, handTwistDeg: 0, clavicleDeg: 0 };
  /** +1 right arm, −1 left: the hinge axis' sign (Z = sign × (shoulder→wrist × pole)). */
  private readonly sign: number;
  private readonly a: number;
  private readonly b: number;
  private readonly restHandInv: THREE.Quaternion;
  private t = {
    dir: new THREE.Vector3(),
    p: new THREE.Vector3(),
    z: new THREE.Vector3(),
    xu: new THREE.Vector3(),
    yu: new THREE.Vector3(),
    xf: new THREE.Vector3(),
    yf: new THREE.Vector3(),
    yh: new THREE.Vector3(),
    v: new THREE.Vector3(),
    qp: new THREE.Quaternion(),
    qu: new THREE.Quaternion(),
    qf: new THREE.Quaternion(),
    qh: new THREE.Quaternion(),
    q: new THREE.Quaternion(),
    m: new THREE.Matrix4(),
    s: new THREE.Vector3(),
  };

  constructor(
    readonly arm: MasterArm,
    restHand: THREE.Quaternion,
    private cfg: { maxReach: number; maxFlexDeg: number; clavicle?: { start: number; full: number; maxDeg: number } } = data.ik,
  ) {
    this.sign = arm.side === 'R' ? 1 : -1;
    this.a = arm.upperLen;
    this.b = arm.foreLen;
    this.restHandInv = restHand.clone().invert();
  }

  /**
   * A far target draws the shoulder toward it: the clavicle turns about its head, toward the
   * target, by `clavicle.maxDeg` × smoothstep of the reach (|shoulder → target| / arm length)
   * between `clavicle.start` and `clavicle.full`. Continuous, the same for every character.
   */
  private reachClavicle(W: THREE.Vector3, scale: number): void {
    const c = this.cfg.clavicle;
    if (!c || c.maxDeg <= 0) return;
    const t = this.t;
    const cl = this.arm.clavicle;
    cl.updateWorldMatrix(true, false);
    const C = t.v.setFromMatrixPosition(cl.matrixWorld);
    const S = t.p.copy(this.arm.upper.position).applyMatrix4(cl.matrixWorld);
    const r = S.distanceTo(W) / ((this.a + this.b) * scale);
    const k = THREE.MathUtils.smoothstep(r, c.start, c.full);
    if (k <= 0) return;
    const cs = S.sub(C);
    const cw = t.yh.subVectors(W, C);
    const axis = t.z.crossVectors(cs, cw);
    if (axis.lengthSq() < 1e-12) return;
    axis.normalize();
    const ang = Math.min(THREE.MathUtils.degToRad(c.maxDeg) * k, cs.angleTo(cw));
    // World turn about the clavicle's head, written as a local rotation (decomposed: the
    // world matrices may carry the body's uniform scale).
    cl.parent!.matrixWorld.decompose(t.xu, t.qp, t.s);
    cl.matrixWorld.decompose(t.xu, t.qu, t.s);
    t.q.setFromAxisAngle(axis, ang).multiply(t.qu);
    cl.quaternion.copy(t.qp).invert().multiply(t.q);
    cl.updateMatrixWorld(true);
    this.stats.clavicleDeg = THREE.MathUtils.radToDeg(ang);
  }

  /**
   * Put the hand on `target` (world: the Hand bone's frame, its translation the wrist) with the
   * elbow bending toward `polePoint` (world). Writes UpperArm, Forearm and Hand local rotations and
   * updates the arm's world matrices (children included: sockets and what hangs on them).
   */
  solve(target: THREE.Matrix4, polePoint: THREE.Vector3): void {
    const t = this.t;
    this.stats.clavicleDeg = 0;
    const arm = this.arm;
    const parent = arm.upper.parent!;
    // A body drawn at a uniform scale (the game's height): the bones' world lengths.
    parent.updateWorldMatrix(true, false);
    const k = t.s.setFromMatrixScale(parent.matrixWorld).x;
    const a = this.a * k;
    const b = this.b * k;
    target.decompose(this.wrist, t.qh, t.s);
    const W = this.wrist;
    this.reachClavicle(W, k);
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(t.v, t.qp, t.s);
    const S = this.shoulder.copy(arm.upper.position).applyMatrix4(parent.matrixWorld);

    // Reach: clamp the shoulder → wrist distance between full fold and straight.
    const dir = t.dir.subVectors(W, S);
    const d = dir.length();
    dir.multiplyScalar(1 / Math.max(d, 1e-9));
    const flexMax = THREE.MathUtils.degToRad(this.cfg.maxFlexDeg);
    const dMin = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(flexMax));
    const dMax = (a + b) * this.cfg.maxReach;
    const de = THREE.MathUtils.clamp(d, dMin, dMax);
    this.stats.reach = d / (a + b);
    this.stats.shortM = Math.max(0, d - de);
    W.copy(S).addScaledVector(dir, de);

    // The elbow's plane: toward the pole point, square to the line.
    const p = t.p.subVectors(polePoint, S);
    p.addScaledVector(dir, -p.dot(dir));
    if (p.lengthSq() < 1e-10) {
      // The pole is on the line: the elbow goes down, else back.
      p.set(0, -1, 0).addScaledVector(dir, dir.y);
      if (p.lengthSq() < 1e-10) p.set(0, 0, -1).applyQuaternion(t.qp).addScaledVector(dir, -dir.dot(p));
    }
    this.pole.copy(p.normalize());

    const cosA = THREE.MathUtils.clamp((a * a + de * de - b * b) / (2 * a * de), -1, 1);
    const E = this.elbow.copy(S).addScaledVector(dir, a * cosA).addScaledVector(p, a * Math.sqrt(1 - cosA * cosA));

    // Hinge frames: +Y along each bone, +Z the hinge axis, X = Y × Z.
    const z = t.z.crossVectors(dir, p).multiplyScalar(this.sign).normalize();
    const yu = t.yu.subVectors(E, S).normalize();
    const xu = t.xu.crossVectors(yu, z);
    const yf = t.yf.subVectors(W, E).normalize();
    const xf = t.xf.crossVectors(yf, z);
    t.qu.setFromRotationMatrix(t.m.makeBasis(xu, yu, z));
    t.qf.setFromRotationMatrix(t.m.makeBasis(xf, yf, z));

    // Local rotations: parent⁻¹ × child, top down.
    arm.upper.quaternion.copy(t.qp).invert().multiply(t.qu);
    arm.fore.quaternion.copy(t.qu).invert().multiply(t.qf);
    arm.hand.quaternion.copy(t.qf).invert().multiply(t.qh);
    arm.upper.updateMatrixWorld(true);

    const r2d = THREE.MathUtils.radToDeg;
    this.stats.flexDeg = r2d(yu.angleTo(yf));
    t.yh.set(0, 1, 0).applyQuaternion(t.qh);
    this.stats.wristBendDeg = r2d(yf.angleTo(t.yh));
    this.stats.handTwistDeg = r2d(twistAboutY(t.q.copy(this.restHandInv).multiply(arm.hand.quaternion)));
  }
}
