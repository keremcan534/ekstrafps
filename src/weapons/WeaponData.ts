import ak47 from '../config/weapons/ak47.json';
import mk47 from '../config/weapons/mk47.json';
import asval from '../config/weapons/asval.json';
import m4a1 from '../config/weapons/m4a1.json';
import rd704 from '../config/weapons/rd704.json';
import ppsh from '../config/weapons/ppsh.json';
import mosin from '../config/weapons/mosin.json';
import kar98 from '../config/weapons/kar98.json';
import heavyPistol from '../config/weapons/heavy_pistol.json';
import pumpShotgun from '../config/weapons/pump_shotgun.json';

export type ModelKey = 'ak47' | 'mk47' | 'asval' | 'm4a1' | 'rd704' | 'ppsh' | 'mosin' | 'kar98' | 'pistol' | 'shotgun';
export type AnimSet = 'rifle' | 'pistol' | 'shotgun' | 'bolt';
export type FireMode = 'auto' | 'semi' | 'pump' | 'bolt';

/**
 * Data-driven weapon definition. A weapon LAUNCHES ammunition: it defines the
 * mechanism (fire rate, modes, barrel), mechanical accuracy and physical
 * handling. Terminal damage comes from AmmoData.
 *
 * Units: angles in degrees, distances in metres, mass in kg, times in seconds.
 * Defaults live in src/config/weapons/*.json and are editable live (Tab / ⚙).
 */
export interface WeaponData {
  id: string;
  name: string;
  /** Short label for HUD / touch buttons. */
  short: string;
  model: ModelKey;
  animSet: AnimSet;
  category: 'rifle' | 'smg' | 'pistol' | 'shotgun';
  /** AmmoData id (src/config/ammo.json). */
  ammo: string;
  /** Selectable fire modes (B cycles). */
  fireModes: FireMode[];
  /** Rounds per minute (semi/pump: fastest possible cycle). */
  fireRate: number;
  /** Bolt actions: seconds to work the bolt after each shot (0 for everything else). */
  boltCycleTime: number;
  magazineSize: number;
  /** Closed bolt: one extra round can sit in the chamber. Open bolt (PPSh) fires straight from the magazine. */
  closedBolt: boolean;
  /** Metres; scales muzzle velocity relative to the ammo's reference barrel. */
  barrelLength: number;

  /** Physical handling. Everything about how the gun moves derives from these three. */
  handling: {
    weight: number;
    /** Overall length; also drives wall collision. */
    length: number;
    /** 0..100. Handling quality: ADS speed, settling, inertia, fatigue. Not accuracy. */
    ergonomics: number;
  };

  /** Mechanical accuracy: extreme spread in MOA (1 MOA ≈ 2.9 cm at 100 m). */
  accuracy: {
    moa: number;
  };

  /**
   * Procedural recoil. Each shot is an impulse into the weapon's recoil springs;
   * leftover energy from previous shots makes bursts climb naturally.
   */
  recoil: {
    /** Muzzle climb per shot (deg, for a 3.5 kg reference weapon). */
    vertical: number;
    /** Random horizontal kick (±deg). */
    horizontal: number;
    /** Consistent horizontal drift per shot (deg, + right). */
    horizontalBias: number;
    /** Rearward kick into the shoulder (m). */
    back: number;
    /** Shoulder/hands stiffness: how hard the shooter holds the gun on target. */
    shoulder: number;
    /** Damping ratio of the recoil spring (0.3 bouncy .. 1 dead). */
    damping: number;
    /** Fraction of the muzzle climb the shooter's view follows. */
    cameraTransfer: number;
    /** Fraction of the view climb that stays (the player must pull it back down). */
    cameraKeep: number;
    /** How fast the recovering part of the view returns (1/s). */
    cameraRecovery: number;
    /** Extra random dispersion from the gun moving under recoil (deg). */
    dispersion: number;
    /** Visual-only camera punch (deg). Kept small: weapon recoil dominates. */
    punch: number;
    /** Roll kick (deg). */
    roll: number;
  };

  /** Where the physical weapon points. */
  aim: {
    /** Point fire: the shouldered weapon points at the camera ray this far out (m). */
    hipConvergence: number;
    /** ADS zero: the trajectory crosses the line of sight at this range (m). [ / ] adjusts. */
    zeroDistance: number;
  };

  sight: {
    type: 'iron' | 'reddot';
    /** Horizontal FOV while aimed (1x optics: slight focus zoom). */
    adsFov: number;
    /** Eye-to-sight distance when aimed (m). */
    sightDistance: number;
  };

  viewmodel: {
    /** Shouldered (point-fire) position relative to the eye, right shoulder. */
    hipPosition: [number, number, number];
  };

  reload: {
    kind: 'magazine' | 'shell';
    time: number;
    emptyTime: number;
    shellStart: number;
    shellInsert: number;
    shellEnd: number;
  };

  equipTime: number;
  holsterTime: number;
  sprintToFireTime: number;

  fx: {
    /** Visual tracer every Nth round for non-tracer ammo (0 = only real tracer ammo). */
    tracerEvery: number;
    muzzleFlashScale: number;
    smoke: number;
    shellEjectDelay: number;
    shellEjectSpeed: number;
  };

  /** Sound event names (see src/audio/SoundBank.ts). */
  audio: {
    fire: string;
    dry: string;
    equip: string;
    reloadStart: string;
    magOut: string;
    magIn: string;
    boltBack: string;
    boltForward: string;
    shellInsert: string;
    pump: string;
  };
}

export const WEAPON_DEFAULTS: readonly WeaponData[] = [ak47, mk47, asval, m4a1, rd704, ppsh, mosin, kar98, heavyPistol, pumpShotgun] as WeaponData[];

/** Live, mutable copies the game and tuning panel share. */
export const createWeaponDefs = (): WeaponData[] => WEAPON_DEFAULTS.map((w) => structuredClone(w));

// "Save to source" rewrites the JSON while the lab is running. Accept those
// updates without reloading the page: the live (already tuned) values stay
// in memory, and the next page load picks up the file.
if (import.meta.hot) {
  import.meta.hot.accept(
    [
      '../config/weapons/ak47.json',
      '../config/weapons/mk47.json',
      '../config/weapons/asval.json',
      '../config/weapons/m4a1.json',
      '../config/weapons/rd704.json',
      '../config/weapons/ppsh.json',
      '../config/weapons/mosin.json',
      '../config/weapons/kar98.json',
      '../config/weapons/heavy_pistol.json',
      '../config/weapons/pump_shotgun.json',
    ],
    () => {},
  );
}

/** JSON file name (relative to src/config) for "Save to source". */
export const weaponFile = (id: string): string => `weapons/${id}`;
