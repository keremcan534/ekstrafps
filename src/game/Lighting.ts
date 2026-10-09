import * as THREE from 'three';
import type { Site9 } from '../world/Site9';

/**
 * Facility power and your flashlight.
 *
 * Site-9 runs at night: a dim fill, and the light near you comes from the lamps
 * (practical lights parked on the nearest fixtures, see updateReds).
 *
 * The lights go out during a SABLE raid (until someone restores power at
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
  /**
   * Practical lights: a fixed pool of point lights parked on the lamps nearest
   * you (in sight). Power on: the ceiling lamps, in their colour. Blacked out:
   * only a few emergency lamps, dim red. Intensity 0 when unused.
   */
  private reds: { l: THREE.PointLight; spot: THREE.Vector3 | null; f: number; keep: boolean; peak: number }[] = [];
  private pickTimer = 0;
  private wasDarkPick = false;
  /** A spot that borrows one practical light while you're near it (see park). */
  private parked: { pos: THREE.Vector3; color: number; peak: number; dist: number } | null = null;
  private static readonly RED_FOG = new THREE.Color(0x120406);

  constructor(
    private scene: THREE.Scene,
    private map: Site9,
    private eye: THREE.Vector3,
    private lookDir: (out: THREE.Vector3) => THREE.Vector3,
    private alive: () => boolean,
    redCount = 4,
    /** Desktop: the flashlight casts a real shadow (it isn't held to a room, core/LightClip). */
    shadow = false,
  ) {
    for (let i = 0; i < redCount; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 11, 1.8);
      l.castShadow = false;
      scene.add(l);
      this.reds.push({ l, spot: null, f: 0, keep: false, peak: 0 });
    }
    this.flashlight = new THREE.SpotLight(0xfff3e2, 0, 78, 0.36, 0.42, 1.0);
    this.flashlight.castShadow = shadow;
    if (shadow) {
      this.flashlight.shadow.mapSize.set(1024, 1024);
      this.flashlight.shadow.camera.near = 0.3;
      this.flashlight.shadow.camera.far = 45;
      this.flashlight.shadow.bias = -0.0004;
      this.flashlight.shadow.normalBias = 0.03;
      this.flashlight.shadow.autoUpdate = false;
      // Drawn once now, so its shadow map exists before the flashlight is first switched on: a
      // shadow-casting light without one leaves every lit material's shadow sampler unbound,
      // and WebGL refuses those draws (INVALID_OPERATION: props and characters went invisible).
      this.flashlight.shadow.needsUpdate = true;
    }
    scene.add(this.flashlight, this.flashlight.target);
    this.envBase = scene.environmentIntensity * 0.3;
    this.sky = scene.background as THREE.Color;
    this.skyBase = this.sky.clone();
    this.fogBase = scene.fog ? (scene.fog as THREE.Fog).color.clone() : null;
  }

  /** The player's flashlight (never held to a room: it casts its own shadow on desktop). */
  get flashlightLight(): THREE.SpotLight {
    return this.flashlight;
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

  /**
   * Borrow one practical light for a fixed spot (phones: an extraction site's
   * floor light) instead of adding a light, which would recompile every shader.
   * It takes a slot after the nearest lamp while you're within ~26 m and the
   * spot is drawn; null gives it back.
   */
  park(pos: THREE.Vector3 | null, color = 0xff2010, peak = 10, dist = 10): void {
    this.parked = pos ? { pos: pos.clone(), color, peak, dist } : null;
    this.pickTimer = 0;
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
    this.scene.environmentIntensity = this.envBase * (1 - 0.9 * k) * (1 + 1.2 * this.map.openLight);
    if (this.fogBase) (this.scene.fog as THREE.Fog).color.copy(this.fogBase).multiplyScalar(1 - 0.92 * k).lerp(Lighting.RED_FOG, k * 0.85);
    this.updateReds(dt, k);

    const fl = this.flashlight;
    // A touch red-shifted when the power is out (the room's red bounces into it).
    fl.color.setRGB(1, 0.95 - 0.1 * k, 0.89 - 0.12 * k);
    fl.intensity = this.flashlightOn && this.alive() ? 34 : 0;
    // Its shadow map is drawn only while it's on.
    if (fl.castShadow) fl.shadow.autoUpdate = fl.intensity > 0;
    if (fl.intensity > 0) {
      const dir = this.lookDir(this.dir);
      fl.position.copy(this.eye).addScaledVector(dir, 0.3).y -= 0.12;
      fl.target.position.copy(this.eye).addScaledVector(dir, 12);
      fl.target.updateMatrixWorld();
    }
  }

  /**
   * Park the practical lights on the lamps nearest you that you can see. Lamps
   * leaving the set fade out before their light moves (no popping).
   */
  private updateReds(dt: number, k: number): void {
    if (!this.reds.length) return;
    const dark = k > 0.5;
    this.pickTimer -= dt;
    if (dark !== this.wasDarkPick) {
      // Power changed: everything fades out, then re-picks from the other set.
      this.wasDarkPick = dark;
      for (const r of this.reds) r.keep = false;
      this.pickTimer = 0.35;
    } else if (this.pickTimer <= 0) {
      this.pickTimer = 0.3;
      const e = this.eye;
      const near = (p: THREE.Vector3) => Math.abs(p.x - e.x) < 32 && Math.abs(p.z - e.z) < 32 && this.map.isVisibleAt(p.x, p.z);
      // Blacked out: only every third emergency lamp is a working beacon (sparse red, mostly dark).
      const cands: { pos: THREE.Vector3; color: number; peak: number; dist: number }[] = dark
        ? this.map.emergencySpots.filter((p, i) => i % 3 === 0 && near(p)).map((pos) => ({ pos, color: 0xff2a14, peak: 22, dist: 14 }))
        : this.map.lampSpots.filter((s) => near(s.pos)).map((s) => ({ pos: s.pos, color: s.color, peak: 34, dist: 11 }));
      cands.sort((a, b) => a.pos.distanceToSquared(e) - b.pos.distanceToSquared(e));
      // The parked spot goes in right after the nearest lamp (first if it's nearer):
      // the lamp over you keeps its light, even with a single practical light (phones).
      const pk = this.parked;
      if (pk && Math.abs(pk.pos.x - e.x) < 26 && Math.abs(pk.pos.z - e.z) < 26 && this.map.isVisibleAt(pk.pos.x, pk.pos.z)) {
        cands.splice(cands.length && cands[0].pos.distanceToSquared(e) < pk.pos.distanceToSquared(e) ? 1 : 0, 0, pk);
      }
      const want = cands.slice(0, dark ? Math.min(2, this.reds.length) : this.reds.length);
      for (const r of this.reds) r.keep = !!r.spot && want.some((w) => w.pos === r.spot);
      for (const w of want) {
        if (this.reds.some((r) => r.spot === w.pos)) continue;
        const free = this.reds.find((r) => !r.spot);
        if (!free) continue;
        free.spot = w.pos;
        free.f = 0;
        free.keep = true;
        free.peak = w.peak;
        free.l.color.setHex(w.color);
        free.l.position.copy(w.pos);
        free.l.distance = w.dist;
      }
    }
    const pulse = dark ? this.map.emergencyPulse : 1;
    // Power on: lamps follow the blackout level down (the flicker included).
    const level = dark ? k : 1 - k;
    for (const r of this.reds) {
      r.f = r.keep ? Math.min(1, r.f + dt * 2.5) : Math.max(0, r.f - dt * 4);
      if (r.f === 0 && !r.keep) r.spot = null;
      r.l.intensity = r.spot ? r.peak * r.f * level * pulse : 0;
    }
  }
}
