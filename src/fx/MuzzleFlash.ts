import * as THREE from 'three';
import { flashSideTexture, flashStarTexture } from './Textures';

const FLASH_LIFE = 0.05;

/**
 * Short, bright, randomized flash attached to the viewmodel muzzle.
 * One front star + two crossed side flames + a point light that lights the gun.
 * Meshes are created once and only re-parented on weapon switch.
 */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private front: THREE.Mesh;
  private sides: THREE.Mesh[] = [];
  private age = 99;
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
    this.front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(flashStarTexture()));
    this.group.add(this.front);
    const sideGeo = new THREE.PlaneGeometry(1, 1);
    sideGeo.translate(0, 0.5, 0);
    sideGeo.rotateX(-Math.PI / 2); // flame extends along -Z (out of the barrel)
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(sideGeo, additive(flashSideTexture()));
      m.rotation.z = i * (Math.PI / 2);
      this.sides.push(m);
      this.group.add(m);
    }
    // Light lives outside the toggled group: hiding a light changes the light count,
    // which would force shader recompiles (a hitch) on every shot.
    this.light = new THREE.PointLight(0xffb060, 0, 1.2, 2);
    this.group.visible = false;
    this.group.traverse((o) => (o.frustumCulled = false));
  }

  attachTo(muzzle: THREE.Object3D): void {
    muzzle.add(this.group);
    muzzle.add(this.light);
  }

  trigger(scale: number): void {
    this.age = 0;
    this.scale = scale * (0.8 + Math.random() * 0.4);
    this.group.rotation.z = Math.random() * Math.PI * 2;
    const s = this.scale;
    this.front.scale.setScalar(0.14 * s);
    for (const side of this.sides) side.scale.set(0.08 * s, 0.2 * s * (0.8 + Math.random() * 0.5), 1);
    this.group.visible = true;
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age > FLASH_LIFE) {
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    const k = 1 - this.age / FLASH_LIFE;
    this.front.scale.setScalar(0.14 * this.scale * (0.7 + 0.3 * k));
    (this.front.material as THREE.MeshBasicMaterial).opacity = k;
    for (const s of this.sides) (s.material as THREE.MeshBasicMaterial).opacity = k;
    this.light.intensity = 3.5 * k * this.scale;
  }
}
