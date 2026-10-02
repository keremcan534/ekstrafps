import * as THREE from 'three';
import { RECIPES } from './Synth';
import { SOUND_BANK, type SoundEvent } from './SoundBank';
import { feel } from '../config/Feel';

const VARIATIONS = 3;
const RENDER_RATE = 44100;

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
  private voices = new Map<string, number>();
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private tmp = new THREE.Vector3();
  ready = false;
  private lastPick = new WeakMap<object, number>();
  /** 0 = small room (short tails) … 1 = huge hall (long tails, more reverb). Set by the game. */
  space = 0.5;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    // Gentle bus compression: shots keep their transient (the punch) instead of being squashed.
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master = this.ctx.createGain();
    this.master.gain.value = feel.masterVolume;
    this.master.connect(comp).connect(this.ctx.destination);
    this.world = this.ctx.createGain();
    this.world.connect(this.master);

    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.buildRoomImpulse(2.3);
    this.reverbIn = this.ctx.createGain();
    const wet = this.ctx.createGain();
    wet.gain.value = 0.68;
    this.reverbIn.connect(convolver).connect(wet).connect(this.master);
  }

  /**
   * Procedural impulse response of a hard indoor range: a cluster of early wall
   * reflections, then a dense tail that darkens as it decays.
   */
  private buildRoomImpulse(seconds: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    const early = [0.009, 0.014, 0.021, 0.029, 0.038, 0.05, 0.063, 0.081];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const n = (Math.random() * 2 - 1) * Math.exp(-t / 0.42);
        const k = Math.min(0.92, 0.25 + t * 0.9); // darker over time
        lp = lp * k + n * (1 - k);
        d[i] = lp * (t < 0.012 ? t / 0.012 : 1) * 1.6;
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

  /** Pre-render all synth recipes and load any sample files. */
  async init(): Promise<void> {
    const needed = new Set<string>();
    const files = new Set<string>();
    for (const ev of Object.values(SOUND_BANK)) {
      for (const l of ev.layers) {
        if (l.synth) needed.add(l.synth);
        if (l.file) files.add(l.file);
        for (const f of l.files ?? []) files.add(f);
      }
    }
    const jobs: Promise<void>[] = [];
    for (const name of needed) {
      const recipe = RECIPES[name];
      if (!recipe) {
        console.warn(`[audio] missing synth recipe "${name}"`);
        continue;
      }
      const list: AudioBuffer[] = [];
      this.synthBuffers.set(name, list);
      for (let v = 0; v < VARIATIONS; v++) {
        if (recipe.samples) {
          const data = recipe.samples(RENDER_RATE);
          const buf = this.ctx.createBuffer(1, data.length, RENDER_RATE);
          buf.getChannelData(0).set(data);
          list.push(recipe.drive ? this.saturate(buf, recipe.drive) : buf);
          continue;
        }
        const off = new OfflineAudioContext(1, Math.ceil(recipe.dur * RENDER_RATE), RENDER_RATE);
        recipe.render!(off);
        jobs.push(off.startRendering().then((buf) => void list.push(recipe.drive ? this.saturate(buf, recipe.drive) : buf)));
      }
    }
    for (const file of files) {
      jobs.push(
        fetch(file)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((data) => this.ctx.decodeAudioData(data))
          .then((buf) => void this.fileBuffers.set(file, buf))
          .catch(() => console.info(`[audio] ${file} not found, using synth fallback`)),
      );
    }
    await Promise.all(jobs);
    this.ready = true;
  }

  /** Must be called from a user gesture (mobile browsers require it). */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setListener(position: THREE.Vector3, right: THREE.Vector3): void {
    this.listenerPos.copy(position);
    this.listenerRight.copy(right);
  }

  setVolume(v: number): void {
    this.master.gain.value = v;
  }

  play(name: string, opts?: PlayOptions): void {
    if (!this.ready || !name || this.ctx.state !== 'running') return;
    const ev: SoundEvent | undefined = SOUND_BANK[name];
    if (!ev) return;
    const active = this.voices.get(name) ?? 0;
    if (active >= (ev.maxVoices ?? 6)) return;

    let gain = opts?.volume ?? 1;
    let pan = 0;
    let dist = 0;
    if (opts?.position && ev.bus !== 'ui') {
      const d = this.tmp.subVectors(opts.position, this.listenerPos);
      dist = d.length();
      // Gunfire carries (it has its own distant layers). Everything else — impacts,
      // footfalls, robots, lifts, hazards — is local: it fades fast and is cut at
      // its range, so fights across the map don't fill your ears with clinks.
      const gunfire = ev.layers.some((l) => l.range === 'far');
      if (gunfire) gain *= 1 / (1 + dist * 0.06);
      else {
        const maxDist = ev.maxDist ?? 30;
        if (dist > maxDist) return;
        const k = dist / maxDist;
        gain *= (1 - k * k) / (1 + dist * 0.12);
      }
      if (dist > 0.01) pan = Math.max(-0.8, Math.min(0.8, d.dot(this.listenerRight) / dist));
    }
    if (gain < 0.01) return;

    const pitch = (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (ev.pitchVariance ?? 0));
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
    // Room reverb send (distant sounds are relatively wetter).
    let send: GainNode | null = null;
    if (ev.reverb) {
      send = this.ctx.createGain();
      send.gain.value = ev.reverb * Math.min(1.5, (opts?.volume ?? 1) * 0.6 + 0.4 + (1 - gain) * 0.5) * (0.7 + 0.6 * this.space);
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
      if (layer.tail) band *= 0.45 + 0.9 * this.space;
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
      if (send && !layer.dry) g.connect(send);
      src.start(now + (layer.delay ?? 0));
      longest = Math.max(longest, (layer.delay ?? 0) + buf.duration / pitch);
    }
    this.voices.set(name, active + 1);
    setTimeout(() => this.voices.set(name, Math.max(0, (this.voices.get(name) ?? 1) - 1)), longest * 1000 * 0.6);
  }

  private pickSynth(name?: string): AudioBuffer | undefined {
    if (!name) return undefined;
    const list = this.synthBuffers.get(name);
    if (!list || list.length === 0) return undefined;
    return list[(Math.random() * list.length) | 0];
  }
}
