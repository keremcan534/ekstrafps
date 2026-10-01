import defaults from '../config/ammo.json';

/**
 * Ammunition defines what happens after the trigger: the projectile and its
 * terminal effect. Weapons only define how it is launched (barrel, action,
 * handling). Edit in src/config/ammo.json or live in the tuning panel.
 */
export interface AmmoData {
  name: string;
  caliber: string;
  /** Grams. */
  projectileMass: number;
  /** m/s from a barrel of `referenceBarrel` metres. */
  muzzleVelocity: number;
  referenceBarrel: number;
  /** Relative velocity change per metre of barrel above/below reference. */
  velocityPerBarrelMeter: number;
  /** Damage at muzzle velocity; scales with remaining velocity. */
  damage: number;
  /** Armor penetration rating (hook: no armor model yet). */
  penetration: number;
  /** Higher = less drag. Abstracted G1-like coefficient. */
  ballisticCoefficient: number;
  /** Chance to skip off hard surfaces at grazing angles. */
  ricochetChance: number;
  /** Hook for future fragmentation / wound effects. */
  fragmentationChance: number;
  tracer: boolean;
  /** Multiplies the weapon's mechanical MOA. */
  accuracyModifier: number;
  /** Multiplies the weapon's recoil impulse. */
  recoilModifier: number;
  /** Projectiles per shot (buckshot). */
  pellets: number;
  /** Pellet pattern spread (degrees), for multi-projectile loads only. */
  pelletSpread: number;
  /** Gameplay multiplier on physical momentum pushed into props (physics comedy). */
  impactBoost: number;
}

export const AMMO_DEFAULTS = defaults as Record<string, AmmoData>;

/** Live, mutable ammo table shared by the game and the tuning panel. */
export const ammoTable: Record<string, AmmoData> = structuredClone(AMMO_DEFAULTS);

export const getAmmo = (id: string): AmmoData => {
  const a = ammoTable[id];
  if (!a) throw new Error(`Unknown ammo "${id}"`);
  return a;
};

/** Muzzle velocity for a given barrel length (m/s). */
export const muzzleVelocity = (ammo: AmmoData, barrelLength: number): number =>
  ammo.muzzleVelocity * Math.max(0.5, 1 + ammo.velocityPerBarrelMeter * (barrelLength - ammo.referenceBarrel));

/** Quadratic drag factor k in dv/dt = -k·|v|·v (per metre). */
export const dragFactor = (ammo: AmmoData): number => 0.0003 / Math.max(0.01, ammo.ballisticCoefficient);

/**
 * Analytic drop (m) after flying `distance` metres horizontally, ignoring the tiny
 * effect of gravity on drag. Used to solve zeroing every frame cheaply.
 */
export const dropAt = (distance: number, v0: number, k: number): number => {
  const t = (Math.exp(k * distance) - 1) / (k * v0);
  return 0.5 * 9.81 * t * t;
};

/** Time of flight (s) to `distance` metres. */
export const timeOfFlight = (distance: number, v0: number, k: number): number => (Math.exp(k * distance) - 1) / (k * v0);

// "Save to source" rewrites ammo.json while running: accept without reloading.
if (import.meta.hot) import.meta.hot.accept('../config/ammo.json', () => {});
