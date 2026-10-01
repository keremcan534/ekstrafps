import type { WeaponData } from './WeaponData';
import type { AmmoData } from './AmmoData';
import { feel } from '../config/Feel';

/**
 * Physical handling derived from weight, length and ergonomics. These feed the
 * procedural weapon equations (inertia, ADS, sway, fatigue, recoil mass), so a
 * heavy long rifle and a light compact gun differ through SYSTEM behaviour, not
 * through slower animations or more randomness.
 */
export interface Handling {
  /** Seconds of lag behind camera rotation (lag ≈ turn rate × inertiaTime). */
  inertiaTime: number;
  /** Follow spring natural frequency (rad/s) and damping ratio: how the gun settles. */
  followFreq: number;
  followZeta: number;
  /** Time to bring the sights up (s), before stamina / movement modifiers. */
  adsTime: number;
  /** ADS spring damping ratio (< 1 = slight overshoot while settling). */
  adsZeta: number;
  /** Multiplier on procedural sway amplitude. */
  swayScale: number;
  /** Arm stamina drained per second while aiming, recovered per second when not. */
  staminaDrain: number;
  staminaRecover: number;
  /** Multiplier on equip / holster time (raise / lower speed). */
  raiseScale: number;
  /** Angular recoil multiplier from mass (lighter guns kick harder). */
  recoilMass: number;
  /** Mechanical dispersion: extreme spread diameter in degrees. */
  dispersionDeg: number;
  /** Moment proxy (kg·m), shown in the debug HUD as "weapon inertia". */
  moment: number;
}

export function computeHandling(w: WeaponData, ammo: AmmoData): Handling {
  const W = Math.max(0.3, w.handling.weight);
  const L = Math.max(0.1, w.handling.length);
  const E = Math.min(1, Math.max(0, w.handling.ergonomics / 100));
  const moment = W * (0.6 + L);
  const ergoLag = 1 - 0.6 * E;
  return {
    inertiaTime: 0.0053 * moment * ergoLag * feel.inertiaScale,
    followFreq: 13 * Math.sqrt(5 / moment) * (0.75 + 0.5 * E),
    followZeta: 0.45 + 0.3 * E,
    adsTime: 0.15 + (W * 0.05 + L * 0.12) * (1.25 - E),
    adsZeta: 0.62 + 0.35 * E,
    swayScale: (0.75 + 0.07 * W) * (1.15 - 0.3 * E) * feel.swayScale,
    staminaDrain: 0.016 * W * (1.35 - E),
    staminaRecover: 0.12 + 0.12 * E,
    raiseScale: 1.25 - 0.5 * E,
    recoilMass: Math.sqrt(3.5 / W),
    dispersionDeg: (w.accuracy.moa * ammo.accuracyModifier) / 60,
    moment,
  };
}
