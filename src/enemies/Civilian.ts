import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import { clamp } from '../core/math';
import { Humanoid, defaultPose, type DamageInfo } from '../targets/Humanoid';
import type { NavGrid } from '../ai/NavGrid';
import { labSkin } from './CivilianSkin';

export interface CivilianHooks {
  onKilled(c: Civilian, info: DamageInfo): void;
  onThud(at: THREE.Vector3, strength: number): void;
}

type State = 'hide' | 'flee' | 'dead';

const RUN = 4.3;

/**
 * Site-9 lab staff still hiding in the labs. They cower until something scary
 * happens near them (gunfire, a blast, a robot closing in, being shot at),
 * then bolt in a panic — arms pumping, looking back over the shoulder — to
 * somewhere away from it, and cower again. Robots go for them; so might you
 * (it costs).
 */
export class Civilian {
  readonly body: Humanoid;
  readonly pos = new THREE.Vector3();
  state: State = 'hide';
  yaw = 0;
  /** Seconds of panic left (re-armed by every new scare). */
  panic = 0;
  private vel = new THREE.Vector3();
  private path: THREE.Vector3[] | null = null;
  private pathIndex = 0;
  private stride = 0;
  private strideAmount = 0;
  private time = Math.random() * 10;
  private lookBack = 0;
  private pose = defaultPose();
  private tmp = new THREE.Vector3();
  /** Where the latest scare came from. */
  readonly threat = new THREE.Vector3();

  constructor(
    physics: Physics,
    scene: THREE.Object3D,
    private nav: NavGrid,
    readonly index: number,
    hooks: CivilianHooks,
  ) {
    this.body = new Humanoid(physics, scene, labSkin(index), {
      onDamage: (info) => this.scare(info.hit.point, 8),
      onDeath: (info) => {
        this.state = 'dead';
        hooks.onKilled(this, info);
      },
      onThud: (at, s) => hooks.onThud(at, s),
    }, this);
    this.body.team = 'civilians';
  }

  get alive(): boolean {
    return this.body.alive;
  }

  spawn(at: THREE.Vector3, yaw: number): void {
    this.pos.copy(at).setY(0);
    this.yaw = yaw;
    this.state = 'hide';
    this.panic = 0;
    this.path = null;
    this.vel.set(0, 0, 0);
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = yaw;
    this.body.setActive(true);
    this.body.reset(false);
  }

  /** Something frightening at `from`: run (or keep running) away from it. */
  scare(from: THREE.Vector3, seconds = 6): void {
    if (!this.alive) return;
    const fresh = this.panic <= 0.5;
    this.panic = Math.max(this.panic, seconds);
    this.threat.copy(from);
    if (this.state !== 'flee' || fresh || !this.path) this.pickRefuge();
    this.state = 'flee';
  }

  /** Melee (robot swing). */
  hit(damage: number, from: THREE.Vector3): void {
    this.body.meleeHit(damage, from, 2.2);
  }

  /** A walkable point 14-26 m away, roughly away from the threat. */
  private pickRefuge(): void {
    const away = Math.atan2(this.pos.x - this.threat.x, this.pos.z - this.threat.z);
    for (let i = 0; i < 10; i++) {
      const a = away + (Math.random() - 0.5) * (1.2 + i * 0.25);
      const r = 14 + Math.random() * 12;
      const p = this.nav.nearestWalkable(this.pos.x + Math.sin(a) * r, this.pos.z + Math.cos(a) * r, this.tmp, 3);
      if (!p) continue;
      const path = this.nav.findPath(this.pos, p, 2500);
      if (path && path.length) {
        this.path = path;
        this.pathIndex = 0;
        return;
      }
    }
    this.path = null;
  }

  update(dt: number): void {
    this.time += dt;
    const p = this.pose;
    if (!this.alive) {
      this.body.update(dt, p);
      return;
    }
    this.panic = Math.max(0, this.panic - dt);
    const desired = this.tmp.set(0, 0, 0);
    if (this.state === 'flee') {
      if (this.path && this.pathIndex < this.path.length) {
        const wp = this.path[this.pathIndex];
        const dx = wp.x - this.pos.x;
        const dz = wp.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) this.pathIndex++;
        else desired.set(dx / d, 0, dz / d).multiplyScalar(RUN);
      } else if (this.panic > 0.5) this.pickRefuge();
      else this.state = 'hide';
    }
    const accel = 12 * dt;
    this.vel.x += clamp(desired.x - this.vel.x, -accel, accel);
    this.vel.z += clamp(desired.z - this.vel.z, -accel, accel);
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (this.nav.walkable(nx, nz)) this.pos.set(nx, 0, nz);
    else if (this.nav.walkable(nx, this.pos.z)) this.pos.x = nx;
    else if (this.nav.walkable(this.pos.x, nz)) this.pos.z = nz;
    else this.vel.set(0, 0, 0);
    const v = Math.hypot(this.vel.x, this.vel.z);
    if (v > 0.3) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      this.yaw += clamp(Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)), -8 * dt, 8 * dt);
    }
    this.stride += (v * dt * Math.PI * 2) / 2.2;
    this.strideAmount += (clamp(v / 1.6, 0, 1.25) - this.strideAmount) * Math.min(1, dt * 8);

    p.idle = false;
    p.stridePhase = this.stride;
    p.strideAmount = this.strideAmount;
    p.strideSide = 0;
    p.spineY = 0;
    p.headY = 0;
    if (v > 1) {
      // Panicked run: leaning in, arms pumping, glancing back over the shoulder now and then.
      this.lookBack -= dt;
      if (this.lookBack < -2 - Math.random() * 2) this.lookBack = 0.5;
      p.crouch = 0.05;
      p.spineX = 0.28;
      p.headX = this.lookBack > 0 ? -0.1 : 0.05;
      p.headY = this.lookBack > 0 ? 1.2 : 0;
      p.armL = -0.6 + Math.sin(this.stride) * 0.9;
      p.armR = -0.6 - Math.sin(this.stride) * 0.9;
      p.elbows = 1.4;
    } else {
      // Cowering: crouched low, hands over the head, rocking, peeking up when it's loud.
      const k = this.panic > 0 ? 1 : 0.75;
      p.crouch = 0.75 * k;
      p.spineX = 0.62 + Math.sin(this.time * 2.1 + this.index) * 0.05;
      p.headX = 0.45;
      p.headY = Math.sin(this.time * 0.7 + this.index) * 0.35 * (this.panic > 0 ? 1 : 0.4);
      p.armL = -1.45;
      p.armR = -1.45;
      p.elbows = 2.45;
    }
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.update(dt, p);
  }
}
