import * as THREE from 'three';

/**
 * Pooled GPU-instanced particles. Each particle is a camera-facing quad that
 * stretches along its screen-space velocity, so the same system draws sparks,
 * tracers (very fast single particles), dust, debris and smoke.
 *
 * Zero allocations per spawn: fixed-capacity typed arrays, swap-remove on death.
 */

export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  sizeEnd: number;
  /** Extra length per m/s of screen velocity (0 = round). */
  stretch: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  gravity: number;
  drag: number;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iColor;
attribute vec2 iSize;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
  // Screen-space velocity direction, accounting for perspective.
  vec2 dir = vv.xy - mv.xy * (vv.z / mv.z);
  float len = length(dir);
  vec2 ay = len > 1e-4 ? dir / len : vec2(0.0, 1.0);
  vec2 ax = vec2(-ay.y, ay.x);
  float stretch = iSize.x + len * iSize.y;
  mv.xy += ax * position.x * iSize.x + ay * position.y * stretch;
  vUv = uv;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
varying vec2 vUv;
uniform float uSoftness;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  float a = 1.0 - smoothstep(1.0 - uSoftness, 1.0, d);
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

const STRIDE_POS = 3;

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private count = 0;
  private readonly capacity: number;
  // Simulation state
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private sizeStart: Float32Array;
  private sizeEnd: Float32Array;
  private stretch: Float32Array;
  private alpha0: Float32Array;
  private gravity: Float32Array;
  private drag: Float32Array;
  private posAttr: THREE.InstancedBufferAttribute;
  private velAttr: THREE.InstancedBufferAttribute;
  private colAttr: THREE.InstancedBufferAttribute;
  private sizeAttr: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;

  constructor(capacity: number, blending: 'additive' | 'normal', softness = 0.6) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity * 2);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.sizeStart = new Float32Array(capacity);
    this.sizeEnd = new Float32Array(capacity);
    this.stretch = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setAttribute('uv', base.getAttribute('uv'));
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.velAttr = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 2).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPos', this.posAttr);
    this.geometry.setAttribute('iVel', this.velAttr);
    this.geometry.setAttribute('iColor', this.colAttr);
    this.geometry.setAttribute('iSize', this.sizeAttr);
    this.geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uSoftness: { value: softness } },
      transparent: true,
      depthWrite: false,
      blending: blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = blending === 'additive' ? 3 : 2;
  }

  get alive(): number {
    return this.count;
  }

  spawn(p: ParticleSpawn): void {
    let i = this.count;
    if (i >= this.capacity) {
      // Pool full: overwrite a random live slot rather than dropping the new effect.
      i = Math.floor(Math.random() * this.capacity);
    } else {
      this.count++;
    }
    const i3 = i * STRIDE_POS;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx;
    this.vel[i3 + 1] = p.vy;
    this.vel[i3 + 2] = p.vz;
    const i4 = i * 4;
    this.col[i4] = p.r;
    this.col[i4 + 1] = p.g;
    this.col[i4 + 2] = p.b;
    this.col[i4 + 3] = p.alpha;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.sizeStart[i] = p.size;
    this.sizeEnd[i] = p.sizeEnd;
    this.stretch[i] = p.stretch;
    this.alpha0[i] = p.alpha;
    this.gravity[i] = p.gravity;
    this.drag[i] = p.drag;
    this.size[i * 2] = p.size;
    this.size[i * 2 + 1] = p.stretch;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.copySlot(this.count - 1, i);
        this.count--;
        continue;
      }
      const i3 = i * 3;
      const drag = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= drag;
      this.vel[i3 + 1] = this.vel[i3 + 1] * drag - this.gravity[i] * dt;
      this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i * 2] = this.sizeStart[i] + (this.sizeEnd[i] - this.sizeStart[i]) * t;
      // Fade out over the last 60% of life.
      this.col[i * 4 + 3] = this.alpha0[i] * Math.min(1, (1 - t) / 0.6);
      i++;
    }
    this.geometry.instanceCount = this.count;
    if (this.count > 0) {
      this.posAttr.addUpdateRange(0, this.count * 3);
      this.velAttr.addUpdateRange(0, this.count * 3);
      this.colAttr.addUpdateRange(0, this.count * 4);
      this.sizeAttr.addUpdateRange(0, this.count * 2);
      this.posAttr.needsUpdate = true;
      this.velAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
  }

  private copySlot(from: number, to: number): void {
    if (from === to) return;
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.size[to * 2] = this.size[from * 2];
    this.size[to * 2 + 1] = this.size[from * 2 + 1];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.sizeStart[to] = this.sizeStart[from];
    this.sizeEnd[to] = this.sizeEnd[from];
    this.stretch[to] = this.stretch[from];
    this.alpha0[to] = this.alpha0[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
  }
}

/** Reusable spawn descriptor so callers never allocate. */
export const spawnParams = (): ParticleSpawn => ({
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.05, sizeEnd: 0.05, stretch: 0,
  r: 1, g: 1, b: 1, alpha: 1, gravity: 0, drag: 0,
});
