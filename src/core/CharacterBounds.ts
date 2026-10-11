import * as THREE from 'three';
import type { Humanoid } from '../targets/Humanoid';
import type { MasterCharacter } from '../characters/MasterCharacter';

/**
 * Characters drawn only where they can be seen. Render only: .visible, the matrices, the posing
 * and the AI stay as they are (root.visible, the room culling's, drives those).
 *
 * 1. Bounds from the bones. Every skinned piece of a character (body, vest, pouches, straps,
 *    coat) had a fixed 3.5 m frustum sphere, so a character up to 3.5 m off screen (the ally at
 *    your back) kept all of its draws. Each character now has ONE sphere for its body and its
 *    skinned gear: the centre where it always was (three sorts the opaque draws by that centre,
 *    so the order doesn't change) and a radius worked out every render from its bones:
 *      max over bones j of |B_j − c| + reach_j
 *    B_j is the bone in the body mesh's space; reach_j is how far a vertex weighted on it sits
 *    from it in the bone's own frame (the near and far geometry of every piece), times a bound on
 *    how much that frame stretches into mesh space (constant: nothing scales a body or a bone
 *    after it is built). Skinning blends points each inside its bone's ball, so every vertex is
 *    in the sphere; the weights' small deviation from summing to 1 is added, and 1 cm so the
 *    GPU's float rounding can't put a vertex across a frustum plane. Never more than the fixed
 *    radius (past it a draw is culled as it was).
 * 2. Rooms out of sight. Portal culling (Site9) keeps the screen rects each room is seen
 *    through. A character in a room in view but outside every rect it could be seen through
 *    (the neighbour room beside the doorway) moves its opaque meshes to layer 30 for that render.
 *
 * Both run inside the render, between three's matrix pass and its draw lists
 * (scene.onBeforeRender): the matrices are the ones drawn and every render of the scene (the
 * trailer's too) gets fresh bounds; the layers go back in onAfterRender.
 *
 * Switches (A/B in one page): window.__charCull = false (or ?nocharcull) puts the fixed spheres
 * back and culls nothing; window.__charCullPortal = false turns off 2 only. __charBoundsCheck()
 * skins every vertex of every character in view on the CPU and reports the worst margin to its
 * sphere (?boundscheck: every 240 renders).
 */

/** Portal culling's answers (world/Site9). */
export interface PortalView {
  /** Was the last search made for exactly this view? */
  portalCamera(camera: THREE.Camera): boolean;
  /** Could any point of this world box be on screen through the openings? */
  boxVisible(lo: THREE.Vector3, hi: THREE.Vector3): boolean;
}

interface Switches {
  __charCull?: boolean;
  __charCullPortal?: boolean;
  __charBoundsCheck?: () => BoundsReport;
}

export interface BoundsReport {
  bodies: number;
  vertices: number;
  /** The smallest distance (cm) of a vertex inside its sphere (negative: outside). */
  worstCm: number;
  outside: number;
  /** Rigid meshes with a vertex outside their own bounding sphere. */
  rigidOutside: number;
  /** Shared pieces whose frame wasn't the body mesh's. */
  frameMismatch: number;
}

/** A layer no camera of ours looks at. */
const HIDDEN = 1 << 30;
/** Float rounding: the radius grows by this share, plus PAD of the fixed radius (≈ 1 cm). */
const SLACK = 1e-5;
const PAD = 0.003;

interface Anchor {
  /** The kept bone standing for this one (index in Body.bones). */
  k: number;
  /** The most the path from it to this bone adds (mesh units). */
  off: number;
  /** Bound on how much this bone's frame stretches into mesh space. */
  sigma: number;
}

interface Body {
  h: Humanoid;
  /** The body mesh: the sphere is in its space. */
  ref: THREE.SkinnedMesh;
  sphere: THREE.Sphere;
  /** The fixed radius it had. */
  base: number;
  /** This render's radius from the bones, not capped at `base` (the room test uses it). */
  radius: number;
  /** Bounds from the bones work for it (a geometry it can't bound turns them off for good). */
  ok: boolean;
  /** Skinned meshes drawn in `sphere`: the body, and gear in exactly its frame. */
  pieces: THREE.SkinnedMesh[];
  /** Per piece: the geometries its reach covers, and the one it had last render. */
  covered: THREE.BufferGeometry[][];
  last: (THREE.BufferGeometry | null)[];
  /** The master's body node (pieces and socket gear are what it draws), or null. */
  model: THREE.Object3D | null;
  /** The master's rigid gear on its bones. */
  socket: THREE.Mesh[];
  /** Kept bones (a finger is kept by its hand), their world matrices, their reach (−1: nothing on it). */
  bones: THREE.Bone[];
  els: ArrayLike<number>[];
  reach: Float64Array;
  /** The kept bones with something on them. */
  live: Int32Array;
  nLive: number;
  anchor: Map<THREE.Bone, Anchor>;
  /** Over every vertex: the largest Σ|w|, the largest |Σw − 1|. */
  wAbs: number;
  wDev: number;
  pad: number;
}

/** Every body built, weakly (a lab that throws characters away doesn't keep them)... */
let bodies: WeakRef<Body>[] = [];
/** ...each record living as long as its Humanoid. */
const held = new WeakMap<Humanoid, Body>();

/** The bodies still alive (dropping the ones collected). */
function live(): WeakRef<Body>[] {
  let dead = 0;
  for (const r of bodies) if (!r.deref()) dead++;
  if (dead) bodies = bodies.filter((r) => !!r.deref());
  return bodies;
}

/**
 * A Humanoid's skinned body to bound (called once it is built): `mesh` is what it draws, `near`
 * and `far` the geometries it swaps (the master's mid body and gear come from its visual). Every
 * geometry a piece can swap to is covered here, at spawn: covering one mid-match walks all of
 * its vertices (a hitch on a phone the first time someone crosses a distance band).
 */
export function trackBody(h: Humanoid, mesh: THREE.SkinnedMesh, near: THREE.BufferGeometry | null, far: THREE.BufferGeometry | null): void {
  const sphere = mesh.boundingSphere;
  if (!sphere) return;
  const mc = masterOf(h);
  const model = mc ? mc.model : null;
  const pieces: THREE.SkinnedMesh[] = [mesh];
  const covered: THREE.BufferGeometry[][] = [[near, mc?.mid ?? null, far, mesh.geometry].filter((g, i, a): g is THREE.BufferGeometry => !!g && a.indexOf(g) === i)];
  const socket: THREE.Mesh[] = [];
  if (mc && model) {
    // Gear's lighter versions (mid, far) by the geometry it is drawn with up close (phones: that
    // is already the mid one, and only the far one swaps in).
    const lods = new Map<THREE.BufferGeometry, THREE.BufferGeometry[]>();
    for (const g of mc.person.gear) {
      const light = [g.lod, g.far].filter((x): x is THREE.BufferGeometry => !!x);
      if (light.length) g.scene.traverse((o) => (o as THREE.Mesh).isMesh && lods.set((o as THREE.Mesh).geometry, light));
    }
    const own = plainPath(mesh, model);
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (o === mesh || !(o as THREE.Mesh).isMesh) return;
      if (!sm.isSkinnedMesh) {
        socket.push(o as THREE.Mesh);
        return;
      }
      // In exactly the body mesh's frame (nothing but identity nodes up to the body node) with
      // the same sphere: it shares it. Anything else keeps its own fixed sphere.
      if (!own || !sm.visible || !plainPath(sm, model) || !sm.boundingSphere?.equals(sphere)) return;
      sm.boundingSphere = sphere;
      pieces.push(sm);
      covered.push([sm.geometry, ...(lods.get(sm.geometry) ?? [])]);
    });
  }
  const b: Body = {
    h, ref: mesh, sphere, base: sphere.radius, radius: Infinity, ok: true, pieces, covered, last: pieces.map((p) => p.geometry),
    model, socket, bones: [], els: [], reach: new Float64Array(0), live: new Int32Array(0), nLive: 0, anchor: new Map(), wAbs: 0, wDev: 0,
    pad: sphere.radius * PAD,
  };
  held.set(h, b);
  bodies.push(new WeakRef(b));
  if (!pieces.every((p) => p.bindMode === THREE.AttachedBindMode && p.skeleton && !p.skeleton.bones.some((x) => !x) && !displaced(p.material))) {
    b.ok = false;
    return;
  }
  anchors(b, mc);
  for (let p = 0; p < pieces.length; p++) {
    for (const g of covered[p]) {
      if (cover(b, pieces[p], g)) continue;
      b.ok = false;
      return;
    }
  }
}

/** The master humanoid's visual, if that is what draws the body. */
function masterOf(h: Humanoid): MasterCharacter | null {
  const v = h.visual as Partial<MasterCharacter> | null;
  return v && v.model && v.rig && v.person ? (v as MasterCharacter) : null;
}

/** Every node from `o` up to (not including) `top` is the identity: `o` is drawn in top's frame exactly. */
function plainPath(o: THREE.Object3D, top: THREE.Object3D | null): boolean {
  let n: THREE.Object3D | null = o;
  for (; n && n !== top; n = n.parent) {
    const p = n.position;
    const q = n.quaternion;
    const s = n.scale;
    if (p.x !== 0 || p.y !== 0 || p.z !== 0 || q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 1 || s.x !== 1 || s.y !== 1 || s.z !== 1) return false;
    if (!n.matrixAutoUpdate && !n.matrix.equals(IDENTITY)) return false;
  }
  return n === top;
}
const IDENTITY = new THREE.Matrix4();

/** A material that moves vertices in its vertex shader past what the skinning does. */
function displaced(m: THREE.Material | THREE.Material[]): boolean {
  return (Array.isArray(m) ? m : [m]).some((x) => !!(x as THREE.MeshStandardMaterial).displacementMap);
}

const maxScale = (o: THREE.Object3D): number => Math.max(Math.abs(o.scale.x), Math.abs(o.scale.y), Math.abs(o.scale.z));
const minScale = (o: THREE.Object3D): number => Math.min(Math.abs(o.scale.x), Math.abs(o.scale.y), Math.abs(o.scale.z));

/**
 * The kept bones and what stands for each bone: itself, or (the master's fingers and hand
 * sockets) its hand, whose sphere then reaches past the finger's own by the finger's joints
 * (posed by turns only: their offsets are fixed). ~30 bones a frame instead of 69.
 */
function anchors(b: Body, mc: MasterCharacter | null): void {
  // Mesh space is the body mesh's: how much a node's frame can stretch into it, from the nodes'
  // scales (a bound for any turns) down from where its chain meets the mesh's.
  const refChain: THREE.Object3D[] = [];
  const refInv: number[] = [];
  let acc = 1;
  for (let o: THREE.Object3D | null = b.ref; o; o = o.parent) {
    refChain.push(o);
    refInv.push(acc);
    acc /= minScale(o);
  }
  const parts = new Set<THREE.Object3D>(b.h.parts.map((p) => p.group));
  const sigma = (n: THREE.Object3D): number => {
    let s = 1;
    let o: THREE.Object3D | null = n;
    for (; o; o = o.parent) {
      const i = refChain.indexOf(o);
      if (i >= 0) {
        s *= refInv[i];
        break;
      }
      s *= maxScale(o);
    }
    if (!o) return Infinity;
    // A ragdoll's parts take unscaled world matrices of their own: bound from there down too.
    let r = acc;
    let p: THREE.Object3D | null = n;
    for (; p && !parts.has(p); p = p.parent) r *= maxScale(p);
    return p ? Math.max(s, r) : s;
  };
  const all: THREE.Bone[] = [];
  for (const p of b.pieces) for (const x of p.skeleton.bones) if (!all.includes(x)) all.push(x);
  const hands: THREE.Object3D[] = mc ? [mc.rig.arms.R.hand, mc.rig.arms.L.hand].filter((x) => all.includes(x)) : [];
  const keep = (x: THREE.Bone): THREE.Bone => {
    for (let o = x.parent; o && o !== b.model; o = o.parent) if (hands.includes(o)) return o as THREE.Bone;
    return x;
  };
  for (const x of all) {
    if (keep(x) !== x) continue;
    b.anchor.set(x, { k: b.bones.length, off: 0, sigma: sigma(x) });
    b.bones.push(x);
    b.els.push(x.matrixWorld.elements);
  }
  for (const x of all) {
    const hand = keep(x);
    if (hand === x) continue;
    let off = 0;
    for (let o: THREE.Object3D = x; o !== hand; o = o.parent!) off += sigma(o.parent!) * o.position.length();
    b.anchor.set(x, { k: b.anchor.get(hand)!.k, off, sigma: sigma(x) });
  }
  b.reach = new Float64Array(b.bones.length).fill(-1);
  b.live = new Int32Array(b.bones.length);
}

interface Reach {
  /** Per bone: inverse bind matrix × bind matrix (the vertex into the bone's frame). */
  k: Float64Array;
  /** Per bone: the farthest vertex weighted on it, in its frame (−1: none). */
  reach: Float64Array;
  wAbs: number;
  wDev: number;
}
const reaches = new WeakMap<THREE.BufferGeometry, Reach[]>();
const m4 = new THREE.Matrix4();

/** How far each bone's vertices reach in its own frame (shared by every body drawing the same geometry the same way). */
function boneReach(geo: THREE.BufferGeometry, skel: THREE.Skeleton, bind: THREE.Matrix4): Reach | null {
  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const n = skel.bones.length;
  if (!pos || !si || !sw || Object.keys(geo.morphAttributes).length || skel.boneInverses.length !== n) return null;
  const k = new Float64Array(n * 16);
  for (let j = 0; j < n; j++) k.set(m4.multiplyMatrices(skel.boneInverses[j], bind).elements, j * 16);
  const known = reaches.get(geo) ?? [];
  for (const e of known) if (e.k.every((v, i) => v === k[i])) return e;
  const reach = new Float64Array(n).fill(-1);
  let wAbs = 0;
  let wDev = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let sa = 0;
    let s = 0;
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (w === 0) continue;
      const j = si.getComponent(i, c);
      // A weight on a bone the skeleton hasn't: the shader would read past it.
      if (j >= n) return null;
      sa += Math.abs(w);
      s += w;
      const e = j * 16;
      const ux = k[e] * x + k[e + 4] * y + k[e + 8] * z + k[e + 12];
      const uy = k[e + 1] * x + k[e + 5] * y + k[e + 9] * z + k[e + 13];
      const uz = k[e + 2] * x + k[e + 6] * y + k[e + 10] * z + k[e + 14];
      const d = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (d > reach[j]) reach[j] = d;
    }
    if (sa > wAbs) wAbs = sa;
    if (Math.abs(s - 1) > wDev) wDev = Math.abs(s - 1);
  }
  const e = { k, reach, wAbs, wDev };
  known.push(e);
  reaches.set(geo, known);
  return e;
}

/** Fold a geometry a piece draws into the body's reach (once per geometry). */
function cover(b: Body, piece: THREE.SkinnedMesh, geo: THREE.BufferGeometry): boolean {
  const t = boneReach(geo, piece.skeleton, piece.bindMatrix);
  if (!t) return false;
  const bones = piece.skeleton.bones;
  for (let j = 0; j < bones.length; j++) {
    if (t.reach[j] < 0) continue;
    const a = b.anchor.get(bones[j]);
    if (!a) return false;
    const v = a.off + a.sigma * t.reach[j];
    if (v > b.reach[a.k]) b.reach[a.k] = v;
  }
  b.wAbs = Math.max(b.wAbs, t.wAbs);
  b.wDev = Math.max(b.wDev, t.wDev);
  b.nLive = 0;
  for (let k = 0; k < b.reach.length; k++) if (b.reach[k] >= 0) b.live[b.nLive++] = k;
  return true;
}

/** A bound on how far a matrix's linear part stretches any vector (Gershgorin on its columns' Gram matrix). */
function stretch(e: ArrayLike<number>): number {
  const aa = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const bb = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
  const cc = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
  const ab = Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]);
  const ac = Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]);
  const bc = Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]);
  return Math.sqrt(Math.max(aa + ab + ac, bb + ab + bc, cc + ac + bc));
}

/** A mesh whose draw rooms out of sight may skip: opaque, frustum-culled, its geometry's sphere its bounds. */
function cullable(m: THREE.Mesh): boolean {
  if (!m.frustumCulled || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return false;
  if (Object.keys(m.geometry.morphAttributes).length || !opaque(m.material)) return false;
  return true;
}

function opaque(m: THREE.Material | THREE.Material[]): boolean {
  if (Array.isArray(m)) return m.every(opaque);
  return m.visible && !m.transparent && !(m as THREE.MeshStandardMaterial).displacementMap;
}

export class CharacterBounds {
  /** What the last render of the scene did. */
  readonly stats = { bodies: 0, tight: 0, portal: false, culled: 0, meshes: 0 };
  private cand: THREE.Mesh[] = [];
  private masks: number[] = [];
  private nCand = 0;
  private lo = new THREE.Vector3();
  private hi = new THREE.Vector3();
  private c = new THREE.Vector3();
  private renders = 0;
  private checkEvery: number;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    private portal: PortalView | null,
  ) {
    const params = new URLSearchParams(location.search);
    const w = window as unknown as Switches;
    if (w.__charCull === undefined) w.__charCull = !params.has('nocharcull');
    if (w.__charCullPortal === undefined) w.__charCullPortal = true;
    w.__charBoundsCheck = () => this.check();
    this.checkEvery = params.has('boundscheck') ? 240 : 0;
    // Nothing else uses the scene's own hooks.
    scene.onBeforeRender = (_r, _s, camera) => this.before(camera);
    scene.onAfterRender = () => this.after();
  }

  private before(camera: THREE.Camera): void {
    this.restore();
    const w = window as unknown as Switches;
    const on = w.__charCull !== false;
    // Rooms out of sight: for the view portal culling searched only, and never while shadow maps
    // render (three's shadow pass tests a caster's layers against the main camera's).
    const portal = on && w.__charCullPortal !== false && this.portal && !this.renderer.shadowMap.enabled && this.portal.portalCamera(camera) ? this.portal : null;
    let n = 0;
    let tight = 0;
    let culled = 0;
    const meshes = this.nCand;
    let dead = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i].deref();
      if (!b) {
        dead++;
        continue;
      }
      if (!b.h.root.visible || !this.inScene(b.h.root)) continue;
      n++;
      if (!on || !b.ok) {
        b.sphere.radius = b.base;
        continue;
      }
      this.bound(b);
      if (!b.ok) continue;
      if (b.sphere.radius < b.base) tight++;
      if (portal && this.cull(b, portal)) culled++;
    }
    if (dead) live();
    const s = this.stats;
    s.bodies = n;
    s.tight = tight;
    s.portal = !!portal;
    s.culled = culled;
    s.meshes = this.nCand - meshes;
  }

  private after(): void {
    this.restore();
    if (this.checkEvery && ++this.renders % this.checkEvery === 0) this.check();
  }

  private inScene(o: THREE.Object3D): boolean {
    for (let p = o.parent; p; p = p.parent) if (p === this.scene) return true;
    return false;
  }

  /** The radius from the bones (see the top). */
  private bound(b: Body): void {
    for (let p = 0; p < b.pieces.length; p++) {
      const g = b.pieces[p].geometry;
      if (g === b.last[p]) continue;
      b.last[p] = g;
      if (b.covered[p].includes(g)) continue;
      b.covered[p].push(g);
      if (cover(b, b.pieces[p], g)) continue;
      b.ok = false;
      b.sphere.radius = b.base;
      return;
    }
    // Mesh space as drawn: the shader takes the skinned point back through bindMatrixInverse.
    const ie = b.ref.bindMatrixInverse.elements;
    const c = b.sphere.center;
    const ox = ie[12] - c.x;
    const oy = ie[13] - c.y;
    const oz = ie[14] - c.z;
    const reach = b.reach;
    const els = b.els;
    const live = b.live;
    let r = 0;
    for (let i = 0; i < b.nLive; i++) {
      const k = live[i];
      const e = els[k];
      const x = e[12];
      const y = e[13];
      const z = e[14];
      const dx = ie[0] * x + ie[4] * y + ie[8] * z + ox;
      const dy = ie[1] * x + ie[5] * y + ie[9] * z + oy;
      const dz = ie[2] * x + ie[6] * y + ie[10] * z + oz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + reach[k];
      if (d > r) r = d;
    }
    // A vertex is Σ w_j p_j with each p_j within r of the centre: within Σ|w| r + |Σw − 1| |c|.
    b.radius = (r * b.wAbs + b.wDev * c.length()) * (1 + SLACK) + b.pad;
    b.sphere.radius = b.radius < b.base ? b.radius : b.base;
  }

  /** Rooms out of sight: everything opaque the character draws, on layer 30 for this render if none of it can show. */
  private cull(b: Body, portal: PortalView): boolean {
    const start = this.nCand;
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
    // The skinned pieces: the bone sphere where three puts it in the world. Most characters in
    // view are done here (all of it is drawn or none).
    const mw = b.ref.matrixWorld;
    this.grow(this.c.copy(b.sphere.center).applyMatrix4(mw), b.radius * stretch(mw.elements));
    if (portal.boxVisible(this.lo, this.hi)) return false;
    for (const p of b.pieces) if (p.visible && opaque(p.material)) this.push(p);
    for (const m of b.socket) if (m.visible && cullable(m)) this.addMesh(m);
    // The rest it carries (guns, gloves): what three would draw of it.
    this.walk(b.h.root, b);
    if (this.nCand === start) return false;
    if (portal.boxVisible(this.lo, this.hi)) {
      this.nCand = start;
      return false;
    }
    for (let i = start; i < this.nCand; i++) {
      const m = this.cand[i];
      this.masks[i] = m.layers.mask;
      m.layers.mask = HIDDEN;
    }
    return true;
  }

  private walk(o: THREE.Object3D, b: Body): void {
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (!c.visible || c === b.model || c === b.ref) continue;
      if ((c as THREE.Mesh).isMesh && cullable(c as THREE.Mesh)) this.addMesh(c as THREE.Mesh);
      if (c.children.length) this.walk(c, b);
    }
  }

  /** A rigid mesh: its geometry's sphere where three puts it, into the box. */
  private addMesh(m: THREE.Mesh): void {
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere!;
    const mw = m.matrixWorld;
    this.grow(this.c.copy(s.center).applyMatrix4(mw), s.radius * stretch(mw.elements) * (1 + SLACK) + 0.01);
    this.push(m);
  }

  private grow(c: THREE.Vector3, r: number): void {
    const lo = this.lo;
    const hi = this.hi;
    lo.set(Math.min(lo.x, c.x - r), Math.min(lo.y, c.y - r), Math.min(lo.z, c.z - r));
    hi.set(Math.max(hi.x, c.x + r), Math.max(hi.y, c.y + r), Math.max(hi.z, c.z + r));
  }

  private push(m: THREE.Mesh): void {
    this.cand[this.nCand] = m;
    this.masks[this.nCand] = 0;
    this.nCand++;
  }

  /** Every layer back as it was (newest first: a mesh listed twice ends with its own). */
  private restore(): void {
    for (let i = this.nCand - 1; i >= 0; i--) {
      const m = this.cand[i];
      if (m.layers.mask === HIDDEN) m.layers.mask = this.masks[i];
    }
    this.nCand = 0;
  }

  /**
   * Dev: every vertex of every character in view skinned on the CPU (three's own
   * applyBoneTransform, from the matrices last drawn) against its sphere. Call it between
   * frames (the console) or let ?boundscheck run it after a render.
   */
  check(): BoundsReport {
    const v = new THREE.Vector3();
    const rep: BoundsReport = { bodies: 0, vertices: 0, worstCm: Infinity, outside: 0, rigidOutside: 0, frameMismatch: 0 };
    const rigid = new Set<THREE.BufferGeometry>();
    for (const r of live()) {
      const b = r.deref()!;
      if (!b.ok || !b.h.root.visible || !this.inScene(b.h.root) || b.radius === Infinity) continue;
      rep.bodies++;
      const c = b.sphere.center;
      const unit = stretch(b.ref.matrixWorld.elements) * 100;
      for (const p of b.pieces) {
        if (p !== b.ref && (!p.matrixWorld.equals(b.ref.matrixWorld) || !p.bindMatrixInverse.equals(b.ref.bindMatrixInverse))) rep.frameMismatch++;
        const pos = p.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          p.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
          const margin = (b.radius - v.distanceTo(c)) * unit;
          rep.vertices++;
          if (margin < rep.worstCm) rep.worstCm = margin;
          if (margin < 0) rep.outside++;
        }
      }
      // The rigid pieces' own spheres (what the room test and three's frustum test take).
      b.h.root.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !cullable(m) || rigid.has(m.geometry)) return;
        rigid.add(m.geometry);
        const g = m.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const pos = g.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          if (v.fromBufferAttribute(pos, i).distanceTo(g.boundingSphere!.center) > g.boundingSphere!.radius * (1 + 1e-6)) {
            rep.rigidOutside++;
            break;
          }
        }
      });
    }
    console.info(`[charBounds] ${rep.bodies} bodies, ${rep.vertices} vertices: worst margin ${rep.worstCm.toFixed(2)} cm, ${rep.outside} outside, ${rep.rigidOutside} rigid meshes outside their sphere, ${rep.frameMismatch} frame mismatches`);
    return rep;
  }
}
