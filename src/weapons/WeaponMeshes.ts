import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelKey } from './WeaponData';
import type { WeaponRig } from './WeaponModels';

/**
 * Real weapon meshes, packed by scripts/pack-weapon.mjs: public/guns/fp/<key>.glb for the
 * gun in your hands (hand-made models, e.g. Sketchfab, kept as made: AI-generated meshes
 * melt at a hand's width from the eye, so a gun without one stays procedural there), and
 * public/guns/m/<key>.glb for every third-person gun and wall buy (Meshy is fine at range). They are dressed onto the procedural rigs, which keep doing the
 * work (muzzle, sights, hands, recoil pivot, animations):
 *
 * - The model is turned and scaled onto the procedural gun by matching their side
 *   silhouettes (whichever end is the muzzle, whatever units it came in).
 * - Its triangles inside the procedural magazine / slide / bolt / pump are cut out and
 *   handed to those moving nodes, so reloads and cycling still move the right piece.
 * - The procedural parts go (optics too), except the hands and the round held for
 *   loading. Aimed, the eye sits just over the model's highest point along the barrel,
 *   so the gun never covers what you are aiming at.
 *
 * A gun without a file keeps its procedural model. `?gunmodel=ak47=guns/x.glb,...`
 * swaps in other files (testing an import).
 */

type Tier = 'view' | 'world';

interface GunSource {
  /** Non-indexed; attribute `mat` holds each vertex's index into `materials`. */
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

const sources = new Map<string, GunSource>();
/** Fitted root-space transform per `${key}|${tier}` (each file has its own coordinates). */
const fits = new Map<string, THREE.Matrix4 | null>();

/** Models the fit turns the wrong way round (a stock thinner than the barrel). */
const FLIP: Record<string, boolean> = { 'm249|world': true };

const KEYS: ModelKey[] = ['ak47', 'mk47', 'asval', 'm4a1', 'rd704', 'ppsh', 'mosin', 'kar98', 'pistol', 'shotgun', 'mp5', 'glock', 'saiga', 'svd', 'm249', 'scarh'];

/** Float copies of position / normal / uv (quantized files come as normalized integers), non-indexed. */
function floatGeometry(src: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  let g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(matrix);
  if (g.index) g = g.toNonIndexed();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/**
 * A skinned mesh as it stands (positions and normals through its bones, then into world
 * space): Sketchfab first-person packs come rigged, and quantized skinned files keep their
 * scale in the bind matrices, not the node.
 */
function skinnedGeometry(m: THREE.SkinnedMesh): THREE.BufferGeometry {
  const g = floatGeometry(m.geometry, new THREE.Matrix4());
  const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  const si = src.getAttribute('skinIndex');
  const sw = src.getAttribute('skinWeight');
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const sk = m.skeleton;
  const bones = sk.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, sk.boneInverses[i]));
  const pre = m.bindMatrix;
  const post = new THREE.Matrix4().multiplyMatrices(m.matrixWorld, m.bindMatrixInverse);
  const blend = new THREE.Matrix4();
  const full = new THREE.Matrix4();
  const n3 = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    blend.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const b = bones[si.getComponent(i, k)].elements;
      for (let e = 0; e < 16; e++) blend.elements[e] += b[e] * w;
    }
    full.multiplyMatrices(post, blend).multiply(pre);
    v.fromBufferAttribute(pos, i).applyMatrix4(full);
    pos.setXYZ(i, v.x, v.y, v.z);
    if (nor) {
      v.fromBufferAttribute(nor, i).applyMatrix3(n3.getNormalMatrix(full)).normalize();
      nor.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return g;
}

/**
 * First-person packs often ship arms, gloves, a crosshair or a pose dummy with the gun:
 * not ours (the rig has its own hands).
 */
const NOT_GUN = /glove|sleeve|\barms?\b|\bhands?\b|finger|crosshair|shape_?pose/i;

function notGun(m: THREE.Mesh): boolean {
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  for (let o: THREE.Object3D | null = m; o; o = o.parent) if (NOT_GUN.test(o.name)) return true;
  return mats.every((mt) => NOT_GUN.test(mt.name));
}

/** `meshy`: an AI model (glossy finish to tone down). */
async function loadOne(url: string, meshy: boolean): Promise<GunSource | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || notGun(m)) return;
      const mt = Array.isArray(m.material) ? m.material[0] : m.material;
      let idx = materials.indexOf(mt);
      if (idx < 0) idx = materials.push(mt) - 1;
      const g = (m as THREE.SkinnedMesh).isSkinnedMesh ? skinnedGeometry(m as THREE.SkinnedMesh) : floatGeometry(m.geometry, m.matrixWorld);
      g.setAttribute('mat', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(idx), 1));
      geos.push(g);
    });
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geometry || !materials.length) return null;
    for (const m of materials) {
      const mt = m as THREE.MeshStandardMaterial;
      mt.side = THREE.FrontSide;
      // Meshy finishes come out glossy (roughness ~0.35): in the first-person room light a
      // black polymer frame reads as polished silver. A touch more satin.
      if (meshy) mt.roughness = 1.3;
      // Seen along the top at a grazing angle: without anisotropic filtering the textures
      // smear into mud a hand's width from the eye.
      for (const t of [mt.map, mt.normalMap, mt.roughnessMap, mt.metalnessMap, mt.aoMap]) if (t) t.anisotropy = 8;
      // Meshy bakes a little light into "emissive": none on a gun.
      if (meshy && mt.emissiveMap) {
        mt.emissiveMap = null;
        mt.emissive.setRGB(0, 0, 0);
      }
    }
    return { geometry, materials };
  } catch {
    return null;
  }
}

/** Load every weapon model there is (missing ones are skipped). Never rejects. */
export async function loadWeaponMeshes(): Promise<void> {
  const override = new Map<string, string>();
  for (const pair of (new URLSearchParams(location.search).get('gunmodel') ?? '').split(',')) {
    const [k, url] = pair.split('=');
    if (k && url) override.set(k, url);
  }
  // The gun in your hands is the full model on phones too; others carry the light one.
  const tiers: Tier[] = ['view', 'world'];
  await Promise.all(
    KEYS.flatMap((k) =>
      tiers.map(async (tier) => {
        const url = override.get(k) ?? `${tier === 'view' ? 'guns/fp' : 'guns/m'}/${k}.glb`;
        const s = await loadOne(url, tier === 'world');
        if (s) sources.set(`${k}|${tier}`, s);
      }),
    ),
  );
}

// ------------------------------------------------------------------ fitting

/** Side silhouette grid (z across, y up), CELL metres a cell. */
const CELL = 0.006;

interface Grid {
  z0: number;
  y0: number;
  w: number;
  h: number;
  cells: Uint8Array;
}

function rasterize(tris: Float32Array, grid: Grid, m: THREE.Matrix4 | null): void {
  const e = m?.elements;
  const { z0, y0, w, h, cells } = grid;
  const P = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < tris.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const x = tris[t + v * 3];
      const y = tris[t + v * 3 + 1];
      const z = tris[t + v * 3 + 2];
      const wy = e ? e[1] * x + e[5] * y + e[9] * z + e[13] : y;
      const wz = e ? e[2] * x + e[6] * y + e[10] * z + e[14] : z;
      P[v * 2] = (wz - z0) / CELL;
      P[v * 2 + 1] = (wy - y0) / CELL;
    }
    const [ax, ay, bx, by, cx, cy] = P;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) {
      // Edge-on: mark the cells it passes through.
      for (const [px, py] of [[ax, ay], [bx, by], [cx, cy]]) {
        const ix = Math.floor(px), iy = Math.floor(py);
        if (ix >= 0 && iy >= 0 && ix < w && iy < h) cells[iy * w + ix] = 1;
      }
      continue;
    }
    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const px = ix + 0.5, py = iy + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -0.15 && w1 >= -0.15 && w2 >= -0.15) cells[iy * w + ix] = 1;
      }
    }
  }
}

/** Overlap of two silhouettes, `b` shifted by (dx, dy) cells. */
function iou(a: Grid, b: Grid, dx: number, dy: number): number {
  let both = 0, either = 0;
  const { w, h } = a;
  for (let y = 0; y < h; y++) {
    const by = y - dy;
    for (let x = 0; x < w; x++) {
      const av = a.cells[y * w + x];
      const bx = x - dx;
      const bv = bx >= 0 && by >= 0 && bx < w && by < h ? b.cells[by * w + bx] : 0;
      if (av && bv) both++;
      if (av || bv) either++;
    }
  }
  return either ? both / either : 0;
}

/** Triangles (flat xyz array) of every mesh under `root` that passes `keep`, in root space. */
function trianglesOf(root: THREE.Object3D, keep: (m: THREE.Mesh) => boolean): Float32Array {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out: number[] = [];
  const m4 = new THREE.Matrix4();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !keep(m)) return;
    m4.multiplyMatrices(inv, m.matrixWorld);
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m4);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

function boundsOf(tris: Float32Array): THREE.Box3 {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 3) b.expandByPoint(v.set(tris[i], tris[i + 1], tris[i + 2]));
  return b;
}

/**
 * Root-space transform that lays the model over the procedural gun: its longest axis
 * along the bore, the next one up, scaled to the same length; then the turn (muzzle
 * either way, either side up) and a small scale / offset search that best matches
 * the two side silhouettes.
 */
function fit(ref: Float32Array, model: Float32Array, flip = false): THREE.Matrix4 {
  // A model posed at an angle (first-person packs hold the gun canted): turn it square
  // onto its principal axes first, then fit as usual with a little pitch search.
  const P = principalFrame(model);
  if (!P) return fitSquare(ref, model, flip, [0]);
  const turned = new Float32Array(model.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < model.length; i += 3) v.set(model[i], model[i + 1], model[i + 2]).applyMatrix4(P).toArray(turned, i);
  return fitSquare(ref, turned, flip, [-6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6]).multiply(P);
}

/**
 * Rotation onto the model's principal axes (largest spread first → x, y, z), or null
 * when they already run along the file's own axes (within 4°): most models are square.
 */
function principalFrame(model: Float32Array): THREE.Matrix4 | null {
  const n = model.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < model.length; i += 3) for (let k = 0; k < 3; k++) mean[k] += model[i + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < model.length; i += 3) {
    const d = [model[i] - mean[0], model[i + 1] - mean[1], model[i + 2] - mean[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (d[a] * d[b]) / n;
  }
  // Jacobi rotations: V's columns become the eigenvectors.
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 20; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(C[p][q]) < 1e-12) continue;
      const th = 0.5 * Math.atan2(2 * C[p][q], C[q][q] - C[p][p]);
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) {
        const kp = C[k][p], kq = C[k][q];
        C[k][p] = c * kp - s * kq;
        C[k][q] = s * kp + c * kq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = C[p][k], qk = C[q][k];
        C[p][k] = c * pk - s * qk;
        C[q][k] = s * pk + c * qk;
      }
      for (let k = 0; k < 3; k++) {
        const kp = V[k][p], kq = V[k][q];
        V[k][p] = c * kp - s * kq;
        V[k][q] = s * kp + c * kq;
      }
    }
  }
  const order = [0, 1, 2].sort((a, b) => C[b][b] - C[a][a]);
  const ax = order.map((j) => new THREE.Vector3(V[0][j], V[1][j], V[2][j]).normalize());
  const square = ax.every((a) => Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)) > Math.cos((4 * Math.PI) / 180));
  if (square) return null;
  const z = new THREE.Vector3().crossVectors(ax[0], ax[1]);
  return new THREE.Matrix4().set(ax[0].x, ax[0].y, ax[0].z, 0, ax[1].x, ax[1].y, ax[1].z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
}

/** fit() for a model square to its axes; `pitches` (degrees) are also tried, best first pass refined. */
function fitSquare(ref: Float32Array, model: Float32Array, flip: boolean, pitches: number[]): THREE.Matrix4 {
  const rb = boundsOf(ref);
  const mb = boundsOf(model);
  const ms = mb.getSize(new THREE.Vector3());
  const mc = mb.getCenter(new THREE.Vector3());
  const axes = [0, 1, 2].sort((a, b) => ms.getComponent(b) - ms.getComponent(a));
  const [L, H] = axes;
  const unit = (i: number, s: number) => new THREE.Vector3().setComponent(i, s);
  const len = rb.max.z - rb.min.z;
  const rc = rb.getCenter(new THREE.Vector3());
  const pad = 0.08;
  const grid = (): Grid => {
    const w = Math.ceil((len + 2 * pad) / CELL);
    const h = Math.ceil((rb.max.y - rb.min.y + 2 * pad + 0.1) / CELL);
    return { z0: rb.min.z - pad, y0: rb.min.y - pad - 0.05, w, h, cells: new Uint8Array(w * h) };
  };
  const refGrid = grid();
  rasterize(ref, refGrid, null);
  // The muzzle is the thin end (a barrel), the stock or grip end is tall: that decides
  // which way round it goes, the silhouettes decide which side is up.
  const span = (lo: number, hi: number) => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < model.length; i += 3) {
      const l = model[i + L];
      if (l < lo || l > hi) continue;
      min = Math.min(min, model[i + H]);
      max = Math.max(max, model[i + H]);
    }
    return max - min;
  };
  const end = ms.getComponent(L) * 0.12;
  const thinAtMax = span(mb.max.getComponent(L) - end, Infinity) < span(-Infinity, mb.min.getComponent(L) + end);
  const sl = thinAtMax !== flip ? -1 : 1;
  let best = { score: -1, m: new THREE.Matrix4(), place: (_deg: number) => new THREE.Matrix4() };
  {
    for (const sh of [1, -1]) {
      // Source axis L → +Z·sl, H → +Y·sh, the third by the right hand.
      const zAxis = unit(L, sl); // source direction that maps to +Z
      const yAxis = unit(H, sh);
      const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
      // Rows of the rotation are the source directions of target x / y / z.
      const rot = new THREE.Matrix4().set(
        xAxis.x, xAxis.y, xAxis.z, 0,
        yAxis.x, yAxis.y, yAxis.z, 0,
        zAxis.x, zAxis.y, zAxis.z, 0,
        0, 0, 0, 1,
      );
      for (const k of [0.94, 0.97, 1, 1.03, 1.06]) {
        const s = (len / ms.getComponent(L)) * k;
        const place = (deg: number) =>
          new THREE.Matrix4()
            .makeTranslation(rc.x, rc.y, rc.z)
            .multiply(new THREE.Matrix4().makeScale(s, s, s))
            .multiply(new THREE.Matrix4().makeRotationX((deg * Math.PI) / 180))
            .multiply(rot)
            .multiply(new THREE.Matrix4().makeTranslation(-mc.x, -mc.y, -mc.z));
        const m = place(0);
        const g = grid();
        rasterize(model, g, m);
        for (let dy = -8; dy <= 8; dy++) {
          for (let dz = -8; dz <= 8; dz++) {
            const score = iou(refGrid, g, dz, dy);
            if (score > best.score) best = { score, m: new THREE.Matrix4().makeTranslation(0, dy * CELL, dz * CELL).multiply(m), place };
          }
        }
      }
    }
  }
  // Pitch: the principal axis leans a little toward the magazine and stock; search around it.
  if (pitches.length > 1) {
    const base = best;
    for (const deg of pitches) {
      if (deg === 0) continue;
      const m = base.place(deg);
      const g = grid();
      rasterize(model, g, m);
      for (let dy = -10; dy <= 10; dy++) {
        for (let dz = -6; dz <= 6; dz++) {
          const score = iou(refGrid, g, dz, dy);
          if (score > best.score) best = { score, m: new THREE.Matrix4().makeTranslation(0, dy * CELL, dz * CELL).multiply(m), place: base.place };
        }
      }
    }
  }
  // Across: the barrel on the bore (the bounds centre is pulled aside by handles and levers).
  const v = new THREE.Vector3();
  let front = Infinity;
  for (let i = 0; i < model.length; i += 3) front = Math.min(front, v.set(model[i], model[i + 1], model[i + 2]).applyMatrix4(best.m).z);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < model.length; i += 3) {
    v.set(model[i], model[i + 1], model[i + 2]).applyMatrix4(best.m);
    if (v.z < front + 0.06) {
      lo = Math.min(lo, v.x);
      hi = Math.max(hi, v.x);
    }
  }
  if (hi > lo) best.m.premultiply(new THREE.Matrix4().makeTranslation(-(lo + hi) / 2, 0, 0));
  return best.m;
}

// ------------------------------------------------------------------ dressing

/** Is `o` (or an ancestor up to `root`) one of `nodes`? */
function under(o: THREE.Object3D, nodes: (THREE.Object3D | null)[], root: THREE.Object3D): THREE.Object3D | null {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (nodes.includes(p)) return p;
  return null;
}

/** Root-space bounds of the meshes under `node` (hands excluded). */
function partBounds(rig: WeaponRig, node: THREE.Object3D): THREE.Box3 {
  return boundsOf(trianglesOf(rig.root, (m) => !!under(m, [node], rig.root) && !under(m, [rig.leftHand, rig.rightHand, rig.heldShell], rig.root)));
}

/**
 * `geo` without loose pieces: split into connected parts (shared corners), keep the
 * biggest and every part whose bounds touch a kept one, drop the rest (spare rounds
 * floating where a reload animation would use them). Null if nothing is dropped.
 */
function keepAttached(geo: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = geo.getAttribute('position');
  const tris = pos.count / 3;
  const parent = new Int32Array(tris).map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const corner = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
      const o = corner.get(key);
      if (o === undefined) corner.set(key, t);
      else parent[find(t)] = find(o);
    }
  }
  const parts = new Map<number, { tris: number[]; box: THREE.Box3 }>();
  const v = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    let p = parts.get(r);
    if (!p) parts.set(r, (p = { tris: [], box: new THREE.Box3() }));
    p.tris.push(t);
    for (let k = 0; k < 3; k++) p.box.expandByPoint(v.fromBufferAttribute(pos, t * 3 + k));
  }
  const list = [...parts.values()].sort((a, b) => b.tris.length - a.tris.length);
  const size = list[0].box.getSize(new THREE.Vector3()).length();
  const kept = [list[0]];
  const rest = list.slice(1);
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const near = rest[i].box.clone().expandByScalar(size * 0.005);
      if (kept.some((k) => k.box.intersectsBox(near))) {
        kept.push(...rest.splice(i, 1));
        grew = true;
      }
    }
  }
  if (!rest.length) return null;
  const keep = kept.flatMap((p) => p.tris);
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name);
    const arr = new Float32Array(keep.length * 3 * a.itemSize);
    let i = 0;
    for (const t of keep) for (let k = 0; k < 3; k++, i++) for (let j = 0; j < a.itemSize; j++) arr[i * a.itemSize + j] = a.getComponent(t * 3 + k, j);
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  return out;
}

/** Highest point of the model on the bore's centre plane between depths z0..z1 (root space), under `below`. */
function topNear(geo: THREE.BufferGeometry, z0: number, z1: number, below: number): number | null {
  const pos = geo.getAttribute('position');
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(pos.getX(i)) < 0.02 && z >= z0 && z <= z1 && y < below && y > top) top = y;
  }
  return top > -Infinity ? top : null;
}

/**
 * Dress `rig` (fresh from its builder) in the model for `key`, if there is one.
 * `world`: the light third-person file.
 */
export function dressRig(rig: WeaponRig, key: ModelKey, world: boolean): boolean {
  const tier: Tier = world ? 'world' : 'view';
  const src = sources.get(`${key}|${tier}`);
  if (!src) return false;
  const root = rig.root;
  const keepNodes = [rig.leftHand, rig.rightHand, rig.heldShell];
  const isProc = (m: THREE.Mesh) => !under(m, keepNodes, root);
  let matrix = fits.get(`${key}|${tier}`);
  if (matrix === undefined) {
    const ref = trianglesOf(root, (m) => isProc(m) && !(m.material as THREE.Material).transparent);
    src.geometry = keepAttached(src.geometry) ?? src.geometry;
    const pos = src.geometry.getAttribute('position').array as Float32Array;
    matrix = ref.length ? fit(ref, pos, !!FLIP[`${key}|${tier}`]) : null;
    fits.set(`${key}|${tier}`, matrix);
  }
  if (!matrix) return false;

  // Moving regions, taken from the procedural parts at rest (a little margin around them).
  const bolty = !!rig.bolt && (rig.shellType === 'pistol' || !!rig.bolt.userData.knob);
  const regions: { node: THREE.Object3D; box: THREE.Box3 }[] = [];
  for (const node of [rig.mag, bolty ? rig.bolt : null, rig.pump]) {
    if (!node) continue;
    const box = partBounds(rig, node);
    if (box.isEmpty()) continue;
    box.expandByVector(new THREE.Vector3(0.004, 0.004, 0.004));
    if (node === rig.mag) box.min.y -= 0.02; // models often carry a longer magazine
    regions.push({ node, box });
  }

  // Strip the procedural gun (moving nodes stay as empty groups).
  const drop: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && isProc(m)) drop.push(m);
  });
  for (const m of drop) {
    // A moving part that is itself a mesh: keep the node, lose its looks.
    if (m === rig.mag || m === rig.bolt || m === rig.pump) {
      m.visible = true;
      (m as THREE.Mesh).geometry = new THREE.BufferGeometry();
      continue;
    }
    const parent = m.parent!;
    for (const k of [...m.children]) parent.attach(k);
    m.removeFromParent();
  }

  // Cut the model up: each triangle goes to the region its centre is in, else the body.
  const geo = src.geometry.clone().applyMatrix4(matrix);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const mat = geo.getAttribute('mat');
  // Per moving node and material.
  const buckets = new Map<string, { node: THREE.Object3D; mat: number; starts: number[] }>();
  const c = new THREE.Vector3();
  const a = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    c.set(0, 0, 0);
    for (let v = 0; v < 3; v++) c.add(a.fromBufferAttribute(pos, t + v));
    c.multiplyScalar(1 / 3);
    const r = regions.find((r) => r.box.containsPoint(c));
    const node = r?.node ?? root;
    const mi = mat ? mat.getX(t) : 0;
    const key = `${node.uuid}|${mi}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { node, mat: mi, starts: [] }));
    b.starts.push(t);
  }
  root.updateMatrixWorld(true);
  for (const { node, mat: mi, starts } of buckets.values()) {
    const n = starts.length * 3;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
    let i = 0;
    for (const t of starts) {
      for (let v = 0; v < 3; v++, i++) {
        P.set([pos.getX(t + v), pos.getY(t + v), pos.getZ(t + v)], i * 3);
        if (nor) N.set([nor.getX(t + v), nor.getY(t + v), nor.getZ(t + v)], i * 3);
        if (uv) U.set([uv.getX(t + v), uv.getY(t + v)], i * 2);
      }
    }
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', new THREE.BufferAttribute(P, 3));
    if (nor) part.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    if (uv) part.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    // Into the node's own space (its rest place in the root).
    if (node !== root) part.applyMatrix4(new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(root.matrixWorld));
    part.computeBoundingSphere();
    const mesh = new THREE.Mesh(part, src.materials[mi]);
    mesh.userData.gunModel = true;
    mesh.castShadow = true;
    node.add(mesh);
  }
  // Flash and tracers from the model's own muzzle (the fitted length can differ a little).
  const mz = rig.muzzle.position;
  let front = Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) < 0.03 && Math.abs(pos.getY(i) - mz.y) < 0.05) front = Math.min(front, pos.getZ(i));
  }
  if (rig.muzzle.parent === root && Math.abs(front - mz.z) < 0.15) mz.z = front;
  // Aimed: the eye just over the highest point of the gun from the rear sight to the
  // muzzle (on the centre line; side levers and handles don't count), level with the
  // bore. Nothing of the model rises into the view, the shot still lands at the centre.
  if (rig.sight.parent === root) {
    const y = topNear(geo, mz.z, rig.sight.position.z + 0.1, rig.sight.position.y + 0.12);
    if (y !== null) rig.sight.position.y = y + 0.006;
  }
  geo.dispose();
  return true;
}
