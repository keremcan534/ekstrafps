import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponRig } from './WeaponModels';

/**
 * A soldier's gun (a baked third-person rig, WeaponModels.bakeRig) in as few draws as the
 * picture allows. The model file comes cut into one mesh per moving part and palette material
 * (WeaponMeshes.dressRig): 2-10 at the root, 1-4 on the magazine, every one a draw for every
 * soldier in sight. Third person never works the bolt or the pump, so their pieces join the
 * body; the magazine keeps its own mesh (reloads hide it). Within each, the materials differ
 * only in a few numbers (roughness, metalness, the specular strength and colour, the index of
 * refraction, Standard or Physical): those ride along per vertex, read through flat varyings
 * (the same float32 the uniform held), so the body is one draw and the magazine another.
 *
 * Exact by construction: same vertices, the triangles of each material in the order three
 * drew them (by material id, so a later material still wins a depth tie), every other
 * setting and texture identical (else that material keeps its own mesh). A Standard material
 * inside a Physical program runs the Standard specular block word for word.
 *
 * `?nogunmerge`: every piece as the model file was cut, one draw each (the reference for an
 * A/B). `?noguncull`: soldiers' guns are drawn off screen too, as before.
 */

/** Pieces with fewer corners: the grip finders (GunGrips, MasterGrips) skip them, so they stay apart. */
const SLIVER = 24;

const flag = (name: string) => typeof location !== 'undefined' && new URLSearchParams(location.search).has(name);

function under(o: THREE.Object3D, anc: THREE.Object3D | null): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === anc) return true;
  return false;
}

/**
 * A magazine piece's box without its looks. GunGrips measures the magazine with
 * Box3.setFromObject, which takes each mesh's own box through the (turned) world matrix: one
 * merged box turned is wider than the pieces' boxes turned. These keep that sum as it was
 * (the merged mesh adds an empty box); not a Mesh, so nothing draws or reads them.
 */
class PartBox extends THREE.Object3D {
  declare geometry: THREE.BufferGeometry;
  constructor(geometry?: THREE.BufferGeometry) {
    super();
    if (geometry) this.geometry = geometry;
  }
  copy(source: THREE.Object3D, recursive?: boolean): this {
    super.copy(source, recursive);
    this.geometry = (source as PartBox).geometry;
    return this;
  }
}

/**
 * Merge the model's pieces in a rig being baked. `meshes`: every mesh under its root, taken
 * before the bake. The root's matrices must be current.
 */
export function mergeGunParts(rig: WeaponRig, meshes: THREE.Mesh[]): void {
  const { root, mag } = rig;
  const nodes = new Map<THREE.Object3D, THREE.Mesh[]>([[root, []]]);
  if (mag) nodes.set(mag, []);
  for (const m of meshes) {
    if (!m.userData.gunModel || Array.isArray(m.material) || under(m, rig.leftHand) || under(m, rig.rightHand)) continue;
    let shown = true;
    for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) shown &&= p.visible;
    if (!shown || (m.geometry.getAttribute('position')?.count ?? 0) < SLIVER) continue;
    nodes.get(mag && under(m, mag) ? mag : root)!.push(m);
  }
  if (flag('nogunmerge')) return;
  if (!chunksKnown()) return perMaterial(root, nodes.get(root)!);
  for (const [node, parts] of nodes) mergeNode(node, parts, node === mag);
}

/** Soldiers' guns off screen are not drawn: every mesh of the gun (not the hands) culled again. */
export function cullGunParts(rig: WeaponRig): void {
  if (flag('noguncull')) return;
  rig.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !under(o, rig.leftHand) && !under(o, rig.rightHand)) o.frustumCulled = true;
  });
}

/** Without the shader patch (three's chunks changed): bolt and pump pieces join the body's mesh of the same material. */
function perMaterial(root: THREE.Object3D, parts: THREE.Mesh[]): void {
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m4 = new THREE.Matrix4();
  const model = new Map<THREE.Material, THREE.Mesh[]>();
  for (const m of parts) model.set(m.material as THREE.Material, [...(model.get(m.material as THREE.Material) ?? []), m]);
  for (const [mt, list] of model) {
    const geos = list.map((p) => p.geometry.clone().applyMatrix4(m4.multiplyMatrices(rootInv, p.matrixWorld)));
    const names = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join();
    if (list.length < 2 || geos.some((g) => !!g.index || names(g) !== names(geos[0]))) continue;
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mt);
    mesh.userData.gunModel = true;
    mesh.castShadow = list[0].castShadow;
    mesh.frustumCulled = list[0].frustumCulled;
    for (const p of list) p.removeFromParent();
    root.add(mesh);
  }
}

// ------------------------------------------------------------------ which materials can share

type Mat = THREE.MeshPhysicalMaterial;

/** three's draw order among opaque materials (after renderOrder): not in its typings. */
const idOf = (m: THREE.Material) => (m as unknown as { id: number }).id;

/** What a piece's mesh brings besides its geometry: all the same within one draw. */
const meshKey = (p: THREE.Mesh) => `${p.castShadow}|${p.receiveShadow}|${p.renderOrder}|${p.layers.mask}|${p.frustumCulled}`;

const SHAPE: [string, number][] = [
  ['position', 3],
  ['normal', 3],
  ['uv', 2],
];

/** Non-indexed position / normal / uv, nothing else, drawn whole: what dressRig makes. */
function plain(p: THREE.Mesh): boolean {
  const g = p.geometry;
  if ((p as THREE.SkinnedMesh).isSkinnedMesh || (p as THREE.InstancedMesh).isInstancedMesh || p.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return false;
  if (g.index || g.groups.length || Object.keys(g.morphAttributes).length || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
  if (Object.keys(g.attributes).sort().join() !== 'normal,position,uv') return false;
  return SHAPE.every(([name, size]) => {
    const at = g.getAttribute(name) as THREE.BufferAttribute;
    return !!at.isBufferAttribute && at.array instanceof Float32Array && at.itemSize === size && !at.normalized;
  });
}

/** Settings that may differ between materials sharing a draw: carried per vertex. */
const PER_VERTEX = new Set(['roughness', 'metalness', 'specularIntensity', 'specularColor', 'ior']);
/** Not settings (names, bookkeeping), or checked on their own. */
const IGNORE = new Set(['uuid', 'name', 'userData', 'version', 'type', 'defines', '_listeners']);

/** A Standard or Physical material that can be read per vertex in a shared program. */
function hostable(mt: THREE.Material): boolean {
  const m = mt as Mat;
  if (!m.isMeshStandardMaterial || m.transparent || m.blending !== THREE.NormalBlending) return false;
  if (JSON.stringify(m.defines) !== (m.isMeshPhysicalMaterial ? '{"STANDARD":"","PHYSICAL":""}' : '{"STANDARD":""}')) return false;
  // A shader hook of its own (GunSurface on the gun in hand) would need chaining: not here.
  for (const v of Object.values(m)) if (typeof v === 'function') return false;
  // Physical only for its specular settings: none of the extra layers, no specular maps.
  if (m.isMeshPhysicalMaterial) {
    const on = [m.clearcoat, m.sheen, m.transmission, m.iridescence, m.anisotropy, m.dispersion, (m as unknown as { retroreflectivity?: number }).retroreflectivity ?? 0];
    if (on.some((v) => v > 0) || m.specularIntensityMap || m.specularColorMap) return false;
  }
  return true;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  // Textures by identity: the same sampler, transform and data.
  if ((a as THREE.Texture).isTexture || (b as THREE.Texture).isTexture) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  const eq = (a as { equals?: (o: unknown) => boolean }).equals;
  return a.constructor === b.constructor && typeof eq === 'function' && eq.call(a, b);
}

/** Every setting but the per-vertex ones identical (a Physical-only one: inert, checked in hostable). */
function sameSettings(a: THREE.Material, b: THREE.Material): boolean {
  const A = a as unknown as Record<string, unknown>;
  const B = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (IGNORE.has(k) || PER_VERTEX.has(k) || !(k in A) || !(k in B)) continue;
    if (!same(A[k], B[k])) return false;
  }
  return true;
}

// ------------------------------------------------------------------ merging

/**
 * One node's pieces (the root with the bolt's and pump's, or the magazine) by material, in
 * three's draw order. Neighbouring materials that can share a program share a draw; one that
 * can't keeps its place between them (its pieces merge on their own).
 */
function mergeNode(node: THREE.Object3D, parts: THREE.Mesh[], isMag: boolean): void {
  const members = new Map<THREE.Material, THREE.Mesh[]>();
  for (const p of parts) members.set(p.material as THREE.Material, [...(members.get(p.material as THREE.Material) ?? []), p]);
  const order = [...members.keys()].sort((a, b) => idOf(a) - idOf(b));
  let run: THREE.Material[] = [];
  const flush = () => {
    if (run.length) build(node, run.map((m) => [m, members.get(m)!] as const), isMag);
    run = [];
  };
  for (const m of order) {
    const ps = members.get(m)!;
    // Glass and the like stay as they are (sorted back to front, skipped by the grip finders).
    if ((m as Mat).transparent || !ps.every((p) => plain(p) && meshKey(p) === meshKey(ps[0]))) {
      flush();
      continue;
    }
    const joins = run.length > 0 && hostable(m) && hostable(run[0]) && sameSettings(run[0], m) && meshKey(ps[0]) === meshKey(members.get(run[0])![0]);
    if (!joins) flush();
    run.push(m);
  }
  flush();
}

const IDENTITY = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** Copy a piece's corners into `node`'s space at corner `at`: verbatim when it already sits there. */
function copyPiece(p: THREE.Mesh, node: THREE.Object3D, P: Float32Array, N: Float32Array, U: Float32Array, at: number): void {
  const g = p.geometry;
  const pos = g.getAttribute('position').array as Float32Array;
  const nor = g.getAttribute('normal').array as Float32Array;
  U.set(g.getAttribute('uv').array as Float32Array, at * 2);
  if (p.parent === node && p.matrix.equals(IDENTITY)) {
    P.set(pos, at * 3);
    N.set(nor, at * 3);
    return;
  }
  // A bolt or pump piece: into the root as the old merge put it (positions through the
  // matrix); a pure move leaves the normals as they were.
  _rel.multiplyMatrices(_inv.copy(node.matrixWorld).invert(), p.matrixWorld);
  const e = _rel.elements;
  const turned = e[0] !== 1 || e[1] !== 0 || e[2] !== 0 || e[4] !== 0 || e[5] !== 1 || e[6] !== 0 || e[8] !== 0 || e[9] !== 0 || e[10] !== 1;
  _nm.getNormalMatrix(_rel);
  for (let i = 0, n = pos.length / 3; i < n; i++) {
    _v.fromArray(pos, i * 3).applyMatrix4(_rel).toArray(P, (at + i) * 3);
    if (turned) _v.fromArray(nor, i * 3).applyNormalMatrix(_nm).toArray(N, (at + i) * 3);
  }
  if (!turned) N.set(nor, at * 3);
}

function build(node: THREE.Object3D, run: (readonly [THREE.Material, THREE.Mesh[]])[], isMag: boolean): void {
  const pieces = run.flatMap(([, ps]) => ps);
  if (run.length === 1 && pieces.length === 1) return weldInPlace(pieces[0]);
  const host = run.length === 1 ? { material: run[0][0], layout: null } : hostFor(run.map(([m]) => m as Mat));
  if (!host) return;
  const L = host.layout;
  let n = 0;
  for (const p of pieces) n += p.geometry.getAttribute('position').count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const U = new Float32Array(n * 2);
  const k = L?.scalars.length ?? 0;
  const A = new Float32Array(n * k);
  const S = new Float32Array(L?.spec ? n * 3 : 0);
  let at = 0;
  for (const [mt, ps] of run) {
    const m = mt as Mat;
    const phys = !!m.isMeshPhysicalMaterial;
    const values = L ? L.scalars.map((f) => (f === 'std' ? (phys ? 0 : 1) : f === 'roughness' || f === 'metalness' ? m[f] : phys ? m[f] : 0)) : [];
    for (const p of ps) {
      const c = p.geometry.getAttribute('position').count;
      copyPiece(p, node, P, N, U, at);
      for (let i = at; i < at + c; i++) {
        for (let j = 0; j < k; j++) A[i * k + j] = values[j];
        if (L?.spec && phys) m.specularColor.toArray(S, i * 3);
      }
      at += c;
    }
  }
  const arrays = [P, N, U, A, S].filter((a) => a.length);
  const sizes = [3, 3, 2, k, 3].filter((_, i) => [P, N, U, A, S][i].length);
  const welded = weld(arrays, sizes, n);
  const out = welded?.arrays ?? arrays;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out[0], 3));
  g.setAttribute('normal', new THREE.BufferAttribute(out[1], 3));
  g.setAttribute('uv', new THREE.BufferAttribute(out[2], 2));
  if (k) g.setAttribute('gunPartMat', new THREE.BufferAttribute(out[3], k));
  if (L?.spec) g.setAttribute('gunPartSpec', new THREE.BufferAttribute(out[k ? 4 : 3], 3));
  if (welded) g.setIndex(new THREE.BufferAttribute(welded.index, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, host.material);
  const first = pieces[0];
  mesh.userData.gunModel = true;
  mesh.castShadow = first.castShadow;
  mesh.receiveShadow = first.receiveShadow;
  mesh.renderOrder = first.renderOrder;
  mesh.layers.mask = first.layers.mask;
  mesh.frustumCulled = first.frustumCulled;
  if (isMag) {
    g.boundingBox = new THREE.Box3(); // empty: the pieces' boxes stand in (PartBox)
    for (const p of pieces) {
      p.geometry.computeBoundingBox();
      const box = new THREE.BufferGeometry();
      box.boundingBox = p.geometry.boundingBox!.clone();
      const stand = new PartBox(box);
      stand.position.copy(p.position);
      stand.quaternion.copy(p.quaternion);
      stand.scale.copy(p.scale);
      p.parent!.add(stand);
    }
  }
  for (const p of pieces) p.removeFromParent();
  node.add(mesh);
}

/** A lone piece: indexed in place when that saves vertices (see weld). */
function weldInPlace(p: THREE.Mesh): void {
  if (!plain(p)) return;
  const g = p.geometry;
  const arrays = ['position', 'normal', 'uv'].map((a) => g.getAttribute(a).array as Float32Array);
  const welded = weld(arrays, [3, 3, 2], g.getAttribute('position').count);
  if (!welded) return;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(welded.arrays[0], 3));
  out.setAttribute('normal', new THREE.BufferAttribute(welded.arrays[1], 3));
  out.setAttribute('uv', new THREE.BufferAttribute(welded.arrays[2], 2));
  out.setIndex(new THREE.BufferAttribute(welded.index, 1));
  out.computeBoundingSphere();
  p.geometry = out;
}

/**
 * Corners that are the same vertex bit for bit (every attribute) become one indexed vertex,
 * in first-use order, the triangles kept in theirs: the vertex shader then runs once per
 * vertex instead of once per corner, on the same inputs, so with the same results. About
 * half of a palette model's corners are repeats, two thirds of a 25k-triangle one's. Null
 * when it would not pay (under 1 in 16 shared), or would leave a piece under SLIVER.
 */
function weld(arrays: Float32Array[], sizes: number[], count: number): { arrays: Float32Array[]; index: Uint16Array | Uint32Array } | null {
  const words = arrays.map((a) => new Uint32Array(a.buffer, a.byteOffset, a.length));
  let cap = 16;
  while (cap < count * 2) cap *= 2;
  const table = new Int32Array(cap).fill(-1);
  const first = new Uint32Array(count);
  const remap = new Uint32Array(count);
  let unique = 0;
  const equal = (a: number, b: number) => {
    for (let w = 0; w < words.length; w++) {
      const s = sizes[w];
      const W = words[w];
      for (let j = 0; j < s; j++) if (W[a * s + j] !== W[b * s + j]) return false;
    }
    return true;
  };
  for (let i = 0; i < count; i++) {
    let h = 0x811c9dc5;
    for (let w = 0; w < words.length; w++) {
      const s = sizes[w];
      const W = words[w];
      for (let j = i * s; j < i * s + s; j++) h = Math.imul(h ^ W[j], 0x01000193);
    }
    for (let slot = (h >>> 0) & (cap - 1); ; slot = (slot + 1) & (cap - 1)) {
      const u = table[slot];
      if (u < 0) {
        table[slot] = unique;
        first[unique] = i;
        remap[i] = unique++;
        break;
      }
      if (equal(first[u], i)) {
        remap[i] = u;
        break;
      }
    }
  }
  if (unique * 16 > count * 15 || unique < SLIVER) return null;
  const out = arrays.map((_, w) => {
    const s = sizes[w];
    const W = words[w];
    const o = new Float32Array(unique * s);
    const O = new Uint32Array(o.buffer);
    for (let u = 0; u < unique; u++) for (let j = 0; j < s; j++) O[u * s + j] = W[first[u] * s + j];
    return o;
  });
  // WebGL 2 always restarts strips at the type's top index: 16-bit only up to 65534.
  const index = unique <= 0xffff ? new Uint16Array(count) : new Uint32Array(count);
  index.set(remap);
  return { arrays: out, index };
}

// ------------------------------------------------------------------ the shared program

type Scalar = 'roughness' | 'metalness' | 'specularIntensity' | 'ior' | 'std';

/** What a merged draw reads per vertex: up to four numbers (gunPartMat), the specular colour (gunPartSpec). */
interface Layout {
  scalars: Scalar[];
  spec: boolean;
}

/** One material per set of merged materials: every copy of the same gun shares it (and its program). */
const hosts = new Map<string, { material: THREE.Material; layout: Layout | null } | null>();

function hostFor(mats: Mat[]): { material: THREE.Material; layout: Layout | null } | null {
  const key = mats.map(idOf).join(',');
  if (hosts.has(key)) return hosts.get(key)!;
  const phys = mats.filter((m) => m.isMeshPhysicalMaterial);
  const differs = (list: Mat[], f: (m: Mat) => unknown) => list.some((m) => f(m) !== f(list[0]));
  const scalars: Scalar[] = [];
  if (differs(mats, (m) => m.roughness)) scalars.push('roughness');
  if (differs(mats, (m) => m.metalness)) scalars.push('metalness');
  if (differs(phys, (m) => m.specularIntensity)) scalars.push('specularIntensity');
  if (differs(phys, (m) => m.ior)) scalars.push('ior');
  if (phys.length && phys.length < mats.length) scalars.push('std');
  const spec = phys.some((m) => !m.specularColor.equals(phys[0].specularColor));
  let host: { material: THREE.Material; layout: Layout | null } | null;
  if (!scalars.length && !spec) {
    // Nothing differs: the first one draws them all.
    host = { material: mats[0], layout: null };
  } else if (scalars.length > 4) {
    host = null;
  } else {
    const layout = { scalars, spec };
    // A Physical one when any is (its specular settings are the shared uniforms the per-vertex
    // ones don't replace), else Standard.
    const material = (phys[0] ?? mats[0]).clone();
    material.name = 'gunParts';
    material.onBeforeCompile = patch(layout);
    const tag = `gunParts|${scalars.join(',')}${spec ? '|spec' : ''}`;
    material.customProgramCacheKey = () => tag;
    host = { material, layout };
  }
  hosts.set(key, host);
  return host;
}

const C = THREE.ShaderChunk as unknown as Record<string, string>;
const ROUGH = 'float roughnessFactor = roughness;';
const METAL = 'float metalnessFactor = metalness;';
const IOR = 'material.ior = ior;';
const SPEC_I = 'float specularIntensityFactor = specularIntensity;';
const SPEC_C = 'vec3 specularColorFactor = specularColor;';

/** lights_physical_fragment cut round its `#ifdef IOR … #else … #endif` (the Physical and Standard specular). */
function iorBlock(src: string): { head: string; ior: string; std: string; tail: string } | null {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim() === '#ifdef IOR');
  if (start < 0) return null;
  let depth = 0;
  let mid = -1;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#if')) depth++;
    else if (t === '#else' && depth === 1) mid = i;
    else if (t === '#endif' && --depth === 0) {
      if (mid < 0) return null;
      const part = (a: number, b: number) => lines.slice(a, b).join('\n');
      return { head: part(0, start), ior: part(start + 1, mid), std: part(mid + 1, i), tail: part(i + 1, lines.length) };
    }
  }
  return null;
}

const once = (s: string | undefined, find: string) => !!s && s.indexOf(find) >= 0 && s.indexOf(find) === s.lastIndexOf(find);

let known: boolean | undefined;

/** The shader text this patch edits is what it was written against (three r186); else no merging. */
function chunksKnown(): boolean {
  if (known !== undefined) return known;
  const L = THREE.ShaderLib as unknown as Record<string, { vertexShader: string; fragmentShader: string }>;
  const b = iorBlock(C.lights_physical_fragment);
  known =
    once(C.roughnessmap_fragment, ROUGH) &&
    once(C.metalnessmap_fragment, METAL) &&
    !!b &&
    [IOR, SPEC_I, SPEC_C].every((s) => once(b.ior, s)) &&
    ['standard', 'physical'].every(
      (k) =>
        ['#include <common>', '#include <begin_vertex>'].every((s) => once(L[k]?.vertexShader, s)) &&
        ['#include <common>', '#include <roughnessmap_fragment>', '#include <metalnessmap_fragment>', '#include <lights_physical_fragment>'].every((s) => once(L[k]?.fragmentShader, s)),
    );
  if (!known) console.warn('GunMerge: unexpected three shader chunks; soldiers keep one gun mesh per material');
  return known;
}

/** The shared program: the per-vertex numbers in place of the uniforms they stand for. */
function patch(l: Layout): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  const k = l.scalars.length;
  const type = ['float', 'float', 'vec2', 'vec3', 'vec4'][k];
  const of = (f: Scalar) => (k === 1 ? 'vGunPartMat' : `vGunPartMat.${'xyzw'[l.scalars.indexOf(f)]}`);
  const has = (f: Scalar) => l.scalars.includes(f);
  let vary = '';
  let set = '';
  if (k) {
    vary += `flat varying ${type} vGunPartMat;\n`;
    set += 'vGunPartMat = gunPartMat;\n';
  }
  if (l.spec) {
    vary += 'flat varying vec3 vGunPartSpec;\n';
    set += 'vGunPartSpec = gunPartSpec;\n';
  }
  const attrs = (k ? `attribute ${type} gunPartMat;\n` : '') + (l.spec ? 'attribute vec3 gunPartSpec;\n' : '');
  return (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', () => `#include <common>\n${attrs}${vary}`)
      .replace('#include <begin_vertex>', () => `#include <begin_vertex>\n${set}`);
    let f = shader.fragmentShader.replace('#include <common>', () => `#include <common>\n${vary}`);
    if (has('roughness')) f = f.replace('#include <roughnessmap_fragment>', () => C.roughnessmap_fragment.replace(ROUGH, () => `float roughnessFactor = ${of('roughness')};`));
    if (has('metalness')) f = f.replace('#include <metalnessmap_fragment>', () => C.metalnessmap_fragment.replace(METAL, () => `float metalnessFactor = ${of('metalness')};`));
    if (has('specularIntensity') || has('ior') || has('std') || l.spec) f = f.replace('#include <lights_physical_fragment>', () => specular(l, of, has));
    shader.fragmentShader = f;
  };
}

/**
 * The Physical specular block reading its numbers per vertex. A Standard piece (std) runs the
 * Standard block word for word: F0 0.04 and F90 1, as its own program would.
 */
function specular(l: Layout, of: (f: Scalar) => string, has: (f: Scalar) => boolean): string {
  const b = iorBlock(C.lights_physical_fragment)!;
  let ior = b.ior;
  if (has('ior')) ior = ior.replace(IOR, () => `material.ior = ${of('ior')};`);
  if (has('specularIntensity')) ior = ior.replace(SPEC_I, () => `float specularIntensityFactor = ${of('specularIntensity')};`);
  if (l.spec) ior = ior.replace(SPEC_C, () => 'vec3 specularColorFactor = vGunPartSpec;');
  if (has('std')) ior = `\tif ( ${of('std')} > 0.5 ) {\n${b.std}\n\t} else {\n${ior}\n\t}`;
  return `${b.head}\n#ifdef IOR\n${ior}\n#else\n${b.std}\n#endif\n${b.tail}`;
}
