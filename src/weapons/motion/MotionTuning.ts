import defaults from '../../config/weaponMotion.json';
import type { WeaponData } from '../WeaponData';

/**
 * First-person weapon motion tuning (src/config/weaponMotion.json), one block per motion
 * layer. The tuning panel edits this object live; the layers read it every frame.
 *
 * Units: lengths in m, angles in degrees, frequencies in rad/s unless a field says it is a
 * multiplier. Most values are multipliers on what the weapon's handling (weight, length,
 * ergonomics: Handling.ts) already gives, so one set of numbers suits every gun.
 */
export type WeaponMotionTuning = typeof defaults;
export const motionTuning: WeaponMotionTuning = structuredClone(defaults);
export const motionTuningDefaults: Readonly<WeaponMotionTuning> = structuredClone(defaults);

if (import.meta.hot) import.meta.hot.accept('../../config/weaponMotion.json', () => {});

export type MotionClass = keyof WeaponMotionTuning['classes'];
/** Weapon-class taste: mass (lag, momentum, impulses), response (spring speed), bob. */
export type ClassTuning = WeaponMotionTuning['classes'][MotionClass];

/** Which class a weapon moves like: pistols light and quick, belt-fed / heavy rifles slow. */
export function motionClass(d: WeaponData): MotionClass {
  if (d.category === 'pistol') return 'pistol';
  if (d.category === 'smg') return 'smg';
  if (d.category === 'shotgun') return 'shotgun';
  return d.handling.weight >= 6 ? 'heavy' : 'rifle';
}
