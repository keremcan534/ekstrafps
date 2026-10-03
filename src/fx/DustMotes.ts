import * as THREE from 'three';

/**
 * Dust hanging in the air around the camera: a few hundred soft specks in a box
 * that wraps around you (endless, no spawning), drifting and slowly turning over.
 * Additive and faint; the lamps and your flashlight make it read. Fades out in a
 * blackout (nothing lights it).
 */
export class DustMotes {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private phase: Float32Array;
  private mat: THREE.PointsMaterial;
  private time = 0;
  private static readonly SIZE = 22;
  private static readonly HEIGHT = 7;

  constructor(count: number) {
    const S = DustMotes.SIZE;
    this.pos = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * S;
      this.pos[i * 3 + 1] = Math.random() * DustMotes.HEIGHT;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * S;
      this.phase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.PointsMaterial({
      map: speck(),
      color: 0xd9d2c4,
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /** @param darkness 0 = lights on … 1 = blackout. */
  update(dt: number, eye: THREE.Vector3, darkness: number): void {
    this.time += dt;
    const S = DustMotes.SIZE;
    const H = DustMotes.HEIGHT;
    const p = this.pos;
    const t = this.time;
    for (let i = 0, n = this.phase.length; i < n; i++) {
      const ph = this.phase[i];
      // Slow Brownian-ish drift: a gentle sink plus a lazy swirl.
      p[i * 3] += Math.sin(t * 0.21 + ph) * 0.05 * dt;
      p[i * 3 + 1] += (Math.sin(t * 0.17 + ph * 1.7) * 0.03 - 0.012) * dt;
      p[i * 3 + 2] += Math.cos(t * 0.19 + ph * 1.3) * 0.05 * dt;
      // Wrap into the box around the eye.
      const dx = p[i * 3] - eye.x;
      if (dx > S / 2) p[i * 3] -= S;
      else if (dx < -S / 2) p[i * 3] += S;
      const dz = p[i * 3 + 2] - eye.z;
      if (dz > S / 2) p[i * 3 + 2] -= S;
      else if (dz < -S / 2) p[i * 3 + 2] += S;
      if (p[i * 3 + 1] < 0) p[i * 3 + 1] += H;
      else if (p[i * 3 + 1] > H) p[i * 3 + 1] -= H;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mat.opacity = 0.5 * (1 - 0.85 * darkness);
  }
}

/** Soft round speck. */
function speck(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
