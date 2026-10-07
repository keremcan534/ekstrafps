import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import { clamp } from '../core/math';
import { Humanoid, defaultPose, type DamageInfo, strideLength } from '../targets/Humanoid';
import { robotSkin } from '../targets/RobotTarget';
import { withModel } from '../targets/CharacterModels';
import { skinDetail } from './SoldierSkin';
import type { NavGrid } from '../ai/NavGrid';
import { OBSTACLES, obstacleAt, type Obstacle } from '../game/Obstacles';

/** Anything a rogue robot can attack (the player, allies, other teams...). */
export interface MeleeTarget {
  pos: THREE.Vector3;
  alive: boolean;
  hit(damage: number, from: THREE.Vector3): void;
}

export interface RogueHooks {
  onDamage(r: RogueRobot, info: DamageInfo): void;
  onDeath(r: RogueRobot, info: DamageInfo): void;
  onAttack(r: RogueRobot): void;
  onThud(at: THREE.Vector3, strength: number): void;
  onWake(r: RogueRobot): void;
  /** Short circuit: sparks while powered down (EMP from the raid). */
  onShort?(r: RogueRobot, big: boolean): void;
  /** Rebooted after a short circuit. */
  onReboot?(r: RogueRobot): void;
}

type State = 'pooled' | 'rising' | 'idle' | 'waking' | 'chase' | 'dead';

const VISOR = new THREE.Color(0xff3a22);
/** Visor colour per variant: runners read amber. */
const VISORS = { normal: VISOR, runner: new THREE.Color(0xffb21a) };
export type RobotVariant = keyof typeof VISORS;

/** Servo: travel to `to` at a constant `rate` (rad/s) and stop dead, no easing either end. */
const servo = (from: number, to: number, rate: number, dt: number): number => from + clamp(to - from, -rate * dt, rate * dt);
/** The robot's control loop: joint goals are re-read this often (Hz), so motion steps and holds. */
const CONTROL_HZ = 8;

/**
 * Rogue production robot (the "zombie" of Site-9). Either a powered-down
 * wanderer standing slumped where it was left (Left 4 Dead style: it wakes when
 * it sees or hears you, gets shot, or a neighbour wakes), or part of a mob that
 * arrives by service lift / charging bay / hatch. Once awake it paths to the
 * nearest target over the nav grid and swings at it. Uses the same
 * Humanoid body as the target dummies (zoned hitboxes, reactions, ragdoll).
 * Pooled: robots are created once and recycled between spawns.
 */
export class RogueRobot {
  readonly body: Humanoid;
  state: State = 'pooled';
  readonly pos = new THREE.Vector3();
  yaw = 0;
  speed = 1.6;
  damage = 30;
  private vel = new THREE.Vector3();
  private path: THREE.Vector3[] | null = null;
  private pathIndex = 0;
  private repath = Math.random() * 0.6;
  private attackTime = -1;
  private cooldown = 0;
  private stride = 0;
  private strideAmount = 0;
  private deadTime = 0;
  private flash = 0;
  private pose = defaultPose();
  private merged: THREE.MeshStandardMaterial;
  private materials: { paint: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial };
  private tmp = new THREE.Vector3();
  /**
   * Servo-driven joints (the robot's motion): `goal` is latched by the control loop,
   * `at` travels to it at a fixed rate. Arms, elbows, head and torso move like motors.
   */
  private joint = {
    goal: { armL: 0, armR: 0, elbows: 0, headX: 0, headY: 0, spineX: 0, spineY: 0 },
    at: { armL: 0, armR: 0, elbows: 0, headX: 0, headY: 0, spineX: 0, spineY: 0 },
  };
  private control = Math.random() / CONTROL_HZ;
  /** Turning: holds its heading until off by a margin, then pivots square in one go. */
  private turning = false;
  /** Dormant twitch: seconds to the next one, time left on this one, where the head jerks to. */
  private twitchIn = 2 + Math.random() * 4;
  private twitch = 0;
  private twitchHead = 0;
  /** The fast runner (amber visor) or the normal walker. */
  variant: RobotVariant = 'normal';
  /** The model's materials on show (none on the procedural body). */
  private looks: THREE.MeshStandardMaterial[] = [];

  constructor(physics: Physics, scene: THREE.Object3D, private nav: NavGrid, private hooks: RogueHooks) {
    this.materials = {
      paint: new THREE.MeshStandardMaterial({ color: 0x8d8f93, metalness: 0.5, roughness: 0.45 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x24272b, metalness: 0.75, roughness: 0.4 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: VISOR, emissiveIntensity: 2.6, roughness: 0.3 }),
    };
    const { paint, dark, visor } = this.materials;
    this.merged = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.45 });
    const skin = withModel('robot', robotSkin(paint, dark, visor, 100, this.merged));
    this.body = new Humanoid(physics, scene, skin, {
      onDamage: (info) => {
        this.flash = 1;
        this.wake();
        hooks.onDamage(this, info);
      },
      onDeath: (info) => {
        this.state = 'dead';
        this.deadTime = 0;
        this.setVisor(0.2);
        hooks.onDeath(this, info);
      },
      onThud: (at, s) => hooks.onThud(at, s),
    }, this);
    this.pose.idle = false;
    // Model robots (public/chars: the box walker) get their own copies of the
    // materials, so each robot's visor glow and hit flash are its own.
    if (skin.body) {
      this.looks = skin.body.materials.map((m) => (m as THREE.MeshStandardMaterial).clone());
      this.body.setBodyLook(null, this.looks);
    }
    this.body.setActive(false);
  }

  /** Visor glow, 2.6 = fully awake. */
  private setVisor(intensity: number): void {
    this.materials.visor.emissiveIntensity = intensity;
    for (const m of this.looks) m.emissiveIntensity = Math.min(1.6, intensity / 1.6);
  }

  setVariant(v: RobotVariant): void {
    this.variant = v;
    this.materials.visor.emissive.copy(VISORS[v]);
  }

  get active(): boolean {
    return this.state !== 'pooled';
  }

  get alive(): boolean {
    return this.state === 'rising' || this.state === 'chase' || this.state === 'idle' || this.state === 'waking';
  }

  /** Awake and hunting. */
  get aggro(): boolean {
    return this.state === 'rising' || this.state === 'chase' || this.state === 'waking';
  }

  get dormant(): boolean {
    return this.state === 'idle';
  }

  /** Seconds left of a short circuit (powered down, can't wake). */
  stunned = 0;
  private sparkTimer = 0;

  /**
   * Short circuit: whatever it was doing, it drops into the powered-down slump with
   * sparks and a dead visor, then reboots after `seconds`.
   */
  shortCircuit(seconds: number): void {
    if (!this.alive) return;
    this.stunned = seconds;
    this.sparkTimer = 0;
    this.attackTime = -1;
    this.path = null;
    this.state = 'idle';
    this.setVisor(0.05);
    this.hooks.onShort?.(this, true);
  }

  /** Power up (seen/heard/shot/neighbour). */
  wake(): void {
    if (this.state !== 'idle' || this.stunned > 0) return;
    this.state = 'waking';
    this.wakeTime = 0;
    this.hooks.onWake(this);
  }
  private wakeTime = 0;
  /** Idle wanderers shuffle between nearby spots instead of standing still. */
  wanders = false;
  private wanderTimer = 0;
  private wanderTo: THREE.Vector3 | null = null;

  /**
   * @param mode 'rise' climbs out of the floor, 'step' walks straight out (lift/bay),
   *             'idle' stands powered-down until disturbed.
   */
  spawn(at: THREE.Vector3, health: number, speed: number, damage: number, mode: 'rise' | 'step' | 'idle' = 'rise', yaw = Math.random() * Math.PI * 2): void {
    this.pos.copy(at).setY(0);
    this.yaw = yaw;
    this.speed = speed;
    this.damage = damage;
    this.vel.set(0, 0, 0);
    this.path = null;
    this.attackTime = -1;
    this.cooldown = 0.6;
    this.state = mode === 'idle' ? 'idle' : mode === 'rise' ? 'rising' : 'chase';
    this.wanders = mode === 'idle' && Math.random() < 0.5;
    this.wanderTo = null;
    this.wanderTimer = Math.random() * 4;
    this.body.health.maxHealth = health;
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.setActive(true);
    this.body.reset(mode === 'rise');
    this.setVisor(mode === 'idle' ? 0.35 : 2.6);
    const slump = mode === 'idle';
    const start = { armL: slump ? 0.1 : -0.55, armR: slump ? 0.1 : -0.55, elbows: slump ? 0.1 : 0.9, headX: slump ? 0.6 : 0, headY: 0, spineX: slump ? 0.55 : 0.06, spineY: 0 };
    Object.assign(this.joint.goal, start);
    Object.assign(this.joint.at, start);
    this.turning = false;
    this.twitch = 0;
  }

  recycle(): void {
    this.state = 'pooled';
    this.body.setActive(false);
  }

  /** Barricade being torn at. */
  private chew: Obstacle | null = null;

  /**
   * Run the servos: `latch` sets the goals (on the control loop's tick, or this frame when
   * `now`), then every joint moves to its goal at `rate` and the pose takes the result.
   */
  private drive(dt: number, rate: number, latch: (g: RogueRobot['joint']['goal']) => void, now = false): void {
    this.control -= dt;
    if (now || this.control <= 0) {
      this.control = now ? 1 / CONTROL_HZ : Math.max(this.control + 1 / CONTROL_HZ, 0.25 / CONTROL_HZ);
      latch(this.joint.goal);
    }
    const { goal, at } = this.joint;
    for (const k of Object.keys(goal) as (keyof typeof goal)[]) at[k] = servo(at[k], goal[k], rate, dt);
    const p = this.pose;
    p.armL = at.armL;
    p.armR = at.armR;
    p.elbows = at.elbows;
    p.headX = at.headX;
    p.headY = at.headY;
    p.spineX = at.spineX;
    p.spineY = at.spineY;
  }

  /** Turn towards `want`: nothing inside the dead band, else a constant-rate pivot until square. */
  private pivot(want: number, band: number, rate: number, dt: number): void {
    const da = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    if (Math.abs(da) > band) this.turning = true;
    else if (Math.abs(da) < 0.03) this.turning = false;
    if (this.turning) this.yaw += clamp(da, -rate * dt, rate * dt);
  }

  update(dt: number, targets: MeleeTarget[], others: RogueRobot[]): void {
    if (this.state === 'pooled') return;
    this.flash = Math.max(0, this.flash - dt * 8);
    const f = this.flash;
    this.merged.emissive.setRGB(f * 0.8, f * 0.7, f * 0.6);
    for (const m of this.looks) m.color.setScalar(1 + f * 1.5);
    if (this.state === 'dead') {
      this.body.update(dt, this.pose);
      this.deadTime += dt;
      // Phones: corpses clear sooner (fewer ragdolls in the physics step).
      if (this.deadTime > (skinDetail.low ? 3 : 6)) this.recycle();
      return;
    }
    if (this.stunned > 0) {
      this.stunned -= dt;
      this.sparkTimer -= dt;
      if (this.sparkTimer <= 0) {
        this.sparkTimer = 0.25 + Math.random() * 0.9;
        this.hooks.onShort?.(this, false);
      }
      // Dead visor that stutters back now and then.
      this.setVisor(Math.random() < 0.08 ? 1.6 : 0.05);
      if (this.stunned <= 0) {
        this.stunned = 0;
        this.hooks.onReboot?.(this);
        this.wake();
      }
    }
    if (this.state === 'idle' || this.state === 'waking') {
      // Powered down: slumped, head hanging, arms limp, a slow sway. Waking straightens up.
      const p = this.pose;
      // Boot sequence: the head comes up, then the torso, then the arms, each its own servo move.
      let stage = 0;
      if (this.state === 'waking') {
        this.wakeTime += dt;
        stage = Math.min(3, Math.floor(this.wakeTime / 0.17) + 1);
        this.setVisor(0.35 + (stage / 3) * 2.6 + (this.wakeTime < 0.3 ? Math.random() * 2 : 0));
        if (this.wakeTime >= 0.7) this.state = 'chase';
      }
      const k = stage > 0 ? 0 : 1;
      // Wanderers drift around at a slumped shuffle.
      let shuffle = 0;
      if (this.state === 'idle' && this.wanders) {
        this.wanderTimer -= dt;
        if (!this.wanderTo && this.wanderTimer <= 0) {
          const a = Math.random() * Math.PI * 2;
          const r = 2 + Math.random() * 4;
          const tx = this.pos.x + Math.cos(a) * r;
          const tz = this.pos.z + Math.sin(a) * r;
          if (this.nav.walkable(tx, tz) && this.nav.clearLine(this.pos.x, this.pos.z, tx, tz)) this.wanderTo = new THREE.Vector3(tx, 0, tz);
          else this.wanderTimer = 1;
        }
        if (this.wanderTo) {
          const dx = this.wanderTo.x - this.pos.x;
          const dz = this.wanderTo.z - this.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.3) {
            this.wanderTo = null;
            this.wanderTimer = 3 + Math.random() * 5;
          } else {
            this.pos.x += (dx / d) * 0.55 * dt;
            this.pos.z += (dz / d) * 0.55 * dt;
            this.pivot(Math.atan2(dx, dz), 0.25, 2.5, dt);
            shuffle = 0.55;
            this.stride += (0.55 * dt * Math.PI * 2) / 1.1;
          }
        }
      }
      // Phones: a hidden dormant robot standing still skips posing (Humanoid LOD), so no sway either.
      const still = this.state === 'idle' && shuffle === 0;
      // Powered down, a machine doesn't sway: now and then a servo twitches (the head jerks
      // round and back). Not on hidden phone bodies (they skip posing while still).
      if (this.state === 'idle' && this.stunned <= 0 && !(skinDetail.low && !this.body.root.visible)) {
        this.twitchIn -= dt;
        if (this.twitchIn <= 0) {
          this.twitchIn = 3 + Math.random() * 6;
          this.twitch = 0.25 + Math.random() * 0.3;
          this.twitchHead = (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.35);
        }
      }
      this.twitch = Math.max(0, this.twitch - dt);
      const kHead = stage >= 1 ? 0 : 1;
      const kSpine = stage >= 2 ? 0 : 1;
      const kArms = stage >= 3 ? 0 : 1;
      this.drive(dt, stage > 0 ? 7 : 9, (g) => {
        g.spineX = 0.55 * kSpine + 0.06 * (1 - kSpine);
        g.headX = 0.6 * kHead;
        g.headY = this.twitch > 0 ? this.twitchHead : 0;
        g.armL = g.armR = 0.1 * kArms - 0.55 * (1 - kArms);
        g.elbows = 0.1 + 0.8 * (1 - kArms);
        g.spineY = 0;
      }, stage > 0);
      p.stridePhase = this.stride;
      p.strideAmount = shuffle * k;
      p.crouch = 0.15 * kSpine;
      this.body.root.position.copy(this.pos);
      this.body.root.rotation.y = this.yaw;
      this.body.update(dt, p, still);
      return;
    }
    if (this.state === 'rising') {
      // Stepping out of the bay: stand while the rise spring settles.
      if (this.body.rise.value > -0.05) this.state = 'chase';
      this.pose.strideAmount = 0;
      this.body.root.position.copy(this.pos);
      this.body.update(dt, this.pose);
      return;
    }

    // Nearest living target.
    let best: MeleeTarget | null = null;
    let bd = Infinity;
    for (const t of targets) {
      if (!t.alive) continue;
      const d = t.pos.distanceToSquared(this.pos);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    const dist = Math.sqrt(bd);
    this.cooldown -= dt;

    const desired = this.tmp.set(0, 0, 0);
    if (best && this.attackTime < 0) {
      // Path: straight line when clear, A* otherwise (refreshed a few times a second).
      this.repath -= dt;
      const direct = dist < 30 && this.nav.clearLine(this.pos.x, this.pos.z, best.pos.x, best.pos.z);
      if (direct) {
        this.path = null;
        if (dist > 1.1) desired.set(best.pos.x - this.pos.x, 0, best.pos.z - this.pos.z).normalize().multiplyScalar(this.speed);
      } else {
        if (this.repath <= 0 && dist > 70) {
          // Far-off target: no whole-map search; wait and look again (mobs spawn near their target anyway).
          this.path = null;
          this.repath = 1.5 + Math.random();
        } else if (this.repath <= 0) {
          const path = this.nav.findPathFor(this, this.pos, best.pos, 4000);
          if (path || !this.nav.lastTruncated) {
            this.path = path;
            this.pathIndex = 0;
            this.repath = path ? 0.7 + Math.random() * 0.4 : 1.2 + Math.random() * 0.8;
          } else this.repath = 0.05; // asked the path worker: keep the current path, collect the answer next frame
        }
        if (this.path && this.pathIndex < this.path.length) {
          const wp = this.path[this.pathIndex];
          const dx = wp.x - this.pos.x;
          const dz = wp.z - this.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.5) this.pathIndex++;
          else desired.set(dx / d, 0, dz / d).multiplyScalar(this.speed);
        }
      }
      if (dist < 1.5 && this.cooldown <= 0) this.attackTime = 0; // wind up a swing
    }
    // Separation from other robots.
    for (const o of others) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.81 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        desired.x += (dx / d) * (0.9 - d) * 4;
        desired.z += (dz / d) * (0.9 - d) * 4;
      }
    }
    const accel = 10 * dt;
    this.vel.x += clamp(desired.x - this.vel.x, -accel, accel);
    this.vel.z += clamp(desired.z - this.vel.z, -accel, accel);
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    // A barricade in the way: stop and tear at it.
    const wall = OBSTACLES.length ? obstacleAt(nx, nz, 0.4) : null;
    // Keep the barricade through the swing (the robot stands still while it winds up).
    if (wall) this.chew = wall;
    else if (this.attackTime < 0) this.chew = null;
    if (wall) {
      this.vel.set(0, 0, 0);
      if (this.attackTime < 0 && this.cooldown <= 0) this.attackTime = 0;
    } else if (this.nav.walkable(nx, nz)) this.pos.set(nx, 0, nz);
    else if (this.nav.walkable(nx, this.pos.z)) this.pos.x = nx;
    else if (this.nav.walkable(this.pos.x, nz)) this.pos.z = nz;
    else this.vel.set(0, 0, 0);

    // Face the target when close, else the direction of travel.
    const v = Math.hypot(this.vel.x, this.vel.z);
    let want = this.yaw;
    if (this.chew) want = Math.atan2(this.chew.x - this.pos.x, this.chew.z - this.pos.z);
    else if (best && dist < 4) want = Math.atan2(best.pos.x - this.pos.x, best.pos.z - this.pos.z);
    else if (v > 0.2) want = Math.atan2(this.vel.x, this.vel.z);
    // Holds its heading while near enough, then squares up to the new one in a single pivot.
    this.pivot(want, v > 0.2 ? 0.14 : 0.3, 7, dt);

    // Animation: a machine's march (the Humanoid 'machine' gait), arms up in a guard, the
    // head tracking its target in servo steps; a piston blow on attack.
    this.stride += (v * dt * Math.PI * 2) / strideLength(this.strideAmount);
    this.strideAmount += (clamp(v / 1.6, 0, 1.2) - this.strideAmount) * Math.min(1, dt * 8);
    const p = this.pose;
    p.crouch = 0;
    p.stridePhase = this.stride;
    p.strideAmount = this.strideAmount;
    // Swing clock this frame (-1: none): wind up to 0.38 s, the blow lands at 0.44, done at 0.7.
    const raw = this.attackTime >= 0 ? this.attackTime + dt : -1;
    const t = raw < 0.7 ? raw : -1;
    let look = 0;
    if (best && dist < 25) {
      const bearing = Math.atan2(best.pos.x - this.pos.x, best.pos.z - this.pos.z) - this.yaw;
      look = Math.atan2(Math.sin(bearing), Math.cos(bearing));
    }
    const lean = Math.min(0.12, this.speed * 0.03);
    // The blow drives down far faster than anything else moves.
    const striking = t >= 0.38 && t < 0.5;
    this.drive(dt, striking ? 32 : 9, (g) => {
      g.headX = 0;
      g.headY = Math.round(clamp(look, -0.7, 0.7) / 0.15) * 0.15;
      g.spineX = 0.06 + lean;
      g.spineY = 0;
      g.armL = g.armR = -0.55;
      g.elbows = 0.9;
      if (t >= 0 && t < 0.38) {
        // Wind up: the right arm cranks up and back, the torso turns into it, and holds.
        g.armR = -2.6;
        g.spineY = -0.3;
        g.elbows = 0.5;
      } else if (t >= 0.38) {
        g.armR = -0.25;
        g.spineY = 0.2;
        g.spineX = 0.18 + lean;
        g.elbows = 0.5;
      }
    }, raw >= 0 && (this.attackTime === 0 || (this.attackTime < 0.38 && raw >= 0.38) || raw >= 0.7)); // each phase of a swing starts at once
    if (t >= 0.46 && t < 0.62) {
      // Hard stop: the arm chatters as the servo holds against the blow.
      const k = 1 - (t - 0.46) / 0.16;
      p.armR += Math.sin(t * 90) * 0.06 * k;
      p.spineX += Math.sin(t * 70 + 1) * 0.02 * k;
    }
    if (this.attackTime >= 0) {
      this.attackTime += dt;
      const t = this.attackTime;
      if (t >= 0.38) {
        if (t - dt < 0.44 && t >= 0.44) {
          this.hooks.onAttack(this);
          if (this.chew?.alive) this.chew.damage(this.damage * 1.2);
          else if (best && best.pos.distanceTo(this.pos) < 2.0) best.hit(this.damage, this.pos);
        }
        if (t > 0.7) {
          this.attackTime = -1;
          this.cooldown = 1.0;
        }
      }
    }
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.update(dt, p);
  }
}
