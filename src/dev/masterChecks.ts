import * as THREE from 'three';
import { DIGITS, SIDES, sided, type Digit, type MasterRig, type Side } from '../characters/master/MasterRig';
import type { RifleHold } from '../characters/master/RifleHold';
import { twistAboutY } from '../characters/master/TwistSolver';
import data from '../characters/master/masterRig.json';

/**
 * Acceptance checks of the master humanoid holding a rifle (master-lab.html). Every mode is posed
 * at its sample times and at every character world yaw 0 … 330° (30° steps); each check keeps its
 * worst value and where it happened. Measured on the posed skeleton, the CPU-skinned mesh (the
 * real vertices the GPU draws) and the weapon's own triangles.
 *
 *   palm        hand +Z against the weapon: right vs the socket's grip frame, left vs its target
 *   onTarget    each hand on its target (the right: the weapon where the stance put it)
 *   elbow       the elbow on its pole's side of the shoulder → wrist line, flexing the right way,
 *               within 5 … 150°
 *   wrist       hand vs forearm bend < 60°, hand roll |θ| < 120°
 *   twistSplit  ForearmTwist = α θ and UpperArmTwist = −β × the upper arm's roll (±0.5°)
 *   candy       skinned forearm cross-sections (mid, distal) and the shoulder's: hull area and
 *               perimeter vs rest ≥ 0.8
 *   stretch     |shoulder → wrist| ≤ upper + forearm + 1 mm
 *   weaponUp    the weapon's +Y · world up > 0.5
 *   grip        each wrapping finger's tip (its distal segment's skinned vertices) within 5 mm of
 *               the weapon's surface, palms on it, hands not deep inside it
 *   jumps       along the walk cycle and a 360° turn (frame to frame): hand turns < 30°, elbows
 *               move < 5 cm
 *   yaw         every metric and every bone (character space) the same at every yaw
 */
export interface CheckRow {
  check: string;
  pass: boolean;
  worst: number;
  unit: string;
  limit: string;
  where: string;
}

export interface ModeSpec {
  name: string;
  /** Sample times (s) along the clip. */
  times: number[];
  /** Frame-to-frame sequence: clip times and yaws (rad), or none. */
  sequence?: { t: number; yaw: number }[];
}

export interface CheckHost {
  rig: MasterRig;
  hold: RifleHold;
  /** Pose mode `name` at clip time `t` (s) and character yaw `yaw` (rad), matrices updated. */
  pose(name: string, t: number, yaw: number): void;
  /** The character's group (its world yaw). */
  character: THREE.Object3D;
}

export interface CheckReport {
  rows: CheckRow[];
  perMode: Record<string, CheckRow[]>;
  samples: number;
  ms: number;
  /** Fingertip gaps (mm) at yaw 0 per mode, side and digit (signed: − inside the weapon). */
  fingers: Record<string, Record<string, number>>;
}

export const YAWS = Array.from({ length: 12 }, (_, i) => i * 30);
const PALM_DEG = 5;
const ON_TARGET_MM = 2;
const WRIST_BEND = 60;
const HAND_TWIST = 120;
const FLEX = [5, 150];
const CANDY = 0.8;
const GRIP_MM = 5;
const THUMB_MM = 8;
const INSIDE_MM = -6;
const JUMP_DEG = 30;
const JUMP_ELBOW_M = 0.05;
const WRAP: Record<Side, Digit[]> = { R: ['Middle', 'Ring', 'Pinky'], L: ['Index', 'Middle', 'Ring', 'Pinky'] };

// --- The weapon's surface ------------------------------------------------------------------

const CELL = 10; // model units (≈ mm)

/** The weapon's triangles in its own model space, in a uniform grid, for nearest-point queries. */
export class GunSurface {
  private cells = new Map<number, number[]>();
  private tri: Float32Array;
  private stamp: Uint32Array;
  private pass = 0;
  private T = new THREE.Triangle();
  private q = new THREE.Vector3();

  /** `model`: the gun's meshes (static, in its model space under `root`). */
  constructor(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const flat: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Matrix4();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
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
    const T = this.tri;
    for (let i = 0; i < this.stamp.length; i++) {
      const o = i * 12;
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(T[o + k], T[o + 3 + k], T[o + 6 + k]) / CELL));
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(T[o + k], T[o + 3 + k], T[o + 6 + k]) / CELL));
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const k = key(x, y, z);
            let cell = this.cells.get(k);
            if (!cell) this.cells.set(k, (cell = []));
            cell.push(i);
          }
    }
  }

  /** Distance to the nearest triangle corner (model units), searching everything: for points far off. */
  far(p: THREE.Vector3): number {
    const T = this.tri;
    let best = Infinity;
    for (let o = 0; o < T.length; o += 12)
      for (let k = 0; k < 9; k += 3) {
        const d = (T[o + k] - p.x) ** 2 + (T[o + k + 1] - p.y) ** 2 + (T[o + k + 2] - p.z) ** 2;
        if (d < best) best = d;
      }
    return Math.sqrt(best);
  }

  /** Nearest surface point within `reach` cells of the model-space point `p`: signed distance (model units, − behind the surface). */
  nearest(p: THREE.Vector3, reach = 2): number {
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cz = Math.floor(p.z / CELL);
    const T = this.tri;
    const pass = ++this.pass;
    let best = Infinity;
    let signed = Infinity;
    for (let x = cx - reach; x <= cx + reach; x++)
      for (let y = cy - reach; y <= cy + reach; y++)
        for (let z = cz - reach; z <= cz + reach; z++) {
          const cell = this.cells.get(key(x, y, z));
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

const key = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

// --- Mesh probes (vertex sets chosen once, on the rest pose) ------------------------------------

interface Slab {
  label: string;
  side: Side;
  bone: THREE.Bone;
  verts: number[];
  restArea: number;
  restPerim: number;
}

export interface Probes {
  slabs: Slab[];
  /** Per side and digit: the distal segment's vertices. */
  tips: Record<Side, Record<Digit, number[]>>;
  /** Per side: palm-side vertices of the hand (the palm's contact). */
  palm: Record<Side, number[]>;
  /** Per side: every vertex the hand or its fingers move most. */
  hand: Record<Side, number[]>;
}

/** Choose the probe vertices on the rig in its rest pose (call before any animation). */
export function makeProbes(rig: MasterRig): Probes {
  const mesh = rig.mesh;
  rig.model.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const idx = (n: string) => bones.indexOf(rig.bone(n));
  const v = new THREE.Vector3();
  const n = si.count;
  const weightOf = (i: number, set: Set<number>) => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (set.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
    return w;
  };
  const dominant = (i: number) => {
    let best = -1, bj = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > best) [best, bj] = [w, si.getComponent(i, k)];
    }
    return bj;
  };
  const restPos = (i: number, out: THREE.Vector3) => mesh.getVertexPosition(i, out).applyMatrix4(mesh.matrixWorld);
  const slabs: Slab[] = [];
  const tips = { R: {}, L: {} } as Record<Side, Record<Digit, number[]>>;
  const palm = { R: [] as number[], L: [] as number[] };
  const hand = { R: [] as number[], L: [] as number[] };
  for (const s of SIDES) {
    const arm = rig.arms[s];
    // Forearm slabs (mid, distal), and the upper arm's near the shoulder.
    const forearmSet = new Set([idx(sided('Forearm', s)), idx(sided('ForearmTwist', s)), idx(sided('Hand', s))]);
    const upperSet = new Set([idx(sided('UpperArm', s)), idx(sided('UpperArmTwist', s)), idx(sided('Forearm', s))]);
    const seg = (b: THREE.Bone, len: number) => {
      const a = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      const e = new THREE.Vector3(0, len, 0).applyMatrix4(b.matrixWorld);
      return new THREE.Line3(a, e);
    };
    const specs: [string, THREE.Bone, number, number, Set<number>][] = [
      ['forearm 50%', arm.fore, arm.foreLen, 0.5, forearmSet],
      ['forearm 85%', arm.fore, arm.foreLen, 0.85, forearmSet],
      ['upper arm 25%', arm.upper, arm.upperLen, 0.25, upperSet],
    ];
    for (const [label, bone, len, f, set] of specs) {
      const line = seg(bone, len);
      const verts: number[] = [];
      for (let i = 0; i < n; i++) {
        if (weightOf(i, set) < 0.97) continue;
        restPos(i, v);
        const t = line.closestPointToPointParameter(v, false);
        if (Math.abs(t - f) * len > 0.012) continue;
        verts.push(i);
      }
      const slab: Slab = { label, side: s, bone, verts, restArea: 0, restPerim: 0 };
      const [area, perim] = section(rig, slab);
      slab.restArea = area;
      slab.restPerim = perim;
      slabs.push(slab);
    }
    // Fingers, palm, hand.
    const handIdx = idx(sided('Hand', s));
    const handBones = new Set([handIdx, ...arm.fingers.map((b) => bones.indexOf(b))]);
    const handInv = new THREE.Matrix4().copy(arm.hand.matrixWorld).invert();
    for (const d of DIGITS) {
      const tip = idx(sided(`${d}3`, s));
      tips[s][d] = [];
      for (let i = 0; i < n; i++) if (dominant(i) === tip && weightOf(i, new Set([tip])) > 0.5) tips[s][d].push(i);
    }
    for (let i = 0; i < n; i++) {
      const dj = dominant(i);
      if (!handBones.has(dj)) continue;
      hand[s].push(i);
      if (dj !== handIdx) continue;
      restPos(i, v).applyMatrix4(handInv);
      if (v.z > 0.008 && v.y > 0.03 && v.y < 0.095) palm[s].push(i);
    }
  }
  return { slabs, tips, palm, hand };
}

const sv = new THREE.Vector3();
const sm = new THREE.Matrix4();

/** A slab's skinned cross-section in its bone's frame: convex hull area (m²) and perimeter (m). */
function section(rig: MasterRig, slab: Slab): [number, number] {
  const mesh = rig.mesh;
  sm.copy(slab.bone.matrixWorld).invert();
  const pts: [number, number][] = [];
  for (const i of slab.verts) {
    mesh.getVertexPosition(i, sv).applyMatrix4(mesh.matrixWorld).applyMatrix4(sm);
    pts.push([sv.x, sv.z]);
  }
  return hull(pts);
}

/** Convex hull (monotone chain) area and perimeter of 2D points. */
function hull(p: [number, number][]): [number, number] {
  if (p.length < 3) return [0, 0];
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
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

// --- Measuring one pose ----------------------------------------------------------------------

/** One posed frame's numbers (the checks read these). */
export interface Measure {
  palmDeg: Record<Side, number>;
  handPosMm: Record<Side, number>;
  handRotDeg: Record<Side, number>;
  weaponPosMm: number;
  weaponRotDeg: number;
  elbowPoleDot: Record<Side, number>;
  flexDeg: Record<Side, number>;
  wristBendDeg: Record<Side, number>;
  handTwistDeg: Record<Side, number>;
  foreSplitErr: Record<Side, number>;
  upperSplitErr: Record<Side, number>;
  candy: { label: string; side: Side; area: number; perim: number }[];
  stretchMm: Record<Side, number>;
  weaponUp: number;
  tipMm: Record<Side, Record<Digit, number>>;
  palmMm: Record<Side, number>;
  insideMm: Record<Side, number>;
  /** Hand world orientations and elbow positions in character space (frame-to-frame checks). */
  handQ: Record<Side, THREE.Quaternion>;
  elbowC: Record<Side, THREE.Vector3>;
}

const r2d = THREE.MathUtils.radToDeg;
const tmp = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  d: new THREE.Vector3(),
  m: new THREE.Matrix4(),
  m2: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  s: new THREE.Vector3(),
  line: new THREE.Line3(),
};
const col = (m: THREE.Matrix4, i: number, out: THREE.Vector3) => out.setFromMatrixColumn(m, i).normalize();
const qp = new THREE.Vector3();
const qs = new THREE.Vector3();
/** A frame's rotation, normalised (clip keys are float32: an unnormalised pair reads ~0.02° apart through acos). */
const quatOf = (m: THREE.Matrix4, out: THREE.Quaternion) => (m.decompose(qp, out, qs), out.normalize());
/** A gap in mm (nothing found within reach: 99). */
const mm = (units: number, scaleMm: number) => (Number.isFinite(units) ? units * scaleMm : 99);

/** Measure the current pose (the hold already solved). */
export function measure(host: CheckHost, probes: Probes, gun: GunSurface): Measure {
  const { rig, hold } = host;
  const t = tmp;
  const mesh = rig.mesh;
  const weaponM = hold.weapon.matrixWorld;
  const weaponInv = t.m2.copy(weaponM).invert();
  const charInv = new THREE.Matrix4().copy(host.character.matrixWorld).invert();
  const out = {
    palmDeg: {}, handPosMm: {}, handRotDeg: {}, elbowPoleDot: {}, flexDeg: {}, wristBendDeg: {}, handTwistDeg: {}, foreSplitErr: {}, upperSplitErr: {},
    stretchMm: {}, tipMm: { R: {}, L: {} }, palmMm: {}, insideMm: {}, handQ: {}, elbowC: {}, candy: [],
  } as unknown as Measure;
  // The right hand's expected frame in weapon space: grip ⊗ socket⁻¹; the left's: its target.
  const sock = rig.arms.R.socket;
  hold.rightGrip.updateMatrix();
  const expR = new THREE.Matrix4().compose(sock.position, sock.quaternion, t.s.set(1, 1, 1)).invert().premultiply(hold.rightGrip.matrix);
  hold.leftGrip.updateMatrix();
  const expL = hold.leftGrip.matrix;
  for (const s of SIDES) {
    const arm = rig.arms[s];
    const exp = s === 'R' ? expR : expL;
    // Palm normal and hand frame in weapon space.
    const hw = t.m.multiplyMatrices(weaponInv, arm.hand.matrixWorld);
    out.palmDeg[s] = r2d(col(hw, 2, t.a).angleTo(col(exp, 2, t.b)));
    out.handRotDeg[s] = r2d(quatOf(hw, t.q).angleTo(quatOf(exp, t.q2)));
    // Position on target (world): right = its IK target, left = the grip node.
    const target = hold.targets[s];
    out.handPosMm[s] = t.a.setFromMatrixPosition(arm.hand.matrixWorld).distanceTo(t.b.setFromMatrixPosition(target)) * 1000;
    // Elbow: pole side, flexion.
    const S = t.a.setFromMatrixPosition(arm.upper.matrixWorld);
    const E = t.b.setFromMatrixPosition(arm.fore.matrixWorld);
    const Wr = t.c.setFromMatrixPosition(arm.hand.matrixWorld);
    t.line.set(S, Wr);
    const foot = t.line.closestPointToPoint(E, false, new THREE.Vector3());
    const off = new THREE.Vector3().subVectors(E, foot);
    const poleOff = new THREE.Vector3().subVectors(hold.poles[s], foot);
    const dir = new THREE.Vector3().subVectors(Wr, S).normalize();
    poleOff.addScaledVector(dir, -poleOff.dot(dir));
    out.elbowPoleDot[s] = off.lengthSq() > 1e-10 && poleOff.lengthSq() > 1e-10 ? off.normalize().dot(poleOff.normalize()) : 0;
    const yu = col(arm.upper.matrixWorld, 1, new THREE.Vector3());
    const yf = col(arm.fore.matrixWorld, 1, new THREE.Vector3());
    const zf = col(arm.fore.matrixWorld, 2, new THREE.Vector3()).multiplyScalar(s === 'R' ? -1 : 1);
    out.flexDeg[s] = r2d(Math.atan2(new THREE.Vector3().crossVectors(yu, yf).dot(zf), yu.dot(yf)));
    const yh = col(arm.hand.matrixWorld, 1, new THREE.Vector3());
    out.wristBendDeg[s] = r2d(yf.angleTo(yh));
    // Twist split.
    const restQ = (b: THREE.Bone) => rig.rest.get(b.name)!.quaternion;
    const handTw = twistAboutY(t.q.copy(restQ(arm.hand)).invert().multiply(arm.hand.quaternion));
    const foreTw = twistAboutY(t.q.copy(restQ(arm.foreTwist)).invert().multiply(arm.foreTwist.quaternion));
    const upTw = twistAboutY(t.q.copy(restQ(arm.upper)).invert().multiply(arm.upper.quaternion));
    const uatTw = twistAboutY(t.q.copy(restQ(arm.upperTwist)).invert().multiply(arm.upperTwist.quaternion));
    out.handTwistDeg[s] = r2d(handTw);
    out.foreSplitErr[s] = Math.abs(r2d(foreTw - hold.twist.alpha * handTw));
    out.upperSplitErr[s] = Math.abs(r2d(uatTw + hold.twist.beta * upTw));
    out.stretchMm[s] = (S.distanceTo(Wr) - (arm.upperLen + arm.foreLen)) * 1000;
    out.handQ[s] = quatOf(arm.hand.matrixWorld, new THREE.Quaternion());
    out.elbowC[s] = E.clone().applyMatrix4(charInv);
  }
  for (const slab of probes.slabs) {
    const [area, perim] = section(rig, slab);
    out.candy.push({ label: slab.label, side: slab.side, area: area / slab.restArea, perim: perim / slab.restPerim });
  }
  out.weaponUp = col(weaponM, 1, t.a).y;
  // Weapon where the stance wanted it.
  out.weaponPosMm = t.a.setFromMatrixPosition(weaponM).distanceTo(t.b.setFromMatrixPosition(hold.desired)) * 1000;
  out.weaponRotDeg = r2d(quatOf(weaponM, t.q).angleTo(quatOf(hold.desired, t.q2)));
  // Skinned hand vertices against the weapon (model units ≈ mm).
  const toModel = t.m.copy(hold.model.matrixWorld).invert().multiply(mesh.matrixWorld);
  const scaleMm = hold.def.scale * 1000;
  const v = t.d;
  for (const s of SIDES) {
    for (const d of DIGITS) {
      let best = Infinity;
      for (const i of probes.tips[s][d]) best = Math.min(best, gun.nearest(mesh.getVertexPosition(i, v).applyMatrix4(toModel), 3));
      out.tipMm[s][d] = mm(best, scaleMm);
    }
    let palm = Infinity;
    for (const i of probes.palm[s]) palm = Math.min(palm, gun.nearest(mesh.getVertexPosition(i, v).applyMatrix4(toModel), 3));
    out.palmMm[s] = mm(palm, scaleMm);
    let inside = Infinity;
    for (const i of probes.hand[s]) inside = Math.min(inside, gun.nearest(mesh.getVertexPosition(i, v).applyMatrix4(toModel), 1));
    out.insideMm[s] = mm(inside, scaleMm);
  }
  return out;
}

// --- Running everything ----------------------------------------------------------------------

class Worst {
  rows = new Map<string, CheckRow>();
  /** `bad`: larger is worse (true) or smaller is worse (false). */
  add(check: string, value: number, pass: boolean, unit: string, limit: string, where: string, largerWorse = true): void {
    const r = this.rows.get(check);
    const worse = !r || (largerWorse ? value > r.worst : value < r.worst);
    if (!r) this.rows.set(check, { check, pass, worst: value, unit, limit, where });
    else {
      r.pass &&= pass;
      if (worse) {
        r.worst = value;
        r.where = where;
      }
    }
  }
  list(): CheckRow[] {
    return [...this.rows.values()].map((r) => ({ ...r, worst: +r.worst.toFixed(3) }));
  }
}

/** Every check over every mode, sample time and yaw. Synchronous (a few seconds). */
export function runChecks(host: CheckHost, probes: Probes, gun: GunSurface, modes: ModeSpec[]): CheckReport {
  const t0 = performance.now();
  const all = new Worst();
  const perMode: Record<string, CheckRow[]> = {};
  const fingers: CheckReport['fingers'] = {};
  let samples = 0;
  const flatNames = [
    ...SIDES.flatMap((s) => ['palm', 'handPos', 'handRot', 'elbowPole', 'flex', 'wristBend', 'handTwist', 'stretch', 'palmGap', 'inside', ...DIGITS.map((d) => `tip.${d}`)].map((n) => `${s}.${n}`)),
    ...probes.slabs.flatMap((sl) => [`${sl.side} ${sl.label} area`, `${sl.side} ${sl.label} perim`]),
    'weaponUp',
    'weaponPos',
    'weaponRot',
  ];
  const flat = (m: Measure): number[] => [
    ...SIDES.flatMap((s) => [m.palmDeg[s], m.handPosMm[s], m.handRotDeg[s], m.elbowPoleDot[s], m.flexDeg[s], m.wristBendDeg[s], m.handTwistDeg[s], m.stretchMm[s], m.palmMm[s], m.insideMm[s], ...DIGITS.map((d) => m.tipMm[s][d])]),
    ...m.candy.flatMap((c) => [c.area, c.perim]),
    m.weaponUp,
    m.weaponPosMm,
    m.weaponRotDeg,
  ];
  const bonesC = (): number[] => {
    const inv = new THREE.Matrix4().copy(host.character.matrixWorld).invert();
    const out: number[] = [];
    const p = new THREE.Vector3();
    for (const b of host.rig.mesh.skeleton.bones) out.push(...p.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv).toArray());
    out.push(...p.setFromMatrixPosition(host.hold.weapon.matrixWorld).applyMatrix4(inv).toArray());
    return out;
  };
  for (const mode of modes) {
    const w = new Worst();
    const both = (check: string, value: number, pass: boolean, unit: string, limit: string, where: string, largerWorse = true) => {
      w.add(check, value, pass, unit, limit, where, largerWorse);
      all.add(check, value, pass, unit, limit, `${mode.name} ${where}`, largerWorse);
    };
    let yawDiff = 0;
    let boneDiff = 0;
    let yawWhere = '';
    for (const time of mode.times) {
      let ref: number[] | null = null;
      let refB: number[] | null = null;
      for (const yawDeg of YAWS) {
        host.pose(mode.name, time, THREE.MathUtils.degToRad(yawDeg));
        const m = measure(host, probes, gun);
        samples++;
        const at = `t=${time.toFixed(2)} yaw=${yawDeg}`;
        if (yawDeg === 0 && time === mode.times[0]) fingers[mode.name] = Object.fromEntries(SIDES.flatMap((s) => [...DIGITS.map((d) => [`${s}.${d}`, +m.tipMm[s][d].toFixed(1)]), [`${s}.palm`, +m.palmMm[s].toFixed(1)], [`${s}.inside`, +m.insideMm[s].toFixed(1)]]));
        for (const s of SIDES) {
          const where = `${s} ${at}`;
          both('palm', m.palmDeg[s], m.palmDeg[s] < PALM_DEG, '°', `< ${PALM_DEG}°`, where);
          both('hand rotation on target', m.handRotDeg[s], m.handRotDeg[s] < 0.5, '°', '< 0.5°', where);
          both('hand on target', m.handPosMm[s], m.handPosMm[s] < ON_TARGET_MM, 'mm', `< ${ON_TARGET_MM} mm`, where);
          both('elbow on pole side', m.elbowPoleDot[s], m.elbowPoleDot[s] > 0.5, 'cos', '> 0.5', where, false);
          both('elbow flexion', m.flexDeg[s], m.flexDeg[s] >= FLEX[0] && m.flexDeg[s] <= FLEX[1], '°', `${FLEX[0]} … ${FLEX[1]}°`, where);
          both('elbow flexion (min)', m.flexDeg[s], m.flexDeg[s] >= FLEX[0], '°', `≥ ${FLEX[0]}° (never backwards)`, where, false);
          both('wrist bend', m.wristBendDeg[s], m.wristBendDeg[s] < WRIST_BEND, '°', `< ${WRIST_BEND}°`, where);
          both('hand roll', Math.abs(m.handTwistDeg[s]), Math.abs(m.handTwistDeg[s]) < HAND_TWIST, '°', `|θ| < ${HAND_TWIST}°`, where);
          both('twist split', Math.max(m.foreSplitErr[s], m.upperSplitErr[s]), Math.max(m.foreSplitErr[s], m.upperSplitErr[s]) < 0.5, '°', '< 0.5° from α θ, −β φ', where);
          both('arm stretch', m.stretchMm[s], m.stretchMm[s] <= 1, 'mm', '≤ +1 mm', where);
          for (const d of WRAP[s]) both('finger grip', Math.abs(m.tipMm[s][d]), Math.abs(m.tipMm[s][d]) < GRIP_MM, 'mm', `|gap| < ${GRIP_MM} mm`, `${s}.${d} ${at}`);
          both('thumb on weapon', Math.abs(m.tipMm[s].Thumb), Math.abs(m.tipMm[s].Thumb) < THUMB_MM, 'mm', `|gap| < ${THUMB_MM} mm`, where);
          both('palm on weapon', m.palmMm[s], m.palmMm[s] < GRIP_MM, 'mm', `< ${GRIP_MM} mm`, where);
          both('hand inside weapon', m.insideMm[s], m.insideMm[s] > INSIDE_MM, 'mm', `> ${INSIDE_MM} mm`, where, false);
        }
        for (const c of m.candy) {
          const r = Math.min(c.area, c.perim);
          both('candy-wrap section', r, r >= CANDY, 'ratio', `≥ ${CANDY}`, `${c.side} ${c.label} ${at}`, false);
        }
        both('weapon up', m.weaponUp, m.weaponUp > 0.5, 'dot', '> 0.5', at, false);
        both('weapon where the stance put it', m.weaponPosMm, m.weaponPosMm < ON_TARGET_MM, 'mm', `< ${ON_TARGET_MM} mm`, at);
        // Same result at every yaw.
        const f = flat(m);
        const bc = bonesC();
        if (!ref || !refB) {
          ref = f;
          refB = bc;
        } else {
          for (let i = 0; i < f.length; i++) {
            const dv = Math.abs(f[i] - ref[i]);
            if (dv > yawDiff) [yawDiff, yawWhere] = [dv, `${flatNames[i]} ${at}`];
          }
          for (let i = 0; i < bc.length; i++) boneDiff = Math.max(boneDiff, Math.abs(bc[i] - refB[i]) * 1000);
        }
      }
    }
    both('yaw invariance (metrics)', yawDiff, yawDiff < 1e-3, 'abs', '< 0.001', yawWhere);
    both('yaw invariance (bones)', boneDiff, boneDiff < 1e-3, 'mm', '< 0.001 mm', '');
    // Frame to frame.
    if (mode.sequence) {
      let prev: Measure | null = null;
      let worstTurn = 0;
      let worstMove = 0;
      let at = '';
      for (const f of mode.sequence) {
        host.pose(mode.name, f.t, f.yaw);
        const m = measure(host, probes, gun);
        samples++;
        if (prev) {
          for (const s of SIDES) {
            const turn = r2d(m.handQ[s].normalize().angleTo(prev.handQ[s].normalize()));
            const move = m.elbowC[s].distanceTo(prev.elbowC[s]);
            if (turn > worstTurn) [worstTurn, at] = [turn, `${s} t=${f.t.toFixed(3)} yaw=${r2d(f.yaw).toFixed(0)}`];
            worstMove = Math.max(worstMove, move);
          }
        }
        prev = m;
      }
      both('frame-to-frame hand turn', worstTurn, worstTurn < JUMP_DEG, '°', `< ${JUMP_DEG}°`, at);
      both('frame-to-frame elbow move', worstMove * 100, worstMove < JUMP_ELBOW_M, 'cm', `< ${JUMP_ELBOW_M * 100} cm`, at);
    }
    perMode[mode.name] = w.list();
  }
  return { rows: all.list(), perMode, samples, ms: Math.round(performance.now() - t0), fingers };
}

/** The data the checks hold the hold to (for the report). */
export const CHECK_DATA = { alpha: data.twist.forearm, beta: data.twist.upperArm };
