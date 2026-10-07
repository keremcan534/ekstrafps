import ak47 from '../config/weapons/ak47.json';
import mk47 from '../config/weapons/mk47.json';
import asval from '../config/weapons/asval.json';
import m4a1 from '../config/weapons/m4a1.json';
import ppsh from '../config/weapons/ppsh.json';
import kar98 from '../config/weapons/kar98.json';
import heavyPistol from '../config/weapons/heavy_pistol.json';
import mp5 from '../config/weapons/mp5.json';
import svd from '../config/weapons/svd.json';
import scarh from '../config/weapons/scarh.json';
import qbz192 from '../config/weapons/qbz192.json';
import g36c from '../config/weapons/g36c.json';
import cz805 from '../config/weapons/cz805.json';
import ak109 from '../config/weapons/ak109.json';
import mp5sd from '../config/weapons/mp5sd.json';
import ash127 from '../config/weapons/ash127.json';

export type ModelKey = 'ak47' | 'mk47' | 'asval' | 'm4a1' | 'ppsh' | 'mosin' | 'kar98' | 'pistol' | 'shotgun'
  | 'mp5' | 'glock' | 'saiga' | 'svd' | 'm249' | 'scarh' | 'qbz192' | 'g36c' | 'cz805' | 'ak109' | 'mp5sd' | 'ash127';
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

  /** Where the physical weapon points. */
  aim: {
    /** Point fire: the shouldered weapon points at the camera ray this far out (m). */
    hipConvergence: number;
    /** ADS zero: the trajectory crosses the line of sight at this range (m). [ / ] adjusts. */
    zeroDistance: number;
  };

  sight: {
    type: 'iron' | 'reddot';
    /**
     * Horizontal FOV while aimed (1x optics: slight focus zoom). A weapon with a view
     * profile (src/config/viewprofiles) has it there instead, with the rest of its placement.
     */
    adsFov?: number;
    /** Eye-to-sight distance when aimed (m). Not for profiled weapons (ads.eyeRelief). */
    sightDistance?: number;
  };

  /** First-person placement, old style. A weapon with a view profile has none. */
  viewmodel?: {
    /** Shouldered (point-fire) position relative to the eye, right shoulder. */
    hipPosition: [number, number, number];
    /** Shouldered turn (deg: pitch, yaw, roll), from gun-pose.html. Default: a slight cant. */
    hipRotation?: [number, number, number];
    /**
     * Aimed pose set by hand in gun-pose.html (position m, rotation deg, both relative to
     * the eye). Default: worked out from the model's sights and sight.sightDistance.
     */
    ads?: { position: [number, number, number]; rotation: [number, number, number] };
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

export const WEAPON_DEFAULTS: readonly WeaponData[] = [ak47, ak109, mk47, asval, m4a1, g36c, qbz192, cz805, ppsh, kar98, heavyPistol, mp5, mp5sd, svd, scarh, ash127] as WeaponData[];

/**
 * Weapons taken out of the game (no model of their own): their old ids, still in map
 * tables and saved loadouts, stand for these.
 */
const RETIRED: Record<string, string> = { mosin: 'kar98', pump_shotgun: 'mp5', glock18: 'heavy_pistol', saiga12: 'ak47', m249: 'scarh', rd704: 'scarh' };
export const liveWeaponId = (id: string): string => RETIRED[id] ?? id;

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
      '../config/weapons/ppsh.json',
      '../config/weapons/kar98.json',
      '../config/weapons/heavy_pistol.json',
      '../config/weapons/mp5.json',
      '../config/weapons/svd.json',
      '../config/weapons/scarh.json',
      '../config/weapons/qbz192.json',
      '../config/weapons/g36c.json',
      '../config/weapons/cz805.json',
      '../config/weapons/ak109.json',
      '../config/weapons/mp5sd.json',
      '../config/weapons/ash127.json',
    ],
    () => {},
  );
}

/** JSON file name (relative to src/config) for "Save to source". */
export const weaponFile = (id: string): string => `weapons/${id}`;
