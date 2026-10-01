import * as THREE from 'three';
import { flashSideTexture, flashVariant, glowTexture } from './Textures';

const VARIANTS = 4;

/**
 * Short, bright, never-identical flash attached to the viewmodel muzzle:
 * a randomly chosen star (4 generated variants), two crossed side flames, a
 * soft bloom glow and a point light that lights the gun. Lasts ~2 frames.
 * Meshes are created once and only re-parented on weapon switch.
 */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private front: THREE.Mesh;
  private glow: THREE.Mesh;
  private sides: THREE.Mesh[] = [];
  private stars: THREE.Texture[] = [];
  private age = 99;
  private life = 0.05;
  private scale = 1;

  constructor() {
    const additive = (tex: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    for (let i = 0; i < VARIANTS; i++) this.stars.push(flashVariant(i));
    this.front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(this.stars[0]));
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(glowTexture()));
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.6;
    this.group.add(this.glow, this.front);
    const sideGeo = new THREE.PlaneGeometry(1, 1);
    sideGeo.translate(0, 0.5, 0);
    sideGeo.rotateX(-Math.PI / 2); // flame extends along -Z (out of the barrel)
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(sideGeo, additive(flashSideTexture()));
      m.rotation.z = i * (Math.PI / 3);
      this.sides.push(m);
      this.group.add(m);
    }
    // Light lives outside the toggled group: hiding a light changes the light count,
    // which would force shader recompiles (a hitch) on every shot.
    this.light = new THREE.PointLight(0xffb060, 0, 1.6, 2);
    this.group.visible = false;
    this.group.traverse((o) => (o.frustumCulled = false));
  }

  attachTo(muzzle: THREE.Object3D): void {
    muzzle.add(this.group);
    muzzle.add(this.light);
  }

  trigger(scale: number): void {
    this.age = 0;
    this.life = 0.04 + Math.random() * 0.025;
    this.scale = scale * (0.8 + Math.random() * 0.45);
    this.group.rotation.z = Math.random() * Math.PI * 2;
    (this.front.material as THREE.MeshBasicMaterial).map = this.stars[(Math.random() * VARIANTS) | 0];
    const s = this.scale;
    this.front.scale.setScalar(0.15 * s);
    this.glow.scale.setScalar(0.32 * s);
    this.glow.position.z = -0.03 * s;
    for (const side of this.sides) side.scale.set(0.075 * s * (0.8 + Math.random() * 0.4), 0.24 * s * (0.7 + Math.random() * 0.6), 1);
    // Full brightness on the very first frame (update() only fades afterwards).
    (this.front.material as THREE.MeshBasicMaterial).opacity = 1;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.6;
    for (const side of this.sides) (side.material as THREE.MeshBasicMaterial).opacity = 1;
    this.light.intensity = 5 * s;
    this.group.visible = true;
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age > this.life) {
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    const k = 1 - this.age / this.life;
    const k2 = k * k;
    this.front.scale.setScalar(0.15 * this.scale * (0.75 + 0.25 * k));
    (this.front.material as THREE.MeshBasicMaterial).opacity = k;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.6 * k2;
    for (const s of this.sides) (s.material as THREE.MeshBasicMaterial).opacity = k2;
    this.light.intensity = 5 * k * this.scale;
  }
}
