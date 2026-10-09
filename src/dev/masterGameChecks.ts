import * as THREE from 'three';
import type { Soldier } from '../enemies/Soldier';
import { MasterCharacter } from '../characters/MasterCharacter';
import { masterAssets } from '../characters/MasterAssets';
import { DIGITS, SIDES, sided, type Digit, type Side } from '../characters/master/MasterRig';
import { twistAboutY } from '../characters/master/TwistSolver';
import data from '../characters/master/masterRig.json';

/**
 * The master humanoid's holds in the game, measured (soldier-lab.html `__slm`, or the game's
 * soldiers): the lab's acceptance checks (dev/masterChecks.ts) on the game's own guns, stances
 * and Humanoid-driven bodies.
 *
 *   onTarget    each solved hand on its IK target (mm, deg): the right hand's weapon socket on
 *               the gun's pistol-grip frame, the left wrist on the support frame
 *   palm        hand +Z against the target's +Z (deg)
 *   elbow       the elbow on its pole's side (cos), flexion 5 … 150° (never backwards)
 *   wrist       hand vs forearm bend < 60°, hand roll |θ| < 120°
 *   twistSplit  ForearmTwist / ForearmTwist2 = α₁θ, α₂θ and UpperArmTwist = −βφ (± 0.5°)
 *   reach       |shoulder → target| / arm length, and how far short the hand stays (mm)
 *   candy       skinned forearm cross-sections (50 %, 85 %) vs rest: hull area / perimeter ≥ 0.8
 *   grip        each wrapping fingertip (skinned distal segment) within 5 mm of the gun's surface,
 *               the thumb within 8 mm, the palm on it, no hand deep inside it
 *   weaponUp    the gun's +Y · world up > 0.5
 *   yaw         the drawn body (character space) and every metric the same at any world yaw
 *               (the Humanoid's pose held, the root turned, the visual posed again)
 */
const r2d = THREE.MathUtils.radToDeg;
const WRAP: Record<Side, Digit[]> = { R: ['Middle', 'Ring', 'Pinky'], L: ['Index', 'Middle', 'Ring', 'Pinky'] };

/** A gun's triangles in its rig root's space (metres) in a uniform grid: signed distance to the nearest. */
export class RigSurface {
  private cells = new Map<number, number[]>();
  private tri: Float32Array;
  private stamp: Uint32Array;
  private pass = 0;
  private T = new THREE.Triangle();
  private q = new THREE.Vector3();
  private static CELL = 0.01;
  private static key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

  constructor(readonly root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const flat: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Matrix4();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) if (!p.visible) return;
      m.multiplyMatrices(inv, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.index;
      const len = idx ? idx.count : pos.count;
      for (let k = 0; k + 2 < len; k += 3) {
        a.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(m);
        b.fromBufferAttribute(pos, idx ? idx.getX(k + 1) : k + 1).applyMatrix4(m);
        c.fromBufferAttribute(pos, idx ? idx.getX(k + 2) : k + 2).applyMatrix4(m);
        THREE.Triangle.getNormal(a, b, c, n);
        if (n.lengthSq() < 0.5) continue;
        flat.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, n.x, n.y, n.z);
      }
    });
    this.tri = new Float32Array(flat);
    this.stamp = new Uint32Array(flat.length / 12);
    const C = RigSurface.CELL;
    const T = this.tri;
    for (let i = 0; i < T.length / 12; i++) {
      const o = i * 12;
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(T[o + k], T[o + 3 + k], T[o + 6 + k]) / C));
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(T[o + k], T[o + 3 + k], T[o + 6 + k]) / C));
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const key = RigSurface.key(x, y, z);
            let cell = this.cells.get(key);
            if (!cell) this.cells.set(key, (cell = []));
            cell.push(i);
          }
    }
  }

  /** Signed distance (m, − behind the surface) from root-space point `p` to the nearest triangle within `reach` cells (Infinity: none). */
  nearest(p: THREE.Vector3, reach = 2): number {
    const C = RigSurface.CELL;
    const cx = Math.floor(p.x / C), cy = Math.floor(p.y / C), cz = Math.floor(p.z / C);
    const T = this.tri;
    let best = Infinity;
    let signed = Infinity;
    const pass = ++this.pass;
    for (let x = cx - reach; x <= cx + reach; x++)
      for (let y = cy - reach; y <= cy + reach; y++)
        for (let z = cz - reach; z <= cz + reach; z++) {
          const cell = this.cells.get(RigSurface.key(x, y, z));
          if (!cell) continue;
          for (const i of cell) {
            if (this.stamp[i] === pass) continue;
            this.stamp[i] = pass;
            const o = i * 12;
            this.T.a.set(T[o], T[o + 1], T[o + 2]);
            this.T.b.set(T[o + 3], T[o + 4], T[o + 5]);
            this.T.c.set(T[o + 6], T[o + 7], T[o + 8]);
            this.T.closestPointToPoint(p, this.q);
            const d = this.q.distanceTo(p);
            // A big triangle sits in every cell of its box: past the searched radius it is not "near"
            // (its plane's side would say inside or out at random).
            if (d > (reach + 0.5) * C) continue;
            if (d < best) {
              best = d;
              const side = (p.x - this.q.x) * T[o + 9] + (p.y - this.q.y) * T[o + 10] + (p.z - this.q.z) * T[o + 11];
              signed = side >= 0 ? d : -d;
            }
          }
        }
    return signed;
  }
}

interface Probes {
  tips: Record<Side, Record<Digit, number[]>>;
  palm: Record<Side, number[]>;
  hand: Record<Side, number[]>;
  /** Forearm sections: vertex sets, the fraction along the forearm, rest hull (area, perimeter). */
  slabs: { side: Side; f: number; verts: number[]; area: number; perim: number }[];
}

let probes: Probes | null = null;

/** Probe vertices chosen once on the template body at rest (every master character shares the geometry). */
export function getProbes(): Probes {
  if (probes) return probes;
  const a = masterAssets();
  if (!a) throw new Error('master not loaded');
  const rig = a.rig;
  const mesh = rig.mesh;
  rig.model.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const idx = (n: string) => bones.indexOf(rig.bone(n));
  const v = new THREE.Vector3();
  const n = si.count;
  const dominant = (i: number) => {
    let best = -1, bj = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > best) [best, bj] = [w, si.getComponent(i, k)];
    }
    return bj;
  };
  const weightOf = (i: number, set: Set<number>) => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (set.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
    return w;
  };
  const out: Probes = { tips: { R: {} as Record<Digit, number[]>, L: {} as Record<Digit, number[]> }, palm: { R: [], L: [] }, hand: { R: [], L: [] }, slabs: [] };
  for (const s of SIDES) {
    const arm = rig.arms[s];
    for (const d of DIGITS) {
      const tip = idx(sided(`${d}3`, s));
      out.tips[s][d] = [];
      for (let i = 0; i < n; i++) if (dominant(i) === tip) out.tips[s][d].push(i);
    }
    const handIdx = idx(sided('Hand', s));
    const handBones = new Set([handIdx, ...arm.fingers.map((b) => bones.indexOf(b))]);
    const handInv = new THREE.Matrix4().copy(arm.hand.matrixWorld).invert();
    for (let i = 0; i < n; i++) {
      const dj = dominant(i);
      if (!handBones.has(dj)) continue;
      out.hand[s].push(i);
      if (dj !== handIdx) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).applyMatrix4(handInv);
      if (v.z > 0.008 && v.y > 0.03 && v.y < 0.095) out.palm[s].push(i);
    }
    const foreSet = new Set([idx(sided('Forearm', s)), idx(sided('ForearmTwist', s)), idx(sided('ForearmTwist2', s)), handIdx]);
    const A = new THREE.Vector3().setFromMatrixPosition(arm.fore.matrixWorld);
    const B = new THREE.Vector3(0, arm.foreLen, 0).applyMatrix4(arm.fore.matrixWorld);
    const line = new THREE.Line3(A, B);
    for (const f of [0.5, 0.85]) {
      // The game's body is a decimated LOD: a slab 4 cm thick holds a ring or two.
      const verts: number[] = [];
      for (let i = 0; i < n; i++) {
        if (weightOf(i, foreSet) < 0.97) continue;
        mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
        if (Math.abs(line.closestPointToPointParameter(v, false) - f) * arm.foreLen > 0.02) continue;
        verts.push(i);
      }
      const [area, perim] = section(mesh, arm.fore, verts);
      if (verts.length >= 8 && area > 0) out.slabs.push({ side: s, f, verts, area, perim });
    }
  }
  return (probes = out);
}

const sv = new THREE.Vector3();
const sm = new THREE.Matrix4();
function section(mesh: THREE.SkinnedMesh, bone: THREE.Object3D, verts: number[]): [number, number] {
  sm.copy(bone.matrixWorld).invert();
  const pts: [number, number][] = [];
  for (const i of verts) {
    mesh.getVertexPosition(i, sv).applyMatrix4(mesh.matrixWorld).applyMatrix4(sm);
    pts.push([sv.x, sv.z]);
  }
  if (pts.length < 3) return [0, 0];
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  let area = 0;
  let perim = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    area += a[0] * b[1] - b[0] * a[1];
    perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return [Math.abs(area) / 2, perim];
}

export interface MasterMeasure {
  posMm: Partial<Record<Side, number>>;
  rotDeg: Partial<Record<Side, number>>;
  palmDeg: Partial<Record<Side, number>>;
  elbowPole: Partial<Record<Side, number>>;
  flexDeg: Partial<Record<Side, number>>;
  wristDeg: Partial<Record<Side, number>>;
  rollDeg: Partial<Record<Side, number>>;
  splitErr: Record<Side, number>;
  reach: Partial<Record<Side, number>>;
  shortMm: Partial<Record<Side, number>>;
  candy: number;
  tipsMm: Partial<Record<Side, Record<Digit, number>>>;
  palmMm: Partial<Record<Side, number>>;
  insideMm: Partial<Record<Side, number>>;
  weaponUp: number;
}

const surfaces = new WeakMap<THREE.Object3D, RigSurface>();
const t = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), s: new THREE.Vector3(), m: new THREE.Matrix4(), line: new THREE.Line3() };
const col = (m: THREE.Matrix4, i: number, out: THREE.Vector3) => out.setFromMatrixColumn(m, i).normalize();
const quatOf = (m: THREE.Matrix4, out: THREE.Quaternion) => (m.decompose(t.s, out, t.c), out.normalize());

/** One master soldier's hold as it stands (posed this frame). */
export function measureMaster(s: Soldier, withSurface = true): MasterMeasure | null {
  const m = s.body.visual;
  if (!(m instanceof MasterCharacter)) return null;
  const rig = m.rig;
  const out: MasterMeasure = { posMm: {}, rotDeg: {}, palmDeg: {}, elbowPole: {}, flexDeg: {}, wristDeg: {}, rollDeg: {}, splitErr: { R: 0, L: 0 }, reach: {}, shortMm: {}, candy: Infinity, tipsMm: {}, palmMm: {}, insideMm: {}, weaponUp: 0 };
  const gunRoot = s.rig.root;
  gunRoot.updateWorldMatrix(true, false);
  out.weaponUp = col(gunRoot.matrixWorld, 1, t.a).y;
  const P = getProbes();
  let surface = withSurface ? surfaces.get(gunRoot) : undefined;
  if (withSurface && !surface) surfaces.set(gunRoot, (surface = new RigSurface(gunRoot)));
  const toRoot = new THREE.Matrix4().copy(gunRoot.matrixWorld).invert().multiply(rig.mesh.matrixWorld);
  const v = new THREE.Vector3();
  for (const side of SIDES) {
    const arm = rig.arms[side];
    // Twist split (always).
    const restQ = (b: THREE.Bone) => rig.rest.get(b.name)!.quaternion;
    const tw = (b: THREE.Bone) => twistAboutY(t.q.copy(restQ(b)).invert().multiply(b.quaternion));
    const hand = tw(arm.hand);
    // (An arm easing in after changing hands blends its twist bones too.)
    out.splitErr[side] = m.easing(side) ? 0 : Math.max(
      Math.abs(r2d(tw(arm.foreTwist) - m.twist.alpha * hand)),
      Math.abs(r2d(tw(arm.foreTwist2) - m.twist.alpha2 * hand)),
      Math.abs(r2d(tw(arm.upperTwist) + m.twist.beta * tw(arm.upper))),
    );
    // (An arm easing in after changing hands is short of its target on purpose.)
    if (!m.solved[side] || m.easing(side)) continue;
    const target = m.targets[side];
    out.posMm[side] = t.a.setFromMatrixPosition(arm.hand.matrixWorld).distanceTo(t.b.setFromMatrixPosition(target)) * 1000;
    out.rotDeg[side] = r2d(quatOf(arm.hand.matrixWorld, t.q).angleTo(quatOf(target, t.q2)));
    out.palmDeg[side] = r2d(col(arm.hand.matrixWorld, 2, t.a).angleTo(col(target, 2, t.b)));
    const S = new THREE.Vector3().setFromMatrixPosition(arm.upper.matrixWorld);
    const E = new THREE.Vector3().setFromMatrixPosition(arm.fore.matrixWorld);
    const W = new THREE.Vector3().setFromMatrixPosition(arm.hand.matrixWorld);
    t.line.set(S, W);
    const foot = t.line.closestPointToPoint(E, false, new THREE.Vector3());
    const off = E.clone().sub(foot);
    const dir = W.clone().sub(S).normalize();
    const poleOff = m.poles[side].clone().sub(foot);
    poleOff.addScaledVector(dir, -poleOff.dot(dir));
    out.elbowPole[side] = off.lengthSq() > 1e-10 && poleOff.lengthSq() > 1e-10 ? off.normalize().dot(poleOff.normalize()) : 0;
    const yu = col(arm.upper.matrixWorld, 1, new THREE.Vector3());
    const yf = col(arm.fore.matrixWorld, 1, new THREE.Vector3());
    const zf = col(arm.fore.matrixWorld, 2, new THREE.Vector3()).multiplyScalar(side === 'R' ? -1 : 1);
    out.flexDeg[side] = r2d(Math.atan2(new THREE.Vector3().crossVectors(yu, yf).dot(zf), yu.dot(yf)));
    out.wristDeg[side] = r2d(yf.angleTo(col(arm.hand.matrixWorld, 1, new THREE.Vector3())));
    out.rollDeg[side] = r2d(hand);
    out.reach[side] = m.ik[side].stats.reach;
    out.shortMm[side] = m.ik[side].stats.shortM * 1000;
    if (surface) {
      const tips = {} as Record<Digit, number>;
      for (const d of DIGITS) {
        let best = Infinity;
        for (const i of P.tips[side][d]) best = Math.min(best, surface.nearest(rig.mesh.getVertexPosition(i, v).applyMatrix4(toRoot), 3));
        tips[d] = Number.isFinite(best) ? best * 1000 : 99;
      }
      out.tipsMm[side] = tips;
      let palm = Infinity;
      for (const i of P.palm[side]) palm = Math.min(palm, surface.nearest(rig.mesh.getVertexPosition(i, v).applyMatrix4(toRoot), 3));
      out.palmMm[side] = Number.isFinite(palm) ? palm * 1000 : 99;
      let inside = Infinity;
      for (const i of P.hand[side]) inside = Math.min(inside, surface.nearest(rig.mesh.getVertexPosition(i, v).applyMatrix4(toRoot), 1));
      out.insideMm[side] = Number.isFinite(inside) ? inside * 1000 : 99;
    }
  }
  for (const sl of P.slabs) {
    const [area, perim] = section(rig.mesh, rig.arms[sl.side].fore, sl.verts);
    out.candy = Math.min(out.candy, area / sl.area, perim / sl.perim);
  }
  return out;
}

export interface CheckRow {
  check: string;
  pass: boolean;
  worst: number;
  limit: string;
  where: string;
}

/** Fold measures into worst-case rows (`where` labels each sample). */
export class Rows {
  rows = new Map<string, CheckRow>();
  add(check: string, value: number | undefined, ok: (v: number) => boolean, limit: string, where: string, largerWorse = true): void {
    if (value === undefined || !Number.isFinite(value)) return;
    const r = this.rows.get(check);
    const pass = ok(value);
    if (!r) this.rows.set(check, { check, pass, worst: value, limit, where });
    else {
      r.pass &&= pass;
      if (largerWorse ? value > r.worst : value < r.worst) {
        r.worst = value;
        r.where = where;
      }
    }
  }
  fold(m: MasterMeasure, where: string): void {
    for (const s of SIDES) {
      const w = `${where} ${s}`;
      this.add('hand on target (mm)', m.posMm[s], (v) => v < 2, '< 2', w);
      this.add('hand rotation on target (°)', m.rotDeg[s], (v) => v < 0.5, '< 0.5', w);
      this.add('palm (°)', m.palmDeg[s], (v) => v < 5, '< 5', w);
      this.add('elbow on pole side (cos)', m.elbowPole[s], (v) => v > 0.5, '> 0.5', w, false);
      this.add('elbow flexion max (°)', m.flexDeg[s], (v) => v <= 150, '≤ 150', w);
      this.add('elbow flexion min (°)', m.flexDeg[s], (v) => v >= 5, '≥ 5 (never backwards)', w, false);
      this.add('wrist bend (°)', m.wristDeg[s], (v) => v < 60, '< 60', w);
      this.add('hand roll |θ| (°)', m.rollDeg[s] === undefined ? undefined : Math.abs(m.rollDeg[s]!), (v) => v < 120, '< 120', w);
      this.add('twist split (°)', m.splitErr[s], (v) => v < 0.5, '< 0.5', w);
      this.add('reach short (mm)', m.shortMm[s], (v) => v < 1, '< 1 (target in reach)', w);
      const tips = m.tipsMm[s];
      if (tips) {
        for (const d of WRAP[s]) this.add('finger grip |gap| (mm)', Math.abs(tips[d]), (v) => v < 5, '< 5', `${w}.${d}`);
        this.add('thumb |gap| (mm)', Math.abs(tips.Thumb), (v) => v < 8, '< 8', w);
      }
      this.add('palm on weapon (mm)', m.palmMm[s], (v) => v < 5, '< 5', w);
      this.add('hand inside weapon (mm)', m.insideMm[s], (v) => v > -6, '> −6', w, false);
    }
    this.add('candy-wrap section (ratio)', m.candy, (v) => v >= 0.8, '≥ 0.8', where, false);
    this.add('weapon up (dot)', m.weaponUp, (v) => v > 0.5, '> 0.5', where, false);
  }
  list(): CheckRow[] {
    return [...this.rows.values()].map((r) => ({ ...r, worst: +r.worst.toFixed(3) }));
  }
}

/**
 * Yaw invariance: the Humanoid's pose held, the root turned through 0 … 330° and the visual posed
 * again; the drawn bones (character space) and the measures must not change. Worst difference
 * (mm for bones, raw units for measures).
 */
export function yawSweep(s: Soldier): { boneMm: number; metric: number; where: string } {
  const m = s.body.visual as MasterCharacter;
  const root = s.body.root;
  const yaw0 = root.rotation.y;
  const bonesC = () => {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    return m.rig.mesh.skeleton.bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv));
  };
  const flat = (x: MasterMeasure) => [
    ...SIDES.flatMap((sd) => [x.posMm[sd] ?? 0, x.rotDeg[sd] ?? 0, x.palmDeg[sd] ?? 0, x.elbowPole[sd] ?? 0, x.flexDeg[sd] ?? 0, x.wristDeg[sd] ?? 0, x.rollDeg[sd] ?? 0, x.splitErr[sd]]),
    x.candy,
    x.weaponUp,
  ];
  let ref: THREE.Vector3[] | null = null;
  let refM: number[] | null = null;
  let boneMm = 0;
  let metric = 0;
  let where = '';
  for (let k = 0; k < 12; k++) {
    root.rotation.y = yaw0 + THREE.MathUtils.degToRad(k * 30);
    m.posed(0, false);
    const b = bonesC();
    const x = flat(measureMaster(s, false)!);
    if (!ref || !refM) {
      ref = b;
      refM = x;
      continue;
    }
    for (let i = 0; i < b.length; i++) boneMm = Math.max(boneMm, b[i].distanceTo(ref[i]) * 1000);
    for (let i = 0; i < x.length; i++) {
      // The weapon's up is a world measure: it turns with nothing here, it must hold too.
      const d = Math.abs(x[i] - refM[i]);
      if (d > metric) [metric, where] = [d, `#${i} at ${k * 30}°`];
    }
  }
  root.rotation.y = yaw0;
  m.posed(0, false);
  return { boneMm, metric, where };
}

/** The data the checks hold the hold to. */
export const CHECK_DATA = { twist: data.twist, stances: Object.keys(data.stances) };
