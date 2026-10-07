import * as THREE from 'three';
import { damp } from '../core/math';

const WHITE = new THREE.Color(1, 1, 1);

/**
 * How much light reaches the gun in your hands, from the world around you.
 *
 * The weapon is drawn in its own scene with its own lights (it must read as parts and
 * edges, not a black mass). Left alone those lights make it glow in a blacked-out
 * corridor. This sums the world's lights at the point in front of the eye where the gun
 * is: the fill (hemisphere, ambient, image-based), the moon / sun, and every lamp,
 * emergency light, flashlight and muzzle flash with its falloff and cone. The result is
 * a level (1: a lit room) and the colour of that light, eased over a few frames.
 */
export class ViewLight {
  /** Current level: 1 = lit like a lit room, less in the dark. */
  level = 1;
  /** Colour of the light around you (white in a lit room, red in a blackout). */
  readonly color = new THREE.Color(1, 1, 1);
  private lights: THREE.Light[] = [];
  private listAge = Infinity;
  private target = 1;
  private targetColor = new THREE.Color(1, 1, 1);
  private p = new THREE.Vector3();
  private at = new THREE.Vector3();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private sum = new THREE.Color();
  private c = new THREE.Color();

  /**
   * @param lit the summed light (see `measure`) at which the gun gets its full lighting
   * @param floor the least it ever gets (the eye adapts; a gun never turns pure black)
   */
  constructor(
    private scene: THREE.Scene,
    private lit: number,
    private floor = 0.14,
  ) {}

  /** Sum of the world's light at `at` (luminance-weighted; the colour into `color`). */
  measure(at: THREE.Vector3, color: THREE.Color): number {
    const s = this.sum.setRGB(0, 0, 0);
    const add = (col: THREE.Color, k: number) => {
      if (k <= 0) return;
      s.r += col.r * k;
      s.g += col.g * k;
      s.b += col.b * k;
    };
    // Image-based fill: most of the indoor light.
    add(this.c.setRGB(1, 1, 1), this.scene.environment ? this.scene.environmentIntensity * 0.6 : 0);
    for (const l of this.lights) {
      if (!l.visible || l.intensity <= 0 || !this.onStage(l)) continue;
      if ((l as THREE.HemisphereLight).isHemisphereLight) {
        const h = l as THREE.HemisphereLight;
        add(this.c.copy(h.color).lerp(h.groundColor, 0.5), h.intensity);
      } else if ((l as THREE.AmbientLight).isAmbientLight || (l as THREE.LightProbe).isLightProbe) {
        add(this.c.setRGB(1, 1, 1), l.intensity * ((l as THREE.LightProbe).isLightProbe ? 0.6 : 1));
      } else if ((l as THREE.DirectionalLight).isDirectionalLight) {
        // Moon / sun: walls and roofs stand in the way more often than not.
        add(l.color, l.intensity * 0.35);
      } else if ((l as THREE.PointLight).isPointLight || (l as THREE.SpotLight).isSpotLight) {
        const pl = l as THREE.PointLight;
        l.getWorldPosition(this.v);
        const dist = Math.max(0.5, this.v.distanceTo(at));
        const cut = pl.distance > 0 ? Math.max(0, 1 - (dist / pl.distance) ** 4) ** 2 : 1;
        let k = (pl.intensity * cut) / Math.max(dist ** pl.decay, 0.01);
        if ((l as THREE.SpotLight).isSpotLight) {
          const sp = l as THREE.SpotLight;
          sp.target.getWorldPosition(this.d).sub(this.v).normalize();
          const cos = this.p.copy(at).sub(this.v).normalize().dot(this.d);
          const outer = Math.cos(sp.angle);
          const inner = Math.cos(sp.angle * (1 - sp.penumbra));
          k *= THREE.MathUtils.smoothstep(cos, outer, inner);
        }
        // Your own flashlight starts at the gun: the beam goes ahead, the gun gets its spill.
        if (this.v.distanceTo(at) < 1) k = Math.min(k, this.lit * 0.35);
        add(l.color, k);
      }
    }
    const lum = 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;
    if (lum > 1e-5) color.setRGB(s.r / lum, s.g / lum, s.b / lum);
    else color.setRGB(1, 1, 1);
    return lum;
  }

  /** A light hidden with its parent (a room not drawn) lights nothing. */
  private onStage(l: THREE.Object3D): boolean {
    for (let o: THREE.Object3D | null = l; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  /** Once a frame: `eye` and the camera's forward / up give where the gun is. */
  update(dt: number, eye: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    this.listAge += dt;
    if (this.listAge > 2) {
      // Lights come and go with the map (practical lights are parked, not added): a slow refresh.
      this.listAge = 0;
      this.lights = [];
      this.scene.traverse((o) => {
        if ((o as THREE.Light).isLight) this.lights.push(o as THREE.Light);
      });
    }
    const at = this.at.copy(eye).addScaledVector(forward, 0.45).addScaledVector(up, -0.15);
    const lum = this.measure(at, this.targetColor);
    // The eye adapts: the dark is darker for the gun, but never black.
    this.target = Math.max(this.floor, Math.min(1, (lum / this.lit) ** 0.6));
    const k = damp(5, dt);
    this.level += (this.target - this.level) * k;
    // Pale the colour: the gun's own lights keep it readable, only the hue of the room shows.
    this.c.copy(this.targetColor);
    const m = Math.max(this.c.r, this.c.g, this.c.b);
    this.c.multiplyScalar(1 / Math.max(m, 1e-5)).lerp(WHITE, 0.45);
    this.color.lerp(this.c, k);
  }
}
