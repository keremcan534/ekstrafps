import * as THREE from 'three';

/**
 * A few shared point lights for AI muzzle flashes.
 *
 * Every light in the scene is part of every lit shader. A light per soldier meant
 * the light count changed whenever a soldier spawned or walked into a culled
 * (hidden) room, and each change recompiles every material: a 1-2 s freeze.
 * These lights never leave the scene; a flash borrows the oldest one.
 */
export class MuzzleLights {
  readonly group = new THREE.Group();
  private lights: { l: THREE.PointLight; life: number }[] = [];
  private next = 0;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 2.8, 2);
      this.group.add(l);
      this.lights.push({ l, life: 0 });
    }
  }

  flash(at: THREE.Vector3, listener: THREE.Vector3): void {
    if (!this.lights.length || at.distanceToSquared(listener) > 45 * 45) return;
    const s = this.lights[this.next];
    this.next = (this.next + 1) % this.lights.length;
    s.l.position.copy(at);
    s.life = 0.06;
  }

  update(dt: number): void {
    for (const s of this.lights) {
      s.life = Math.max(0, s.life - dt);
      s.l.intensity = s.life > 0 ? (s.life / 0.06) * 5 : 0;
    }
  }
}
