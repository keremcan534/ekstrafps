/**
 * Sound events → layers. Gameplay only ever references event names
 * (e.g. "ar.fire"); what those events sound like is decided here.
 *
 * To use real audio, add `file: 'audio/ar_shot.ogg'` to a layer (files go in
 * /public/audio). The synth recipe stays as a fallback if the file is missing.
 */
export interface SoundLayer {
  /** Synth recipe name from Synth.ts. */
  synth?: string;
  /** Optional sample file (relative to /public). Overrides the synth when it loads. */
  file?: string;
  gain: number;
  /** Delay before this layer plays (seconds). */
  delay?: number;
  /** Keep this layer out of the room reverb (mechanical clicks). */
  dry?: boolean;
  /** Sample variations: one is picked per play. */
  files?: string[];
  /**
   * Distance band (sounds with a position): near = the close blast / punch / mechanism
   * (fades out by ~50 m), far = the distant report (20-120 m), farthest = beyond ~70 m.
   * No band: always.
   */
  range?: 'near' | 'far' | 'farthest';
  /** Room tail: louder in big halls, smaller in offices (AudioSystem.space). */
  tail?: boolean;
}

/** Close-shot variations cut from the recorded gunshots (public/audio/guns). */
const shots = (key: string, n: number) => Array.from({ length: n }, (_, i) => `audio/guns/${key}_close${i}.wav`);
/** Distant report: the same crack-and-roll heard from far off (darker further away). */
const distant = (k: number): SoundLayer[] => [
  { file: 'audio/guns/distant.wav', gain: 0.65 * k, range: 'far' },
  { file: 'audio/guns/distant_far.wav', gain: 0.6 * k, range: 'farthest' },
];

export interface SoundEvent {
  layers: SoundLayer[];
  /** Random pitch +/- (fraction). */
  pitchVariance?: number;
  /** Max overlapping instances of this event. */
  maxVoices?: number;
  /** Bus: weapon sounds duck nothing, ui bypasses distance attenuation. */
  bus?: 'sfx' | 'ui';
  /** Send level into the room reverb (gunshots ~0.6, impacts ~0.25). */
  reverb?: number;
  /** Positional non-gunfire sounds: not heard beyond this (m, default 30). */
  maxDist?: number;
}

export const SOUND_BANK: Record<string, SoundEvent> = {
  // Layered gunshots: recorded close blast (variations) · synth low-end punch ·
  // mechanical action · room tail (scaled by room size) · distant report.
  'ar.fire': {
    layers: [
      { files: shots('ar', 4), gain: 1.15, range: 'near' },
      { synth: 'ar_punch', gain: 0.81, range: 'near' },
      { synth: 'ar_mech', gain: 0.3, range: 'near', dry: true },
      { file: 'audio/guns/ar_tail.wav', gain: 0.46, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.5,
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'ak.fire': {
    layers: [
      { files: shots('ak', 4), gain: 1.22, range: 'near' },
      { synth: 'ak_punch', gain: 0.94, range: 'near' },
      { synth: 'ak_mech', gain: 0.35, range: 'near', dry: true },
      { file: 'audio/guns/ak_tail.wav', gain: 0.52, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.55,
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'mk47.fire': {
    layers: [
      { files: shots('heavy', 4), gain: 1.08, range: 'near' },
      { synth: 'ak_punch', gain: 0.81, range: 'near' },
      { synth: 'ar_mech', gain: 0.3, range: 'near', dry: true },
      { file: 'audio/guns/heavy_tail.wav', gain: 0.4, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.55,
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'rd704.fire': {
    layers: [
      { files: shots('mg', 4), gain: 1.22, range: 'near' },
      { synth: 'ak_punch', gain: 1.08, range: 'near' },
      { synth: 'ak_mech', gain: 0.35, range: 'near', dry: true },
      { file: 'audio/guns/mg_tail.wav', gain: 0.46, tail: true },
      ...distant(1.1),
    ],
    reverb: 0.55,
    pitchVariance: 0.025,
    maxVoices: 16,
  },
  'val.fire': {
    // Integrally suppressed subsonic: no supersonic crack, the action is the loudest part.
    layers: [
      { synth: 'val_mech', gain: 0.6 },
      { synth: 'val_thump', gain: 0.75 },
      { synth: 'val_tail', gain: 0.15 },
    ],
    reverb: 0.35,
    pitchVariance: 0.04,
    maxVoices: 16,
  },
  'ppsh.fire': {
    layers: [
      { files: shots('smg', 3), gain: 1.01, range: 'near' },
      { synth: 'ar_punch', gain: 0.54, range: 'near' },
      { synth: 'ar_mech', gain: 0.3, range: 'near', dry: true },
      { file: 'audio/guns/smg_tail.wav', gain: 0.4, tail: true },
      ...distant(0.7),
    ],
    reverb: 0.45,
    pitchVariance: 0.04,
    maxVoices: 20,
  },
  'pistol.fire': {
    layers: [
      { files: shots('pistol', 3), gain: 1.15, range: 'near' },
      { synth: 'pistol_punch', gain: 0.94, range: 'near' },
      { synth: 'pistol_mech', gain: 0.4, range: 'near', dry: true },
      { file: 'audio/guns/pistol_tail.wav', gain: 0.46, tail: true },
      { synth: 'pistol_tail', gain: 0.22, tail: true },
      ...distant(0.6),
    ],
    reverb: 0.55,
    pitchVariance: 0.03,
    maxVoices: 8,
  },
  'shotgun.fire': {
    layers: [
      { files: shots('boom', 1), gain: 1.28, range: 'near' },
      { synth: 'shotgun_punch', gain: 1.35, range: 'near' },
      { synth: 'shotgun_shot', gain: 0.35, range: 'near', dry: true },
      { file: 'audio/guns/boom_tail.wav', gain: 0.52, tail: true },
      { synth: 'shotgun_tail', gain: 0.25, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.65,
    pitchVariance: 0.04,
    maxVoices: 6,
  },
  // Bolt actions: N-wave crack, saturated body, deep boom, big room.
  'mosin.fire': {
    layers: [
      { files: shots('heavy', 4), gain: 1.15, range: 'near' },
      { synth: 'rifle_boom', gain: 1.35, range: 'near' },
      { synth: 'ak_mech', gain: 0.25, range: 'near', dry: true },
      { file: 'audio/guns/heavy_tail.wav', gain: 0.52, tail: true },
      { synth: 'crack_heavy', gain: 0.5, range: 'near' },
      ...distant(1.3),
    ],
    reverb: 0.7,
    pitchVariance: 0.02,
    maxVoices: 4,
  },
  'kar98.fire': {
    layers: [
      { files: shots('heavy', 4), gain: 1.15, range: 'near' },
      { synth: 'rifle_boom', gain: 1.42, range: 'near' },
      { synth: 'ak_mech', gain: 0.22, range: 'near', dry: true },
      { file: 'audio/guns/heavy_tail.wav', gain: 0.52, tail: true },
      { synth: 'kar_body', gain: 0.5, range: 'near' },
      ...distant(1.3),
    ],
    reverb: 0.7,
    pitchVariance: 0.02,
    maxVoices: 4,
  },
  'bolt.open': { layers: [{ synth: 'bolt_up', gain: 0.6 }, { synth: 'bolt_slide_back', gain: 0.65, delay: 0.05 }], reverb: 0.15, pitchVariance: 0.04 },
  'bolt.close': { layers: [{ synth: 'bolt_slide_fwd', gain: 0.75 }], reverb: 0.15, pitchVariance: 0.04 },
  'reload.bolt.start': { layers: [{ synth: 'cloth', gain: 0.45 }], maxDist: 14 },
  'reload.bolt.round': { layers: [{ synth: 'round_insert', gain: 0.7 }], pitchVariance: 0.06, maxDist: 14 },
  'impact.heavy': { layers: [{ synth: 'impact_heavy', gain: 0.6 }], reverb: 0.3, pitchVariance: 0.08, maxVoices: 4 },
  'shotgun.pump': { layers: [{ synth: 'shotgun_pump', gain: 0.7 }], pitchVariance: 0.03 },

  dry_fire: { layers: [{ synth: 'dry_fire', gain: 0.6 }] },
  'equip.rifle': { layers: [{ synth: 'equip', gain: 0.5 }], maxDist: 14 },
  'equip.pistol': { layers: [{ synth: 'equip', gain: 0.45 }], pitchVariance: 0.05, maxDist: 14 },
  'equip.shotgun': { layers: [{ synth: 'equip', gain: 0.55 }, { synth: 'shotgun_pump', gain: 0.25, delay: 0.18 }], maxDist: 14 },

  'reload.rifle.start': { layers: [{ synth: 'cloth', gain: 0.5 }], maxDist: 14 },
  'reload.rifle.magout': { layers: [{ synth: 'mag_out', gain: 0.6 }], maxDist: 14 },
  'reload.rifle.magin': { layers: [{ synth: 'mag_in', gain: 0.75 }], maxDist: 14 },
  'reload.rifle.boltback': { layers: [{ synth: 'bolt_back', gain: 0.6 }], maxDist: 14 },
  'reload.rifle.boltforward': { layers: [{ synth: 'bolt_forward', gain: 0.75 }], maxDist: 14 },
  'reload.pistol.start': { layers: [{ synth: 'cloth', gain: 0.4 }], maxDist: 14 },
  'reload.pistol.magout': { layers: [{ synth: 'mag_out', gain: 0.5 }], pitchVariance: 0.08, maxDist: 14 },
  'reload.pistol.magin': { layers: [{ synth: 'mag_in', gain: 0.65 }], pitchVariance: 0.06, maxDist: 14 },
  'reload.pistol.slideback': { layers: [{ synth: 'bolt_back', gain: 0.5 }], maxDist: 14 },
  'reload.pistol.slideforward': { layers: [{ synth: 'bolt_forward', gain: 0.7 }], pitchVariance: 0.05, maxDist: 14 },
  'reload.shotgun.start': { layers: [{ synth: 'cloth', gain: 0.5 }], maxDist: 14 },
  'reload.shotgun.shell': { layers: [{ synth: 'shell_insert', gain: 0.7 }], pitchVariance: 0.05, maxDist: 14 },

  'impact.concrete': { reverb: 0.22, layers: [{ synth: 'impact_concrete', gain: 0.35 }], pitchVariance: 0.12, maxVoices: 8, maxDist: 24 },
  'impact.metal': { reverb: 0.22, layers: [{ synth: 'impact_metal', gain: 0.4 }], pitchVariance: 0.1, maxVoices: 6, maxDist: 20 },
  'impact.robot': { reverb: 0.22, layers: [{ synth: 'impact_robot', gain: 0.45 }], pitchVariance: 0.1, maxDist: 22, maxVoices: 6 },
  'impact.robotweak': { reverb: 0.22, layers: [{ synth: 'impact_robotweak', gain: 0.5 }], pitchVariance: 0.06, maxDist: 22, maxVoices: 4 },
  'impact.prop': { layers: [{ synth: 'prop_hit', gain: 0.4 }], pitchVariance: 0.15, maxVoices: 6, maxDist: 18 },
  'shell.brass': { layers: [{ synth: 'shell_brass', gain: 0.12 }], pitchVariance: 0.15, maxVoices: 4 },
  'shell.plastic': { layers: [{ synth: 'shell_plastic', gain: 0.2 }], pitchVariance: 0.15, maxVoices: 3 },

  'ui.firemode': { layers: [{ synth: 'firemode_click', gain: 0.5 }], bus: 'ui' },
  'impact.ricochet': { layers: [{ synth: 'ricochet', gain: 0.35 }], pitchVariance: 0.2, maxVoices: 4, maxDist: 15 },
  'ui.hit': { layers: [{ synth: 'hit_tick', gain: 0.35 }], pitchVariance: 0.04, maxVoices: 3, bus: 'ui' },
  'ui.crit': { layers: [{ synth: 'hit_crit', gain: 0.4 }], pitchVariance: 0.03, maxVoices: 3, bus: 'ui' },
  'ui.kill': { layers: [{ synth: 'kill', gain: 0.55 }], maxVoices: 2, bus: 'ui' },
  'robot.death': { layers: [{ synth: 'robot_death', gain: 0.6 }], pitchVariance: 0.08, maxDist: 32, maxVoices: 3 },
  'robot.fall': { reverb: 0.25, layers: [{ synth: 'body_fall', gain: 0.55 }], pitchVariance: 0.12, maxDist: 24, maxVoices: 4 },
  'robot.stagger': { layers: [{ synth: 'servo_strain', gain: 0.5 }], pitchVariance: 0.1, maxDist: 20, maxVoices: 2 },
  // ---------- Black Division ----------
  'bd.fire': {
    layers: [
      { files: shots('ak', 4), gain: 1.15, range: 'near' },
      { synth: 'ak_punch', gain: 1.08, range: 'near' },
      { synth: 'ak_mech', gain: 0.3, range: 'near', dry: true },
      { file: 'audio/guns/ak_tail.wav', gain: 0.57, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.8,
    pitchVariance: 0.04,
    maxVoices: 12,
  },
  'bd.see_enemy': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_see_enemy.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.spread_out': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_spread_out.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.contact': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_contact.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.flanking': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_flanking.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.moving': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_moving.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.reloading': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_reloading.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.target_down': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_target_down.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.man_down': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_man_down.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.lost_visual': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_lost_visual.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bd.hit': { reverb: 0.3, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_hit.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2 },
  'bullet.flyby': { layers: [{ synth: 'flyby_crack', gain: 0.75 }, { synth: 'flyby_whizz', gain: 0.25 }], pitchVariance: 0.12, maxVoices: 4, bus: 'ui' },
  'bullet.whizz': { layers: [{ synth: 'flyby_whizz', gain: 0.7 }], pitchVariance: 0.15, maxVoices: 4, bus: 'ui' },
  'impact.flesh': { reverb: 0.15, layers: [{ synth: 'impact_flesh', gain: 0.6 }], pitchVariance: 0.12, maxVoices: 6 },
  'impact.armor': { reverb: 0.2, layers: [{ synth: 'impact_armor', gain: 0.6 }], pitchVariance: 0.08, maxVoices: 6 },
  'impact.helmet': { reverb: 0.2, layers: [{ synth: 'impact_helmet', gain: 0.55 }], pitchVariance: 0.08, maxVoices: 4 },
  'player.hurt': { layers: [{ synth: 'player_hit', gain: 0.8 }], pitchVariance: 0.08, maxVoices: 3, bus: 'ui' },
  'player.death': { layers: [{ synth: 'player_death', gain: 0.9 }], maxVoices: 1, bus: 'ui' },
  'hazard.zap': { reverb: 0.2, layers: [{ synth: 'hazard_zap', gain: 0.45 }], pitchVariance: 0.2, maxDist: 16, maxVoices: 3 },
  'hazard.fire': { reverb: 0.2, layers: [{ synth: 'hazard_fire', gain: 0.5 }], pitchVariance: 0.15, maxDist: 16, maxVoices: 3 },
  'hazard.gas': { reverb: 0.2, layers: [{ synth: 'hazard_gas', gain: 0.45 }], pitchVariance: 0.1, maxDist: 16, maxVoices: 3 },
  'lift.arrive': { reverb: 0.4, layers: [{ synth: 'lift_ding', gain: 0.7 }, { synth: 'lift_doors', gain: 0.6, delay: 0.5 }], maxDist: 26, maxVoices: 3 },
  'robot.wake': { reverb: 0.3, layers: [{ synth: 'robot_wake', gain: 0.7 }], pitchVariance: 0.12, maxDist: 28, maxVoices: 4 },
  'power.down': { reverb: 0.7, layers: [{ synth: 'power_down', gain: 0.8 }], maxVoices: 1, bus: 'ui' },
  'raid.siren': { reverb: 0.8, layers: [{ synth: 'raid_siren', gain: 0.6 }], maxVoices: 1, bus: 'ui' },
  'director.horde': { reverb: 0.6, layers: [{ synth: 'horde_alarm', gain: 0.6 }], maxVoices: 1, bus: 'ui' },
  'robot.boot': { layers: [{ synth: 'robot_boot', gain: 0.35 }], pitchVariance: 0.08, maxDist: 18, maxVoices: 3 },
  'player.land': { layers: [{ synth: 'land', gain: 0.5 }], pitchVariance: 0.08, bus: 'ui' },
  'player.jump': { layers: [{ synth: 'jump', gain: 0.4 }], pitchVariance: 0.1, bus: 'ui' },
};
