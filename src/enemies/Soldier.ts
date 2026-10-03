import * as THREE from 'three';
import { byPlayer, raid } from '../game/Progress';
import { RAPIER, GROUPS, type Physics } from '../core/Physics';
import { Spring } from '../core/Spring';
import { Noise1D } from '../core/Noise';
import { clamp, DEG } from '../core/math';
import { feel } from '../config/Feel';
import { Humanoid, defaultPose, type DamageInfo, strideLength, LEAN_ROLL } from '../targets/Humanoid';
import { bakedRig, buildEnemyRifle, type WeaponRig } from '../weapons/WeaponModels';
import type { WeaponData } from '../weapons/WeaponData';
import { getAmmo, type AmmoData } from '../weapons/AmmoData';
import type { MuzzleLights } from '../fx/MuzzleLights';
import { MuzzleFlash } from '../fx/MuzzleFlash';
import type { ProjectileSystem } from '../weapons/Ballistics';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { Shells } from '../fx/Shells';
import type { AudioSystem } from '../audio/AudioSystem';
import type { NavGrid } from '../ai/NavGrid';
import { soldierMaterials, soldierSkin, type SoldierMaterials, type SoldierPalette } from './SoldierSkin';
import { OBSTACLES, obstacleAt } from '../game/Obstacles';
import { lightSources, makeBeam, weaponLight, type LightSource } from '../fx/WeaponLights';
import { aiWorld } from '../ai/World';

/** Node budget for a soldier's path search (across the facility: ~85 m with detours). */
const LONG_SEARCH = 40000;

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
  /** Phones: no dynamic light per enemy muzzle flash. */
  lowSpec?: boolean;
  /** Weapon definitions (for soldiers that buy weapons). */
  weaponData?: (id: string) => WeaponData | undefined;
  /** Shared muzzle-flash lights (no light per soldier: light count changes recompile every shader). */
  muzzleLights?: MuzzleLights;
  /** Camera position (flash lights only near the viewer). */
  listener?: THREE.Vector3;
}

/** How the weapon is held: low ready / high port (moving), ready, aiming. */
export type AimMode = 'low' | 'high' | 'ready' | 'aim';

export type Role = 'anchor' | 'flankL' | 'flankR' | 'push';
export type BrainState = 'patrol' | 'alert' | 'combat' | 'search' | 'dead';
export type VoiceLine = 'see_enemy' | 'spread_out' | 'contact' | 'flanking' | 'moving' | 'reloading' | 'target_down' | 'man_down' | 'lost_visual' | 'hit';

export interface SoldierHooks {
  onSpotted(s: Soldier): void;
  onDamaged(s: Soldier, info: DamageInfo): void;
  onKilled(s: Soldier, info: DamageInfo): void;
  say(s: Soldier, line: VoiceLine): void;
  onThud(at: THREE.Vector3, strength: number): void;
  onDowned?(s: Soldier): void;
}

export const WALK = 1.45;
export const JOG = 2.2;
export const RUN = 3.7;
/** Catch-up sprint (falling behind the squad / the player). */
export const SPRINT = 5.2;
const HEAD_OFFSET = new THREE.Vector3(0, 0.15, 0.04);

const v3 = () => new THREE.Vector3();

/**
 * One SABLE operator: Humanoid body (soldier skin, plate + helmet),
 * a black carbine held with two-hand IK, perception (view cone + line of sight
 * + awareness that builds up), navigation, cover-aware positioning, and
 * human-like shooting (reaction time, aim error that tightens while the target
 * stays visible, bursts, recoil, reloads, flinch when hit).
 *
 * Squad-level decisions (who flanks, when to speak, patrol formation) live in
 * BlackDivision; this class executes them.
 */
export class Soldier implements LightSource {
  readonly body: Humanoid;
  rig: WeaponRig;
  readonly index: number;
  /** The Warden (SABLE boss kit). */
  readonly boss: boolean;
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
  private steerPt = v3();
  private steerPath = [this.steerPt];
  /** A path asked of the path worker (see setPath): where to, and the goal it was asked for. */
  private pathWant: { to: THREE.Vector3; asked: THREE.Vector3 } | null = null;
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
  /** Holds the current weapon model (synced to the dropped-rifle body on death). */
  private rifleRoot = new THREE.Group();
  /** Weapon models this soldier has carried, by model (re-arming reuses them). */
  private rigs = new Map<string, WeaponRig>();
  private flash: MuzzleFlash;
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
  // Current weapon (SABLE default: black MK47-pattern carbine).
  magSize = 30;
  private fireInterval = 60 / 620;
  private reloadTime = 2.7;
  private semi = false;
  private pellets = 1;
  private pelletSpread = 0;
  private fireSound = 'bd.fire';
  weaponId = 'bd_carbine';
  /** What the AI knows about its gun: pistol / smg / shotgun / rifle / dmr / bolt. */
  weaponClass = 'rifle';
  /** Integrally suppressed (heard much closer). */
  private suppressed = false;
  /** Burst length multiplier (skilled shooters tap at range). */
  burstScale = 1;
  ammo = 30;
  reloadTimer = 0;
  /** Spare rounds (Infinity: issued weapon / sidearm). */
  reserve = Infinity;
  private maxReserve = Infinity;
  /** Mag and reserve both empty. */
  onDry: (() => void) | null = null;
  private lastStep = 0;
  /** SABLE: rifle light (visible beam; a pooled spot light when near the camera). */
  private beam: ReturnType<typeof makeBeam> | null = null;
  private beamOn = false;
  /** Jump-peek height (m), driven by the AI brain. */
  hopY = 0;
  /** Seconds pushed up against a barricade. */
  private breach = 0;
  // Idle life: breathing, weight shifts, glances, a weapon check now and then.
  private idleTime = Math.random() * 10;
  private glance = 0;
  private glanceTarget = 0;
  private glanceTimer = 0;
  private checkTimer = 4 + Math.random() * 10;
  private checking = 0;
  private roll = 0;
  /** Marksmanship multiplier (1 = SABLE standard). */
  skill = 1;
  /** Holding a handgun: pushed out at arm's length to aim, tucked to the chest otherwise. */
  private pistol = false;
  private hold = new THREE.Vector3();
  private holdWant = new THREE.Vector3();
  /** A friendly player to keep out of the way of (allies). */
  avoid: THREE.Vector3 | null = null;
  private flinch = 0;
  private ammoData: AmmoData;

  // Stance
  private crouch = 0;
  crouchTarget = 0;
  /** Lean round a corner, set by the brain each frame: -1 left … 1 right (0 = upright). */
  leanTarget = 0;
  private lean = 0;
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

  private mats: SoldierMaterials;

  constructor(
    private deps: SoldierDeps,
    index: number,
    private hooks: SoldierHooks,
    /** Team id: 'bd' (SABLE), 'alpha' (the player's team), 'bravo', 'charlie', 'delta'. */
    readonly team: string = 'bd',
    palette: SoldierPalette = team === 'alpha' ? 'vanta' : team === 'bd' ? 'bd' : (team as SoldierPalette),
  ) {
    this.index = index;
    this.boss = palette === 'bdboss';
    this.mats = soldierMaterials(palette);
    this.voicePitch = 0.94 + index * 0.035;
    this.errNoise = new Noise1D(index * 17 + 3);
    this.errNoise2 = new Noise1D(index * 29 + 11);
    this.ammoData = getAmmo('762x39_ps');
    this.flash = new MuzzleFlash(2.6, false);
    this.body = new Humanoid(deps.physics, deps.scene, soldierSkin(palette === 'bdboss' ? 650 : team === 'bd' ? 160 : 200, palette, index % 4), {
      onDamage: (info) => this.onDamaged(info),
      onDeath: (info) => this.onKilled(info),
      onThud: (at, s) => hooks.onThud(at, s),
      onDowned: () => hooks.onDowned?.(this),
    }, this);

    // Rifle in the right shoulder pocket; the aim node pitches/yaws it.
    const torso = this.body.part('torso').group;
    this.aimNode.position.set(0.11, 0.41, 0.12);
    // Z first: the node takes back the torso's lean roll (Q / E), so the gun points where
    // it's aimed whatever the body does (the bore cant is the rifle's own roll).
    this.aimNode.rotation.order = 'ZYX';
    torso.add(this.aimNode);
    this.body.team = team;
    if (deps.lowSpec) this.body.setCastShadow(false);
    this.rig = buildEnemyRifle(!!deps.lowSpec);
    if (deps.lowSpec) this.rig.root.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = false)));
    this.mountRig();
    this.aimNode.add(this.rifleRoot);
    this.flash.attachTo(this.rig.muzzle);
    this.reloadHand.position.set(-0.05, 0.2, 0.24);
    torso.add(this.reloadHand);

    this.rifleBody = deps.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setEnabled(false).setCcdEnabled(true).setAngularDamping(0.5),
    );
    deps.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.03, 0.06, 0.42).setTranslation(0, 0.03, 0.3).setMass(3.5).setFriction(0.9).setCollisionGroups(GROUPS.debris),
      this.rifleBody,
    );
    deps.physics.addSynced(this.rifleBody, this.rifleRoot);
    if (palette === 'bd' || palette === 'bdboss') {
      this.beam = makeBeam();
      this.beam.visible = false;
      this.rifleRoot.add(this.beam);
      lightSources.add(this);
    }
  }

  get lit(): boolean {
    return this.beamOn && this.alive && !this.downed && this.body.root.visible;
  }

  lightOrigin(out: THREE.Vector3): THREE.Vector3 {
    return this.rig.muzzle.getWorldPosition(out);
  }

  lightDir(out: THREE.Vector3): THREE.Vector3 {
    this.rifleRoot.getWorldQuaternion(this.q);
    return out.set(0, 0, 1).applyQuaternion(this.q);
  }

  /** Keep the beam on the muzzle (the rig changes with the weapon) and fade it with the dark. */
  private updateBeam(): void {
    if (!this.beam) return;
    const level = weaponLight.level;
    this.beamOn = level > 0.05;
    this.beam.visible = this.beamOn;
    if (!this.beamOn) return;
    this.rig.muzzle.getWorldPosition(this.tmp);
    this.rifleRoot.worldToLocal(this.beam.position.copy(this.tmp));
    this.beam.setStrength(0.2 * level);
  }

  get alive(): boolean {
    return this.body.alive;
  }

  get downed(): boolean {
    return this.body.downed;
  }

  /** Put the current rig in the holder: barrel forward, butt at the holder origin. */
  private mountRig(): void {
    this.rig.root.rotation.set(0, Math.PI, 0);
    this.rig.root.position.set(this.rig.butt.x, -this.rig.butt.y, this.rig.butt.z);
    this.rifleRoot.add(this.rig.root);
    this.flash.attachTo(this.rig.muzzle);
  }

  /** Arm with a real weapon (fire rate, magazine, ammo, sound, model). */
  setWeapon(data: WeaponData, reserve = Infinity): void {
    this.reserve = this.maxReserve = reserve;
    this.rifleRoot.remove(this.rig.root);
    // Third person: a low-detail build on phones, always baked to ~2 draw calls.
    // Shared baked geometry, and each model kept once per soldier (re-arming the
    // sidearm on every respawn builds nothing).
    let rig = this.rigs.get(data.model);
    if (!rig) {
      rig = bakedRig(data.model, !!this.deps.lowSpec);
      rig.root.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = !this.deps.lowSpec)));
      this.rigs.set(data.model, rig);
    }
    if (rig.mag) rig.mag.visible = true;
    this.rig = rig;
    this.mountRig();
    this.weaponId = data.id;
    this.pistol = data.category === 'pistol';
    this.weaponClass = data.fireModes.includes('bolt') ? 'bolt' : data.category === 'rifle' && !data.fireModes.includes('auto') ? 'dmr' : data.category;
    this.suppressed = /val/i.test(data.id);
    this.ammoData = getAmmo(data.ammo);
    this.magSize = data.magazineSize;
    const manual = data.fireModes.includes('bolt') || data.fireModes.includes('pump');
    const cycle = data.fireModes.includes('bolt') ? Math.max(0.9, data.boltCycleTime || 1) : data.fireModes.includes('pump') ? 0.75 : 0;
    this.fireInterval = Math.max(60 / data.fireRate, cycle, data.fireModes.includes('auto') ? 0 : 0.16);
    this.semi = manual || !data.fireModes.includes('auto');
    this.reloadTime = data.reload.kind === 'magazine' ? data.reload.time : data.reload.shellStart + data.reload.shellInsert * Math.min(5, data.magazineSize) + data.reload.shellEnd;
    this.pellets = Math.max(1, this.ammoData.pellets);
    this.pelletSpread = this.ammoData.pelletSpread;
    this.fireSound = data.audio.fire;
    this.ammo = this.magSize;
  }

  get headPos(): THREE.Vector3 {
    return this.body.part('head').worldPos;
  }

  /** 0 standing .. 1 crouched. */
  get stance(): number {
    return this.crouch;
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
    this.ammo = this.magSize;
    this.reloadTimer = 0;
    this.crouch = this.crouchTarget = 0;
    this.aimPitch = -0.5;
    this.aimYaw = -0.3;
    this.stowRifle();
    if (this.beam) lightSources.add(this);
    if (this.rig.mag) this.rig.mag.visible = true;
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.y = this.yaw;
    this.body.reset(false);
  }

  /** The dropped rifle back in the hands (no physics body). */
  private stowRifle(): void {
    this.rifleBody.setEnabled(false);
    if (this.rifleRoot.parent !== this.aimNode) {
      this.aimNode.add(this.rifleRoot);
      this.rifleRoot.position.set(0, 0, 0);
      this.rifleRoot.quaternion.identity();
    }
  }

  /**
   * Off the map (extracted, or a spare kept for reuse): no longer a light source,
   * and a dropped rifle goes away with the body. spawn() brings both back.
   */
  dispose(): void {
    lightSources.delete(this);
    this.stowRifle();
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
    // Career stats: only your own kills.
    if (byPlayer(info.hit) && this.team !== 'alpha') {
      if (this.team === 'salvage') raid.salvage++;
      else if (this.team !== 'bd') raid.soldiers++;
      else if (this.boss) raid.warden++;
      else raid.bd++;
      if (info.zone === 'head') raid.headshots++;
    }
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
    this.mats.strobe.emissiveIntensity = 0;
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

  /**
   * Walk to `to` along a path. The search runs on the path worker: until its answer is
   * in (a frame or two), the soldier keeps to the path it has and update() collects the
   * answer, so this reports success for a request in flight (a "not yet" is no failure).
   */
  setPath(to: THREE.Vector3, speed: number): boolean {
    this.moveSpeed = speed;
    if (this.pathWant) {
      this.pathWant.to.copy(to);
      return true;
    }
    return this.askPath(to);
  }

  private askPath(to: THREE.Vector3): boolean {
    // (On the path worker the search is off this thread: long cross-facility routes,
    // which wind through several rooms, get the nodes they need. See NavGrid.findPathFor.)
    // Around other teams' barricades when there's a way; through them (breaching) when there isn't.
    const nav = this.deps.nav;
    let p = nav.findPathFor(this, this.pos, to, LONG_SEARCH, OBSTACLES.length ? this.team : undefined);
    if (!p && nav.lastTruncated) {
      // Asked (or the frame's search budget is spent): keep walking, update() asks again.
      const w = (this.pathWant ??= { to: v3(), asked: v3() });
      w.to.copy(to);
      w.asked.copy(to);
      return true;
    }
    this.pathWant = null;
    // A search that ran out of nodes would only run out again without the barricades:
    // retry only when the way was really blocked.
    if (!p && OBSTACLES.length) p = nav.findPath(this.pos, to);
    this.path = p;
    this.pathIndex = 0;
    return !!p;
  }

  /** Collect a path asked for in setPath; the goal moved meanwhile (> 2 m): ask again. */
  private pollPath(): void {
    const w = this.pathWant;
    if (!w) return;
    const nav = this.deps.nav;
    const p = nav.findPathFor(this, this.pos, w.asked, LONG_SEARCH, OBSTACLES.length ? this.team : undefined);
    if (!p && nav.lastTruncated) return;
    this.pathWant = null;
    if (w.to.distanceToSquared(w.asked) > 4) {
      this.askPath(w.to);
      return;
    }
    this.path = p ?? (OBSTACLES.length ? nav.findPath(this.pos, w.asked) : null);
    this.pathIndex = 0;
  }

  /** Arrived (or no path): not while a path is still being worked out (that's no arrival). */
  get pathDone(): boolean {
    if (this.pathWant) return false;
    return !this.path || this.pathIndex >= this.path.length;
  }

  stop(): void {
    this.path = null;
    this.pathWant = null;
  }

  /** Steer toward `target` directly (formation following on the leader's trail). */
  steerTo(target: THREE.Vector3, speed: number): void {
    this.pathWant = null;
    // One persistent single-point path (no allocation every frame while following).
    this.steerPt.copy(target);
    this.path = this.steerPath;
    this.pathIndex = 0;
    this.moveSpeed = speed;
  }

  // ------------------------------------------------------------ frame

  /**
   * @param faceTarget world point to face/aim at (null = face movement)
   * @param aimMode 'low' (patrol carry), 'ready', 'aim'
   */
  update(dt: number, player: PlayerTarget, mates: Soldier[], faceTarget: THREE.Vector3 | null, aimMode: AimMode, wantFire: boolean): void {
    if (this.beam) {
      this.beam.visible = false;
      this.beamOn = false;
    }
    this.time += dt;
    this.pollPath();
    if (!this.alive) {
      this.body.update(dt, this.pose);
      return;
    }
    if (this.body.downed) {
      // Down: kneeling, slumped, weapon lowered; bleeding out until revived.
      this.body.tickDowned(dt);
      const p = this.pose;
      p.crouch = 1;
      p.strideAmount = 0;
      p.spineX = 0.6;
      p.headX = 0.35;
      p.spineY = 0;
      p.gripL = null;
      p.gripR = this.rig.rightHand;
      this.vel.set(0, 0, 0);
      this.aimNode.rotation.set(0.9, -0.4, 0);
      this.body.root.position.copy(this.pos);
      this.body.update(dt, p);
      this.flash.update(dt);
      return;
    }
    this.flinch = Math.max(0, this.flinch - dt * 1.4);
    this.move(dt, mates, player, faceTarget);

    // Stance: crouch smoothing; low-cover peeking is driven by the squad (crouchTarget).
    this.crouch += (this.crouchTarget - this.crouch) * Math.min(1, dt * 7);

    // IR strobe on the helmet blinks (shared material: whole squad blinks together).
    this.strobe = (this.time * 1.3) % 1;
    this.mats.strobe.emissiveIntensity = this.strobe < 0.05 ? 6 : 0;

    // Animation layer.
    const p = this.pose;
    p.idle = false;
    p.crouch = this.crouch * 0.85;
    // Leaning: quick in and out, like a player tapping Q / E.
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 7);
    p.lean = this.lean;
    p.stridePhase = this.stride;
    p.strideAmount = this.strideAmount;
    p.strideSide = this.strideSide;
    p.spineY = 0.32; // bladed stance: support shoulder forward
    p.spineX = aimMode === 'low' || aimMode === 'high' ? 0.04 : 0.1;
    const scan = this.state === 'patrol' ? Math.sin(this.time * 0.55 + this.index) * 0.45 : 0;
    p.headY = scan - 0.32; // face the target over the bladed torso
    p.headX = aimMode === 'aim' ? 0.18 : 0.05;
    // Standing around (not aiming): never a statue.
    const still = Math.hypot(this.vel.x, this.vel.z) < 0.3;
    let rollWant = 0;
    if (still && aimMode !== 'aim' && this.reloadTimer <= 0) {
      this.idleTime += dt;
      const t = this.idleTime;
      p.spineX += Math.sin(t * 1.7 + this.index) * 0.018; // breathing
      p.spineY += Math.sin(t * 0.37 + this.index * 2) * 0.07; // weight shift
      this.glanceTimer -= dt;
      if (this.glanceTimer <= 0) {
        this.glanceTimer = 1.5 + Math.random() * 3;
        this.glanceTarget = Math.random() < 0.35 ? 0 : (Math.random() * 2 - 1) * 0.75;
      }
      this.glance += (this.glanceTarget - this.glance) * Math.min(1, dt * 3);
      p.headY += this.glance;
      p.headX += Math.sin(t * 0.6 + this.index) * 0.05;
      // Now and then: tilt the gun and look it over.
      this.checkTimer -= dt;
      if (this.checkTimer <= 0) {
        this.checking = 1.6;
        this.checkTimer = 8 + Math.random() * 14;
      }
      if (this.checking > 0) {
        this.checking -= dt;
        rollWant = 0.55;
        p.headX += 0.25;
        p.headY = -0.2;
      }
    } else {
      this.checking = 0;
      // On the move: a body that walks, not a mannequin sliding. Shoulders counter the
      // hips each step, the head nods with the footfalls, a lean into a run, and eyes
      // that check the sides when there's nothing to aim at.
      const sa = Math.min(1.25, this.strideAmount);
      p.spineY += Math.sin(this.stride) * 0.09 * sa * (aimMode === 'aim' ? 0.25 : 1);
      p.spineX += 0.07 * Math.max(0, sa - 0.75);
      p.headX += Math.sin(this.stride * 2) * 0.035 * sa;
      if (aimMode !== 'aim') {
        this.glanceTimer -= dt;
        if (this.glanceTimer <= 0) {
          this.glanceTimer = 1.2 + Math.random() * 2.5;
          this.glanceTarget = Math.random() < 0.5 ? 0 : (Math.random() * 2 - 1) * 0.6;
        }
        this.glance += (this.glanceTarget - this.glance) * Math.min(1, dt * 3);
        p.headY += this.glance;
      } else this.glance *= 1 - Math.min(1, dt * 6);
    }
    this.roll += (rollWant - this.roll) * Math.min(1, dt * 5);
    p.gripR = this.rig.rightHand;
    const reloading = this.reloadTimer > 0;
    const rk = reloading ? 1 - this.reloadTimer / this.reloadTime : 0;
    const handOff = reloading && rk > 0.2 && rk < 0.62;
    p.gripL = handOff ? this.reloadHand : this.rig.mag && reloading && rk > 0.1 && rk < 0.8 ? this.rig.mag : this.rig.leftHand;
    if (this.rig.mag) this.rig.mag.visible = !(reloading && rk > 0.25 && rk < 0.6);

    this.aim(dt, faceTarget, aimMode, player);
    this.body.root.position.copy(this.pos);
    this.body.root.position.y += this.hopY;
    this.body.root.rotation.y = this.yaw;
    this.body.update(dt, p);
    this.updateBeam();

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
    if (this.avoid) {
      const dx = this.pos.x - this.avoid.x;
      const dz = this.pos.z - this.avoid.z;
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
    // A barricade in the way: stop, and after a moment start breaching it.
    const wall = OBSTACLES.length ? obstacleAt(nx, nz, 0.35, this.team) : null;
    if (wall) {
      this.vel.set(0, 0, 0);
      this.breach += dt;
      if (this.breach > 0.8) wall.damage(90 * dt);
    } else this.breach = 0;
    // Never step into solid cells (slide along the free axis instead).
    if (wall) {
      // held at the barricade
    } else if (this.deps.nav.walkable(nx, nz)) this.pos.set(nx, 0, nz);
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

    // Walk cycle: phase advances with distance over what the legs sweep (feet don't skate);
    // sideways share from local velocity.
    this.stride += (v * dt * Math.PI * 2) / strideLength(this.strideAmount);
    // A footfall every half stride: gear rustle (only heard up close).
    const step = Math.floor(this.stride / Math.PI);
    if (step !== this.lastStep) {
      this.lastStep = step;
      if (v > 0.8) {
        this.deps.audio.play('foley.step', { position: this.pos, volume: (v > 3 ? 0.6 : v > 1.8 ? 0.35 : 0.2) * (0.8 + Math.random() * 0.4) });
        aiWorld.emit(v > 3 ? 'sprint' : 'step', this.pos, this.team, this, this.crouch > 0.5 ? 0.4 : v > 1.8 ? 1 : 0.7);
      }
    }
    this.strideAmount += (clamp(v / 1.6, 0, v > 3 ? 1.25 : 1) - this.strideAmount) * Math.min(1, dt * 8);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const side = v > 0.1 ? (this.vel.x * cos - this.vel.z * sin) / v : 0;
    this.strideSide += (side - this.strideSide) * Math.min(1, dt * 6);
  }

  private aim(dt: number, faceTarget: THREE.Vector3 | null, mode: AimMode, player: PlayerTarget): void {
    let yaw: number;
    let pitch: number;
    if (mode === 'high') {
      // High port: muzzle up, gun diagonal across the chest (moving fast, ready to snap down).
      yaw = -0.85;
      pitch = 0.88;
    } else if (mode === 'low' || !faceTarget) {
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
        const sigma = ((1.0 + 0.03 * dist) * settle * (moving ? 1.7 : 1) * (1 + this.flinch * 2) * DEG) / Math.max(0.2, feel.enemyAccuracy * this.skill);
        yaw += this.errNoise.sample(this.time * 0.9) * sigma * 1.9;
        pitch += this.errNoise2.sample(this.time * 0.9) * sigma * 1.1;
      }
    }
    const rate = (mode === 'aim' ? 4 : mode === 'high' || mode === 'low' ? 4.5 : 2.5) * dt;
    this.aimYaw += clamp(yaw - this.aimYaw, -rate, rate);
    this.aimPitch += clamp(pitch - this.aimPitch, -rate, rate);
    this.recoilPitch.update(dt);
    this.recoilYaw.update(dt);
    // The body's own lean (crouch, spine) is part of the parent chain.
    // Cancel the animated spine lean (not the hit reactions: those throw the aim off).
    const lean = (mode === 'low' || mode === 'high' ? 0.04 : 0.1) + this.crouch * 0.85 * 0.18;
    // The gun rides the gait: a bob per footfall and a sway per stride (steadied when aiming).
    const sa = Math.min(1.25, this.strideAmount) * (mode === 'aim' ? 0.3 : 1);
    const bobP = Math.sin(this.stride * 2) * 0.035 * sa;
    const bobY = Math.sin(this.stride) * 0.05 * sa;
    this.aimNode.rotation.set(-(this.aimPitch + this.recoilPitch.value) - lean + bobP, this.aimYaw + this.recoilYaw.value + bobY, -this.lean * LEAN_ROLL);
    if (this.rifleRoot.parent === this.aimNode) this.rifleRoot.rotation.z = this.roll + bobY * 0.6 + this.lean * LEAN_ROLL * 0.6;
    // Where the gun sits in the hands. Handguns: two-handed out in front to aim
    // (centred under the eyes), compressed at the chest at the ready, low while
    // running. Long guns stay shouldered (the holder origin is the shoulder pocket).
    if (this.pistol) {
      if (mode === 'aim') this.holdWant.set(-0.1, 0.06, 0.34);
      else if (mode === 'ready') this.holdWant.set(-0.08, -0.08, 0.2);
      else if (mode === 'high') this.holdWant.set(-0.1, 0.02, 0.14);
      else this.holdWant.set(-0.06, -0.2, 0.12);
    } else if (mode === 'high') this.holdWant.set(-0.06, -0.2, 0.14);
    else this.holdWant.set(0, 0, 0);
    this.hold.lerp(this.holdWant, Math.min(1, dt * 9));
    if (this.rifleRoot.parent === this.aimNode) this.rifleRoot.position.copy(this.hold);
  }

  // ------------------------------------------------------------ weapon

  /** Reaction delay before the first shot after acquiring the target. */
  onAcquire(): void {
    this.reactionTimer = 0.55 + Math.random() * 0.45;
  }

  /** The brain sets the reaction delay (expected contacts are fast, surprises slow). */
  react(seconds: number): void {
    this.reactionTimer = seconds;
  }

  /** Aim settle: how long the target counts as already tracked (tighter first shots). */
  settle(seconds: number): void {
    this.visibleTime = seconds;
  }

  /** Ammo cache: full spare rounds again. */
  refillReserve(): void {
    this.reserve = this.maxReserve;
  }

  startReload(): boolean {
    if (this.reloadTimer > 0 || this.ammo === this.magSize) return false;
    if (this.reserve <= 0) {
      if (this.ammo <= 0) this.onDry?.();
      return false;
    }
    this.reloadTimer = this.reloadTime;
    this.burstLeft = 0;
    this.deps.audio.play('reload.rifle.magout', { position: this.pos, volume: 0.6 });
    aiWorld.emit('reload', this.pos, this.team, this);
    return true;
  }

  private weapon(dt: number, player: PlayerTarget, mates: Soldier[], wantFire: boolean): void {
    if (this.reloadTimer > 0) {
      const before = this.reloadTimer;
      this.reloadTimer -= dt;
      if (before > this.reloadTime * 0.45 && this.reloadTimer <= this.reloadTime * 0.45) this.deps.audio.play('reload.rifle.magin', { position: this.pos, volume: 0.7 });
      if (this.reloadTimer <= 0) {
        const take = Math.min(this.magSize - this.ammo, this.reserve);
        this.ammo += take;
        this.reserve -= take;
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
      const base = this.semi ? 1 : dist > 35 ? 1 + ((Math.random() * 2) | 0) : dist > 15 ? 2 + ((Math.random() * 2) | 0) : 3 + ((Math.random() * 3) | 0);
      this.burstLeft = Math.max(1, Math.round(base * (dist > 15 ? this.burstScale : 1)));
    }
    // Muzzle and bore.
    this.rig.muzzle.getWorldPosition(this.muzzle);
    this.rifleRoot.getWorldQuaternion(this.q);
    this.dir.set(0, 0, 1).applyQuaternion(this.q);
    // Don't shoot through a squadmate (or the friendly player): a narrow lane check.
    const range = this.muzzle.distanceTo(player.chest);
    for (const m of mates) {
      if (m === this || !m.alive) continue;
      const to = this.tmp.subVectors(m.chestPos, this.muzzle);
      const along = to.dot(this.dir);
      if (along > 0 && along < range && to.addScaledVector(this.dir, -along).length() < 0.6) {
        this.burstLeft = 0;
        this.burstPause = this.time + 0.4;
        return;
      }
    }
    if (this.avoid) {
      const to = this.tmp.set(this.avoid.x - this.muzzle.x, this.avoid.y + 1.3 - this.muzzle.y, this.avoid.z - this.muzzle.z);
      const along = to.dot(this.dir);
      if (along > 0 && along < range && to.addScaledVector(this.dir, -along).length() < 0.7) {
        this.burstLeft = 0;
        this.burstPause = this.time + 0.35;
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
    this.nextShot = this.time + this.fireInterval * (0.95 + Math.random() * 0.1);
    if (this.burstLeft <= 0) this.burstPause = this.time + (this.semi ? 0.25 + Math.random() * 0.35 : 0.6 + Math.random() * 0.9);
    const tracer = this.team === 'bd' && this.ammo % 4 === 0;
    // Any team but the player's can hit the player; the player's team never gives hit markers.
    const hostile = this.team !== 'alpha';
    const ally = this.team === 'alpha';
    const spread = Math.tan(this.pelletSpread * DEG);
    for (let i = 0; i < this.pellets; i++) {
      const d = i === 0 ? this.dir : this.tmp2.copy(this.dir).add(this.tmp.set(gauss() * spread, gauss() * spread, gauss() * spread)).normalize();
      this.deps.projectiles.fire(this.muzzle, d, this.ammoData.muzzleVelocity * (0.985 + Math.random() * 0.03), this.ammoData, 0, tracer && i === 0, i < 2, this, hostile, ally, this.team);
    }
    this.deps.audio.play(this.fireSound, { position: this.muzzle });
    aiWorld.emit(this.suppressed ? 'gunshot_sup' : 'gunshot', this.muzzle, this.team, this);
    this.recoilPitch.impulse(0.55 + Math.random() * 0.3);
    this.recoilYaw.impulse((Math.random() - 0.5) * 0.5);
    // What only shows: the flash, the light, smoke and brass. Out of sight (a room the
    // portal culling doesn't draw) they'd cost particles, a muzzle light from the pool
    // and physics bodies for casings nobody sees.
    if (!this.body.root.visible) return;
    this.flash.trigger(1.3 * (1 + 0.15 * ((this.deps.muzzleLights?.boost ?? 1) - 1)));
    if (this.deps.muzzleLights) this.deps.muzzleLights.flash(this.muzzle, this.deps.listener ?? this.muzzle);
    this.deps.impacts.muzzleBlast(this.muzzle, this.dir, 1.1);
    this.deps.impacts.muzzleSmoke(this.muzzle, this.dir, 0.6);
    // Brass out to the right.
    this.rig.ejectPort.getWorldPosition(this.tmp);
    this.tmp2.set(2.2, 1.5, 0.3).applyQuaternion(this.q).add(this.vel);
    this.deps.shells.eject('rifle', this.tmp, this.tmp2, this.q);
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
