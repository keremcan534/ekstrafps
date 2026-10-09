import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

/** Collision group bits (membership). */
export const G = {
  WORLD: 1 << 0,
  PROP: 1 << 1,
  PLAYER: 1 << 2,
  SHELL: 1 << 3,
  /** Living bodies' hitboxes: no colliders, a query with this bit tests the hit sets (see HitSet). */
  HITBOX: 1 << 4,
  DEBRIS: 1 << 5,
  RAY: 1 << 6,
  /** A living body's one capsule: keeps you (and props, corpses) out of it; bullets pass it. */
  BLOCKER: 1 << 7,
} as const;

export const groups = (member: number, filter: number): number => ((member & 0xffff) << 16) | (filter & 0xffff);

/** Pre-baked interaction groups for each kind of collider. */
export const GROUPS = {
  world: groups(G.WORLD, 0xffff),
  prop: groups(G.PROP, G.WORLD | G.PROP | G.PLAYER | G.SHELL | G.BLOCKER | G.DEBRIS | G.RAY),
  player: groups(G.PLAYER, G.WORLD | G.PROP | G.BLOCKER | G.RAY),
  shell: groups(G.SHELL, G.WORLD | G.PROP | G.DEBRIS),
  blocker: groups(G.BLOCKER, G.PROP | G.PLAYER | G.DEBRIS),
  debris: groups(G.DEBRIS, G.WORLD | G.PROP | G.SHELL | G.DEBRIS | G.BLOCKER | G.RAY),
  /** Robot ragdoll parts: like debris, but ragdolls never collide with each other or themselves. */
  ragdoll: groups(G.DEBRIS, G.WORLD | G.PROP | G.SHELL | G.BLOCKER | G.RAY),
  /** Phones: ragdolls ignore the living too, so walkers don't keep waking settled corpses. */
  ragdollLite: groups(G.DEBRIS, G.WORLD | G.PROP | G.SHELL | G.RAY),
  /** Query groups for bullets. */
  bullet: groups(G.RAY, G.WORLD | G.PROP | G.HITBOX | G.DEBRIS),
  /** Enemy bullets can also hit the player. */
  enemyBullet: groups(G.RAY, G.WORLD | G.PROP | G.HITBOX | G.DEBRIS | G.PLAYER),
  /** AI line of sight: blocked by level geometry and props only. */
  sight: groups(G.RAY, G.WORLD | G.PROP),
  /** Query groups for the character controller. */
  playerQuery: groups(G.PLAYER, G.WORLD | G.PROP | G.BLOCKER),
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
  /** Fired by an AI teammate of the player. */
  ally: boolean;
  /** Shooter's team id ('alpha' = the player's team). Same-team hits are ignored. */
  team: string;
  /** Who fired it (player controller / soldier) — whose wallet gets the points. */
  owner?: object | null;
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
  /** Null for a living body's hitbox (a hit set, no collider). */
  collider: RAPIER.Collider | null;
  receiver: HitReceiver | undefined;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/** Where a ray met a hit set (written only for a nearer hit than the distance passed in). */
export interface SetHit {
  distance: number;
  normal: THREE.Vector3;
  receiver: HitReceiver | undefined;
}

/**
 * A living body's hitboxes, tested in JS instead of as physics bodies: dozens of bodies with
 * a dozen kinematic boxes each, moved every step, were most of the physics world. Queries with
 * the HITBOX bit (bullets, aim probes) test every registered set after the physics world.
 */
export interface HitSet {
  /** Whose body it is: a shooter's own rounds pass through it. */
  readonly owner: object | undefined;
  /** Nearest hit along the ray closer than `maxDist`: writes `out` and returns true. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: SetHit): boolean;
  /** Could a ball of `radius` swept along the ray for `maxDist` touch the body? (A cheap, generous test.) */
  near(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number): boolean;
}

const STATIC_RECEIVER: HitReceiver = { surface: 'concrete', allowDecals: true };

export class Physics {
  readonly world: RAPIER.World;
  readonly receivers = new Map<number, HitReceiver>();
  private synced: { body: RAPIER.RigidBody; object: THREE.Object3D }[] = [];
  private hitSets: HitSet[] = [];
  private setHit: SetHit = { distance: 0, normal: new THREE.Vector3(), receiver: undefined };
  /** One ray reused by every query (origin/dir are written in place). */
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private syncPos = { x: 0, y: 0, z: 0 };
  private syncRot = { x: 0, y: 0, z: 0, w: 1 };
  private rayHit: RayHit = {
    collider: null,
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
    this.setRay(a, d);
    return !this.world.castRay(this.ray, len, true, undefined, queryGroups);
  }
  private losDir = new THREE.Vector3();

  private setRay(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const o = this.ray.origin;
    const d = this.ray.dir;
    o.x = origin.x;
    o.y = origin.y;
    o.z = origin.z;
    d.x = dir.x;
    d.y = dir.y;
    d.z = dir.z;
  }

  static async create(timestep: number): Promise<Physics> {
    await RAPIER.init();
    return new Physics(timestep);
  }

  private constructor(timestep: number) {
    this.world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    this.world.timestep = timestep;
    // After every step Rapier re-maps each body and collider handle through JS callbacks (for
    // soft bodies, which this game has none of): thousands of calls a step, ~0.2 ms on a desktop
    // and several times that on a phone.
    // Bodies, colliders and joints made or removed through the API keep those maps current
    // themselves; the full pass still runs whenever the counts disagree.
    const w = this.world;
    const remap = w.mapNewSoftBodies.bind(w);
    w.mapNewSoftBodies = () => {
      if (w.bodies.len() !== w.bodies.raw.len() || w.colliders.len() !== w.colliders.raw.len()) remap();
    };
  }

  register(collider: RAPIER.Collider, receiver: HitReceiver): void {
    this.receivers.set(collider.handle, receiver);
  }

  /** Forget a collider about to be removed (Rapier reuses handles: a stale entry would take a new collider's hits). */
  unregister(collider: RAPIER.Collider): void {
    this.receivers.delete(collider.handle);
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
      // Scratch out-objects: no allocation per synced body per frame.
      const t = body.translation(this.syncPos);
      const r = body.rotation(this.syncRot);
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

  /** A living body's hitboxes join the bullet queries (see HitSet). Adding twice is harmless. */
  addHitSet(set: HitSet): void {
    if (!this.hitSets.includes(set)) this.hitSets.push(set);
  }

  removeHitSet(set: HitSet): void {
    const i = this.hitSets.indexOf(set);
    if (i < 0) return;
    this.hitSets[i] = this.hitSets[this.hitSets.length - 1];
    this.hitSets.pop();
  }

  /**
   * Cast a bullet ray. Returns a shared result object (do not keep a reference).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, queryGroups: number = GROUPS.bullet, ignoreOwner?: object | null): RayHit | null {
    this.setRay(origin, dir);
    this.ignoreOwner = ignoreOwner ?? null;
    const hit = this.world.castRayAndGetNormal(
      this.ray, maxDist, true, undefined, queryGroups, undefined, undefined, this.ignoreOwner ? this.ownerFilter : undefined,
    );
    // Living bodies, nearer than whatever the physics world gave.
    let onSet = false;
    if (queryGroups & G.HITBOX) {
      let best = hit ? hit.timeOfImpact : maxDist;
      const sets = this.hitSets;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i];
        if (ignoreOwner && s.owner === ignoreOwner) continue;
        if (s.raycast(origin, dir, best, this.setHit)) {
          best = this.setHit.distance;
          onSet = true;
        }
      }
    }
    const out = this.rayHit;
    if (onSet) {
      const s = this.setHit;
      out.collider = null;
      out.receiver = s.receiver;
      out.distance = s.distance;
      out.point.copy(origin).addScaledVector(dir, s.distance);
      out.normal.copy(s.normal);
      return out;
    }
    if (!hit) return null;
    out.collider = hit.collider;
    out.receiver = this.receivers.get(hit.collider.handle);
    out.distance = hit.timeOfImpact;
    out.point.copy(origin).addScaledVector(dir, hit.timeOfImpact);
    out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return out;
  }

  /** Could a ball of `radius` swept along the ray touch a living body (hit assist's broad check)? */
  nearHitSet(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number, ignoreOwner?: object | null): boolean {
    const sets = this.hitSets;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      if (ignoreOwner && s.owner === ignoreOwner) continue;
      if (s.near(origin, dir, maxDist, radius)) return true;
    }
    return false;
  }
}
