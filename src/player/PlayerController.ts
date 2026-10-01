import * as THREE from 'three';
import { RAPIER, GROUPS, type Physics } from '../core/Physics';
import type { Input } from '../core/Input';
import { clamp, damp, moveTowards, DEG } from '../core/math';
import { playerConfig as cfg } from './PlayerConfig';

/** Start a few cm above the floor; gravity settles the capsule onto the controller skin. */
const SPAWN_LIFT = 0.05;

/**
 * Kinematic first-person character. Arcade feel: snappy acceleration,
 * coyote time, jump buffering, momentum-preserving air control.
 * Runs on the fixed simulation step; look (yaw/pitch) is applied per frame.
 */
export class PlayerController {
  /** Feet position (current / previous fixed step, for render interpolation). */
  readonly feet = new THREE.Vector3();
  readonly prevFeet = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  grounded = false;
  sprinting = false;
  crouching = false;
  /** 0 = standing, 1 = fully crouched (smoothed). */
  crouchAmount = 0;
  eyeHeight = cfg.standEyeHeight;
  /** Walk-cycle phase (radians), advanced by distance travelled on the ground. */
  bobPhase = 0;
  /** Horizontal speed / walkSpeed (0..~1.5). */
  speedRatio = 0;
  airTime = 0;

  /** Set by the weapon each frame: ADS or firing blocks sprint. */
  sprintBlocked = false;
  adsAmount = 0;

  onLand: ((impactSpeed: number) => void) | null = null;
  onJump: (() => void) | null = null;

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private height = cfg.standHeight;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private jumpCooldown = 0;
  private wish = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private upRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  private collision = new RAPIER.CharacterCollision();

  constructor(private physics: Physics, spawn: THREE.Vector3, spawnYaw = 0) {
    const world = physics.world;
    this.feet.copy(spawn);
    this.feet.y += SPAWN_LIFT;
    this.prevFeet.copy(this.feet);
    this.yaw = spawnYaw;

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.feet.x, this.feet.y + this.height / 2, this.feet.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(this.height / 2 - cfg.radius, cfg.radius).setCollisionGroups(GROUPS.player),
      this.body,
    );

    this.controller = world.createCharacterController(0.02);
    this.controller.enableAutostep(cfg.stepHeight, 0.15, false);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle(cfg.maxSlopeDeg * DEG);
    this.controller.setMinSlopeSlideAngle((cfg.maxSlopeDeg + 4) * DEG);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(cfg.pushImpulse * 40);
    this.controller.setSlideEnabled(true);
    // Resolve tiny ground penetrations quickly instead of stalling on them.
    this.controller.setNormalNudgeFactor(0.002);
  }

  get colliderHandle(): number {
    return this.collider.handle;
  }

  /** Per-frame: mouse/touch look + input buffering. */
  updateLook(yawDelta: number, pitchDelta: number): void {
    this.yaw += yawDelta;
    this.pitch = clamp(this.pitch + pitchDelta, -89 * DEG, 89 * DEG);
  }

  bufferInput(input: Input): void {
    if (input.jumpPressed) this.jumpBufferTimer = cfg.jumpBuffer;
  }

  fixedUpdate(dt: number, input: Input): void {
    this.prevFeet.copy(this.feet);
    this.jumpBufferTimer -= dt;
    this.coyoteTimer -= dt;
    this.jumpCooldown -= dt;

    // --- Crouch ---
    const wantCrouch = input.crouchHeld;
    if (wantCrouch) this.crouching = true;
    else if (this.crouching && this.canStand()) this.crouching = false;
    this.crouchAmount = moveTowards(this.crouchAmount, this.crouching ? 1 : 0, cfg.crouchTransitionSpeed * dt * 0.6);
    const targetHeight = cfg.standHeight + (cfg.crouchHeight - cfg.standHeight) * this.crouchAmount;
    if (Math.abs(targetHeight - this.height) > 1e-4) {
      this.height = targetHeight;
      this.collider.setHalfHeight(Math.max(0.05, this.height / 2 - cfg.radius));
      this.body.setTranslation({ x: this.feet.x, y: this.feet.y + this.height / 2, z: this.feet.z }, true);
    }
    const targetEye = cfg.standEyeHeight + (cfg.crouchEyeHeight - cfg.standEyeHeight) * this.crouchAmount;
    this.eyeHeight += (targetEye - this.eyeHeight) * damp(cfg.crouchTransitionSpeed, dt);

    // --- Wish direction ---
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = -fz;
    const rz = fx;
    this.wish.set(fx * input.moveY + rx * input.moveX, 0, fz * input.moveY + rz * input.moveX);
    const inputMag = Math.min(1, this.wish.length());
    if (inputMag > 0.001) this.wish.divideScalar(Math.max(1, this.wish.length()));

    this.sprinting =
      input.sprintHeld && input.moveY > 0.3 && !this.crouching && !this.sprintBlocked && (this.grounded || this.sprinting);

    let maxSpeed = this.crouching ? cfg.crouchSpeed : this.sprinting ? cfg.sprintSpeed : cfg.walkSpeed;
    maxSpeed *= 1 + (cfg.adsSpeedMultiplier - 1) * this.adsAmount;
    const wishVx = this.wish.x * maxSpeed;
    const wishVz = this.wish.z * maxSpeed;

    // --- Horizontal acceleration ---
    const v = this.velocity;
    if (this.grounded) {
      const rate = inputMag > 0.01 ? cfg.groundAcceleration : cfg.groundDeceleration;
      const dx = wishVx - v.x;
      const dz = wishVz - v.z;
      const dl = Math.hypot(dx, dz);
      const step = rate * dt;
      if (dl <= step) {
        v.x = wishVx;
        v.z = wishVz;
      } else {
        v.x += (dx / dl) * step;
        v.z += (dz / dl) * step;
      }
    } else if (inputMag > 0.01) {
      // Air: steer toward wish velocity without exceeding current/target speed.
      const before = Math.hypot(v.x, v.z);
      v.x += this.wish.x * cfg.airAcceleration * dt;
      v.z += this.wish.z * cfg.airAcceleration * dt;
      const after = Math.hypot(v.x, v.z);
      const cap = Math.max(before, maxSpeed);
      if (after > cap) {
        v.x *= cap / after;
        v.z *= cap / after;
      }
    }

    // --- Jump ---
    const canJump = (this.grounded || this.coyoteTimer > 0) && this.jumpCooldown <= 0;
    if (this.jumpBufferTimer > 0 && canJump) {
      if (this.crouching && this.canStand()) this.crouching = false;
      v.y = cfg.jumpVelocity;
      this.grounded = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      this.jumpCooldown = 0.15;
      this.onJump?.();
    }

    // --- Gravity ---
    v.y -= cfg.gravity * dt;

    // --- Collide & slide ---
    const desired = this.tmp.copy(v).multiplyScalar(dt);
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.playerQuery);
    let move = this.controller.computedMovement();
    // Rapier sometimes reports the floor itself as a blocking contact when the capsule
    // dips a millimetre into its skin, cancelling a whole step of movement (a visible
    // hitch). If ONLY floor contacts blocked us, retry with a tiny lift.
    const wantH = Math.hypot(desired.x, desired.z);
    if (wantH > 1e-4 && Math.hypot(move.x, move.z) < wantH * 0.5 && this.onlyFloorContacts()) {
      desired.y = Math.max(desired.y, 0) + 0.004;
      this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.playerQuery);
      move = this.controller.computedMovement();
    }
    const wasGrounded = this.grounded;
    const fallSpeed = -v.y;
    this.grounded = this.controller.computedGrounded() && v.y <= 0.01;

    // Velocity response comes ONLY from real obstacles: remove the velocity component
    // pointing into walls (slide along them) and stop upward motion at ceilings.
    // Floor contacts never touch horizontal velocity, otherwise grazing the ground
    // makes the character hitch while walking.
    for (let i = 0, n = this.controller.numComputedCollisions(); i < n; i++) {
      const c = this.controller.computedCollision(i, this.collision);
      if (!c) continue;
      const nx = c.normal1.x;
      const ny = c.normal1.y;
      const nz = c.normal1.z;
      if (Math.abs(ny) < 0.7) {
        const hl = Math.hypot(nx, nz) || 1;
        const into = (v.x * nx + v.z * nz) / hl;
        if (into < 0) {
          v.x -= (nx / hl) * into;
          v.z -= (nz / hl) * into;
        }
      } else if (ny < -0.7 && v.y > 0) {
        v.y = 0;
      }
    }

    if (this.grounded) {
      v.y = -0.5; // keep a little downward pressure so ground detection stays stable
      this.coyoteTimer = cfg.coyoteTime;
      this.airTime = 0;
      if (!wasGrounded && fallSpeed > 2) this.onLand?.(fallSpeed);
    } else {
      this.airTime += dt;
    }

    this.feet.x += move.x;
    this.feet.y += move.y;
    this.feet.z += move.z;
    this.body.setNextKinematicTranslation({ x: this.feet.x, y: this.feet.y + this.height / 2, z: this.feet.z });

    const hSpeed = Math.hypot(move.x, move.z) / dt;
    this.speedRatio = hSpeed / cfg.walkSpeed;
    if (this.grounded) this.bobPhase += hSpeed * dt * (Math.PI / 1.9) * cfg.cameraBobFrequency;

    // Safety net: fell out of the world.
    if (this.feet.y < -30) this.teleport(new THREE.Vector3(0, 1, 6), 0);
  }

  teleport(pos: THREE.Vector3, yaw: number): void {
    this.feet.copy(pos);
    this.feet.y += SPAWN_LIFT;
    this.prevFeet.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.prevFeet.copy(this.feet);
    this.body.setTranslation({ x: this.feet.x, y: this.feet.y + this.height / 2, z: this.feet.z }, true);
  }

  /** Interpolated eye position for rendering. */
  getEyePosition(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    return out.lerpVectors(this.prevFeet, this.feet, alpha).setY(
      this.prevFeet.y + (this.feet.y - this.prevFeet.y) * alpha + this.eyeHeight,
    );
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  private onlyFloorContacts(): boolean {
    const n = this.controller.numComputedCollisions();
    if (n === 0) return false;
    for (let i = 0; i < n; i++) {
      const c = this.controller.computedCollision(i, this.collision);
      if (c && c.normal1.y < 0.7) return false;
    }
    return true;
  }

  private canStand(): boolean {
    const headroom = cfg.standHeight - this.height + 0.05;
    if (headroom <= 0.06) return true;
    const top = this.feet.y + this.height - 0.05;
    const offsets = [0, cfg.radius * 0.7, -cfg.radius * 0.7];
    for (const ox of offsets) {
      for (const oz of offsets) {
        if (ox !== 0 && oz !== 0) continue;
        this.upRay.origin = { x: this.feet.x + ox, y: top, z: this.feet.z + oz };
        const hit = this.physics.world.castRay(this.upRay, headroom, true, undefined, GROUPS.playerQuery, this.collider);
        if (hit) return false;
      }
    }
    return true;
  }
}
