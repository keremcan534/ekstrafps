import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelKey } from './WeaponData';
import type { WeaponRig } from './WeaponModels';
import { loadArms } from './FirstPersonHands';
import { dressGunMaterial } from './GunSurface';

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
 *
 * A weapon with a view profile (ViewProfile.ts) takes only its first-person model from here
 * (gunSource): none of the guessing below. Its placement is the profile's (ProfiledRig.ts).
 */

type Tier = 'view' | 'world';

/** A named piece of a model file: a bone of its skeleton, or a mesh node. */
export interface GunPart {
  name: string;
  /** Index of the enclosing piece in `parts`, -1 at the top. */
  parent: number;
  /** Where the piece's own origin sits, model space (a bone's head: what it turns about). */
  head: THREE.Vector3;
}

export interface GunSource {
  /**
   * Model space (the file's scene, its own units and axes), non-indexed. Attribute `mat`:
   * each vertex's index into `materials`; `part`: its index into `parts` (the bone that
   * moves it most, or its mesh node).
   */
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  parts: GunPart[];
  /** Loose pieces already dropped (keepAttached). */
  clean?: boolean;
}

const sources = new Map<string, GunSource>();
/** Fitted root-space transform per `${key}|${tier}` (each file has its own coordinates). */
const fits = new Map<string, THREE.Matrix4 | null>();

/** Models whose rear sight is in the way (a folding sight left up): cut off at the rail. */
const NO_REAR_SIGHT = new Set<ModelKey>(['svd']);

/** `geo` (root space) without its rear sight: whatever stands above the rail there. */
function stripRearSight(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  // The rear sight: the tallest thing on the centre line over the receiver.
  let best = { z: 0, y: -Infinity };
  for (let z = -0.25; z <= 0.06; z += 0.004) {
    const y = topNear(geo, z - 0.002, z + 0.002, 1);
    if (y !== null && y > best.y) best = { z, y };
  }
  // The rail just in front of it.
  const rail = topNear(geo, best.z - 0.12, best.z - 0.06, best.y - 0.005);
  if (rail === null) return geo;
  const pos = geo.getAttribute('position');
  const keep: number[] = [];
  const c = new THREE.Vector3();
  const a = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(a.fromBufferAttribute(pos, t + k));
    c.multiplyScalar(1 / 3);
    if (Math.abs(c.z - best.z) < 0.035 && c.y > rail + 0.003 && Math.abs(c.x) < 0.03) continue;
    keep.push(t);
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const at = geo.getAttribute(name);
    const arr = new Float32Array(keep.length * 3 * at.itemSize);
    let i = 0;
    for (const t of keep) for (let k = 0; k < 3; k++, i++) for (let j = 0; j < at.itemSize; j++) arr[i * at.itemSize + j] = at.getComponent(t + k, j);
    out.setAttribute(name, new THREE.BufferAttribute(arr, at.itemSize));
  }
  geo.dispose();
  return out;
}

/** The lit dot put in a model's reflex sight (it has a window, not a lens). */
const RETICLE = new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false });
const RETICLE_GLOW = new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

/** Models the fit turns the wrong way round (a stock thinner than the barrel). */
const FLIP: Record<string, boolean> = { 'm249|world': true };

const KEYS: ModelKey[] = ['ak47', 'mk47', 'asval', 'm4a1', 'ppsh', 'mosin', 'kar98', 'pistol', 'shotgun', 'mp5', 'glock', 'saiga', 'svd', 'm249', 'scarh', 'qbz192', 'g36c', 'cz805', 'ak109', 'mp5sd', 'ash127'];

/** Overall length (m) for guns borrowing a relative's rig: the model is scaled to its own, not the rig's. */
const LENGTH: Partial<Record<ModelKey, number>> = { qbz192: 0.84, g36c: 0.72, cz805: 0.91, ak109: 0.94, mp5sd: 0.78, ash127: 0.75 };

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

/** Per vertex (non-indexed order): the bone that moves it most. */
function dominantBones(m: THREE.SkinnedMesh): THREE.Bone[] {
  const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  const si = src.getAttribute('skinIndex');
  const sw = src.getAttribute('skinWeight');
  const out: THREE.Bone[] = [];
  for (let i = 0; i < si.count; i++) {
    let best = 0;
    let most = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > most) [most, best] = [w, si.getComponent(i, k)];
    }
    out.push(m.skeleton.bones[best]);
  }
  return out;
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
    // The file's named pieces (bones, mesh nodes): a view profile picks its moving parts by name.
    const parts: GunPart[] = [];
    const partOf = new Map<THREE.Object3D, number>();
    const partIndex = (o: THREE.Object3D): number => {
      let i = partOf.get(o);
      if (i === undefined) {
        const parent = o.parent && o.parent !== gltf.scene ? partIndex(o.parent) : -1;
        i = parts.push({ name: o.name, parent, head: o.getWorldPosition(new THREE.Vector3()) }) - 1;
        partOf.set(o, i);
      }
      return i;
    };
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || notGun(m)) return;
      const mt = Array.isArray(m.material) ? m.material[0] : m.material;
      let idx = materials.indexOf(mt);
      if (idx < 0) idx = materials.push(mt) - 1;
      const skinned = (m as THREE.SkinnedMesh).isSkinnedMesh;
      const g = skinned ? skinnedGeometry(m as THREE.SkinnedMesh) : floatGeometry(m.geometry, m.matrixWorld);
      const n = g.getAttribute('position').count;
      g.setAttribute('mat', new THREE.BufferAttribute(new Float32Array(n).fill(idx), 1));
      const part = new Float32Array(n);
      if (skinned) dominantBones(m as THREE.SkinnedMesh).forEach((b, i) => (part[i] = partIndex(b)));
      else part.fill(partIndex(m));
      g.setAttribute('part', new THREE.BufferAttribute(part, 1));
      geos.push(g);
    });
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geometry || !materials.length) return null;
    // The gun's length: its longest side (wood grain runs along it).
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    const grain = new THREE.Vector3(size.x >= size.y && size.x >= size.z ? 1 : 0, size.y > size.x && size.y >= size.z ? 1 : 0, size.z > size.x && size.z > size.y ? 1 : 0);
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
      // The gun in hand (flat palette colours): wood, steel and coating surfaces (GunSurface.ts).
      if (!meshy) dressGunMaterial(mt, grain);
    }
    return { geometry, materials, parts };
  } catch {
    return null;
  }
}

/** Drop loose pieces once (spare rounds floating in the air, a backdrop card). */
function cleanSource(s: GunSource): void {
  if (s.clean) return;
  s.geometry = keepAttached(s.geometry) ?? s.geometry;
  s.clean = true;
}

/** The first-person model for `key` as loaded (loose pieces dropped), or null when there is none. */
export function gunSource(key: string): GunSource | null {
  const s = sources.get(`${key}|view`);
  if (s) cleanSource(s);
  return s ?? null;
}

/**
 * The old automatic fit of `key`'s first-person model (model → weapon space), once a rig
 * has been dressed with it. Only to seed a new view profile: profiled weapons never fit.
 */
export function legacyFit(key: ModelKey): THREE.Matrix4 | null {
  return fits.get(`${key}|view`)?.clone() ?? null;
}

/** Load every weapon model there is (missing ones are skipped). Never rejects. */
export async function loadWeaponMeshes(): Promise<void> {
  // The first-person arms come with the guns (src/weapons/FirstPersonHands.ts).
  const arms = loadArms();
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
  await arms;
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
function fit(ref: Float32Array, model: Float32Array, flip = false, length?: number): THREE.Matrix4 {
  // A model posed at an angle (first-person packs hold the gun canted): turn it square
  // onto its principal axes first, then fit as usual with a little pitch search.
  const P = principalFrame(model);
  if (!P) return fitSquare(ref, model, flip, [0], length);
  const turned = new Float32Array(model.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < model.length; i += 3) v.set(model[i], model[i + 1], model[i + 2]).applyMatrix4(P).toArray(turned, i);
  return fitSquare(ref, turned, flip, [-6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6], length).multiply(P);
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
function fitSquare(ref: Float32Array, model: Float32Array, flip: boolean, pitches: number[], length?: number): THREE.Matrix4 {
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
        const s = ((length ?? len) / ms.getComponent(L)) * k;
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

/**
 * The silhouette fit gets the pitch to a degree or two; the barrel settles it. Slices
 * along the front of the gun give the middle of what's on the centre line there; the
 * median slope between them (outliers like a front sight or gas block don't move a
 * median) is the bore's tilt, turned out about the muzzle.
 */
function levelBarrel(model: Float32Array, m: THREE.Matrix4): THREE.Matrix4 {
  const v = new THREE.Vector3();
  const pts: { z: number; y: number; x: number }[] = [];
  let front = Infinity;
  for (let i = 0; i < model.length; i += 3) {
    v.set(model[i], model[i + 1], model[i + 2]).applyMatrix4(m);
    pts.push({ x: v.x, y: v.y, z: v.z });
    front = Math.min(front, v.z);
  }
  const mids: { z: number; y: number }[] = [];
  for (let z = front + 0.005; z < front + 0.3; z += 0.01) {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      if (Math.abs(p.z - z) > 0.004 || Math.abs(p.x) > 0.025) continue;
      lo = Math.min(lo, p.y);
      hi = Math.max(hi, p.y);
    }
    // A thin section only (the barrel, not a handguard or magazine well).
    if (hi > lo && hi - lo < 0.05) mids.push({ z, y: (lo + hi) / 2 });
  }
  if (mids.length < 4) return m;
  const slopes: number[] = [];
  for (let i = 0; i < mids.length; i++) for (let j = i + 2; j < mids.length; j++) slopes.push((mids[j].y - mids[i].y) / (mids[j].z - mids[i].z));
  slopes.sort((a, b) => a - b);
  const tilt = Math.atan(slopes[slopes.length >> 1]);
  if (Math.abs(tilt) < 0.1 * (Math.PI / 180) || Math.abs(tilt) > 8 * (Math.PI / 180)) return m;
  // Rising toward the back (+z) means the muzzle dips: turn it back about the muzzle.
  const pivot = new THREE.Vector3(0, mids[0].y, mids[0].z);
  return new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationX(tilt))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(m);
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
  // A backdrop or floor card left in the scene: a few triangles spanning more than the gun.
  const card = (p: { tris: number[]; box: THREE.Box3 }) => p.tris.length <= 16 && p.box.getSize(new THREE.Vector3()).length() > size * 0.6;
  const kept = [list[0]];
  const rest = list.slice(1).filter((p) => !card(p));
  const cards = list.length - 1 - rest.length;
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
  if (!rest.length && !cards) return null;
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
function topNear(geo: THREE.BufferGeometry, z0: number, z1: number, below: number, half = 0.02): number | null {
  const pos = geo.getAttribute('position');
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(pos.getX(i)) < half && z >= z0 && z <= z1 && y < below && y > top) top = y;
  }
  return top > -Infinity ? top : null;
}

/**
 * Dress `rig` (fresh from its builder) in the model for `key`, if there is one.
 * `world`: the light third-person file.
 */
export function dressRig(rig: WeaponRig, key: ModelKey, world: boolean, eyeBack?: number): boolean {
  const tier: Tier = world ? 'world' : 'view';
  // Aimed, the eye sits `eyeBack` behind the procedural sight point (the weapon's
  // sightDistance): the sight line is worked out from there, where the player looks from.
  const eyeZ = eyeBack === undefined ? undefined : rig.sight.position.z + eyeBack;
  const src = sources.get(`${key}|${tier}`);
  if (!src) return false;
  const root = rig.root;
  const keepNodes = [rig.leftHand, rig.rightHand, rig.heldShell];
  const isProc = (m: THREE.Mesh) => !under(m, keepNodes, root);
  let matrix = fits.get(`${key}|${tier}`);
  if (matrix === undefined) {
    const ref = trianglesOf(root, (m) => isProc(m) && !(m.material as THREE.Material).transparent);
    cleanSource(src);
    const pos = src.geometry.getAttribute('position').array as Float32Array;
    matrix = ref.length ? fit(ref, pos, !!FLIP[`${key}|${tier}`], LENGTH[key]) : null;
    if (matrix) matrix = levelBarrel(pos, matrix);
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
  let geo = src.geometry.clone().applyMatrix4(matrix);
  if (NO_REAR_SIGHT.has(key)) geo = stripRearSight(geo);
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
  if (rig.muzzle.parent === root && Math.abs(front - mz.z) < 0.3) mz.z = front;
  // Aimed, from the model's own sights. The rear sight: the tallest thing on the centre
  // line over the receiver (the rearmost of the near-tallest, so a pistol's front post
  // doesn't count). A peep (a ray down its centre passes a thin ring, then a hole): the
  // eye in the hole, close behind it. A notch or open sight: the classic picture, the
  // front post's tip level with the rear sight's top, the eye a hand's width behind.
  // The front post: rays down the centre line near the muzzle; through a protective
  // ring the post's top counts, not the ring's.
  if (rig.sight.parent === root) {
    const cap = rig.sight.position.y + 0.12;
    const probe = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const hits = (z: number) => {
      ray.set(new THREE.Vector3(0, cap, z), down);
      return ray.intersectObject(probe).map((h) => h.point.y);
    };
    const bins: { z: number; y: number }[] = [];
    // Up to just behind the grip: further back is the stock, not a sight.
    for (let z = Math.max(mz.z + 0.1, -0.32); z <= 0.06; z += 0.002) {
      const y = topNear(geo, z - 0.001, z + 0.001, cap);
      if (y !== null) bins.push({ z, y });
    }
    const tallest = Math.max(...bins.map((b) => b.y));
    const rearSight = bins.filter((b) => b.y > tallest - 0.002).reduce((a, b) => (b.z > a.z ? b : a), bins[0]);
    // A red dot / reflex sight on the model: a ring around a window 1-5 cm across at the
    // top of the gun, closed at the sides. The eye goes in its middle a hand's width
    // behind, and a dot is lit at the front of the window (low-poly optics have no lens).
    let optic: { y: number; front: number; back: number } | null = null;
    if (rearSight) {
      // Over the receiver only: a front sight's protective ring is open ahead too.
      for (let z = Math.max(rearSight.z - 0.08, -0.15); z <= rearSight.z + 0.08; z += 0.002) {
        const ys = hits(z);
        if (!(ys.length >= 3 && ys[0] > tallest - 0.015 && ys[0] - ys[1] < 0.012 && ys[1] - ys[2] > 0.015 && ys[1] - ys[2] < 0.05)) continue;
        const c = new THREE.Vector3(0, (ys[1] + ys[2]) / 2, z);
        const half = (ys[1] - ys[2]) / 2;
        const closed = [1, -1].every((sx) => {
          ray.set(c, new THREE.Vector3(sx, 0, 0));
          const h = ray.intersectObject(probe)[0];
          return !!h && h.distance < half * 1.6 + 0.004;
        });
        if (!closed) continue;
        // Through a sight's window the way ahead is open (a bolt's or receiver's hole
        // looks straight into metal).
        ray.set(c, new THREE.Vector3(0, 0, -1));
        const ahead = ray.intersectObject(probe)[0];
        if (ahead && ahead.distance < 0.15) continue;
        if (!optic) optic = { y: c.y, front: z, back: z };
        else if (Math.abs(c.y - optic.y) < 0.004) optic.back = z;
      }
    }
    let tip = -Infinity;
    let tipZ = mz.z;
    for (let z = mz.z; z <= mz.z + 0.35; z += 0.002) {
      const ys = hits(z);
      if (!ys.length) continue;
      const ring = ys.length >= 3 && ys[0] - ys[1] < 0.005 && ys[1] - ys[2] > 0.003;
      const y = ring ? ys[2] : ys[0];
      if (y > tip) [tip, tipZ] = [y, z];
    }
    if (optic) {
      rig.sightShift = optic.back - rig.sight.position.z;
      rig.sight.position.set(0, optic.y, optic.back);
      rig.eyeRelief = 0.12;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 16), RETICLE);
      dot.position.set(0, optic.y, optic.front - 0.001);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 16), RETICLE_GLOW);
      glow.position.set(0, optic.y, optic.front - 0.0008);
      root.add(dot, glow);
    } else if (rearSight && tip > -Infinity) {
      // Iron sights, whatever their kind (notch, peep, open leaf, a bare rail): the eye at
      // the cheek goes to the lowest height from which a ray to the front post's tip meets
      // nothing on the way: it looks through the notch or hole, or just over the top. The
      // line from there to the tip is the sight line; aimed, the gun tips so it's level and
      // the post sits dead centre.
      const cheek = eyeZ ?? rearSight.z + 0.3;
      const target = new THREE.Vector3(0, tip, tipZ);
      const from = new THREE.Vector3();
      const dir = new THREE.Vector3();
      let eye = tip;
      // Not under the rear sight (a gap below a leaf is not a sight): from its notch down.
      for (let y = Math.max(tip - 0.002, rearSight.y - 0.012); y <= tip + 0.06; y += 0.0005) {
        from.set(0, y, cheek);
        const span = dir.subVectors(target, from).length();
        ray.set(from, dir.normalize());
        // Not the stock under the cheek (clipped by the near plane), not the post itself.
        ray.near = 0.06;
        ray.far = span - 0.006;
        const blocked = ray.intersectObject(probe).length > 0;
        ray.near = 0;
        ray.far = Infinity;
        if (!blocked) {
          eye = y + 0.002; // a little air over the sight: an open picture, not a slit
          break;
        }
      }
      const rearY = tip + ((eye - tip) * (rearSight.z - tipZ)) / (cheek - tipZ);
      rig.sightShift = rearSight.z - rig.sight.position.z;
      rig.sight.position.set(0, rearY, rearSight.z);
      const tilt = Math.atan2(eye - tip, cheek - tipZ);
      if (Math.abs(tilt) < 4 * (Math.PI / 180)) rig.sightTilt = tilt;
    }
    (probe.material as THREE.Material).dispose();
  }
  geo.dispose();
  return true;
}
