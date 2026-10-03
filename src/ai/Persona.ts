import type { Personality } from '../game/TeamAgent';
import type { ProfileId } from './Tuning';

/**
 * How a bot fights (not how well it shoots): SAIN-style personalities. The decision
 * rules are the same for everyone; these numbers decide when each rule fires.
 * (Search delays are much shorter than SAIN's: these maps are small and fights fast.)
 *
 *   gigachad  — hunts you down: searches at once, rushes, ADADs, never retreats
 *   chad      — aggressive: short holds, rushes a reloading enemy, sprints
 *   wreckless — charges what it hears, barely takes cover
 *   normal    — takes cover, holds a while, then goes looking
 *   turtle    — "snapping turtle": digs in, holds angles, crouch-walks, no suppressing
 *   timmy     — nervous: slow to search, quick to fall back, never shifts cover
 *   rat       — sneaky: holds forever, crouch-walks, no suppressing, never shifts
 *   coward    — avoids fights, falls back early
 */
export type PersonaId = 'gigachad' | 'chad' | 'wreckless' | 'normal' | 'turtle' | 'timmy' | 'rat' | 'coward';

export interface Persona {
  id: PersonaId;
  /** First sight of an enemy in the open: stand and shoot this long (s) before going for cover. */
  holdGround: number;
  /** Random scale on the hold (min, max). */
  holdGroundRange: [number, number];
  /** Lost sight of the enemy: seconds holding the angle before going to look (min, max). */
  searchAfter: [number, number];
  /** Pause before stepping into a search (listening). */
  searchWait: number;
  /** Chance to sprint a search leg (rolled every few seconds). */
  searchSprint: number;
  /** Crouch-walks the last stretch of a search and slows at corners. */
  sneaky: boolean;
  /** Shifts to another cover at all (rats, timmies and cowards stay put). */
  shifts: boolean;
  /** Seconds in one cover before shifting to the next. */
  shiftCoverAfter: number;
  /** Close quarters: dogfight under the first distance, back to normal past the second. */
  dogfight: [number, number];
  /** Charges an enemy who's reloading, or one a squadmate has pinned down. */
  rushes: boolean;
  /** 0..1: how much it stays in the open under fire instead of running for cover. */
  standAndShoot: number;
  /** Health fraction where it falls back (0 = never). */
  retreatHp: number;
  /** Seconds back in cover between peeks / leans (min, max). */
  peekEvery: [number, number];
  /** Exposure per peek (× the base). */
  exposure: number;
  /** Kneels to shoot at range. */
  crouchesAtRange: boolean;
  /** Chance to go and check a noise (otherwise it freezes and listens). */
  investigates: number;
  /** Goes after far gunfire (others ignore shots beyond ~40 m). */
  chasesShots: boolean;
  /** Lays suppressing fire (rats and turtles keep quiet). */
  suppresses: boolean;
  /** A-D-A-D strafing in close and mid-range gunfights. */
  adad: boolean;
  /** Hop chance: jumping a corner on a rush, or when someone appears. */
  hops: number;
  /** Sprints in combat (cover runs, pushes, searches). */
  sprints: boolean;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  gigachad: {
    id: 'gigachad', holdGround: 1.25, holdGroundRange: [0.65, 1.5], searchAfter: [1, 3], searchWait: 0.2, searchSprint: 0.75, sneaky: false,
    shifts: true, shiftCoverAfter: 6, dogfight: [12, 18], rushes: true, standAndShoot: 0.75, retreatHp: 0, peekEvery: [0.75, 1.8], exposure: 1.6,
    crouchesAtRange: false, investigates: 1, chasesShots: true, suppresses: true, adad: true, hops: 0.4, sprints: true,
  },
  chad: {
    id: 'chad', holdGround: 1.5, holdGroundRange: [0.75, 1.5], searchAfter: [3, 7], searchWait: 0.4, searchSprint: 0.6, sneaky: false,
    shifts: true, shiftCoverAfter: 8, dogfight: [10, 15], rushes: true, standAndShoot: 0.5, retreatHp: 0.2, peekEvery: [0.9, 2.4], exposure: 1.3,
    crouchesAtRange: false, investigates: 0.85, chasesShots: true, suppresses: true, adad: true, hops: 0.15, sprints: true,
  },
  wreckless: {
    id: 'wreckless', holdGround: 2, holdGroundRange: [0.75, 2.5], searchAfter: [0.5, 2], searchWait: 0, searchSprint: 0.9, sneaky: false,
    shifts: true, shiftCoverAfter: 5, dogfight: [12, 18], rushes: true, standAndShoot: 0.85, retreatHp: 0, peekEvery: [0.75, 1.6], exposure: 1.7,
    crouchesAtRange: false, investigates: 1, chasesShots: true, suppresses: true, adad: false, hops: 0.8, sprints: true,
  },
  normal: {
    id: 'normal', holdGround: 1, holdGroundRange: [0.5, 1.5], searchAfter: [8, 16], searchWait: 0.8, searchSprint: 0.3, sneaky: false,
    shifts: true, shiftCoverAfter: 9, dogfight: [10, 15], rushes: false, standAndShoot: 0.25, retreatHp: 0.32, peekEvery: [1, 3.2], exposure: 1,
    crouchesAtRange: true, investigates: 0.55, chasesShots: false, suppresses: true, adad: false, hops: 0, sprints: true,
  },
  turtle: {
    id: 'turtle', holdGround: 1.5, holdGroundRange: [0.8, 1.2], searchAfter: [16, 30], searchWait: 1.2, searchSprint: 0.4, sneaky: true,
    shifts: true, shiftCoverAfter: 14, dogfight: [9, 14], rushes: true, standAndShoot: 0.15, retreatHp: 0.35, peekEvery: [1.2, 3.6], exposure: 0.9,
    crouchesAtRange: true, investigates: 0.3, chasesShots: false, suppresses: false, adad: false, hops: 0.2, sprints: false,
  },
  timmy: {
    id: 'timmy', holdGround: 0.5, holdGroundRange: [0.75, 1.5], searchAfter: [20, 40], searchWait: 1.5, searchSprint: 0.2, sneaky: false,
    shifts: false, shiftCoverAfter: 12, dogfight: [8, 12], rushes: false, standAndShoot: 0.1, retreatHp: 0.5, peekEvery: [2, 4.5], exposure: 0.7,
    crouchesAtRange: true, investigates: 0.25, chasesShots: false, suppresses: true, adad: false, hops: 0, sprints: true,
  },
  rat: {
    id: 'rat', holdGround: 1, holdGroundRange: [0.75, 1.5], searchAfter: [30, 60], searchWait: 2, searchSprint: 0, sneaky: true,
    shifts: false, shiftCoverAfter: 18, dogfight: [7, 12], rushes: false, standAndShoot: 0.1, retreatHp: 0.45, peekEvery: [2.5, 5], exposure: 0.6,
    crouchesAtRange: true, investigates: 0.15, chasesShots: false, suppresses: false, adad: false, hops: 0, sprints: false,
  },
  coward: {
    id: 'coward', holdGround: 0.25, holdGroundRange: [0.75, 1.5], searchAfter: [40, 80], searchWait: 2, searchSprint: 0.1, sneaky: false,
    shifts: false, shiftCoverAfter: 14, dogfight: [8, 12], rushes: false, standAndShoot: 0.05, retreatHp: 0.65, peekEvery: [2.5, 5], exposure: 0.6,
    crouchesAtRange: true, investigates: 0.1, chasesShots: false, suppresses: true, adad: false, hops: 0, sprints: true,
  },
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
