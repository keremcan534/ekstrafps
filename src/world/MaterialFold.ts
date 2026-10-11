import * as THREE from 'three';

/**
 * Fold engine: a room draws every material of a "class" in one draw call.
 *
 * A class is a set of opaque MeshStandardMaterials that differ only in scalars (colour,
 * emissive × intensity, roughness, metalness, the luma normaliser) and share their texture
 * objects (or have none). One host material draws them all; every vertex carries the index
 * of its own material, and the vertex stage looks that material's values up in a uniform
 * table holding exactly the float32 values three would have uploaded for it (flat varyings,
 * so nothing is interpolated). The original materials stay what the rest of the game talks
 * to: lamps dimmed by a blackout, flickering LEDs, Survival's lift lights. The table is
 * re-read from them before each render, and re-sent to the GPU only when a value changed
 * (core/UniformCache).
 *
 * Ties: Site-9's coplanar overlays win their depth ties only because three draws opaque
 * materials in id order (LessEqual: the later draw wins). Inside a fold draw the materials
 * come in id order too (later triangles win ties within a draw), and the host is a material
 * whose id sits in the right place among the others (see Site9), so every tie resolves as
 * before. dev/foldOrderCheck proves it for the built map.
 *
 * Shadows: the map's builders give the shadow casters (b) and the ceiling pieces (no cast)
 * their own meshes. While no shadow map renders, casting doesn't matter, so a room draws
 * one mesh per class ("all"); with shadows it draws one per (cast, receive) pair. Both sets
 * share one vertex buffer and differ only in their index (Site9.setShadowMode).
 */

const params = (): URLSearchParams => new URLSearchParams((globalThis as { location?: { search?: string } }).location?.search ?? '');
/**
 * ?nofold: the map built the old way (one draw per material, the ARM texture read three
 * times, shutters drawn with no room): the reference for an A/B of the picture.
 */
export const foldEnabled = (): boolean => !params().has('nofold');
/**
 * ?nofoldstatic: Survival's and Utilities' static pieces keep their own meshes (the one fold
 * step that bakes object transforms on the CPU, so vertices can move by a float32 ulp).
 */
export const foldStaticEnabled = (): boolean => foldEnabled() && !params().has('nofoldstatic');

let ownSeed = 0x2545f491;
const ownRandom = (): number => (ownSeed = (Math.imul(ownSeed, 1664525) + 1013904223) >>> 0) / 4294967296;

/**
 * Run `fn` with Math.random on a private sequence. three gives every geometry, mesh and
 * material a random UUID, and the fold makes a different number of them than the
 * one-mesh-per-material build: kept off the game's own stream, everything drawn from it
 * after the map (Survival's placements, the AI) comes out the same with ?nofold and without,
 * so a seeded A/B builds the same world.
 */
export function withOwnRandom<T>(fn: () => T): T {
  const game = Math.random;
  Math.random = ownRandom;
  try {
    return fn();
  } finally {
    Math.random = game;
  }
}

/** A shader patch that finds nothing to replace would draw the wrong picture: loud in dev. */
function patchFailed(what: string): void {
  const msg = `MaterialFold: shader patch "${what}" matched nothing (three's chunk text changed?)`;
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) throw new Error(msg);
  console.error(msg);
}

/** Replace the first `from` in `src`, or report it. */
export function swapOnce(src: string, from: string, to: string, what: string): string {
  const i = src.indexOf(from);
  if (i < 0) {
    patchFailed(what);
    return src;
  }
  return src.slice(0, i) + to + src.slice(i + from.length);
}

/** Expand a chunk include in place (so a patch can edit what it says), if it is still there. */
function expand(src: string, chunk: string): string {
  const inc = `#include <${chunk}>`;
  return src.includes(inc) ? src.replace(inc, (THREE.ShaderChunk as unknown as Record<string, string>)[chunk]) : src;
}

const defaultCompile = THREE.Material.prototype.onBeforeCompile;
const defaultKey = THREE.Material.prototype.customProgramCacheKey;

/** The shader patches a material carries that the fold knows (grime, luma, ARM), or null for one it doesn't. */
interface Patches {
  /** 'grime' / 'grime-lite' (fx/WorldGrime), '' for none. */
  grime: string;
  luma: boolean;
  arm: boolean;
}
function patchesOf(m: THREE.MeshStandardMaterial): Patches | null {
  if (m.onBeforeCompile === defaultCompile && m.customProgramCacheKey === defaultKey) return { grime: '', luma: false, arm: false };
  if (!m.userData.grime) return null;
  const parts = m.customProgramCacheKey().split('|');
  const grime = parts[0];
  if (grime !== 'grime' && grime !== 'grime-lite') return null;
  const luma = m.userData.lumaNorm !== undefined;
  const arm = !!m.userData.arm1;
  // The key says exactly what the patches are: anything else on it is a patch we don't know.
  const want = [grime, ...(luma ? ['luma'] : []), ...(arm ? ['arm1'] : [])].join('|');
  return want === parts.join('|') ? { grime, luma, arm } : null;
}

/** Everything about a material that changes its program or its pipeline state must match the host's. */
function sameRender(a: THREE.MeshStandardMaterial, b: THREE.MeshStandardMaterial): boolean {
  return (
    !(a as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial &&
    !(b as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial &&
    a.visible && !a.transparent && a.opacity === 1 && a.alphaTest === 0 && !a.alphaHash && !a.alphaToCoverage &&
    a.side === b.side && a.shadowSide === b.shadowSide && a.blending === THREE.NormalBlending && b.blending === THREE.NormalBlending &&
    a.depthTest === b.depthTest && a.depthWrite === b.depthWrite && a.depthFunc === b.depthFunc && a.colorWrite === b.colorWrite &&
    a.polygonOffset === b.polygonOffset && !a.polygonOffset && a.stencilWrite === b.stencilWrite && !a.stencilWrite &&
    a.fog === b.fog && a.toneMapped === b.toneMapped && a.flatShading === b.flatShading && a.wireframe === b.wireframe &&
    a.dithering === b.dithering && a.premultipliedAlpha === b.premultipliedAlpha && a.forceSinglePass === b.forceSinglePass &&
    a.envMap === b.envMap && a.envMapIntensity === b.envMapIntensity && a.lightMap === null && b.lightMap === null &&
    a.bumpMap === null && a.displacementMap === null && a.alphaMap === null &&
    JSON.stringify(a.defines) === JSON.stringify(b.defines) && a.clippingPlanes === b.clippingPlanes && a.precision === b.precision &&
    a.normalMapType === b.normalMapType
  );
}

const black = (c: THREE.Color): boolean => c.r === 0 && c.g === 0 && c.b === 0;

/** three's material id: the opaque pass draws in this order (left out of the type declarations). */
export const materialId = (m: THREE.Material): number => (m as unknown as { id: number }).id;

export type FoldSource = 'b' | 'ceil' | 'clear' | 'obj';

/** Members per class. Plain / emissive solids: two vec4 each in the vertex stage, well inside WebGL2's 256-vector minimum next to three's own. */
const SOLID_CAP = 64;
const TEX_CAP = 8;

/** One class: its host, its member materials and the uniform table the vertex stage reads. */
export class FoldClass {
  readonly members: THREE.MeshStandardMaterial[] = [];
  /** vec4s per member: [colour, metalness], [emissive × intensity, roughness] (+ [luma normaliser] in texture classes). */
  readonly stride: number;
  readonly cap: number;
  readonly tab: Float32Array;
  /** Bumped whenever a value in `tab` changes: core/UniformCache re-sends the table to a program only then. */
  version = 1;
  /** Shared by every mesh of the class: the table is brought up to date once per render, before its first draw. */
  readonly onBeforeRender: (renderer: THREE.WebGLRenderer) => void;
  private entries = new Map<THREE.Material, number>();
  private memberFlags: number[] = [];
  private frame = -1;
  private hostPatches: Patches;
  private installed = false;
  /** Vertex-colour members exist (the solid class: the map's vertex-coloured merge material). */
  private vcolor: boolean;

  constructor(
    readonly key: string,
    readonly host: THREE.MeshStandardMaterial,
    /** Untextured class (plain and emissive solids) or a texture class (members share the host's texture objects). */
    readonly solid: boolean,
    readonly sources: readonly FoldSource[],
  ) {
    const p = patchesOf(host);
    if (!p) throw new Error(`MaterialFold: host of '${key}' carries a shader patch the fold doesn't know`);
    this.hostPatches = p;
    this.vcolor = host.vertexColors;
    // Luma members read their own normaliser: texture classes keep a third vec4 for it.
    this.stride = solid ? 2 : 3;
    this.cap = solid ? SOLID_CAP : TEX_CAP;
    this.tab = new Float32Array(this.cap * this.stride * 4);
    foldTables.set(this.tab, this);
    this.onBeforeRender = (renderer) => {
      const f = renderer.info.render.frame;
      if (f === this.frame) return;
      this.frame = f;
      this.sync();
    };
  }

  /** Can `m` (coming from builder / object `src`) be drawn by this class? */
  accepts(mat: THREE.Material, src: FoldSource): boolean {
    const m = mat as THREE.MeshStandardMaterial;
    if (!this.sources.includes(src) || !m.isMeshStandardMaterial) return false;
    if (!this.entries.has(m) && this.members.length >= this.cap) return false;
    const h = this.host;
    if (!sameRender(m, h)) return false;
    const p = m === h ? this.hostPatches : patchesOf(m);
    if (!p) return false;
    // A grimed member needs the host's grime code (same flavour); an ungrimed one gates it off.
    if (p.grime && p.grime !== this.hostPatches.grime) return false;
    if (p.arm !== this.hostPatches.arm) return false;
    if (m.vertexColors && !this.vcolor) return false;
    if (this.solid) {
      return !m.map && !m.emissiveMap && !m.aoMap && !m.roughnessMap && !m.metalnessMap && !m.normalMap && !p.luma;
    }
    if (m.vertexColors) return false;
    // Texture classes: the very same texture objects (same sampler state, same transforms).
    // A member without the host's emissive map is fine only while its emissive is black
    // (0 × texel = 0): the atlas's plain signs next to its glowing panels.
    const emissiveOk = m.emissiveMap === h.emissiveMap || (m.emissiveMap === null && black(m.emissive));
    return (
      m.map === h.map && emissiveOk && m.aoMap === h.aoMap && m.roughnessMap === h.roughnessMap && m.metalnessMap === h.metalnessMap &&
      m.normalMap === h.normalMap && m.normalScale.equals(h.normalScale) && m.aoMapIntensity === h.aoMapIntensity
    );
  }

  /** `m`'s place in the table (added on first use). Call only after accepts(). */
  entry(m: THREE.MeshStandardMaterial): number {
    let e = this.entries.get(m);
    if (e !== undefined) return e;
    e = this.members.length;
    this.entries.set(m, e);
    this.members.push(m);
    const p = (m === this.host ? this.hostPatches : patchesOf(m))!;
    this.memberFlags.push((m.vertexColors ? 1 : 0) | (p.grime ? 2 : 0) | (p.luma ? 4 : 0));
    if (this.stride > 2) this.tab[e * this.stride * 4 + 8] = p.luma ? (m.userData.lumaNorm as number) : 0;
    this.sync();
    return e;
  }

  /** The per-vertex value: member index × 8 + flags (1 vertex colour, 2 grime, 4 luma). */
  vertexValue(m: THREE.MeshStandardMaterial): number {
    const e = this.entry(m);
    return e * 8 + this.memberFlags[e];
  }

  /**
   * Copy every member's current values into the table, exactly as three would upload them
   * (refreshUniformsCommon: emissive = copy(emissive).multiplyScalar(emissiveIntensity)).
   */
  sync(): void {
    const t = this.tab;
    const s = this.stride * 4;
    let changed = false;
    for (let i = 0, n = this.members.length; i < n; i++) {
      const m = this.members[i];
      const o = i * s;
      const c = m.color;
      const e = m.emissive;
      const k = m.emissiveIntensity;
      changed = put(t, o, c.r) || changed;
      changed = put(t, o + 1, c.g) || changed;
      changed = put(t, o + 2, c.b) || changed;
      changed = put(t, o + 3, m.metalness) || changed;
      changed = put(t, o + 4, e.r * k) || changed;
      changed = put(t, o + 5, e.g * k) || changed;
      changed = put(t, o + 6, e.b * k) || changed;
      changed = put(t, o + 7, m.roughness) || changed;
    }
    if (changed) this.version++;
  }

  /** Patch the host's shader (after its own patches) to read every value from the table. Once, after the map is built. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const host = this.host;
    const prev = host.onBeforeCompile;
    const base = host.customProgramCacheKey === defaultKey ? 'std' : host.customProgramCacheKey();
    const key = `${base}|fold:${this.key}:${this.cap}x${this.stride}`;
    host.onBeforeCompile = (shader, renderer) => {
      prev.call(host, shader, renderer);
      this.patch(shader);
    };
    host.customProgramCacheKey = () => key;
    host.needsUpdate = true;
  }

  private uniform = { value: null as Float32Array | null };

  private patch(shader: THREE.WebGLProgramParametersWithUniforms): void {
    this.uniform.value = this.tab;
    shader.uniforms.foldTab = this.uniform;
    const n = this.cap * this.stride;
    const S = this.stride;
    const luma = S > 2 ? 'foldTab[ foldE + 2 ].x' : '0.0';
    let vs = shader.vertexShader;
    vs = swapOnce(
      vs,
      '#include <common>',
      `#include <common>
attribute float foldIdx;
uniform vec4 foldTab[ ${n} ];
flat varying vec4 vFoldA;
flat varying vec4 vFoldB;
flat varying vec4 vFoldF;`,
      'vertex: declarations',
    );
    // Flat: the values reach every pixel exactly as stored (no interpolation).
    vs = swapOnce(
      vs,
      '#include <begin_vertex>',
      `#include <begin_vertex>
int foldI = int( foldIdx );
int foldE = ( foldI >> 3 ) * ${S};
vFoldA = foldTab[ foldE ];
vFoldB = foldTab[ foldE + 1 ];
vFoldF = vec4( float( foldI & 1 ), float( ( foldI >> 1 ) & 1 ), float( ( foldI >> 2 ) & 1 ), ${luma} );`,
      'vertex: table lookup',
    );
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = swapOnce(fs, '#include <common>', '#include <common>\nflat varying vec4 vFoldA;\nflat varying vec4 vFoldB;\nflat varying vec4 vFoldF;', 'fragment: declarations');
    fs = swapOnce(fs, 'vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vFoldA.rgb, opacity );', 'fragment: diffuse');
    fs = swapOnce(fs, 'vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vFoldB.rgb;', 'fragment: emissive');
    if (this.vcolor) {
      // Only the vertex-coloured members multiply by vColor: the others take the table colour
      // as their old uniform, with no interpolated 1.0 in the product.
      fs = swapOnce(
        fs,
        '#include <color_fragment>',
        `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	if ( vFoldF.x > 0.5 ) diffuseColor *= vColor;
#endif`,
        'fragment: vertex colour gate',
      );
    }
    fs = expand(fs, 'roughnessmap_fragment');
    fs = expand(fs, 'metalnessmap_fragment');
    fs = swapOnce(fs, 'float roughnessFactor = roughness;', 'float roughnessFactor = vFoldB.a;', 'fragment: roughness');
    fs = swapOnce(fs, 'float metalnessFactor = metalness;', 'float metalnessFactor = vFoldA.a;', 'fragment: metalness');
    if (this.hostPatches.grime) {
      // Ungrimed members: dirt and wetness × 0 leave colour and roughness untouched, bit for bit.
      if (!fs.includes('GRIME_GATE')) patchFailed('fragment: grime gate hooks');
      fs = '#define GRIME_GATE vFoldF.y\n' + fs;
    }
    if (!this.solid && this.members.some((m) => m.userData.lumaNorm !== undefined)) {
      // Luma members (fx/Surfaces) take only the photo's light and dark, each with its own
      // normaliser; photo members multiply the texel as three does. One fetch for both.
      const mix = `#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	if ( vFoldF.z > 0.5 ) {
		float lumaD = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) * vFoldF.w;
		diffuseColor.rgb *= mix( 1.0, clamp( lumaD, 0.15, 2.2 ), 0.85 );
	} else {
		diffuseColor *= sampledDiffuseColor;
	}
#endif`;
      const own = this.hostPatches.luma ? lumaHook : '#include <map_fragment>';
      fs = swapOnce(fs, own, mix, 'fragment: luma / photo map');
    }
    shader.fragmentShader = fs;
  }
}

/** The luma stage fx/Surfaces writes (it registers it here so the fold can swap it whole). */
let lumaHook = '\u0000';
export function setLumaHook(code: string): void {
  lumaHook = code;
}

/** Store a float as three would send it (float32); report whether it changed. */
function put(t: Float32Array, i: number, v: number): boolean {
  if (t[i] === Math.fround(v)) return false;
  t[i] = v;
  return true;
}

/** Tables by their array (core/UniformCache asks for the version of the one it is about to send). */
const foldTables = new WeakMap<Float32Array, FoldClass>();
export function foldTableVersion(tab: unknown): number {
  return foldTables.get(tab as Float32Array)?.version ?? -1;
}

/** The classes of a map, in the order they are asked. */
export class FoldRegistry {
  readonly classes: FoldClass[] = [];

  add(key: string, host: THREE.MeshStandardMaterial, solid: boolean, sources: readonly FoldSource[]): FoldClass {
    const c = new FoldClass(key, host, solid, sources);
    this.classes.push(c);
    return c;
  }

  /** The class `m` folds into when it comes from `src`, or null (it keeps its own draw). */
  classify(m: THREE.Material, src: FoldSource): FoldClass | null {
    for (const c of this.classes) if (c.accepts(m, src)) return c;
    return null;
  }

  /** Is `m` the host of a class (its program then expects the fold's vertex data)? */
  isHost(m: THREE.Material): boolean {
    return this.classes.some((c) => c.host === m);
  }

  install(): void {
    for (const c of this.classes) c.install();
  }
}

// ---------------------------------------------------------------- ties

interface PlaneTri {
  n: THREE.Vector3;
  d: number;
  /** Projected on the plane's dominant axes. */
  p: number[];
  tag: number;
}

const tv0 = new THREE.Vector3();
const tv1 = new THREE.Vector3();
const tn = new THREE.Vector3();

/**
 * Exact depth ties between a few triangles and many: coplanar (within 0.2 mm), facing the
 * same way and overlapping. The few are bucketed by plane, the many looked up. Same
 * tolerances as dev/foldOrderCheck.
 */
export class TieFinder {
  /** By quantised normal, then by quantised plane distance. */
  private buckets = new Map<number, Map<number, PlaneTri[]>>();
  /** Around everything added: a triangle outside can't tie with any of it. */
  private box = new THREE.Box3();
  private meshBox = new THREE.Box3();

  private plane(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): { n: THREE.Vector3; d: number } | null {
    tn.crossVectors(tv0.subVectors(b, a), tv1.subVectors(c, a));
    const len = tn.length();
    if (len < 2e-7) return null;
    tn.divideScalar(len);
    return { n: tn, d: tn.dot(a) };
  }

  private static normalKey(n: THREE.Vector3): number {
    return (Math.round(n.x * 200) + 200) * 160801 + (Math.round(n.y * 200) + 200) * 401 + Math.round(n.z * 200) + 200;
  }

  /** Could `mesh` (world space) touch anything added? */
  near(mesh: THREE.Mesh): boolean {
    if (this.box.isEmpty()) return false;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return this.meshBox.copy(g.boundingBox!).applyMatrix4(mesh.matrixWorld).expandByScalar(1e-3).intersectsBox(this.box);
  }

  private static project(n: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number[] {
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    const out: number[] = [];
    for (const v of [a, b, c]) {
      if (ax >= ay && ax >= az) out.push(v.y, v.z);
      else if (ay >= az) out.push(v.x, v.z);
      else out.push(v.x, v.y);
    }
    return out;
  }

  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, tag: number): void {
    const pl = this.plane(a, b, c);
    if (!pl) return;
    this.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    const nk = TieFinder.normalKey(pl.n);
    let byD = this.buckets.get(nk);
    if (!byD) this.buckets.set(nk, (byD = new Map()));
    const dk = Math.round(pl.d * 2000);
    let list = byD.get(dk);
    if (!list) byD.set(dk, (list = []));
    list.push({ n: pl.n.clone(), d: pl.d, p: TieFinder.project(pl.n, a, b, c), tag });
  }

  /** Add the tags of the triangles that tie with (a, b, c) to `out`. */
  test(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: Set<number>): void {
    const m = this.box;
    const e = 1e-3;
    if (Math.max(a.x, b.x, c.x) < m.min.x - e || Math.min(a.x, b.x, c.x) > m.max.x + e) return;
    if (Math.max(a.y, b.y, c.y) < m.min.y - e || Math.min(a.y, b.y, c.y) > m.max.y + e) return;
    if (Math.max(a.z, b.z, c.z) < m.min.z - e || Math.min(a.z, b.z, c.z) > m.max.z + e) return;
    const pl = this.plane(a, b, c);
    if (!pl) return;
    const byD = this.buckets.get(TieFinder.normalKey(pl.n));
    if (!byD) return;
    const dk = Math.round(pl.d * 2000);
    for (let k = dk - 1; k <= dk + 1; k++) {
      const list = byD.get(k);
      if (!list) continue;
      for (const t of list) {
        if (out.has(t.tag) || Math.abs(t.d - pl.d) > 2e-4 || t.n.dot(pl.n) < 0.9999) continue;
        if (overlap2(t.p, TieFinder.project(t.n, a, b, c))) out.add(t.tag);
      }
    }
  }
}

/** Two projected triangles share area (separating axis test, edges of both). */
function overlap2(A: number[], B: number[]): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const ax = -(P[j * 2 + 1] - P[i * 2 + 1]);
      const ay = P[j * 2] - P[i * 2];
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const sa = A[k * 2] * ax + A[k * 2 + 1] * ay;
        const sb = B[k * 2] * ax + B[k * 2 + 1] * ay;
        amin = Math.min(amin, sa);
        amax = Math.max(amax, sa);
        bmin = Math.min(bmin, sb);
        bmax = Math.max(bmax, sb);
      }
      const len = Math.hypot(ax, ay) || 1;
      if (amax <= bmin + 1e-5 * len || bmax <= amin + 1e-5 * len) return false;
    }
  }
  return true;
}

/** Call fn(a, b, c) for every triangle of a mesh, in world space. */
export function eachTriangle(mesh: THREE.Mesh, fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => void): void {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = (idx ? idx.count : pos.count) / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    a.fromBufferAttribute(pos, idx ? idx.getX(3 * t) : 3 * t).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, idx ? idx.getX(3 * t + 1) : 3 * t + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, idx ? idx.getX(3 * t + 2) : 3 * t + 2).applyMatrix4(mesh.matrixWorld);
    fn(a, b, c);
  }
}

// ---------------------------------------------------------------- geometry

/** One material's triangles inside a fold: where its vertices are, where it came from. */
export interface FoldRun {
  mat: THREE.MeshStandardMaterial;
  /** 'b' / 'ceil' / 'clear' (the room's builders) or 'obj:<mesh id>' (a folded Survival piece). */
  src: string;
  castShadow: boolean;
  receiveShadow: boolean;
  /** Vertex range in the fold's buffers (three vertices per triangle). */
  start: number;
  count: number;
  /** Place in the draw (runs draw in material id order). */
  rank: number;
}

/** One builder's share of a room. */
export interface FoldInput {
  src: 'b' | 'ceil' | 'clear';
  parts: Map<THREE.Material, THREE.BufferGeometry[]>;
  castShadow: boolean;
  receiveShadow: boolean;
}

/** Visibility of a fold mesh: 0 always, 1 only while no shadow map renders, 2 only while one does. */
export type FoldMode = 0 | 1 | 2;

/** A fold's mesh and when it draws. */
export interface FoldMesh {
  mesh: THREE.Mesh;
  mode: FoldMode;
}

/** A piece of geometry handed to RoomFold.append (world space, triangle soup). */
export interface FoldPiece {
  mat: THREE.MeshStandardMaterial;
  src: string;
  castShadow: boolean;
  receiveShadow: boolean;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array | null;
}

/**
 * Take every material a class can draw out of the builders' parts and build one fold per
 * class (its meshes go into `parent`). What is left in the parts is built as before.
 */
export function buildFolds(parent: THREE.Object3D, registry: FoldRegistry, inputs: FoldInput[], solidAlways: boolean): RoomFold[] {
  const byClass = new Map<FoldClass, { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[]; input: FoldInput }[]>();
  for (const input of inputs) {
    for (const [mat, geos] of [...input.parts]) {
      const cls = registry.classify(mat, input.src);
      if (!cls) continue;
      // Its table entry now, so the next material's check sees a full table as full.
      cls.entry(mat as THREE.MeshStandardMaterial);
      input.parts.delete(mat);
      let list = byClass.get(cls);
      if (!list) byClass.set(cls, (list = []));
      list.push({ mat: mat as THREE.MeshStandardMaterial, geos, input });
    }
  }
  const out: RoomFold[] = [];
  for (const [cls, list] of byClass) out.push(new RoomFold(parent, cls, list, solidAlways && cls.solid));
  return out;
}

const pairKey = (cast: boolean, recv: boolean): number => (cast ? 2 : 0) + (recv ? 1 : 0);

/** A room's share of one class: its runs, the shared vertex buffers and the meshes that draw them. */
export class RoomFold {
  /** In buffer order (appended pieces come last); `rank` gives the draw order. */
  readonly runs: FoldRun[] = [];
  readonly meshes: FoldMesh[] = [];
  /** Leak pieces cut from this fold's meshes (Site9.shareLeaks): they share the buffers. */
  readonly leaks: THREE.Mesh[] = [];
  /** The shadow-less mesh (null when one mesh serves both modes). */
  all: THREE.Mesh | null = null;
  private attrs: Record<string, THREE.BufferAttribute> = {};
  private vertices = 0;

  constructor(
    readonly parent: THREE.Object3D,
    readonly cls: FoldClass,
    list: { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[]; input: FoldInput }[],
    /** Keep a separate shadow-less mesh even with one (cast, receive) pair (Survival pieces fold into it). */
    alwaysAll: boolean,
  ) {
    // Material id order; the same id from b before ceil (stable sort, inputs in that order).
    const sorted = [...list].sort((a, b) => materialId(a.mat) - materialId(b.mat));
    let n = 0;
    for (const r of sorted) for (const g of r.geos) n += g.getAttribute('position').count;
    const solid = cls.solid;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = solid ? null : new Float32Array(n * 2);
    const col = solid ? new Float32Array(n * 3) : null;
    const idx = new Uint16Array(n);
    let v = 0;
    sorted.forEach((r, rank) => {
      const start = v;
      const value = cls.vertexValue(r.mat);
      for (const g of r.geos) {
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        const c = p.count;
        pos.set(p.array as Float32Array, v * 3);
        nor.set(g.getAttribute('normal').array as Float32Array, v * 3);
        if (uv) uv.set(g.getAttribute('uv').array as Float32Array, v * 2);
        const gc = g.getAttribute('color');
        if (r.mat.vertexColors && (!gc || gc.itemSize !== 3 || !col)) throw new Error('MaterialFold: a vertex-coloured member needs RGB vertex colours');
        if (col && gc) col.set(gc.array as Float32Array, v * 3);
        idx.fill(value, v, v + c);
        v += c;
        g.dispose();
      }
      this.runs.push({ mat: r.mat, src: r.input.src, castShadow: r.input.castShadow, receiveShadow: r.input.receiveShadow, start, count: v - start, rank });
    });
    this.vertices = n;
    this.attrs = this.makeAttrs(pos, nor, uv, col, idx);
    const pairs = new Set(this.runs.map((r) => pairKey(r.castShadow, r.receiveShadow)));
    if (pairs.size === 1 && !alwaysAll) {
      const r = this.runs[0];
      this.addMesh(this.geometry(null), r.castShadow, r.receiveShadow, 0);
      return;
    }
    // Drawn while no shadow map renders: every run in one draw (cast / receive don't matter then).
    this.all = this.addMesh(this.geometry(null), false, true, 1);
    for (const k of [...pairs].sort((a, b) => b - a)) {
      const tri: number[] = [];
      for (const r of this.runs) if (pairKey(r.castShadow, r.receiveShadow) === k) for (let i = r.start; i < r.start + r.count; i++) tri.push(i);
      this.addMesh(this.geometry(tri), (k & 2) !== 0, (k & 1) !== 0, 2);
    }
  }

  private makeAttrs(pos: Float32Array, nor: Float32Array, uv: Float32Array | null, col: Float32Array | null, idx: Uint16Array): Record<string, THREE.BufferAttribute> {
    const a: Record<string, THREE.BufferAttribute> = {
      position: new THREE.BufferAttribute(pos, 3),
      normal: new THREE.BufferAttribute(nor, 3),
      foldIdx: new THREE.BufferAttribute(idx, 1),
    };
    if (uv) a.uv = new THREE.BufferAttribute(uv, 2);
    if (col) a.color = new THREE.BufferAttribute(col, 3);
    return a;
  }

  /** A geometry over the shared buffers: every vertex in buffer order, or the listed ones. */
  private geometry(index: number[] | null): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.attrs)) g.setAttribute(name, attr);
    if (index) g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }

  private addMesh(geo: THREE.BufferGeometry, cast: boolean, recv: boolean, mode: FoldMode): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.cls.host);
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    mesh.onBeforeRender = this.cls.onBeforeRender as THREE.Mesh['onBeforeRender'];
    mesh.userData.fold = this;
    mesh.userData.foldMode = mode;
    this.parent.add(mesh);
    this.meshes.push({ mesh, mode });
    return mesh;
  }

  /** The run a vertex belongs to (dev/foldOrderCheck). */
  runAt(v: number): FoldRun | null {
    const i = this.runIndexAt(v);
    return i < 0 ? null : this.runs[i];
  }

  private runIndexAt(v: number): number {
    let lo = 0;
    let hi = this.runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.runs[mid];
      if (v < r.start) hi = mid - 1;
      else if (v >= r.start + r.count) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /**
   * Add pieces to the shadow-less mesh only (with shadows their own meshes still draw,
   * see Site9.foldStatic). They take their place in the draw by material id; the buffers
   * grow at the end, so every other mesh and leak piece of the fold keeps its index.
   */
  append(pieces: FoldPiece[]): void {
    const all = this.all;
    if (!all || !pieces.length) return;
    let add = 0;
    for (const p of pieces) add += p.position.length / 3;
    const n = this.vertices + add;
    const old = this.attrs;
    const grow = (a: THREE.BufferAttribute | undefined, size: number, Kind: Float32ArrayConstructor | Uint16ArrayConstructor) => {
      if (!a) return null;
      const arr = new Kind(n * size);
      arr.set(a.array as ArrayLike<number>);
      return arr;
    };
    const pos = grow(old.position, 3, Float32Array) as Float32Array;
    const nor = grow(old.normal, 3, Float32Array) as Float32Array;
    const uv = grow(old.uv, 2, Float32Array) as Float32Array | null;
    const col = grow(old.color, 3, Float32Array) as Float32Array | null;
    const idx = grow(old.foldIdx, 1, Uint16Array) as Uint16Array;
    let v = this.vertices;
    for (const p of pieces) {
      const c = p.position.length / 3;
      pos.set(p.position, v * 3);
      nor.set(p.normal, v * 3);
      if (col && p.color) col.set(p.color, v * 3);
      idx.fill(this.cls.vertexValue(p.mat), v, v + c);
      this.runs.push({ mat: p.mat, src: p.src, castShadow: p.castShadow, receiveShadow: p.receiveShadow, start: v, count: c, rank: 0 });
      v += c;
    }
    this.vertices = n;
    this.attrs = this.makeAttrs(pos, nor, uv, col, idx);
    // Draw order: material id, then the order the runs were made in.
    const order = this.runs.map((r, i) => i).sort((a, b) => materialId(this.runs[a].mat) - materialId(this.runs[b].mat) || a - b);
    order.forEach((ri, rank) => (this.runs[ri].rank = rank));
    // The shadow-less mesh's triangles (its own, after any leak cut, plus the new ones), run
    // by run in rank order, each run's in the order they were drawn (every triangle is three
    // consecutive vertices, so its first vertex names it).
    const g = all.geometry;
    const ix = g.getIndex()?.array ?? null;
    const firstOld = ix ? ix.length / 3 : old.position.count / 3;
    const tris = firstOld + add / 3;
    const own = new Int32Array(tris);
    const runOf = new Int32Array(tris);
    for (let i = 0; i < firstOld; i++) {
      own[i] = ix ? ix[i * 3] : i * 3;
      runOf[i] = this.runIndexAt(own[i]);
    }
    let i = firstOld;
    for (let ri = this.runs.length - pieces.length; ri < this.runs.length; ri++) {
      const r = this.runs[ri];
      for (let t = r.start; t < r.start + r.count; t += 3, i++) {
        own[i] = t;
        runOf[i] = ri;
      }
    }
    // Counting sort by rank (stable: each run keeps its triangles' order).
    const rankOf = new Int32Array(this.runs.length);
    order.forEach((ri, rank) => (rankOf[ri] = rank));
    const at = new Int32Array(this.runs.length + 1);
    for (let t = 0; t < tris; t++) at[rankOf[runOf[t]] + 1]++;
    for (let r = 0; r < this.runs.length; r++) at[r + 1] += at[r];
    const index = n > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
    for (let t = 0; t < tris; t++) {
      const k = at[rankOf[runOf[t]]]++ * 3;
      index[k] = own[t];
      index[k + 1] = own[t] + 1;
      index[k + 2] = own[t] + 2;
    }
    for (const m of [...this.meshes.map((f) => f.mesh), ...this.leaks]) for (const [name, attr] of Object.entries(this.attrs)) m.geometry.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
  }
}
