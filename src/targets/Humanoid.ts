import * as THREE from 'three';
import { RAPIER, GROUPS, type BulletHit, type HitResult, type Physics, type SurfaceType } from '../core/Physics';
import { Spring, Spring3 } from '../core/Spring';
import { clamp, DEG } from '../core/math';
import { feel } from '../config/Feel';
import { MeshBuilder } from '../world/MeshBuilder';
import { Damageable } from './Damageable';

export type PartName = 'pelvis' | 'torso' | 'head' | 'upperArmL' | 'upperArmR' | 'foreArmL' | 'foreArmR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';
export type HitZone = 'head' | 'thorax' | 'stomach' | 'arm' | 'leg';
type V3 = [number, number, number];

export interface ColliderDef {
  half: V3;
  center: V3;
  mass: number;
  zone: HitZone;
  surface?: SurfaceType;
  /** Armor class as a penetration rating (plates ~40, helmets ~30). */
  armor?: number;
}

export interface PartDef {
  name: PartName;
  parent: PartName | null;
  /** Joint position in the parent's space (the part's pivot). */
  pos: V3;
  side: -1 | 0 | 1;
  build(b: MeshBuilder): void;
  colliders: ColliderDef[];
}

/** Everything that makes one kind of humanoid look and take damage differently. */
export interface HumanoidSkin {
  parts: PartDef[];
  /** Shin pivot → sole. */
  shinLength: number;
  /** Forearm pivot → palm (IK grip point), in forearm space. */
  handGrip: V3;
  health: number;
  zoneDamage: Record<HitZone, number>;
  /** Head damage multiplier (default: the round's crit multiplier). */
  headMultiplier?: number;
  /** Fraction of damage that still gets through a plate/helmet that stopped the round. */
  bluntFactor?: number;
  idleKnee?: number;
}

export interface Part {
  name: PartName;
  side: -1 | 0 | 1;
  parent: Part | null;
  group: THREE.Group;
  debris: THREE.Group;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  worldPos: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  prevVy: number;
}

export interface DamageInfo {
  hit: BulletHit;
  part: Part;
  zone: HitZone;
  damage: number;
  /** Armor stopped the round (blunt damage only). */
  blocked: boolean;
  surface: SurfaceType;
  killed: boolean;
}

export interface HumanoidHooks {
  onDamage?(info: DamageInfo): void;
  onDeath?(info: DamageInfo): void;
  /** A ragdoll part slammed into something. strength 0..1. */
  onThud?(at: THREE.Vector3, strength: number): void;
  onStagger?(at: THREE.Vector3, strength: number): void;
}

/** Animation layer supplied by the owner every frame; reactions are added on top. */
export interface HumanoidPose {
  /** 0 = standing, 1 = deep crouch. */
  crouch: number;
  /** Walk cycle: phase (radians), amount 0..1, sideways share -1..1. */
  stridePhase: number;
  strideAmount: number;
  strideSide: number;
  spineX: number;
  spineY: number;
  headX: number;
  headY: number;
  /** Hand targets (objects anywhere under the torso), or null for free-hanging arms. */
  gripL: THREE.Object3D | null;
  gripR: THREE.Object3D | null;
  /** Idle breathing / look-around (dummies). */
  idle: boolean;
  /** Free-arm pitch per arm (negative = forward/up), elbow bend. Ignored with grips. */
  armL: number;
  armR: number;
  elbows: number;
}

export const defaultPose = (): HumanoidPose => ({
  crouch: 0, stridePhase: 0, strideAmount: 0, strideSide: 0, spineX: 0, spineY: 0, headX: 0, headY: 0, gripL: null, gripR: null, idle: true,
  armL: 0, armR: 0, elbows: 0,
});

const MAX_TILT = 24 * DEG;

/**
 * A physical humanoid body shared by robots and soldiers.
 *
 * - Alive: every part is a kinematic hitbox that follows the animated pose (what
 *   you see is what you hit). Zones: head, thorax, stomach, arms, legs, with
 *   optional armor per collider. Hits drive layered spring reactions sized by
 *   the round's momentum — head snap, chest stagger, gut fold, arm throw, knee
 *   buckle, step back — and repeated hits build stagger.
 * - Dead: the same bodies turn dynamic and are jointed into a ragdoll that
 *   inherits the animated velocity plus the killing round's momentum at the
 *   exact hit point; the knees buckle as it drops.
 *
 * The owner positions `root`, feeds a HumanoidPose each frame and decides what
 * damage means (AI alerts, respawn...).
 */
export class Humanoid {
  readonly root = new THREE.Group();
  readonly health: Damageable;
  readonly parts: Part[] = [];
  private byName = new Map<PartName, Part>();
  private pivot = new THREE.Group();
  private joints: RAPIER.ImpulseJoint[] = [];
  private knees: RAPIER.RevoluteImpulseJoint[] = [];

  // Leg geometry, read from the skin.
  private thigh: number;
  private shin: number;
  private hipHalf: number;
  private hipOffset: number;
  private idleKnee: number;
  private upperLen: number;
  private gripLocal: THREE.Vector3;

  // --- Reaction springs (radians / metres) ---
  private tiltX = new Spring(60, 7);
  private tiltZ = new Spring(60, 7);
  private bodyYaw = new Spring(70, 8);
  private step = new Spring3(30, 9);
  private spineX = new Spring(140, 11);
  private spineY = new Spring(120, 10);
  private spineZ = new Spring(140, 11);
  private headX = new Spring(190, 12);
  private headY = new Spring(160, 11);
  private headZ = new Spring(190, 12);
  private armX = [new Spring(110, 7), new Spring(110, 7)];
  private armZ = [new Spring(110, 7), new Spring(110, 7)];
  private elbow = [new Spring(120, 9), new Spring(120, 9)];
  private knee = [new Spring(90, 10), new Spring(90, 10)];
  readonly rise = new Spring(130, 11);

  /** On the player's side: rounds from the player and allies pass harmlessly. */
  friendly = false;
  /** Accumulated stagger (0..2): bigger reactions, unsteady sway. */
  stagger = 0;
  private kneelTimer = [0, 0];
  private legWound = [0, 0];
  private time = Math.random() * 100;
  private ragdollTime = 0;
  private thudCooldown = 0;
  private teleport = true;
  private inv = new THREE.Quaternion();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private info: DamageInfo = {
    hit: null as unknown as BulletHit, part: null as unknown as Part, zone: 'thorax', damage: 0, blocked: false, surface: 'robot', killed: false,
  };

  constructor(
    private physics: Physics,
    scene: THREE.Object3D,
    readonly skin: HumanoidSkin,
    private hooks: HumanoidHooks,
    /** Bullets fired by the owner ignore these hitboxes. */
    readonly owner: object,
  ) {
    this.health = new Damageable(skin.health);
    this.root.add(this.pivot);
    scene.add(this.root);
    for (const def of skin.parts) this.buildPart(def, scene);

    const thigh = this.part('thighR').group.position;
    this.hipHalf = Math.abs(thigh.x);
    this.hipOffset = -thigh.y;
    this.thigh = -this.part('shinR').group.position.y;
    this.shin = skin.shinLength;
    this.idleKnee = skin.idleKnee ?? 0.1;
    this.upperLen = this.part('foreArmR').group.position.length();
    this.gripLocal = new THREE.Vector3(...skin.handGrip);
    this.root.updateMatrixWorld(true);
  }

  get alive(): boolean {
    return this.health.alive;
  }

  part(name: PartName): Part {
    return this.byName.get(name)!;
  }

  private buildPart(def: PartDef, scene: THREE.Object3D): void {
    const parent = def.parent ? this.part(def.parent) : null;
    const group = new THREE.Group();
    group.position.set(...def.pos);
    (parent ? parent.group : this.pivot).add(group);
    const b = new MeshBuilder();
    def.build(b);
    b.build(group, { castShadow: true, receiveShadow: true });
    // Cloned before any child part is attached, so the debris holds only this part.
    const debris = group.clone(true);
    debris.position.set(0, 0, 0);
    debris.rotation.set(0, 0, 0);
    debris.visible = false;
    scene.add(debris);

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setLinearDamping(0.08).setAngularDamping(1.1).setCcdEnabled(true),
    );
    const part: Part = {
      name: def.name, side: def.side, parent, group, debris, body, colliders: [],
      worldPos: new THREE.Vector3(), worldQuat: new THREE.Quaternion(), prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), prevVy: 0,
    };
    for (const c of def.colliders) {
      const col = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...c.half)
          .setTranslation(...c.center)
          .setMass(c.mass)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setCollisionGroups(GROUPS.hitbox),
        body,
      );
      part.colliders.push(col);
      const surface = c.surface ?? (c.zone === 'head' ? 'robotWeak' : 'robot');
      this.physics.register(col, {
        surface,
        body,
        owner: this.owner,
        allowDecals: false,
        impulseScale: 3,
        onBulletHit: (h, o) => this.onHit(h, part, c, surface, o),
      });
    }
    this.physics.addSynced(body, debris);
    this.parts.push(part);
    this.byName.set(def.name, part);
  }

  // ---------------------------------------------------------------- hits

  private onHit(hit: BulletHit, part: Part, col: ColliderDef, surface: SurfaceType, out: HitResult): void {
    if (!this.alive) return;
    if (this.friendly && !hit.hostile) return;
    const zone = col.zone;
    const head = zone === 'head';
    let mult = head ? (this.skin.headMultiplier ?? hit.critMultiplier) : this.skin.zoneDamage[zone];
    // Armor: penetration rating vs armor class decides whether the round gets through.
    let blocked = false;
    if (col.armor) {
      const chance = clamp((hit.penetration - col.armor + 15) / 25, 0.02, 0.97);
      if (Math.random() > chance) {
        blocked = true;
        // Blunt trauma only (a stopped round to the helmet is not a headshot).
        mult = head ? 0.35 : mult * (this.skin.bluntFactor ?? 0.3);
      }
    }
    const dmg = hit.damage * mult;
    this.health.applyDamage(dmg);
    out.damage = dmg;
    out.crit = head && !blocked;
    out.health = this.health.health;
    out.maxHealth = this.health.maxHealth;

    const info = this.info;
    info.hit = hit;
    info.part = part;
    info.zone = zone;
    info.damage = dmg;
    info.blocked = blocked;
    info.surface = surface;
    info.killed = !this.alive;
    if (!this.alive) {
      out.killed = true;
      this.die(hit, part, zone);
      this.hooks.onDeath?.(info);
      return;
    }
    this.react(hit, part, zone, dmg);
    this.hooks.onDamage?.(info);
  }

  /** Melee blow (rogue robot swing): body damage + a hard shove. */
  meleeHit(damage: number, from: THREE.Vector3, impulse = 1.8): void {
    if (!this.alive) return;
    const torso = this.part('torso');
    torso.group.getWorldPosition(this.tmp);
    const dir = this.tmp2.copy(this.tmp).sub(from).setY(0).normalize();
    const hit: BulletHit = {
      point: this.tmp.clone(), normal: dir.clone().negate(), direction: dir.clone(), distance: 1, damage, impulse,
      critMultiplier: 1, weaponId: 'melee', penetration: 0, hostile: true, ally: false,
    };
    this.health.applyDamage(damage);
    const info = this.info;
    info.hit = hit;
    info.part = torso;
    info.zone = 'thorax';
    info.damage = damage;
    info.blocked = false;
    info.surface = 'flesh';
    info.killed = !this.alive;
    if (!this.alive) {
      this.die(hit, torso, 'thorax');
      this.hooks.onDeath?.(info);
      return;
    }
    this.react(hit, torso, 'thorax', damage);
    this.hooks.onDamage?.(info);
  }

  /** Living hit reaction: zone-specific spring impulses scaled by the round's momentum. */
  private react(hit: BulletHit, part: Part, zone: HitZone, dmg: number): void {
    // Bullet direction and hit point in body space (facing +Z: shots from the front
    // travel along -Z and push the top of the body backward = negative X rotation).
    this.inv.copy(this.root.quaternion).invert();
    const d = this.tmp.copy(hit.direction).applyQuaternion(this.inv);
    const p = this.tmp2.copy(hit.point).sub(this.root.position).applyQuaternion(this.inv);
    const s = Math.min(4, hit.impulse * feel.hitReactionScale) * (1 + 0.45 * Math.min(1, this.stagger));
    const torque = p.z * d.x - p.x * d.z; // yaw: the struck side is driven away
    const i = part.side > 0 ? 1 : 0;

    // Whole body: lean away from the round, heavy rounds knock it back a step.
    const bodyK = zone === 'arm' ? 0.5 : zone === 'leg' ? 0.6 : 1;
    this.tiltX.impulse(d.z * s * 1.1 * bodyK);
    this.tiltZ.impulse(-d.x * s * 1.1 * bodyK);
    this.bodyYaw.impulse(torque * s * 1.6);
    const push = 0.18 * s + Math.max(0, s - 1.6) * 0.75;
    this.step.impulse(d.x * push, 0, d.z * push);

    switch (zone) {
      case 'head':
        this.headX.impulse(d.z * s * 9);
        this.headZ.impulse(-d.x * s * 6);
        this.headY.impulse(torque * s * 10);
        this.spineX.impulse(d.z * s * 1.8);
        this.armX[0].impulse(d.z * s * 1.5);
        this.armX[1].impulse(d.z * s * 1.5);
        break;
      case 'thorax':
        this.spineX.impulse(d.z * s * 2.4);
        this.spineZ.impulse(-d.x * s * 1.6);
        this.spineY.impulse(torque * s * 8);
        this.headX.impulse(-d.z * s * 1.5); // whiplash: head lags behind the chest
        this.armX[0].impulse(d.z * s * 2);
        this.armX[1].impulse(d.z * s * 2);
        this.elbow[0].impulse(s * 1.2);
        this.elbow[1].impulse(s * 1.2);
        break;
      case 'stomach':
        // Gut shot: folds forward around the hit, knees give a little.
        this.spineX.impulse(s * 2.6 + d.z * s * 0.5);
        this.spineY.impulse(torque * s * 5);
        this.headX.impulse(s * 2);
        this.knee[0].impulse(s * 1.4);
        this.knee[1].impulse(s * 1.4);
        this.elbow[0].impulse(s * 2.5);
        this.elbow[1].impulse(s * 2.5);
        break;
      case 'arm':
        this.armX[i].impulse(-d.z * s * 7);
        this.armZ[i].impulse(d.x * s * 5 + part.side * s * 2);
        this.elbow[i].impulse(s * (part.name.startsWith('fore') ? -3 : 3));
        this.spineY.impulse(torque * s * 12);
        this.spineZ.impulse(-d.x * s * 0.8);
        break;
      case 'leg':
        // Leg buckles; heavy rounds drop the body onto that knee for a moment.
        this.knee[i].impulse(s * 3.8);
        this.knee[1 - i].impulse(s * 1.2);
        this.tiltZ.impulse(-part.side * s * 0.6);
        this.spineX.impulse(s * 1.2);
        this.legWound[i] = Math.min(1, this.legWound[i] + dmg / 90);
        if (s > 1.4 || this.legWound[i] > 0.6) this.kneelTimer[i] = 0.35 + 0.18 * s;
        break;
    }

    const before = this.stagger;
    this.stagger = Math.min(2, this.stagger + 0.22 * s);
    if (s > 2.2 || (before < 1 && this.stagger >= 1)) {
      this.part('torso').group.getWorldPosition(this.tmp);
      this.hooks.onStagger?.(this.tmp, Math.min(1, s / 3));
    }
  }

  // ---------------------------------------------------------------- death

  private die(hit: BulletHit, struck: Part, zone: HitZone): void {
    this.root.updateMatrixWorld(true);
    for (const part of this.parts) {
      part.group.getWorldPosition(part.worldPos);
      part.group.getWorldQuaternion(part.worldQuat);
      const b = part.body;
      b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      b.setTranslation(part.worldPos, true);
      b.setRotation(part.worldQuat, true);
      part.vel.clampLength(0, 6);
      b.setLinvel(part.vel, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      for (const c of part.colliders) c.setCollisionGroups(GROUPS.ragdoll);
      part.debris.position.copy(part.worldPos);
      part.debris.quaternion.copy(part.worldQuat);
      part.debris.visible = true;
      part.prevVy = 0;
    }
    this.pivot.visible = false;
    this.buildJoints(zone === 'head');

    // The killing round: its momentum at the exact hit point, plus a whole-body shove
    // so heavy rounds visibly carry the body (Mosin/Kar98 more than a 5.56).
    const momentum = (hit.impulse / 0.18) * feel.ragdollForce;
    const dir = hit.direction;
    struck.body.applyImpulseAtPoint(
      { x: dir.x * momentum * 1.5, y: dir.y * momentum * 1.5, z: dir.z * momentum * 1.5 },
      hit.point,
      true,
    );
    const shove = Math.min(2.4, momentum * 0.075);
    for (const part of this.parts) {
      const m = part.body.mass();
      const lift = part.name === 'head' || part.name === 'torso' ? 0.25 : 0;
      part.body.applyImpulse({ x: dir.x * shove * m, y: lift * shove * m, z: dir.z * shove * m }, true);
    }
    if (zone === 'head') {
      // Head snaps back and drags the upper body with it: falls backward.
      const k = momentum * 0.9;
      this.part('head').body.applyImpulse({ x: dir.x * k, y: k * 0.35, z: dir.z * k }, true);
      this.part('torso').body.applyImpulse({ x: dir.x * k * 0.8, y: 0, z: dir.z * k * 0.8 }, true);
    }
    this.ragdollTime = 0;
  }

  private buildJoints(headshot: boolean): void {
    const world = this.physics.world;
    const link = (parentName: PartName, childName: PartName, data: RAPIER.JointData) => {
      const j = world.createImpulseJoint(data, this.part(parentName).body, this.part(childName).body, true);
      j.setContactsEnabled(false);
      this.joints.push(j);
      return j;
    };
    // Anchor on the parent = the child's rest offset; anchor on the child = its origin (the pivot).
    const anchor = (child: PartName) => {
      const p = this.part(child).group.position;
      return { x: p.x, y: p.y, z: p.z };
    };
    const ZERO = { x: 0, y: 0, z: 0 };
    const X_AXIS = { x: 1, y: 0, z: 0 };
    const ball = (parent: PartName, child: PartName, tone: number, damping: number) => {
      const j = link(parent, child, RAPIER.JointData.spherical(anchor(child), ZERO));
      // The JS wrapper's SphericalImpulseJoint lacks the per-axis motor methods its
      // typings declare; the raw joint set has them.
      const raw = (j as unknown as { rawSet: { jointConfigureMotorPosition(h: number, axis: number, pos: number, k: number, c: number): void } }).rawSet;
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        raw.jointConfigureMotorPosition(j.handle, axis, 0, tone, damping);
      }
    };

    // Spherical joints with "muscle tone" everywhere the living pose can twist;
    // hinge knees (with limits) so legs fold the right way.
    ball('pelvis', 'torso', 10, 3);
    ball('torso', 'head', 8, 2);
    for (const s of ['L', 'R'] as const) {
      ball('torso', `upperArm${s}`, 2, 1.2);
      ball(`upperArm${s}`, `foreArm${s}`, 3, 1);
      ball('pelvis', `thigh${s}`, 6, 2);
      const knee = link(`thigh${s}`, `shin${s}`, RAPIER.JointData.revolute(anchor(`shin${s}`), ZERO, X_AXIS)) as RAPIER.RevoluteImpulseJoint;
      knee.setLimits(0, 2.5);
      // Death collapse: knees buckle under the body for a moment (limp on a headshot).
      knee.configureMotorPosition(1.7, headshot ? 25 : 55, 6);
      this.knees.push(knee);
    }
  }

  private removeJoints(): void {
    for (const j of this.joints) this.physics.world.removeImpulseJoint(j, true);
    this.joints.length = 0;
    this.knees.length = 0;
  }

  /**
   * Pooling: an inactive body is invisible and has no colliders (no hits, no
   * blocking). Reactivate with reset().
   */
  setActive(active: boolean): void {
    this.root.visible = active;
    for (const part of this.parts) {
      for (const c of part.colliders) c.setEnabled(active);
      if (!active) {
        part.debris.visible = false;
        part.body.setEnabled(false);
      } else part.body.setEnabled(true);
    }
    if (!active) this.removeJoints();
  }

  /** Phones: many bodies in the shadow pass get expensive. */
  setCastShadow(cast: boolean): void {
    this.root.traverse((o) => (o.castShadow = cast));
    for (const p of this.parts) p.debris.traverse((o) => (o.castShadow = cast));
  }

  /** Back to a living, standing body at the root's current transform. */
  reset(fromFloor: boolean): void {
    this.removeJoints();
    for (const part of this.parts) {
      part.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      part.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      for (const c of part.colliders) c.setCollisionGroups(GROUPS.hitbox);
      part.debris.visible = false;
    }
    this.health.reset();
    this.pivot.visible = true;
    for (const s of [this.tiltX, this.tiltZ, this.bodyYaw, this.spineX, this.spineY, this.spineZ, this.headX, this.headY, this.headZ, ...this.armX, ...this.armZ, ...this.elbow, ...this.knee]) {
      s.reset();
    }
    this.step.reset();
    this.stagger = 0;
    this.kneelTimer[0] = this.kneelTimer[1] = 0;
    this.legWound[0] = this.legWound[1] = 0;
    this.rise.reset(0);
    // Pop up out of the floor with a little overshoot.
    if (fromFloor) this.rise.value = -1.9;
    this.teleport = true;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, pose: HumanoidPose): void {
    if (!this.alive) {
      this.updateRagdoll(dt);
      return;
    }
    this.updatePose(dt, pose);
    this.updateHitboxes(dt);
  }

  /** Current world-space knee/hip offset caused by reactions (AI aim disruption). */
  get reactionMagnitude(): number {
    return Math.abs(this.spineX.value) + Math.abs(this.spineY.value) + Math.abs(this.tiltX.value) + Math.abs(this.tiltZ.value);
  }

  private updatePose(dt: number, pose: HumanoidPose): void {
    this.time += dt;
    const t = this.time;
    this.stagger = Math.max(0, this.stagger - dt * 0.65);
    const wobble = Math.min(1, this.stagger);
    const hurt = 1 - this.health.health / this.health.maxHealth;
    const idle = pose.idle ? 1 : 0;

    // Targets: idle breathing, a hunch when hurt, unsteady sway while staggered,
    // a limp toward a wounded leg.
    this.tiltX.target = Math.sin(t * 2.3) * 0.05 * wobble;
    this.tiltZ.target = Math.sin(t * 1.7 + 1) * 0.06 * wobble + (this.legWound[0] - this.legWound[1]) * 0.05;
    this.spineX.target = Math.sin(t * 1.6) * 0.015 * idle + hurt * 0.12 + wobble * 0.08;
    this.headX.target = Math.sin(t * 0.7) * 0.03 * idle + hurt * 0.08;
    this.headY.target = Math.sin(t * 0.45 + 2) * 0.12 * idle;
    for (let i = 0; i < 2; i++) {
      this.kneelTimer[i] = Math.max(0, this.kneelTimer[i] - dt);
      this.legWound[i] = Math.max(0, this.legWound[i] - dt * 0.04);
      const kneel = this.kneelTimer[i] > 0 ? 0.62 : 0;
      const other = this.kneelTimer[1 - i] > 0 ? 0.3 : 0;
      this.knee[i].target = Math.max(kneel, other) + this.legWound[i] * 0.18 + wobble * 0.12;
    }

    const spring = (s: Spring, lo: number, hi: number) => {
      s.update(dt);
      if (s.value < lo || s.value > hi) {
        s.value = clamp(s.value, lo, hi);
        s.velocity *= -0.25;
      }
      return s.value;
    };
    const tiltX = spring(this.tiltX, -MAX_TILT, MAX_TILT);
    const tiltZ = spring(this.tiltZ, -MAX_TILT, MAX_TILT);
    const yaw = spring(this.bodyYaw, -0.6, 0.6);
    const step = this.step.update(dt);
    const rise = this.rise.update(dt);
    const spineX = spring(this.spineX, -0.5, 0.75);
    const spineY = spring(this.spineY, -0.7, 0.7);
    const spineZ = spring(this.spineZ, -0.4, 0.4);
    const headX = spring(this.headX, -0.8, 0.6);
    const headY = spring(this.headY, -0.8, 0.8);
    const headZ = spring(this.headZ, -0.5, 0.5);

    this.pivot.position.set(clamp(step.x, -0.5, 0.5), rise, clamp(step.z, -0.5, 0.5));
    this.pivot.rotation.set(tiltX, yaw, tiltZ);

    // Legs: two-bone knee bend (crouch + reactions), walk cycle on top; the pelvis
    // height follows the legs so the feet stay near the floor.
    const crouchTheta = pose.crouch * 0.95;
    const stride = pose.strideAmount;
    const theta = [0, 0];
    const height = [0, 0];
    for (let i = 0; i < 2; i++) {
      theta[i] = this.idleKnee + crouchTheta + spring(this.knee[i], 0, 1.1);
      height[i] = (this.thigh + this.shin) * Math.cos(theta[i]);
    }
    const roll = clamp(Math.atan2(height[1] - height[0], this.hipHalf * 2), -0.25, 0.25);
    const pelvis = this.part('pelvis').group;
    const bob = stride * 0.035 * (1 - Math.abs(Math.cos(pose.stridePhase)));
    pelvis.position.y = (height[0] + height[1]) * 0.5 + this.hipOffset - bob;
    pelvis.rotation.set(0, Math.sin(pose.stridePhase) * 0.08 * stride, roll);
    const fwd = 1 - Math.abs(pose.strideSide);
    for (let i = 0; i < 2; i++) {
      const s = i === 1 ? 'R' : 'L';
      const ph = pose.stridePhase + i * Math.PI;
      const swing = Math.sin(ph) * 0.42 * stride;
      const lift = Math.max(0, Math.cos(ph)) * 0.75 * stride;
      const abduct = Math.sin(ph) * 0.18 * stride * pose.strideSide;
      this.part(`thigh${s}`).group.rotation.set(-theta[i] - swing * fwd - lift * 0.35, 0, -roll + abduct);
      this.part(`shin${s}`).group.rotation.set(2 * theta[i] + lift, 0, 0);
    }

    const torso = this.part('torso').group;
    torso.rotation.set(spineX + pose.spineX + pose.crouch * 0.18, spineY + pose.spineY - pelvis.rotation.y, spineZ - roll * 0.6);
    this.part('head').group.rotation.set(headX + pose.headX, headY + pose.headY, headZ);

    for (let i = 0; i < 2; i++) {
      const side = i === 1 ? 1 : -1;
      const s = i === 1 ? 'R' : 'L';
      const ax = spring(this.armX[i], -1.3, 1.3) + Math.sin(t * 1.3 + i) * 0.02 * idle;
      const az = spring(this.armZ[i], -1, 1);
      const el = spring(this.elbow[i], -0.15, 1.6);
      const upper = this.part(`upperArm${s}`).group;
      const fore = this.part(`foreArm${s}`).group;
      const grip = i === 1 ? pose.gripR : pose.gripL;
      if (grip) {
        this.solveArm(upper, fore, grip, side);
        // Reactions knock the hand off the weapon for a moment.
        upper.quaternion.multiply(this.qa.setFromEuler(this.euler.set(ax * 0.6, 0, az * 0.6)));
        fore.quaternion.multiply(this.qa.setFromEuler(this.euler.set(-Math.max(0, el) * 0.5, 0, 0)));
      } else {
        upper.rotation.set(ax + (i === 1 ? pose.armR : pose.armL), 0, az + side * (0.06 + hurt * 0.04));
        fore.rotation.set(-(0.15 + el + pose.elbows), 0, 0);
      }
    }
  }

  /** Two-bone IK in torso space: shoulder → elbow → hand on `grip`. */
  private solveArm(upper: THREE.Group, fore: THREE.Group, grip: THREE.Object3D, side: number): void {
    const torso = upper.parent!;
    torso.updateMatrixWorld(true);
    const target = this.ik.target.setFromMatrixPosition(this.tmpM.copy(torso.matrixWorld).invert().multiply(grip.matrixWorld));
    const S = upper.position;
    const L1 = this.upperLen;
    const L2 = this.gripLocal.length();
    const dir = this.ik.dir.subVectors(target, S);
    const d = clamp(dir.length(), Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.002);
    dir.normalize();
    const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    // Elbows hang down and out, slightly back.
    const perp = this.ik.perp.set(side * 0.55, -1, -0.15);
    perp.addScaledVector(dir, -perp.dot(dir)).normalize();
    const elbow = this.ik.elbow.copy(S).addScaledVector(dir, L1 * Math.cos(a)).addScaledVector(perp, L1 * Math.sin(a));
    const upperDir = this.ik.a.subVectors(elbow, S).normalize();
    upper.quaternion.setFromUnitVectors(this.ik.b.copy(fore.position).normalize(), upperDir);
    const foreDir = this.ik.a.copy(S).addScaledVector(dir, d).sub(elbow).normalize();
    this.qb.setFromUnitVectors(this.ik.b.copy(this.gripLocal).normalize(), foreDir);
    fore.quaternion.copy(this.qa.copy(upper.quaternion).invert()).multiply(this.qb);
  }
  private ik = { target: new THREE.Vector3(), dir: new THREE.Vector3(), perp: new THREE.Vector3(), elbow: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };

  /** Kinematic hitboxes follow the animated pose; remember velocities for the ragdoll. */
  private updateHitboxes(dt: number): void {
    this.root.updateMatrixWorld(true);
    for (const part of this.parts) {
      part.group.getWorldPosition(part.worldPos);
      part.group.getWorldQuaternion(part.worldQuat);
      if (this.teleport) {
        part.body.setTranslation(part.worldPos, true);
        part.body.setRotation(part.worldQuat, true);
        part.prevPos.copy(part.worldPos);
        part.vel.set(0, 0, 0);
      } else {
        part.body.setNextKinematicTranslation(part.worldPos);
        part.body.setNextKinematicRotation(part.worldQuat);
        if (dt > 1e-5) {
          part.vel.subVectors(part.worldPos, part.prevPos).divideScalar(dt);
          // The pop-up from the floor is not momentum.
          if (this.rise.value < -0.05) part.vel.y = 0;
        }
        part.prevPos.copy(part.worldPos);
      }
    }
    this.teleport = false;
  }

  private updateRagdoll(dt: number): void {
    this.ragdollTime += dt;
    // Knees only buckle at the moment of death; afterwards the body is fully limp.
    if (this.ragdollTime > 0.45 && this.knees.length) {
      for (const k of this.knees) k.configureMotorPosition(0, 0, 1);
      this.knees.length = 0;
    }
    // Body-fall sounds: a heavy part that was falling fast and suddenly stopped.
    this.thudCooldown -= dt;
    for (const part of this.parts) {
      const vy = part.body.linvel().y;
      const heavy = part.name === 'torso' || part.name === 'pelvis' || part.name === 'head';
      if (heavy && this.thudCooldown <= 0 && part.prevVy < -2.2 && vy > part.prevVy * 0.35) {
        const p = part.body.translation();
        this.tmp.set(p.x, p.y, p.z);
        this.hooks.onThud?.(this.tmp, Math.min(1, -part.prevVy / 7));
        this.thudCooldown = 0.12;
      }
      part.prevVy = vy;
    }
  }
}
