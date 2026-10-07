import { feel } from '../config/Feel';

/**
 * The main menu's soundtrack: Static Horizon first, then the rest shuffled, each track
 * crossfading into the next before its faded tail. Streamed from <audio> elements (no
 * decode of 2-minute tracks up front), so it stays out of the game's mix and compressor,
 * and heard through its own small effects chain (FX): muffled, as if from outside in the
 * cold, with a slap of echo off the treeline and a little room. Plays only while the menu
 * is up before a match; pausing mid-raid stays quiet.
 */

interface Track {
  file: string;
  /** Loudness match (all ≈ -21 LUFS-ish; measured from the masters). */
  gain: number;
}

const OPENER: Track = { file: 'audio/music/static_horizon.mp3', gain: 0.61 };
const REST: Track[] = [
  { file: 'audio/music/frozen_steppe.mp3', gain: 0.9 },
  { file: 'audio/music/static_circuit.mp3', gain: 0.87 },
];

/**
 * The music's treatment. muffle: low-pass corner (Hz) of everything heard; echo: a darkening
 * repeat (delay s, feedback, wet level); room: a short generated reverb (length s, wet level).
 */
const FX = { muffle: 1700, echo: { time: 0.36, feedback: 0.32, wet: 0.22 }, room: { seconds: 2.6, wet: 0.3 } };

/** Seconds of overlap at each change (the masters fade out over their last ~5 s). */
const CROSSFADE = 5;
const FADE_IN = 2.5;
const FADE_OUT = 1.2;

interface Voice {
  el: HTMLAudioElement;
  track: Track;
  /** Current fade level 0..1, and where it is heading. */
  level: number;
  target: number;
  rate: number;
}

export class MenuMusic {
  /** 0..1, from Settings (on top of the master volume). */
  volume = 0.6;
  private voices: Voice[] = [];
  private queue: Track[] = [];
  private wanted = false;
  private timer = 0;
  private last = 0;
  private blocked = false;
  /** The effects chain's input (built on the first track: an AudioContext needs a page that may play). */
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;

  constructor() {
    // App in the background (phone screen off, app switcher): silence, then carry on.
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      for (const v of this.voices) {
        if (hidden) v.el.pause();
        else if (this.wanted && v.target > 0) this.start(v);
      }
    });
  }

  /** Start (or keep) playing. Safe to call repeatedly. */
  play(): void {
    if (this.wanted) return;
    this.wanted = true;
    // Back from a match or the dossier: pick the track up where it paused.
    const cur = this.voices[this.voices.length - 1];
    if (cur && !cur.el.ended) this.fade(cur, 1, FADE_IN);
    else this.next(FADE_IN);
    this.tick();
  }

  /** Fade out and pause (the menu closed, or a match started). */
  stop(): void {
    if (!this.wanted) return;
    this.wanted = false;
    for (const v of this.voices) this.fade(v, 0, FADE_OUT);
  }

  private next(fadeIn: number): void {
    if (!this.queue.length) this.queue = [OPENER, ...shuffle(REST)];
    const track = this.queue.shift()!;
    const el = new Audio(track.file);
    el.preload = 'auto';
    const fx = this.chain();
    if (fx) fx.ctx.createMediaElementSource(el).connect(fx.input);
    const v: Voice = { el, track, level: 0, target: 1, rate: 1 / fadeIn };
    this.voices.push(v);
    this.start(v);
  }

  private start(v: Voice): void {
    void this.ctx?.resume().catch(() => {});
    v.el.play().catch(() => {
      // Autoplay blocked (phones, browsers): the first tap or key starts it.
      if (this.blocked) return;
      this.blocked = true;
      const go = () => {
        this.blocked = false;
        void this.ctx?.resume().catch(() => {});
        for (const ev of ['pointerup', 'touchend', 'keydown']) window.removeEventListener(ev, go);
        if (this.wanted) for (const x of this.voices) if (x.target > 0 && x.el.paused) void x.el.play().catch(() => {});
      };
      for (const ev of ['pointerup', 'touchend', 'keydown']) window.addEventListener(ev, go, { passive: true });
    });
  }

  /** The effects chain, built once (null where Web Audio is missing: the music plays dry). */
  private chain(): { ctx: AudioContext; input: GainNode } | null {
    if (this.ctx && this.input) return { ctx: this.ctx, input: this.input };
    try {
      const ctx = new AudioContext();
      const input = ctx.createGain();
      // Muffled: everything through a gentle low-pass, the lows a touch fuller.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = FX.muffle;
      lp.Q.value = 0.6;
      const warm = ctx.createBiquadFilter();
      warm.type = 'lowshelf';
      warm.frequency.value = 220;
      warm.gain.value = 2;
      input.connect(lp).connect(warm);
      const out = ctx.createGain();
      warm.connect(out);
      // Echo: each repeat darker than the last.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = FX.echo.time;
      const fb = ctx.createGain();
      fb.gain.value = FX.echo.feedback;
      const dark = ctx.createBiquadFilter();
      dark.type = 'lowpass';
      dark.frequency.value = 1100;
      const echo = ctx.createGain();
      echo.gain.value = FX.echo.wet;
      warm.connect(delay).connect(dark).connect(fb).connect(delay);
      dark.connect(echo).connect(out);
      // Room: decaying stereo noise as the impulse response.
      const room = ctx.createConvolver();
      room.buffer = impulse(ctx, FX.room.seconds);
      const wet = ctx.createGain();
      wet.gain.value = FX.room.wet;
      warm.connect(room).connect(wet).connect(out);
      out.connect(ctx.destination);
      this.ctx = ctx;
      this.input = input;
      return { ctx, input };
    } catch {
      return null;
    }
  }

  private fade(v: Voice, target: number, seconds: number): void {
    v.target = target;
    v.rate = 1 / Math.max(0.05, seconds);
    if (target > 0 && v.el.paused && !v.el.ended) this.start(v);
  }

  private tick = (): void => {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      const master = feel.masterVolume * this.volume;
      for (const v of this.voices) {
        const step = v.rate * dt;
        v.level = v.target > v.level ? Math.min(v.target, v.level + step) : Math.max(v.target, v.level - step);
        // Equal-power-ish curve so a crossfade doesn't dip in the middle.
        v.el.volume = Math.min(1, Math.sin((v.level * Math.PI) / 2) * v.track.gain * master);
        if (v.level === 0 && v.target === 0 && !v.el.paused) v.el.pause();
      }
      // Near the end of the current track: bring in the next one over its tail.
      const cur = this.voices[this.voices.length - 1];
      if (this.wanted && cur && cur.target > 0) {
        const left = cur.el.duration - cur.el.currentTime;
        if (cur.el.ended || (Number.isFinite(left) && left < CROSSFADE)) {
          this.fade(cur, 0, Math.max(0.5, left));
          this.next(CROSSFADE);
        }
      }
      // Drop finished voices; stop the clock once everything is silent.
      this.voices = this.voices.filter((v, i) => i === this.voices.length - 1 || v.level > 0 || v.target > 0);
      if (!this.wanted && this.voices.every((v) => v.level === 0)) {
        window.clearInterval(this.timer);
        this.timer = 0;
      }
    }, 50);
  };
}

/** A reverb tail: stereo noise fading out over `seconds`, the highs going first. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      lp += (Math.random() * 2 - 1 - lp) * (0.5 - 0.42 * t);
      d[i] = lp * Math.pow(1 - t, 3);
    }
  }
  return b;
}

function shuffle<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
