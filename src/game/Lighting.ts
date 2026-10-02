import * as THREE from 'three';
import type { Site9 } from '../world/Site9';

/**
 * Facility power and your flashlight.
 *
 * The lights go out during a Black Division raid (until someone restores power at
 * a breaker) or when someone cuts them at a breaker on purpose. Going dark
 * flickers a few times, then the hemisphere/sun/lamps, sky, fog and image-based
 * ambient all drop; red emergency strips keep pulsing. The flashlight switches
 * on by itself when it goes dark and can be toggled any time.
 *
 * The spotlight never leaves the scene (its intensity goes to 0 instead):
 * adding or hiding a light recompiles every shader.
 */
export class Lighting {
  /** A raid is on (the grid is down). */
  private raid = false;
  /** Power restored at a breaker during this raid. */
  private restored = false;
  /** Lights cut at a breaker (no raid needed). */
  private cut = false;
  flashlightOn = false;
  private level = 0;
  private flicker = 9;
  private wasDark = false;
  private flashlight: THREE.SpotLight;
  private sky: THREE.Color;
  private skyBase: THREE.Color;
  private fogBase: THREE.Color | null;
  private envBase: number;
  private dir = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private map: Site9,
    private eye: THREE.Vector3,
    private lookDir: (out: THREE.Vector3) => THREE.Vector3,
    private alive: () => boolean,
  ) {
    this.flashlight = new THREE.SpotLight(0xfff3e2, 0, 46, 0.44, 0.5, 1.25);
    this.flashlight.castShadow = false;
    scene.add(this.flashlight, this.flashlight.target);
    this.sky = scene.background as THREE.Color;
    this.skyBase = this.sky.clone();
    this.fogBase = scene.fog ? (scene.fog as THREE.Fog).color.clone() : null;
    this.envBase = scene.environmentIntensity;
  }

  get dark(): boolean {
    return (this.raid && !this.restored) || this.cut;
  }

  setRaid(on: boolean): void {
    this.raid = on;
    this.restored = false;
    if (on) this.flicker = 0;
  }

  /** Breaker panel: restore power during a raid, otherwise cut / restore the lights. */
  breaker(): 'restored' | 'cut' | 'on' {
    if (this.raid && !this.restored) {
      this.restored = true;
      this.cut = false;
      return 'restored';
    }
    this.cut = !this.cut;
    if (this.cut) this.flicker = 0;
    return this.cut ? 'cut' : 'on';
  }

  /** What a breaker would do right now (prompt text). */
  get breakerAction(): string {
    if (this.raid && !this.restored) return 'Restore power';
    return this.cut ? 'Lights back on' : 'Cut the lights';
  }

  toggleFlashlight(): boolean {
    this.flashlightOn = !this.flashlightOn;
    return this.flashlightOn;
  }

  update(dt: number): void {
    const dark = this.dark;
    if (dark && !this.wasDark) this.flashlightOn = true;
    this.wasDark = dark;
    let k: number;
    if (dark) {
      // Power-down: a few hard flickers, then out.
      this.flicker += dt;
      const f = this.flicker;
      this.level = Math.min(1, this.level + dt * 0.55);
      k = f < 1.6 ? Math.max(this.level, (Math.sin(f * 37) > 0.2 ? 0.15 : 0.9) * Math.min(1, f)) : this.level;
    } else {
      this.level = Math.max(0, this.level - dt * 0.35);
      k = this.level;
    }
    this.map.setBlackout(k);
    this.sky.copy(this.skyBase).multiplyScalar(1 - 0.92 * k);
    // Image-based ambient is most of the indoor fill: it has to go dark too.
    this.scene.environmentIntensity = this.envBase * (1 - 0.9 * k);
    if (this.fogBase) (this.scene.fog as THREE.Fog).color.copy(this.fogBase).multiplyScalar(1 - 0.92 * k);

    const fl = this.flashlight;
    fl.intensity = this.flashlightOn && this.alive() ? 18 : 0;
    if (fl.intensity > 0) {
      const dir = this.lookDir(this.dir);
      fl.position.copy(this.eye).addScaledVector(dir, 0.3).y -= 0.12;
      fl.target.position.copy(this.eye).addScaledVector(dir, 12);
      fl.target.updateMatrixWorld();
    }
  }
}
