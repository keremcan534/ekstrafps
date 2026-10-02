/**
 * Placeholder sound synthesis. Each recipe is rendered ONCE at startup into an
 * AudioBuffer (several random variations each) with an OfflineAudioContext, so
 * playback costs the same as playing a sample file. Replace any of these by
 * pointing a SoundBank layer at a real file.
 */

type Ctx = OfflineAudioContext;
const r = (a: number, b: number) => a + Math.random() * (b - a);

let noiseCache: { rate: number; buf: AudioBuffer } | null = null;
function noise(ctx: Ctx): AudioBuffer {
  if (noiseCache && noiseCache.rate === ctx.sampleRate) return noiseCache.buf;
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache = { rate: ctx.sampleRate, buf };
  return buf;
}

interface NoiseOpts {
  t?: number;
  dur: number;
  attack?: number;
  gain?: number;
  type?: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  /** >1 = faster initial decay */
  curve?: number;
}

function burst(ctx: Ctx, o: NoiseOpts): void {
  const t = o.t ?? 0;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.Q.value = o.q ?? 1;
  f.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
  const g = ctx.createGain();
  const peak = o.gain ?? 1;
  const atk = o.attack ?? 0.001;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + atk);
  g.gain.setTargetAtTime(0, t + atk, o.dur / (3 * (o.curve ?? 1)));
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t, Math.random());
  src.stop(t + o.dur * 1.6 + 0.05);
}

interface ToneOpts {
  t?: number;
  dur: number;
  f0: number;
  f1?: number;
  sweep?: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
}

function tone(ctx: Ctx, o: ToneOpts): void {
  const t = o.t ?? 0;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sweep ?? o.dur));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.gain ?? 1, t + (o.attack ?? 0.002));
  g.gain.setTargetAtTime(0, t + (o.attack ?? 0.002), o.dur / 3);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + o.dur * 1.6 + 0.05);
}

/** Inharmonic partials = metallic ring. */
function metal(ctx: Ctx, t: number, base: number, dur: number, gain: number, ratios = [1, 2.76, 5.4, 8.93]): void {
  ratios.forEach((ratio, i) => {
    const f = base * ratio * r(0.98, 1.02);
    if (f < ctx.sampleRate * 0.45) tone(ctx, { t, dur: dur / (1 + i * 0.6), f0: f, gain: gain / (1 + i * 0.8) });
  });
}

export type Recipe = {
  dur: number;
  /** Node-graph synthesis (rendered offline). */
  render?: (ctx: Ctx) => void;
  /** Direct sample synthesis, for waveforms nodes can't express (supersonic N-wave). */
  samples?: (sampleRate: number) => Float32Array;
  /** Saturation amount applied after rendering (tanh drive). Harsh, loud, Tarkov-ish. */
  drive?: number;
};

/** Supersonic crack: an N-wave (~0.6 ms) followed by a bright, fast-decaying hiss. */
function crackSamples(sr: number, nMs: number, tailMs: number): Float32Array {
  const len = Math.ceil(sr * 0.09);
  const out = new Float32Array(len);
  const n = Math.max(4, Math.round((sr * nMs) / 1000));
  for (let i = 0; i < n; i++) out[i] = 1 - (2 * i) / n;
  const tail = (sr * tailMs) / 1000;
  let prev = 0;
  for (let i = n; i < len; i++) {
    const x = (Math.random() * 2 - 1) * Math.exp(-(i - n) / tail) * 0.55;
    out[i] = x - 0.82 * prev; // crude high-pass: keeps the crack bright
    prev = x;
  }
  return out;
}

export const RECIPES: Record<string, Recipe> = {
  // ---------- Supersonic cracks & heavy rifle bodies ----------
  crack: { dur: 0.09, samples: (sr) => crackSamples(sr, 0.55, 5), drive: 1.5 },
  crack_heavy: { dur: 0.09, samples: (sr) => crackSamples(sr, 0.75, 7), drive: 1.8 },
  rifle_body: { dur: 0.45, drive: 3.2, render: (c) => {
    burst(c, { dur: 0.22, freq: r(3200, 3800), freqEnd: 380, type: 'lowpass', q: 0.9, gain: 2.2 });
    burst(c, { dur: 0.03, freq: 1800, type: 'highpass', gain: 1.4 });
    tone(c, { dur: 0.1, f0: 190, f1: 70, gain: 0.9 });
  } },
  rifle_boom: { dur: 0.6, drive: 2.6, render: (c) => {
    tone(c, { dur: 0.42, f0: r(64, 72), f1: 30, sweep: 0.3, gain: 1.8 });
    burst(c, { dur: 0.22, freq: 180, type: 'lowpass', gain: 1.6 });
  } },
  kar_body: { dur: 0.45, drive: 3.0, render: (c) => {
    burst(c, { dur: 0.25, freq: r(2600, 3100), freqEnd: 320, type: 'lowpass', q: 1.0, gain: 2.3 });
    burst(c, { dur: 0.03, freq: 1600, type: 'highpass', gain: 1.3 });
    tone(c, { dur: 0.12, f0: 160, f1: 60, gain: 1.0 });
  } },
  bolt_up: { dur: 0.12, render: (c) => {
    burst(c, { dur: 0.012, freq: 3400, q: 7, gain: 0.9 });
    metal(c, 0.004, r(1500, 1700), 0.06, 0.25);
  } },
  bolt_slide_back: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.1, attack: 0.01, freq: 2200, freqEnd: 1400, q: 2.2, gain: 0.8 });
    burst(c, { t: 0.1, dur: 0.02, freq: 3000, q: 5, gain: 0.9 });
    metal(c, 0.1, 1200, 0.08, 0.25);
  } },
  bolt_slide_fwd: { dur: 0.3, render: (c) => {
    burst(c, { dur: 0.08, attack: 0.008, freq: 1700, freqEnd: 2500, q: 2.2, gain: 0.8 });
    burst(c, { t: 0.085, dur: 0.03, freq: 2100, q: 3, gain: 1.2 });
    metal(c, 0.085, r(1300, 1450), 0.14, 0.35);
    tone(c, { t: 0.085, dur: 0.05, f0: 150, f1: 80, gain: 0.5 });
    burst(c, { t: 0.16, dur: 0.012, freq: 3600, q: 7, gain: 0.8 });
  } },
  round_insert: { dur: 0.15, render: (c) => {
    burst(c, { dur: 0.03, freq: 1500, freqEnd: 900, q: 2, gain: 0.6 });
    burst(c, { t: 0.03, dur: 0.01, freq: 3600, q: 7, gain: 0.7 });
    metal(c, 0.03, 2300, 0.05, 0.12);
  } },
  impact_heavy: { dur: 0.5, drive: 2.0, render: (c) => {
    tone(c, { dur: 0.18, f0: 110, f1: 42, gain: 1.2 });
    burst(c, { dur: 0.12, freq: 900, freqEnd: 200, type: 'lowpass', gain: 1.4 });
    metal(c, 0.0, r(380, 460), 0.3, 0.35, [1, 2.3, 3.9]);
  } },

  // ---------- Assault rifle ----------
  ar_shot: { dur: 0.3, drive: 2.6, render: (c) => {
    burst(c, { dur: 0.16, freq: r(3200, 3800), freqEnd: 700, type: 'bandpass', q: 0.7, gain: 1.6 });
    burst(c, { dur: 0.035, freq: 2600, type: 'highpass', gain: 0.9 });
  } },
  ar_punch: { drive: 2.2, dur: 0.25, render: (c) => {
    tone(c, { dur: 0.13, f0: r(135, 150), f1: 45, sweep: 0.09, gain: 1.1 });
    tone(c, { dur: 0.012, f0: 900, f1: 200, type: 'square', gain: 0.25 });
  } },
  ar_mech: { dur: 0.12, render: (c) => {
    burst(c, { dur: 0.014, freq: r(4200, 5200), q: 8, gain: 1.2 });
    burst(c, { t: 0.038, dur: 0.012, freq: r(3300, 3800), q: 6, gain: 0.8 });
  } },
  ar_tail: { dur: 1.0, render: (c) => {
    burst(c, { dur: 0.7, attack: 0.012, freq: 650, freqEnd: 220, type: 'lowpass', q: 0.5, gain: 0.5, curve: 0.8 });
    burst(c, { t: 0.07, dur: 0.5, attack: 0.02, freq: 900, freqEnd: 300, type: 'lowpass', gain: 0.22 });
  } },

  // ---------- 7.62x39 (AK family): deeper, harsher ----------
  ak_shot: { drive: 2.6, dur: 0.36, render: (c) => {
    burst(c, { dur: 0.2, freq: r(2400, 2900), freqEnd: 520, type: 'bandpass', q: 0.6, gain: 1.9 });
    burst(c, { dur: 0.04, freq: 2100, type: 'highpass', gain: 1.0 });
  } },
  ak_punch: { drive: 2.2, dur: 0.3, render: (c) => {
    tone(c, { dur: 0.16, f0: r(118, 128), f1: 40, sweep: 0.11, gain: 1.25 });
    burst(c, { dur: 0.06, freq: 280, type: 'lowpass', gain: 0.6 });
  } },
  ak_mech: { dur: 0.14, render: (c) => {
    burst(c, { dur: 0.018, freq: r(3200, 3800), q: 5, gain: 1.2 });
    metal(c, 0.03, r(1700, 1900), 0.05, 0.25);
  } },
  ak_tail: { dur: 1.2, render: (c) => {
    burst(c, { dur: 0.85, attack: 0.012, freq: 560, freqEnd: 190, type: 'lowpass', q: 0.5, gain: 0.6, curve: 0.8 });
    burst(c, { t: 0.08, dur: 0.55, attack: 0.02, freq: 850, freqEnd: 260, type: 'lowpass', gain: 0.25 });
  } },

  // ---------- 9x39 suppressed ----------
  val_thump: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.09, freq: r(700, 900), freqEnd: 250, type: 'lowpass', q: 0.7, gain: 1.4 });
    tone(c, { dur: 0.08, f0: 160, f1: 70, gain: 0.7 });
  } },
  val_mech: { dur: 0.12, render: (c) => {
    burst(c, { dur: 0.016, freq: r(3600, 4300), q: 6, gain: 1.1 });
    burst(c, { t: 0.03, dur: 0.014, freq: r(2600, 3000), q: 5, gain: 0.8 });
    metal(c, 0.03, 2200, 0.04, 0.15);
  } },
  val_tail: { dur: 0.6, render: (c) => burst(c, { dur: 0.4, attack: 0.01, freq: 400, freqEnd: 160, type: 'lowpass', gain: 0.4 }) },

  // ---------- 7.62x25 SMG: snappy ----------
  ppsh_shot: { drive: 2.6, dur: 0.25, render: (c) => {
    burst(c, { dur: 0.11, freq: r(3800, 4400), freqEnd: 900, type: 'bandpass', q: 0.8, gain: 1.4 });
    burst(c, { dur: 0.025, freq: 3000, type: 'highpass', gain: 0.8 });
  } },

  // ---------- Heavy pistol ----------
  pistol_shot: { drive: 2.6, dur: 0.4, render: (c) => {
    burst(c, { dur: 0.24, freq: r(2000, 2400), freqEnd: 500, type: 'bandpass', q: 0.6, gain: 1.9 });
    burst(c, { dur: 0.045, freq: 2200, type: 'highpass', gain: 1.1 });
  } },
  pistol_punch: { drive: 2.2, dur: 0.35, render: (c) => {
    tone(c, { dur: 0.22, f0: r(110, 120), f1: 36, sweep: 0.14, gain: 1.4 });
    burst(c, { dur: 0.08, freq: 260, type: 'lowpass', gain: 0.8 });
  } },
  pistol_mech: { dur: 0.15, render: (c) => {
    burst(c, { t: 0.012, dur: 0.02, freq: 3000, q: 4, gain: 0.9 });
    metal(c, 0.014, r(2100, 2400), 0.07, 0.25);
  } },
  pistol_tail: { dur: 1.3, render: (c) => {
    burst(c, { dur: 1.0, attack: 0.015, freq: 520, freqEnd: 180, type: 'lowpass', q: 0.5, gain: 0.6, curve: 0.8 });
    burst(c, { t: 0.09, dur: 0.6, attack: 0.02, freq: 800, freqEnd: 250, type: 'lowpass', gain: 0.25 });
  } },

  // ---------- Pump shotgun ----------
  shotgun_shot: { drive: 2.6, dur: 0.55, render: (c) => {
    burst(c, { dur: 0.36, freq: r(4200, 5000), freqEnd: 380, type: 'lowpass', q: 0.8, gain: 2.0 });
    burst(c, { dur: 0.05, freq: 1800, type: 'highpass', gain: 1.0 });
  } },
  shotgun_punch: { drive: 2.2, dur: 0.5, render: (c) => {
    tone(c, { dur: 0.32, f0: r(92, 100), f1: 30, sweep: 0.2, gain: 1.6 });
    burst(c, { dur: 0.14, freq: 220, type: 'lowpass', gain: 1.2 });
  } },
  shotgun_tail: { dur: 1.8, render: (c) => {
    burst(c, { dur: 1.4, attack: 0.02, freq: 420, freqEnd: 140, type: 'lowpass', q: 0.5, gain: 0.7, curve: 0.7 });
    burst(c, { t: 0.11, dur: 0.8, attack: 0.03, freq: 700, freqEnd: 200, type: 'lowpass', gain: 0.3 });
  } },
  shotgun_pump: { dur: 0.4, render: (c) => {
    burst(c, { dur: 0.07, freq: 2400, freqEnd: 1500, q: 2, gain: 0.9 });
    metal(c, 0.02, 1700, 0.06, 0.2);
    burst(c, { t: 0.17, dur: 0.06, freq: 1900, freqEnd: 2600, q: 2, gain: 1.0 });
    metal(c, 0.19, 1300, 0.1, 0.3);
    tone(c, { t: 0.19, dur: 0.05, f0: 180, f1: 90, gain: 0.5 });
  } },

  // ---------- Reload / handling ----------
  cloth: { dur: 0.3, render: (c) => burst(c, { dur: 0.2, attack: 0.04, freq: 900, type: 'lowpass', gain: 0.35 }) },
  mag_out: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.012, freq: 3800, q: 6, gain: 0.8 });
    burst(c, { t: 0.02, dur: 0.1, attack: 0.02, freq: 1500, q: 1.5, gain: 0.45 });
  } },
  mag_in: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.05, freq: 1300, q: 3, gain: 1.0 });
    metal(c, 0.0, r(850, 950), 0.1, 0.3);
    tone(c, { dur: 0.06, f0: 140, f1: 80, gain: 0.6 });
  } },
  bolt_back: { dur: 0.2, render: (c) => {
    burst(c, { dur: 0.06, freq: 2600, freqEnd: 1800, q: 2.5, gain: 0.8 });
    burst(c, { t: 0.05, dur: 0.012, freq: 4200, q: 6, gain: 0.7 });
  } },
  bolt_forward: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.04, freq: 2100, q: 2, gain: 1.1 });
    metal(c, 0.0, r(1400, 1600), 0.12, 0.35);
    tone(c, { dur: 0.05, f0: 160, f1: 90, gain: 0.5 });
  } },
  shell_insert: { dur: 0.2, render: (c) => {
    burst(c, { dur: 0.04, freq: 1400, freqEnd: 900, q: 2, gain: 0.7 });
    burst(c, { t: 0.04, dur: 0.012, freq: 3200, q: 6, gain: 0.7 });
    metal(c, 0.04, 1800, 0.05, 0.12);
  } },
  equip: { dur: 0.3, render: (c) => {
    burst(c, { dur: 0.15, attack: 0.03, freq: 1000, type: 'lowpass', gain: 0.3 });
    burst(c, { t: 0.12, dur: 0.015, freq: 3500, q: 5, gain: 0.6 });
  } },
  dry_fire: { dur: 0.08, render: (c) => {
    burst(c, { dur: 0.008, freq: 5200, q: 8, gain: 0.8 });
    burst(c, { t: 0.01, dur: 0.012, freq: 2200, q: 4, gain: 0.4 });
  } },

  firemode_click: { dur: 0.08, render: (c) => {
    burst(c, { dur: 0.01, freq: 4200, q: 8, gain: 0.8 });
    burst(c, { t: 0.025, dur: 0.008, freq: 3000, q: 6, gain: 0.5 });
  } },
  ricochet: { dur: 0.5, render: (c) => {
    tone(c, { dur: 0.35, f0: r(3200, 4200), f1: r(900, 1400), sweep: 0.3, type: 'sine', gain: 0.35 });
    burst(c, { dur: 0.02, freq: 4000, type: 'highpass', gain: 0.5 });
  } },

  // ---------- Impacts ----------
  impact_concrete: { dur: 0.2, render: (c) => {
    burst(c, { dur: 0.07, freq: r(1600, 2200), freqEnd: 500, type: 'lowpass', gain: 0.9 });
    burst(c, { dur: 0.015, freq: 3000, type: 'highpass', gain: 0.5 });
  } },
  impact_metal: { dur: 0.5, render: (c) => {
    metal(c, 0, r(1500, 2600), 0.35, 0.4);
    burst(c, { dur: 0.015, freq: 4000, type: 'highpass', gain: 0.6 });
  } },
  impact_robot: { dur: 0.35, render: (c) => {
    metal(c, 0, r(600, 850), 0.22, 0.45, [1, 2.3, 3.9, 6.1]);
    burst(c, { dur: 0.05, freq: 500, type: 'lowpass', gain: 0.7 });
    tone(c, { dur: 0.05, f0: r(2200, 2600), f1: 700, type: 'sawtooth', gain: 0.08 });
  } },
  impact_robotweak: { dur: 0.45, render: (c) => {
    metal(c, 0, r(2300, 2700), 0.25, 0.4);
    burst(c, { dur: 0.08, freq: 1600, freqEnd: 400, type: 'bandpass', gain: 1.0 });
    tone(c, { dur: 0.12, f0: 3000, f1: 500, type: 'sawtooth', gain: 0.14 });
  } },
  shell_brass: { dur: 0.25, render: (c) => metal(c, 0, r(4200, 5200), 0.12, 0.25, [1, 1.47, 2.09]) },
  shell_plastic: { dur: 0.15, render: (c) => burst(c, { dur: 0.04, freq: 900, type: 'lowpass', gain: 0.5 }) },

  // ---------- Feedback ----------
  hit_tick: { dur: 0.08, render: (c) => {
    tone(c, { dur: 0.03, f0: 1900, gain: 0.45 });
    burst(c, { dur: 0.006, freq: 5000, type: 'highpass', gain: 0.3 });
  } },
  hit_crit: { dur: 0.2, render: (c) => {
    tone(c, { dur: 0.04, f0: 2600, gain: 0.45 });
    tone(c, { t: 0.035, dur: 0.07, f0: 3500, gain: 0.35 });
    metal(c, 0.0, 3100, 0.12, 0.08);
  } },
  kill: { dur: 0.6, render: (c) => {
    tone(c, { dur: 0.16, f0: 95, f1: 45, gain: 0.9 });
    tone(c, { t: 0.02, dur: 0.3, f0: 1320, gain: 0.22 });
    tone(c, { t: 0.07, dur: 0.35, f0: 1980, gain: 0.18 });
    burst(c, { dur: 0.08, freq: 1200, freqEnd: 300, gain: 0.5 });
  } },
  robot_death: { dur: 1.2, render: (c) => {
    burst(c, { dur: 0.7, freq: 1600, freqEnd: 150, type: 'lowpass', gain: 1.4, curve: 0.8 });
    tone(c, { dur: 0.45, f0: 1100, f1: 90, type: 'sawtooth', gain: 0.18 });
    metal(c, 0.05, 520, 0.4, 0.35, [1, 2.3, 3.9]);
    tone(c, { dur: 0.25, f0: 70, f1: 35, gain: 1.0 });
  } },
  // ---------- Black Division / player damage ----------
  flyby_crack: { dur: 0.12, samples: (sr) => crackSamples(sr, 0.45, 9), drive: 2.2 },
  flyby_whizz: { dur: 0.35, render: (c) => {
    burst(c, { dur: 0.22, attack: 0.06, freq: 2600, freqEnd: 700, q: 4, gain: 0.9 });
    tone(c, { dur: 0.25, f0: 1400, f1: 500, gain: 0.08, attack: 0.05 });
  } },
  impact_flesh: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.09, freq: 420, freqEnd: 150, type: 'lowpass', gain: 1.3 });
    tone(c, { dur: 0.08, f0: 130, f1: 55, gain: 0.7 });
    burst(c, { dur: 0.03, freq: 1800, q: 1.5, gain: 0.25 });
  } },
  impact_armor: { dur: 0.4, drive: 1.5, render: (c) => {
    tone(c, { dur: 0.09, f0: 160, f1: 70, gain: 0.9 });
    burst(c, { dur: 0.05, freq: 900, freqEnd: 300, type: 'lowpass', gain: 1.0 });
    metal(c, 0, r(780, 900), 0.16, 0.3, [1, 2.1, 3.4]);
  } },
  impact_helmet: { dur: 0.45, render: (c) => {
    metal(c, 0, r(1600, 1900), 0.3, 0.45, [1, 2.4, 3.9]);
    burst(c, { dur: 0.02, freq: 5000, type: 'highpass', gain: 0.5 });
    tone(c, { dur: 0.05, f0: 220, f1: 90, gain: 0.5 });
  } },
  player_hit: { dur: 1.4, drive: 1.4, render: (c) => {
    tone(c, { dur: 0.16, f0: 95, f1: 38, gain: 1.4 });
    burst(c, { dur: 0.12, freq: 600, freqEnd: 120, type: 'lowpass', gain: 1.2 });
    tone(c, { t: 0.02, dur: 1.2, f0: 3150, gain: 0.05, attack: 0.04 }); // ear ring
  } },
  player_death: { dur: 2.2, render: (c) => {
    tone(c, { dur: 0.6, f0: 70, f1: 28, gain: 1.4 });
    burst(c, { dur: 0.5, freq: 400, freqEnd: 60, type: 'lowpass', gain: 1.2 });
    tone(c, { t: 0.05, dur: 2, f0: 2900, gain: 0.07, attack: 0.1 });
  } },
  radio_click: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.012, freq: 3000, q: 2, gain: 0.8 });
    burst(c, { t: 0.01, dur: 0.16, attack: 0.005, freq: 2200, q: 0.7, gain: 0.18 });
  } },
  body_fall: { dur: 0.5, drive: 1.6, render: (c) => {
    tone(c, { dur: 0.14, f0: r(85, 100), f1: 38, gain: 1.1 });
    burst(c, { dur: 0.1, freq: 700, freqEnd: 160, type: 'lowpass', gain: 1.2 });
    metal(c, 0.005, r(240, 320), 0.28, 0.32, [1, 2.2, 3.7, 5.3]);
    burst(c, { t: 0.04, dur: 0.06, freq: 2600, type: 'bandpass', q: 3, gain: 0.25 });
  } },
  servo_strain: { dur: 0.5, render: (c) => {
    tone(c, { dur: 0.35, f0: r(520, 600), f1: 230, sweep: 0.3, type: 'sawtooth', gain: 0.07 });
    tone(c, { dur: 0.3, f0: r(780, 860), f1: 340, sweep: 0.28, type: 'square', gain: 0.035 });
    metal(c, 0, r(900, 1100), 0.12, 0.12);
  } },
  robot_boot: { dur: 0.5, render: (c) => {
    tone(c, { dur: 0.3, f0: 300, f1: 900, sweep: 0.25, type: 'square', gain: 0.06 });
    metal(c, 0.25, 700, 0.2, 0.2);
  } },
  land: { dur: 0.2, render: (c) => {
    tone(c, { dur: 0.1, f0: 85, f1: 40, gain: 0.7 });
    burst(c, { dur: 0.08, freq: 350, type: 'lowpass', gain: 0.6 });
  } },
  jump: { dur: 0.2, render: (c) => burst(c, { dur: 0.1, attack: 0.02, freq: 700, type: 'lowpass', gain: 0.25 }) },
  prop_hit: { dur: 0.25, render: (c) => {
    burst(c, { dur: 0.08, freq: r(500, 800), type: 'lowpass', gain: 0.9 });
    metal(c, 0, r(300, 450), 0.15, 0.25, [1, 2.4, 4.1]);
  } },
};
