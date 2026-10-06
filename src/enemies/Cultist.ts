import { withModel } from '../targets/CharacterModels';
import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import { clamp } from '../core/math';
import { Humanoid, defaultPose, type DamageInfo, strideLength } from '../targets/Humanoid';
import type { NavGrid } from '../ai/NavGrid';
import { choirSkin } from './CivilianSkin';

export interface CultistHooks {
  onKilled(c: Cultist, info: DamageInfo): void;
  onThud(at: THREE.Vector3, strength: number): void;
  /** Starts the rush: the jumpscare sting. */
  onLunge(c: Cultist): void;
  /** The blade lands (within reach). */
  onSlash(c: Cultist, damage: number): void;
  /** Caught in your light: a hiss. */
  onFlinch(c: Cultist): void;
  /** Breath / whisper while creeping (positional, quiet). */
  onWhisper(c: Cultist): void;
}

/** What the cult knows about you this frame (supplied by Inhabitants). */
export interface Prey {
  feet: THREE.Vector3;
  eye: THREE.Vector3;
  /** Your view direction (unit). */
  look: THREE.Vector3;
  alive: boolean;
}

type State = 'gone' | 'stalk' | 'lunge' | 'slash' | 'flinch' | 'retreat' | 'dead';

const CREEP = 2.1;
const SPRINT = 7.4;
const FLEE = 5.2;

/**
 * The Choir: they only come out when the lights die. They creep up in the dark,
 * crouched and silent but for breathing, and when you're close and not looking
 * they rush you with the blade raised (the sting), slash once and melt back into
 * the dark to try again. Your flashlight burns them: caught in the beam they
 * cover their masks and back off. When the power comes back they're gone.
 */
export class Cultist {
  readonly body: Humanoid;
  readonly pos = new THREE.Vector3();
  state: State = 'gone';
  yaw = 0;
  /** Lights are back: get out of sight and vanish. */
  banished = false;
  private vel = new THREE.Vector3();
  private path: THREE.Vector3[] | null = null;
  private pathIndex = 0;
  private repath = 0;
  private stride = 0;
  private strideAmount = 0;
  private stateTime = 0;
  private cooldown = 0;
  private whisper = 2 + Math.random() * 4;
  private litTime = 0;
  private hitDone = false;
  private time = Math.random() * 10;
  private pose = defaultPose();
  private tmp = new THREE.Vector3();
  private fleeTo: THREE.Vector3 | null = null;

  constructor(
    physics: Physics,
    scene: THREE.Object3D,
    private nav: NavGrid,
    readonly index: number,
    private hooks: CultistHooks,
  ) {
    this.body = new Humanoid(physics, scene, withModel('choir', choirSkin(index)), {
      onDamage: () => {
        // Shot: no flinch-and-run (that's the light); they just keep coming, faster.
        this.cooldown = Math.min(this.cooldown, 0.5);
      },
      onDeath: (info) => {
        this.state = 'dead';
        hooks.onKilled(this, info);
      },
      onThud: (at, s) => hooks.onThud(at, s),
    }, this);
    this.body.team = 'cult';
    this.body.setActive(false);
  }

  get alive(): boolean {
    return this.state !== 'gone' && this.state !== 'dead' && this.body.alive;
  }

  /** Steps out of the dark at `at`. */
  spawn(at: THREE.Vector3, yaw: number): void {
    this.pos.copy(at).setY(0);
    this.yaw = yaw;
    this.state = 'stalk';
    this.stateTime = 0;
    this.banished = false;
    this.cooldown = 1.5;
    this.path = null;
    this.vel.set(0, 0, 0);
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = yaw;
    this.body.setActive(true);
    this.body.reset(false);
  }

  /** Out of the world (pooled). */
  vanish(): void {
    this.state = 'gone';
    this.body.setActive(false);
  }

  hit(damage: number, from: THREE.Vector3): void {
    this.body.meleeHit(damage, from, 1.8);
  }

  private set(s: State): void {
    this.state = s;
    this.stateTime = 0;
  }

  /** A point ~12 m from `from`, away from it (a dark corner to wait in). */
  private pickFlee(from: THREE.Vector3): void {
    const away = Math.atan2(this.pos.x - from.x, this.pos.z - from.z);
    for (let i = 0; i < 8; i++) {
      const a = away + (Math.random() - 0.5) * 1.6;
      const r = 10 + Math.random() * 6;
      const p = this.nav.nearestWalkable(this.pos.x + Math.sin(a) * r, this.pos.z + Math.cos(a) * r, this.tmp, 3);
      if (p) {
        this.fleeTo = p.clone();
        this.path = this.nav.findPath(this.pos, this.fleeTo, 2000);
        this.pathIndex = 0;
        return;
      }
    }
    this.fleeTo = null;
    this.path = null;
  }

  /**
   * @param lit caught in your flashlight beam this frame
   * @param seen you're looking roughly at it
   */
  update(dt: number, prey: Prey, lit: boolean, seen: boolean): void {
    if (this.state === 'gone') return;
    this.time += dt;
    this.stateTime += dt;
    const p = this.pose;
    if (!this.body.alive || this.state === 'dead') {
      this.body.update(dt, p);
      return;
    }
    this.cooldown -= dt;
    const dx = prey.feet.x - this.pos.x;
    const dz = prey.feet.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.litTime = lit ? this.litTime + dt : 0;

    // --- Decide.
    if (this.banished && this.state !== 'retreat') {
      this.set('retreat');
      this.pickFlee(prey.feet);
    } else if (this.litTime > 0.2 && dist < 18 && (this.state === 'stalk' || this.state === 'lunge')) {
      this.set('flinch');
      this.hooks.onFlinch(this);
    }
    const desired = this.tmp.set(0, 0, 0);
    let face: number | null = null;
    switch (this.state) {
      case 'stalk': {
        if (!prey.alive) break;
        // Creep: a path toward you, re-planned often; quiet breathing now and then.
        this.repath -= dt;
        const direct = dist < 14 && this.nav.clearLine(this.pos.x, this.pos.z, prey.feet.x, prey.feet.z);
        if (direct) this.path = null;
        else if (this.repath <= 0) {
          const path = this.nav.findPathFor(this, this.pos, prey.feet, 3000);
          if (path || !this.nav.lastTruncated) {
            this.path = path;
            this.pathIndex = 0;
            this.repath = 0.9;
          } else this.repath = 0.05; // asked the path worker: keep creeping, collect the answer next frame
        }
        const speed = dist < 9 ? CREEP * 0.75 : CREEP;
        if (direct && dist > 1.2) desired.set(dx / dist, 0, dz / dist).multiplyScalar(speed);
        else if (this.path && this.pathIndex < this.path.length) {
          const wp = this.path[this.pathIndex];
          const wx = wp.x - this.pos.x;
          const wz = wp.z - this.pos.z;
          const d = Math.hypot(wx, wz);
          if (d < 0.5) this.pathIndex++;
          else desired.set(wx / d, 0, wz / d).multiplyScalar(speed);
        }
        this.whisper -= dt;
        if (this.whisper <= 0 && dist < 22) {
          this.whisper = 4 + Math.random() * 5;
          this.hooks.onWhisper(this);
        }
        // Close, your back turned (or right on top of you): rush.
        if (this.cooldown <= 0 && direct && (dist < 3.5 || (dist < 7.5 && !seen))) {
          this.set('lunge');
          this.hitDone = false;
          this.hooks.onLunge(this);
        }
        if (dist < 9) face = Math.atan2(dx, dz);
        break;
      }
      case 'lunge':
        desired.set(dx / Math.max(dist, 0.01), 0, dz / Math.max(dist, 0.01)).multiplyScalar(SPRINT);
        face = Math.atan2(dx, dz);
        if (dist < 1.6) this.set('slash');
        else if (this.stateTime > 2.4) {
          this.set('stalk');
          this.cooldown = 2;
        }
        break;
      case 'slash':
        face = Math.atan2(dx, dz);
        if (!this.hitDone && this.stateTime > 0.14) {
          this.hitDone = true;
          if (dist < 2.1 && prey.alive) this.hooks.onSlash(this, 34);
        }
        if (this.stateTime > 0.42) {
          this.set('retreat');
          this.pickFlee(prey.feet);
          this.cooldown = 5 + Math.random() * 4;
        }
        break;
      case 'flinch':
        // Arm over the mask, a step back.
        desired.set(-dx / Math.max(dist, 0.01), 0, -dz / Math.max(dist, 0.01)).multiplyScalar(1.4);
        face = Math.atan2(dx, dz);
        if (this.stateTime > 0.7) {
          this.set('retreat');
          this.pickFlee(prey.feet);
          this.cooldown = 3 + Math.random() * 3;
        }
        break;
      case 'retreat':
        if (this.path && this.pathIndex < this.path.length) {
          const wp = this.path[this.pathIndex];
          const wx = wp.x - this.pos.x;
          const wz = wp.z - this.pos.z;
          const d = Math.hypot(wx, wz);
          if (d < 0.5) this.pathIndex++;
          else desired.set(wx / d, 0, wz / d).multiplyScalar(FLEE);
        } else if (!this.banished && this.stateTime > 2.5) this.set('stalk');
        if (this.stateTime > 7 && !this.banished) this.set('stalk');
        break;
    }

    // --- Move.
    const accel = (this.state === 'lunge' ? 30 : 12) * dt;
    this.vel.x += clamp(desired.x - this.vel.x, -accel, accel);
    this.vel.z += clamp(desired.z - this.vel.z, -accel, accel);
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (this.nav.walkable(nx, nz)) this.pos.set(nx, 0, nz);
    else if (this.nav.walkable(nx, this.pos.z)) this.pos.x = nx;
    else if (this.nav.walkable(this.pos.x, nz)) this.pos.z = nz;
    else this.vel.set(0, 0, 0);
    const v = Math.hypot(this.vel.x, this.vel.z);
    const want = face ?? (v > 0.3 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw);
    this.yaw += clamp(Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)), -9 * dt, 9 * dt);
    this.stride += (v * dt * Math.PI * 2) / strideLength(this.strideAmount);
    this.strideAmount += (clamp(v / 1.6, 0, 1.3) - this.strideAmount) * Math.min(1, dt * 10);

    // --- Pose.
    p.idle = false;
    p.stridePhase = this.stride;
    p.strideAmount = this.strideAmount;
    p.strideSide = 0;
    p.spineY = 0;
    // A slow, wrong head tilt while creeping.
    p.headY = Math.sin(this.time * 0.9 + this.index) * 0.25;
    switch (this.state) {
      case 'stalk':
        p.crouch = 0.4;
        p.spineX = 0.42;
        p.headX = -0.25;
        p.armL = -0.35 + Math.sin(this.stride) * 0.15;
        p.armR = -0.75;
        p.elbows = 0.9;
        break;
      case 'lunge':
        p.crouch = 0.12;
        p.spineX = 0.5;
        p.headX = -0.35;
        p.headY = 0;
        p.armL = -1.3 + Math.sin(this.stride) * 0.4;
        p.armR = -2.9; // blade up over the head
        p.elbows = 0.7;
        break;
      case 'slash': {
        const k = clamp(this.stateTime / 0.18, 0, 1);
        p.crouch = 0.2;
        p.spineX = 0.5 + k * 0.25;
        p.headX = -0.2;
        p.headY = 0;
        p.armL = -0.9;
        p.armR = -2.9 + k * 3.1; // down through you
        p.elbows = 0.3;
        break;
      }
      case 'flinch':
        p.crouch = 0.3;
        p.spineX = -0.1;
        p.headX = 0.3;
        p.armL = -2.4; // forearm over the mask
        p.armR = -0.6;
        p.elbows = 2.2;
        break;
      default:
        p.crouch = 0.15;
        p.spineX = 0.35;
        p.headX = 0;
        p.armL = -0.5 + Math.sin(this.stride) * 0.6;
        p.armR = -0.5 - Math.sin(this.stride) * 0.6;
        p.elbows = 1.1;
    }
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.update(dt, p);
  }
}
