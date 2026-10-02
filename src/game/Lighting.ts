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
  /** Red emergency light pools near you while the power is out (fixed pool, intensity 0 when unused). */
  private reds: { l: THREE.PointLight; spot: THREE.Vector3 | null; f: number; keep: boolean }[] = [];
  private pickTimer = 0;
  private static readonly RED_FOG = new THREE.Color(0x1a0303);

  constructor(
    private scene: THREE.Scene,
    private map: Site9,
    private eye: THREE.Vector3,
    private lookDir: (out: THREE.Vector3) => THREE.Vector3,
    private alive: () => boolean,
    redCount = 4,
  ) {
    for (let i = 0; i < redCount; i++) {
      const l = new THREE.PointLight(0xff2412, 0, 19, 1.5);
      l.castShadow = false;
      scene.add(l);
      this.reds.push({ l, spot: null, f: 0, keep: false });
    }
    this.flashlight = new THREE.SpotLight(0xfff3e2, 0, 46, 0.44, 0.5, 1.25);
    this.flashlight.castShadow = false;
    scene.add(this.flashlight, this.flashlight.target);
    this.sky = scene.background as THREE.Color;
    this.skyBase = this.sky.clone();
    this.fogBase = scene.fog ? (scene.fog as THREE.Fog).color.clone() : null;
    this.envBase = scene.environmentIntensity;
  }

  /** 0 = lights on … 1 = blacked out (muzzle flashes scale with this). */
  get darkness(): number {
    return this.level;
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
    // Dark, with a red haze in the air.
    this.sky.copy(this.skyBase).multiplyScalar(1 - 0.92 * k).lerp(Lighting.RED_FOG, k * 0.8);
    // Image-based ambient is most of the indoor fill: it has to go dark too.
    this.scene.environmentIntensity = this.envBase * (1 - 0.9 * k);
    if (this.fogBase) (this.scene.fog as THREE.Fog).color.copy(this.fogBase).multiplyScalar(1 - 0.92 * k).lerp(Lighting.RED_FOG, k * 0.85);
    this.updateReds(dt, k);

    const fl = this.flashlight;
    // A touch red-shifted when the power is out (the room's red bounces into it).
    fl.color.setRGB(1, 0.95 - 0.1 * k, 0.89 - 0.12 * k);
    fl.intensity = this.flashlightOn && this.alive() ? 18 : 0;
    if (fl.intensity > 0) {
      const dir = this.lookDir(this.dir);
      fl.position.copy(this.eye).addScaledVector(dir, 0.3).y -= 0.12;
      fl.target.position.copy(this.eye).addScaledVector(dir, 12);
      fl.target.updateMatrixWorld();
    }
  }

  /**
   * Keep the red lights on the emergency lamps nearest you that you can see.
   * Lamps leaving the set fade out before their light moves (no popping).
   */
  private updateReds(dt: number, k: number): void {
    if (!this.reds.length) return;
    this.pickTimer -= dt;
    let want: THREE.Vector3[] | null = null;
    if (this.pickTimer <= 0 && k > 0.02) {
      this.pickTimer = 0.3;
      const e = this.eye;
      want = this.map.emergencySpots
        .filter((s) => Math.abs(s.x - e.x) < 30 && Math.abs(s.z - e.z) < 30 && this.map.isVisibleAt(s.x, s.z))
        .sort((a, b) => a.distanceToSquared(e) - b.distanceToSquared(e))
        .slice(0, this.reds.length);
    }
    if (want) {
      for (const r of this.reds) r.keep = !!r.spot && want.includes(r.spot);
      for (const s of want) {
        if (this.reds.some((r) => r.spot === s)) continue;
        const free = this.reds.find((r) => !r.spot);
        if (free) {
          free.spot = s;
          free.f = 0;
          free.keep = true;
          free.l.position.copy(s);
        }
      }
    }
    if (k <= 0.02) for (const r of this.reds) r.keep = false;
    const pulse = this.map.emergencyPulse;
    for (const r of this.reds) {
      r.f = r.keep ? Math.min(1, r.f + dt * 2.5) : Math.max(0, r.f - dt * 4);
      if (r.f === 0 && !r.keep) r.spot = null;
      r.l.intensity = r.spot ? 45 * r.f * k * pulse : 0;
    }
  }
}
