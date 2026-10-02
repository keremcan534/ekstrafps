import * as THREE from 'three';
import { GROUPS, type BulletHit, type HitReceiver, type HitResult, type Physics, type SurfaceType } from '../core/Physics';
import { feel } from '../config/Feel';
import { dragFactor, type AmmoData } from './AmmoData';
import type { ParticleSystem, ParticleSpawn } from '../fx/Particles';
import { spawnParams } from '../fx/Particles';
import type { DebugDraw } from '../fx/DebugDraw';
import type { Trails } from '../fx/Trails';

const GRAVITY = 9.81;
const MAX_STEP = 1 / 240;
const MAX_LIFE = 4;
const MIN_SPEED = 40;
const CAPACITY = 512;

export interface ImpactSink {
  impact(surface: SurfaceType, point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, intensity: number, decal: boolean, playSound: boolean): void;
  ricochet(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3): void;
}

/** Reported for every projectile that hits something damageable or not. */
export interface ProjectileHitReport {
  shotId: number;
  kind: 'hit' | 'crit' | 'kill' | 'world';
  damage: number;
  distance: number;
  speed: number;
  targetHealth: number;
  targetMaxHealth: number;
  point: THREE.Vector3;
  /** Enemy round: not the player's hit (no hit markers). */
  hostile: boolean;
}

interface Projectile {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  v0: number;
  ammo: AmmoData;
  shotId: number;
  pellets: number;
  tracer: boolean;
  age: number;
  travelled: number;
  ricochets: number;
  soundBudget: boolean;
  /** Shooter: its own hitboxes are ignored. */
  owner: object | null;
  hostile: boolean;
  ally: boolean;
  /** Already cracked past the listener. */
  flyby: boolean;
}

/**
 * Real projectile flight for every bullet and pellet:
 * muzzle velocity, gravity, quadratic drag (velocity loss), time of flight,
 * ricochets at grazing angles, and damage/impulse that scale with remaining speed.
 * Integrated in small sub-steps with a raycast per segment, so fast rounds never
 * tunnel. Pooled; no allocation per shot.
 */
export class ProjectileSystem {
  private pool: Projectile[] = [];
  private next = 0;
  private dir = new THREE.Vector3();
  private seg = new THREE.Vector3();
  private impulse = new THREE.Vector3();
  private frameStart = new THREE.Vector3();
  private trailStart = new THREE.Vector3();
  private streakTail = new THREE.Vector3();
  private tracerSpawn: ParticleSpawn = spawnParams();
  private hit: BulletHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    distance: 0,
    damage: 0,
    impulse: 0,
    critMultiplier: 2,
    weaponId: '',
    penetration: 0,
    hostile: false,
    ally: false,
  };
  private result: HitResult = { damage: 0, crit: false, killed: false, health: -1, maxHealth: 0 };
  private report: ProjectileHitReport = {
    shotId: 0, kind: 'world', damage: 0, distance: 0, speed: 0, targetHealth: -1, targetMaxHealth: 0, point: new THREE.Vector3(), hostile: false,
  };
  private closest = new THREE.Vector3();

  /** Listener head (camera): enemy rounds passing close call `onFlyby`. */
  listener: THREE.Vector3 | null = null;
  onFlyby: ((point: THREE.Vector3, distance: number, speed: number) => void) | null = null;

  /** Called whenever a projectile hits anything. */
  onHit: ((r: ProjectileHitReport) => void) | null = null;
  /** Speed of the most recent projectile impact (debug HUD). */
  lastImpactSpeed = 0;

  constructor(
    private physics: Physics,
    private fx: ImpactSink,
    private tracers: ParticleSystem,
    private debug: DebugDraw,
    private trails: Trails,
  ) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), v0: 0, ammo: null as unknown as AmmoData,
        shotId: 0, pellets: 1, tracer: false, age: 0, travelled: 0, ricochets: 0, soundBudget: true,
        owner: null, hostile: false, ally: false, flyby: false,
      });
    }
  }

  get active(): number {
    let n = 0;
    for (const p of this.pool) if (p.alive) n++;
    return n;
  }

  fire(
    origin: THREE.Vector3, dir: THREE.Vector3, speed: number, ammo: AmmoData, shotId: number, tracer: boolean, soundBudget: boolean,
    owner: object | null = null, hostile = false, ally = false,
  ): void {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % CAPACITY;
    p.alive = true;
    p.pos.copy(origin);
    p.vel.copy(dir).multiplyScalar(speed);
    p.v0 = speed;
    p.ammo = ammo;
    p.shotId = shotId;
    p.pellets = Math.max(1, ammo.pellets);
    p.tracer = tracer && feel.tracers;
    p.age = 0;
    p.travelled = 0;
    p.ricochets = 0;
    p.soundBudget = soundBudget;
    p.owner = owner;
    p.hostile = hostile;
    p.ally = ally;
    p.flyby = false;
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.alive) continue;
      let remaining = dt;
      const k = dragFactor(p.ammo);
      this.frameStart.copy(p.pos);
      this.trailStart.copy(p.pos);
      while (remaining > 1e-6 && p.alive) {
        const h = Math.min(remaining, MAX_STEP);
        remaining -= h;
        // Semi-implicit drag + gravity.
        const speed = p.vel.length();
        p.vel.multiplyScalar(1 / (1 + k * speed * h));
        p.vel.y -= GRAVITY * h;
        this.seg.copy(p.vel).multiplyScalar(h);
        const len = this.seg.length();
        if (len < 1e-6) continue;
        this.dir.copy(this.seg).divideScalar(len);
        if (p.hostile && !p.flyby) this.checkFlyby(p, len);
        const hit = this.physics.raycast(p.pos, this.dir, len, p.hostile ? GROUPS.enemyBullet : GROUPS.bullet, p.owner);
        if (hit) {
          this.traceDebug(p, hit.point);
          this.trail(p, hit.point);
          p.travelled += hit.distance;
          this.processHit(p, hit.point, hit.normal, hit.receiver);
        } else {
          p.pos.add(this.seg);
          p.travelled += len;
        }
      }
      if (p.alive) {
        this.traceDebug(p, p.pos);
        this.trail(p, p.pos);
      }
      p.age += dt;
      if (p.alive && (p.age > MAX_LIFE || p.vel.length() < MIN_SPEED || p.pos.y < -20)) p.alive = false;
      if (p.alive && (p.tracer || feel.bulletTrails)) this.drawTracer(p, dt);
    }
  }

  /** Enemy round passing the listener's head: supersonic crack / subsonic whizz. */
  private checkFlyby(p: Projectile, len: number): void {
    const l = this.listener;
    if (!l || !this.onFlyby) return;
    const t = Math.max(0, Math.min(len, this.closest.subVectors(l, p.pos).dot(this.dir)));
    this.closest.copy(p.pos).addScaledVector(this.dir, t);
    const d = this.closest.distanceTo(l);
    if (d < 2.6 && t < len) {
      p.flyby = true;
      this.onFlyby(this.closest, d, p.vel.length());
    }
  }

  /** Debug trajectory: one segment per frame, coloured by remaining velocity. */
  private traceDebug(p: Projectile, end: THREE.Vector3): void {
    if (!this.debug.enabled) return;
    const s = p.vel.length() / p.v0;
    this.debug.persistent(this.frameStart, end, s > 0.85 ? 0xff8a2a : s > 0.6 ? 0xffd04a : 0x9adf5a, 3);
    this.frameStart.copy(end);
  }

  /**
   * Short bright streak behind the round: only the last few metres of this frame's
   * flight, hot at the head and fading to nothing at the tail, gone in a few frames.
   * (Full trajectories are still available with the debug rays, G.)
   */
  private trail(p: Projectile, end: THREE.Vector3): void {
    if (!feel.bulletTrails && !p.tracer) return;
    const len = p.tracer ? 4.5 : 2.4;
    const d = this.trailStart.distanceTo(end);
    const tail = d > len ? this.streakTail.subVectors(this.trailStart, end).multiplyScalar(len / d).add(end) : this.trailStart;
    if (p.tracer) this.trails.add(tail, end, 1, p.hostile ? 0.22 : 0.62, p.hostile ? 0.14 : 0.25, 0.075, true);
    else if (p.hostile) this.trails.add(tail, end, 0.95, 0.42, 0.32, 0.045, true);
    else this.trails.add(tail, end, 1, 0.9, 0.72, 0.045, true);
    this.trailStart.copy(end);
  }

  private drawTracer(p: Projectile, dt: number): void {
    const t = this.tracerSpawn;
    t.x = p.pos.x;
    t.y = p.pos.y;
    t.z = p.pos.z;
    t.vx = p.vel.x;
    t.vy = p.vel.y;
    t.vz = p.vel.z;
    t.life = Math.max(dt, 1 / 60) * 1.05;
    // Real tracers burn bright orange; ordinary rounds show as a faint brass-white streak.
    t.size = t.sizeEnd = p.tracer ? 0.022 : 0.012;
    t.stretch = p.tracer ? 0.0065 : 0.0045;
    t.r = 1;
    // Black Division rounds burn red.
    t.g = p.hostile ? (p.tracer ? 0.2 : 0.55) : p.tracer ? 0.62 : 0.9;
    t.b = p.hostile ? (p.tracer ? 0.15 : 0.45) : p.tracer ? 0.3 : 0.7;
    t.alpha = p.tracer ? 0.95 : 0.55;
    t.gravity = 0;
    t.drag = 0;
    this.tracers.spawn(t);
  }

  private processHit(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, recv: HitReceiver | undefined): void {
    const surface: SurfaceType = recv?.surface ?? 'concrete';
    const speed = p.vel.length();
    const speedRatio = speed / p.v0;
    this.lastImpactSpeed = speed;
    this.dir.copy(p.vel).divideScalar(speed);

    // Ricochet: hard surfaces, grazing angle, chance from the ammo.
    const cosIn = -this.dir.dot(normal);
    const hard = surface === 'metal' || surface === 'concrete' || surface === 'robot';
    if (hard && !recv?.onBulletHit && p.ricochets === 0 && cosIn < 0.26 && Math.random() < p.ammo.ricochetChance) {
      this.fx.ricochet(point, normal, this.dir);
      p.ricochets++;
      p.vel.addScaledVector(normal, 2 * cosIn * speed).multiplyScalar(0.55);
      p.vel.x += (Math.random() - 0.5) * speed * 0.08;
      p.vel.y += (Math.random() - 0.5) * speed * 0.08;
      p.pos.copy(point).addScaledVector(normal, 0.01);
      return;
    }
    p.alive = false;

    // Physical momentum into dynamic bodies (props, robot debris).
    const body = recv?.body;
    const momentum = (p.ammo.projectileMass / 1000) * speed * p.ammo.impactBoost;
    if (body && body.isDynamic()) {
      this.impulse.copy(this.dir).multiplyScalar(momentum * feel.impactForceScale * (recv?.impulseScale ?? 1));
      body.applyImpulseAtPoint(this.impulse, point, true);
    }

    // Damage scales with remaining velocity (energy-loss hook for penetration later).
    const h = this.hit;
    h.point.copy(point);
    h.normal.copy(normal);
    h.direction.copy(this.dir);
    h.distance = p.travelled;
    h.damage = p.ammo.damage * Math.max(0.25, Math.min(1.05, speedRatio));
    h.impulse = momentum * 0.18;
    h.penetration = p.ammo.penetration;
    h.hostile = p.hostile;
    h.ally = p.ally;
    const res = this.result;
    res.damage = 0;
    res.crit = false;
    res.killed = false;
    res.health = -1;
    recv?.onBulletHit?.(h, res);

    const isStatic = !body && (recv?.allowDecals ?? true);
    // Effect size follows the round's remaining kinetic energy (≈1500 J = a 5.56 at range).
    const energy = 0.5 * (p.ammo.projectileMass / 1000) * speed * speed;
    const intensity = Math.min(2.6, Math.max(0.4, energy / 1500));
    this.fx.impact(surface, point, normal, this.dir, intensity, isStatic, p.soundBudget);

    const r = this.report;
    r.shotId = p.shotId;
    r.kind = res.killed ? 'kill' : res.damage > 0 ? (res.crit ? 'crit' : 'hit') : 'world';
    r.damage = res.damage;
    r.distance = p.travelled;
    r.speed = speed;
    r.targetHealth = res.health;
    r.targetMaxHealth = res.maxHealth;
    r.point.copy(point);
    r.hostile = p.hostile || p.ally;
    this.onHit?.(r);
  }
}
