import * as THREE from 'three';
import type { Soldier } from '../enemies/Soldier';
import { MasterCharacter } from '../characters/MasterCharacter';
import type { MasterGrip } from '../characters/MasterGrips';
import type { Digit, Side } from '../characters/master/MasterRig';
import { getProbes, RigSurface } from './masterGameChecks';
import { worldFit } from '../weapons/WeaponMeshes';
import type { ModelKey } from '../weapons/WeaponData';

/**
 * Fits the master humanoid's two hold frames on a third-person gun (soldier-lab.html:
 * `__slm.fit(i)` for soldier i's current gun): Nelder–Mead over each hand's frame - an offset (mm)
 * and a turn (deg) about the frame's own axes, from where it is now (the rule's frames) - against
 * the lab's grip measures (dev/masterGameChecks.ts): the wrapping fingertips and the palm on the
 * gun's surface, the thumb near it, no part of the hand deep inside, the wrist bend, the IK's reach.
 * The hands are separate chains, so each side is fitted alone (a handgun's support hand keeps its
 * place round the firing hand). The result goes to masterRig.json game.grip.fit.<model>: frames in
 * the model's own space (the drawn gun's file), which MasterGrips carries onto any rig the model
 * dresses through its fit (WeaponMeshes.worldFit), desktop or phone.
 */
const WRAP: Record<Side, Digit[]> = { R: ['Middle', 'Ring', 'Pinky'], L: ['Index', 'Middle', 'Ring', 'Pinky'] };
/** Surface search radius in 1 cm cells (beyond it a probe reads as `FAR` and the cost stays smooth). */
const REACH = 3;
const FAR = 0.05;

export interface FitReport {
  model: string;
  evals: number;
  ms: number;
  before: Record<Side, SideMeasure>;
  after: Record<Side, SideMeasure>;
  /** Model-space frames (the gun's file): position then quaternion. */
  right: number[];
  left: number[];
}

interface SideMeasure {
  tips: Partial<Record<Digit, number>>;
  thumb: number;
  palm: number;
  inside: number;
  wrist: number;
  posMm: number;
  cost: number;
}

const mm = (x: number) => Math.round(x * 10000) / 10;
const D2R = THREE.MathUtils.DEG2RAD;

/** Nelder–Mead minimisation of f from x0 with per-axis initial steps. */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], maxEvals: number): { x: number[]; fx: number; evals: number } {
  const n = x0.length;
  let evals = 0;
  const F = (x: number[]) => (evals++, f(x));
  const pts: { x: number[]; fx: number }[] = [{ x: x0.slice(), fx: F(x0) }];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step[i];
    pts.push({ x, fx: F(x) });
  }
  while (evals < maxEvals) {
    pts.sort((a, b) => a.fx - b.fx);
    const best = pts[0], worst = pts[n], second = pts[n - 1];
    if (Math.abs(worst.fx - best.fx) < 1e-3 * (1 + Math.abs(best.fx))) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += pts[i].x[k] / n;
    const along = (t: number) => c.map((ck, k) => ck + t * (worst.x[k] - ck));
    const r = along(-1);
    const fr = F(r);
    if (fr < best.fx) {
      const e = along(-2);
      const fe = F(e);
      pts[n] = fe < fr ? { x: e, fx: fe } : { x: r, fx: fr };
    } else if (fr < second.fx) {
      pts[n] = { x: r, fx: fr };
    } else {
      const k = along(fr < worst.fx ? -0.5 : 0.5);
      const fk = F(k);
      if (fk < Math.min(fr, worst.fx)) pts[n] = { x: k, fx: fk };
      else {
        // Shrink everything toward the best.
        for (let i = 1; i <= n; i++) {
          const x = pts[i].x.map((xi, j) => best.x[j] + 0.5 * (xi - best.x[j]));
          pts[i] = { x, fx: F(x) };
        }
      }
    }
  }
  pts.sort((a, b) => a.fx - b.fx);
  return { x: pts[0].x, fx: pts[0].fx, evals };
}

/** Fit both hold frames of soldier `s` (a master body holding a gun, posed near). */
export function fitGrip(s: Soldier, model: string, maxEvals = 360): FitReport {
  const t0 = performance.now();
  const m = s.body.visual;
  if (!(m instanceof MasterCharacter)) throw new Error('not a master body');
  const grip = (s as unknown as { grip: MasterGrip | null }).grip;
  if (!grip) throw new Error('no grip');
  // The probes are vertices of the near body.
  if (m.mesh.geometry !== m.near) throw new Error('far body: bring the camera (humanoidView) near it first');
  const gunRoot = s.rig.root;
  gunRoot.updateWorldMatrix(true, true);
  const surface = new RigSurface(gunRoot);
  const P = getProbes();
  const rig = m.rig;
  const v = new THREE.Vector3();
  const toRoot = new THREE.Matrix4();
  // Every 3rd probe vertex: the minimum over a fingertip barely moves, at a third of the cost.
  const thin = (a: number[], k = 3) => a.filter((_, i) => i % k === 0);
  const tips = { R: {} as Record<Digit, number[]>, L: {} as Record<Digit, number[]> };
  for (const side of ['R', 'L'] as Side[]) for (const d of Object.keys(P.tips[side]) as Digit[]) tips[side][d] = thin(P.tips[side][d]);
  const palm = { R: thin(P.palm.R), L: thin(P.palm.L) };
  // Penetration: every hand vertex within 4 cm of the gun when the fit starts (the hand moves a
  // couple of centimetres at most; a fingertip pad pressed in is a small patch), only the first
  // centimetre round each searched.
  const hand = { R: [] as number[], L: [] as number[] };
  const dist = (i: number, reach = REACH) => {
    const d = surface.nearest(rig.mesh.getVertexPosition(i, v).applyMatrix4(toRoot), reach);
    return Number.isFinite(d) ? d : FAR;
  };
  const minOf = (ids: number[], reach = REACH) => ids.reduce((b, i) => Math.min(b, dist(i, reach)), Infinity);

  const nodes: Record<Side, THREE.Object3D> = { R: grip.right, L: grip.left };
  const base: Record<Side, THREE.Matrix4> = {
    R: new THREE.Matrix4().compose(grip.right.position, grip.right.quaternion, grip.right.scale),
    L: new THREE.Matrix4().compose(grip.left.position, grip.left.quaternion, grip.left.scale),
  };
  // A handgun's support hand rides the firing hand (its place relative to the grip frame kept).
  const supportOnRight = grip.pistol ? base.R.clone().invert().multiply(base.L) : null;
  const delta = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const place = (side: Side, x: number[]) => {
    delta.compose(v.set(x[0] / 1000, x[1] / 1000, x[2] / 1000), q.setFromEuler(e.set(x[3] * D2R, x[4] * D2R, x[5] * D2R)), one);
    const f = base[side].clone().multiply(delta);
    f.decompose(nodes[side].position, nodes[side].quaternion, nodes[side].scale);
    if (side === 'R' && supportOnRight) f.multiply(supportOnRight).decompose(nodes.L.position, nodes.L.quaternion, nodes.L.scale);
    nodes.R.updateMatrixWorld(true);
    nodes.L.updateMatrixWorld(true);
  };
  const measure = (side: Side): SideMeasure => {
    m.posed(1 / 60, false);
    toRoot.copy(gunRoot.matrixWorld).invert().multiply(rig.mesh.matrixWorld);
    const t: Partial<Record<Digit, number>> = {};
    for (const d of WRAP[side]) t[d] = minOf(tips[side][d]);
    // (A thumb off the gun still needs a way back: searched wider.)
    const thumb = minOf(tips[side].Thumb, 6);
    const p = minOf(palm[side]);
    const inside = minOf(hand[side], 1);
    const arm = rig.arms[side];
    const yf = new THREE.Vector3().setFromMatrixColumn(arm.fore.matrixWorld, 1).normalize();
    const yh = new THREE.Vector3().setFromMatrixColumn(arm.hand.matrixWorld, 1).normalize();
    const wrist = THREE.MathUtils.radToDeg(yf.angleTo(yh));
    const posMm = v.setFromMatrixPosition(arm.hand.matrixWorld).distanceTo(new THREE.Vector3().setFromMatrixPosition(m.targets[side])) * 1000;
    // Cost (mm², deg²): touching is 0 … 1.5 mm off the surface; past 2 mm in, it pushes back.
    const gap = (d: number) => {
      const x = d * 1000;
      return Math.max(0, x - 1.5) ** 2 + 2 * Math.max(0, -2 - x) ** 2;
    };
    let cost = 0;
    for (const d of WRAP[side]) cost += gap(t[d]!);
    // The handgun's support hand wraps the firing hand, not the gun: its own contacts don't count.
    const weight = grip.pistol && side === 'L' ? 0 : 1;
    cost *= weight;
    cost += weight * (0.6 * Math.max(0, Math.abs(thumb * 1000) - 4) ** 2 + gap(p));
    // (The sample is sparse: keep a margin to the check's −6 mm.)
    cost += 8 * Math.max(0, -inside * 1000 - 3.5) ** 2;
    cost += 0.4 * Math.max(0, wrist - 42) ** 2 + 20 * Math.max(0, wrist - 55) ** 2;
    cost += 20 * posMm ** 2;
    // Off the reach limit: the body breathes and sways, a target at full stretch drops out of reach.
    // (A handgun is held out at arm's length by its stance, on purpose.)
    if (!grip.pistol) cost += 4000 * Math.max(0, m.ik[side].stats.reach - 0.95) ** 2;
    return { tips: Object.fromEntries(Object.entries(t).map(([k, d]) => [k, mm(d!)])), thumb: mm(thumb), palm: mm(p), inside: mm(inside), wrist: Math.round(wrist * 10) / 10, posMm: Math.round(posMm * 10) / 10, cost: Math.round(cost) };
  };

  m.posed(1 / 60, false);
  toRoot.copy(gunRoot.matrixWorld).invert().multiply(rig.mesh.matrixWorld);
  for (const side of ['R', 'L'] as Side[]) hand[side] = P.hand[side].filter((i) => dist(i, 4) < 0.04);
  const before = { R: measure('R'), L: measure('L') } as Record<Side, SideMeasure>;
  let evals = 0;
  const sides: Side[] = grip.pistol ? ['R'] : ['R', 'L'];
  for (const side of sides) {
    // Small steps away from the start are cheap, wild ones are not: a soft pull back to it.
    const f = (x: number[]) => {
      place(side, x);
      // A handgun's support hand moves with the grip frame: its wrist and reach count too.
      const c = measure(side).cost + (grip.pistol ? measure('L').cost : 0);
      return c + 0.02 * (x[0] ** 2 + x[1] ** 2 + x[2] ** 2) + 0.05 * (x[3] ** 2 + x[4] ** 2 + x[5] ** 2);
    };
    // Two rounds from each start: a coarse simplex, then a fine one from its best. A hand still
    // far off after the first start tries three more (a local optimum on an odd-shaped gun).
    let best = { x: [0, 0, 0, 0, 0, 0], fx: Infinity };
    for (const start of [[0, 0, 0, 0, 0, 0], [8, -8, 0, 0, 0, 10], [-8, 0, 8, 10, 0, 0], [0, 8, -8, 0, -10, -8]]) {
      if (best.fx < 30) break;
      let x = start;
      let fx = Infinity;
      for (const st of [[12, 12, 12, 10, 10, 10], [4, 4, 4, 3, 3, 3]]) {
        const r = nelderMead(f, x, st, maxEvals / 2);
        [x, fx] = [r.x, r.fx];
        evals += r.evals;
      }
      if (fx < best.fx) best = { x, fx };
    }
    place(side, best.x);
  }
  const after = { R: measure('R'), L: measure('L') } as Record<Side, SideMeasure>;
  // Rig root space → the model's own (the inverse of the model's fit onto this rig).
  const wf = worldFit(model as ModelKey);
  if (!wf) throw new Error(`${model}: no drawn model to fit on`);
  const inv = wf.clone().invert();
  const fq = new THREE.Quaternion();
  wf.decompose(new THREE.Vector3(), fq, new THREE.Vector3());
  fq.invert();
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  const frame = (o: THREE.Object3D) => [...o.position.clone().applyMatrix4(inv).toArray().map(r5), ...fq.clone().multiply(o.quaternion).toArray().map(r5)];
  return { model, evals, ms: Math.round(performance.now() - t0), before, after, right: frame(grip.right), left: frame(grip.left) };
}
