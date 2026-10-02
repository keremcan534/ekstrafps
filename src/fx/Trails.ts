import * as THREE from 'three';

const CAPACITY = 3000;

/**
 * Bullet streaks: short, bright, gone in a few frames (a glimpse of the round,
 * not a laser line). Each segment can fade to black at its tail, so a streak is
 * a hot head with a soft tail. Ring buffer of line segments, additive (dead
 * segments are simply black).
 */
export class Trails {
  readonly mesh: THREE.LineSegments;
  private positions = new Float32Array(CAPACITY * 6);
  private colors = new Float32Array(CAPACITY * 6);
  private base = new Float32Array(CAPACITY * 3);
  private life = new Float32Array(CAPACITY);
  private maxLife = new Float32Array(CAPACITY);
  /** 1 = the start vertex fades to black (streak tail). */
  private fadeTail = new Uint8Array(CAPACITY);
  private next = 0;
  private alive = 0;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    this.mesh = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  add(a: THREE.Vector3, b: THREE.Vector3, r: number, g: number, bl: number, life: number, fadeTail = false): void {
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    const i6 = i * 6;
    this.positions[i6] = a.x;
    this.positions[i6 + 1] = a.y;
    this.positions[i6 + 2] = a.z;
    this.positions[i6 + 3] = b.x;
    this.positions[i6 + 4] = b.y;
    this.positions[i6 + 5] = b.z;
    this.base[i * 3] = r;
    this.base[i * 3 + 1] = g;
    this.base[i * 3 + 2] = bl;
    if (this.life[i] <= 0) this.alive++;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.fadeTail[i] = fadeTail ? 1 : 0;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i6 = i * 6;
      if (this.life[i] <= 0) {
        this.colors.fill(0, i6, i6 + 6);
        continue;
      }
      alive++;
      const k = this.life[i] / this.maxLife[i];
      const f = k * k;
      const r = this.base[i * 3] * f;
      const g = this.base[i * 3 + 1] * f;
      const b = this.base[i * 3 + 2] * f;
      const t = this.fadeTail[i] ? 0 : 1;
      this.colors[i6] = r * t;
      this.colors[i6 + 1] = g * t;
      this.colors[i6 + 2] = b * t;
      // The newer end of the segment is a little brighter: gives the trail direction.
      this.colors[i6 + 3] = Math.min(1, r * 1.3);
      this.colors[i6 + 4] = Math.min(1, g * 1.3);
      this.colors[i6 + 5] = Math.min(1, b * 1.3);
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
}
