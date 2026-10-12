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
 */

/** Texels per copy: model-view (4 columns), normal (3), model (4), bind (4), bind inverse (4), bone base (1). */
const ROW = 20;
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
   * so the boot's shader compile sees them too).
   */
  add(mesh: THREE.SkinnedMesh, lods: readonly (THREE.BufferGeometry | null | undefined)[] = []): void {
    if (off || this.known.has(mesh) || !mesh.isSkinnedMesh || !mesh.skeleton) return;
    const m = mesh.material as THREE.MeshStandardMaterial & { transmission?: number };
    if (Array.isArray(m) || !m.isMeshStandardMaterial || m.transparent || m.normalMapType === THREE.ObjectSpaceNormalMap || (m.transmission ?? 0) > 0) return;
    if (m.onBeforeRender !== THREE.Material.prototype.onBeforeRender || mesh.onAfterRender !== PROTO_AFTER) return;
    if (mesh.bindMode !== THREE.AttachedBindMode || !plain(mesh.geometry)) return;
    this.known.add(mesh);
    for (const lod of lods) if (lod && plain(lod)) this.groupFor(lod, m, mesh);
    this.join({ mesh, mask: mesh.layers.mask, away: 0 });
  }

  /** The world scene: stand-ins live there from the start (so the boot's shader compile sees them). */
  attach(scene: THREE.Object3D): void {
    if (!off && this.group.parent !== scene) scene.add(this.group);
  }

  /** Into the group of the geometry its mesh has now (one that can't be batched: drawn as itself, looked at again now and then). */
  private join(m: Member): void {
    if (plain(m.mesh.geometry)) this.groupFor(m.mesh.geometry, m.mesh.material as THREE.Material, m.mesh).members.push(m);
    else this.loose.push(m);
  }

  private groupFor(geometry: THREE.BufferGeometry, material: THREE.Material, mesh: THREE.SkinnedMesh): Group {
    const key = `${geometry.id}|${(material as unknown as { id: number }).id}|${mesh.receiveShadow}|${mesh.renderOrder}`;
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, (group = this.makeGroup(geometry, material, mesh)));
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
        if (!plain(m.mesh.geometry)) continue;
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
          if (m.mesh.layers.test(camera.layers) && m.mesh.matrixWorld.determinant() > 0 && (!m.mesh.frustumCulled || this.frustum.intersectsObject(m.mesh))) g.shown.push(m);
        } else if (++m.away > FORGET) {
          g.members.splice(i, 1);
          this.dormant.push(m);
        }
      }
      const batch = g.shown.length >= 2;
      g.proxy.visible = batch;
      if (!batch) g.shown.length = 0;
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

  private makeGroup(src: THREE.BufferGeometry, m: THREE.Material, mesh: THREE.SkinnedMesh): Group {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.getAttribute(name));
    geo.instanceCount = 0;
    const mat = m.clone();
    const base = { value: 0 };
    const tex = this.tex;
    mat.onBeforeCompile = (shader, renderer) => {
      m.onBeforeCompile.call(m, shader, renderer);
      shader.uniforms.sbTex = tex;
      shader.uniforms.sbBase = base;
      if (!shader.vertexShader.includes(PARS_IN) || !shader.vertexShader.includes(MAIN_IN)) throw new Error('SkinnedBatch: unexpected vertex shader');
      shader.vertexShader = shader.vertexShader.replace(PARS_IN, PARS).replace(MAIN_IN, MAIN);
    };
    mat.customProgramCacheKey = () => `${m.customProgramCacheKey()}|skinnedBatch`;
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
    const group: Group = { members: [], geometry: src, proxy, base, shown: [] };
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
        // What three runs right before it draws the mesh.
        if (mesh.onBeforeRender !== PROTO_BEFORE) mesh.onBeforeRender(renderer, scene, camera, mesh.geometry, mesh.material as THREE.Material, null as unknown as THREE.Group);
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

/** The copy's own matrices in place of the object uniforms, from its row. */
const MAIN = /* glsl */ `
#define modelViewMatrix sbModelView
#define normalMatrix sbNormal
#define modelMatrix sbModel
void main() {
	int sbRow = sbBase + gl_InstanceID;
	sbModelView = mat4( texelFetch( sbTex, ivec2( 0, sbRow ), 0 ), texelFetch( sbTex, ivec2( 1, sbRow ), 0 ), texelFetch( sbTex, ivec2( 2, sbRow ), 0 ), texelFetch( sbTex, ivec2( 3, sbRow ), 0 ) );
	sbNormal = mat3( texelFetch( sbTex, ivec2( 4, sbRow ), 0 ).xyz, texelFetch( sbTex, ivec2( 5, sbRow ), 0 ).xyz, texelFetch( sbTex, ivec2( 6, sbRow ), 0 ).xyz );
	sbModel = mat4( texelFetch( sbTex, ivec2( 7, sbRow ), 0 ), texelFetch( sbTex, ivec2( 8, sbRow ), 0 ), texelFetch( sbTex, ivec2( 9, sbRow ), 0 ), texelFetch( sbTex, ivec2( 10, sbRow ), 0 ) );
	sbBind = mat4( texelFetch( sbTex, ivec2( 11, sbRow ), 0 ), texelFetch( sbTex, ivec2( 12, sbRow ), 0 ), texelFetch( sbTex, ivec2( 13, sbRow ), 0 ), texelFetch( sbTex, ivec2( 14, sbRow ), 0 ) );
	sbBindInv = mat4( texelFetch( sbTex, ivec2( 15, sbRow ), 0 ), texelFetch( sbTex, ivec2( 16, sbRow ), 0 ), texelFetch( sbTex, ivec2( 17, sbRow ), 0 ), texelFetch( sbTex, ivec2( 18, sbRow ), 0 ) );
	sbBones = int( texelFetch( sbTex, ivec2( 19, sbRow ), 0 ).x );
`;

/** The game's one skinned batcher (master bodies and their worn skinned gear register here). */
export const skinnedBatch = new SkinnedBatch();
