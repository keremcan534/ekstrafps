import * as THREE from 'three';
import { BATCHED_LAYER, sortAsSource } from './RigidBatch';
import { culledMeshes } from './CharacterBounds';

/**
 * The same skinned piece on many characters, in one draw: every master body of a geometry and
 * look, every PMC's plate carrier, pouches and straps. Each is a skinned mesh of its own (a draw
 * call apiece, the phone's dearest cost), yet they share geometry and material: here the copies
 * in sight go out as instances of one draw.
 *
 * Exact by construction, as RigidBatch: three gives each skinned mesh its model-view, normal and
 * model matrices, its bind matrix and its inverse as uniforms (worked out in double precision,
 * sent as float32), and its skeleton's bone matrices as a float texture. Here the same values,
 * worked out the same way, are fetched from float textures by the instance's row (the bones
 * from one texture holding every copy's skeleton) and stand in (#define) for the uniforms in the
 * unchanged skinning and vertex code. The same float32 inputs through the same expressions: the
 * same vertices and normals. The fragment shader is untouched. Which copies are drawn is decided
 * as three does (shown, on the camera's layers, inside the frustum by the same test, not culled
 * by CharacterBounds), with this render's matrices; a copy's own onBeforeRender runs when it is
 * drawn, as three would run it.
 *
 * Bones: three brings a skeleton up to date when it draws a skinned mesh; a copy in a batch
 * isn't drawn by three, so its skeleton is brought up to date in begin() (the master bodies'
 * bones are posed before the render and nothing moves them during it: the same matrices).
 * Shadow cameras still draw the copies themselves, as with RigidBatch.
 *
 * Tinted copies (the robots): each body wears a copy of one material of its own, for its hit
 * flash and its visor glow. Copies that differ from their source only in colour and emissive
 * share a draw too: the colour and emissive × intensity three would upload for each (float32)
 * travel in its row and stand in for the two uniforms, the only places the standard shader
 * reads them. A copy whose material differs in anything else is drawn as itself.
 */

/**
 * Texels per copy: model-view (4 columns), normal (3), model (4), bind (4), bind inverse (4),
 * bone base (1), and for tinted copies colour (1) and emissive × intensity (1).
 */
const ROW = 22;
/** The bones' texture: texels per row (four per bone, as three's own). */
const BONE_W = 2048;
/** As RigidBatch: copies off stage this many renders go dormant, looked at every WAKE_EVERY renders. */
const FORGET = 1800;
const WAKE_EVERY = 30;
const PROTO_BEFORE = THREE.Object3D.prototype.onBeforeRender;
const PROTO_AFTER = THREE.Object3D.prototype.onAfterRender;

interface Member {
  mesh: THREE.SkinnedMesh;
  /** Its layer mask outside the main render. */
  mask: number;
  /** Renders in a row it hasn't been on stage. */
  away: number;
  /** Tinted: the material its own is a copy of (colour and emissive its own), else null. */
  source: THREE.Material | null;
}

interface Group {
  members: Member[];
  /** The members' geometry (a copy whose mesh swaps to another one, a LOD, moves to that one's group). */
  geometry: THREE.BufferGeometry;
  /** Instances of the members' geometry under the stand-in material, skinned by the batch's bones. */
  proxy: THREE.SkinnedMesh<THREE.InstancedBufferGeometry, THREE.Material>;
  base: { value: number };
  /** Copies on stage and in sight this render (the proxy stands in only for two or more). */
  shown: Member[];
  /** Tinted copies of this material (each its own colour and emissive), else null. */
  source: THREE.Material | null;
}

const off = new URLSearchParams(location.search).has('noskinbatch');

export class SkinnedBatch {
  /** The stand-ins (in the world scene; shown only during the main render). */
  readonly group = new THREE.Group();
  private readonly groups = new Map<string, Group>();
  private readonly known = new WeakSet<THREE.Object3D>();
  private readonly dormant: Member[] = [];
  private readonly loose: Member[] = [];
  private readonly moved: Member[] = [];
  private renders = 0;
  private rows = 32;
  private data = new Float32Array(ROW * 4 * this.rows);
  private readonly tex = { value: texture(ROW, this.rows, this.data) };
  private boneRows = 1;
  private bones = new Float32Array(BONE_W * 4 * this.boneRows);
  /** The stand-ins' skeleton: no bones of its own, its bone texture every copy's bones. */
  private readonly skeleton = new THREE.Skeleton([]);
  private readonly bases = new Map<THREE.Skeleton, number>();
  private readonly updated = new Set<THREE.Skeleton>();
  private live = false;
  private filled = false;
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly mv = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();

  constructor() {
    this.group.name = 'SkinnedBatch';
    this.skeleton.boneTexture = texture(BONE_W, this.boneRows, this.bones);
    // three updates a drawn skinned mesh's skeleton: the copies' bones are written in fill().
    this.skeleton.update = () => {};
  }

  /**
   * A skinned piece that may be drawn with its copies. Only what can be batched exactly is
   * taken: one opaque lit material without its own hooks, attached bind mode, plain skinned
   * geometry. `lods`: the other geometries its mesh may be given (their stand-ins are made now,
   * so the boot's shader compile sees them too). `source`: the mesh wears its own copy of this
   * material (a list of that one copy, drawing its geometry's single whole group, will do),
   * differing only in colour and emissive (tinted, see above).
   */
  add(mesh: THREE.SkinnedMesh, lods: readonly (THREE.BufferGeometry | null | undefined)[] = [], source: THREE.Material | null = null): void {
    if (off || this.known.has(mesh) || !mesh.isSkinnedMesh || !mesh.skeleton) return;
    const m = (source ? ownMaterial(mesh) : mesh.material) as THREE.MeshStandardMaterial & { transmission?: number };
    if (!m || Array.isArray(m) || !m.isMeshStandardMaterial || m.transparent || m.normalMapType === THREE.ObjectSpaceNormalMap || (m.transmission ?? 0) > 0) return;
    if (m.onBeforeRender !== THREE.Material.prototype.onBeforeRender || mesh.onAfterRender !== PROTO_AFTER) return;
    if (mesh.bindMode !== THREE.AttachedBindMode || !batchable(mesh, mesh.geometry)) return;
    if (source && !sibling(m, source, true)) return;
    this.known.add(mesh);
    for (const lod of lods) if (lod && batchable(mesh, lod)) this.groupFor(lod, source ?? m, mesh, !!source);
    this.join({ mesh, mask: mesh.layers.mask, away: 0, source });
  }

  /** The world scene: stand-ins live there from the start (so the boot's shader compile sees them). */
  attach(scene: THREE.Object3D): void {
    if (!off && this.group.parent !== scene) scene.add(this.group);
  }

  /** Into the group of the geometry its mesh has now (one that can't be batched: drawn as itself, looked at again now and then). */
  private join(m: Member): void {
    if (batchable(m.mesh, m.mesh.geometry)) this.groupFor(m.mesh.geometry, m.source ?? (m.mesh.material as THREE.Material), m.mesh, !!m.source).members.push(m);
    else this.loose.push(m);
  }

  /** `tinted`: `material` is the source the members' own copies were made from. */
  private groupFor(geometry: THREE.BufferGeometry, material: THREE.Material, mesh: THREE.SkinnedMesh, tinted: boolean): Group {
    const key = `${geometry.id}|${(material as unknown as { id: number }).id}${tinted ? 't' : ''}|${mesh.receiveShadow}|${mesh.renderOrder}`;
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, (group = this.makeGroup(geometry, material, mesh, tinted)));
    return group;
  }

  /**
   * Right before the main world render (`camera` draws `scene`): the copies on stage and in sight
   * in groups of two or more leave the camera's layers for this render, their skeletons brought
   * up to date; their stand-in shows. Shadow cameras keep seeing them.
   */
  begin(scene: THREE.Object3D, camera: THREE.Camera, lights: readonly THREE.Light[]): void {
    if (off) return;
    this.attach(scene);
    for (const l of lights) if (l.castShadow && (l as THREE.DirectionalLight).shadow) (l as THREE.DirectionalLight).shadow.camera.layers.enable(BATCHED_LAYER);
    if (++this.renders % WAKE_EVERY === 0) {
      for (let i = this.dormant.length - 1; i >= 0; i--) {
        const m = this.dormant[i];
        if (!onStage(m.mesh, scene)) continue;
        this.dormant.splice(i, 1);
        m.away = 0;
        this.join(m);
      }
      for (let i = this.loose.length - 1; i >= 0; i--) {
        const m = this.loose[i];
        if (!batchable(m.mesh, m.mesh.geometry)) continue;
        this.loose.splice(i, 1);
        this.join(m);
      }
    }
    // In sight by their last matrices: who goes in a batch (the draw tests them anew).
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera & { reversedDepth?: boolean }).reversedDepth ?? false);
    const moved = this.moved;
    this.updated.clear();
    for (const g of this.groups.values()) {
      g.shown.length = 0;
      for (let i = g.members.length - 1; i >= 0; i--) {
        const m = g.members[i];
        if (m.mesh.geometry !== g.geometry) {
          // Its geometry was swapped (a LOD band): drawn as itself this render, with its new geometry's copies from the next.
          g.members.splice(i, 1);
          moved.push(m);
        } else if (onStage(m.mesh, scene)) {
          m.away = 0;
          // A mirrored copy is drawn with its faces wound the other way (three flips them per object): not batched.
          // A tinted copy whose material has drifted from its source in anything but colour and emissive: drawn as itself.
          if (m.mesh.layers.test(camera.layers) && m.mesh.matrixWorld.determinant() > 0 && (!m.mesh.frustumCulled || this.frustum.intersectsObject(m.mesh)) && (!g.source || sibling(ownMaterial(m.mesh), g.source))) g.shown.push(m);
        } else if (++m.away > FORGET) {
          g.members.splice(i, 1);
          this.dormant.push(m);
        }
      }
      const batch = g.shown.length >= 2;
      g.proxy.visible = batch;
      if (!batch) g.shown.length = 0;
      else if (g.source) {
        // Tinted copies, each its own material: drawn in three's order for them (material id),
        // the batch where the first of them would be drawn.
        g.shown.sort(byOwnMaterial);
        sortAsSource(g.proxy.material, ownMaterial(g.shown[0].mesh)!);
      }
      for (const m of g.shown) {
        m.mask = m.mesh.layers.mask;
        m.mesh.layers.mask = 1 << BATCHED_LAYER;
        const skel = m.mesh.skeleton;
        if (!this.updated.has(skel)) {
          this.updated.add(skel);
          skel.update();
        }
      }
    }
    for (const m of moved) this.join(m);
    moved.length = 0;
    this.live = true;
    this.filled = false;
  }

  /** Right after the main world render: everything as it was. */
  end(): void {
    if (!this.live) return;
    this.live = false;
    for (const g of this.groups.values()) {
      for (const m of g.shown) m.mesh.layers.mask = m.mask;
      g.proxy.visible = false;
    }
  }

  private makeGroup(src: THREE.BufferGeometry, m: THREE.Material, mesh: THREE.SkinnedMesh, tinted: boolean): Group {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.getAttribute(name));
    geo.instanceCount = 0;
    const mat = m.clone();
    if (tinted) mat.defines = { ...mat.defines, SB_TINT: '' };
    const base = { value: 0 };
    const tex = this.tex;
    mat.onBeforeCompile = (shader, renderer) => {
      m.onBeforeCompile.call(m, shader, renderer);
      shader.uniforms.sbTex = tex;
      shader.uniforms.sbBase = base;
      if (!shader.vertexShader.includes(PARS_IN) || !shader.vertexShader.includes(MAIN_IN)) throw new Error('SkinnedBatch: unexpected vertex shader');
      shader.vertexShader = shader.vertexShader.replace(PARS_IN, PARS).replace(MAIN_IN, MAIN);
      if (tinted) {
        const fs = shader.fragmentShader;
        if (!fs.includes(FRAG_IN) || !fs.includes(DIFFUSE_IN) || !fs.includes(EMISSIVE_IN)) throw new Error('SkinnedBatch: unexpected fragment shader');
        shader.fragmentShader = fs.replace(FRAG_IN, FRAG_PARS).replace(DIFFUSE_IN, DIFFUSE).replace(EMISSIVE_IN, EMISSIVE);
      }
    };
    mat.customProgramCacheKey = () => `${m.customProgramCacheKey()}|skinnedBatch${tinted ? '|tint' : ''}`;
    sortAsSource(mat, m);
    const proxy = new THREE.SkinnedMesh(geo, mat);
    proxy.bind(this.skeleton, new THREE.Matrix4());
    // Never culled; three still reads a skinned mesh's sphere for its sort depth (and would skin
    // the geometry by the stand-in's empty skeleton to work one out).
    proxy.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    proxy.frustumCulled = false;
    proxy.castShadow = false;
    proxy.receiveShadow = mesh.receiveShadow;
    proxy.renderOrder = mesh.renderOrder;
    proxy.visible = false;
    proxy.matrixAutoUpdate = false;
    const group: Group = { members: [], geometry: src, proxy, base, shown: [], source: tinted ? m : null };
    // Every stand-in's rows are written by the first one drawn (the textures go up once).
    proxy.onBeforeRender = (r, s, camera) => {
      if (this.live && !this.filled) this.fill(r, s, camera);
    };
    this.group.add(proxy);
    return group;
  }

  /** The rows of every copy drawn this render (culled as three culls), and their skeletons' bones. */
  private fill(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.filled = true;
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera & { reversedDepth?: boolean }).reversedDepth ?? false);
    let need = 0;
    let texels = 0;
    for (const g of this.groups.values()) {
      need += g.shown.length;
      for (const m of g.shown) texels += m.mesh.skeleton.bones.length * 4;
    }
    if (need > this.rows) this.grow(need);
    if (texels > BONE_W * this.boneRows) this.growBones(texels);
    this.bases.clear();
    const d = this.data;
    const bd = this.bones;
    let row = 0;
    let boneAt = 0;
    for (const g of this.groups.values()) {
      g.base.value = row;
      let n = 0;
      for (const m of g.shown) {
        const mesh = m.mesh;
        if (culledMeshes.has(mesh) || (mesh.frustumCulled && !this.frustum.intersectsObject(mesh))) continue;
        // What three runs right before it draws the mesh (a one-copy list: with its one group).
        const own = ownMaterial(mesh)!;
        if (mesh.onBeforeRender !== PROTO_BEFORE) mesh.onBeforeRender(renderer, scene, camera, mesh.geometry, own, (Array.isArray(mesh.material) ? mesh.geometry.groups[0] : null) as unknown as THREE.Group);
        const skel = mesh.skeleton;
        let bone = this.bases.get(skel);
        if (bone === undefined) {
          bone = boneAt;
          bd.set(skel.boneMatrices!, boneAt * 16);
          boneAt += skel.bones.length;
          this.bases.set(skel, bone);
        }
        this.mv.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
        this.nm.getNormalMatrix(this.mv);
        const o = (row + n) * ROW * 4;
        d.set(this.mv.elements, o);
        const ne = this.nm.elements;
        for (let c = 0; c < 3; c++) {
          d[o + 16 + c * 4] = ne[c * 3];
          d[o + 17 + c * 4] = ne[c * 3 + 1];
          d[o + 18 + c * 4] = ne[c * 3 + 2];
          d[o + 19 + c * 4] = 0;
        }
        d.set(mesh.matrixWorld.elements, o + 28);
        d.set(mesh.bindMatrix.elements, o + 44);
        d.set(mesh.bindMatrixInverse.elements, o + 60);
        d[o + 76] = bone;
        d[o + 77] = 0;
        d[o + 78] = 0;
        d[o + 79] = 0;
        if (g.source) {
          // As three uploads them: diffuse = colour, emissive = emissive × intensity (doubles, sent as float32).
          const s = own as THREE.MeshStandardMaterial;
          const c = s.color;
          const e = s.emissive;
          const k = s.emissiveIntensity;
          d[o + 80] = c.r;
          d[o + 81] = c.g;
          d[o + 82] = c.b;
          d[o + 83] = 0;
          d[o + 84] = e.r * k;
          d[o + 85] = e.g * k;
          d[o + 86] = e.b * k;
          d[o + 87] = 0;
        } else d.fill(0, o + 80, o + 88);
        n++;
      }
      g.proxy.geometry.instanceCount = n;
      row += n;
    }
    this.tex.value.needsUpdate = true;
    if (boneAt) this.skeleton.boneTexture!.needsUpdate = true;
  }

  private grow(need: number): void {
    while (this.rows < need) this.rows *= 2;
    this.data = new Float32Array(ROW * 4 * this.rows);
    this.tex.value.dispose();
    this.tex.value = texture(ROW, this.rows, this.data);
  }

  private growBones(texels: number): void {
    while (BONE_W * this.boneRows < texels) this.boneRows *= 2;
    this.bones = new Float32Array(BONE_W * 4 * this.boneRows);
    this.skeleton.boneTexture!.dispose();
    this.skeleton.boneTexture = texture(BONE_W, this.boneRows, this.bones);
  }
}

function texture(w: number, h: number, data: Float32Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/** A skinned geometry the stand-ins can draw as is: not instanced already, no morphs, all of it drawn. */
function plain(g: THREE.BufferGeometry): boolean {
  return !(g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry && !Object.keys(g.morphAttributes).length && g.drawRange.start === 0 && g.drawRange.count === Infinity && !!g.getAttribute('skinIndex') && !!g.getAttribute('skinWeight');
}

/**
 * `mesh` drawn with `g` is one whole draw: a plain geometry, and with a list of materials, a
 * list of one whose single group covers every index (three draws that group: the same triangles).
 */
function batchable(mesh: THREE.SkinnedMesh, g: THREE.BufferGeometry): boolean {
  if (!plain(g)) return false;
  if (!Array.isArray(mesh.material)) return true;
  const gr = g.groups;
  const n = g.index ? g.index.count : g.getAttribute('position').count;
  return mesh.material.length === 1 && gr.length === 1 && gr[0].start === 0 && gr[0].count >= n && (gr[0].materialIndex ?? 0) === 0;
}

/** The mesh's material, or the one of a one-material list (else null). */
function ownMaterial(mesh: THREE.SkinnedMesh): THREE.Material | null {
  const m = mesh.material;
  if (!Array.isArray(m)) return m;
  return m.length === 1 ? m[0] : null;
}

const byOwnMaterial = (a: Member, b: Member): number => (ownMaterial(a.mesh) as unknown as { id: number }).id - (ownMaterial(b.mesh) as unknown as { id: number }).id;

/** What a tinted copy may differ from its source in (and bookkeeping no draw reads). */
const TINT = new Set(['color', 'emissive', 'emissiveIntensity', 'uuid', 'id', 'name', 'userData', 'version', '_listeners']);
/** The hooks three calls on a material (a copy may not bring its own). */
const HOOKS = ['onBeforeCompile', 'customProgramCacheKey', 'onBeforeRender', 'onBuild'];
/** A source's fields to compare (its own, but the tint), worked out once. */
const fieldsOf = new WeakMap<THREE.Material, string[]>();

/**
 * `a` is a copy of `src` that three would draw with the same program and the same uniforms but
 * diffuse and emissive: every other field the same value (textures the same objects; colours,
 * vectors and planes equal; defines alike), the same hooks. `full`: also field by field the
 * other way round (on joining; each render compares the source's fields and the hooks).
 */
function sibling(a: THREE.Material | null, src: THREE.Material, full = false): boolean {
  if (!a) return false;
  if (a === src) return true;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(src)) return false;
  const x = a as unknown as Record<string, unknown>;
  const y = src as unknown as Record<string, unknown>;
  for (const h of HOOKS) if (x[h] !== y[h]) return false;
  let keys = fieldsOf.get(src);
  if (!keys) fieldsOf.set(src, (keys = Object.keys(y).filter((k) => !TINT.has(k))));
  for (const k of keys) if (!same(x[k], y[k])) return false;
  if (full) for (const k of Object.keys(x)) if (!TINT.has(k) && !same(x[k], y[k])) return false;
  return true;
}

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
  // Plain records (defines): the same keys, the same values.
  if (Object.getPrototypeOf(p) !== Object.prototype || Object.getPrototypeOf(q) !== Object.prototype) return false;
  const pk = Object.keys(p);
  if (pk.length !== Object.keys(q).length) return false;
  for (const k of pk) if (!same((p as Record<string, unknown>)[k], (q as Record<string, unknown>)[k])) return false;
  return true;
}

/** Shown: the mesh and every parent visible, all the way up to `root` (what the render draws). */
function onStage(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

const PARS_IN = '#include <skinning_pars_vertex>';
const MAIN_IN = 'void main() {';

/** three's skinning_pars_vertex with the bind matrices and the bone base the copy's own. */
const PARS = /* glsl */ `
#ifdef USE_SKINNING
uniform highp sampler2D boneTexture;
uniform highp sampler2D sbTex;
uniform int sbBase;
mat4 sbModelView;
mat3 sbNormal;
mat4 sbModel;
mat4 sbBind;
mat4 sbBindInv;
int sbBones;
#define bindMatrix sbBind
#define bindMatrixInverse sbBindInv
mat4 getBoneMatrix( const in float i ) {
	int size = textureSize( boneTexture, 0 ).x;
	int j = ( sbBones + int( i ) ) * 4;
	int x = j % size;
	int y = j / size;
	vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
	vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
	vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
	vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
	return mat4( v1, v2, v3, v4 );
}
#endif
`;

/** The copy's own matrices in place of the object uniforms, from its row (a tinted copy's colour and emissive too). */
const MAIN = /* glsl */ `
#define modelViewMatrix sbModelView
#define normalMatrix sbNormal
#define modelMatrix sbModel
#ifdef SB_TINT
flat varying vec3 sbTintDiffuse;
flat varying vec3 sbTintEmissive;
#endif
void main() {
	int sbRow = sbBase + gl_InstanceID;
	sbModelView = mat4( texelFetch( sbTex, ivec2( 0, sbRow ), 0 ), texelFetch( sbTex, ivec2( 1, sbRow ), 0 ), texelFetch( sbTex, ivec2( 2, sbRow ), 0 ), texelFetch( sbTex, ivec2( 3, sbRow ), 0 ) );
	sbNormal = mat3( texelFetch( sbTex, ivec2( 4, sbRow ), 0 ).xyz, texelFetch( sbTex, ivec2( 5, sbRow ), 0 ).xyz, texelFetch( sbTex, ivec2( 6, sbRow ), 0 ).xyz );
	sbModel = mat4( texelFetch( sbTex, ivec2( 7, sbRow ), 0 ), texelFetch( sbTex, ivec2( 8, sbRow ), 0 ), texelFetch( sbTex, ivec2( 9, sbRow ), 0 ), texelFetch( sbTex, ivec2( 10, sbRow ), 0 ) );
	sbBind = mat4( texelFetch( sbTex, ivec2( 11, sbRow ), 0 ), texelFetch( sbTex, ivec2( 12, sbRow ), 0 ), texelFetch( sbTex, ivec2( 13, sbRow ), 0 ), texelFetch( sbTex, ivec2( 14, sbRow ), 0 ) );
	sbBindInv = mat4( texelFetch( sbTex, ivec2( 15, sbRow ), 0 ), texelFetch( sbTex, ivec2( 16, sbRow ), 0 ), texelFetch( sbTex, ivec2( 17, sbRow ), 0 ), texelFetch( sbTex, ivec2( 18, sbRow ), 0 ) );
	sbBones = int( texelFetch( sbTex, ivec2( 19, sbRow ), 0 ).x );
#ifdef SB_TINT
	sbTintDiffuse = texelFetch( sbTex, ivec2( 20, sbRow ), 0 ).rgb;
	sbTintEmissive = texelFetch( sbTex, ivec2( 21, sbRow ), 0 ).rgb;
#endif
`;

/** Tinted stand-ins' fragment stage: the copy's own colour and emissive where three reads the two uniforms (their only reads). */
const FRAG_IN = '#include <common>';
const FRAG_PARS = '#include <common>\nflat varying vec3 sbTintDiffuse;\nflat varying vec3 sbTintEmissive;';
const DIFFUSE_IN = 'vec4 diffuseColor = vec4( diffuse, opacity );';
const DIFFUSE = 'vec4 diffuseColor = vec4( sbTintDiffuse, opacity );';
const EMISSIVE_IN = 'vec3 totalEmissiveRadiance = emissive;';
const EMISSIVE = 'vec3 totalEmissiveRadiance = sbTintEmissive;';

/** The game's one skinned batcher (master bodies and their worn skinned gear register here). */
export const skinnedBatch = new SkinnedBatch();
