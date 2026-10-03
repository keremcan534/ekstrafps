import * as THREE from 'three';
import type { Combatant } from '../game/TeamAgent';
import { NoiseBus, type NoiseKind } from './NoiseBus';
import { AI_TUNING } from './Tuning';

/** What the AI world needs from a bot (keeps this module free of the Bot class). */
export interface AIListener {
  readonly team: string;
  /** The bot's own shooter object (its bullets carry it as owner). */
  readonly owner: object;
  readonly alive: boolean;
  /** Chest position (near-miss distance is measured from here). */
  chest(out: THREE.Vector3): THREE.Vector3;
  /** A round passed `dist` m away; it came from around `origin`, fired by `owner`. */
  onNearMiss(dist: number, origin: THREE.Vector3, owner: object | null, team: string): void;
}

/**
 * Shared AI state for one frame: the clock, everything audible, the ray budget,
 * and hooks into the rest of the game (who owns a bullet, how dark it is).
 * One per page (there is one game).
 */
class AIWorld {
  time = 0;
  readonly noise = new NoiseBus();
  readonly listeners = new Set<AIListener>();
  /** 0..1 how dark the facility is (vision gets worse). */
  darkness = 0;
  /** Is this combatant lit (flashlight on, weapon light)? */
  isLit: (c: Combatant) => boolean = () => false;
  /** Bullet owner (player controller / soldier) → combatant record. */
  resolveOwner: (owner: object | null) => Combatant | null = () => null;
  private rays = 0;
  private covers = 0;
  /** Stats for the debug HUD. */
  stats = { rays: 0, raysDenied: 0, coverQueries: 0 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  beginFrame(dt: number): void {
    this.time += dt;
    this.stats.rays = AI_TUNING.rayBudgetPerFrame - this.rays;
    this.rays = AI_TUNING.rayBudgetPerFrame;
    this.covers = AI_TUNING.coverQueriesPerFrame;
    this.noise.prune(this.time);
  }

  /** Take one perception ray from this frame's budget. */
  takeRay(): boolean {
    if (this.rays <= 0) {
      this.stats.raysDenied++;
      return false;
    }
    this.rays--;
    return true;
  }

  takeCoverQuery(): boolean {
    if (this.covers <= 0) return false;
    this.covers--;
    this.stats.coverQueries++;
    return true;
  }

  emit(kind: NoiseKind, pos: THREE.Vector3, team: string, source: object | null, loud = 1): void {
    this.noise.emit(kind, pos, team, source, this.time, loud);
  }

  /**
   * One integration step of a flying round (start → start + dir·len). Bots it
   * passes close to feel it (suppression) and learn roughly where it came from.
   */
  bulletSegment(start: THREE.Vector3, dir: THREE.Vector3, len: number, origin: THREE.Vector3, owner: object | null, team: string): void {
    for (const l of this.listeners) {
      if (!l.alive || l.team === team || l.owner === owner) continue;
      const c = l.chest(this.tmp);
      // Quick reject: farther than the segment reach.
      const dx = c.x - start.x;
      const dy = c.y - start.y;
      const dz = c.z - start.z;
      if (dx * dx + dy * dy + dz * dz > (len + 2.5) * (len + 2.5)) continue;
      const t = Math.max(0, Math.min(len, dx * dir.x + dy * dir.y + dz * dir.z));
      const p = this.tmp2.copy(start).addScaledVector(dir, t);
      const d = p.distanceTo(c);
      if (d < 2.2) l.onNearMiss(d, origin, owner, team);
    }
  }

  /** A round hit something: bots right next to the impact flinch too. */
  bulletImpact(point: THREE.Vector3, origin: THREE.Vector3, owner: object | null, team: string): void {
    this.noise.emit('impact', point, team, owner, this.time, 1);
    for (const l of this.listeners) {
      if (!l.alive || l.team === team || l.owner === owner) continue;
      const d = l.chest(this.tmp).distanceTo(point);
      if (d < 2.4) l.onNearMiss(d + 0.3, origin, owner, team);
    }
  }
}

export const aiWorld = new AIWorld();
