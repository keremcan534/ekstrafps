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
  private synthBuffers = new Map<string, AudioBuffer[]>();
  private fileBuffers = new Map<string, AudioBuffer>();
  private voices = new Map<string, number>();
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private tmp = new THREE.Vector3();
  ready = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master = this.ctx.createGain();
    this.master.gain.value = feel.masterVolume;
    this.master.connect(comp).connect(this.ctx.destination);
  }

  /** Pre-render all synth recipes and load any sample files. */
  async init(): Promise<void> {
    const needed = new Set<string>();
    const files = new Set<string>();
    for (const ev of Object.values(SOUND_BANK)) {
      for (const l of ev.layers) {
        if (l.synth) needed.add(l.synth);
        if (l.file) files.add(l.file);
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
        const off = new OfflineAudioContext(1, Math.ceil(recipe.dur * RENDER_RATE), RENDER_RATE);
        recipe.render(off);
        jobs.push(off.startRendering().then((buf) => void list.push(buf)));
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
    if (opts?.position && ev.bus !== 'ui') {
      const d = this.tmp.subVectors(opts.position, this.listenerPos);
      const dist = d.length();
      gain *= 1 / (1 + dist * 0.06);
      if (dist > 0.01) pan = Math.max(-0.8, Math.min(0.8, d.dot(this.listenerRight) / dist));
    }
    if (gain < 0.01) return;

    const pitch = (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (ev.pitchVariance ?? 0));
    const now = this.ctx.currentTime;
    let longest = 0;
    let out: AudioNode = this.master;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.master);
      out = p;
    }
    for (const layer of ev.layers) {
      const buf = (layer.file && this.fileBuffers.get(layer.file)) || this.pickSynth(layer.synth);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      const g = this.ctx.createGain();
      g.gain.value = layer.gain * gain;
      src.connect(g).connect(out);
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
