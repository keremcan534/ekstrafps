import assaultRifle from '../config/weapons/assault_rifle.json';
import heavyPistol from '../config/weapons/heavy_pistol.json';
import pumpShotgun from '../config/weapons/pump_shotgun.json';

/**
 * Data-driven weapon definition. Every gun shares the same systems; personality
 * comes purely from these numbers. Defaults live in src/config/weapons/*.json
 * and are editable live from the tuning panel (Tab / ⚙).
 *
 * Units: angles in degrees, distances in metres, times in seconds.
 */
export interface WeaponData {
  id: string;
  name: string;
  /** Procedural model + animation set. */
  model: 'rifle' | 'pistol' | 'shotgun';
  /** auto = hold to fire, semi = one shot per press, pump = semi + visible pump cycle. */
  fireMode: 'auto' | 'semi' | 'pump';
  /** Only hitscan exists in v0.1; projectile weapons will add a second mode here. */
  mode: 'hitscan';
  ammoType: 'rifle' | 'pistol' | 'shell';

  /** Damage per bullet (per pellet for shotguns). */
  damage: number;
  /** Rounds per minute (for pump/semi: the fastest possible cycle). */
  fireRate: number;
  magazineSize: number;
  /** Bullets per shot (shotgun pellets). */
  pellets: number;
  range: number;
  /** Damage falls off linearly from falloffStart to falloffEnd, down to falloffMinMultiplier. */
  falloffStart: number;
  falloffEnd: number;
  falloffMinMultiplier: number;
  critMultiplier: number;
  /** Physics impulse per bullet/pellet applied to props (N·s). */
  impactForce: number;
  /** Strength of robot dummy flinch per bullet. */
  hitReaction: number;

  reload: {
    /** 'magazine' = all at once, 'shell' = one by one (shotgun). */
    kind: 'magazine' | 'shell';
    time: number;
    emptyTime: number;
    /** Shell reloads: */
    shellStart: number;
    shellInsert: number;
    shellEnd: number;
  };

  equipTime: number;
  holsterTime: number;
  /** Delay before you can fire after stopping a sprint. */
  sprintToFireTime: number;

  spread: {
    hip: number;
    ads: number;
    /** Added at full movement speed. */
    moving: number;
    air: number;
    crouchMultiplier: number;
    /** Bloom added per shot, capped at bloomMax, recovering at bloomRecovery deg/s. */
    bloomPerShot: number;
    bloomMax: number;
    bloomRecovery: number;
  };

  /** Aim displacement: actually moves where you aim. Learnable, not random. */
  recoil: {
    /** Upward climb per shot. */
    vertical: number;
    /** Random horizontal jitter (+/-). */
    horizontal: number;
    /** Consistent horizontal drift per shot (+ = right). */
    horizontalBias: number;
    /** Deterministic horizontal sway pattern over a spray. */
    patternAmplitude: number;
    patternFrequency: number;
    firstShotMultiplier: number;
    /** Each consecutive shot raises recoil by this fraction, up to buildUpMax. */
    buildUpPerShot: number;
    buildUpMax: number;
    /** How fast the aim follows the kick (higher = snappier). */
    snappiness: number;
    /** How fast aim returns to where you were pointing (1/s). */
    recoverySpeed: number;
    recoveryDelay: number;
    adsMultiplier: number;
  };

  /** Visual-only camera kick (bullets ignore it). */
  cameraRecoil: {
    pitch: number;
    yaw: number;
    roll: number;
    stiffness: number;
    damping: number;
    fovPunch: number;
    shake: number;
  };

  /** Weapon model kick (spring-driven, can be exaggerated). */
  visualRecoil: {
    kickBack: number;
    kickUp: number;
    kickSide: number;
    kickRoll: number;
    kickRaise: number;
    rotStiffness: number;
    rotDamping: number;
    posStiffness: number;
    posDamping: number;
    adsMultiplier: number;
  };

  ads: {
    fov: number;
    /** 1 / seconds to fully aim. */
    speed: number;
    swayMultiplier: number;
    bobMultiplier: number;
    /** Distance of the sight from the eye when aimed. */
    sightDistance: number;
  };

  /** Where the physical weapon points (shots leave the muzzle, not the camera). */
  aim: {
    /** Point-fire: the shouldered weapon is pointed at the camera ray this far out (m). */
    hipConvergence: number;
    /** ADS: the bore crosses the sight line at this distance (m). */
    zeroDistance: number;
  };

  /** Weapon inertia / sway (follow spring that trails the camera). */
  sway: {
    amount: number;
    max: number;
    stiffness: number;
    damping: number;
  };

  bob: {
    amount: number;
    sprintAmount: number;
  };

  viewmodel: {
    /** Shouldered (point-fire) position relative to the eye. */
    hipPosition: [number, number, number];
  };

  fx: {
    /** 0 = no tracers, N = every Nth bullet/pellet. */
    tracerEvery: number;
    muzzleFlashScale: number;
    smoke: number;
    /** Delay before the shell ejects (pump/bolt actions eject later). */
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

export const WEAPON_DEFAULTS: readonly WeaponData[] = [
  assaultRifle as WeaponData,
  heavyPistol as WeaponData,
  pumpShotgun as WeaponData,
];

/** Live, mutable copies the game and tuning panel share. */
export const createWeaponDefs = (): WeaponData[] => WEAPON_DEFAULTS.map((w) => structuredClone(w));

// "Save to source" rewrites the JSON while the lab is running. Accept those
// updates without reloading the page: the live (already tuned) values stay
// in memory, and the next page load picks up the file.
if (import.meta.hot) {
  import.meta.hot.accept(
    ['../config/weapons/assault_rifle.json', '../config/weapons/heavy_pistol.json', '../config/weapons/pump_shotgun.json'],
    () => {},
  );
}

/** JSON file names relative to src/config (used by "Save to source"). */
export const WEAPON_FILES: Record<string, string> = {
  assault_rifle: 'weapons/assault_rifle',
  heavy_pistol: 'weapons/heavy_pistol',
  pump_shotgun: 'weapons/pump_shotgun',
};
