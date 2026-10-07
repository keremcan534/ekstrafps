import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import { feel } from '../config/Feel';
import { Humanoid, defaultPose, type HumanoidSkin } from './Humanoid';
import { withModel } from './CharacterModels';

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

const COLORS = { paint: 0xe39a2d, dark: 0x2c3036, visor: 0x3ce6ff, visorHurt: 0xff3b2f };
const VISOR_OK = new THREE.Color(COLORS.visor);
const VISOR_HURT = new THREE.Color(COLORS.visorHurt);
const WHITE = new THREE.Color(1, 1, 1);

export function robotSkin(paint: THREE.Material, dark: THREE.Material, visor: THREE.Material, health: number, merge?: THREE.MeshStandardMaterial): HumanoidSkin {
  const T = 0.42; // thigh
  return {
    health,
    merge,
    gait: 'machine',
    shinLength: 0.44,
    handGrip: [0, -0.33, 0.05],
    zoneDamage: { head: 1, thorax: 1, stomach: 0.9, arm: 0.6, leg: 0.7 },
    parts: [
      {
        name: 'pelvis', parent: null, pos: [0, 0.92, 0], side: 0,
        build: (b) => b.box(dark, [0.44, 0.16, 0.26], [0, -0.04, 0]).box(paint, [0.3, 0.06, 0.28], [0, 0.05, 0]),
        colliders: [{ half: [0.22, 0.1, 0.14], center: [0, -0.03, 0], mass: 14, zone: 'stomach' }],
      },
      ...([-1, 1] as const).flatMap((side) => [
        {
          name: side === 1 ? 'thighR' : 'thighL', parent: 'pelvis', pos: [0.13 * side, -0.06, 0], side,
          build: (b) => b.box(dark, [0.17, T, 0.19], [0, -T / 2, 0]).box(paint, [0.19, 0.15, 0.21], [0, -T + 0.02, 0.01]),
          colliders: [{ half: [0.09, T / 2, 0.1], center: [0, -T / 2, 0], mass: 8, zone: 'leg' }],
        },
        {
          name: side === 1 ? 'shinR' : 'shinL', parent: side === 1 ? 'thighR' : 'thighL', pos: [0, -T, 0], side,
          build: (b) => b.box(dark, [0.15, 0.38, 0.17], [0, -0.2, 0]).box(dark, [0.21, 0.08, 0.3], [0, -0.4, 0.03]),
          colliders: [{ half: [0.09, 0.22, 0.12], center: [0, -0.22, 0.02], mass: 6, zone: 'leg' }],
        },
      ] as HumanoidSkin['parts']),
      {
        name: 'torso', parent: 'pelvis', pos: [0, 0.03, 0], side: 0,
        build: (b) => {
          b.box(dark, [0.4, 0.2, 0.28], [0, 0.06, 0]);
          b.box(paint, [0.58, 0.5, 0.36], [0, 0.34, 0]);
          b.box(dark, [0.36, 0.26, 0.04], [0, 0.34, 0.18]);
          b.box(paint, [0.66, 0.1, 0.3], [0, 0.56, 0]);
          b.cylinder(visor, 0.05, 0.03, [0, 0.36, 0.2], [Math.PI / 2, 0, 0], 12);
          b.box(dark, [0.1, 0.08, 0.1], [0, 0.63, 0]);
        },
        colliders: [
          { half: [0.21, 0.1, 0.15], center: [0, 0.06, 0], mass: 8, zone: 'stomach' },
          { half: [0.3, 0.23, 0.18], center: [0, 0.39, 0], mass: 22, zone: 'thorax' },
        ],
      },
      ...([-1, 1] as const).flatMap((side) => [
        {
          name: side === 1 ? 'upperArmR' : 'upperArmL', parent: 'torso', pos: [0.39 * side, 0.52, 0], side,
          build: (b) => b.box(paint, [0.15, 0.14, 0.16], [0.02 * side, 0, 0]).box(dark, [0.12, 0.36, 0.13], [0.02 * side, -0.2, 0]),
          colliders: [{ half: [0.075, 0.21, 0.085], center: [0.02 * side, -0.16, 0], mass: 4, zone: 'arm' }],
        },
        {
          name: side === 1 ? 'foreArmR' : 'foreArmL', parent: side === 1 ? 'upperArmR' : 'upperArmL', pos: [0.02 * side, -0.38, 0], side,
          build: (b) => b.box(paint, [0.13, 0.3, 0.14], [0, -0.14, 0.03]).box(dark, [0.15, 0.1, 0.18], [0, -0.33, 0.05]),
          colliders: [{ half: [0.075, 0.2, 0.09], center: [0, -0.19, 0.03], mass: 3, zone: 'arm' }],
        },
      ] as HumanoidSkin['parts']),
      {
        name: 'head', parent: 'torso', pos: [0, 0.62, 0], side: 0,
        build: (b) => {
          b.box(dark, [0.36, 0.28, 0.32], [0, 0.18, 0]);
          b.box(paint, [0.38, 0.05, 0.34], [0, 0.33, 0]);
          b.box(visor, [0.3, 0.08, 0.03], [0, 0.2, 0.16]);
          b.cylinder(dark, 0.008, 0.18, [0.12, 0.42, -0.05], [0, 0, 0], 6);
          b.cylinder(visor, 0.018, 0.03, [0.12, 0.52, -0.05], [0, 0, 0], 8);
        },
        colliders: [{ half: [0.19, 0.16, 0.17], center: [0, 0.17, 0], mass: 6, zone: 'head' }],
      },
    ],
  };
}

/**
 * Robot target dummy: a Humanoid body with a robot skin, an optional strafing
 * rail, damage flash, a visor that shows health and auto-respawn.
 * No AI (the SABLE soldiers have it).
 */
export class RobotTarget {
  readonly body: Humanoid;
  readonly chestPoint = new THREE.Object3D();
  private materials: { paint: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial };
  private pose = defaultPose();
  private merged: THREE.MeshStandardMaterial;
  /** The model's materials on show (none on the procedural body): this robot's own copies. */
  private looks: THREE.MeshStandardMaterial[] = [];
  private flash = 0;
  private critFlash = 0;
  private time = Math.random() * 10;
  private base = new THREE.Vector3();
  private railTime = Math.random() * 10;
  private respawnTimer = 0;
  private currentPos = new THREE.Vector3();
  private visorColor = new THREE.Color();
  private tmp = new THREE.Vector3();

  constructor(
    physics: Physics,
    scene: THREE.Object3D,
    private opts: RobotOptions,
    private events: RobotEvents,
  ) {
    this.materials = {
      paint: new THREE.MeshStandardMaterial({ color: COLORS.paint, metalness: 0.35, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: COLORS.dark, metalness: 0.75, roughness: 0.4 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: COLORS.visor, emissiveIntensity: 2.2, roughness: 0.3 }),
    };
    const { paint, dark, visor } = this.materials;
    this.merged = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.45 });
    // The same Meshy walker as the rogue machines (public/chars); the procedural body if it's missing.
    const skin = withModel('robot', robotSkin(paint, dark, visor, opts.health ?? 200, this.merged));
    this.body = new Humanoid(physics, scene, skin, {
      onDamage: (info) => {
        this.flash = Math.min(1, this.flash + 0.75);
        if (info.zone === 'head') this.critFlash = 1;
      },
      onDeath: () => {
        this.flash = 1;
        this.materials.visor.emissiveIntensity = 0.25;
        this.respawnTimer = feel.robotRespawnTime;
        this.chestPoint.getWorldPosition(this.tmp);
        this.events.onDeath(this, this.tmp);
      },
      onThud: (at, s) => this.events.onThud?.(at, s),
      onStagger: (at, s) => this.events.onStagger?.(at, s),
    }, this);
    if (skin.body) {
      this.looks = skin.body.materials.map((m) => (m as THREE.MeshStandardMaterial).clone());
      this.body.setBodyLook(null, this.looks);
    }
    this.base.copy(opts.position);
    this.currentPos.copy(opts.position);
    this.root.position.copy(opts.position);
    this.root.rotation.y = opts.facing ?? 0;
    this.chestPoint.position.set(0, 0.35, 0);
    this.body.part('torso').group.add(this.chestPoint);
    this.body.reset(false);
  }

  get root(): THREE.Group {
    return this.body.root;
  }

  get health() {
    return this.body.health;
  }

  get alive(): boolean {
    return this.body.alive;
  }

  /** Lab tool: bring the robot back immediately (alive or not). */
  forceRespawn(): void {
    this.respawn();
  }

  private respawn(): void {
    this.body.reset(true);
    this.flash = 0;
    this.critFlash = 0;
    this.materials.visor.emissiveIntensity = 2.2;
    this.events.onRespawn(this);
  }

  fixedUpdate(dt: number): void {
    const rail = this.opts.rail;
    if (!rail || !this.alive) return;
    this.railTime += dt;
    const s = Math.sin(this.railTime * rail.speed) * rail.length * 0.5;
    this.currentPos.copy(this.base).addScaledVector(rail.axis, s);
  }

  update(dt: number): void {
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt * 9);
    this.critFlash = Math.max(0, this.critFlash - dt * 6);
    const f = this.flash;
    this.merged.emissive.setRGB(f * 0.7, f * 0.66, f * 0.62);
    for (const m of this.looks) m.color.setScalar(1 + f * 1.5);
    if (!this.alive) {
      for (const m of this.looks) m.emissive.setScalar(0);
      this.body.update(dt, this.pose);
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
    this.root.position.copy(this.currentPos);
    this.body.update(dt, this.pose);

    // Visor colour shows remaining health; a badly hurt robot's visor flickers.
    const hp = this.health.health / this.health.maxHealth;
    const flicker = hp < 0.35 && Math.sin(this.time * 37) * Math.sin(this.time * 13.7) > 0.6 ? 0.35 : 1;
    this.visorColor.copy(VISOR_HURT).lerp(VISOR_OK, hp).lerp(WHITE, this.critFlash);
    this.materials.visor.emissive.copy(this.visorColor);
    this.materials.visor.emissiveIntensity = (2.2 + this.critFlash * 4) * flicker;
    // The model has no visor of its own: it glows red as it's hurt (flickering near the end)
    // and white on a headshot.
    const glow = (1 - hp) * 0.16 * flicker;
    for (const m of this.looks) m.emissive.copy(VISOR_HURT).multiplyScalar(glow).lerp(WHITE, this.critFlash * 0.35);
  }
}
