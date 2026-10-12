import * as THREE from 'three';

/**
 * The same rigid character piece on many characters, in one draw: every soldier's gun of a
 * model, every PMC's helmet, radio and NVGs (and the map's loose crates and barrels). Each is a mesh of its own (a draw call apiece, the
 * phone's dearest cost), yet they share geometry and material: here the copies in sight go out
 * as instances of one draw.
 *
 * Exact by construction. three gives each object its model-view, normal and model matrices as
 * uniforms (worked out in double precision, sent as float32); here the same three matrices are
 * worked out the same way per copy and fetched from a float texture by the instance's row, then
 * stand in for the uniforms (#define) in the unchanged vertex shader. The same float32 inputs
 * through the same expressions: the same vertices, normals and world positions. The fragment
 * shader is untouched (it reads none of the three, except object-space normal maps and
 * transmission, which are never batched). Which copies are drawn is decided the way three does
 * it (shown, on the camera's layers, inside the frustum by the same test), with the matrices of
 * this very render.
 *
 * The copies themselves are only taken out of the main world render (a layer the camera doesn't
 * see, for that render alone): shadow cameras, other renders, raycasts and everything that reads
 * their matrices see them as always.
 */

/** Texels per copy: model-view (4 columns), normal (3), model (4). */
const ROW = 11;
/** The layer the batched copies sit on during the main render (cameras don't see it; shadow cameras do). */
export const BATCHED_LAYER = 30;
/**
 * A copy off stage this many renders running goes dormant: out of the per-render walk (re-armed
 * soldiers leave their old guns behind, pooled bodies wait hidden), looked at only every
 * WAKE_EVERY renders, and back in its group once it is on stage again (the gun taken up again,
 * the body brought back into play).
 */
const FORGET = 1800;
const WAKE_EVERY = 30;

interface Member {
  mesh: THREE.Mesh;
  /** Its layer mask outside the main render. */
  mask: number;
  /** Renders in a row it hasn't been on stage. */
  away: number;
}

interface Group {
  members: Member[];
  /** The members' geometry (a copy whose mesh swaps to another one, a LOD, moves to that one's group). */
  geometry: THREE.BufferGeometry;
  /** Instances of the members' geometry under the stand-in material. */
  proxy: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  base: { value: number };
  /** Copies on stage this render (the proxy stands in only for two or more). */
  shown: Member[];
}

const off = new URLSearchParams(location.search).has('nobatch');

export class RigidBatch {
  /** The stand-ins (in the world scene; shown only during the main render). */
  readonly group = new THREE.Group();
  private readonly groups = new Map<string, Group>();
  private readonly known = new WeakSet<THREE.Object3D>();
  private rows = 64;
  private data = new Float32Array(ROW * 4 * this.rows);
  private readonly tex = { value: this.texture() };
  private live = false;
  private filled = false;
  private readonly dormant: Member[] = [];
  /** Copies whose mesh has a geometry that can't be batched for now. */
  private readonly loose: Member[] = [];
  private readonly moved: Member[] = [];
  private renders = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly mv = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();

  constructor() {
    this.group.name = 'RigidBatch';
  }

  /**
   * A rigid piece that may be drawn with its copies. Only what can be batched exactly is taken:
   * one opaque lit material without its own per-object hooks, plain geometry. `lods`: the other
   * geometries its mesh may be given (LOD bands): their stand-ins are made now, so the boot's
   * shader compile sees them too.
   */
  add(mesh: THREE.Mesh, lods: readonly (THREE.BufferGeometry | null | undefined)[] = []): void {
    if (off || this.known.has(mesh)) return;
    const m = mesh.material as THREE.MeshStandardMaterial & { transmission?: number };
    const g = mesh.geometry;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
    if (Array.isArray(m) || !m.isMeshStandardMaterial || m.transparent || m.normalMapType === THREE.ObjectSpaceNormalMap || (m.transmission ?? 0) > 0) return;
    if (m.onBeforeRender !== THREE.Material.prototype.onBeforeRender || mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return;
    if (!plain(g)) return;
    this.known.add(mesh);
    for (const lod of lods) if (lod && plain(lod)) this.groupFor(lod, m, mesh);
    this.join({ mesh, mask: mesh.layers.mask, away: 0 });
  }

  /** Into the group of the geometry its mesh has now (one that can't be batched: drawn as itself, looked at again now and then). */
  private join(m: Member): void {
    if (plain(m.mesh.geometry)) this.groupFor(m.mesh.geometry, m.mesh.material as THREE.Material, m.mesh).members.push(m);
    else this.loose.push(m);
  }

  private groupFor(geometry: THREE.BufferGeometry, material: THREE.Material, mesh: THREE.Mesh): Group {
    const key = `${geometry.id}|${(material as unknown as { id: number }).id}|${mesh.receiveShadow}|${mesh.renderOrder}`;
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, (group = this.makeGroup(geometry, material, mesh)));
    return group;
  }

  /** The world scene: stand-ins live there from the start (so the boot's shader compile sees them). */
  attach(scene: THREE.Object3D): void {
    if (!off && this.group.parent !== scene) scene.add(this.group);
  }

  /**
   * Right before the main world render (`camera` draws `scene`): the copies on stage in groups
   * of two or more leave the camera's layers for this render; their stand-in shows. Shadow
   * cameras keep seeing them (their shadows are drawn from the copies, as before).
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
    // Who goes in a batch: copies in sight by their last matrices (the draw tests them anew with
    // this render's; a stand-in kept for copies all out of sight would cost a draw's setup for nothing).
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera & { reversedDepth?: boolean }).reversedDepth ?? false);
    const moved = this.moved;
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
      // An empty group stays (its stand-in's program with it) for the copies that come back.
      const batch = g.shown.length >= 2;
      g.proxy.visible = batch;
      if (!batch) g.shown.length = 0;
      for (const m of g.shown) {
        m.mask = m.mesh.layers.mask;
        m.mesh.layers.mask = 1 << BATCHED_LAYER;
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

  private makeGroup(src: THREE.BufferGeometry, m: THREE.Material, mesh: THREE.Mesh): Group {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.getAttribute(name));
    geo.instanceCount = 0;
    const mat = m.clone();
    const base = { value: 0 };
    const tex = this.tex;
    mat.onBeforeCompile = (shader, renderer) => {
      m.onBeforeCompile.call(m, shader, renderer);
      shader.uniforms.rbTex = tex;
      shader.uniforms.rbBase = base;
      const main = 'void main() {';
      if (!shader.vertexShader.includes(main)) throw new Error('RigidBatch: no vertex main()');
      shader.vertexShader = shader.vertexShader.replace(main, VERTEX);
    };
    mat.customProgramCacheKey = () => `${m.customProgramCacheKey()}|rigidBatch`;
    const proxy = new THREE.Mesh(geo, mat);
    proxy.frustumCulled = false;
    proxy.castShadow = false;
    proxy.receiveShadow = mesh.receiveShadow;
    proxy.renderOrder = mesh.renderOrder;
    proxy.visible = false;
    proxy.matrixAutoUpdate = false;
    const group: Group = { members: [], geometry: src, proxy, base, shown: [] };
    // Every stand-in's rows are written by the first one drawn (the texture goes up once).
    proxy.onBeforeRender = (_r, _s, camera) => {
      if (this.live && !this.filled) this.fill(camera);
    };
    this.group.add(proxy);
    return group;
  }

  /** The rows of every copy drawn this render, culled as three culls (its own frustum test). */
  private fill(camera: THREE.Camera): void {
    this.filled = true;
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera & { reversedDepth?: boolean }).reversedDepth ?? false);
    let row = 0;
    let need = 0;
    for (const g of this.groups.values()) need += g.shown.length;
    if (need > this.rows) this.grow(need);
    const d = this.data;
    for (const g of this.groups.values()) {
      g.base.value = row;
      let n = 0;
      for (const m of g.shown) {
        const mesh = m.mesh;
        if (mesh.frustumCulled && !this.frustum.intersectsObject(mesh)) continue;
        this.mv.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
        this.nm.getNormalMatrix(this.mv);
        const o = (row + n) * ROW * 4;
        const e = this.mv.elements;
        for (let k = 0; k < 16; k++) d[o + k] = e[k];
        const ne = this.nm.elements;
        for (let c = 0; c < 3; c++) {
          d[o + 16 + c * 4] = ne[c * 3];
          d[o + 17 + c * 4] = ne[c * 3 + 1];
          d[o + 18 + c * 4] = ne[c * 3 + 2];
          d[o + 19 + c * 4] = 0;
        }
        const w = mesh.matrixWorld.elements;
        for (let k = 0; k < 16; k++) d[o + 28 + k] = w[k];
        n++;
      }
      g.proxy.geometry.instanceCount = n;
      row += n;
    }
    this.tex.value.needsUpdate = true;
  }

  private grow(need: number): void {
    while (this.rows < need) this.rows *= 2;
    this.data = new Float32Array(ROW * 4 * this.rows);
    this.tex.value.dispose();
    this.tex.value = this.texture();
  }

  private texture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.data, ROW, this.rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    return t;
  }
}

/**
 * A geometry the stand-ins can draw as is: not instanced already, no morphs, all of it drawn. (Its
 * groups don't matter: under its one material three draws it whole, as the stand-in does.)
 */
function plain(g: THREE.BufferGeometry): boolean {
  return !(g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry && !Object.keys(g.morphAttributes).length && g.drawRange.start === 0 && g.drawRange.count === Infinity;
}

/** Shown: the mesh and every parent visible, all the way up to `root` (what the render draws). */
function onStage(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

/** The copy's own three matrices in place of the object uniforms, from its row. */
const VERTEX = /* glsl */ `
uniform highp sampler2D rbTex;
uniform int rbBase;
mat4 rbModelView;
mat3 rbNormal;
mat4 rbModel;
#define modelViewMatrix rbModelView
#define normalMatrix rbNormal
#define modelMatrix rbModel
void main() {
	int rbRow = rbBase + gl_InstanceID;
	rbModelView = mat4( texelFetch( rbTex, ivec2( 0, rbRow ), 0 ), texelFetch( rbTex, ivec2( 1, rbRow ), 0 ), texelFetch( rbTex, ivec2( 2, rbRow ), 0 ), texelFetch( rbTex, ivec2( 3, rbRow ), 0 ) );
	rbNormal = mat3( texelFetch( rbTex, ivec2( 4, rbRow ), 0 ).xyz, texelFetch( rbTex, ivec2( 5, rbRow ), 0 ).xyz, texelFetch( rbTex, ivec2( 6, rbRow ), 0 ).xyz );
	rbModel = mat4( texelFetch( rbTex, ivec2( 7, rbRow ), 0 ), texelFetch( rbTex, ivec2( 8, rbRow ), 0 ), texelFetch( rbTex, ivec2( 9, rbRow ), 0 ), texelFetch( rbTex, ivec2( 10, rbRow ), 0 ) );
`;

/** The game's one batcher (the world scene's rigid character pieces register here). */
export const rigidBatch = new RigidBatch();
