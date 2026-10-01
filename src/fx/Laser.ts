import * as THREE from 'three';

/**
 * Visible test laser. It is mounted on the weapon and runs parallel to the bore,
 * so it shows exactly where the physical gun points. This is the main tool for
 * learning point fire.
 * The beam is a world-space line from the emitter to the first surface, plus a
 * glowing dot at the hit point.
 */
export class Laser {
  readonly group = new THREE.Group();
  enabled = false;
  private beam: THREE.Line;
  private dot: THREE.Sprite;
  private positions: Float32Array;

  constructor() {
    this.positions = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.beam = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.beam.frustumCulled = false;

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.15, 'rgba(255,60,60,1)');
    g.addColorStop(0.45, 'rgba(255,0,0,0.35)');
    g.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.dot = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
        toneMapped: false,
      }),
    );
    this.dot.scale.setScalar(0.022);
    this.dot.renderOrder = 5;
    this.group.add(this.beam, this.dot);
    this.group.visible = false;
  }

  update(from: THREE.Vector3, to: THREE.Vector3, hitSomething: boolean): void {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    const p = this.positions;
    p[0] = from.x;
    p[1] = from.y;
    p[2] = from.z;
    p[3] = to.x;
    p[4] = to.y;
    p[5] = to.z;
    (this.beam.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.dot.visible = hitSomething;
    // Pull the dot slightly toward the shooter so it never z-fights the surface.
    this.dot.position.copy(to).lerp(from, 0.002);
  }
}
