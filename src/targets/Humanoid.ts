import * as THREE from 'three';
import { RAPIER, GROUPS, type BulletHit, type HitReceiver, type HitResult, type HitSet, type Physics, type SetHit, type SurfaceType } from '../core/Physics';
import { Spring, Spring3 } from '../core/Spring';
import { clamp, DEG } from '../core/math';
import { feel } from '../config/Feel';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBuilder } from '../world/MeshBuilder';
import { skinDetail } from '../enemies/SoldierSkin';
import { Damageable } from './Damageable';

export type PartName = 'pelvis' | 'torso' | 'head' | 'upperArmL' | 'upperArmR' | 'foreArmL' | 'foreArmR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';
export type HitZone = 'head' | 'thorax' | 'stomach' | 'arm' | 'leg';
type V3 = [number, number, number];

export interface ColliderDef {
  half: V3;
  center: V3;
  mass: number;
  zone: HitZone;
  surface?: SurfaceType;
  /** Armor class as a penetration rating (plates ~40, helmets ~30). */
  armor?: number;
}

export interface PartDef {
  name: PartName;
  parent: PartName | null;
  /** Joint position in the parent's space (the part's pivot). */
  pos: V3;
  side: -1 | 0 | 1;
  build(b: MeshBuilder): void;
  colliders: ColliderDef[];
}

/** Everything that makes one kind of humanoid look and take damage differently. */
export interface HumanoidSkin {
  parts: PartDef[];
  /** Shin pivot → sole. */
  shinLength: number;
  /** Forearm pivot → palm (IK grip point), in forearm space. */
  handGrip: V3;
  health: number;
  zoneDamage: Record<HitZone, number>;
  /** Head damage multiplier (default: the round's crit multiplier). */
  headMultiplier?: number;
  /** Fraction of damage that still gets through a plate/helmet that stopped the round. */
  bluntFactor?: number;
  /** Vertex-coloured material the plain materials are merged into (fewer draw calls). */
  merge?: THREE.MeshStandardMaterial;
  /**
   * A whole model body (targets/ModelBody): rest-pose skinned geometry weighted over
   * `slots` (part names, plus footL / footR for the ankle bones). Replaces the parts' builds.
   */
  body?: { geometry: THREE.BufferGeometry; materials: THREE.Material[]; slots: string[]; lod?: THREE.BufferGeometry };
  /**
   * A body drawn by a skeleton of its own (the master humanoid, characters/MasterCharacter):
   * built once the parts exist, it follows them every frame (HumanoidVisual.posed). Replaces
   * `body` and the parts' builds; the parts stay the one animation, hit test and ragdoll.
   */
  visual?: (body: Humanoid) => HumanoidVisual;
  idleKnee?: number;
  /**
   * 'machine': a robot's walk. Legs sweep at a constant rate and lift sharply, every
   * footfall lands with a hard drop, no hip twist, no idle breathing, stiff piston arms.
   */
  gait?: 'human' | 'machine';
}

/** A body drawn by a skeleton of its own, driven from the Humanoid's parts (see HumanoidSkin.visual). */
export interface HumanoidVisual {
  /** What is drawn: its geometry is swapped near / far and its shadow cast near, as a model body's. */
  readonly mesh: THREE.SkinnedMesh;
  readonly near: THREE.BufferGeometry;
  readonly far: THREE.BufferGeometry | null;
  /**
   * The parts were just posed (alive: before the hitboxes read them, so it may turn the arm parts
   * to match what it draws) or moved by the ragdoll (dead). `far`: the far geometry is up.
   */
  posed(dt: number, far: boolean): void;
}

/** Triangle wave in -1..1 on the same phase as sin: a constant-rate sweep. */
const tri = (a: number): number => (2 / Math.PI) * Math.asin(Math.sin(a));

const SLAB_O = [0, 0, 0];
const SLAB_D = [0, 0, 0];

/**
 * A ray (o + t d) against the box `c` ± `h` (slab test): the entry distance in [0, maxT], or
 * -1. `face` gets the entry face (axis, outward sign; axis -1: the ray starts inside, t = 0).
 */
function boxRay(o: THREE.Vector3, d: THREE.Vector3, c: V3, h: V3, maxT: number, face: { axis: number; sign: number }): number {
  SLAB_O[0] = o.x - c[0];
  SLAB_O[1] = o.y - c[1];
  SLAB_O[2] = o.z - c[2];
  SLAB_D[0] = d.x;
  SLAB_D[1] = d.y;
  SLAB_D[2] = d.z;
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;
  for (let a = 0; a < 3; a++) {
    const oa = SLAB_O[a];
    const da = SLAB_D[a];
    const ha = h[a];
    if (Math.abs(da) < 1e-12) {
      if (oa < -ha || oa > ha) return -1;
      continue;
    }
    let t1 = (-ha - oa) / da;
    let t2 = (ha - oa) / da;
    // Moving +: in through the - face.
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  face.axis = axis;
  face.sign = sign;
  return tmin;
}

export interface Part {
  name: PartName;
  side: -1 | 0 | 1;
  parent: Part | null;
  /** Bone of the skinned body (also the parent for attachments). */
  group: THREE.Bone;
  /** The ragdoll body (dead only: a living body is hit-tested by hand, see Humanoid.raycast). */
  body: RAPIER.RigidBody | null;
  colliders: RAPIER.Collider[];
  /** The hitboxes, in the part's frame (the hit test; the ragdoll's colliders). */
  shapes: PartDef['colliders'];
  /** One bullet receiver per shape. */
  receivers: HitReceiver[];
  /** The bone's world transform as of the last pose (what rounds are tested against). */
  worldPos: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  prevVy: number;
}

export interface DamageInfo {
  hit: BulletHit;
  part: Part;
  zone: HitZone;
  damage: number;
  /** Armor stopped the round (blunt damage only). */
  blocked: boolean;
  surface: SurfaceType;
  killed: boolean;
}

export interface HumanoidHooks {
  onDamage?(info: DamageInfo): void;
  onDeath?(info: DamageInfo): void;
  /** A ragdoll part slammed into something. strength 0..1. */
  onThud?(at: THREE.Vector3, strength: number): void;
  onStagger?(at: THREE.Vector3, strength: number): void;
  /** Went down (last stand) instead of dying. */
  onDowned?(info: DamageInfo): void;
}

/** Animation layer supplied by the owner every frame; reactions are added on top. */
export interface HumanoidPose {
  /** 0 = standing, 1 = deep crouch. */
  crouch: number;
  /** Walk cycle: phase (radians), amount 0..1, sideways share -1..1. */
  stridePhase: number;
  strideAmount: number;
  strideSide: number;
  spineX: number;
  spineY: number;
  headX: number;
  headY: number;
  /** Hand targets (objects anywhere under the torso), or null for free-hanging arms. */
  gripL: THREE.Object3D | null;
  gripR: THREE.Object3D | null;
  /** Idle breathing / look-around (dummies). */
  idle: boolean;
  /** Free-arm pitch per arm (negative = forward/up), elbow bend. Ignored with grips. */
  armL: number;
  armR: number;
  elbows: number;
  /** Leaning out round a corner (Q / E): -1 left … 1 right. The torso rolls by lean × LEAN_ROLL. */
  lean?: number;
  /** The head's roll about its line of sight (rad, + = its top toward −X): a cheek laid on a stock. */
  headRoll?: number;
}

/** Torso roll at full lean (rad). */
export const LEAN_ROLL = 0.5;

/**
 * Ground covered by one full walk cycle (m) at a stride amount: what the legs' swing
 * actually sweeps (two steps, each 2 × leg × sin(swing)). Advancing the phase by
 * distance / this keeps the planted foot still on the floor: a fixed cycle length
 * made slow walkers skate (half the swing for the same distance) and runners overreach.
 */
export const strideLength = (amount: number): number => Math.max(0.45, 4 * 0.9 * Math.sin(0.42 * Math.max(0.25, amount)));

export const defaultPose = (): HumanoidPose => ({
  crouch: 0, stridePhase: 0, strideAmount: 0, strideSide: 0, spineX: 0, spineY: 0, headX: 0, headY: 0, gripL: null, gripR: null, idle: true,
  armL: 0, armR: 0, elbows: 0,
});

const MAX_TILT = 24 * DEG;
const ONE = new THREE.Vector3(1, 1, 1);
/** Phones (cheap characters): hidden bodies pose less often, corpses keep fewer CCD bodies. */
const lowSpec = (): boolean => skinDetail.low;
/** Where the player's view is (Game sets it each frame): phones pose far bodies less often. */
export const humanoidView = new THREE.Vector3(0, -1e5, 0);
/** Phones: visible bodies beyond this (m²) pose every other frame. */
const FAR_SQ = 30 * 30;
/**
 * Model bodies far from the camera swap to their simplified geometry (public/chars/lod, ~4.5k
 * triangles instead of 15-40k) past LOD_FAR m, back inside LOD_NEAR (no flicker at the edge),
 * and only bodies within SHADOW m cast a shadow: a crowd in the sun's shadow camera was
 * drawing every robot's full mesh a second time each frame.
 */
const LOD_FAR_SQ = 14 * 14;
const LOD_NEAR_SQ = 12.5 * 12.5;
const SHADOW_SQ = 14 * 14;
const speedSq = (v: { x: number; y: number; z: number }): number => v.x * v.x + v.y * v.y + v.z * v.z;

/**
 * A physical humanoid body shared by robots and soldiers.
 *
 * - Alive: every part's hitboxes follow the animated pose (what you see is what you
 *   hit), tested by hand against each round (raycast(): no physics bodies, one capsule
 *   keeps the player out). Zones: head, thorax, stomach, arms, legs, with
 *   optional armor per box. Hits drive layered spring reactions sized by
 *   the round's momentum — head snap, chest stagger, gut fold, arm throw, knee
 *   buckle, step back — and repeated hits build stagger.
 * - Dead: the parts become dynamic bodies jointed into a ragdoll that
 *   inherits the animated velocity plus the killing round's momentum at the
 *   exact hit point; the knees buckle as it drops.
 *
 * The owner positions `root`, feeds a HumanoidPose each frame and decides what
 * damage means (AI alerts, respawn...).
 */
export class Humanoid implements HitSet {
  readonly root = new THREE.Group();
  readonly health: Damageable;
  readonly parts: Part[] = [];
  /** Ankle bones (left, right): visual only, posed flat in updatePose. */
  private feet: THREE.Bone[] = [];
  /** A body drawn by a skeleton of its own (HumanoidSkin.visual), or null. */
  visual: HumanoidVisual | null = null;
  /**
   * Which way each side's limbs lie from the centre line ([left, right], ±1, from the skin's own
   * joints): procedural and model bodies put "R" at +X, the master humanoid its anatomical right
   * (−X). Arm splay, elbow poles, pelvis roll and hit throws go that way.
   */
  private sideSign: [number, number] = [-1, 1];
  private byName = new Map<PartName, Part>();
  private pivot = new THREE.Group();
  /** The whole body is ONE skinned mesh (a draw call per material), parts are bones. */
  private mesh!: THREE.SkinnedMesh;
  /** Model bodies: the full and the far-away geometry, which one is up, and whether to cast shadows at all. */
  private nearGeo: THREE.BufferGeometry | null = null;
  private farGeo: THREE.BufferGeometry | null = null;
  private lodFar = false;
  private shadowWanted = true;
  private pendingGeo: Map<THREE.Material, THREE.BufferGeometry[]>[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  private knees: RAPIER.RevoluteImpulseJoint[] = [];

  // Leg geometry, read from the skin.
  private thigh: number;
  private shin: number;
  private hipHalf: number;
  private hipOffset: number;
  private idleKnee: number;
  private machine: boolean;
  private upperLen: number;
  private gripLocal: THREE.Vector3;

  // --- Reaction springs (radians / metres) ---
  private tiltX = new Spring(60, 7);
  private tiltZ = new Spring(60, 7);
  private bodyYaw = new Spring(70, 8);
  private step = new Spring3(30, 9);
  private spineX = new Spring(140, 11);
  private spineY = new Spring(120, 10);
  private spineZ = new Spring(140, 11);
  private headX = new Spring(190, 12);
  private headY = new Spring(160, 11);
  private headZ = new Spring(190, 12);
  private armX = [new Spring(110, 7), new Spring(110, 7)];
  private armZ = [new Spring(110, 7), new Spring(110, 7)];
  private elbow = [new Spring(120, 9), new Spring(120, 9)];
  private knee = [new Spring(90, 10), new Spring(90, 10)];
  readonly rise = new Spring(130, 11);

  /** On the player's side: rounds from the player and allies pass harmlessly. */
  friendly = false;
  /** Team id: rounds from the same team pass harmlessly ('' = no team). */
  team = '';
  /** Asked when health runs out: true = go down (a teammate can revive) instead of dying. */
  canGoDown: (() => boolean) | null = null;
  /** Down but not out: kneeling, can't act, bleeding out. */
  downed = false;
  bleed = 0;
  /** Accumulated stagger (0..2): bigger reactions, unsteady sway. */
  stagger = 0;
  private kneelTimer = [0, 0];
  private legWound = [0, 0];
  private time = Math.random() * 100;
  private ragdollTime = 0;
  private thudCooldown = 0;
  private teleport = true;
  private inv = new THREE.Quaternion();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpScale = new THREE.Vector3();
  private linvel = { x: 0, y: 0, z: 0 };
  // Hidden-body LOD (phones): time not yet posed, skipped frames, root at the last pose.
  private lodDt = 0;
  private lodSkip = 0;
  private frozen = false;
  private lastPose: HumanoidPose | null = null;
  private lastRootPos = new THREE.Vector3();
  private lastRootQuat = new THREE.Quaternion();
  /** Every ragdoll part asleep: the bones already sit where the bodies are. */
  private settled = false;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private info: DamageInfo = {
    hit: null as unknown as BulletHit, part: null as unknown as Part, zone: 'thorax', damage: 0, blocked: false, surface: 'robot', killed: false,
  };

  constructor(
    private physics: Physics,
    scene: THREE.Object3D,
    readonly skin: HumanoidSkin,
    private hooks: HumanoidHooks,
    /** Bullets fired by the owner ignore these hitboxes. */
    readonly owner: object,
  ) {
    this.health = new Damageable(skin.health);
    this.root.add(this.pivot);
    scene.add(this.root);
    for (const def of skin.parts) this.buildPart(def);
    this.buildSkin();

    const thigh = this.part('thighR').group.position;
    this.hipHalf = Math.abs(thigh.x);
    this.hipOffset = -thigh.y;
    this.sideSign = [Math.sign(this.part('upperArmL').group.position.x) || -1, Math.sign(this.part('upperArmR').group.position.x) || 1];
    this.thigh = -this.part('shinR').group.position.y;
    this.shin = skin.shinLength;
    this.idleKnee = skin.idleKnee ?? 0.1;
    this.machine = skin.gait === 'machine';
    this.upperLen = this.part('foreArmR').group.position.length();
    this.gripLocal = new THREE.Vector3(...skin.handGrip);
    this.hips = this.part('pelvis');
    this.measure();
    for (const part of this.parts) part.group.matrixWorld.decompose(part.worldPos, part.worldQuat, this.tmpScale);
    this.setHits(true);
    this.setBlocker(true);
  }

  get alive(): boolean {
    return this.health.alive;
  }

  /**
   * Bake every part's geometry (in the rest pose) into one skinned mesh: vertex
   * skin index = part, weight 1 (rigid parts). Plain materials fold into the skin's
   * vertex-coloured merge material; the rest become material groups.
   */
  private buildSkin(): void {
    // Feet: a bone at each ankle (no physics body), so boots stay flat on the floor as
    // the leg swings instead of tipping with the shin. Boot pieces (built at the shin's
    // lower end) are skinned to it.
    const ankleY = -this.skin.shinLength * 0.8;
    const footOf = new Map<Part, number>();
    for (const name of ['shinL', 'shinR'] as const) {
      const shin = this.byName.get(name);
      if (!shin) continue;
      const foot = new THREE.Bone();
      foot.position.set(0, ankleY, 0);
      shin.group.add(foot);
      footOf.set(shin, this.parts.length + this.feet.length);
      this.feet.push(foot);
    }
    this.root.updateMatrixWorld(true);
    if (this.skin.visual) {
      // A body with a skeleton of its own, following the parts (HumanoidSkin.visual).
      const v = (this.visual = this.skin.visual(this));
      this.mesh = v.mesh;
      this.nearGeo = v.near;
      this.farGeo = v.far;
      this.pendingGeo.length = 0;
      return;
    }
    if (this.skin.body) {
      // A model body: its geometry is already in the rest pose, weighted by slot name.
      const bone = (slot: string): THREE.Bone =>
        slot === 'footL' ? this.feet[0] : slot === 'footR' ? this.feet[1] : this.part(slot as PartName).group;
      const { geometry, materials, slots } = this.skin.body;
      this.mesh = new THREE.SkinnedMesh(geometry, materials);
      this.nearGeo = geometry;
      this.farGeo = this.skin.body.lod ?? null;
      this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3.5);
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
      this.root.add(this.mesh);
      this.mesh.updateMatrixWorld(true);
      this.mesh.bind(new THREE.Skeleton(slots.map(bone)));
      this.pendingGeo.length = 0;
      return;
    }
    const merge = this.skin.merge;
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const plain = (m: THREE.Material) => {
      const s = m as THREE.MeshStandardMaterial;
      const emissive = s.emissive && (s.emissive.r + s.emissive.g + s.emissive.b) * (s.emissiveIntensity ?? 1) > 0.001;
      return !!merge && s.isMeshStandardMaterial && !s.map && !s.transparent && !emissive;
    };
    this.parts.forEach((part, idx) => {
      for (const [mat, geos] of this.pendingGeo[idx]) {
        const target = plain(mat) ? merge! : mat;
        const color = plain(mat) ? (mat as THREE.MeshStandardMaterial).color : new THREE.Color(1, 1, 1);
        for (const g of geos) {
          // Below the ankle (in the shin's own space): the foot's.
          let bone = idx;
          const foot = footOf.get(part);
          if (foot !== undefined) {
            g.computeBoundingBox();
            if ((g.boundingBox!.min.y + g.boundingBox!.max.y) / 2 < ankleY + 0.05) bone = foot;
          }
          g.applyMatrix4(part.group.matrixWorld);
          const n = g.getAttribute('position').count;
          const si = new Uint16Array(n * 4);
          const sw = new Float32Array(n * 4);
          const col = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            si[i * 4] = bone;
            sw[i * 4] = 1;
            col[i * 3] = color.r;
            col[i * 3 + 1] = color.g;
            col[i * 3 + 2] = color.b;
          }
          g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
          g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
          g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
          const list = byMat.get(target) ?? [];
          list.push(g);
          byMat.set(target, list);
        }
      }
    });
    this.pendingGeo.length = 0;
    const mats: THREE.Material[] = [];
    const geos: THREE.BufferGeometry[] = [];
    for (const [mat, list] of byMat) {
      const g = mergeGeometries(list, false);
      if (!g) continue;
      mats.push(mat);
      geos.push(g);
      for (const x of list) x.dispose();
    }
    const geometry = mergeGeometries(geos, true)!;
    for (const g of geos) g.dispose();
    // Generous fixed bounds (the ragdoll can spread a few metres from the root).
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3.5);
    this.mesh = new THREE.SkinnedMesh(geometry, mats);
    // The mesh's own sphere (three computes it once from the first pose, then keeps it):
    // generous and fixed, or a ragdoll that falls away from the root gets frustum-culled.
    this.mesh.boundingSphere = geometry.boundingSphere.clone();
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton([...this.parts.map((p) => p.group), ...this.feet]));
  }

  part(name: PartName): Part {
    return this.byName.get(name)!;
  }

  private buildPart(def: PartDef): void {
    const parent = def.parent ? this.part(def.parent) : null;
    const group = new THREE.Bone();
    group.position.set(...def.pos);
    (parent ? parent.group : this.pivot).add(group);
    const b = new MeshBuilder();
    def.build(b);
    this.pendingGeo.push(b.take());

    const part = {
      name: def.name, side: def.side, parent, group, body: null, colliders: [], shapes: def.colliders, receivers: [],
      worldPos: new THREE.Vector3(), worldQuat: new THREE.Quaternion(), prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), prevVy: 0,
    } as unknown as Part;
    part.receivers = def.colliders.map((c) => {
      const surface = c.surface ?? (c.zone === 'head' ? 'robotWeak' : 'robot');
      return { surface, owner: this.owner, allowDecals: false, impulseScale: 3, onBulletHit: (h, o) => this.onHit(h, part, c, surface, o) } as HitReceiver;
    });
    this.parts.push(part);
    this.byName.set(def.name, part);
  }

  /** A dead part's dynamic body and its colliders (the ragdoll; the corpse still takes rounds). */
  private createRagdollBody(part: Part, groups: number, ccd: boolean): void {
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(part.worldPos.x, part.worldPos.y, part.worldPos.z)
        .setRotation(part.worldQuat)
        .setLinearDamping(0.08)
        .setAngularDamping(1.1)
        .setCcdEnabled(ccd),
    );
    part.body = body;
    part.colliders = [];
    part.shapes.forEach((c, k) => {
      const col = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...c.half)
          .setTranslation(...c.center)
          .setMass(c.mass)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setCollisionGroups(groups),
        body,
      );
      part.colliders.push(col);
      const r = part.receivers[k];
      r.body = body;
      this.physics.register(col, r);
    });
  }

  /** The ragdoll's bodies and joints out of the physics world (respawn, pooling). */
  private removeRagdoll(): void {
    this.removeJoints();
    if (!this.ragdolled) return;
    this.ragdolled = false;
    for (const part of this.parts) {
      for (const c of part.colliders) this.physics.unregister(c);
      if (part.body) this.physics.world.removeRigidBody(part.body);
      part.body = null;
      part.colliders = [];
      for (const r of part.receivers) r.body = undefined;
      part.group.matrixWorldAutoUpdate = true;
    }
  }

  /**
   * Pooled and out of play: nothing in the physics world, no hit test. A living body has
   * no physics bodies either: its hitboxes are tested by hand (raycast(), a core/Physics
   * HitSet) and one capsule keeps the player out. Real bodies exist only for the ragdoll.
   */
  private detached = false;
  /** The ragdoll's part bodies exist (dead, in play). */
  private ragdolled = false;
  private hitsOn = false;
  private blocker: RAPIER.RigidBody | null = null;
  private blockerAt = new THREE.Vector3();
  /** The blocker capsule: radius, half the straight part, centre height above the root. */
  private capRadius = 0.3;
  private capHalf = 0.55;
  private capY = 0.85;
  /** Farthest any hitbox reaches from the pelvis pivot, in any pose (the quick reject). */
  private reach = 1.5;
  /** The pelvis part (the hit test's and the capsule's centre). */
  private hips!: Part;

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.removeRagdoll();
    this.setHits(false);
    this.setBlocker(false);
  }

  private attach(): void {
    if (!this.detached) return;
    this.detached = false;
    if (!this.alive) return;
    this.setHits(true);
    this.setBlocker(!this.downed);
  }

  private setHits(on: boolean): void {
    if (this.hitsOn === on) return;
    this.hitsOn = on;
    if (on) this.physics.addHitSet(this);
    else this.physics.removeHitSet(this);
  }

  /** The living body's capsule (blocks the player, pushes props and corpses; bullets pass it). */
  private setBlocker(on: boolean): void {
    if (on === !!this.blocker) return;
    const world = this.physics.world;
    if (!on) {
      world.removeRigidBody(this.blocker!);
      this.blocker = null;
      return;
    }
    const at = this.blockerPos();
    this.blocker = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z));
    world.createCollider(RAPIER.ColliderDesc.capsule(this.capHalf, this.capRadius).setCollisionGroups(GROUPS.blocker), this.blocker);
  }

  private blockerPos(): THREE.Vector3 {
    const p = this.hips.worldPos;
    return this.blockerAt.set(p.x, this.root.position.y + this.capY, p.z);
  }

  /**
   * Sizes of the hit test and the capsule, from the rest pose (root at the origin): the
   * standing height, and how far a box can reach from the pelvis along the joint chain.
   */
  private measure(): void {
    this.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let top = 0;
    let reach = 0;
    for (const part of this.parts) {
      let chain = 0;
      for (let p: Part | null = part; p && p.name !== 'pelvis'; p = p.parent) chain += p.group.position.length();
      for (const c of part.shapes) {
        reach = Math.max(reach, chain + Math.hypot(...c.center) + Math.hypot(...c.half));
        v.set(...c.center).applyMatrix4(part.group.matrixWorld);
        top = Math.max(top, v.y + c.half[1] - this.root.position.y);
      }
    }
    this.reach = reach + 0.05;
    this.capY = top / 2;
    this.capHalf = Math.max(0.05, top / 2 - this.capRadius);
  }

  // ---------------------------------------------------------------- hit test (HitSet)

  private ro = new THREE.Vector3();
  private rd = new THREE.Vector3();
  private qi = new THREE.Quaternion();
  private face = { axis: -1, sign: 0 };

  /** The ray against the sphere round the pelvis that holds every hitbox in any pose. */
  private ballHit(o: THREE.Vector3, d: THREE.Vector3, maxDist: number, r: number): boolean {
    const c = this.hips.worldPos;
    const mx = o.x - c.x;
    const my = o.y - c.y;
    const mz = o.z - c.z;
    const cc = mx * mx + my * my + mz * mz - r * r;
    if (cc <= 0) return true;
    const b = mx * d.x + my * d.y + mz * d.z;
    if (b > 0) return false;
    const disc = b * b - cc;
    return disc >= 0 && -b - Math.sqrt(disc) <= maxDist;
  }

  /** Bullets (core/Physics HitSet): the ray against every part's boxes, in that part's frame. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: SetHit): boolean {
    if (!this.ballHit(origin, dir, maxDist, this.reach)) return false;
    let best = maxDist;
    let hit = false;
    for (const part of this.parts) {
      const qi = this.qi.copy(part.worldQuat).conjugate();
      const lo = this.ro.copy(origin).sub(part.worldPos).applyQuaternion(qi);
      const ld = this.rd.copy(dir).applyQuaternion(qi);
      for (let k = 0; k < part.shapes.length; k++) {
        const s = part.shapes[k];
        const t = boxRay(lo, ld, s.center, s.half, best, this.face);
        if (t < 0) continue;
        best = t;
        hit = true;
        out.distance = t;
        out.receiver = part.receivers[k];
        // The face it came in through, back to world space (from inside: against the ray).
        if (this.face.axis < 0) out.normal.copy(dir).negate();
        else out.normal.set(0, 0, 0).setComponent(this.face.axis, this.face.sign).applyQuaternion(part.worldQuat);
      }
    }
    return hit;
  }

  near(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number): boolean {
    return this.ballHit(origin, dir, maxDist, this.reach + radius);
  }

  // ---------------------------------------------------------------- hits

  private onHit(hit: BulletHit, part: Part, col: ColliderDef, surface: SurfaceType, out: HitResult): void {
    if (!this.alive) return;
    if (this.friendly && !hit.hostile) return;
    if (this.team && hit.team === this.team) return;
    if (this.downed) {
      // Shooting someone who is down finishes them faster.
      this.bleed -= hit.damage * 0.12;
      out.damage = hit.damage * 0.3;
      if (this.bleed <= 0) this.finish(hit, part, col.zone);
      return;
    }
    const zone = col.zone;
    const head = zone === 'head';
    let mult = head ? (this.skin.headMultiplier ?? hit.critMultiplier) : this.skin.zoneDamage[zone];
    // Armor: penetration rating vs armor class decides whether the round gets through.
    let blocked = false;
    if (col.armor) {
      const chance = clamp((hit.penetration - col.armor + 15) / 25, 0.02, 0.97);
      if (Math.random() > chance) {
        blocked = true;
        // Blunt trauma only (a stopped round to the helmet is not a headshot).
        mult = head ? 0.35 : mult * (this.skin.bluntFactor ?? 0.3);
      }
    }
    const dmg = hit.damage * mult;
    if (this.health.health - dmg <= 0 && this.canGoDown?.()) {
      this.goDown(hit, part, zone, dmg);
      out.damage = dmg;
      out.health = 0;
      out.maxHealth = this.health.maxHealth;
      return;
    }
    this.health.applyDamage(dmg);
    out.damage = dmg;
    out.crit = head && !blocked;
    out.health = this.health.health;
    out.maxHealth = this.health.maxHealth;

    const info = this.info;
    info.hit = hit;
    info.part = part;
    info.zone = zone;
    info.damage = dmg;
    info.blocked = blocked;
    info.surface = surface;
    info.killed = !this.alive;
    if (!this.alive) {
      out.killed = true;
      this.die(hit, part, zone);
      this.hooks.onDeath?.(info);
      return;
    }
    this.react(hit, part, zone, dmg);
    this.hooks.onDamage?.(info);
  }

  private goDown(hit: BulletHit, part: Part, zone: HitZone, dmg: number): void {
    this.health.health = 1;
    this.downed = true;
    this.bleed = 30;
    // On the floor: nothing to walk into (the hitboxes still take rounds).
    this.setBlocker(false);
    this.react(hit, part, zone, dmg);
    const info = this.info;
    info.hit = hit;
    info.part = part;
    info.zone = zone;
    info.damage = dmg;
    info.blocked = false;
    info.surface = 'flesh';
    info.killed = false;
    this.hooks.onDowned?.(info);
  }

  /** Bled out / finished while down: now really dead (ragdoll). */
  private finish(hit: BulletHit, part: Part, zone: HitZone): void {
    this.downed = false;
    this.health.health = 0;
    const info = this.info;
    info.hit = hit;
    info.part = part;
    info.zone = zone;
    info.damage = 1;
    info.killed = true;
    this.die(hit, part, zone);
    this.hooks.onDeath?.(info);
  }

  /** Teammate got them up. */
  revive(): void {
    this.attach();
    if (!this.downed) return;
    this.downed = false;
    this.health.health = this.health.maxHealth * 0.5;
    this.setBlocker(true);
  }

  /** Bleed-out ticking (call every frame). */
  tickDowned(dt: number): void {
    if (this.detached) return;
    if (!this.downed) return;
    this.bleed -= dt;
    if (this.bleed <= 0) {
      const torso = this.part('torso');
      const hit: BulletHit = {
        point: torso.worldPos.clone(), normal: new THREE.Vector3(0, 1, 0), direction: new THREE.Vector3(0, -1, 0), distance: 0, damage: 1, impulse: 0.2,
        critMultiplier: 1, weaponId: 'bleed', penetration: 0, hostile: true, ally: false, team: '',
      };
      this.finish(hit, torso, 'thorax');
    }
  }

  /** Melee blow (rogue robot swing): body damage + a hard shove. */
  meleeHit(damage: number, from: THREE.Vector3, impulse = 1.8): void {
    if (this.detached) return;
    if (!this.alive) return;
    const torso = this.part('torso');
    torso.group.getWorldPosition(this.tmp);
    const dir = this.tmp2.copy(this.tmp).sub(from).setY(0).normalize();
    const hit: BulletHit = {
      point: this.tmp.clone(), normal: dir.clone().negate(), direction: dir.clone(), distance: 1, damage, impulse,
      critMultiplier: 1, weaponId: 'melee', penetration: 0, hostile: true, ally: false, team: 'robots',
    };
    if (this.downed) {
      this.bleed -= damage * 0.12;
      if (this.bleed <= 0) this.finish(hit, torso, 'thorax');
      return;
    }
    if (this.health.health - damage <= 0 && this.canGoDown?.()) {
      this.goDown(hit, torso, 'thorax', damage);
      return;
    }
    this.health.applyDamage(damage);
    const info = this.info;
    info.hit = hit;
    info.part = torso;
    info.zone = 'thorax';
    info.damage = damage;
    info.blocked = false;
    info.surface = 'flesh';
    info.killed = !this.alive;
    if (!this.alive) {
      this.die(hit, torso, 'thorax');
      this.hooks.onDeath?.(info);
      return;
    }
    this.react(hit, torso, 'thorax', damage);
    this.hooks.onDamage?.(info);
  }

  /** Living hit reaction: zone-specific spring impulses scaled by the round's momentum. */
  private react(hit: BulletHit, part: Part, zone: HitZone, dmg: number): void {
    // Bullet direction and hit point in body space (facing +Z: shots from the front
    // travel along -Z and push the top of the body backward = negative X rotation).
    this.inv.copy(this.root.quaternion).invert();
    const d = this.tmp.copy(hit.direction).applyQuaternion(this.inv);
    const p = this.tmp2.copy(hit.point).sub(this.root.position).applyQuaternion(this.inv);
    const s = Math.min(4, hit.impulse * feel.hitReactionScale) * (1 + 0.45 * Math.min(1, this.stagger));
    const torque = p.z * d.x - p.x * d.z; // yaw: the struck side is driven away
    const i = part.side > 0 ? 1 : 0;

    // Whole body: lean away from the round, heavy rounds knock it back a step.
    const bodyK = zone === 'arm' ? 0.5 : zone === 'leg' ? 0.6 : 1;
    this.tiltX.impulse(d.z * s * 1.1 * bodyK);
    this.tiltZ.impulse(-d.x * s * 1.1 * bodyK);
    this.bodyYaw.impulse(torque * s * 1.6);
    const push = 0.18 * s + Math.max(0, s - 1.6) * 0.75;
    this.step.impulse(d.x * push, 0, d.z * push);

    switch (zone) {
      case 'head':
        this.headX.impulse(d.z * s * 9);
        this.headZ.impulse(-d.x * s * 6);
        this.headY.impulse(torque * s * 10);
        this.spineX.impulse(d.z * s * 1.8);
        this.armX[0].impulse(d.z * s * 1.5);
        this.armX[1].impulse(d.z * s * 1.5);
        break;
      case 'thorax':
        this.spineX.impulse(d.z * s * 2.4);
        this.spineZ.impulse(-d.x * s * 1.6);
        this.spineY.impulse(torque * s * 8);
        this.headX.impulse(-d.z * s * 1.5); // whiplash: head lags behind the chest
        this.armX[0].impulse(d.z * s * 2);
        this.armX[1].impulse(d.z * s * 2);
        this.elbow[0].impulse(s * 1.2);
        this.elbow[1].impulse(s * 1.2);
        break;
      case 'stomach':
        // Gut shot: folds forward around the hit, knees give a little.
        this.spineX.impulse(s * 2.6 + d.z * s * 0.5);
        this.spineY.impulse(torque * s * 5);
        this.headX.impulse(s * 2);
        this.knee[0].impulse(s * 1.4);
        this.knee[1].impulse(s * 1.4);
        this.elbow[0].impulse(s * 2.5);
        this.elbow[1].impulse(s * 2.5);
        break;
      case 'arm':
        this.armX[i].impulse(-d.z * s * 7);
        this.armZ[i].impulse(d.x * s * 5 + this.sideSign[i] * s * 2);
        this.elbow[i].impulse(s * (part.name.startsWith('fore') ? -3 : 3));
        this.spineY.impulse(torque * s * 12);
        this.spineZ.impulse(-d.x * s * 0.8);
        break;
      case 'leg':
        // Leg buckles; heavy rounds drop the body onto that knee for a moment.
        this.knee[i].impulse(s * 3.8);
        this.knee[1 - i].impulse(s * 1.2);
        this.tiltZ.impulse(-this.sideSign[i] * s * 0.6);
        this.spineX.impulse(s * 1.2);
        this.legWound[i] = Math.min(1, this.legWound[i] + dmg / 90);
        if (s > 1.4 || this.legWound[i] > 0.6) this.kneelTimer[i] = 0.35 + 0.18 * s;
        break;
    }

    const before = this.stagger;
    this.stagger = Math.min(2, this.stagger + 0.22 * s);
    if (s > 2.2 || (before < 1 && this.stagger >= 1)) {
      this.part('torso').group.getWorldPosition(this.tmp);
      this.hooks.onStagger?.(this.tmp, Math.min(1, s / 3));
    }
  }

  // ---------------------------------------------------------------- death

  private die(hit: BulletHit, struck: Part, zone: HitZone): void {
    this.attach();
    // A hidden body may be a frame behind (LOD): pose it now so the ragdoll starts
    // from the current pose with fresh velocities.
    this.setFrozen(false);
    if (this.lodDt > 0 && this.lastPose) {
      this.updatePose(this.lodDt, this.lastPose);
      this.updateHitboxes(this.lodDt);
    }
    this.lodDt = 0;
    this.settled = false;
    const lite = lowSpec();
    this.root.updateMatrixWorld(true);
    // The living hit test and capsule give way to real bodies, at the pose and speed the
    // animation had.
    this.setHits(false);
    this.setBlocker(false);
    this.removeRagdoll();
    this.ragdolled = true;
    for (const part of this.parts) {
      part.group.matrixWorld.decompose(part.worldPos, part.worldQuat, this.tmpScale);
      // Phones: CCD on the heavy core only (the joints hold the limbs to it).
      this.createRagdollBody(part, lite ? GROUPS.ragdollLite : GROUPS.ragdoll, !lite || part.name === 'torso' || part.name === 'pelvis');
      part.vel.clampLength(0, 6);
      part.body!.setLinvel(part.vel, true);
      // From now on the bones follow the physics bodies directly.
      part.group.matrixWorldAutoUpdate = false;
      part.prevVy = 0;
    }
    this.buildJoints(zone === 'head');

    // The killing round: its momentum at the exact hit point, plus a whole-body shove
    // so heavy rounds visibly carry the body (Mosin/Kar98 more than a 5.56).
    const momentum = (hit.impulse / 0.18) * feel.ragdollForce;
    const dir = hit.direction;
    struck.body!.applyImpulseAtPoint(
      { x: dir.x * momentum * 1.5, y: dir.y * momentum * 1.5, z: dir.z * momentum * 1.5 },
      hit.point,
      true,
    );
    const shove = Math.min(2.4, momentum * 0.075);
    for (const part of this.parts) {
      const m = part.body!.mass();
      const lift = part.name === 'head' || part.name === 'torso' ? 0.25 : 0;
      part.body!.applyImpulse({ x: dir.x * shove * m, y: lift * shove * m, z: dir.z * shove * m }, true);
    }
    if (zone === 'head') {
      // Head snaps back and drags the upper body with it: falls backward.
      const k = momentum * 0.9;
      this.part('head').body!.applyImpulse({ x: dir.x * k, y: k * 0.35, z: dir.z * k }, true);
      this.part('torso').body!.applyImpulse({ x: dir.x * k * 0.8, y: 0, z: dir.z * k * 0.8 }, true);
    }
    this.ragdollTime = 0;
  }

  private buildJoints(headshot: boolean): void {
    const world = this.physics.world;
    const link = (parentName: PartName, childName: PartName, data: RAPIER.JointData) => {
      const j = world.createImpulseJoint(data, this.part(parentName).body!, this.part(childName).body!, true);
      j.setContactsEnabled(false);
      this.joints.push(j);
      return j;
    };
    // Anchor on the parent = the child's rest offset; anchor on the child = its origin (the pivot).
    const anchor = (child: PartName) => {
      const p = this.part(child).group.position;
      return { x: p.x, y: p.y, z: p.z };
    };
    const ZERO = { x: 0, y: 0, z: 0 };
    const X_AXIS = { x: 1, y: 0, z: 0 };
    const ball = (parent: PartName, child: PartName, tone: number, damping: number) => {
      const j = link(parent, child, RAPIER.JointData.spherical(anchor(child), ZERO));
      // The JS wrapper's SphericalImpulseJoint lacks the per-axis motor methods its
      // typings declare; the raw joint set has them.
      const raw = (j as unknown as { rawSet: { jointConfigureMotorPosition(h: number, axis: number, pos: number, k: number, c: number): void } }).rawSet;
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        raw.jointConfigureMotorPosition(j.handle, axis, 0, tone, damping);
      }
      this.tone.push({ raw, handle: j.handle, tone, damping });
    };

    // Spherical joints with "muscle tone" everywhere the living pose can twist;
    // hinge knees (with limits) so legs fold the right way.
    ball('pelvis', 'torso', 10, 3);
    ball('torso', 'head', 8, 2);
    for (const s of ['L', 'R'] as const) {
      ball('torso', `upperArm${s}`, 2, 1.2);
      ball(`upperArm${s}`, `foreArm${s}`, 3, 1);
      ball('pelvis', `thigh${s}`, 6, 2);
      const knee = link(`thigh${s}`, `shin${s}`, RAPIER.JointData.revolute(anchor(`shin${s}`), ZERO, X_AXIS)) as RAPIER.RevoluteImpulseJoint;
      knee.setLimits(0, 2.5);
      // Death collapse: knees buckle under the body for a moment (limp on a headshot).
      knee.configureMotorPosition(1.7, headshot ? 25 : 55, 6);
      this.knees.push(knee);
    }
  }

  private removeJoints(): void {
    for (const j of this.joints) this.physics.world.removeImpulseJoint(j, true);
    this.joints.length = 0;
    this.knees.length = 0;
    this.tone.length = 0;
    this.toneStage = 0;
  }

  /** The spherical joints' "muscle tone" motors (released as the body goes limp). */
  private tone: { raw: { jointConfigureMotorPosition(h: number, axis: number, pos: number, k: number, c: number): void }; handle: number; tone: number; damping: number }[] = [];
  private toneStage = 0;

  /** Weaken every spherical joint's tone to `share` of its strength (damping stays: no jelly). */
  private setTone(share: number): void {
    for (const t of this.tone) {
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) t.raw.jointConfigureMotorPosition(t.handle, axis, 0, t.tone * share, t.damping);
    }
    // A body asleep in its last pose wouldn't notice: let it settle again.
    for (const part of this.parts) part.body?.wakeUp();
  }

  /**
   * Pooling: an inactive body is invisible and has no colliders (no hits, no
   * blocking). Reactivate with reset().
   */
  setActive(active: boolean): void {
    this.setFrozen(false);
    this.root.visible = active;
    if (active) this.attach();
    else this.detach();
  }

  /** Phones: many bodies in the shadow pass get expensive. */
  /**
   * A model body's look: its geometry (weighted to the same slots, rest pose on this
   * body's joints) and materials. Pass `geometry` null to keep the shape and only
   * swap the materials (e.g. per-body copies to tint). Procedural bodies ignore it.
   */
  setBodyLook(geometry: THREE.BufferGeometry | null, materials: THREE.Material[]): void {
    if (!this.skin.body) return;
    if (geometry) {
      this.nearGeo = geometry;
      if (!this.lodFar) this.mesh.geometry = geometry;
    }
    this.mesh.material = materials;
  }

  setCastShadow(cast: boolean): void {
    this.shadowWanted = cast;
    this.mesh.castShadow = cast;
  }

  /** Back to a living, standing body at the root's current transform. */
  reset(fromFloor: boolean): void {
    this.attach();
    this.removeRagdoll();
    this.setFrozen(false);
    this.lodDt = 0;
    this.settled = false;
    for (const part of this.parts) part.group.matrixWorldAutoUpdate = true;
    this.health.reset();
    this.downed = false;
    this.setHits(true);
    this.setBlocker(true);
    for (const s of [this.tiltX, this.tiltZ, this.bodyYaw, this.spineX, this.spineY, this.spineZ, this.headX, this.headY, this.headZ, ...this.armX, ...this.armZ, ...this.elbow, ...this.knee]) {
      s.reset();
    }
    this.step.reset();
    this.stagger = 0;
    this.kneelTimer[0] = this.kneelTimer[1] = 0;
    this.legWound[0] = this.legWound[1] = 0;
    this.rise.reset(0);
    // Pop up out of the floor with a little overshoot.
    if (fromFloor) this.rise.value = -1.9;
    this.teleport = true;
  }

  // ---------------------------------------------------------------- update

  /**
   * @param still The owner is standing still (dormant, idle, holding a spot): on
   *              phones a hidden body that hasn't moved then skips posing entirely.
   */
  update(dt: number, pose: HumanoidPose, still = false): void {
    // Pooled (out of play): nothing to pose, no hitboxes to move.
    if (this.detached) return;
    this.updateLod();
    if (!this.alive) {
      // No ragdoll (dead and brought back into play without a reset): nothing to move.
      if (!this.ragdolled) return;
      // A settled corpse costs nothing until something wakes it (once the knees are limp;
      // the frame it falls asleep still syncs the bones one last time).
      if (this.settled || this.knees.length === 0) {
        const was = this.settled;
        this.settled = this.allAsleep();
        if (this.settled && was) {
          this.ragdollTime += dt;
          return;
        }
      }
      this.updateRagdoll(dt);
      return;
    }
    this.lastPose = pose;
    const far = lowSpec() && this.root.visible && this.root.position.distanceToSquared(humanoidView) > FAR_SQ;
    if (far && !this.teleport) {
      // Phones, visible but far (30 m+): pose every other frame over the time of both
      // (at that size 30 Hz motion doesn't show; the hitboxes trail by one frame at most).
      this.setFrozen(false);
      this.lodDt += dt;
      if (++this.lodSkip < 2) return;
      this.lodSkip = 0;
      dt = this.lodDt;
    } else if (lowSpec() && !this.root.visible && !this.teleport) {
      if (still && this.root.position.equals(this.lastRootPos) && this.root.quaternion.equals(this.lastRootQuat)) {
        // Hidden and standing still: the hitboxes already sit where the pose put them.
        this.lodDt = 0;
        this.setFrozen(true);
        return;
      }
      this.setFrozen(false);
      // Hidden and moving: pose every third frame, over the time of all three (the
      // hitboxes trail by at most two frames, only in rooms you can't see).
      this.lodDt += dt;
      if (++this.lodSkip < 3) return;
      this.lodSkip = 0;
      dt = this.lodDt;
    } else {
      // Visible (or just reset): always a full update, including any skipped time.
      dt += this.lodDt;
      this.setFrozen(false);
    }
    this.lodDt = 0;
    this.updatePose(dt, pose);
    this.visual?.posed(dt, this.lodFar);
    this.updateHitboxes(dt);
    this.lastRootPos.copy(this.root.position);
    this.lastRootQuat.copy(this.root.quaternion);
  }

  /** Far geometry and shadow by distance from the camera (model bodies; see LOD_FAR_SQ). */
  private updateLod(): void {
    const d2 = this.root.position.distanceToSquared(humanoidView);
    if (this.farGeo && this.nearGeo) {
      const far = this.lodFar ? d2 > LOD_NEAR_SQ : d2 > LOD_FAR_SQ;
      if (far !== this.lodFar) {
        this.lodFar = far;
        this.mesh.geometry = far ? this.farGeo : this.nearGeo;
      }
    }
    const cast = this.shadowWanted && d2 < SHADOW_SQ;
    if (this.mesh.castShadow !== cast) this.mesh.castShadow = cast;
  }

  private allAsleep(): boolean {
    for (const part of this.parts) if (!part.body!.isSleeping()) return false;
    return true;
  }

  /**
   * Hidden and unposed: the renderer's per-frame matrix pass stops recomposing the
   * rig (its matrices are still right). Anything that poses it unfreezes it first.
   */
  private setFrozen(on: boolean): void {
    if (this.frozen === on) return;
    this.frozen = on;
    const auto = !on;
    this.root.matrixAutoUpdate = this.root.matrixWorldAutoUpdate = auto;
    this.pivot.matrixAutoUpdate = this.pivot.matrixWorldAutoUpdate = auto;
    for (const part of this.parts) {
      part.group.matrixAutoUpdate = part.group.matrixWorldAutoUpdate = auto;
      // Standing still: nothing for a ragdoll to inherit.
      if (on) part.vel.set(0, 0, 0);
    }
  }

  /** Current world-space knee/hip offset caused by reactions (AI aim disruption). */
  get reactionMagnitude(): number {
    return Math.abs(this.spineX.value) + Math.abs(this.spineY.value) + Math.abs(this.tiltX.value) + Math.abs(this.tiltZ.value);
  }

  private updatePose(dt: number, pose: HumanoidPose): void {
    this.time += dt;
    const t = this.time;
    this.stagger = Math.max(0, this.stagger - dt * 0.65);
    const wobble = Math.min(1, this.stagger);
    const hurt = 1 - this.health.health / this.health.maxHealth;
    const idle = pose.idle && !this.machine ? 1 : 0;
    const machine = this.machine;

    // Targets: idle breathing, a hunch when hurt, unsteady sway while staggered,
    // a limp toward a wounded leg.
    this.tiltX.target = Math.sin(t * 2.3) * 0.05 * wobble;
    this.tiltZ.target = Math.sin(t * 1.7 + 1) * 0.06 * wobble + (this.legWound[0] - this.legWound[1]) * 0.05;
    this.spineX.target = Math.sin(t * 1.6) * 0.015 * idle + hurt * 0.12 + wobble * 0.08;
    this.headX.target = Math.sin(t * 0.7) * 0.03 * idle + hurt * 0.08;
    this.headY.target = Math.sin(t * 0.45 + 2) * 0.12 * idle;
    for (let i = 0; i < 2; i++) {
      this.kneelTimer[i] = Math.max(0, this.kneelTimer[i] - dt);
      this.legWound[i] = Math.max(0, this.legWound[i] - dt * 0.04);
      const kneel = this.kneelTimer[i] > 0 ? 0.62 : 0;
      const other = this.kneelTimer[1 - i] > 0 ? 0.3 : 0;
      this.knee[i].target = Math.max(kneel, other) + this.legWound[i] * 0.18 + wobble * 0.12;
    }

    const spring = (s: Spring, lo: number, hi: number) => {
      s.update(dt);
      if (s.value < lo || s.value > hi) {
        s.value = clamp(s.value, lo, hi);
        s.velocity *= -0.25;
      }
      return s.value;
    };
    const tiltX = spring(this.tiltX, -MAX_TILT, MAX_TILT);
    const tiltZ = spring(this.tiltZ, -MAX_TILT, MAX_TILT);
    const yaw = spring(this.bodyYaw, -0.6, 0.6);
    const step = this.step.update(dt);
    const rise = this.rise.update(dt);
    const spineX = spring(this.spineX, -0.5, 0.75);
    const spineY = spring(this.spineY, -0.7, 0.7);
    const spineZ = spring(this.spineZ, -0.4, 0.4);
    const headX = spring(this.headX, -0.8, 0.6);
    const headY = spring(this.headY, -0.8, 0.8);
    const headZ = spring(this.headZ, -0.5, 0.5);

    this.pivot.position.set(clamp(step.x, -0.5, 0.5), rise, clamp(step.z, -0.5, 0.5));
    this.pivot.rotation.set(tiltX, yaw, tiltZ);

    // Legs: two-bone knee bend (crouch + reactions), walk cycle on top; the pelvis
    // height follows the legs so the feet stay near the floor.
    const crouchTheta = pose.crouch * 0.95;
    const stride = pose.strideAmount;
    // Standing with a gun: an athletic stance (knees soft, feet apart, the off-side foot a
    // half step forward) instead of a mannequin's locked knees and heels together.
    const armed = pose.gripL || pose.gripR ? 1 : 0.4;
    const stance = Math.max(0, 1 - stride * 2.5) * armed * (1 - pose.crouch);
    const theta = [0, 0];
    const height = [0, 0];
    for (let i = 0; i < 2; i++) {
      theta[i] = this.idleKnee + crouchTheta + spring(this.knee[i], 0, 1.1) + 0.1 * stance;
      height[i] = (this.thigh + this.shin) * Math.cos(theta[i]);
    }
    const roll = clamp(Math.atan2(height[1] - height[0], this.hipHalf * 2), -0.25, 0.25) * this.sideSign[1];
    const pelvis = this.part('pelvis').group;
    // A machine drops onto each footfall (|sin| = 1 as a swing ends) instead of rolling over it.
    const clunk = machine ? stride * Math.pow(Math.abs(Math.sin(pose.stridePhase)), 12) : 0;
    const bob = machine ? clunk * 0.045 : stride * 0.035 * (1 - Math.abs(Math.cos(pose.stridePhase)));
    pelvis.position.y = (height[0] + height[1]) * 0.5 + this.hipOffset - bob;
    pelvis.rotation.set(0, machine ? 0 : Math.sin(pose.stridePhase) * 0.08 * stride, roll);
    const fwd = 1 - Math.abs(pose.strideSide);
    for (let i = 0; i < 2; i++) {
      const s = i === 1 ? 'R' : 'L';
      const ph = pose.stridePhase + i * Math.PI;
      const swing = (machine ? tri(ph) : Math.sin(ph)) * 0.42 * stride;
      // Machine: the knee snaps up at the start of the swing and holds, a short high step.
      const lift = (machine ? Math.sqrt(Math.max(0, Math.cos(ph))) * 0.6 : Math.max(0, Math.cos(ph)) * 0.75) * stride;
      const abduct = Math.sin(ph) * 0.3 * stride * pose.strideSide;
      const thigh = this.part(`thigh${s}`).group;
      // Feet apart (outward is away from the body's centre) and staggered: left ahead.
      const out = Math.sign(thigh.position.x) * 0.06 * stance;
      const stagger = (i === 0 ? -0.16 : 0.1) * stance;
      const tx = -theta[i] - swing * fwd - lift * 0.35 + stagger;
      const sx = 2 * theta[i] + lift;
      thigh.rotation.set(tx, 0, -roll + abduct + out);
      this.part(`shin${s}`).group.rotation.set(sx, 0, 0);
      // The foot stays level: it takes back the thigh's and shin's pitch and the body's
      // tilt, then toes up a little through the swing.
      const foot = this.feet[i];
      if (foot) foot.rotation.set(-(tx + sx) - tiltX - lift * 0.25, 0, -out);
    }

    const torso = this.part('torso').group;
    // Leaning into the run; a slight forward lean over the gun when standing to shoot.
    torso.rotation.set(spineX + pose.spineX + pose.crouch * 0.18 + stride * (machine ? 0.03 : 0.1) + clunk * 0.04 + stance * 0.05, spineY + pose.spineY - pelvis.rotation.y, spineZ - roll * 0.6 + (pose.lean ?? 0) * LEAN_ROLL);
    this.part('head').group.rotation.set(headX + pose.headX, headY + pose.headY, headZ + (pose.headRoll ?? 0));
    // Grip targets are read in torso space: one matrix pass serves both arms.
    if (pose.gripL || pose.gripR) torso.updateMatrixWorld(true);

    for (let i = 0; i < 2; i++) {
      const side = this.sideSign[i];
      const s = i === 1 ? 'R' : 'L';
      const ax = spring(this.armX[i], -1.3, 1.3) + Math.sin(t * 1.3 + i) * 0.02 * idle;
      const az = spring(this.armZ[i], -1, 1);
      const el = spring(this.elbow[i], -0.15, 1.6);
      const upper = this.part(`upperArm${s}`).group;
      const fore = this.part(`foreArm${s}`).group;
      const grip = i === 1 ? pose.gripR : pose.gripL;
      if (grip) {
        this.solveArm(upper, fore, grip, side);
        // Reactions knock the hand off the weapon for a moment.
        upper.quaternion.multiply(this.qa.setFromEuler(this.euler.set(ax * 0.6, 0, az * 0.6)));
        fore.quaternion.multiply(this.qa.setFromEuler(this.euler.set(-Math.max(0, el) * 0.5, 0, 0)));
      } else {
        // Walking arms swing opposite the legs (this arm forward with the other leg),
        // elbows bending more as the pace picks up.
        // A machine's arms pump short and level, like pistons.
        const armPh = pose.stridePhase + (1 - i) * Math.PI;
        const armSwing = machine ? -tri(armPh) * 0.16 * stride : -Math.sin(armPh) * 0.38 * stride;
        upper.rotation.set(ax + (i === 1 ? pose.armR : pose.armL) + armSwing, 0, az + side * (0.06 + hurt * 0.04));
        fore.rotation.set(-(0.15 + el + pose.elbows + stride * (machine ? 0.08 : 0.35)), 0, 0);
      }
    }
  }

  /** Where the hand grips, in the forearm's own space (m). */
  get handPoint(): THREE.Vector3 {
    return this.gripLocal;
  }

  /** The ankle bones ([left, right], children of the shins): kept level, a visual's feet follow them. */
  get footBones(): readonly THREE.Bone[] {
    return this.feet;
  }

  /** Shoulder to hand-grip point with the arm straight (m): how far a grip can be reached. */
  get armReach(): number {
    return this.upperLen + this.gripLocal.length();
  }

  /** Two-bone IK in torso space: shoulder → elbow → hand on `grip` (torso matrices already current). */
  private solveArm(upper: THREE.Object3D, fore: THREE.Object3D, grip: THREE.Object3D, side: number): void {
    const torso = upper.parent!;
    const target = this.ik.target.setFromMatrixPosition(this.tmpM.copy(torso.matrixWorld).invert().multiply(grip.matrixWorld));
    const S = upper.position;
    const L1 = this.upperLen;
    const L2 = this.gripLocal.length();
    const dir = this.ik.dir.subVectors(target, S);
    const d = clamp(dir.length(), Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.002);
    dir.normalize();
    const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    // Elbows hang down and out, slightly back.
    const perp = this.ik.perp.set(side * 0.55, -1, -0.15);
    perp.addScaledVector(dir, -perp.dot(dir)).normalize();
    const elbow = this.ik.elbow.copy(S).addScaledVector(dir, L1 * Math.cos(a)).addScaledVector(perp, L1 * Math.sin(a));
    const upperDir = this.ik.a.subVectors(elbow, S).normalize();
    upper.quaternion.setFromUnitVectors(this.ik.b.copy(fore.position).normalize(), upperDir);
    const foreDir = this.ik.a.copy(S).addScaledVector(dir, d).sub(elbow).normalize();
    this.qb.setFromUnitVectors(this.ik.b.copy(this.gripLocal).normalize(), foreDir);
    fore.quaternion.copy(this.qa.copy(upper.quaternion).invert()).multiply(this.qb);
  }
  private ik = { target: new THREE.Vector3(), dir: new THREE.Vector3(), perp: new THREE.Vector3(), elbow: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };

  /** The hitboxes follow the animated pose (the hit test reads them); velocities for the ragdoll; the capsule follows. */
  private updateHitboxes(dt: number): void {
    this.root.updateMatrixWorld(true);
    for (const part of this.parts) {
      // The pass above made every matrixWorld current: read it, don't walk the parents again.
      part.group.matrixWorld.decompose(part.worldPos, part.worldQuat, this.tmpScale);
      if (this.teleport) {
        part.prevPos.copy(part.worldPos);
        part.vel.set(0, 0, 0);
      } else {
        if (dt > 1e-5) {
          part.vel.subVectors(part.worldPos, part.prevPos).divideScalar(dt);
          // The pop-up from the floor is not momentum.
          if (this.rise.value < -0.05) part.vel.y = 0;
        }
        part.prevPos.copy(part.worldPos);
      }
    }
    if (this.blocker) {
      if (this.teleport) this.blocker.setTranslation(this.blockerPos(), true);
      else this.blocker.setNextKinematicTranslation(this.blockerPos());
    }
    this.teleport = false;
  }

  private updateRagdoll(dt: number): void {
    this.ragdollTime += dt;
    // Bones = physics bodies (body origin = bone pivot).
    for (const part of this.parts) {
      part.body!.translation(part.worldPos);
      part.body!.rotation(part.worldQuat);
      part.group.matrixWorld.compose(part.worldPos, part.worldQuat, ONE);
    }
    // Attachments still on the bones (chest markers...) follow.
    for (const part of this.parts) for (const c of part.group.children) if (!(c as THREE.Bone).isBone) c.updateMatrixWorld(true);
    for (const f of this.feet) f.updateMatrixWorld(true);
    this.visual?.posed(dt, this.lodFar);
    // Joint jitter keeps a corpse awake long after it has come to rest (a dozen bodies
    // in the solver each): once it's barely moving, put it to sleep (sooner on phones, and
    // sooner still for a corpse nobody can see or that lies 30 m+ away).
    const unseen = lowSpec() && (!this.root.visible || this.part('torso').worldPos.distanceToSquared(humanoidView) > FAR_SQ);
    if (this.ragdollTime > (lowSpec() ? (unseen ? 1.2 : 3.5) : 6) && this.parts.every((p) => p.body!.isSleeping() || speedSq(p.body!.linvel(this.linvel)) < 0.25)) {
      for (const part of this.parts) part.body!.sleep();
    }
    // Knees only buckle at the moment of death; afterwards the body is fully limp.
    if (this.ragdollTime > 0.45 && this.knees.length) {
      for (const k of this.knees) k.configureMotorPosition(0, 0, 1);
      this.knees.length = 0;
    }
    // The muscle tone goes too: it held the hips and torso in the standing pose, so a
    // body that buckled stayed kneeling like a statue. A little stays (and the joint
    // friction) so the head and limbs don't twist into impossible angles.
    if (this.toneStage === 0 && this.ragdollTime > 0.45) {
      this.toneStage = 1;
      this.setTone(0.15);
    } else if (this.toneStage === 1 && this.ragdollTime > 1.1) {
      this.toneStage = 2;
      this.setTone(0.04);
    }
    // Body-fall sounds: a heavy part that was falling fast and suddenly stopped.
    this.thudCooldown -= dt;
    for (const part of this.parts) {
      const vy = part.body!.linvel(this.linvel).y;
      const heavy = part.name === 'torso' || part.name === 'pelvis' || part.name === 'head';
      if (heavy && this.thudCooldown <= 0 && part.prevVy < -2.2 && vy > part.prevVy * 0.35) {
        this.tmp.copy(part.worldPos);
        this.hooks.onThud?.(this.tmp, Math.min(1, -part.prevVy / 7));
        this.thudCooldown = 0.12;
      }
      part.prevVy = vy;
    }
  }
}
