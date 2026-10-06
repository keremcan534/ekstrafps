import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelKey } from './WeaponData';
import type { WeaponRig } from './WeaponModels';

/**
 * Real weapon meshes (Meshy, packed by scripts/pack-weapon.mjs): public/guns/<key>.glb, the
 * model as made, for the gun in your hands (desktop and phones); public/guns/m/<key>.glb
 * for every third-person gun. They are dressed onto the procedural rigs, which keep doing the
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
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

const sources = new Map<string, GunSource>();
/** Fitted root-space transform per model key (both tiers share the source coordinates). */
const fits = new Map<string, THREE.Matrix4 | null>();

/** Models the fit turns the wrong way round (a stock thinner than the barrel). */
const FLIP: Partial<Record<ModelKey, boolean>> = { m249: true };

const KEYS: ModelKey[] = ['ak47', 'mk47', 'asval', 'm4a1', 'rd704', 'ppsh', 'mosin', 'kar98', 'pistol', 'shotgun', 'mp5', 'glock', 'saiga', 'svd', 'm249', 'scarh'];

/** Float copies of every attribute (quantized files come as normalized integers). */
function floatGeometry(src: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(matrix);
  return g;
}

async function loadOne(url: string): Promise<GunSource | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = [];
    let material: THREE.Material | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = floatGeometry(m.geometry, m.matrixWorld);
      geos.push(g.index ? g.toNonIndexed() : g);
      material ??= Array.isArray(m.material) ? m.material[0] : m.material;
    });
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geometry || !material) return null;
    const mt = material as THREE.MeshStandardMaterial;
    mt.side = THREE.FrontSide;
    // Meshy finishes come out glossy (roughness ~0.35): in the first-person room light a
    // black polymer frame reads as polished silver. A touch more satin.
    mt.roughness = 1.3;
    // Seen along the top at a grazing angle: without anisotropic filtering the textures
    // smear into mud a hand's width from the eye.
    for (const t of [mt.map, mt.normalMap, mt.roughnessMap, mt.metalnessMap, mt.aoMap]) if (t) t.anisotropy = 8;
    // Meshy bakes a little light into "emissive": none on a gun.
    if (mt.emissiveMap) {
      mt.emissiveMap = null;
      mt.emissive.setRGB(0, 0, 0);
    }
    return { geometry, material: mt };
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
        const url = override.get(k) ?? `${tier === 'view' ? 'guns' : 'guns/m'}/${k}.glb`;
        const s = await loadOne(url);
        if (s) sources.set(`${k}|${tier}`, s);
      }),
    ),
  );
}

export function hasWeaponMesh(key: ModelKey): boolean {
  return sources.has(`${key}|world`) || sources.has(`${key}|view`);
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
  let best = { score: -1, m: new THREE.Matrix4() };
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
        const m = new THREE.Matrix4()
          .makeTranslation(rc.x, rc.y, rc.z)
          .multiply(new THREE.Matrix4().makeScale(s, s, s))
          .multiply(rot)
          .multiply(new THREE.Matrix4().makeTranslation(-mc.x, -mc.y, -mc.z));
        const g = grid();
        rasterize(model, g, m);
        for (let dy = -8; dy <= 8; dy++) {
          for (let dz = -8; dz <= 8; dz++) {
            const score = iou(refGrid, g, dz, dy);
            if (score > best.score) best = { score, m: new THREE.Matrix4().makeTranslation(0, dy * CELL, dz * CELL).multiply(m) };
          }
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
  const src = (!world && sources.get(`${key}|view`)) || sources.get(`${key}|world`);
  if (!src) return false;
  const root = rig.root;
  const keepNodes = [rig.leftHand, rig.rightHand, rig.heldShell];
  const isProc = (m: THREE.Mesh) => !under(m, keepNodes, root);
  let matrix = fits.get(key);
  if (matrix === undefined) {
    const ref = trianglesOf(root, (m) => isProc(m) && !(m.material as THREE.Material).transparent);
    // Fit on the light tier when there is one (same coordinates, fewer triangles).
    const fitSrc = sources.get(`${key}|world`) ?? src;
    const pos = fitSrc.geometry.getAttribute('position').array as Float32Array;
    matrix = ref.length ? fit(ref, pos, !!FLIP[key]) : null;
    fits.set(key, matrix);
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
  const buckets = new Map<THREE.Object3D, number[]>();
  const c = new THREE.Vector3();
  const a = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    c.set(0, 0, 0);
    for (let v = 0; v < 3; v++) c.add(a.fromBufferAttribute(pos, t + v));
    c.multiplyScalar(1 / 3);
    const r = regions.find((r) => r.box.containsPoint(c));
    const node = r?.node ?? root;
    let list = buckets.get(node);
    if (!list) buckets.set(node, (list = []));
    list.push(t);
  }
  root.updateMatrixWorld(true);
  for (const [node, starts] of buckets) {
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
    const mesh = new THREE.Mesh(part, src.material);
    mesh.userData.gunModel = true;
    mesh.castShadow = true;
    node.add(mesh);
  }
  // Flash and tracers from the model's own muzzle (the fitted length can differ a little).
  const mz = rig.muzzle.position;
  let front = Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) < 0.03 && Math.abs(pos.getY(i) - mz.y) < 0.035) front = Math.min(front, pos.getZ(i));
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
