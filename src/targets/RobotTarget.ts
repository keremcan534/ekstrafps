import * as THREE from 'three';
import { RAPIER, GROUPS, type BulletHit, type HitResult, type Physics } from '../core/Physics';
import { Spring, Spring3 } from '../core/Spring';
import { clamp, DEG } from '../core/math';
import { feel } from '../config/Feel';
import { MeshBuilder } from '../world/MeshBuilder';
import { Damageable } from './Damageable';

export interface RobotOptions {
  position: THREE.Vector3;
  /** Yaw in radians; 0 = facing +Z (toward the firing line). */
  facing?: number;
  health?: number;
  /** Optional strafing rail. */
  rail?: { axis: THREE.Vector3; length: number; speed: number };
}

export interface RobotEvents {
  onDeath(robot: RobotTarget, at: THREE.Vector3): void;
  onRespawn(robot: RobotTarget): void;
  /** A ragdoll part slammed into something (body fall, limb clank). strength 0..1. */
  onThud?(at: THREE.Vector3, strength: number): void;
  /** Heavy stagger: servo strain sound hook. */
  onStagger?(at: THREE.Vector3, strength: number): void;
}

type PartName = 'pelvis' | 'torso' | 'head' | 'upperArmL' | 'upperArmR' | 'foreArmL' | 'foreArmR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';
export type HitZone = 'head' | 'thorax' | 'stomach' | 'arm' | 'leg';

interface ColliderDef {
  half: [number, number, number];
  center: [number, number, number];
  mass: number;
  zone: HitZone;
}

interface Part {
  name: PartName;
  /** -1 = robot's left (-X), +1 = right (+X), 0 = centre line. */
  side: -1 | 0 | 1;
  parent: Part | null;
  /** Posed node inside the living robot's hierarchy. */
  group: THREE.Group;
  /** World-space copy shown while ragdolled (synced to `body`). */
  debris: THREE.Group;
  /** Kinematic hitbox while alive, dynamic ragdoll body when dead. */
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  worldPos: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  /** Animated velocity, inherited by the ragdoll on death. */
  vel: THREE.Vector3;
  prevVy: number;
}

/** Damage multiplier per zone (head uses the round's crit multiplier). */
const ZONE_DAMAGE: Record<HitZone, number> = { head: 1, thorax: 1, stomach: 0.9, arm: 0.6, leg: 0.7 };

const THIGH = 0.42;
const SHIN = 0.44;
const HIP_HALF_WIDTH = 0.13;
const IDLE_KNEE = 0.1;
const MAX_TILT = 24 * DEG;
const COLORS = { paint: 0xe39a2d, dark: 0x2c3036, visor: 0x3ce6ff, visorHurt: 0xff3b2f };
const VISOR_OK = new THREE.Color(COLORS.visor);
const VISOR_HURT = new THREE.Color(COLORS.visorHurt);
const WHITE = new THREE.Color(1, 1, 1);
const X_AXIS = { x: 1, y: 0, z: 0 };

/**
 * Robot target dummy with a physical body:
 *
 * - Alive: every body part is a kinematic hitbox that follows the animated pose
 *   (so what you see is what you hit), split into zones: head, thorax, stomach,
 *   arms, legs. Hits drive layered spring reactions per zone — head snaps back,
 *   shoulder hits spin the torso, gut shots fold it, leg hits buckle the knee,
 *   heavy rounds knock the whole robot back a step. Repeated hits build stagger.
 * - Dead: the same bodies turn dynamic and get jointed into a ragdoll (revolute
 *   knees/elbows/neck/waist with limits, spherical hips/shoulders with weak
 *   "muscle tone"). It inherits the animated velocity plus the killing round's
 *   momentum at the exact hit point, and the knees buckle as it drops.
 *
 * No AI — that comes later and can reuse this hit/death plumbing.
 */
export class RobotTarget {
  readonly root = new THREE.Group();
  readonly health: Damageable;
  readonly chestPoint = new THREE.Object3D();
  private pivot = new THREE.Group();
  private parts: Part[] = [];
  private byName = new Map<PartName, Part>();
  private joints: RAPIER.ImpulseJoint[] = [];
  private knees: RAPIER.RevoluteImpulseJoint[] = [];
  private materials: { paint: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial };

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
  private rise = new Spring(130, 11);

  /** Accumulated stagger (0..~2): makes reactions bigger and the robot unsteady. */
  private stagger = 0;
  private kneelTimer = [0, 0];
  private legWound = [0, 0];
  private flash = 0;
  private critFlash = 0;
  private time = Math.random() * 100;

  private base = new THREE.Vector3();
  private railTime = Math.random() * 10;
  private respawnTimer = 0;
  private ragdollTime = 0;
  private thudCooldown = 0;
  private teleport = true;
  private currentPos = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private inv = new THREE.Quaternion();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private visorColor = new THREE.Color();

  constructor(
    private physics: Physics,
    scene: THREE.Object3D,
    private opts: RobotOptions,
    private events: RobotEvents,
  ) {
    this.health = new Damageable(opts.health ?? 200);
    this.base.copy(opts.position);
    this.currentPos.copy(opts.position);
    this.root.position.copy(opts.position);
    this.root.rotation.y = opts.facing ?? 0;
    this.root.add(this.pivot);
    scene.add(this.root);

    this.materials = {
      paint: new THREE.MeshStandardMaterial({ color: COLORS.paint, metalness: 0.35, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: COLORS.dark, metalness: 0.75, roughness: 0.4 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: COLORS.visor, emissiveIntensity: 2.2, roughness: 0.3 }),
    };
    this.buildBody(scene);
    this.updatePose(0);
  }

  get alive(): boolean {
    return this.health.alive;
  }

  // ---------------------------------------------------------------- build

  private buildBody(scene: THREE.Object3D): void {
    const { paint, dark, visor } = this.materials;
    const mk = (
      name: PartName,
      parent: Part | null,
      pos: [number, number, number],
      side: -1 | 0 | 1,
      build: (b: MeshBuilder) => void,
      cols: ColliderDef[],
    ): Part => {
      const group = new THREE.Group();
      group.position.set(...pos);
      (parent ? parent.group : this.pivot).add(group);
      const b = new MeshBuilder();
      build(b);
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
        name, side, parent, group, debris, body, colliders: [],
        worldPos: new THREE.Vector3(), worldQuat: new THREE.Quaternion(), prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), prevVy: 0,
      };
      for (const c of cols) {
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
        this.physics.register(col, {
          surface: c.zone === 'head' ? 'robotWeak' : 'robot',
          body,
          allowDecals: false,
          impulseScale: 3,
          onBulletHit: (h, o) => this.onHit(h, part, c.zone, o),
        });
      }
      this.physics.addSynced(body, debris);
      this.parts.push(part);
      this.byName.set(name, part);
      return part;
    };

    const pelvis = mk('pelvis', null, [0, 0.92, 0], 0, (b) => {
      b.box(dark, [0.44, 0.16, 0.26], [0, -0.04, 0]);
      b.box(paint, [0.3, 0.06, 0.28], [0, 0.05, 0]);
    }, [{ half: [0.22, 0.1, 0.14], center: [0, -0.03, 0], mass: 14, zone: 'stomach' }]);

    for (const side of [-1, 1] as const) {
      const thigh = mk(side === 1 ? 'thighR' : 'thighL', pelvis, [HIP_HALF_WIDTH * side, -0.06, 0], side, (b) => {
        b.box(dark, [0.17, THIGH, 0.19], [0, -THIGH / 2, 0]);
        b.box(paint, [0.19, 0.15, 0.21], [0, -THIGH + 0.02, 0.01]);
      }, [{ half: [0.09, THIGH / 2, 0.1], center: [0, -THIGH / 2, 0], mass: 8, zone: 'leg' }]);
      mk(side === 1 ? 'shinR' : 'shinL', thigh, [0, -THIGH, 0], side, (b) => {
        b.box(dark, [0.15, 0.38, 0.17], [0, -0.2, 0]);
        b.box(dark, [0.21, 0.08, 0.3], [0, -SHIN + 0.04, 0.03]);
      }, [{ half: [0.09, SHIN / 2, 0.12], center: [0, -SHIN / 2, 0.02], mass: 6, zone: 'leg' }]);
    }

    const torso = mk('torso', pelvis, [0, 0.03, 0], 0, (b) => {
      b.box(dark, [0.4, 0.2, 0.28], [0, 0.06, 0]);
      b.box(paint, [0.58, 0.5, 0.36], [0, 0.34, 0]);
      b.box(dark, [0.36, 0.26, 0.04], [0, 0.34, 0.18]);
      b.box(paint, [0.66, 0.1, 0.3], [0, 0.56, 0]);
      b.cylinder(visor, 0.05, 0.03, [0, 0.36, 0.2], [Math.PI / 2, 0, 0], 12);
      b.box(dark, [0.1, 0.08, 0.1], [0, 0.63, 0]);
    }, [
      { half: [0.21, 0.1, 0.15], center: [0, 0.06, 0], mass: 8, zone: 'stomach' },
      { half: [0.3, 0.23, 0.18], center: [0, 0.39, 0], mass: 22, zone: 'thorax' },
    ]);
    this.chestPoint.position.set(0, 0.35, 0);
    torso.group.add(this.chestPoint);

    for (const side of [-1, 1] as const) {
      const upper = mk(side === 1 ? 'upperArmR' : 'upperArmL', torso, [0.39 * side, 0.52, 0], side, (b) => {
        b.box(paint, [0.15, 0.14, 0.16], [0.02 * side, 0, 0]);
        b.box(dark, [0.12, 0.36, 0.13], [0.02 * side, -0.2, 0]);
      }, [{ half: [0.075, 0.21, 0.085], center: [0.02 * side, -0.16, 0], mass: 4, zone: 'arm' }]);
      mk(side === 1 ? 'foreArmR' : 'foreArmL', upper, [0.02 * side, -0.38, 0], side, (b) => {
        b.box(paint, [0.13, 0.3, 0.14], [0, -0.14, 0.03]);
        b.box(dark, [0.15, 0.1, 0.18], [0, -0.33, 0.05]);
      }, [{ half: [0.075, 0.2, 0.09], center: [0, -0.19, 0.03], mass: 3, zone: 'arm' }]);
    }

    mk('head', torso, [0, 0.62, 0], 0, (b) => {
      b.box(dark, [0.36, 0.28, 0.32], [0, 0.18, 0]);
      b.box(paint, [0.38, 0.05, 0.34], [0, 0.33, 0]);
      b.box(visor, [0.3, 0.08, 0.03], [0, 0.2, 0.16]);
      b.cylinder(dark, 0.008, 0.18, [0.12, 0.42, -0.05], [0, 0, 0], 6);
      b.cylinder(visor, 0.018, 0.03, [0.12, 0.52, -0.05], [0, 0, 0], 8);
    }, [{ half: [0.19, 0.16, 0.17], center: [0, 0.17, 0], mass: 6, zone: 'head' }]);
  }

  private part(name: PartName): Part {
    return this.byName.get(name)!;
  }

  // ---------------------------------------------------------------- hits

  private onHit(hit: BulletHit, part: Part, zone: HitZone, out: HitResult): void {
    if (!this.alive) return;
    const head = zone === 'head';
    const dmg = hit.damage * (head ? hit.critMultiplier : ZONE_DAMAGE[zone]);
    this.health.applyDamage(dmg);
    out.damage = dmg;
    out.crit = head;
    out.health = this.health.health;
    out.maxHealth = this.health.maxHealth;
    this.flash = Math.min(1, this.flash + 0.75);
    if (head) this.critFlash = 1;

    if (!this.alive) {
      out.killed = true;
      this.die(hit, part, zone);
      return;
    }
    this.react(hit, part, zone, dmg);
  }

  /** Living hit reaction: zone-specific spring impulses scaled by the round's momentum. */
  private react(hit: BulletHit, part: Part, zone: HitZone, dmg: number): void {
    // Bullet direction and hit point in robot space (robot faces +Z, so shots from the
    // front travel along -Z and push the top of the body backward = negative X rotation).
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
        // Head snaps back hard; the neck carries it into the shoulders.
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
        // Arms swing forward as the chest is driven back (inertia).
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
        // Arm is thrown back, the shoulder drags the torso around.
        this.armX[i].impulse(-d.z * s * 7);
        this.armZ[i].impulse(d.x * s * 5 + part.side * s * 2);
        this.elbow[i].impulse(s * (part.name.startsWith('fore') ? -3 : 3));
        this.spineY.impulse(torque * s * 12);
        this.spineZ.impulse(-d.x * s * 0.8);
        break;
      case 'leg': {
        // Leg buckles; heavy rounds drop the robot onto that knee for a moment.
        this.knee[i].impulse(s * 3.8);
        this.knee[1 - i].impulse(s * 1.2);
        this.tiltZ.impulse(-part.side * s * 0.6);
        this.spineX.impulse(s * 1.2);
        this.legWound[i] = Math.min(1, this.legWound[i] + dmg / 90);
        if (s > 1.4 || this.legWound[i] > 0.6) this.kneelTimer[i] = 0.35 + 0.18 * s;
        break;
      }
    }

    const before = this.stagger;
    this.stagger = Math.min(2, this.stagger + 0.22 * s);
    if (s > 2.2 || (before < 1 && this.stagger >= 1)) {
      this.chestPoint.getWorldPosition(this.tmp);
      this.events.onStagger?.(this.tmp, Math.min(1, s / 3));
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
      const head = this.part('head').body;
      const k = momentum * 0.9;
      head.applyImpulse({ x: dir.x * k, y: k * 0.35, z: dir.z * k }, true);
      this.part('torso').body.applyImpulse({ x: dir.x * k * 0.8, y: 0, z: dir.z * k * 0.8 }, true);
    }

    this.ragdollTime = 0;
    this.respawnTimer = feel.robotRespawnTime;
    this.materials.visor.emissiveIntensity = 0.25;
    this.chestPoint.getWorldPosition(this.tmp);
    this.events.onDeath(this, this.tmp);
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
    const hinge = (parent: PartName, child: PartName, min: number, max: number, damping: number) => {
      const j = link(parent, child, RAPIER.JointData.revolute(anchor(child), ZERO, X_AXIS)) as RAPIER.RevoluteImpulseJoint;
      j.setLimits(min, max);
      j.configureMotorPosition(0, 0, damping);
      return j;
    };
    const ball = (parent: PartName, child: PartName, tone: number, damping: number) => {
      const j = link(parent, child, RAPIER.JointData.spherical(anchor(child), ZERO));
      // The JS wrapper's SphericalImpulseJoint lacks the per-axis motor methods its
      // typings declare; the raw joint set has them.
      const raw = (j as unknown as { rawSet: { jointConfigureMotorPosition(h: number, axis: number, pos: number, k: number, c: number): void } }).rawSet;
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        raw.jointConfigureMotorPosition(j.handle, axis, 0, tone, damping);
      }
      return j;
    };

    hinge('pelvis', 'torso', -0.45, 1.05, 2);
    hinge('torso', 'head', -0.75, 0.6, 1.5);
    for (const s of ['L', 'R'] as const) {
      ball('torso', `upperArm${s}`, 2, 1.2);
      hinge(`upperArm${s}`, `foreArm${s}`, -2.3, 0, 0.6);
      ball('pelvis', `thigh${s}`, 6, 2);
      const knee = hinge(`thigh${s}`, `shin${s}`, 0, 2.5, 1);
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

  /** Lab tool: bring the robot back immediately (alive or not). */
  forceRespawn(): void {
    this.respawn();
  }

  private respawn(): void {
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
    // Pop up out of the floor with a little overshoot.
    this.rise.reset(0);
    this.rise.value = -1.9;
    this.flash = 0;
    this.critFlash = 0;
    this.materials.visor.emissiveIntensity = 2.2;
    this.teleport = true;
    this.events.onRespawn(this);
  }

  // ---------------------------------------------------------------- update

  fixedUpdate(dt: number): void {
    const rail = this.opts.rail;
    if (!rail || !this.alive) return;
    this.railTime += dt;
    const prevX = this.currentPos.x;
    const prevZ = this.currentPos.z;
    const s = Math.sin(this.railTime * rail.speed) * rail.length * 0.5;
    this.currentPos.copy(this.base).addScaledVector(rail.axis, s);
    this.velocity.set((this.currentPos.x - prevX) / dt, 0, (this.currentPos.z - prevZ) / dt);
  }

  update(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 9);
    this.critFlash = Math.max(0, this.critFlash - dt * 6);
    if (!this.alive) {
      this.updateRagdoll(dt);
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
    this.updatePose(dt);
    this.updateHitboxes(dt);

    // Damage flash + visor colour shows remaining health.
    const f = this.flash;
    this.materials.paint.emissive.setRGB(f * 0.9, f * 0.85, f * 0.8);
    this.materials.dark.emissive.setRGB(f * 0.5, f * 0.5, f * 0.5);
    const hp = this.health.health / this.health.maxHealth;
    // A badly hurt robot's visor flickers.
    const flicker = hp < 0.35 && Math.sin(this.time * 37) * Math.sin(this.time * 13.7) > 0.6 ? 0.35 : 1;
    this.visorColor.copy(VISOR_HURT).lerp(VISOR_OK, hp).lerp(WHITE, this.critFlash);
    this.materials.visor.emissive.copy(this.visorColor);
    this.materials.visor.emissiveIntensity = (2.2 + this.critFlash * 4) * flicker;
  }

  /** Drive the living pose from the reaction springs. */
  private updatePose(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.stagger = Math.max(0, this.stagger - dt * 0.65);
    const wobble = Math.min(1, this.stagger);
    const hp = this.health.health / this.health.maxHealth;
    const hurt = 1 - hp;

    // Targets: idle breathing, a hunch when hurt, unsteady sway while staggered,
    // a limp toward a wounded leg.
    this.tiltX.target = Math.sin(t * 2.3) * 0.05 * wobble;
    this.tiltZ.target = Math.sin(t * 1.7 + 1) * 0.06 * wobble + (this.legWound[0] - this.legWound[1]) * 0.05;
    this.spineX.target = Math.sin(t * 1.6) * 0.015 + hurt * 0.12 + wobble * 0.08;
    this.headX.target = Math.sin(t * 0.7) * 0.03 + hurt * 0.08;
    this.headY.target = Math.sin(t * 0.45 + 2) * 0.12;
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

    // Legs: two-bone knee bend, pelvis height follows the legs (feet stay near the floor).
    const theta = [0, 0];
    const height = [0, 0];
    for (let i = 0; i < 2; i++) {
      theta[i] = IDLE_KNEE + spring(this.knee[i], 0, 1.1);
      height[i] = (THIGH + SHIN) * Math.cos(theta[i]);
    }
    const roll = clamp(Math.atan2(height[1] - height[0], HIP_HALF_WIDTH * 2), -0.25, 0.25);
    const pelvis = this.part('pelvis').group;
    pelvis.position.y = (height[0] + height[1]) * 0.5 + 0.06;
    pelvis.rotation.set(0, 0, roll);
    for (let i = 0; i < 2; i++) {
      const s = i === 1 ? 'R' : 'L';
      this.part(`thigh${s}`).group.rotation.set(-theta[i], 0, -roll);
      this.part(`shin${s}`).group.rotation.set(2 * theta[i], 0, 0);
    }

    this.part('torso').group.rotation.set(spineX, spineY, spineZ - roll * 0.6);
    this.part('head').group.rotation.set(headX, headY, headZ);
    for (let i = 0; i < 2; i++) {
      const side = i === 1 ? 1 : -1;
      const s = i === 1 ? 'R' : 'L';
      const ax = spring(this.armX[i], -1.3, 1.3) + Math.sin(t * 1.3 + i) * 0.02;
      const az = spring(this.armZ[i], -1, 1);
      const el = spring(this.elbow[i], -0.15, 1.6);
      this.part(`upperArm${s}`).group.rotation.set(ax, 0, az + side * (0.06 + hurt * 0.04));
      this.part(`foreArm${s}`).group.rotation.set(-(0.15 + el), 0, 0);
    }
    this.root.position.copy(this.currentPos);
  }

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
    const f = this.flash;
    this.materials.paint.emissive.setRGB(f * 0.9, f * 0.85, f * 0.8);
    this.materials.dark.emissive.setRGB(f * 0.5, f * 0.5, f * 0.5);

    // Body-fall sounds: a part that was falling fast and suddenly stopped hit something.
    this.thudCooldown -= dt;
    for (const part of this.parts) {
      const vy = part.body.linvel().y;
      const heavy = part.name === 'torso' || part.name === 'pelvis' || part.name === 'head';
      if (heavy && this.thudCooldown <= 0 && part.prevVy < -2.2 && vy > part.prevVy * 0.35) {
        const p = part.body.translation();
        this.tmp.set(p.x, p.y, p.z);
        this.events.onThud?.(this.tmp, Math.min(1, -part.prevVy / 7));
        this.thudCooldown = 0.12;
      }
      part.prevVy = vy;
    }
  }
}
