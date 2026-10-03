import { AUTO_TIERS, saveAutoTier } from '../config/Graphics';

/** Seconds per measurement window. */
const WINDOW = 4;
/** Seconds ignored after a change (shader compiles, the new framebuffer). */
const SETTLE = 3;

/**
 * Graphics preset AUTO (phones): climbs the quality ladder while the frame rate
 * holds the target with room to spare (two good windows in a row), steps down when
 * it doesn't. A tier that made frames miss is this session's ceiling from then on,
 * so the game doesn't keep bouncing between two tiers (and recompiling), until
 * frames have held for a good while.
 * The tier is saved: the next session starts where this one settled.
 */
export class AutoQuality {
  private t = 0;
  private settle = SETTLE + 2;
  private frames: number[] = [];
  private good = 0;
  private ceiling = AUTO_TIERS - 1;
  /** Good windows in a row at the ceiling: after ~80 s the tier above gets another try (a firefight or a hot phone has passed). */
  private calm = 0;

  constructor(
    public tier: number,
    private apply: (tier: number) => void,
  ) {}

  /** Once per rendered frame: its real length (s), the fps to hold, the dynamic-resolution scale now. */
  frame(rawDt: number, target: number, dynScale: number): void {
    if (rawDt <= 0 || rawDt > 0.25) return; // background tab / a hitch: not a measurement
    if ((this.settle -= rawDt) > 0) return;
    this.frames.push(rawDt);
    if ((this.t += rawDt) < WINDOW) return;
    // The average, not the median: a 60 cap on a 90 Hz screen alternates 11 and 22 ms frames.
    const fps = this.frames.length / this.t;
    // Hitches: frames over 1.6x the target frame time.
    const spikes = this.frames.filter((f) => f > 1.6 / target).length / this.frames.length;
    this.frames = [];
    this.t = 0;
    // Dynamic resolution already gave up a lot of sharpness, or frames still miss: one step down.
    if (fps < target * 0.82 || dynScale < 0.8) {
      this.good = this.calm = 0;
      this.ceiling = Math.min(this.ceiling, this.tier - 1);
      if (this.tier > 0) this.set(this.tier - 1);
      return;
    }
    if (fps < target * 0.95 || spikes > 0.03 || dynScale < 0.99) {
      this.good = this.calm = 0;
      return;
    }
    if (this.tier >= this.ceiling && this.ceiling < AUTO_TIERS - 1 && ++this.calm >= 20) {
      this.calm = 0;
      this.ceiling++;
    }
    if (++this.good >= 2 && this.tier < this.ceiling) {
      this.good = 0;
      this.set(this.tier + 1);
    }
  }

  private set(tier: number): void {
    this.tier = tier;
    this.settle = SETTLE;
    this.frames = [];
    this.t = 0;
    saveAutoTier(tier);
    this.apply(tier);
  }
}
