/**
 * Tactical AI tuning. Everything here is read live, so the tuning panel (Tab,
 * ?dev) can change it mid-fight. Times in seconds, distances in metres.
 */
export const AI_TUNING = {
  // --- Update rates (staggered per bot) ---
  /** Vision / hearing tick. */
  perceptionInterval: 0.12,
  /** Utility re-evaluation (plus immediate re-evaluation on events). */
  decisionInterval: 0.22,
  /** Squad brain: sharing, roles, plan. */
  squadInterval: 0.45,
  /** Line-of-sight rays all bots may cast per frame for perception. */
  rayBudgetPerFrame: 70,
  /** Cover searches allowed per frame (each costs a few dozen rays). */
  coverQueriesPerFrame: 1,

  // --- Perception ---
  visionRange: 80,
  /** Multiplier on how fast a sighting turns into a confirmed contact. */
  recognitionSpeed: 1,
  /** Recognition at which a bot turns to look at something it half-saw. */
  suspicionLevel: 0.35,
  hearingScale: 1,
  /** Out of sight, confidence falls with this time constant. */
  contactMemory: 11,
  /** Contacts this old with ~no confidence are forgotten. */
  forgetAfter: 45,

  // --- Combat ---
  /** Longest stay in one cover before probing / repositioning (personality scales it). */
  maxHoldCover: 9,
  /** Never pick a new position more often than this. */
  minRepositionInterval: 2.5,
  /** Seconds exposed per peek (skill shortens it). */
  peekExposure: 1.2,
  suppressionGain: 1,
  /** Suppression lost per second. */
  suppressionDecay: 0.32,
  /** Above this a bot counts as suppressed. */
  suppressedLevel: 0.55,
  /** Global multipliers on the tactical choices. */
  flankUtility: 1,
  pushUtility: 1,
  retreatUtility: 1,
  suppressUtility: 1,
  /** A lost enemy is searched for this long. */
  searchDuration: 32,
  /** No tactical progress for this long with a known threat: the watchdog forces a new plan. */
  passivityTimeout: 7,
  /** The squad changes plan when nobody made progress for this long. */
  squadStallTime: 13,
  /** Radio delay between a sighting and the squad knowing about it. */
  commDelayMin: 0.2,
  commDelayMax: 0.9,

  // --- Formation / friendlies ---
  formationSpacing: 3.2,
  friendlyNear: 6,
  friendlyTactical: 22,
  friendlyTooFar: 34,

  // --- Debug ---
  debug: false,
  debugLabels: true,
  debugPaths: true,
  debugCover: true,
  debugLos: true,
  debugMemory: true,
  debugFlank: true,
  debugSound: true,
};

export type ProfileId = 'cautious' | 'balanced' | 'aggressive' | 'tactical' | 'reckless';

/**
 * Personality: weights on the utility scores, not raw stats. The situation still
 * decides; a cautious bot just values cover more and pushes later.
 */
export interface Profile {
  id: ProfileId;
  cover: number;
  push: number;
  flank: number;
  suppress: number;
  /** Multiplier on max hold time in cover. */
  hold: number;
  /** Multiplier on peek exposure. */
  exposure: number;
  /** Health fraction under which retreat starts to look good. */
  retreatHp: number;
  /** How much the squad's plan and roles weigh. */
  cooperation: number;
  /** Search / move pace (1 = jog). */
  pace: number;
  /** Multiplier on the passivity timeout. */
  patience: number;
}

export const PROFILES: Record<ProfileId, Profile> = {
  cautious: { id: 'cautious', cover: 1.45, push: 0.45, flank: 0.7, suppress: 1.1, hold: 1.35, exposure: 0.8, retreatHp: 0.5, cooperation: 1.1, pace: 0.8, patience: 1.25 },
  balanced: { id: 'balanced', cover: 1, push: 1, flank: 1, suppress: 1, hold: 1, exposure: 1, retreatHp: 0.35, cooperation: 1, pace: 1, patience: 1 },
  aggressive: { id: 'aggressive', cover: 0.75, push: 1.55, flank: 1.35, suppress: 0.8, hold: 0.65, exposure: 1.15, retreatHp: 0.25, cooperation: 0.9, pace: 1.2, patience: 0.75 },
  tactical: { id: 'tactical', cover: 1.15, push: 1, flank: 1.25, suppress: 1.35, hold: 0.9, exposure: 0.85, retreatHp: 0.38, cooperation: 1.4, pace: 1, patience: 0.9 },
  reckless: { id: 'reckless', cover: 0.45, push: 1.9, flank: 0.9, suppress: 0.6, hold: 0.5, exposure: 1.5, retreatHp: 0.12, cooperation: 0.6, pace: 1.3, patience: 0.6 },
};

/** Effective engagement ranges by weapon class (what a bot "knows" about its gun). */
export const WEAPON_RANGE: Record<string, { ideal: number; max: number }> = {
  shotgun: { ideal: 7, max: 14 },
  smg: { ideal: 13, max: 26 },
  pistol: { ideal: 11, max: 22 },
  rifle: { ideal: 22, max: 48 },
  dmr: { ideal: 32, max: 65 },
  bolt: { ideal: 38, max: 80 },
};
