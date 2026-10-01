import * as THREE from 'three';

const CAPACITY = 1024; // line segments

interface Persistent {
  a: THREE.Vector3;
  b: THREE.Vector3;
  color: THREE.Color;
  life: number;
  maxLife: number;
}

/**
 * Immediate-mode debug lines, drawn in their own pass on top of everything
 * (including the weapon) so aim rays and probes are always visible.
 * `line()` lasts one frame; `persistent()` fades out over `life` seconds.
 */
export class DebugDraw {
  readonly scene = new THREE.Scene();
  enabled = false;
  private positions = new Float32Array(CAPACITY * 6);
  private colors = new Float32Array(CAPACITY * 6);
  private geometry = new THREE.BufferGeometry();
  private count = 0;
  private persistentLines: Persistent[] = [];
  private tmpColor = new THREE.Color();
  private ca = new THREE.Vector3();
  private cb = new THREE.Vector3();

  constructor() {
    const pos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('color', col);
    const lines = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }),
    );
    lines.frustumCulled = false;
    this.scene.add(lines);
  }

  line(a: THREE.Vector3, b: THREE.Vector3, color: number | THREE.Color, brightness = 1): void {
    if (!this.enabled || this.count >= CAPACITY) return;
    const c = typeof color === 'number' ? this.tmpColor.setHex(color) : this.tmpColor.copy(color);
    const i = this.count * 6;
    this.positions[i] = a.x;
    this.positions[i + 1] = a.y;
    this.positions[i + 2] = a.z;
    this.positions[i + 3] = b.x;
    this.positions[i + 4] = b.y;
    this.positions[i + 5] = b.z;
    for (let k = 0; k < 2; k++) {
      this.colors[i + k * 3] = c.r * brightness;
      this.colors[i + k * 3 + 1] = c.g * brightness;
      this.colors[i + k * 3 + 2] = c.b * brightness;
    }
    this.count++;
  }

  /** Small 3-axis cross marker. */
  cross(p: THREE.Vector3, size: number, color: number): void {
    const a = this.ca;
    const b = this.cb;
    for (let axis = 0; axis < 3; axis++) {
      a.copy(p);
      b.copy(p);
      a.setComponent(axis, a.getComponent(axis) - size);
      b.setComponent(axis, b.getComponent(axis) + size);
      this.line(a, b, color);
    }
  }

  /** Line that stays visible and fades (bullet trajectories). */
  persistent(a: THREE.Vector3, b: THREE.Vector3, color: number, life: number): void {
    if (!this.enabled) return;
    if (this.persistentLines.length > 400) this.persistentLines.shift();
    this.persistentLines.push({ a: a.clone(), b: b.clone(), color: new THREE.Color(color), life, maxLife: life });
  }

  /** Call once per frame after all lines were submitted, before rendering. */
  flush(dt: number): void {
    for (let i = this.persistentLines.length - 1; i >= 0; i--) {
      const l = this.persistentLines[i];
      l.life -= dt;
      if (l.life <= 0) {
        this.persistentLines.splice(i, 1);
        continue;
      }
      this.line(l.a, l.b, l.color, 0.25 + 0.75 * (l.life / l.maxLife));
    }
    this.geometry.setDrawRange(0, this.count * 2);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.count = 0;
  }
}
