import * as THREE from 'three';
import { RAPIER, GROUPS, type Physics } from '../core/Physics';
import { Spring } from '../core/Spring';
import { Noise1D } from '../core/Noise';
import { clamp, DEG } from '../core/math';
import { feel } from '../config/Feel';
import { Humanoid, defaultPose, type DamageInfo } from '../targets/Humanoid';
import { buildEnemyRifle, type WeaponRig } from '../weapons/WeaponModels';
import { getAmmo, type AmmoData } from '../weapons/AmmoData';
import { MuzzleFlash } from '../fx/MuzzleFlash';
import type { ProjectileSystem } from '../weapons/Ballistics';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { Shells } from '../fx/Shells';
import type { AudioSystem } from '../audio/AudioSystem';
import type { NavGrid } from '../ai/NavGrid';
import { soldierMaterials, soldierSkin } from './SoldierSkin';

/** What the AI knows about the player, refreshed by the squad every frame. */
export interface PlayerTarget {
  feet: THREE.Vector3;
  head: THREE.Vector3;
  chest: THREE.Vector3;
  velocity: THREE.Vector3;
  sprinting: boolean;
  crouching: boolean;
  alive: boolean;
}

export interface SoldierDeps {
  physics: Physics;
  nav: NavGrid;
  projectiles: ProjectileSystem;
  impacts: ImpactSystem;
  shells: Shells;
  audio: AudioSystem;
  scene: THREE.Object3D;
}

export type Role = 'anchor' | 'flankL' | 'flankR' | 'push';
export type BrainState = 'patrol' | 'alert' | 'combat' | 'search' | 'dead';
export type VoiceLine = 'see_enemy' | 'spread_out' | 'contact' | 'flanking' | 'moving' | 'reloading' | 'target_down' | 'man_down' | 'lost_visual' | 'hit';

export interface SoldierHooks {
  onSpotted(s: Soldier): void;
  onDamaged(s: Soldier, info: DamageInfo): void;
  onKilled(s: Soldier, info: DamageInfo): void;
  say(s: Soldier, line: VoiceLine): void;
  onThud(at: THREE.Vector3, strength: number): void;
}

export const WALK = 1.45;
export const JOG = 2.2;
export const RUN = 3.7;
const MAG = 30;
const FIRE_INTERVAL = 60 / 620;
const RELOAD_TIME = 2.7;
const HEAD_OFFSET = new THREE.Vector3(0, 0.15, 0.04);

const v3 = () => new THREE.Vector3();

/**
 * One Black Division operator: Humanoid body (soldier skin, plate + helmet),
 * a black carbine held with two-hand IK, perception (view cone + line of sight
 * + awareness that builds up), navigation, cover-aware positioning, and
 * human-like shooting (reaction time, aim error that tightens while the target
 * stays visible, bursts, recoil, reloads, flinch when hit).
 *
 * Squad-level decisions (who flanks, when to speak, patrol formation) live in
 * BlackDivision; this class executes them.
 */
export class Soldier {
  readonly body: Humanoid;
  readonly rig: WeaponRig;
  readonly index: number;
  state: BrainState = 'patrol';
  role: Role = 'anchor';

  readonly pos = v3();
  yaw = 0;
  readonly vel = v3();
  /** Seconds this soldier has continuously seen the player. */
  visibleTime = 0;
  sees = false;
  awareness = 0;
  /** Voice pitch: each operator sounds slightly different. */
  readonly voicePitch: number;

  // Movement
  path: THREE.Vector3[] | null = null;
  private pathIndex = 0;
  moveSpeed = WALK;
  /** Explicit destination for combat/search positions. */
  readonly goal = v3();
  hasGoal = false;
  goalLowCover = false;
  decideTimer = 0;
  noLosTime = 0;
  holdTimer = 0;

  // Aim / fire
  private aimNode = new THREE.Group();
  private rifleRoot: THREE.Group;
  private flash = new MuzzleFlash(2.6);
  private aimYaw = 0;
  private aimPitch = -0.5;
  private recoilPitch = new Spring(120, 14);
  private recoilYaw = new Spring(120, 14);
  private errNoise: Noise1D;
  private errNoise2: Noise1D;
  private time = Math.random() * 100;
  private reactionTimer = 0;
  private burstLeft = 0;
  private nextShot = 0;
  private burstPause = 0;
  ammo = MAG;
  reloadTimer = 0;
  private flinch = 0;
  private ammoData: AmmoData;

  // Stance
  private crouch = 0;
  crouchTarget = 0;
  /** Low-cover peek cycle phase (seconds). */
  peekPhase = Math.random() * 3;
  seeChest = false;
  seeHead = false;
  wasSeeing = false;
  saidFlank = false;
  repathTimer = 0;
  private stride = 0;
  private strideAmount = 0;
  private strideSide = 0;
  private pose = defaultPose();
  private perceiveTimer = Math.random() * 0.12;
  private strobe = 0;

  // Dropped rifle
  private rifleBody: RAPIER.RigidBody;
  private reloadHand = new THREE.Object3D();

  private tmp = v3();
  private tmp2 = v3();
  private tmp3 = v3();
  private q = new THREE.Quaternion();
  private eye = v3();
  private muzzle = v3();
  private dir = v3();

  constructor(
    private deps: SoldierDeps,
    index: number,
    private hooks: SoldierHooks,
  ) {
    this.index = index;
    this.voicePitch = 0.94 + index * 0.035;
    this.errNoise = new Noise1D(index * 17 + 3);
    this.errNoise2 = new Noise1D(index * 29 + 11);
    this.ammoData = getAmmo('762x39_ps');
    this.body = new Humanoid(deps.physics, deps.scene, soldierSkin(160), {
      onDamage: (info) => this.onDamaged(info),
      onDeath: (info) => this.onKilled(info),
      onThud: (at, s) => hooks.onThud(at, s),
    }, this);

    // Rifle in the right shoulder pocket; the aim node pitches/yaws it.
    const torso = this.body.part('torso').group;
    this.aimNode.position.set(0.11, 0.41, 0.12);
    this.aimNode.rotation.order = 'YXZ';
    torso.add(this.aimNode);
    this.rig = buildEnemyRifle();
    this.rifleRoot = this.rig.root;
    this.rifleRoot.rotation.y = Math.PI;
    this.rifleRoot.position.set(this.rig.butt.x, -this.rig.butt.y, this.rig.butt.z);
    this.aimNode.add(this.rifleRoot);
    this.flash.attachTo(this.rig.muzzle);
    this.reloadHand.position.set(-0.05, 0.2, 0.24);
    torso.add(this.reloadHand);

    this.rifleBody = deps.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setEnabled(false).setCcdEnabled(true).setAngularDamping(0.5),
    );
    deps.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.03, 0.06, 0.42).setTranslation(0, 0.03, -0.12).setMass(3.5).setFriction(0.9).setCollisionGroups(GROUPS.debris),
      this.rifleBody,
    );
    deps.physics.addSynced(this.rifleBody, this.rifleRoot);
  }

  get alive(): boolean {
    return this.body.alive;
  }

  get headPos(): THREE.Vector3 {
    return this.body.part('head').worldPos;
  }

  get chestPos(): THREE.Vector3 {
    return this.tmp3.copy(this.body.part('torso').worldPos).setY(this.body.part('torso').worldPos.y + 0.3);
  }

  // ------------------------------------------------------------ lifecycle

  spawn(at: THREE.Vector3, yaw: number): void {
    this.pos.copy(at).setY(0);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.state = 'patrol';
    this.awareness = 0;
    this.sees = false;
    this.visibleTime = 0;
    this.path = null;
    this.hasGoal = false;
    this.ammo = MAG;
    this.reloadTimer = 0;
    this.crouch = this.crouchTarget = 0;
    this.aimPitch = -0.5;
    this.aimYaw = -0.3;
    this.rifleBody.setEnabled(false);
    if (this.rifleRoot.parent !== this.aimNode) {
      this.aimNode.add(this.rifleRoot);
      this.rifleRoot.rotation.set(0, Math.PI, 0);
      this.rifleRoot.position.set(this.rig.butt.x, -this.rig.butt.y, this.rig.butt.z);
    }
    if (this.rig.mag) this.rig.mag.visible = true;
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.reset(false);
  }

  private onDamaged(info: DamageInfo): void {
    // A hit ruins the aim for a moment and makes the soldier certain where we are.
    this.flinch = Math.min(1.5, this.flinch + 0.6 + info.hit.impulse * 0.2);
    this.burstLeft = 0;
    this.nextShot = Math.max(this.nextShot, this.time + 0.35);
    this.hooks.onDamaged(this, info);
  }

  private onKilled(info: DamageInfo): void {
    this.state = 'dead';
    this.flash.update(1);
    // Drop the rifle as a physics object.
    this.rifleRoot.updateMatrixWorld(true);
    this.rifleRoot.getWorldPosition(this.tmp);
    this.rifleRoot.getWorldQuaternion(this.q);
    this.deps.scene.add(this.rifleRoot);
    this.rifleRoot.position.copy(this.tmp);
    this.rifleRoot.quaternion.copy(this.q);
    const b = this.rifleBody;
    b.setEnabled(true);
    b.setTranslation(this.tmp, true);
    b.setRotation(this.q, true);
    b.setLinvel({ x: info.hit.direction.x * 1.5 + this.vel.x, y: 1.2, z: info.hit.direction.z * 1.5 + this.vel.z }, true);
    b.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);
    soldierMaterials().strobe.emissiveIntensity = 0;
    this.hooks.onKilled(this, info);
  }

  // ------------------------------------------------------------ perception

  /** View cone + line of sight + awareness build-up. Returns true when newly spotted. */
  perceive(dt: number, player: PlayerTarget): boolean {
    this.perceiveTimer -= dt;
    if (this.perceiveTimer > 0) return false;
    const step = 0.12 - this.perceiveTimer;
    this.perceiveTimer = 0.12;
    if (!player.alive) {
      this.sees = false;
      this.visibleTime = 0;
      return false;
    }
    this.eye.copy(this.headPos).add(HEAD_OFFSET);
    const to = this.tmp.subVectors(player.head, this.eye);
    const dist = to.length();
    const combat = this.state === 'combat' || this.state === 'alert' || this.state === 'search';
    // Horizontal view cone around where the body (and head) faces.
    const fwdYaw = this.yaw + this.pose.headY * 0.6;
    const angle = Math.abs(wrap(Math.atan2(to.x, to.z) - fwdYaw));
    const cone = combat ? 100 * DEG : 62 * DEG;
    let visible = false;
    this.seeHead = this.seeChest = false;
    if (dist < 95 && (angle < cone || dist < 2.5)) {
      this.seeChest = this.deps.physics.lineOfSight(this.eye, player.chest, GROUPS.sight);
      this.seeHead = this.seeChest || this.deps.physics.lineOfSight(this.eye, player.head, GROUPS.sight);
      visible = this.seeHead;
    }
    this.sees = visible;
    if (visible) {
      this.visibleTime += step;
      if (this.state === 'patrol') {
        const near = clamp(1.5 - dist / 40, 0.15, 1.5);
        const posture = player.sprinting ? 1.6 : player.crouching && player.velocity.lengthSq() < 0.5 ? 0.5 : 1;
        this.awareness += step * 1.25 * near * posture;
        if (dist < 7) this.awareness = 1;
        if (this.awareness >= 1) return true;
      }
    } else {
      this.visibleTime = 0;
      if (this.state === 'patrol') this.awareness = Math.max(0, this.awareness - step * 0.12);
      if (dist < 1.8) this.awareness = 1; // bumped into us
    }
    return false;
  }

  // ------------------------------------------------------------ movement

  setPath(to: THREE.Vector3, speed: number): boolean {
    const p = this.deps.nav.findPath(this.pos, to);
    this.path = p;
    this.pathIndex = 0;
    this.moveSpeed = speed;
    return !!p;
  }

  get pathDone(): boolean {
    return !this.path || this.pathIndex >= this.path.length;
  }

  stop(): void {
    this.path = null;
  }

  /** Steer toward `target` directly (formation following on the leader's trail). */
  steerTo(target: THREE.Vector3, speed: number): void {
    this.path = [target.clone()];
    this.pathIndex = 0;
    this.moveSpeed = speed;
  }

  // ------------------------------------------------------------ frame

  /**
   * @param faceTarget world point to face/aim at (null = face movement)
   * @param aimMode 'low' (patrol carry), 'ready', 'aim'
   */
  update(dt: number, player: PlayerTarget, mates: Soldier[], faceTarget: THREE.Vector3 | null, aimMode: 'low' | 'ready' | 'aim', wantFire: boolean): void {
    this.time += dt;
    if (!this.alive) {
      this.body.update(dt, this.pose);
      return;
    }
    this.flinch = Math.max(0, this.flinch - dt * 1.4);
    this.move(dt, mates, player, faceTarget);

    // Stance: crouch smoothing; low-cover peeking is driven by the squad (crouchTarget).
    this.crouch += (this.crouchTarget - this.crouch) * Math.min(1, dt * 7);

    // IR strobe on the helmet blinks (shared material: whole squad blinks together).
    this.strobe = (this.time * 1.3) % 1;
    soldierMaterials().strobe.emissiveIntensity = this.strobe < 0.05 ? 6 : 0;

    // Animation layer.
    const p = this.pose;
    p.idle = false;
    p.crouch = this.crouch * 0.85;
    p.stridePhase = this.stride;
    p.strideAmount = this.strideAmount;
    p.strideSide = this.strideSide;
    p.spineY = 0.32; // bladed stance: support shoulder forward
    p.spineX = aimMode === 'low' ? 0.04 : 0.1;
    const scan = this.state === 'patrol' ? Math.sin(this.time * 0.55 + this.index) * 0.45 : 0;
    p.headY = scan - 0.32; // face the target over the bladed torso
    p.headX = aimMode === 'aim' ? 0.18 : 0.05;
    p.gripR = this.rig.rightHand;
    const reloading = this.reloadTimer > 0;
    const rk = reloading ? 1 - this.reloadTimer / RELOAD_TIME : 0;
    const handOff = reloading && rk > 0.2 && rk < 0.62;
    p.gripL = handOff ? this.reloadHand : this.rig.mag && reloading && rk > 0.1 && rk < 0.8 ? this.rig.mag : this.rig.leftHand;
    if (this.rig.mag) this.rig.mag.visible = !(reloading && rk > 0.25 && rk < 0.6);

    this.aim(dt, faceTarget, aimMode, player);
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.update(dt, p);

    this.weapon(dt, player, mates, wantFire && aimMode === 'aim');
    this.flash.update(dt);
  }

  private move(dt: number, mates: Soldier[], player: PlayerTarget, faceTarget: THREE.Vector3 | null): void {
    const desired = this.tmp.set(0, 0, 0);
    let speed = 0;
    if (this.path && this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const to = this.tmp2.set(wp.x - this.pos.x, 0, wp.z - this.pos.z);
      const d = to.length();
      if (d < 0.35) this.pathIndex++;
      else {
        speed = this.moveSpeed * (this.crouch > 0.5 ? 0.55 : 1);
        // Slow into the final point.
        if (this.pathIndex === this.path.length - 1) speed = Math.min(speed, d * 2.2);
        desired.copy(to).divideScalar(d).multiplyScalar(speed);
      }
    }
    // Separation from squadmates and the player.
    for (const m of mates) {
      if (m === this || !m.alive) continue;
      const dx = this.pos.x - m.pos.x;
      const dz = this.pos.z - m.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.44 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        desired.x += (dx / d) * (1.2 - d) * 2.5;
        desired.z += (dz / d) * (1.2 - d) * 2.5;
      }
    }
    if (player.alive) {
      const dx = this.pos.x - player.feet.x;
      const dz = this.pos.z - player.feet.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.3 && d > 1e-4) {
        desired.x += (dx / d) * (1.3 - d) * 4;
        desired.z += (dz / d) * (1.3 - d) * 4;
      }
    }
    // Accelerate toward the desired velocity.
    const accel = 9;
    this.vel.x += clamp(desired.x - this.vel.x, -accel * dt, accel * dt);
    this.vel.z += clamp(desired.z - this.vel.z, -accel * dt, accel * dt);
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    // Never step into solid cells (slide along the free axis instead).
    if (this.deps.nav.walkable(nx, nz)) this.pos.set(nx, 0, nz);
    else if (this.deps.nav.walkable(nx, this.pos.z)) {
      this.pos.x = nx;
      this.vel.z = 0;
    } else if (this.deps.nav.walkable(this.pos.x, nz)) {
      this.pos.z = nz;
      this.vel.x = 0;
    } else this.vel.set(0, 0, 0);

    const v = Math.hypot(this.vel.x, this.vel.z);
    // Facing: at the target when there is one, else along the movement.
    let wantYaw = this.yaw;
    if (faceTarget) wantYaw = Math.atan2(faceTarget.x - this.pos.x, faceTarget.z - this.pos.z);
    else if (v > 0.2) wantYaw = Math.atan2(this.vel.x, this.vel.z);
    const turn = (faceTarget ? 7 : 4) * dt;
    this.yaw += clamp(wrap(wantYaw - this.yaw), -turn, turn);

    // Walk cycle: phase advances with distance; sideways share from local velocity.
    const strideLen = v > 3 ? 2.3 : 1.55;
    this.stride += (v * dt * Math.PI * 2) / strideLen;
    this.strideAmount += (clamp(v / 1.6, 0, v > 3 ? 1.25 : 1) - this.strideAmount) * Math.min(1, dt * 8);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const side = v > 0.1 ? (this.vel.x * cos - this.vel.z * sin) / v : 0;
    this.strideSide += (side - this.strideSide) * Math.min(1, dt * 6);
  }

  private aim(dt: number, faceTarget: THREE.Vector3 | null, mode: 'low' | 'ready' | 'aim', player: PlayerTarget): void {
    let yaw: number;
    let pitch: number;
    if (mode === 'low' || !faceTarget) {
      // Patrol carry: muzzle down and across the body.
      yaw = -0.62;
      pitch = -0.62;
    } else {
      // Aim point + lead + error; error tightens while the target stays visible.
      const dist = faceTarget.distanceTo(this.pos);
      const tof = dist / 700;
      const t = this.tmp.copy(faceTarget).addScaledVector(player.velocity, tof * 0.8);
      this.aimNode.getWorldPosition(this.tmp2);
      const d = t.sub(this.tmp2);
      // Into root (body) space.
      const s = Math.sin(-this.yaw);
      const c = Math.cos(-this.yaw);
      const lx = d.x * c + d.z * s;
      const lz = -d.x * s + d.z * c;
      yaw = Math.atan2(lx, lz) - 0.32;
      pitch = Math.atan2(d.y, Math.hypot(lx, lz)) - (mode === 'ready' ? 0.35 : 0);
      if (mode === 'aim') {
        const moving = Math.hypot(this.vel.x, this.vel.z) > 0.6;
        const settle = 1 + 3.5 * Math.exp(-this.visibleTime / 2.0);
        const sigma = ((1.0 + 0.03 * dist) * settle * (moving ? 1.7 : 1) * (1 + this.flinch * 2) * DEG) / Math.max(0.2, feel.enemyAccuracy);
        yaw += this.errNoise.sample(this.time * 0.9) * sigma * 1.9;
        pitch += this.errNoise2.sample(this.time * 0.9) * sigma * 1.1;
      }
    }
    const rate = (mode === 'aim' ? 4 : 2.5) * dt;
    this.aimYaw += clamp(yaw - this.aimYaw, -rate, rate);
    this.aimPitch += clamp(pitch - this.aimPitch, -rate, rate);
    this.recoilPitch.update(dt);
    this.recoilYaw.update(dt);
    // The body's own lean (crouch, spine) is part of the parent chain.
    // Cancel the animated spine lean (not the hit reactions: those throw the aim off).
    const lean = (mode === 'low' ? 0.04 : 0.1) + this.crouch * 0.85 * 0.18;
    this.aimNode.rotation.set(-(this.aimPitch + this.recoilPitch.value) - lean, this.aimYaw + this.recoilYaw.value, 0);
  }

  // ------------------------------------------------------------ weapon

  /** Reaction delay before the first shot after acquiring the target. */
  onAcquire(): void {
    this.reactionTimer = 0.55 + Math.random() * 0.45;
  }

  startReload(): boolean {
    if (this.reloadTimer > 0 || this.ammo === MAG) return false;
    this.reloadTimer = RELOAD_TIME;
    this.burstLeft = 0;
    this.deps.audio.play('reload.rifle.magout', { position: this.pos, volume: 0.6 });
    return true;
  }

  private weapon(dt: number, player: PlayerTarget, mates: Soldier[], wantFire: boolean): void {
    if (this.reloadTimer > 0) {
      const before = this.reloadTimer;
      this.reloadTimer -= dt;
      if (before > RELOAD_TIME * 0.45 && this.reloadTimer <= RELOAD_TIME * 0.45) this.deps.audio.play('reload.rifle.magin', { position: this.pos, volume: 0.7 });
      if (this.reloadTimer <= 0) {
        this.ammo = MAG;
        this.deps.audio.play('reload.rifle.boltforward', { position: this.pos, volume: 0.6 });
      }
      return;
    }
    this.reactionTimer -= dt;
    if (!wantFire || !player.alive || this.reactionTimer > 0) {
      this.burstLeft = 0;
      return;
    }
    if (this.ammo <= 0) {
      this.startReload();
      return;
    }
    if (this.time < this.nextShot) return;
    if (this.burstLeft <= 0) {
      if (this.time < this.burstPause) return;
      const dist = this.pos.distanceTo(player.feet);
      this.burstLeft = dist > 35 ? 1 + ((Math.random() * 2) | 0) : dist > 15 ? 2 + ((Math.random() * 2) | 0) : 3 + ((Math.random() * 3) | 0);
    }
    // Muzzle and bore.
    this.rig.muzzle.getWorldPosition(this.muzzle);
    this.rifleRoot.getWorldQuaternion(this.q);
    this.dir.set(0, 0, -1).applyQuaternion(this.q);
    // Don't shoot through a squadmate.
    for (const m of mates) {
      if (m === this || !m.alive) continue;
      const to = this.tmp.subVectors(m.chestPos, this.muzzle);
      const along = to.dot(this.dir);
      if (along > 0 && along < this.muzzle.distanceTo(player.chest) && to.addScaledVector(this.dir, -along).length() < 0.6) {
        this.burstLeft = 0;
        this.burstPause = this.time + 0.4;
        return;
      }
    }
    // Small mechanical dispersion (~2.5 MOA).
    const moa = 0.042 * DEG;
    this.dir.x += gauss() * moa;
    this.dir.y += gauss() * moa;
    this.dir.z += gauss() * moa;
    this.dir.normalize();
    this.ammo--;
    this.burstLeft--;
    this.nextShot = this.time + FIRE_INTERVAL * (0.95 + Math.random() * 0.1);
    if (this.burstLeft <= 0) this.burstPause = this.time + 0.6 + Math.random() * 0.9;
    const tracer = this.ammo % 4 === 0;
    this.deps.projectiles.fire(this.muzzle, this.dir, this.ammoData.muzzleVelocity * (0.985 + Math.random() * 0.03), this.ammoData, 0, tracer, true, this, true);
    this.flash.trigger(1.3);
    this.deps.impacts.muzzleBlast(this.muzzle, this.dir, 1.1);
    this.deps.impacts.muzzleSmoke(this.muzzle, this.dir, 0.6);
    this.deps.audio.play('bd.fire', { position: this.muzzle });
    this.recoilPitch.impulse(0.55 + Math.random() * 0.3);
    this.recoilYaw.impulse((Math.random() - 0.5) * 0.5);
    // Brass out to the right.
    this.rig.ejectPort.getWorldPosition(this.tmp);
    this.tmp2.set(2.2, 1.5, 0.3).applyQuaternion(this.q).add(this.vel);
    this.deps.shells.eject('rifle', this.tmp, this.tmp2, this.q);
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
