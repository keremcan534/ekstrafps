/**
 * The terminal's sound chip: square/triangle beeps, filtered noise, held drones and
 * recorded lines crushed down to old speech-chip quality, straight on WebAudio
 * (separate from the game's mixer so a program can run from the menu).
 */

export interface Drone {
  set(freq: number, vol?: number): void;
  stop(): void;
}

export class Chip {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private drones = new Set<Drone>();
  private voices = new Map<string, Promise<AudioBuffer | null>>();
  private playing = new Set<AudioBufferSourceNode>();
  /** Bumped by hush(), so a line still loading when a program quits stays quiet. */
  private gen = 0;

  private ac(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  /** Call from a user gesture (browsers start audio suspended). */
  wake(): void {
    void this.ac()?.resume();
  }

  /** A short tone, optionally sliding to `to` Hz. */
  beep(freq: number, dur = 0.08, vol = 0.18, type: OscillatorType = 'square', to?: number, delay = 0): void {
    const ctx = this.ac();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** A burst of filtered noise (static, clacks, wind). */
  noise(dur = 0.1, vol = 0.2, freq = 2000, q = 0.7, delay = 0): void {
    const ctx = this.ac();
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  /** A held tone (wind, hum, a heater) until stopped. Noise when `freq` is 0. */
  drone(freq: number, vol = 0.05, type: OscillatorType = 'sawtooth', lowpass = 900): Drone {
    const ctx = this.ac();
    const none: Drone = { set() {}, stop() {} };
    if (!ctx || !this.master || !this.noiseBuf) return none;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(vol, ctx.currentTime, 0.2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    f.connect(g).connect(this.master);
    let src: OscillatorNode | AudioBufferSourceNode;
    if (freq > 0) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      src = o;
    } else {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      src = s;
    }
    src.connect(f);
    src.start();
    const d: Drone = {
      set: (fr, v) => {
        if (src instanceof OscillatorNode) src.frequency.setTargetAtTime(fr, ctx.currentTime, 0.05);
        else f.frequency.setTargetAtTime(fr, ctx.currentTime, 0.1);
        if (v !== undefined) g.gain.setTargetAtTime(v, ctx.currentTime, 0.1);
      },
      stop: () => {
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        src.stop(ctx.currentTime + 0.5);
        this.drones.delete(d);
      },
    };
    this.drones.add(d);
    return d;
  }

  /** Fetch and crush a recorded line once (`rate` Hz sample-and-hold, `bits` deep). */
  loadVoice(url: string, rate = 6000, bits = 4): Promise<AudioBuffer | null> {
    const key = `${url}|${rate}|${bits}`;
    let p = this.voices.get(key);
    if (!p) {
      const ctx = this.ac();
      p = !ctx
        ? Promise.resolve(null)
        : fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(url))))
            .then((b) => ctx.decodeAudioData(b))
            .then((src) => crush(ctx, src, rate, bits))
            .catch(() => null);
      this.voices.set(key, p);
    }
    return p;
  }

  /** Play a recorded line through the chip (silently skipped if it can't load). */
  voice(url: string, o: { rate?: number; bits?: number; vol?: number; pitch?: number; delay?: number } = {}): void {
    const gen = this.gen;
    void this.loadVoice(url, o.rate, o.bits).then((buf) => {
      const ctx = this.ctx;
      if (!buf || !ctx || !this.master || gen !== this.gen) return;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = o.pitch ?? 1;
      const g = ctx.createGain();
      g.gain.value = o.vol ?? 0.5;
      s.connect(g).connect(this.master);
      s.start(ctx.currentTime + (o.delay ?? 0));
      this.playing.add(s);
      s.onended = () => this.playing.delete(s);
    });
  }

  /** Stop every held sound and recorded line (a program ended or was quit). */
  hush(): void {
    this.gen++;
    for (const d of [...this.drones]) d.stop();
    for (const s of this.playing) s.stop();
    this.playing.clear();
  }
}

/** Note name to Hz ('A4' = 440). */
export function hz(note: string): number {
  const m = /^([A-G])(#?)(\d)$/.exec(note);
  if (!m) return 0;
  const steps: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const n = steps[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * Math.pow(2, n / 12);
}

/** Mono, normalised, sample-and-held to `rate` Hz and quantised to `bits`. */
function crush(ctx: AudioContext, src: AudioBuffer, rate: number, bits: number): AudioBuffer {
  const n = src.length;
  const out = ctx.createBuffer(1, n, src.sampleRate);
  const o = out.getChannelData(0);
  const chans = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const ch of chans) v += ch[i];
    o[i] = v / chans.length;
    peak = Math.max(peak, Math.abs(o[i]));
  }
  const norm = peak > 0 ? 0.9 / peak : 1;
  const hold = Math.max(1, Math.round(src.sampleRate / rate));
  const levels = 2 ** (bits - 1);
  let held = 0;
  for (let i = 0; i < n; i++) {
    if (i % hold === 0) held = Math.round(o[i] * norm * levels) / levels;
    o[i] = held;
  }
  return out;
}
