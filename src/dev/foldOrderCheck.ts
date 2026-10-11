import * as THREE from 'three';
import { materialId, type RoomFold } from '../world/MaterialFold';
import type { Site9 } from '../world/Site9';

/**
 * Dev check for world/MaterialFold (?foldcheck): does every coplanar depth tie still go the
 * way it went before the fold?
 *
 * Site-9's overlays win their ties with what they sit on only by draw order: three draws
 * opaque materials in id order and the later draw wins an exact tie (LessEqual); inside one
 * draw, the later triangle wins. For every pair of overlapping, same-facing, coplanar opaque
 * triangles of different meshes in a room (faces nobody can see left out: under the floor,
 * inside a wall skin, inside the ceiling slab), this works out who won before the fold
 * (material id, then triangle order within the same original mesh) and who wins now (host
 * id, then triangle order within the same draw). A tie that was decided before must be
 * decided the same way now; one between two meshes of the same material was decided by
 * distance before and still is, so it doesn't count. Run for both shadow states (the fold
 * draws differently in each).
 */

interface Key {
  /** Material id (before: the triangle's own material; now: what draws it). */
  mat: number;
  /** The mesh that draws it (before: the builder mesh or object it came from). */
  mesh: string;
  /** Its place in that mesh's draw. */
  order: number;
}

interface Tri {
  p: THREE.Vector2[];
  n: THREE.Vector3;
  d: number;
  mesh: THREE.Mesh;
  before: Key;
  now: Key;
  what: string;
}

export interface FoldOrderReport {
  shadows: boolean;
  /** Tie pairs found (triangle pairs). */
  ties: number;
  /** Ties between two meshes of one material: decided by distance, before and now. */
  undecided: number;
  /** Ties that change hands (or are no longer decided): must be 0. */
  violations: number;
  /** Violations by room and material pair. */
  byPair: Record<string, number>;
}

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();

/** A material for the log: name, else type, colour and id. */
function label(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  if (m.name) return `${m.name}(${materialId(m)})`;
  const col = s.color ? '#' + s.color.getHexString() : '';
  const em = s.emissive && s.emissive.getHex() ? ' glow#' + s.emissive.getHexString() : '';
  const tex = s.map ? ' tex' : '';
  return `${m.type.replace('Mesh', '').replace('Material', '')}${col}${em}${tex}(${materialId(m)})`;
}

/** Is the mesh drawn in this shadow state (its own and its parents' flags; room and portal visibility aside)? */
function drawn(mesh: THREE.Mesh, top: THREE.Object3D, shadows: boolean): boolean {
  const mode = mesh.userData.foldMode as number | undefined;
  if (mode !== undefined && mode !== 0 && (mode === 2) !== shadows) return false;
  if (mesh.userData.folded && !shadows) return false;
  for (let p: THREE.Object3D | null = mesh; p && p !== top; p = p.parent) {
    // Fold meshes and folded pieces: their own flag is the shadow state's, judged above.
    // Shared pieces: theirs follows the rooms in view (the room being checked is).
    if (p === mesh && (mode !== undefined || mesh.userData.folded)) continue;
    if (p.userData.shared) continue;
    if (!p.visible) return false;
  }
  return true;
}

function trianglesOf(mesh: THREE.Mesh, room: { def: { rect: number[]; h: number; sky?: boolean; skylight?: boolean } }, out: Tri[]): void {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = (idx ? idx.count : pos.count) / 3;
  const fold = mesh.userData.fold as RoomFold | undefined;
  const leak = (mesh.userData.leak as string | undefined) ?? '';
  const [rx0, rz0, rx1, rz1] = room.def.rect;
  const H = room.def.h;
  const open = room.def.sky || room.def.skylight;
  mesh.updateMatrixWorld(true);
  const mat = mesh.material as THREE.Material;
  for (let t = 0; t < n; t++) {
    const a = idx ? idx.getX(3 * t) : 3 * t;
    const b = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    v0.fromBufferAttribute(pos, a).applyMatrix4(mesh.matrixWorld);
    v1.fromBufferAttribute(pos, b).applyMatrix4(mesh.matrixWorld);
    v2.fromBufferAttribute(pos, c).applyMatrix4(mesh.matrixWorld);
    e1.subVectors(v1, v0);
    e2.subVectors(v2, v0);
    const nn = new THREE.Vector3().crossVectors(e1, e2);
    const area = nn.length() / 2;
    if (area < 1e-7) continue;
    nn.normalize();
    const cx = (v0.x + v1.x + v2.x) / 3;
    const cy = (v0.y + v1.y + v2.y) / 3;
    const cz = (v0.z + v1.z + v2.z) / 3;
    // Faces nobody sees: facing down at floor level, inside the wall skins (0.15 m), inside the ceiling slab.
    if (nn.y < -0.5 && cy < 0.03) continue;
    if (cx < rx0 + 0.149 || cx > rx1 - 0.149 || cz < rz0 + 0.149 || cz > rz1 - 0.149) continue;
    if (cy > H - 0.001 && nn.y > 0.5 && !open) continue;
    const ax = Math.abs(nn.x);
    const ay = Math.abs(nn.y);
    const az = Math.abs(nn.z);
    const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const p = [v0, v1, v2].map((v) => (drop === 0 ? new THREE.Vector2(v.y, v.z) : drop === 1 ? new THREE.Vector2(v.x, v.z) : new THREE.Vector2(v.x, v.y)));
    const now: Key = { mat: materialId(mat), mesh: `m${mesh.id}`, order: t };
    let before = now;
    let what = label(mat);
    if (fold) {
      const run = fold.runAt(a);
      if (!run) continue;
      before = { mat: materialId(run.mat), mesh: `${fold.parent.id}|${run.src}|${materialId(run.mat)}|${leak}`, order: a };
      what = `${label(run.mat)}[${run.src}]`;
    }
    out.push({ p, n: nn, d: nn.dot(v0), mesh, before, now, what });
  }
}

function separated(A: THREE.Vector2[], B: THREE.Vector2[]): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const a = P[i];
      const b = P[(i + 1) % 3];
      const ax = -(b.y - a.y);
      const ay = b.x - a.x;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const q of A) {
        const s = q.x * ax + q.y * ay;
        amin = Math.min(amin, s);
        amax = Math.max(amax, s);
      }
      for (const q of B) {
        const s = q.x * ax + q.y * ay;
        bmin = Math.min(bmin, s);
        bmax = Math.max(bmax, s);
      }
      const len = Math.hypot(ax, ay) || 1;
      if (amax <= bmin + 1e-5 * len || bmax <= amin + 1e-5 * len) return true;
    }
  }
  return false;
}

/** Who draws later (wins an exact tie): 1 = a, -1 = b, 0 = not decided by order. */
function winner(a: Key, b: Key): number {
  if (a.mat !== b.mat) return a.mat > b.mat ? 1 : -1;
  if (a.mesh !== b.mesh) return 0;
  return a.order > b.order ? 1 : a.order < b.order ? -1 : 0;
}

export function foldOrderCheck(site: Site9, shadows: boolean): FoldOrderReport {
  const report: FoldOrderReport = { shadows, ties: 0, undecided: 0, violations: 0, byPair: {} };
  const shared = site.foldView.shared;
  for (const [id, room] of site.layout.rooms) {
    const tris: Tri[] = [];
    const meshes: THREE.Mesh[] = [];
    room.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material) && !(m.material as THREE.Material).transparent && drawn(m, room.group, shadows)) meshes.push(m);
    });
    for (const s of shared) {
      if (!s.rooms.includes(id)) continue;
      s.mesh.userData.shared = true;
      s.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material) || (m.material as THREE.Material).transparent) return;
        if (drawn(m, s.mesh.parent ?? s.mesh, shadows)) meshes.push(m);
      });
      delete s.mesh.userData.shared;
    }
    for (const m of meshes) trianglesOf(m, room, tris);
    const buckets = new Map<string, Tri[]>();
    for (const t of tris) {
      const key = `${Math.round(t.n.x * 200)},${Math.round(t.n.y * 200)},${Math.round(t.n.z * 200)}|${Math.round(t.d * 2000)}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(t);
    }
    for (const [key, list] of buckets) {
      // The neighbouring distance bucket too (tolerance ~0.5 mm).
      const [nk, dk] = key.split('|');
      const cands = list.concat(buckets.get(`${nk}|${+dk + 1}`) ?? []);
      if (cands.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        const A = list[i];
        let aminx = Infinity, amaxx = -Infinity, aminy = Infinity, amaxy = -Infinity;
        for (const q of A.p) {
          aminx = Math.min(aminx, q.x);
          amaxx = Math.max(amaxx, q.x);
          aminy = Math.min(aminy, q.y);
          amaxy = Math.max(amaxy, q.y);
        }
        for (let j = i + 1; j < cands.length; j++) {
          const B = cands[j];
          if (B.mesh === A.mesh && B.before.mesh === A.before.mesh) continue;
          if (Math.abs(A.d - B.d) > 2e-4 || A.n.dot(B.n) < 0.9999) continue;
          let bminx = Infinity, bmaxx = -Infinity, bminy = Infinity, bmaxy = -Infinity;
          for (const q of B.p) {
            bminx = Math.min(bminx, q.x);
            bmaxx = Math.max(bmaxx, q.x);
            bminy = Math.min(bminy, q.y);
            bmaxy = Math.max(bmaxy, q.y);
          }
          if (bmaxx <= aminx || bminx >= amaxx || bmaxy <= aminy || bminy >= amaxy) continue;
          if (separated(A.p, B.p)) continue;
          report.ties++;
          const was = winner(A.before, B.before);
          if (was === 0) {
            report.undecided++;
            continue;
          }
          if (winner(A.now, B.now) === was) continue;
          report.violations++;
          const [lo, hi] = was > 0 ? [B, A] : [A, B];
          const k = `${id}: ${lo.what} < ${hi.what}`;
          report.byPair[k] = (report.byPair[k] ?? 0) + 1;
        }
      }
    }
  }
  return report;
}

/** ?foldcheck: both shadow states, logged. */
export function logFoldOrder(site: Site9): FoldOrderReport[] {
  const out = [false, true].map((s) => foldOrderCheck(site, s));
  for (const r of out) {
    const head = `foldOrderCheck (${r.shadows ? 'shadow map' : 'no shadow map'}): ${r.ties} tie pairs, ${r.undecided} decided by distance, ${r.violations} changed hands`;
    if (r.violations) console.error(head, r.byPair);
    else console.info(head);
  }
  return out;
}
