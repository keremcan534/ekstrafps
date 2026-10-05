import { feel } from '../config/Feel';

/**
 * The archive's own sounds, synthesised (quiet, soft-edged): a folder dropped into its
 * place — a paper slide over a muffled wooden knock — for picking a file, and a short
 * burst of static for each photo cut.
 */
export class DossierSfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  private ready(): AudioContext | null {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        const len = Math.floor(this.ctx.sampleRate * 0.6);
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private out(ctx: AudioContext, gain: number): GainNode {
    const g = ctx.createGain();
    g.gain.value = gain * feel.masterVolume;
    g.connect(ctx.destination);
    return g;
  }

  /** Picking a file: paper sliding, then a soft knock underneath. */
  select(): void {
    const ctx = this.ready();
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const bus = this.out(ctx, 0.55);
    // Paper: band-passed noise sweeping down, a quick swell and a long soft tail.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(3200, t);
    bp.frequency.exponentialRampToValueAtTime(1300, t + 0.22);
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0, t);
    pg.gain.linearRampToValueAtTime(0.16, t + 0.035);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    src.connect(bp).connect(pg).connect(bus);
    src.start(t, Math.random() * 0.3, 0.3);
    // Knock: a low, muffled thump as it settles.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t + 0.05);
    o.frequency.exponentialRampToValueAtTime(62, t + 0.17);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t + 0.05);
    og.gain.linearRampToValueAtTime(0.32, t + 0.058);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(lp).connect(og).connect(bus);
    o.start(t + 0.05);
    o.stop(t + 0.3);
  }

  /** A photo cut: a few crackles of static, quiet. */
  cut(): void {
    const ctx = this.ready();
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const bus = this.out(ctx, 0.35);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const g = ctx.createGain();
    // Stepped bursts, the way a bad signal drops in and out.
    const steps = [0.09, 0.02, 0.07, 0.0, 0.05, 0.015, 0.03, 0];
    steps.forEach((v, k) => g.gain.setValueAtTime(v, t + k * 0.035));
    src.connect(hp).connect(g).connect(bus);
    src.start(t, Math.random() * 0.3, 0.3);
  }
}
