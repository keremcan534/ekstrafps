import * as THREE from 'three';

/**
 * Everything bots can hear. Gameplay code emits noises where they happen
 * (shots, steps, reloads, doors, blasts, robots, impacts); each bot reads the
 * new ones on its perception tick and turns them into estimated positions.
 * Nothing here is "where the enemy is": only where a sound came from.
 */
export type NoiseKind = 'gunshot' | 'gunshot_sup' | 'step' | 'sprint' | 'reload' | 'door' | 'explosion' | 'robot' | 'impact' | 'voice';

export interface Noise {
  id: number;
  kind: NoiseKind;
  pos: THREE.Vector3;
  team: string;
  /** Who made it (shooter / walker), when known: lets a hearing update the right contact. */
  source: object | null;
  time: number;
  /** Loudness multiplier on the kind's base range. */
  loud: number;
}

/** Base hearing range (m) per kind. */
export const NOISE_RANGE: Record<NoiseKind, number> = {
  gunshot: 85,
  gunshot_sup: 22,
  step: 7,
  sprint: 16,
  reload: 9,
  door: 32,
  explosion: 130,
  robot: 18,
  impact: 11,
  voice: 24,
};

/** How much a noise tells about a threat (confidence weight). */
export const NOISE_WEIGHT: Record<NoiseKind, number> = {
  gunshot: 1,
  gunshot_sup: 0.8,
  step: 0.55,
  sprint: 0.65,
  reload: 0.7,
  door: 0.45,
  explosion: 0.35,
  robot: 0.5,
  impact: 0.4,
  voice: 0.6,
};

const KEEP = 1.6; // seconds a noise stays readable

export class NoiseBus {
  private list: Noise[] = [];
  private nextId = 1;
  /** Per-source throttle (automatic fire would flood the list). */
  private lastBySource = new WeakMap<object, { kind: NoiseKind; time: number; noise: Noise }>();

  /** When each source last fired (muzzle flashes give shooters away). */
  private lastShot = new WeakMap<object, number>();

  emit(kind: NoiseKind, pos: THREE.Vector3, team: string, source: object | null, time: number, loud = 1): void {
    if (source && (kind === 'gunshot' || kind === 'gunshot_sup')) this.lastShot.set(source, time);
    if (source) {
      const last = this.lastBySource.get(source);
      // Same source, same kind, within 0.15 s: just move the existing noise (a burst is one event).
      if (last && last.kind === kind && time - last.time < 0.15) {
        last.noise.pos.copy(pos);
        last.noise.time = time;
        last.noise.loud = Math.max(last.noise.loud, loud);
        last.time = time;
        return;
      }
    }
    const n: Noise = { id: this.nextId++, kind, pos: pos.clone(), team, source, time, loud };
    this.list.push(n);
    if (source) this.lastBySource.set(source, { kind, time, noise: n });
  }

  /** Noises newer than `id` (and updated ones) since `since` seconds. */
  *since(id: number, since: number): Generator<Noise> {
    for (const n of this.list) if (n.id > id || n.time > since) yield n;
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  prune(now: number): void {
    let k = 0;
    for (const n of this.list) if (now - n.time < KEEP) this.list[k++] = n;
    this.list.length = k;
  }

  /** Did `source` fire in the last `window` seconds (its muzzle flash gives it away)? */
  firedRecently(source: object, now: number, window: number): boolean {
    const t = this.lastShot.get(source);
    return t !== undefined && now - t < window;
  }

  /** Debug: everything still readable. */
  get all(): readonly Noise[] {
    return this.list;
  }
}
