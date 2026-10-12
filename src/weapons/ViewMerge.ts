import * as THREE from 'three';
import { BATCHED_LAYER, sortAsSource } from '../core/RigidBatch';
import { swapOnce } from '../world/MaterialFold';
import type { WeaponRig } from './WeaponModels';

/**
 * The gun in hand in one draw. Its pieces are drawn on screen every frame, each a draw call of
 * its own (a body, a magazine and a bolt in each of the palette's materials: 3 to 12 draws),
 * though they share one program and one palette texture and differ only in a few numbers.
 *
 * Exact by construction, as the batches are: the pieces' vertices go into one geometry as they
 * are (each keeps its own model space), with the index of its piece and of its material. Each
 * frame the pieces' model-view, normal and model matrices, worked out as three works them out
 * (doubles, sent as float32), go up as uniform arrays and stand in (#define) for three's
 * per-object matrices in the unchanged vertex code; the GunSurface detail reads the piece's own
 * model space as before. The colour, emissive x intensity, roughness and metalness three would
 * upload for each material sit in a table (float32) and reach the fragment stage flat, in place
 * of the four uniforms at their only reads. A hidden piece (its node or one above it) is moved
 * outside the clip volume: it draws nothing, as when three skips it. The pieces stay where they
 * are, on a layer the gun's camera doesn't see, so the game still moves and hides them.
 *
 * Only pieces three would draw with the same program and uniforms but those four are merged
 * (the same palette, sampling, grain, settings), and only across materials no other opaque
 * material of the gun's scene sits between in three's material order. The draw sorts where the
 * first piece would, and an index puts the pieces in three's own order for them each frame
 * (material, the depth of each piece's centre, object): where two pieces' faces meet at the same
 * depth, the same one wins. ?novmmerge: one by one.
 */

const MAX_PIECES = 12;
const MAX_MATS = 12;
const off = (): boolean => new URLSearchParams(location.search).has('novmmerge');

interface Piece {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Its layers outside the merge. */
  mask: number;
}

/**
 * What the four per-material values may differ in, bookkeeping no draw reads, and the GunSurface
 * hooks (each dressed material has closures of its own: compared by what they do, below).
 */
const OWN = new Set(['color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'uuid', 'id', 'name', 'userData', 'version', '_listeners', 'onBeforeCompile', 'customProgramCacheKey']);
const HOOKS = ['onBeforeRender', 'onBuild'];

function same(p: unknown, q: unknown): boolean {
  if (p === q) return true;
  if (!p || !q || typeof p !== 'object' || typeof q !== 'object') return false;
  if (Array.isArray(p) || Array.isArray(q)) {
    if (!Array.isArray(p) || !Array.isArray(q) || p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++) if (!same(p[i], q[i])) return false;
    return true;
  }
  const e = (p as { equals?: (o: unknown) => boolean }).equals;
  if (typeof e === 'function') return Object.getPrototypeOf(p) === Object.getPrototypeOf(q) && e.call(p, q);
  if (Object.getPrototypeOf(p) !== Object.prototype || Object.getPrototypeOf(q) !== Object.prototype) return false;
  const pk = Object.keys(p);
  if (pk.length !== Object.keys(q).length) return false;
  for (const k of pk) if (!same((p as Record<string, unknown>)[k], (q as Record<string, unknown>)[k])) return false;
  return true;
}

/** `a` draws with `b`'s program and uniforms but colour, emissive, roughness and metalness (GunSurface grain alike). */
function alike(a: THREE.MeshStandardMaterial, b: THREE.MeshStandardMaterial): boolean {
  if (a === b) return true;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const h of HOOKS) if (x[h] !== y[h]) return false;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!OWN.has(k) && !same(x[k], y[k])) return false;
  // The same patch (GunSurface's, the one hook a dressed material carries) with the same grain.
  if (!a.userData.gunSurface || !b.userData.gunSurface || a.customProgramCacheKey() !== b.customProgramCacheKey()) return false;
  const ga = a.userData.gunGrain as { x: number; y: number; z: number } | undefined;
  const gb = b.userData.gunGrain as { x: number; y: number; z: number } | undefined;
  return !!ga && !!gb && ga.x === gb.x && ga.y === gb.y && ga.z === gb.z;
}

/** An attribute's raw stored components (no normalisation applied: the GPU does that, as before). */
function raw(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, v: number, c: number): number {
  if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const i = a as THREE.InterleavedBufferAttribute;
    return i.data.array[v * i.data.stride + i.offset + c] as number;
  }
  return (a as THREE.BufferAttribute).array[v * a.itemSize + c] as number;
}

const arrayType = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) =>
  ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array).constructor;

/** A piece the merge can take: a plain opaque dressed (GunSurface) mesh, shown, with no children. */
function mergeable(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || !m.visible || m.children.length) return false;
  const mt = m.material as THREE.MeshStandardMaterial;
  // Physical palettes too (a set of their own: another program); nothing see-through (three gives transmission a pass of its own).
  if (Array.isArray(mt) || !mt.isMeshStandardMaterial || ((mt as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0 || !mt.userData.gunSurface) return false;
  if (mt.transparent || mt.opacity !== 1 || mt.alphaTest || !mt.visible || mt.onBeforeRender !== THREE.Material.prototype.onBeforeRender) return false;
  if (m.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || m.onAfterRender !== THREE.Object3D.prototype.onAfterRender) return false;
  const g = m.geometry;
  if (g.groups.length || Object.keys(g.morphAttributes).length || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
  return !!g.getAttribute('position') && !!g.getAttribute('normal');
}

export class ViewMerge {
  readonly mesh: THREE.Mesh;
  private readonly mv: THREE.Matrix4[] = [];
  private readonly nm: THREE.Matrix3[] = [];
  private readonly mm: THREE.Matrix4[] = [];
  private readonly show: number[] = [];
  private readonly tab = new Float32Array(MAX_MATS * 8);
  private broken = false;
  /** Each piece's vertices in the merged geometry. */
  private readonly ranges: { start: number; count: number }[] = [];
  /** The pieces in the order they are drawn now (three's: material, depth, object), and the index that says so. */
  private order: number[] = [];
  private readonly next: number[] = [];
  private readonly z: number[] = [];
  private readonly index: THREE.BufferAttribute;
  private readonly proj = new THREE.Matrix4();
  private readonly v4 = new THREE.Vector4();

  constructor(
    private readonly root: THREE.Object3D,
    private readonly pieces: Piece[],
    private readonly mats: THREE.MeshStandardMaterial[],
  ) {
    for (let i = 0; i < MAX_PIECES; i++) {
      this.mv.push(new THREE.Matrix4());
      this.nm.push(new THREE.Matrix3());
      this.mm.push(new THREE.Matrix4());
      this.show.push(0);
    }
    const geos: THREE.BufferGeometry[] = [];
    const uv = pieces.every((p) => !!p.geometry.getAttribute('uv'));
    pieces.forEach((p, i) => {
      // The piece's own vertices, in its own space, in its own triangle order.
      const src = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position'));
      g.setAttribute('normal', src.getAttribute('normal'));
      if (uv) g.setAttribute('uv', src.getAttribute('uv'));
      const n = src.getAttribute('position').count;
      g.setAttribute('vmPart', new THREE.BufferAttribute(new Float32Array(n).fill(i), 1));
      g.setAttribute('vmMat', new THREE.BufferAttribute(new Float32Array(n).fill(mats.indexOf(p.material)), 1));
      geos.push(g);
    });
    // Each attribute concatenated as stored: the same array type, the same normalisation (mergeViewRig checked they match).
    const geometry = new THREE.BufferGeometry();
    for (const name of Object.keys(geos[0].attributes)) {
      const first = geos[0].getAttribute(name);
      const size = first.itemSize;
      const total = geos.reduce((s, g) => s + g.getAttribute(name).count, 0);
      const Type = arrayType(first) as new (n: number) => THREE.TypedArray;
      const out = new Type(total * size);
      let at = 0;
      for (const g of geos) {
        const a = g.getAttribute(name);
        for (let v = 0; v < a.count; v++) for (let c = 0; c < size; c++) out[at++] = raw(a, v, c);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(out, size, first.normalized));
    }
    // The draw order goes through an index: rewritten when three's order of the pieces changes.
    let start = 0;
    for (const g of geos) {
      const count = g.getAttribute('position').count;
      this.ranges.push({ start, count });
      start += count;
    }
    this.index = new THREE.BufferAttribute(start > 65535 ? new Uint32Array(start) : new Uint16Array(start), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(this.index);
    this.order = pieces.map((_, i) => i);
    this.writeIndex();
    geometry.computeBoundingSphere();
    const src = mats[0];
    const mat = src.clone();
    const uniforms = { vmMV: { value: this.mv }, vmN: { value: this.nm }, vmM: { value: this.mm }, vmShow: { value: this.show }, vmTab: { value: this.tab } };
    mat.onBeforeCompile = (shader, renderer) => {
      src.onBeforeCompile.call(src, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      let vs = shader.vertexShader;
      vs = swapOnce(vs, '#include <common>', `#include <common>\n${VERTEX_PARS}`, 'ViewMerge: vertex declarations');
      vs = swapOnce(vs, 'void main() {', VERTEX_MAIN, 'ViewMerge: vertex main');
      vs = swapOnce(vs, '#include <project_vertex>', `#include <project_vertex>\n${VERTEX_HIDE}`, 'ViewMerge: hidden pieces');
      shader.vertexShader = vs;
      let fs = shader.fragmentShader;
      fs = swapOnce(fs, '#include <common>', '#include <common>\nflat varying vec4 vmA;\nflat varying vec4 vmB;', 'ViewMerge: fragment declarations');
      fs = expand(fs, 'roughnessmap_fragment');
      fs = expand(fs, 'metalnessmap_fragment');
      fs = swapOnce(fs, 'vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vmA.rgb, opacity );', 'ViewMerge: diffuse');
      fs = swapOnce(fs, 'vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vmB.rgb;', 'ViewMerge: emissive');
      fs = swapOnce(fs, 'float roughnessFactor = roughness;', 'float roughnessFactor = vmB.a;', 'ViewMerge: roughness');
      fs = swapOnce(fs, 'float metalnessFactor = metalness;', 'float metalnessFactor = vmA.a;', 'ViewMerge: metalness');
      shader.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => `${src.customProgramCacheKey()}|viewMerge`;
    // Drawn where three would draw the first piece (the lowest material id among them).
    sortAsSource(mat, mats.reduce((a, b) => ((a as unknown as { id: number }).id < (b as unknown as { id: number }).id ? a : b)));
    this.mesh = new THREE.Mesh(geometry, mat);
    this.mesh.name = 'ViewMerge';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = pieces[0].mesh.renderOrder;
    this.mesh.onBeforeRender = (_r, _s, camera) => this.sync(camera);
    root.add(this.mesh);
    for (const p of pieces) p.mesh.layers.mask = 1 << BATCHED_LAYER;
  }

  /**
   * Right before the draw: each piece's matrices from this render's (as three works them out
   * for an object it draws), whether it is shown, and the materials' values.
   */
  private sync(camera: THREE.Camera): void {
    if (this.broken) return;
    // three's sort depth for an object: its geometry's sphere centre through its world and the camera's view-projection.
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (p.mesh.material !== p.material || p.mesh.geometry !== p.geometry) {
        this.unmerge();
        return;
      }
      let shown = true;
      for (let o: THREE.Object3D | null = p.mesh; o && o !== this.root; o = o.parent) {
        if (!o.visible) {
          shown = false;
          break;
        }
      }
      this.show[i] = shown ? 1 : 0;
      this.mv[i].multiplyMatrices(camera.matrixWorldInverse, p.mesh.matrixWorld);
      this.nm[i].getNormalMatrix(this.mv[i]);
      this.mm[i].copy(p.mesh.matrixWorld);
      if (p.geometry.boundingSphere === null) p.geometry.computeBoundingSphere();
      this.z[i] = this.v4.copy(p.geometry.boundingSphere!.center as unknown as THREE.Vector4).applyMatrix4(p.mesh.matrixWorld).applyMatrix4(this.proj).z;
    }
    // The pieces in three's order for them (as painterSortStable: material id, depth, object id).
    const next = this.next;
    next.length = 0;
    for (let i = 0; i < this.pieces.length; i++) next.push(i);
    next.sort((a, b) => {
      const ma = (this.pieces[a].material as unknown as { id: number }).id;
      const mb = (this.pieces[b].material as unknown as { id: number }).id;
      if (ma !== mb) return ma - mb;
      if (this.z[a] !== this.z[b]) return this.z[a] - this.z[b];
      return this.pieces[a].mesh.id - this.pieces[b].mesh.id;
    });
    let changed = false;
    for (let i = 0; i < next.length; i++) if (next[i] !== this.order[i]) changed = true;
    if (changed) {
      this.order = next.slice();
      this.writeIndex();
    }
    const t = this.tab;
    for (let k = 0; k < this.mats.length; k++) {
      const m = this.mats[k];
      const o = k * 8;
      // As three uploads them: diffuse = colour, emissive = emissive x intensity.
      t[o] = m.color.r;
      t[o + 1] = m.color.g;
      t[o + 2] = m.color.b;
      t[o + 3] = m.metalness;
      t[o + 4] = m.emissive.r * m.emissiveIntensity;
      t[o + 5] = m.emissive.g * m.emissiveIntensity;
      t[o + 6] = m.emissive.b * m.emissiveIntensity;
      t[o + 7] = m.roughness;
    }
  }

  /** The index: each piece's vertices, the pieces in this.order (a piece's own triangles in their own order). */
  private writeIndex(): void {
    const idx = this.index.array as Uint16Array | Uint32Array;
    let at = 0;
    for (const i of this.order) {
      const r = this.ranges[i];
      for (let v = r.start; v < r.start + r.count; v++) idx[at++] = v;
    }
    this.index.needsUpdate = true;
  }

  /** A piece's material or geometry was swapped: its pieces are drawn one by one again, for good. */
  private unmerge(): void {
    this.broken = true;
    this.mesh.visible = false;
    for (const p of this.pieces) p.mesh.layers.mask = p.mask;
  }
}

/**
 * Merge the gun's mergeable pieces (built, before it is first shown): each set of pieces alike
 * enough (the standard palette, the physical one), two or more of them and within the uniform
 * tables' room, becomes one draw.
 */
export function mergeViewRig(rig: WeaponRig): ViewMerge[] {
  if (off()) return [];
  const all: THREE.Mesh[] = [];
  rig.root.traverse((o) => {
    if (mergeable(o)) all.push(o);
  });
  const sets: THREE.Mesh[][] = [];
  for (const m of all) {
    const mt = m.material as THREE.MeshStandardMaterial;
    const set = sets.find((s) => alike(s[0].material as THREE.MeshStandardMaterial, mt));
    if (set) set.push(m);
    else sets.push([m]);
  }
  // three draws the opaque pieces in material id order: a set merges only across materials no
  // other opaque material of the gun's scene sits between (else that one's draw would move).
  let top: THREE.Object3D = rig.root;
  while (top.parent) top = top.parent;
  const opaque = new Set<number>();
  top.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (!x.transparent) opaque.add((x as unknown as { id: number }).id);
  });
  const out: ViewMerge[] = [];
  for (const set of sets) {
    const ids = [...new Set(set.map((m) => (m.material as unknown as { id: number }).id))].sort((a, b) => a - b);
    let run: number[] = [ids[0]];
    const flush = () => {
      const v = mergeSet(rig, set.filter((m) => run.includes((m.material as unknown as { id: number }).id)));
      if (v) out.push(v);
    };
    for (let i = 1; i < ids.length; i++) {
      const between = [...opaque].some((x) => x > ids[i - 1] && x < ids[i] && !ids.includes(x));
      if (between) {
        flush();
        run = [];
      }
      run.push(ids[i]);
    }
    flush();
  }
  return out;
}

function mergeSet(rig: WeaponRig, set: THREE.Mesh[]): ViewMerge | null {
  if (set.length < 2) return null;
  // three's order for them: material id, then object id.
  const id = (o: { id: number }) => o.id;
  set.sort((a, b) => id(a.material as unknown as { id: number }) - id(b.material as unknown as { id: number }) || a.id - b.id);
  const pieces = set.slice(0, MAX_PIECES).map((mesh) => ({ mesh, geometry: mesh.geometry, material: mesh.material as THREE.MeshStandardMaterial, mask: mesh.layers.mask }));
  const mats: THREE.MeshStandardMaterial[] = [];
  for (const p of pieces) if (!mats.includes(p.material)) mats.push(p.material);
  if (mats.length > MAX_MATS || pieces.length < 2) return null;
  // Every piece stores its attributes alike (type, size, normalisation): concatenated as they are.
  const uv = pieces.every((p) => !!p.geometry.getAttribute('uv'));
  for (const name of uv ? ['position', 'normal', 'uv'] : ['position', 'normal']) {
    const a0 = pieces[0].geometry.getAttribute(name);
    for (const p of pieces) {
      const a = p.geometry.getAttribute(name);
      if (arrayType(a) !== arrayType(a0) || a.itemSize !== a0.itemSize || a.normalized !== a0.normalized) return null;
    }
  }
  return new ViewMerge(rig.root, pieces, mats);
}

function expand(src: string, chunk: string): string {
  const inc = `#include <${chunk}>`;
  return src.includes(inc) ? src.replace(inc, (THREE.ShaderChunk as unknown as Record<string, string>)[chunk]) : src;
}

const VERTEX_PARS = /* glsl */ `
attribute float vmPart;
attribute float vmMat;
uniform mat4 vmMV[ ${MAX_PIECES} ];
uniform mat3 vmN[ ${MAX_PIECES} ];
uniform mat4 vmM[ ${MAX_PIECES} ];
uniform float vmShow[ ${MAX_PIECES} ];
uniform vec4 vmTab[ ${MAX_MATS * 2} ];
flat varying vec4 vmA;
flat varying vec4 vmB;
mat4 vmModelView;
mat3 vmNormal;
mat4 vmModel;
int vmI;
`;

/** The piece's own matrices in place of the object's, its material's values, from the tables. */
const VERTEX_MAIN = /* glsl */ `
#define modelViewMatrix vmModelView
#define normalMatrix vmNormal
#define modelMatrix vmModel
void main() {
	vmI = int( vmPart );
	vmModelView = vmMV[ vmI ];
	vmNormal = vmN[ vmI ];
	vmModel = vmM[ vmI ];
	int vmJ = int( vmMat ) * 2;
	vmA = vmTab[ vmJ ];
	vmB = vmTab[ vmJ + 1 ];
`;

/** A hidden piece's vertices outside the clip volume: no fragments, as when three skips the piece. */
const VERTEX_HIDE = /* glsl */ `
if ( vmShow[ vmI ] < 0.5 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`;
