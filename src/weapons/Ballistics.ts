import * as THREE from 'three';
import type { BulletHit, HitReceiver, HitResult, Physics, SurfaceType } from '../core/Physics';
import { feel } from '../config/Feel';
import { dragFactor, type AmmoData } from './AmmoData';
import type { ParticleSystem, ParticleSpawn } from '../fx/Particles';
import { spawnParams } from '../fx/Particles';
import type { DebugDraw } from '../fx/DebugDraw';

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
  };
  private result: HitResult = { damage: 0, crit: false, killed: false, health: -1, maxHealth: 0 };
  private report: ProjectileHitReport = {
    shotId: 0, kind: 'world', damage: 0, distance: 0, speed: 0, targetHealth: -1, targetMaxHealth: 0, point: new THREE.Vector3(),
  };

  /** Called whenever a projectile hits anything. */
  onHit: ((r: ProjectileHitReport) => void) | null = null;
  /** Speed of the most recent projectile impact (debug HUD). */
  lastImpactSpeed = 0;

  constructor(
    private physics: Physics,
    private fx: ImpactSink,
    private tracers: ParticleSystem,
    private debug: DebugDraw,
  ) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), v0: 0, ammo: null as unknown as AmmoData,
        shotId: 0, pellets: 1, tracer: false, age: 0, travelled: 0, ricochets: 0, soundBudget: true,
      });
    }
  }

  get active(): number {
    let n = 0;
    for (const p of this.pool) if (p.alive) n++;
    return n;
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, ammo: AmmoData, shotId: number, tracer: boolean, soundBudget: boolean): void {
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
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.alive) continue;
      let remaining = dt;
      const k = dragFactor(p.ammo);
      this.frameStart.copy(p.pos);
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
        const hit = this.physics.raycast(p.pos, this.dir, len);
        if (hit) {
          this.traceDebug(p, hit.point);
          p.travelled += hit.distance;
          this.processHit(p, hit.point, hit.normal, hit.receiver);
        } else {
          p.pos.add(this.seg);
          p.travelled += len;
        }
      }
      if (p.alive) this.traceDebug(p, p.pos);
      p.age += dt;
      if (p.alive && (p.age > MAX_LIFE || p.vel.length() < MIN_SPEED || p.pos.y < -20)) p.alive = false;
      if (p.alive && p.tracer) this.drawTracer(p, dt);
    }
  }

  /** Debug trajectory: one segment per frame, coloured by remaining velocity. */
  private traceDebug(p: Projectile, end: THREE.Vector3): void {
    if (!this.debug.enabled) return;
    const s = p.vel.length() / p.v0;
    this.debug.persistent(this.frameStart, end, s > 0.85 ? 0xff8a2a : s > 0.6 ? 0xffd04a : 0x9adf5a, 3);
    this.frameStart.copy(end);
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
    t.size = t.sizeEnd = 0.022;
    t.stretch = 0.0065;
    t.r = 1;
    t.g = 0.62;
    t.b = 0.3;
    t.alpha = 0.95;
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
      this.impulse.copy(this.dir).multiplyScalar(momentum * feel.impactForceScale);
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
    const res = this.result;
    res.damage = 0;
    res.crit = false;
    res.killed = false;
    res.health = -1;
    recv?.onBulletHit?.(h, res);

    const isStatic = !body && (recv?.allowDecals ?? true);
    this.fx.impact(surface, point, normal, this.dir, p.pellets > 1 ? 0.55 : 1, isStatic, p.soundBudget);

    const r = this.report;
    r.shotId = p.shotId;
    r.kind = res.killed ? 'kill' : res.damage > 0 ? (res.crit ? 'crit' : 'hit') : 'world';
    r.damage = res.damage;
    r.distance = p.travelled;
    r.speed = speed;
    r.targetHealth = res.health;
    r.targetMaxHealth = res.maxHealth;
    r.point.copy(point);
    this.onHit?.(r);
  }
}
