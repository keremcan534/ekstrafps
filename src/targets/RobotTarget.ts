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
}

type PartName = 'legs' | 'torso' | 'head' | 'armL' | 'armR';

interface Part {
  name: PartName;
  group: THREE.Group;
  debris: THREE.Group;
  body: RAPIER.RigidBody;
  half: [number, number, number];
  /** Collider centre offset from the group origin. */
  center: [number, number, number];
}

const MAX_TILT = 26 * DEG;
const COLORS = { paint: 0xe39a2d, dark: 0x2c3036, visor: 0x3ce6ff, visorHurt: 0xff3b2f };
const VISOR_OK = new THREE.Color(COLORS.visor);
const VISOR_HURT = new THREE.Color(COLORS.visorHurt);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Simple robot target dummy: body + head (weak point) hitboxes, spring-driven
 * hit reactions, damage flash, physics collapse on death and auto-respawn.
 * No AI — that comes later and can reuse this hit/death plumbing.
 */
export class RobotTarget {
  readonly root = new THREE.Group();
  readonly health: Damageable;
  readonly chestPoint = new THREE.Object3D();
  private pivot = new THREE.Group();
  private parts: Part[] = [];
  private hitbox: RAPIER.RigidBody;
  private hitColliders: RAPIER.Collider[] = [];
  private materials: { paint: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial };

  // Reaction springs
  private tiltX = new Spring(85, 8);
  private tiltZ = new Spring(85, 8);
  private twist = new Spring(110, 9);
  private headX = new Spring(170, 10);
  private headZ = new Spring(170, 10);
  private shove = new Spring3(140, 14);
  private rise = new Spring(130, 11);
  private flash = 0;
  private critFlash = 0;

  private base = new THREE.Vector3();
  private railTime = Math.random() * 10;
  private respawnTimer = 0;
  private currentPos = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private inv = new THREE.Quaternion();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private visorColor = new THREE.Color();
  private torsoGroup!: THREE.Group;
  private headGroup!: THREE.Group;

  constructor(
    private physics: Physics,
    scene: THREE.Object3D,
    private opts: RobotOptions,
    private events: RobotEvents,
  ) {
    this.health = new Damageable(opts.health ?? 180);
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
    this.buildVisual(scene);

    // Kinematic hitbox body: torso/legs + head weak point.
    this.hitbox = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(opts.position.x, opts.position.y, opts.position.z)
        .setRotation(new THREE.Quaternion().setFromEuler(this.root.rotation)),
    );
    const bodyCol = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.42, 0.78, 0.2).setTranslation(0, 0.78, 0).setCollisionGroups(GROUPS.hitbox),
      this.hitbox,
    );
    const headCol = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.19, 0.16, 0.17).setTranslation(0, 1.74, 0).setCollisionGroups(GROUPS.hitbox),
      this.hitbox,
    );
    this.hitColliders.push(bodyCol, headCol);
    physics.register(bodyCol, { surface: 'robot', allowDecals: false, onBulletHit: (h, o) => this.onHit(h, false, o) });
    physics.register(headCol, { surface: 'robotWeak', allowDecals: false, onBulletHit: (h, o) => this.onHit(h, true, o) });
  }

  get alive(): boolean {
    return this.health.alive;
  }

  private buildVisual(scene: THREE.Object3D): void {
    const { paint, dark, visor } = this.materials;
    const mk = (name: PartName, parent: THREE.Object3D, pos: [number, number, number], build: (b: MeshBuilder) => void, half: [number, number, number], center: [number, number, number]) => {
      const group = new THREE.Group();
      group.position.set(...pos);
      parent.add(group);
      const b = new MeshBuilder();
      build(b);
      b.build(group, { castShadow: true, receiveShadow: true });
      const debris = group.clone(true);
      debris.position.set(0, 0, 0);
      debris.rotation.set(0, 0, 0);
      debris.visible = false;
      scene.add(debris);
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setEnabled(false).setLinearDamping(0.1).setAngularDamping(0.4).setCcdEnabled(true),
      );
      const col = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...half)
          .setTranslation(...center)
          .setDensity(260)
          .setFriction(0.7)
          .setRestitution(0.15)
          .setCollisionGroups(GROUPS.debris),
        body,
      );
      this.physics.register(col, { surface: 'robot', body, allowDecals: false });
      this.physics.addSynced(body, debris);
      this.parts.push({ name, group, debris, body, half, center });
      return group;
    };

    mk('legs', this.pivot, [0, 0, 0], (b) => {
      b.box(dark, [0.17, 0.8, 0.19], [0.13, 0.44, 0]).box(dark, [0.17, 0.8, 0.19], [-0.13, 0.44, 0]);
      b.box(dark, [0.21, 0.08, 0.3], [0.13, 0.04, 0.03]).box(dark, [0.21, 0.08, 0.3], [-0.13, 0.04, 0.03]);
      b.box(paint, [0.19, 0.16, 0.21], [0.13, 0.46, 0.01]).box(paint, [0.19, 0.16, 0.21], [-0.13, 0.46, 0.01]);
      b.box(dark, [0.44, 0.16, 0.26], [0, 0.88, 0]);
    }, [0.24, 0.48, 0.14], [0, 0.48, 0]);

    const torso = mk('torso', this.pivot, [0, 0.95, 0], (b) => {
      b.box(dark, [0.4, 0.2, 0.28], [0, 0.06, 0]);
      b.box(paint, [0.58, 0.5, 0.36], [0, 0.34, 0]);
      b.box(dark, [0.36, 0.26, 0.04], [0, 0.34, 0.18]);
      b.box(paint, [0.66, 0.1, 0.3], [0, 0.56, 0]);
      b.cylinder(visor, 0.05, 0.03, [0, 0.36, 0.2], [Math.PI / 2, 0, 0], 12);
      b.box(dark, [0.1, 0.08, 0.1], [0, 0.63, 0]);
    }, [0.3, 0.32, 0.18], [0, 0.32, 0]);
    this.chestPoint.position.set(0, 0.35, 0);
    torso.add(this.chestPoint);
    this.torsoGroup = torso;

    for (const side of [1, -1] as const) {
      mk(side === 1 ? 'armR' : 'armL', torso, [0.39 * side, 0.52, 0], (b) => {
        b.box(paint, [0.15, 0.14, 0.16], [0.02 * side, 0, 0]);
        b.box(dark, [0.12, 0.36, 0.13], [0.02 * side, -0.22, 0]);
        b.box(paint, [0.13, 0.3, 0.14], [0.02 * side, -0.52, 0.03]);
        b.box(dark, [0.15, 0.1, 0.18], [0.02 * side, -0.71, 0.05]);
      }, [0.08, 0.38, 0.09], [0.02 * side, -0.38, 0.02]);
    }

    this.headGroup = mk('head', torso, [0, 0.62, 0], (b) => {
      b.box(dark, [0.36, 0.28, 0.32], [0, 0.18, 0]);
      b.box(paint, [0.38, 0.05, 0.34], [0, 0.33, 0]);
      b.box(visor, [0.3, 0.08, 0.03], [0, 0.2, 0.16]);
      b.cylinder(dark, 0.008, 0.18, [0.12, 0.42, -0.05], [0, 0, 0], 6);
      b.cylinder(visor, 0.018, 0.03, [0.12, 0.52, -0.05], [0, 0, 0], 8);
    }, [0.19, 0.16, 0.17], [0, 0.17, 0]);
  }

  private onHit(hit: BulletHit, head: boolean, out: HitResult): void {
    if (!this.alive) return;
    const dmg = hit.damage * (head ? hit.critMultiplier : 1);
    this.health.applyDamage(dmg);
    out.damage = dmg;
    out.crit = head;
    out.health = this.health.health;
    out.maxHealth = this.health.maxHealth;

    // Reaction: transform bullet direction into robot-local space.
    this.inv.copy(this.root.quaternion).invert();
    const d = this.tmp.copy(hit.direction).applyQuaternion(this.inv);
    const k = hit.impulse * feel.hitReactionScale;
    this.tiltX.impulse(d.z * k * (head ? 0.6 : 1.0));
    this.tiltZ.impulse(-d.x * k * (head ? 0.6 : 1.0));
    const local = this.tmp2.copy(hit.point).sub(this.currentPos).applyQuaternion(this.inv);
    this.twist.impulse((local.x * d.z - local.z * d.x) * k * 4);
    this.shove.impulse(d.x * k * 0.25, 0, d.z * k * 0.25);
    if (head) {
      this.headX.impulse(d.z * k * 3.2);
      this.headZ.impulse(-d.x * k * 3.2);
      this.critFlash = 1;
    }
    this.flash = Math.min(1, this.flash + 0.75);

    if (!this.alive) {
      out.killed = true;
      this.die(hit, head);
    }
  }

  private die(hit: BulletHit, head: boolean): void {
    for (const c of this.hitColliders) c.setEnabled(false);
    this.root.updateMatrixWorld(true);
    const launch = clamp(hit.impulse * 0.9, 2.5, 9);
    for (const part of this.parts) {
      part.group.getWorldPosition(this.tmp);
      part.group.getWorldQuaternion(this.tmpQ);
      const b = part.body;
      b.setEnabled(true);
      b.setTranslation(this.tmp, true);
      b.setRotation(this.tmpQ, true);
      const up = part.name === 'head' ? (head ? 5.5 : 3.5) : part.name === 'legs' ? 0.5 : 2;
      const scatter = part.name === 'legs' ? 0.3 : 1.4;
      b.setLinvel(
        {
          x: this.velocity.x + hit.direction.x * launch * (part.name === 'legs' ? 0.3 : 1) + (Math.random() - 0.5) * scatter,
          y: up + Math.random() * 1.5,
          z: this.velocity.z + hit.direction.z * launch * (part.name === 'legs' ? 0.3 : 1) + (Math.random() - 0.5) * scatter,
        },
        true,
      );
      b.setAngvel({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 }, true);
      part.debris.position.copy(this.tmp);
      part.debris.quaternion.copy(this.tmpQ);
      part.debris.visible = true;
    }
    this.pivot.visible = false;
    this.respawnTimer = feel.robotRespawnTime;
    this.chestPoint.getWorldPosition(this.tmp);
    this.events.onDeath(this, this.tmp);
  }

  private respawn(): void {
    for (const part of this.parts) {
      part.body.setEnabled(false);
      part.debris.visible = false;
    }
    this.health.reset();
    for (const c of this.hitColliders) c.setEnabled(true);
    this.pivot.visible = true;
    this.tiltX.reset();
    this.tiltZ.reset();
    this.twist.reset();
    this.headX.reset();
    this.headZ.reset();
    this.shove.reset();
    // Pop up out of the floor with a little overshoot.
    this.rise.reset(0);
    this.rise.value = -1.9;
    this.flash = 0;
    this.critFlash = 0;
    this.events.onRespawn(this);
  }

  fixedUpdate(dt: number): void {
    const rail = this.opts.rail;
    if (!rail) return;
    this.railTime += dt;
    const prevX = this.currentPos.x;
    const prevZ = this.currentPos.z;
    const s = Math.sin(this.railTime * rail.speed) * rail.length * 0.5;
    this.currentPos.copy(this.base).addScaledVector(rail.axis, s);
    this.velocity.set((this.currentPos.x - prevX) / dt, 0, (this.currentPos.z - prevZ) / dt);
    this.hitbox.setNextKinematicTranslation(this.currentPos);
  }

  update(dt: number): void {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
    this.root.position.copy(this.currentPos);
    const clampSpring = (s: Spring) => {
      s.update(dt);
      if (Math.abs(s.value) > MAX_TILT) {
        s.value = Math.sign(s.value) * MAX_TILT;
        s.velocity *= -0.3;
      }
    };
    clampSpring(this.tiltX);
    clampSpring(this.tiltZ);
    this.twist.update(dt);
    this.headX.update(dt);
    this.headZ.update(dt);
    const shove = this.shove.update(dt);
    const rise = this.rise.update(dt);

    this.pivot.rotation.set(this.tiltX.value, this.twist.value * 0.5, this.tiltZ.value);
    this.pivot.position.set(clamp(shove.x, -0.3, 0.3), rise, clamp(shove.z, -0.3, 0.3));
    this.torsoGroup.rotation.set(this.tiltX.value * 0.5, this.twist.value, this.tiltZ.value * 0.5);
    this.headGroup.rotation.set(this.headX.value, 0, this.headZ.value);

    // Damage flash + visor colour shows remaining health.
    this.flash = Math.max(0, this.flash - dt * 9);
    this.critFlash = Math.max(0, this.critFlash - dt * 6);
    const f = this.flash;
    this.materials.paint.emissive.setRGB(f * 0.9, f * 0.85, f * 0.8);
    this.materials.dark.emissive.setRGB(f * 0.5, f * 0.5, f * 0.5);
    const hp = this.health.health / this.health.maxHealth;
    this.visorColor.copy(VISOR_HURT).lerp(VISOR_OK, hp).lerp(WHITE, this.critFlash);
    this.materials.visor.emissive.copy(this.visorColor);
    this.materials.visor.emissiveIntensity = 2.2 + this.critFlash * 4;
  }
}
