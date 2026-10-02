import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

/** Collision group bits (membership). */
export const G = {
  WORLD: 1 << 0,
  PROP: 1 << 1,
  PLAYER: 1 << 2,
  SHELL: 1 << 3,
  HITBOX: 1 << 4,
  DEBRIS: 1 << 5,
  RAY: 1 << 6,
} as const;

export const groups = (member: number, filter: number): number => ((member & 0xffff) << 16) | (filter & 0xffff);

/** Pre-baked interaction groups for each kind of collider. */
export const GROUPS = {
  world: groups(G.WORLD, 0xffff),
  prop: groups(G.PROP, G.WORLD | G.PROP | G.PLAYER | G.SHELL | G.HITBOX | G.DEBRIS | G.RAY),
  player: groups(G.PLAYER, G.WORLD | G.PROP | G.HITBOX | G.RAY),
  shell: groups(G.SHELL, G.WORLD | G.PROP | G.DEBRIS),
  hitbox: groups(G.HITBOX, G.PROP | G.PLAYER | G.DEBRIS | G.RAY),
  debris: groups(G.DEBRIS, G.WORLD | G.PROP | G.SHELL | G.DEBRIS | G.HITBOX | G.RAY),
  /** Robot ragdoll parts: like debris, but ragdolls never collide with each other or themselves. */
  ragdoll: groups(G.DEBRIS, G.WORLD | G.PROP | G.SHELL | G.HITBOX | G.RAY),
  /** Query groups for bullets. */
  bullet: groups(G.RAY, G.WORLD | G.PROP | G.HITBOX | G.DEBRIS),
  /** Enemy bullets can also hit the player. */
  enemyBullet: groups(G.RAY, G.WORLD | G.PROP | G.HITBOX | G.DEBRIS | G.PLAYER),
  /** AI line of sight: blocked by level geometry and props only. */
  sight: groups(G.RAY, G.WORLD | G.PROP),
  /** Query groups for the character controller. */
  playerQuery: groups(G.PLAYER, G.WORLD | G.PROP | G.HITBOX),
} as const;

export type SurfaceType = 'concrete' | 'metal' | 'robot' | 'robotWeak' | 'flesh' | 'armor' | 'helmet' | 'player';

export interface BulletHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
  damage: number;
  impulse: number;
  critMultiplier: number;
  weaponId: string;
  /** Armor penetration rating of the round. */
  penetration: number;
  /** Fired by an enemy (not the player). */
  hostile: boolean;
}

export interface HitResult {
  /** Damage actually applied (after crit). 0 if the object is not damageable. */
  damage: number;
  crit: boolean;
  killed: boolean;
  /** Health remaining, or -1 when not damageable. */
  health: number;
  maxHealth: number;
}

/** Anything a bullet can hit. Registered per collider handle. */
export interface HitReceiver {
  surface: SurfaceType;
  body?: RAPIER.RigidBody;
  /** Object decals get attached to (so marks move with props). Null = static world. */
  decalParent?: THREE.Object3D | null;
  allowDecals?: boolean;
  /** Who this collider belongs to: a shooter's own bullets ignore it. */
  owner?: object;
  /** Multiplier on the bullet momentum pushed into `body` (ragdolls read better a bit livelier). */
  impulseScale?: number;
  onBulletHit?(hit: BulletHit, out: HitResult): void;
}

export interface RayHit {
  collider: RAPIER.Collider;
  receiver: HitReceiver | undefined;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

const STATIC_RECEIVER: HitReceiver = { surface: 'concrete', allowDecals: true };

export class Physics {
  readonly world: RAPIER.World;
  readonly receivers = new Map<number, HitReceiver>();
  private synced: { body: RAPIER.RigidBody; object: THREE.Object3D }[] = [];
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private rayHit: RayHit = {
    collider: null as unknown as RAPIER.Collider,
    receiver: undefined,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
  };

  private ignoreOwner: object | null = null;
  private ownerFilter = (c: RAPIER.Collider): boolean => this.receivers.get(c.handle)?.owner !== this.ignoreOwner;

  /** True when nothing in `queryGroups` blocks the straight line a → b. */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3, queryGroups: number = GROUPS.sight): boolean {
    const d = this.losDir.subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    this.ray.origin = { x: a.x, y: a.y, z: a.z };
    this.ray.dir = { x: d.x, y: d.y, z: d.z };
    return !this.world.castRay(this.ray, len, true, undefined, queryGroups);
  }
  private losDir = new THREE.Vector3();

  static async create(timestep: number): Promise<Physics> {
    await RAPIER.init();
    return new Physics(timestep);
  }

  private constructor(timestep: number) {
    this.world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    this.world.timestep = timestep;
  }

  register(collider: RAPIER.Collider, receiver: HitReceiver): void {
    this.receivers.set(collider.handle, receiver);
  }

  /** Keep a mesh in sync with a dynamic rigid body. */
  addSynced(body: RAPIER.RigidBody, object: THREE.Object3D): void {
    this.synced.push({ body, object });
  }

  step(): void {
    this.world.step();
  }

  syncObjects(): void {
    for (let i = 0; i < this.synced.length; i++) {
      const { body, object } = this.synced[i];
      if (!body.isEnabled() || body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      object.position.set(t.x, t.y, t.z);
      object.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Static box collider + optional receiver. */
  addStaticBox(center: THREE.Vector3, half: THREE.Vector3, rotation?: THREE.Quaternion, receiver?: HitReceiver): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(GROUPS.world)
      .setFriction(0.8);
    if (rotation) desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    const c = this.world.createCollider(desc);
    this.register(c, receiver ?? STATIC_RECEIVER);
    return c;
  }

  /**
   * Cast a bullet ray. Returns a shared result object (do not keep a reference).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, queryGroups: number = GROUPS.bullet, ignoreOwner?: object | null): RayHit | null {
    this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    this.ignoreOwner = ignoreOwner ?? null;
    const hit = this.world.castRayAndGetNormal(
      this.ray, maxDist, true, undefined, queryGroups, undefined, undefined, this.ignoreOwner ? this.ownerFilter : undefined,
    );
    if (!hit) return null;
    const out = this.rayHit;
    out.collider = hit.collider;
    out.receiver = this.receivers.get(hit.collider.handle);
    out.distance = hit.timeOfImpact;
    out.point.copy(origin).addScaledVector(dir, hit.timeOfImpact);
    out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return out;
  }
}
