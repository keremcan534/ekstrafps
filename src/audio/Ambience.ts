import * as THREE from 'three';
import type { AudioSystem } from './AudioSystem';
import { AMBIENCE_LOOPS } from './SoundBank';

type Bed = 'room' | 'hvac' | 'servers' | 'power' | 'wind' | 'dark';

/** Where you are (Site-9 room id + style), or null on the lab map. */
export interface AmbienceSpot {
  id: string;
  style: string;
  /** Open to the sky (garden) or under skylights (atrium). */
  open: boolean;
}

const OFFICE = new Set(['lobby', 'cafe', 'security', 'medical', 'labs', 'barracks']);
/** Overall bed level (ambience sits under everything). */
const LEVEL = 0.38;

/**
 * Site-9's room tone: looping beds mixed by the room you're in — ducts in the
 * offices, fans and hum in the server hall, rumble and buzz in the plant, wind
 * under the skylights — and by the power: in a blackout the machines spin down
 * (their pitch sags as they stop) and a low drone takes over. Now and then the
 * building makes a noise somewhere off in the dark (a creak, a thump, a duct
 * rattling); those are positional, so walls muffle them.
 */
export class Ambience {
  private beds = new Map<Bed, { gain: GainNode; src: AudioBufferSourceNode }>();
  private level = new Map<Bed, number>();
  private rate = 1;
  private next = 10;
  private tmp = new THREE.Vector3();
  /** Seconds until the next try at starting beds whose files haven't loaded yet (they load after PLAY). */
  private retry = 1;

  constructor(private audio: AudioSystem) {
    this.startBeds();
  }

  /** Start every bed whose file is loaded; the rest are retried from update(). */
  private startBeds(): void {
    for (const file of AMBIENCE_LOOPS) {
      const name = file.split('/').pop()!.replace('.wav', '') as Bed;
      if (this.beds.has(name)) continue;
      const bed = this.audio.startLoop(file);
      if (!bed) continue;
      // A bed that joins late picks up the current spin-down (its level is set in update()).
      if (name === 'hvac' || name === 'servers' || name === 'power') bed.src.playbackRate.value = this.rate;
      this.beds.set(name, bed);
    }
  }

  update(dt: number, spot: AmbienceSpot | null, darkness: number, listener: THREE.Vector3): void {
    if (this.beds.size < AMBIENCE_LOOPS.length) {
      this.retry -= dt;
      if (this.retry <= 0) {
        this.retry = 1;
        this.startBeds();
      }
    }
    const want: Record<Bed, number> = { room: 0.35, hvac: 0, servers: 0, power: 0, wind: 0, dark: 0 };
    const id = spot?.id ?? '';
    const style = spot?.style ?? 'lab';
    if (OFFICE.has(style) || style === 'lab') want.hvac = 0.5;
    else if (style === 'factory' || style === 'hangar') want.hvac = 0.25;
    if (id === 'servers') want.servers = 0.75;
    else if (id === 'cooling') want.servers = 0.35;
    if (id === 'power') want.power = 0.9;
    else if (id === 'cooling') want.power = 0.5;
    else if (style === 'factory') want.power = 0.25;
    else if (style === 'hangar') want.power = 0.12;
    if (spot?.open) want.wind = style === 'garden' ? 0.7 : 0.5;
    else if (style === 'hangar') want.wind = 0.18;
    // Blackout: the machines die, the room goes still, a low drone comes up.
    const live = 1 - darkness;
    want.hvac *= live;
    want.servers *= live;
    want.power *= live;
    want.room *= 1 - 0.55 * darkness;
    want.dark = 0.75 * darkness;
    const now = this.audio.now;
    for (const [name, bed] of this.beds) {
      const target = want[name] * LEVEL;
      if (Math.abs((this.level.get(name) ?? -1) - target) > 0.002) {
        this.level.set(name, target);
        bed.gain.gain.setTargetAtTime(target, now, 1.2);
      }
    }
    // Spin-down: only schedule a change when it's real (every call adds an automation
    // event the audio thread keeps; once a frame would pile up thousands).
    const rate = 0.55 + 0.45 * live;
    if (Math.abs(rate - this.rate) > 0.01) {
      this.rate = rate;
      for (const name of ['hvac', 'servers', 'power'] as const) this.beds.get(name)?.src.playbackRate.setTargetAtTime(rate, now, 0.8);
    }

    // The building, somewhere off in the dark.
    this.next -= dt;
    if (this.next <= 0) {
      this.next = darkness > 0.5 ? 6 + Math.random() * 9 : 12 + Math.random() * 16;
      const a = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 28;
      const at = this.tmp.set(listener.x + Math.sin(a) * r, 2 + Math.random() * 4, listener.z + Math.cos(a) * r);
      const k = Math.random();
      this.audio.play(k < 0.5 ? 'amb.groan' : k < 0.75 ? 'amb.thump' : 'amb.rattle', { position: at, volume: 0.5 + Math.random() * 0.4 });
    }
  }
}
