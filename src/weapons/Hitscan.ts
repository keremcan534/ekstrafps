import * as THREE from 'three';
import { DEG } from '../core/math';
import type { BulletHit, HitResult, Physics, RayHit, SurfaceType } from '../core/Physics';
import { feel } from '../config/Feel';
import type { WeaponData } from './WeaponData';

/** Aggregated result of one trigger pull (all pellets). */
export interface ShotResult {
  kind: 'miss' | 'hit' | 'crit' | 'kill';
  damage: number;
  /** Distance of the first pellet hit (debug HUD). */
  distance: number;
  /** Health of the last damaged target, -1 if none. */
  targetHealth: number;
  targetMaxHealth: number;
  /** World position of the most significant hit (for damage numbers). */
  point: THREE.Vector3;
}

export interface ImpactSink {
  impact(surface: SurfaceType, point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, intensity: number, decal: boolean, playSound: boolean): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3): void;
}

/**
 * Instant-hit bullets. Applies spread (center-weighted, so it's readable),
 * fixed + jittered shotgun pellet pattern, damage falloff, crits, and physics
 * impulse. Everything returned in a reused result object.
 */
export class Hitscan {
  private dir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private end = new THREE.Vector3();
  private hit: BulletHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    distance: 0,
    damage: 0,
    impulse: 0,
    critMultiplier: 1,
    weaponId: '',
  };
  private hitResult: HitResult = { damage: 0, crit: false, killed: false, health: -1, maxHealth: 0 };
  private result: ShotResult = { kind: 'miss', damage: 0, distance: -1, targetHealth: -1, targetMaxHealth: 0, point: new THREE.Vector3() };
  private impulse = new THREE.Vector3();

  constructor(private physics: Physics, private fx: ImpactSink) {}

  fire(
    data: WeaponData,
    origin: THREE.Vector3,
    aim: THREE.Vector3,
    spreadDeg: number,
    tracerFrom: THREE.Vector3 | null,
    shotNumber: number,
  ): ShotResult {
    const r = this.result;
    r.kind = 'miss';
    r.damage = 0;
    r.distance = -1;
    r.targetHealth = -1;
    let rank = 0; // miss < hit < crit < kill

    // Basis around the aim direction.
    this.right.set(0, 1, 0).cross(aim);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(aim, this.right).normalize();

    const pellets = Math.max(1, data.pellets);
    const spread = Math.tan(spreadDeg * DEG);
    const patternRot = Math.random() * Math.PI * 2;
    let impactsWithSound = 0;

    for (let i = 0; i < pellets; i++) {
      let ox: number;
      let oy: number;
      if (pellets > 1) {
        // Shotgun: one pellet near the centre, the rest on two rings, slightly jittered.
        const ring = i === 0 ? 0 : i % 2 === 0 ? 1 : 0.55;
        const a = patternRot + (i / (pellets - 1)) * Math.PI * 2;
        const jitter = 0.18;
        ox = (Math.cos(a) * ring + (Math.random() - 0.5) * jitter) * spread;
        oy = (Math.sin(a) * ring + (Math.random() - 0.5) * jitter) * spread;
      } else {
        // Centre-weighted cone: most shots land near the crosshair.
        const a = Math.random() * Math.PI * 2;
        const rad = Math.random() * spread;
        ox = Math.cos(a) * rad;
        oy = Math.sin(a) * rad;
      }
      this.dir.copy(aim).addScaledVector(this.right, ox).addScaledVector(this.up, oy).normalize();

      const hit = this.physics.raycast(origin, this.dir, data.range);
      const tracerShot = tracerFrom && data.fx.tracerEvery > 0 && (shotNumber * pellets + i) % data.fx.tracerEvery === 0;
      if (!hit) {
        if (tracerShot) this.fx.tracer(tracerFrom!, this.end.copy(origin).addScaledVector(this.dir, Math.min(data.range, 120)));
        continue;
      }
      if (tracerShot) this.fx.tracer(tracerFrom!, hit.point);
      if (r.distance < 0) r.distance = hit.distance;

      const pelletRank = this.applyHit(data, hit, pellets, impactsWithSound < 3);
      impactsWithSound++;
      if (this.hitResult.damage > 0) {
        r.damage += this.hitResult.damage;
        r.targetHealth = this.hitResult.health;
        r.targetMaxHealth = this.hitResult.maxHealth;
      }
      if (pelletRank > rank) {
        rank = pelletRank;
        r.point.copy(hit.point);
      } else if (pelletRank > 0 && rank === pelletRank) {
        r.point.copy(hit.point);
      }
    }
    r.kind = rank === 3 ? 'kill' : rank === 2 ? 'crit' : rank === 1 ? 'hit' : 'miss';
    return r;
  }

  /** Returns 0 = no damage, 1 = hit, 2 = crit, 3 = kill. */
  private applyHit(data: WeaponData, hit: RayHit, pellets: number, playSound: boolean): number {
    const recv = hit.receiver;
    const surface: SurfaceType = recv?.surface ?? 'concrete';
    const falloffT = Math.min(1, Math.max(0, (hit.distance - data.falloffStart) / Math.max(0.01, data.falloffEnd - data.falloffStart)));
    const falloff = 1 + (data.falloffMinMultiplier - 1) * falloffT;

    // Physics impulse on dynamic bodies (props, robot debris). Closer = stronger for pellets too.
    const body = recv?.body;
    if (body && body.isDynamic()) {
      const k = data.impactForce * feel.impactForceScale * (0.5 + 0.5 * falloff);
      this.impulse.copy(this.dir).multiplyScalar(k);
      body.applyImpulseAtPoint(this.impulse, hit.point, true);
    }

    // Damage
    const h = this.hit;
    h.point.copy(hit.point);
    h.normal.copy(hit.normal);
    h.direction.copy(this.dir);
    h.distance = hit.distance;
    h.damage = data.damage * falloff;
    h.impulse = data.hitReaction * (0.5 + 0.5 * falloff);
    h.critMultiplier = data.critMultiplier;
    h.weaponId = data.id;
    const res = this.hitResult;
    res.damage = 0;
    res.crit = false;
    res.killed = false;
    res.health = -1;
    recv?.onBulletHit?.(h, res);

    const isStatic = !body && (recv?.allowDecals ?? true);
    this.fx.impact(surface, hit.point, hit.normal, this.dir, pellets > 1 ? 0.55 : 1, isStatic, playSound);
    if (res.killed) return 3;
    if (res.damage > 0) return res.crit ? 2 : 1;
    return 0;
  }
}
