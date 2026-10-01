import * as THREE from 'three';

/**
 * Damped spring (semi-implicit Euler, sub-stepped for stability at high stiffness).
 * Used everywhere we want things to feel like they physically receive an impulse
 * and settle back: weapon recoil, camera punch, landing dip, hit reactions.
 */
const MAX_STEP = 1 / 240;

export class Spring {
  value = 0;
  velocity = 0;
  target = 0;

  constructor(public stiffness = 200, public damping = 20) {}

  impulse(v: number): void {
    this.velocity += v;
  }

  update(dt: number): number {
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MAX_STEP);
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }
}

/** Three independent springs sharing stiffness/damping. */
export class Spring3 {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly target = new THREE.Vector3();

  constructor(public stiffness = 200, public damping = 20) {}

  impulse(x: number, y: number, z: number): void {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
  }

  update(dt: number): THREE.Vector3 {
    let remaining = Math.min(dt, 0.1);
    const v = this.value;
    const vel = this.velocity;
    const t = this.target;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MAX_STEP);
      const k = this.stiffness;
      const c = this.damping;
      vel.x += (-k * (v.x - t.x) - c * vel.x) * h;
      vel.y += (-k * (v.y - t.y) - c * vel.y) * h;
      vel.z += (-k * (v.z - t.z) - c * vel.z) * h;
      v.x += vel.x * h;
      v.y += vel.y * h;
      v.z += vel.z * h;
      remaining -= h;
    }
    return v;
  }

  reset(): void {
    this.value.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.target.set(0, 0, 0);
  }
}
