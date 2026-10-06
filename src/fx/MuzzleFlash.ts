import * as THREE from 'three';
import { fireGlowTexture, fireSideTexture, fireStarTexture, smokePuffTexture } from './FireTextures';

const STARS = 6;
const SIDES = 4;

/**
 * Short, bright, never-identical muzzle fire attached to a muzzle: a fire star seen down the
 * bore (one of six noise-drawn variants, turned at random), three crossed jets of flame out
 * of the muzzle (each its own variant), a warm bloom and a point light that lights the gun,
 * for 2–4 frames; then a wisp of powder smoke that drifts off and thins for half a second.
 * Meshes are created once and only re-parented on weapon switch.
 */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private front: THREE.Mesh;
  private glow: THREE.Mesh;
  private sides: THREE.Mesh[] = [];
  private stars: THREE.Texture[] = [];
  private jets: THREE.Texture[] = [];
  private smoke: THREE.Sprite;
  private smokeAge = 99;
  private smokeLife = 0.5;
  private age = 99;
  private life = 0.05;
  private scale = 1;

  /** @param lightDistance reach of the flash light (world-space flashes light up more). */
  constructor(lightDistance = 1.6, private withLight = true) {
    const additive = (tex: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    for (let i = 0; i < STARS; i++) this.stars.push(fireStarTexture(i));
    for (let i = 0; i < SIDES; i++) this.jets.push(fireSideTexture(i));
    this.front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(this.stars[0]));
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(fireGlowTexture()));
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.55;
    this.group.add(this.glow, this.front);
    const sideGeo = new THREE.PlaneGeometry(1, 1);
    sideGeo.translate(0, 0.5, 0);
    sideGeo.rotateX(-Math.PI / 2); // flame extends along -Z (out of the barrel)
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(sideGeo, additive(this.jets[i % SIDES]));
      m.rotation.z = i * (Math.PI / 3);
      this.sides.push(m);
      this.group.add(m);
    }
    // Light lives outside the toggled group: hiding a light changes the light count,
    // which would force shader recompiles (a hitch) on every shot.
    this.light = new THREE.PointLight(0xffa850, 0, lightDistance, 2);
    this.group.visible = false;
    this.group.traverse((o) => (o.frustumCulled = false));
    this.smoke = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokePuffTexture(), color: 0x8a8a88, transparent: true, depthWrite: false, opacity: 0 }));
    this.smoke.frustumCulled = false;
    this.smoke.visible = false;
  }

  attachTo(muzzle: THREE.Object3D): void {
    muzzle.add(this.group);
    muzzle.add(this.smoke);
    if (this.withLight) muzzle.add(this.light);
  }

  trigger(scale: number): void {
    this.age = 0;
    this.life = 0.04 + Math.random() * 0.025;
    this.scale = scale * (0.8 + Math.random() * 0.45);
    this.group.rotation.z = Math.random() * Math.PI * 2;
    (this.front.material as THREE.MeshBasicMaterial).map = this.stars[(Math.random() * STARS) | 0];
    const s = this.scale;
    this.front.scale.setScalar(0.17 * s);
    this.glow.scale.setScalar(0.34 * s);
    this.glow.position.z = -0.03 * s;
    for (const side of this.sides) {
      (side.material as THREE.MeshBasicMaterial).map = this.jets[(Math.random() * SIDES) | 0];
      side.scale.set(0.12 * s * (0.8 + Math.random() * 0.4), 0.19 * s * (0.7 + Math.random() * 0.6), 1);
    }
    // Full brightness on the very first frame (update() only fades afterwards).
    (this.front.material as THREE.MeshBasicMaterial).opacity = 1;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.55;
    for (const side of this.sides) (side.material as THREE.MeshBasicMaterial).opacity = 1;
    this.light.intensity = this.withLight ? 5 * s : 0;
    this.group.visible = true;
    // A fresh wisp of smoke (an automatic keeps feeding the same one).
    this.smokeAge = 0;
    this.smokeLife = 0.4 + Math.random() * 0.25;
    this.smoke.material.rotation = Math.random() * Math.PI * 2;
    this.smoke.visible = true;
  }

  update(dt: number): void {
    this.age += dt;
    this.smokeAge += dt;
    if (this.smokeAge < this.smokeLife) {
      const k = this.smokeAge / this.smokeLife;
      const s = this.scale;
      // Out of the muzzle, slowing, rising a little, spreading and thinning.
      this.smoke.position.set(0, 0.02 * s * k, -0.05 * s - 0.12 * s * (1 - (1 - k) * (1 - k)));
      this.smoke.scale.setScalar((0.06 + 0.2 * Math.sqrt(k)) * s);
      this.smoke.material.opacity = 0.28 * (1 - k) * Math.min(1, this.smokeAge / 0.03);
      this.smoke.material.rotation += dt * 0.6;
    } else this.smoke.visible = false;
    if (this.age > this.life) {
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    const k = 1 - this.age / this.life;
    const k2 = k * k;
    this.front.scale.setScalar(0.17 * this.scale * (0.75 + 0.25 * k));
    (this.front.material as THREE.MeshBasicMaterial).opacity = k;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.55 * k2;
    for (const s of this.sides) (s.material as THREE.MeshBasicMaterial).opacity = k2;
    this.light.intensity = this.withLight ? 5 * k * this.scale : 0;
  }
}
