import * as THREE from 'three';
import { applySockets, sided, type MasterRig, type Side, type Digit } from '../characters/master/MasterRig';
import { jointQuaternion } from '../weapons/hands/GripPoses';
import type { RifleHold } from '../characters/master/RifleHold';
import data from '../characters/master/masterRig.json';
import type { GunSurface, Probes } from './masterChecks';

/**
 * Deriving the master's hand frames on a weapon as DATA (master-lab.html → __ml.fit): with the
 * fingers in their library grip pose, move the hand (6 DOF, its own frame) until the wrapping
 * fingertips and the palm touch the weapon's surface without sinking into it, starting from the
 * frame the first-person hold gives. The result is written into the live data (right hand:
 * masterRig.json `sockets.RightHandWeaponSocket`; left: the weapon's `leftGrip`) for the lab to
 * show and the checks to judge; it is saved by copying the printed numbers into masterRig.json.
 */
export interface FitOptions {
  /** Fingers whose tips must touch (default: right middle/ring/pinky, left index…pinky). */
  wrap?: Digit[];
  /** Wanted gap (mm) for tips and palm. */
  gap?: number;
  /** How far the hand may wander from the start before it costs (m, deg). */
  keepM?: number;
  keepDeg?: number;
  iterations?: number;
  /** Weight of the thumb's gap (default 0.3). */
  thumbWeight?: number;
  /** More cost for a candidate hand frame (the weapon's metric model space), e.g. the arm's twist. */
  extra?: (H: THREE.Matrix4, terms: Record<string, number>) => number;
}

export interface FitResult {
  side: Side;
  cost0: number;
  cost: number;
  moveMm: number;
  turnDeg: number;
  terms: Record<string, number>;
  /** The new data (socket transform for the right hand, leftGrip for the left). */
  data: { position: number[]; quaternion: number[] };
}

const WRAP: Record<Side, Digit[]> = { R: ['Middle', 'Ring', 'Pinky'], L: ['Index', 'Middle', 'Ring', 'Pinky'] };

/** Fit one hand on the weapon as the hold has it now (pose a rifle mode first). */
export function fitHand(rig: MasterRig, hold: RifleHold, probes: Probes, gun: GunSurface, side: Side, o: FitOptions = {}): FitResult {
  const wrap = o.wrap ?? WRAP[side];
  const gap = o.gap ?? 1;
  const keepM = o.keepM ?? 0.02;
  const keepDeg = o.keepDeg ?? 15;
  const mesh = rig.mesh;
  const arm = rig.arms[side];
  rig.model.updateMatrixWorld(true);
  const handInv = new THREE.Matrix4().copy(arm.hand.matrixWorld).invert();
  const v = new THREE.Vector3();
  const local = (ids: number[], step = 1) => {
    const out: THREE.Vector3[] = [];
    for (let k = 0; k < ids.length; k += step) out.push(mesh.getVertexPosition(ids[k], v).applyMatrix4(mesh.matrixWorld).applyMatrix4(handInv).clone());
    return out;
  };
  // Middle phalanx vertices (dominant bone X2).
  const geo = mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const mids: Record<string, number[]> = {};
  for (const d of wrap) {
    const j = bones.indexOf(rig.bone(sided(`${d}2`, side)));
    mids[d] = [];
    for (let i = 0; i < si.count; i++) {
      let best = -1, bj = -1;
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > best) [best, bj] = [sw.getComponent(i, k), si.getComponent(i, k)];
      if (bj === j) mids[d].push(i);
    }
  }
  const tips = Object.fromEntries(wrap.map((d) => [d, local(probes.tips[side][d])])) as Record<string, THREE.Vector3[]>;
  const thumb = local(probes.tips[side].Thumb);
  const midL = Object.fromEntries(wrap.map((d) => [d, local(mids[d], 2)])) as Record<string, THREE.Vector3[]>;
  const palm = local(probes.palm[side]);
  const all = local(probes.hand[side], 3);

  // The hand's frame in the weapon's metric model frame now.
  hold.weapon.updateWorldMatrix(true, false);
  const H0 = new THREE.Matrix4().copy(hold.weapon.matrixWorld).invert().multiply(arm.hand.matrixWorld);
  const scale = hold.def.scale;
  const mm = scale * 1000;
  const H = new THREE.Matrix4();
  const D = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const rv = new THREE.Vector3();
  const p = new THREE.Vector3();
  const frameOf = (x: number[]) => {
    rv.set(x[3], x[4], x[5]);
    const ang = rv.length();
    q.setFromAxisAngle(ang > 1e-12 ? rv.clone().divideScalar(ang) : rv.set(1, 0, 0), ang);
    D.compose(new THREE.Vector3(x[0], x[1], x[2]), q, new THREE.Vector3(1, 1, 1));
    return H.multiplyMatrices(H0, D);
  };
  const dist = (pts: THREE.Vector3[], reach: number) => {
    let best = Infinity;
    for (const pt of pts) {
      p.copy(pt).applyMatrix4(H).divideScalar(scale);
      const d = gun.nearest(p, reach);
      if (d < best) best = d;
    }
    return Number.isFinite(best) ? best * mm : 40;
  };
  const terms: Record<string, number> = {};
  const cost = (x: number[]): number => {
    frameOf(x);
    let c = 0;
    for (const d of wrap) {
      const g = dist(tips[d], 3);
      terms[`tip.${d}`] = g;
      c += (g - gap) ** 2;
      const gm = dist(midL[d], 3);
      terms[`mid.${d}`] = gm;
      c += 0.3 * Math.max(0, gm - 4) ** 2;
    }
    const gt = dist(thumb, 3);
    terms.thumb = gt;
    c += (o.thumbWeight ?? 0.3) * Math.max(0, Math.abs(gt - gap) - 3) ** 2;
    const gp = dist(palm, 3);
    terms.palm = gp;
    c += Math.max(0, gp - 2 * gap) ** 2 + 2 * Math.max(0, -gp - 2) ** 2;
    let pen = 0;
    for (const pt of all) {
      p.copy(pt).applyMatrix4(H).divideScalar(scale);
      const d = gun.nearest(p, 1);
      if (Number.isFinite(d) && d * mm < -2) pen += (d * mm + 2) ** 2;
    }
    terms.penetration = pen;
    c += 0.2 * pen;
    const move = Math.hypot(x[0], x[1], x[2]);
    const turn = THREE.MathUtils.radToDeg(Math.hypot(x[3], x[4], x[5]));
    c += 4 * (move / keepM) ** 2 + 4 * (turn / keepDeg) ** 2;
    if (o.extra) c += o.extra(H, terms);
    return c;
  };
  const x0 = [0, 0, 0, 0, 0, 0];
  const cost0 = cost(x0);
  const best = nelderMead(cost, x0, [0.006, 0.006, 0.006, 0.08, 0.08, 0.08], o.iterations ?? 500);
  const c = cost(best);
  frameOf(best);
  const result: FitResult = {
    side,
    cost0: +cost0.toFixed(2),
    cost: +c.toFixed(2),
    moveMm: +(Math.hypot(best[0], best[1], best[2]) * 1000).toFixed(1),
    turnDeg: +THREE.MathUtils.radToDeg(Math.hypot(best[3], best[4], best[5])).toFixed(1),
    terms: Object.fromEntries(Object.entries(terms).map(([k, val]) => [k, +val.toFixed(1)])),
    data: { position: [], quaternion: [] },
  };
  const pos = new THREE.Vector3();
  const s = new THREE.Vector3();
  if (side === 'R') {
    // socketLocal = H⁻¹ × grip frame.
    hold.rightGrip.updateMatrix();
    const sock = H.clone().invert().multiply(hold.rightGrip.matrix);
    sock.decompose(pos, q, s);
    result.data = { position: pos.toArray().map((x) => +x.toFixed(4)), quaternion: q.toArray().map((x) => +x.toFixed(5)) };
  } else {
    H.decompose(pos, q, s);
    result.data = { position: pos.divideScalar(scale).toArray().map((x) => +x.toFixed(2)), quaternion: q.toArray().map((x) => +x.toFixed(5)) };
  }
  return result;
}

/** Write a fit's numbers into the live data and the rig (the lab shows them at once). */
export function applyFit(rig: MasterRig, hold: RifleHold, r: FitResult): void {
  if (r.side === 'R') {
    data.sockets.RightHandWeaponSocket.position = r.data.position;
    data.sockets.RightHandWeaponSocket.quaternion = r.data.quaternion;
    applySockets(rig);
  } else {
    hold.def.leftGrip.position = r.data.position;
    hold.def.leftGrip.quaternion = r.data.quaternion;
  }
  hold.refresh();
}

export interface ThumbFit {
  side: Side;
  pose: string;
  cost0: number;
  cost: number;
  terms: Record<string, number>;
  /** Thumb1 [curl, spread, twist], Thumb2 curl, Thumb3 curl (deg). */
  angles: number[];
  /** The corrections as data (masterRig.json gripCorrections.<pose>). */
  data: Record<string, number[]>;
}

/**
 * Fit the master's thumb onto the weapon: Thumb1 [curl, spread, twist] and Thumb2 / Thumb3 curl
 * as a correction after the library pose, so its tip rests on the surface and no part of it sinks
 * in. Writes the result into the live data (masterRig.json `gripCorrections.<pose>`).
 */
export function fitThumb(rig: MasterRig, hold: RifleHold, gun: GunSurface, side: Side, pose: string, update: () => void, iterations = 300): ThumbFit {
  const mesh = rig.mesh;
  const geo = mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const thumbIdx = [1, 2, 3].map((j) => bones.indexOf(rig.bone(sided(`Thumb${j}`, side))));
  const verts: number[] = [];
  const tip: number[] = [];
  for (let i = 0; i < si.count; i++) {
    let best = -1, bj = -1;
    for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > best) [best, bj] = [sw.getComponent(i, k), si.getComponent(i, k)];
    if (!thumbIdx.includes(bj)) continue;
    verts.push(i);
    if (bj === thumbIdx[2]) tip.push(i);
  }
  const set = ((data.gripCorrections as Record<string, Record<string, number[]>>)[pose] ??= {});
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const mm = hold.def.scale * 1000;
  const terms: Record<string, number> = {};
  const write = (x: number[]) => {
    set.Thumb1 = jointQuaternion(x[0], x[1], x[2], q).toArray();
    set.Thumb2 = jointQuaternion(x[3], 0, 0, q).toArray();
    set.Thumb3 = jointQuaternion(x[4], 0, 0, q).toArray();
  };
  const cost = (x: number[]): number => {
    write(x);
    update();
    const toModel = new THREE.Matrix4().copy(hold.model.matrixWorld).invert().multiply(mesh.matrixWorld);
    let g = Infinity;
    for (const i of tip) g = Math.min(g, gun.nearest(mesh.getVertexPosition(i, v).applyMatrix4(toModel), 3));
    if (!Number.isFinite(g)) for (const i of tip) g = Math.min(g, gun.far(mesh.getVertexPosition(i, v).applyMatrix4(toModel)));
    g *= mm;
    let pen = 0;
    for (const i of verts) {
      const d = gun.nearest(mesh.getVertexPosition(i, v).applyMatrix4(toModel), 1) * mm;
      if (Number.isFinite(d) && d < -1) pen += (d + 1) ** 2;
    }
    terms.tip = g;
    terms.penetration = pen;
    let reg = 0;
    for (const a of x) reg += (a / 25) ** 2;
    return (g - 1) ** 2 + 0.5 * pen + 2 * reg;
  };
  const x0 = [0, 0, 0, 0, 0];
  const cost0 = cost(x0);
  const best = nelderMead(cost, x0, [8, 8, 8, 8, 8], iterations);
  const c = cost(best);
  write(best);
  update();
  return {
    side,
    pose,
    cost0: +cost0.toFixed(2),
    cost: +c.toFixed(2),
    terms: Object.fromEntries(Object.entries(terms).map(([k, val]) => [k, +val.toFixed(1)])),
    angles: best.map((a) => +a.toFixed(1)),
    data: Object.fromEntries(['Thumb1', 'Thumb2', 'Thumb3'].map((k) => [k, set[k].map((x) => +x.toFixed(5))])),
  };
}


/** Nelder–Mead minimisation (small dimension, no gradients). */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters: number): number[] {
  const n = x0.length;
  let pts = [x0.slice(), ...step.map((s, i) => x0.map((v, j) => (j === i ? v + s : v)))];
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]);
    vals = order.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const at = (t: number) => c.map((v, j) => v + t * (pts[n][j] - v));
    const xr = at(-1);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = at(-2);
      const fe = f(xe);
      if (fe < fr) [pts[n], vals[n]] = [xe, fe];
      else [pts[n], vals[n]] = [xr, fr];
    } else if (fr < vals[n - 1]) [pts[n], vals[n]] = [xr, fr];
    else {
      const xc = at(fr < vals[n] ? -0.5 : 0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, vals[n])) [pts[n], vals[n]] = [xc, fc];
      else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]));
          vals[i] = f(pts[i]);
        }
      }
    }
    if (Math.abs(vals[n] - vals[0]) < 1e-6) break;
  }
  const i = vals.indexOf(Math.min(...vals));
  return pts[i];
}

