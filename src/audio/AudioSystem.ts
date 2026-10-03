import * as THREE from 'three';
import { RECIPES } from './Synth';
import { AMBIENCE_LOOPS, SOUND_BANK, compressedUrl, isDeferredEvent, type SoundEvent } from './SoundBank';
import { feel } from '../config/Feel';

const VARIATIONS = 3;
const RENDER_RATE = 44100;
/** lowSpec: gunfire further than this isn't played at all (no ray, no nodes). */
const GUNFIRE_CULL = 80;
/** lowSpec: an occlusion ray is reused for this long per source cell (ms). */
const OCCLUSION_TTL = 200;

export interface AudioOptions {
  /**
   * Phones: half the voices held for their real length, no per-shot room tails, far
   * gunfire culled, occlusion rays cached, a shorter mono reverb, a louder bus (more
   * presence and make-up gain for small speakers),
   * 22.05 kHz files kept at 22.05 kHz in memory, audio suspended in the background,
   * compressed .mp3 twins fetched instead of the WAVs.
   */
  lowSpec?: boolean;
  /** No sound at all (?noaudio): play() does nothing and init() resolves at once. */
  disabled?: boolean;
}

/** Runs at most `max` async jobs at once, the rest wait in order. */
class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number) {}
  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        // Always async: a job that throws synchronously rejects its own promise and still frees the slot.
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (this.active < this.max) start();
      else this.waiting.push(start);
    });
  }
}

/** Sample rate from a WAV or MP3 header (0 if it can't tell). */
function sniffRate(data: ArrayBuffer): number {
  const b = new Uint8Array(data);
  const v = new DataView(data);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    for (let o = 12; o + 16 <= b.length; ) {
      const size = v.getUint32(o + 4, true);
      if (tag(o) === 'fmt ') return v.getUint32(o + 12, true);
      o += 8 + size + (size & 1);
    }
    return 0;
  }
  let o = 0;
  // ID3v2 tag in front of the first frame: 10-byte header + syncsafe size (+ footer).
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  for (const end = Math.min(b.length - 3, o + 8192); o < end; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b[o + 1] >> 1) & 3; // 1 = Layer III
    const idx = (b[o + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || idx === 3 || b[o + 2] >> 4 === 15) continue;
    return [44100, 48000, 32000][idx] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  }
  return 0;
}

/** Gapless info from an MP3's Xing/Info + LAME header (encoder delay and padding), null if absent. */
interface Mp3Gapless {
  rate: number;
  /** Samples per frame. */
  spf: number;
  frames: number;
  startPad: number;
  endPad: number;
}
function mp3Gapless(data: ArrayBuffer): Mp3Gapless | null {
  const b = new Uint8Array(data);
  const v = new DataView(data);
  let o = 0;
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  for (const end = Math.min(b.length - 4, o + 8192); o < end; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[o + 1] >> 3) & 3;
    const layer = (b[o + 1] >> 1) & 3;
    const idx = (b[o + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || idx === 3 || b[o + 2] >> 4 === 15) continue;
    const mpeg1 = version === 3;
    const mono = b[o + 3] >> 6 === 3;
    // The Xing/Info tag sits after the side info of the first frame (+2 bytes of CRC if present).
    let x = o + 4 + ((b[o + 1] & 1) === 0 ? 2 : 0) + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    if (x + 8 > b.length) return null;
    const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
    if (tag !== 'Xing' && tag !== 'Info') return null;
    const flags = v.getUint32(x + 4);
    if (!(flags & 1)) return null;
    const frames = v.getUint32(x + 8);
    x += 12 + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
    // LAME extension: 9-byte encoder name, 12 more bytes, then delay and padding (12 bits each).
    const p = x + 21;
    if (p + 3 > b.length) return null;
    return {
      rate: [44100, 48000, 32000][idx] / (mpeg1 ? 1 : version === 2 ? 2 : 4),
      spf: mpeg1 ? 1152 : 576,
      frames,
      startPad: (b[p] << 4) | (b[p + 1] >> 4),
      endPad: ((b[p + 1] & 15) << 8) | b[p + 2],
    };
  }
  return null;
}

export interface PlayOptions {
  /** World position: enables distance attenuation + stereo panning. */
  position?: THREE.Vector3;
  volume?: number;
  pitch?: number;
}

/**
 * Event-based layered audio. Gameplay calls `play('ar.fire')`; layering,
 * variations, voice limits and (eventually) real sample files are all data
 * in SoundBank.ts. Missing sounds never break gameplay — they are skipped.
 */
export class AudioSystem {
  readonly ctx: AudioContext;
  private master: GainNode;
  /** Shared room reverb: concrete hall impulse response, fed by per-event sends. */
  private reverbIn: GainNode;
  /** Everything with a position (the world) goes through here, so your shots can duck it. */
  private world: GainNode;
  private synthBuffers = new Map<string, AudioBuffer[]>();
  private fileBuffers = new Map<string, AudioBuffer>();
  /** End times (audio clock) of the instances still playing, per event: voice limits that can't get stuck. */
  private voices = new Map<string, number[]>();
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private tmp = new THREE.Vector3();
  ready = false;
  private lastPick = new WeakMap<object, number>();
  /** 0 = small room (short tails) … 1 = huge hall (long tails, more reverb). Set by the game. */
  space = 0.5;
  /**
   * Walls between you and a sound: 0 = clear line … 1 = behind walls. Set by the
   * game (a ray through the level). Occluded sounds come through muffled and quieter.
   */
  occlusion: ((at: THREE.Vector3) => number) | null = null;
  /**
   * Resolves when the deferred set (voices, extraction, the Choir, civilians, ambience
   * beds) has loaded or failed. init() resolves earlier, after the core set.
   */
  readonly deferred: Promise<void>;
  private resolveDeferred!: () => void;
  private readonly lowSpec: boolean;
  /** ?noaudio: callers that resume `ctx` themselves (PerfBench) can check this first. */
  readonly disabled: boolean;
  /** Synth renders in flight or done, per recipe (each recipe renders once, on demand). */
  private synthJobs = new Map<string, Promise<void>>();
  private fileLimit: Limiter;
  private synthLimit: Limiter;
  /** lowSpec: shared 22.05 kHz decoder (undefined = not tried yet, null = unavailable). */
  private decoder22k: OfflineAudioContext | null | undefined;
  /** lowSpec: recent occlusion results per 2 m cell of the source position. */
  private occCache = new Map<number, { t: number; v: number }>();

  constructor(opts: AudioOptions = {}) {
    this.lowSpec = !!opts.lowSpec;
    this.disabled = !!opts.disabled;
    this.deferred = new Promise<void>((r) => (this.resolveDeferred = r));
    this.fileLimit = new Limiter(this.lowSpec ? 4 : 6);
    this.synthLimit = new Limiter(this.lowSpec ? 4 : Infinity);
    // Android phones: a bigger buffer means far fewer audio-thread wakeups (heat, crackle)
    // for a few ms of latency nobody hears under a gunshot.
    const android = this.lowSpec && /Android/i.test(navigator.userAgent);
    this.ctx = new AudioContext({ latencyHint: android ? 'balanced' : 'interactive' });
    if (this.disabled) {
      void this.ctx.suspend();
      this.resolveDeferred();
    } else {
      // iOS: play through the silent switch like a game, not like a web page's beeps.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      try {
        if (session) session.type = 'playback';
      } catch {
        // older WebKit: read-only or missing
      }
      if (this.lowSpec) {
        // No audio thread while the app is in the background (screen off, app switcher).
        const sleep = () => this.ctx.state === 'running' && void this.ctx.suspend();
        document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && sleep());
        window.addEventListener('pagehide', sleep);
      }
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = feel.masterVolume;
    // Master tone: a little weight in the lows, the harsh top tamed, then the bus
    // compressor and a brick-wall-ish limiter so a firefight never clips into distortion.
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 110;
    low.gain.value = 2;
    const high = this.ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 9000;
    high.gain.value = -2.5;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    // Presence where small speakers live (2-3 kHz): gunfire on a phone was all peak and
    // no body. Then bus compression with make-up gain, so shots sound as loud as they
    // peak (the slow attack lets the crack through); the limiter still stops clipping.
    const presence = this.ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2400;
    presence.Q.value = 0.8;
    presence.gain.value = this.lowSpec ? 3.5 : 1.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = this.lowSpec ? -20 : -14;
    comp.knee.value = 8;
    comp.ratio.value = this.lowSpec ? 4 : 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.15;
    const makeup = this.ctx.createGain();
    makeup.gain.value = this.lowSpec ? 1.8 : 1.35;
    this.master.connect(low).connect(high).connect(presence).connect(comp).connect(makeup).connect(limiter).connect(this.ctx.destination);
    this.world = this.ctx.createGain();
    this.world.connect(this.master);

    const convolver = this.ctx.createConvolver();
    // Phones: a 1.2 s mono room (the convolver is the one constant cost of the audio graph).
    if (!this.disabled) convolver.buffer = this.lowSpec ? this.buildRoomImpulse(1.2, 1) : this.buildRoomImpulse(2.3, 2);
    this.reverbIn = this.ctx.createGain();
    const wet = this.ctx.createGain();
    wet.gain.value = 0.52;
    this.reverbIn.connect(convolver).connect(wet).connect(this.master);
  }

  /**
   * Procedural impulse response of a hard indoor range: a cluster of early wall
   * reflections, then a dense tail that darkens as it decays.
   */
  private buildRoomImpulse(seconds: number, channels: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(channels, len, sr);
    const early = [0.009, 0.014, 0.021, 0.029, 0.038, 0.05, 0.063, 0.081];
    for (let ch = 0; ch < channels; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const n = (Math.random() * 2 - 1) * Math.exp(-t / 0.42);
        const k = Math.min(0.92, 0.25 + t * 0.9); // darker over time
        lp = lp * k + n * (1 - k);
        // A short room (phones) fades out over its last 0.2 s instead of stopping dead.
        const fade = seconds < 2 ? Math.min(1, (seconds - t) / 0.2) : 1;
        d[i] = lp * (t < 0.012 ? t / 0.012 : 1) * 1.6 * fade;
      }
      for (const e of early) {
        const at = Math.floor((e + (ch ? 0.0023 : 0)) * sr);
        if (at < len) d[at] += (Math.random() < 0.5 ? -1 : 1) * 0.6 * Math.exp(-e / 0.05);
      }
    }
    return buf;
  }

  /** tanh saturation + peak safety, applied to "drive" recipes after rendering. */
  private saturate(buf: AudioBuffer, drive: number): AudioBuffer {
    const d = buf.getChannelData(0);
    const norm = Math.tanh(drive);
    for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * drive) / norm;
    return buf;
  }

  /**
   * Load the sample files and render the synth recipes that have no file (a recipe
   * that backs a file only renders if that file fails). Resolves once the core set
   * (guns, impacts, footsteps, UI) is in; the rest keeps loading behind `deferred`.
   */
  async init(): Promise<void> {
    if (this.disabled) return;
    const synths = { core: new Set<string>(), late: new Set<string>() };
    /** file -> needed by a core event?, synth recipes that stand in if it fails. */
    const files = new Map<string, { core: boolean; fallbacks: Set<string> }>();
    for (const [name, ev] of Object.entries(SOUND_BANK)) {
      const core = !isDeferredEvent(name);
      for (const l of ev.layers) {
        if (l.tail && this.lowSpec) continue; // never played on phones (see play())
        const list = l.files?.length ? l.files : l.file ? [l.file] : [];
        if (list.length === 0) {
          if (l.synth) (core ? synths.core : synths.late).add(l.synth);
          continue;
        }
        for (const f of list) {
          const entry = files.get(f) ?? { core: false, fallbacks: new Set<string>() };
          entry.core ||= core;
          if (l.synth) entry.fallbacks.add(l.synth);
          files.set(f, entry);
        }
      }
    }
    for (const f of AMBIENCE_LOOPS) if (!files.has(f)) files.set(f, { core: false, fallbacks: new Set() });

    const core: Promise<void>[] = [...synths.core].map((s) => this.renderSynth(s));
    for (const [file, e] of files) if (e.core) core.push(this.load(file, e.fallbacks));
    await Promise.all(core);
    this.ready = true;
    const late: Promise<void>[] = [...synths.late].map((s) => this.renderSynth(s));
    for (const [file, e] of files) if (!e.core) late.push(this.load(file, e.fallbacks));
    void Promise.all(late).then(() => this.resolveDeferred());
  }

  /**
   * Fetch + decode one bank file; synth fallbacks on failure. Never rejects. Phones fetch
   * the .mp3 twin first (the .wav if that fails); desktop and Electron keep the WAVs.
   */
  private load(file: string, fallbacks: Set<string>): Promise<void> {
    const url = this.lowSpec ? compressedUrl(file) : file;
    return this.fileLimit
      .run(() => this.fetchDecode(url).catch((err) => (url !== file ? this.fetchDecode(file) : Promise.reject(err))))
      .then((buf) => void this.fileBuffers.set(file, buf))
      .catch(() => {
        console.info(`[audio] ${file} not found, using synth fallback`);
        return Promise.all([...fallbacks].map((s) => this.renderSynth(s))).then(() => undefined);
      });
  }

  private async fetchDecode(url: string): Promise<AudioBuffer> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const data = await r.arrayBuffer();
    // Read before decoding (decodeAudioData detaches the bytes).
    const gapless = url.endsWith('.mp3') ? mp3Gapless(data) : null;
    // Phones: 22.05 kHz files (voices, ambience) stay 22.05 kHz in memory instead of being
    // resampled to the device rate (48 kHz = over twice the PCM); playback resamples them.
    if (this.lowSpec && sniffRate(data) === 22050) {
      if (this.decoder22k === undefined) {
        try {
          this.decoder22k = new OfflineAudioContext(1, 1, 22050);
        } catch {
          this.decoder22k = null;
        }
      }
      // decodeAudioData detaches its input: decode a copy, so the fallback still has the bytes.
      if (this.decoder22k) {
        return this.decoder22k
          .decodeAudioData(data.slice(0))
          .catch(() => this.ctx.decodeAudioData(data))
          .then((buf) => this.trimMp3(buf, gapless));
      }
    }
    return this.ctx.decodeAudioData(data).then((buf) => this.trimMp3(buf, gapless));
  }

  /**
   * Cut the MP3 encoder delay if the browser's decoder left it in (decoders that ignore the
   * LAME header): otherwise every close-shot sample would start ~23 ms (voices ~50 ms) late
   * against its synth punch. No-op when the decoded length already matches the original.
   */
  private trimMp3(buf: AudioBuffer, g: Mp3Gapless | null): AudioBuffer {
    if (!g) return buf;
    const k = buf.sampleRate / g.rate; // the decoder may have resampled to the context rate
    const expected = Math.round((g.frames * g.spf - g.startPad - g.endPad) * k);
    const extra = buf.length - expected;
    if (expected <= 0 || extra <= 64 * k) return buf;
    // Untrimmed output = [delay + 529 decoder samples (+ the Info frame as silence)][audio][padding - 529].
    const lead = Math.round((extra / k - g.endPad + 529) * k);
    if (lead <= 0 || lead >= buf.length) return buf;
    const len = Math.min(expected, buf.length - lead);
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(lead, lead + len), ch);
    return out;
  }

  /** Render a synth recipe's variations (once; later calls share the same job). Never rejects. */
  private renderSynth(name: string): Promise<void> {
    const running = this.synthJobs.get(name);
    if (running) return running;
    const recipe = RECIPES[name];
    let job: Promise<void>;
    if (!recipe) {
      console.warn(`[audio] missing synth recipe "${name}"`);
      job = Promise.resolve();
    } else {
      const list: AudioBuffer[] = [];
      this.synthBuffers.set(name, list);
      const renders: Promise<void>[] = [];
      for (let v = 0; v < VARIATIONS; v++) {
        if (recipe.samples) {
          const data = recipe.samples(RENDER_RATE);
          const buf = this.ctx.createBuffer(1, data.length, RENDER_RATE);
          buf.getChannelData(0).set(data);
          list.push(recipe.drive ? this.saturate(buf, recipe.drive) : buf);
          continue;
        }
        renders.push(
          this.synthLimit
            .run(() => {
              const off = new OfflineAudioContext(1, Math.ceil(recipe.dur * RENDER_RATE), RENDER_RATE);
              recipe.render!(off);
              return off.startRendering();
            })
            .then((buf) => void list.push(recipe.drive ? this.saturate(buf, recipe.drive) : buf)),
        );
      }
      job = Promise.all(renders).then(
        () => undefined,
        (err) => console.warn(`[audio] synth "${name}" failed`, err),
      );
    }
    this.synthJobs.set(name, job);
    return job;
  }

  /**
   * A looping bed (ambience): starts silent; the caller fades its gain. Rate can
   * be changed (machines spinning down). Null if the file didn't load.
   */
  startLoop(file: string): { gain: GainNode; src: AudioBufferSourceNode } | null {
    const buf = this.fileBuffers.get(file);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.world);
    src.start(this.ctx.currentTime, Math.random() * buf.duration);
    return { gain, src };
  }

  /** Audio clock (seconds). */
  get now(): number {
    return this.ctx.currentTime;
  }

  /** Must be called from a user gesture (mobile browsers require it). */
  unlock(): void {
    if (this.disabled) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    if (this.watching) return;
    this.watching = true;
    // Browsers suspend audio after focus changes or device switches (and phones suspend it
    // in the background, see the constructor): resume on the next input or when the page
    // comes back, instead of staying silent for the rest of the run. WebKit only unlocks
    // audio on the end of a touch (touchend / pointerup / click), never on touchstart.
    const resume = () => {
      if (this.ctx.state !== 'running' && document.visibilityState === 'visible') void this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(ev, resume, { passive: true });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && resume());
    window.addEventListener('pageshow', resume);
  }
  private watching = false;

  setListener(position: THREE.Vector3, right: THREE.Vector3): void {
    this.listenerPos.copy(position);
    this.listenerRight.copy(right);
  }

  setVolume(v: number): void {
    this.master.gain.value = v;
  }

  play(name: string, opts?: PlayOptions): void {
    if (this.disabled || !this.ready || !name || this.ctx.state !== 'running') return;
    const ev: SoundEvent | undefined = SOUND_BANK[name];
    if (!ev) return;
    // Phones: world sounds get half the voices, each held for its real length (every voice is
    // a handful of live nodes on the audio thread). Your own sounds (no position) keep the full
    // count in a pool of their own, so bots firing the same gun can never mute your shots.
    const budgeted = this.lowSpec && !!opts?.position;
    const key = this.lowSpec && !opts?.position ? `${name}#own` : name;
    const ends = (this.voices.get(key) ?? []).filter((t) => t > this.ctx.currentTime);
    const maxVoices = ev.maxVoices ?? 6;
    if (ends.length >= (budgeted ? Math.max(1, Math.round(maxVoices * 0.5)) : maxVoices)) {
      this.voices.set(key, ends);
      return;
    }

    let gain = opts?.volume ?? 1;
    let pan = 0;
    let dist = 0;
    let occluded = 0;
    const gunfire = ev.layers.some((l) => l.range === 'far');
    if (opts?.position && ev.bus !== 'ui') {
      const d = this.tmp.subVectors(opts.position, this.listenerPos);
      dist = d.length();
      // Phones: far-off gunfire is skipped before it costs a ray or a node.
      if (this.lowSpec && gunfire && !ev.noCull && dist > GUNFIRE_CULL) return;
      // Gunfire carries (it has its own distant layers). Everything else — impacts,
      // footfalls, robots, lifts, hazards — is local: it fades fast and is cut at
      // its range, so fights across the map don't fill your ears with clinks.
      if (gunfire) gain *= 1 / (1 + dist * 0.06);
      else if (ev.voice) {
        const maxDist = ev.maxDist ?? 60;
        if (dist > maxDist) return;
        gain *= Math.max(0.45, 1 - dist / maxDist);
      } else {
        const maxDist = ev.maxDist ?? 30;
        if (dist > maxDist) return;
        const k = dist / maxDist;
        gain *= (1 - k * k) / (1 + dist * 0.12);
      }
      if (dist > 0.01) pan = Math.max(-0.8, Math.min(0.8, d.dot(this.listenerRight) / dist));
      // Phones: near-centre sounds skip the panner node.
      if (this.lowSpec && Math.abs(pan) < 0.15) pan = 0;
      if (dist > 2.5 && this.occlusion) {
        occluded = this.lowSpec ? this.occlusionCached(opts.position) : this.occlusion(opts.position);
        gain *= 1 - 0.42 * occluded;
      }
    }
    if (gain < 0.01) return;

    const pitch = (opts?.pitch ?? 1) * (ev.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (ev.pitchVariance ?? 0));
    const now = this.ctx.currentTime;
    let longest = 0;
    // Your own gunshot (no position, has distance bands): louder, a chest kick under it,
    // and the rest of the world ducks for a moment so the shot owns the mix.
    const self = !opts?.position && ev.layers.some((l) => l.range === 'far');
    if (self) {
      gain *= 1.2;
      const w = this.world.gain;
      w.cancelScheduledValues(now);
      w.setValueAtTime(w.value, now);
      w.linearRampToValueAtTime(0.5, now + 0.008);
      w.setTargetAtTime(1, now + 0.06, 0.12);
      this.play('self.kick');
    }
    const bus = opts?.position ? this.world : this.master;
    let out: AudioNode = bus;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(bus);
      out = p;
    }
    // Air and walls: the further a sound travels the more of its top end it loses
    // (a far gunshot is a dull thump), and through walls it comes out muffled.
    // The reverb send is taken after the filter (what you hear of another room is muffled too).
    if (dist > 4) {
      let cutoff = 20000 * Math.exp(-dist / (gunfire ? 55 : 30));
      if (occluded > 0) cutoff *= 1 - 0.78 * occluded;
      cutoff = Math.max(occluded > 0.5 ? 380 : 900, cutoff);
      if (cutoff < 16000) {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cutoff;
        lp.Q.value = 0.6;
        lp.connect(out);
        out = lp;
        if (occluded > 0.5 && !this.lowSpec) {
          // Behind walls: a second pole (steeper) and the body of the sound kept (not on phones).
          const lp2 = this.ctx.createBiquadFilter();
          lp2.type = 'lowpass';
          lp2.frequency.value = cutoff * 1.4;
          lp2.Q.value = 0.5;
          const body = this.ctx.createBiquadFilter();
          body.type = 'lowshelf';
          body.frequency.value = 160;
          body.gain.value = 3;
          lp2.connect(body).connect(lp);
          out = lp2;
        }
      }
    }
    let send: GainNode | null = null;
    if (ev.reverb) {
      send = this.ctx.createGain();
      send.gain.value = ev.reverb * Math.min(1.5, (opts?.volume ?? 1) * 0.6 + 0.4 + (1 - gain) * 0.5) * (0.7 + 0.6 * this.space) * (1 + 0.5 * occluded);
      send.connect(this.reverbIn);
    }
    // Distance bands: the close blast gives way to the distant report.
    const smooth = (a0: number, a1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a0) / (a1 - a0)));
      return t * t * (3 - 2 * t);
    };
    const far = smooth(18, 50, dist);
    const farthest = smooth(70, 120, dist);
    for (const layer of ev.layers) {
      let band = 1;
      if (layer.range === 'near') band = 1 - far;
      else if (layer.range === 'far') band = far * (1 - farthest);
      else if (layer.range === 'farthest') band = farthest;
      if (band < 0.02) continue;
      if (layer.tail) {
        // Phones: the reverb send already gives every shot its room; the extra tail layer is skipped.
        if (this.lowSpec) continue;
        band *= 0.45 + 0.9 * this.space;
      }
      let pickFile = layer.file;
      if (layer.files?.length) {
        // Never the same variation twice in a row (repetition is what you notice first).
        const last = this.lastPick.get(layer) ?? -1;
        let i = (Math.random() * layer.files.length) | 0;
        if (i === last && layer.files.length > 1) i = (i + 1 + ((Math.random() * (layer.files.length - 1)) | 0)) % layer.files.length;
        this.lastPick.set(layer, i);
        pickFile = layer.files[i];
      }
      const buf = (pickFile && this.fileBuffers.get(pickFile)) || this.pickSynth(layer.synth);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      const g = this.ctx.createGain();
      g.gain.value = layer.gain * gain * band;
      src.connect(g).connect(out);
      if (send && !layer.dry) (out === bus || out instanceof StereoPannerNode ? g : out).connect(send);
      src.start(now + (layer.delay ?? 0));
      longest = Math.max(longest, (layer.delay ?? 0) + buf.duration / pitch);
    }
    // Phones hold a world voice's slot until it really ends, so the cap is a true node budget.
    ends.push(now + longest * (budgeted ? 1 : 0.6));
    this.voices.set(key, ends);
  }

  /** occlusion() with each result reused for OCCLUSION_TTL per 2 m cell of the source (lowSpec). */
  private occlusionCached(at: THREE.Vector3): number {
    const key = (Math.round(at.x / 2) + 2048) * 16777216 + (Math.round(at.y / 2) + 2048) * 4096 + (Math.round(at.z / 2) + 2048);
    const t = performance.now();
    const hit = this.occCache.get(key);
    if (hit && t - hit.t < OCCLUSION_TTL) return hit.v;
    const v = this.occlusion!(at);
    if (hit) {
      hit.t = t;
      hit.v = v;
    } else {
      if (this.occCache.size >= 256) for (const [k, e] of this.occCache) if (t - e.t >= OCCLUSION_TTL) this.occCache.delete(k);
      this.occCache.set(key, { t, v });
    }
    return v;
  }

  private pickSynth(name?: string): AudioBuffer | undefined {
    if (!name) return undefined;
    const list = this.synthBuffers.get(name);
    if (!list || list.length === 0) return undefined;
    return list[(Math.random() * list.length) | 0];
  }
}
