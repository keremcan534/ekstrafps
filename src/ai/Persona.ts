import type { Personality } from '../game/TeamAgent';
import type { ProfileId } from './Tuning';

/**
 * How a bot fights (not how well it shoots): SAIN-style personalities. The decision
 * rules are the same for everyone; these numbers decide when each rule fires.
 *
 *   gigachad  — hunts you down: searches at once, rushes, ADADs, never retreats
 *   chad      — aggressive: short holds, rushes a reloading enemy, sprints
 *   wreckless — runs straight at fights, barely takes cover
 *   normal    — takes cover, holds a while, then goes looking
 *   turtle    — "snapping turtle": digs in, holds angles for long, ambushes
 *   timmy     — nervous: slow to search, quick to fall back
 *   rat       — sneaky: holds forever, crouch-walks, rarely pushes
 *   coward    — avoids fights, falls back early
 */
export type PersonaId = 'gigachad' | 'chad' | 'wreckless' | 'normal' | 'turtle' | 'timmy' | 'rat' | 'coward';

export interface Persona {
  id: PersonaId;
  /** Lost sight of the enemy: seconds holding the angle before going to look (min, max). */
  searchAfter: [number, number];
  /** Pause before stepping into a search (listening). */
  searchWait: number;
  /** Search pace far from the target area (close in, everyone walks with the gun up). */
  searchPace: 'sprint' | 'run' | 'walk';
  /** Seconds in one cover before shifting to the next. */
  shiftCoverAfter: number;
  /** Close quarters: dogfight under the first distance, back to normal past the second. */
  dogfight: [number, number];
  /** Charges an enemy who's reloading, pinned or the squad says push. */
  rushes: boolean;
  /** 0..1: chance to stand and shoot in the open instead of working to cover. */
  standAndShoot: number;
  /** Health fraction where it falls back (0 = never). */
  retreatHp: number;
  /** Seconds between peeks / leans from cover (min, max). */
  peekEvery: [number, number];
  /** Exposure per peek (× the base). */
  exposure: number;
  /** Kneels to shoot at range. */
  crouchesAtRange: boolean;
  /** Chance to go and check an unexplained noise (otherwise it holds and waits). */
  investigates: number;
  /** A-D-A-D strafing in close and mid-range gunfights. */
  adad: boolean;
  /** Sprints in combat (cover runs, pushes, searches). */
  sprints: boolean;
  /** Squad: likes the flanker / assault jobs. */
  flanks: boolean;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  gigachad: { id: 'gigachad', searchAfter: [1, 3], searchWait: 0.2, searchPace: 'sprint', shiftCoverAfter: 6, dogfight: [14, 20], rushes: true, standAndShoot: 0.75, retreatHp: 0, peekEvery: [0.8, 1.8], exposure: 1.6, crouchesAtRange: false, investigates: 1, adad: true, sprints: true, flanks: true },
  chad: { id: 'chad', searchAfter: [3, 7], searchWait: 0.4, searchPace: 'run', shiftCoverAfter: 8, dogfight: [11, 16], rushes: true, standAndShoot: 0.5, retreatHp: 0.2, peekEvery: [1, 2.4], exposure: 1.3, crouchesAtRange: false, investigates: 0.9, adad: true, sprints: true, flanks: true },
  wreckless: { id: 'wreckless', searchAfter: [0.5, 2], searchWait: 0, searchPace: 'sprint', shiftCoverAfter: 5, dogfight: [12, 18], rushes: true, standAndShoot: 0.85, retreatHp: 0, peekEvery: [0.8, 1.6], exposure: 1.7, crouchesAtRange: false, investigates: 1, adad: false, sprints: true, flanks: true },
  normal: { id: 'normal', searchAfter: [8, 16], searchWait: 0.8, searchPace: 'run', shiftCoverAfter: 9, dogfight: [8, 12], rushes: false, standAndShoot: 0.25, retreatHp: 0.32, peekEvery: [1.4, 3.2], exposure: 1, crouchesAtRange: true, investigates: 0.6, adad: false, sprints: true, flanks: true },
  turtle: { id: 'turtle', searchAfter: [16, 30], searchWait: 1.2, searchPace: 'walk', shiftCoverAfter: 14, dogfight: [7, 10], rushes: false, standAndShoot: 0.15, retreatHp: 0.35, peekEvery: [1.6, 3.6], exposure: 0.9, crouchesAtRange: true, investigates: 0.3, adad: false, sprints: false, flanks: false },
  timmy: { id: 'timmy', searchAfter: [20, 40], searchWait: 1.5, searchPace: 'walk', shiftCoverAfter: 12, dogfight: [6, 9], rushes: false, standAndShoot: 0.1, retreatHp: 0.5, peekEvery: [2, 4.5], exposure: 0.7, crouchesAtRange: true, investigates: 0.25, adad: false, sprints: true, flanks: false },
  rat: { id: 'rat', searchAfter: [30, 60], searchWait: 2, searchPace: 'walk', shiftCoverAfter: 18, dogfight: [5, 8], rushes: false, standAndShoot: 0.1, retreatHp: 0.45, peekEvery: [2.5, 5], exposure: 0.6, crouchesAtRange: true, investigates: 0.15, adad: false, sprints: false, flanks: false },
  coward: { id: 'coward', searchAfter: [40, 80], searchWait: 2, searchPace: 'walk', shiftCoverAfter: 14, dogfight: [6, 9], rushes: false, standAndShoot: 0.05, retreatHp: 0.65, peekEvery: [2.5, 5], exposure: 0.6, crouchesAtRange: true, investigates: 0.1, adad: false, sprints: true, flanks: false },
};

/** The old tactical profile (and the elite flag) → a fighting personality. */
export function personaFor(profile: ProfileId, p: Personality, chad: boolean): Persona {
  if (chad) return PERSONAS.gigachad;
  switch (profile) {
    case 'reckless':
      return PERSONAS[Math.random() < 0.6 ? 'wreckless' : 'chad'];
    case 'aggressive':
      return PERSONAS[Math.random() < 0.75 ? 'chad' : 'normal'];
    case 'tactical':
      return PERSONAS[Math.random() < 0.6 ? 'normal' : 'turtle'];
    case 'cautious':
      return PERSONAS[p.role === 'marksman' ? 'turtle' : Math.random() < 0.5 ? 'timmy' : 'rat'];
    default:
      return PERSONAS[Math.random() < 0.8 ? 'normal' : 'chad'];
  }
}
