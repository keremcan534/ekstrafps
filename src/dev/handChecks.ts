import * as THREE from 'three';
import type { Viewmodel } from '../weapons/Viewmodel';
import { FINGER_NAMES, type FingerName, type HandPose } from '../weapons/HandPose';

/**
 * Measurements of the first-person hands against the weapon they hold (the calibration page
 * and the state checks): how far each finger is from the weapon's surface, how much glove is
 * inside it, and fitting a pose's fingers until they meet it. Everything is measured on the
 * real skinned glove and the weapon's own triangles, in the viewmodel's world.
 */
type Side = 'right' | 'left';

/** Grid cell (m): a query sees the surface within one cell. */
const CELL = 0.02;

/** The weapon's triangles in a uniform grid (world space), for near-surface queries. */
export class WeaponSurface {
  private cells = new Map<number, number[]>();
  /** Per triangle: a, b, c (9 floats) and its unit normal (3). */
  private tri: Float32Array;
  private stamp: Uint32Array;
  private pass = 0;
  readonly count: number;
  private t = new THREE.Triangle();
  private q = new THREE.Vector3();

  constructor(vm: Viewmodel) {
    const rig = vm.activeRig;
    vm.scene.updateMatrixWorld(true);
    const flat: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    rig?.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.gizmo || ([] as THREE.Material[]).concat(m.material).some((mt) => mt.transparent)) return;
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
      const pos = m.geometry.getAttribute('position');
      const idx = m.geometry.index;
      const len = idx ? idx.count : pos.count;
      for (let k = 0; k + 2 < len; k += 3) {
        a.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, idx ? idx.getX(k + 1) : k + 1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, idx ? idx.getX(k + 2) : k + 2).applyMatrix4(m.matrixWorld);
        THREE.Triangle.getNormal(a, b, c, n);
        if (n.lengthSq() < 0.5) continue;
        flat.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, n.x, n.y, n.z);
      }
    });
    this.tri = new Float32Array(flat);
    this.count = flat.length / 12;
    this.stamp = new Uint32Array(this.count);
    const T = this.tri;
    for (let i = 0; i < this.count; i++) {
      const o = i * 12;
      const x0 = Math.floor(Math.min(T[o], T[o + 3], T[o + 6]) / CELL), x1 = Math.floor(Math.max(T[o], T[o + 3], T[o + 6]) / CELL);
      const y0 = Math.floor(Math.min(T[o + 1], T[o + 4], T[o + 7]) / CELL), y1 = Math.floor(Math.max(T[o + 1], T[o + 4], T[o + 7]) / CELL);
      const z0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / CELL), z1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / CELL);
      // Anything longer than a metre (or not finite) is no part of a gun in the hands.
      if (!(x1 - x0 < 50 && y1 - y0 < 50 && z1 - z0 < 50)) continue;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const k = key(x, y, z);
            let cell = this.cells.get(k);
            if (!cell) this.cells.set(k, (cell = []));
            cell.push(i);
          }
    }
  }

  /**
   * Nearest surface point within one cell's reach (else null): its distance, and the signed
   * distance (negative behind the surface, by the triangle's normal).
   */
  nearest(p: THREE.Vector3): { d: number; signed: number } | null {
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cz = Math.floor(p.z / CELL);
    const T = this.tri;
    const pass = ++this.pass;
    let best = Infinity;
    let signed = 0;
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let z = cz - 1; z <= cz + 1; z++) {
          const cell = this.cells.get(key(x, y, z));
          if (!cell) continue;
          for (const i of cell) {
            if (this.stamp[i] === pass) continue;
            this.stamp[i] = pass;
            const o = i * 12;
            this.t.a.set(T[o], T[o + 1], T[o + 2]);
            this.t.b.set(T[o + 3], T[o + 4], T[o + 5]);
            this.t.c.set(T[o + 6], T[o + 7], T[o + 8]);
            this.t.closestPointToPoint(p, this.q);
            const d = this.q.distanceTo(p);
            if (d < best) {
              best = d;
              const side = (p.x - this.q.x) * T[o + 9] + (p.y - this.q.y) * T[o + 10] + (p.z - this.q.z) * T[o + 11];
              signed = side >= 0 ? d : -d;
            }
          }
        }
    return best === Infinity ? null : { d: best, signed };
  }
}

/** A grid cell's key (cells within ±2^20 of the origin). */
const key = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

/** A bone's segment (world): its head, and the next joint (or its own length along +Y). */
function segment(bone: THREE.Bone, a: THREE.Vector3, b: THREE.Vector3): void {
  bone.getWorldPosition(a);
  const child = bone.children.find((c) => (c as THREE.Bone).isBone);
  if (child) child.getWorldPosition(b);
  else b.set(0, (bone.userData.length as number) ?? 0.02, 0).applyMatrix4(bone.matrixWorld);
}

const radii = new WeakMap<THREE.SkinnedMesh, Map<string, number>>();

/**
 * Each finger bone's radius (m): the median distance of the glove it mostly moves from its
 * line, measured on the posed, skinned glove (the stored positions may be quantized).
 */
export function fingerRadii(vm: Viewmodel): Map<string, number> {
  const mesh = vm.arms.gloves;
  if (!mesh) return new Map();
  let out = radii.get(mesh);
  if (out) return out;
  out = new Map();
  vm.arms.group.updateMatrixWorld(true);
  const bones = mesh.skeleton.bones;
  const geo = mesh.geometry;
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const lists = bones.map(() => [] as number[]);
  const lines = bones.map((b) => {
    const a = new THREE.Vector3();
    const e = new THREE.Vector3();
    segment(b, a, e);
    return new THREE.Line3(a, e);
  });
  const v = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i < si.count; i += 3) {
    if (sw.getX(i) < 0.6) continue;
    const j = si.getX(i);
    if (!/(Thumb|Index|Middle|Ring|Pinky)0\d$/.test(bones[j].name)) continue;
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    lists[j].push(v.distanceTo(lines[j].closestPointToPoint(v, true, q)));
  }
  bones.forEach((bn, j) => {
    const l = lists[j].sort((x, y) => x - y);
    if (l.length) out!.set(bn.name, l[Math.floor(l.length / 2)]);
  });
  radii.set(mesh, out);
  return out;
}

/** Gap (m) between each joint's segment of a hand's fingers and the weapon's surface; negative: into it. */
export function fingerGaps(vm: Viewmodel, side: Side, surf: WeaponSurface): Record<FingerName, [number, number, number]> {
  const out = {} as Record<FingerName, [number, number, number]>;
  for (const f of FINGER_NAMES) out[f] = fingerGap(vm, side, f, surf);
  return out;
}

const ga = new THREE.Vector3();
const gb = new THREE.Vector3();
const gp = new THREE.Vector3();

/** One finger's gaps (m), base → tip joint. */
export function fingerGap(vm: Viewmodel, side: Side, f: FingerName, surf: WeaponSurface): [number, number, number] {
  const bones = vm.arms.bonesOf(side);
  const r = fingerRadii(vm);
  const out: [number, number, number] = [CELL, CELL, CELL];
  bones?.fingers[f].forEach((bone, j) => {
    segment(bone, ga, gb);
    const rad = r.get(bone.name) ?? 0.009;
    const len = ga.distanceTo(gb);
    let gap = CELL;
    for (const t of [0.15, 0.4, 0.65, 0.9]) {
      // The tip's rounded end: stop a radius short of the segment's end.
      gp.lerpVectors(ga, gb, j === 2 ? Math.min(t, 1 - rad / Math.max(len, 1e-4)) : t);
      // Unsigned: a gun's hollow parts (a handguard's shell) have walls on both sides.
      const n = surf.nearest(gp);
      if (n) gap = Math.min(gap, n.d - rad);
    }
    out[j] = gap;
  });
  return out;
}

/** Glove vertices of a hand behind the weapon's surface (inside it): how many, and the deepest (mm). */
export function gloveInside(vm: Viewmodel, side: Side, surf: WeaponSurface, every = 4): { count: number; maxMm: number; checked: number } {
  const mesh = vm.arms.gloves;
  if (!mesh) return { count: 0, maxMm: 0, checked: 0 };
  const prefix = side === 'right' ? 'Right' : 'Left';
  const bones = mesh.skeleton.bones;
  const mine = bones.map((b) => b.name.startsWith(prefix) && !/Arm$/.test(b.name));
  const si = mesh.geometry.getAttribute('skinIndex');
  const sw = mesh.geometry.getAttribute('skinWeight');
  const v = new THREE.Vector3();
  let count = 0;
  let max = 0;
  let checked = 0;
  for (let i = 0; i < si.count; i += every) {
    // Hand and fingers only (the forearm is a sleeve the weapon never reaches).
    if (!mine[si.getX(i)] || sw.getX(i) < 0.5) continue;
    checked++;
    mesh.getVertexPosition(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    const n = surf.nearest(v);
    // Clipping is shallow: deeper "inside" is a hollow part's far wall, not glove in metal.
    if (n && n.signed < -0.001 && n.d < 0.012) {
      count++;
      max = Math.max(max, n.d);
    }
  }
  return { count, maxMm: max * 1000, checked };
}

/** A fitted finger stays this far off the weapon's surface (m). */
const CLEARANCE = 0.0005;

/** Bend limits when fitting (deg): base, middle, tip joint. */
const FIT_MAX: Record<FingerName, [number, number, number]> = {
  thumb: [0, 75, 80],
  index: [95, 105, 80],
  middle: [95, 105, 80],
  ring: [95, 105, 80],
  pinky: [95, 105, 80],
};

/**
 * Close each listed finger of `pose` (worn by `side`) around the weapon, joint by joint from
 * the base, the way a hand closes: each joint bends from straight until its own segment
 * meets the weapon's surface (one already touching at the start may keep touching, but not
 * press further in). Closing from outside, a finger can't pass through a wall into a hollow
 * part. Spread and twist stay as they are; the thumb's base stays (set it by hand), and with
 * `keepBase` every finger's does (a trigger finger: its base set along the receiver).
 */
export function fitFingers(vm: Viewmodel, side: Side, pose: HandPose, fingers: readonly FingerName[], surf = new WeaponSurface(vm), keepBase = false): void {
  const bones = vm.arms.bonesOf(side);
  if (!bones) return;
  for (const f of fingers) {
    const first = f === 'thumb' || keepBase ? 1 : 0;
    for (let j = first; j < 3; j++) pose[f][j][0] = 0;
    for (let j = first; j < 3; j++) {
      vm.arms.poseHand(side, pose);
      const start = fingerGap(vm, side, f, surf)[j];
      let ok = 0;
      for (let c = 2; c <= FIT_MAX[f][j]; c += 2) {
        pose[f][j][0] = c;
        vm.arms.poseHand(side, pose);
        const g = fingerGap(vm, side, f, surf)[j];
        if (g < CLEARANCE && g < start - 0.001) break;
        ok = c;
      }
      pose[f][j][0] = ok;
    }
  }
  vm.arms.poseHand(side, pose);
}
