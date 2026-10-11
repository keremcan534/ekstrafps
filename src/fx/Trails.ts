import * as THREE from 'three';

const CAPACITY = 3000;

/**
 * Bullet streaks: short, bright, gone in a few frames (a glimpse of the round,
 * not a laser line). Each segment can fade to black at its tail, so a streak is
 * a hot head with a soft tail. Ring buffer of line segments, additive. A dead
 * segment is collapsed to a point (black alone wasn't enough: fog mixes black
 * toward the fog colour, so old streaks lingered as faint lines in the haze).
 * Only the ring's live stretch is walked and uploaded, and with nothing alive the
 * lines aren't drawn at all.
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
  /** The oldest slot that may still be alive: live segments all lie in [oldest, next) round the ring. */
  private oldest = 0;
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
    this.mesh.visible = false;
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
    if (this.life[i] <= 0) {
      if (this.alive === 0) this.oldest = i;
      this.alive++;
    }
    this.mesh.visible = true;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.fadeTail[i] = fadeTail ? 1 : 0;
  }

  update(dt: number): void {
    if (this.alive === 0) {
      this.mesh.visible = false;
      return;
    }
    let alive = 0;
    // From the oldest live slot round to the newest; the stretch shrinks from its old end.
    const start = this.oldest;
    const count = (this.next - start + CAPACITY) % CAPACITY || CAPACITY;
    let lead = true;
    for (let n = 0; n < count; n++) {
      const i = (start + n) % CAPACITY;
      if (this.life[i] <= 0) {
        if (lead) this.oldest = (i + 1) % CAPACITY;
        continue;
      }
      this.life[i] -= dt;
      const i6 = i * 6;
      if (this.life[i] <= 0) {
        this.colors.fill(0, i6, i6 + 6);
        this.positions.copyWithin(i6 + 3, i6, i6 + 3);
        if (lead) this.oldest = (i + 1) % CAPACITY;
        continue;
      }
      lead = false;
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
    // Upload only the stretch walked (new segments are in it too), in two pieces where it wraps.
    const first = Math.min(count, CAPACITY - start);
    for (const a of [this.posAttr, this.colAttr]) {
      a.addUpdateRange(start * 6, first * 6);
      if (count > first) a.addUpdateRange(0, (count - first) * 6);
      a.needsUpdate = true;
    }
  }
}
