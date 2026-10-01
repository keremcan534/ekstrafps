/**
 * Smooth 1D value noise (cubic-interpolated random lattice), summed over two
 * octaves. Used for organic sway: hand tremor, slow aim drift. Deterministic
 * per seed so channels don't move in lockstep.
 */
export class Noise1D {
  private values = new Float32Array(256);

  constructor(seed: number) {
    let s = (seed * 9301 + 49297) % 233280;
    for (let i = 0; i < 256; i++) {
      s = (s * 9301 + 49297) % 233280;
      this.values[i] = (s / 233280) * 2 - 1;
    }
  }

  private raw(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.values[i & 255];
    const b = this.values[(i + 1) & 255];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  }

  /** Roughly in [-1, 1]. */
  sample(x: number): number {
    return (this.raw(x) * 0.7 + this.raw(x * 2.13 + 17.3) * 0.3) / 0.85;
  }
}
