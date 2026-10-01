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
}

export interface SoundEvent {
  layers: SoundLayer[];
  /** Random pitch +/- (fraction). */
  pitchVariance?: number;
  /** Max overlapping instances of this event. */
  maxVoices?: number;
  /** Bus: weapon sounds duck nothing, ui bypasses distance attenuation. */
  bus?: 'sfx' | 'ui';
}

export const SOUND_BANK: Record<string, SoundEvent> = {
  // Layered gunshots: mechanical · shot · low-frequency punch · environment tail
  'ar.fire': {
    layers: [
      { synth: 'ar_mech', gain: 0.35 },
      { synth: 'ar_shot', gain: 0.75 },
      { synth: 'ar_punch', gain: 0.8 },
      { synth: 'ar_tail', gain: 0.45 },
    ],
    pitchVariance: 0.035,
    maxVoices: 16,
  },
  'ak.fire': {
    layers: [
      { synth: 'ak_mech', gain: 0.4 },
      { synth: 'ak_shot', gain: 0.85 },
      { synth: 'ak_punch', gain: 0.95 },
      { synth: 'ak_tail', gain: 0.55 },
    ],
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'mk47.fire': {
    layers: [
      { synth: 'ar_mech', gain: 0.35 },
      { synth: 'ak_shot', gain: 0.8 },
      { synth: 'ak_punch', gain: 0.9 },
      { synth: 'ar_tail', gain: 0.5 },
    ],
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'rd704.fire': {
    layers: [
      { synth: 'ak_mech', gain: 0.4 },
      { synth: 'ak_shot', gain: 0.9 },
      { synth: 'ak_punch', gain: 1.05 },
      { synth: 'ak_tail', gain: 0.6 },
    ],
    pitchVariance: 0.025,
    maxVoices: 16,
  },
  'val.fire': {
    // Integrally suppressed subsonic: no supersonic crack, the action is the loudest part.
    layers: [
      { synth: 'val_mech', gain: 0.6 },
      { synth: 'val_thump', gain: 0.75 },
      { synth: 'val_tail', gain: 0.25 },
    ],
    pitchVariance: 0.04,
    maxVoices: 16,
  },
  'ppsh.fire': {
    layers: [
      { synth: 'ar_mech', gain: 0.3 },
      { synth: 'ppsh_shot', gain: 0.7 },
      { synth: 'ar_punch', gain: 0.6 },
      { synth: 'ar_tail', gain: 0.4 },
    ],
    pitchVariance: 0.04,
    maxVoices: 20,
  },
  'pistol.fire': {
    layers: [
      { synth: 'pistol_mech', gain: 0.45 },
      { synth: 'pistol_shot', gain: 0.9 },
      { synth: 'pistol_punch', gain: 1.0 },
      { synth: 'pistol_tail', gain: 0.6 },
    ],
    pitchVariance: 0.03,
    maxVoices: 8,
  },
  'shotgun.fire': {
    layers: [
      { synth: 'shotgun_shot', gain: 1.0 },
      { synth: 'shotgun_punch', gain: 1.1 },
      { synth: 'shotgun_tail', gain: 0.7 },
    ],
    pitchVariance: 0.03,
    maxVoices: 6,
  },
  'shotgun.pump': { layers: [{ synth: 'shotgun_pump', gain: 0.7 }], pitchVariance: 0.03 },

  dry_fire: { layers: [{ synth: 'dry_fire', gain: 0.6 }] },
  'equip.rifle': { layers: [{ synth: 'equip', gain: 0.5 }] },
  'equip.pistol': { layers: [{ synth: 'equip', gain: 0.45 }], pitchVariance: 0.05 },
  'equip.shotgun': { layers: [{ synth: 'equip', gain: 0.55 }, { synth: 'shotgun_pump', gain: 0.25, delay: 0.18 }] },

  'reload.rifle.start': { layers: [{ synth: 'cloth', gain: 0.5 }] },
  'reload.rifle.magout': { layers: [{ synth: 'mag_out', gain: 0.6 }] },
  'reload.rifle.magin': { layers: [{ synth: 'mag_in', gain: 0.75 }] },
  'reload.rifle.boltback': { layers: [{ synth: 'bolt_back', gain: 0.6 }] },
  'reload.rifle.boltforward': { layers: [{ synth: 'bolt_forward', gain: 0.75 }] },
  'reload.pistol.start': { layers: [{ synth: 'cloth', gain: 0.4 }] },
  'reload.pistol.magout': { layers: [{ synth: 'mag_out', gain: 0.5 }], pitchVariance: 0.08 },
  'reload.pistol.magin': { layers: [{ synth: 'mag_in', gain: 0.65 }], pitchVariance: 0.06 },
  'reload.pistol.slideback': { layers: [{ synth: 'bolt_back', gain: 0.5 }] },
  'reload.pistol.slideforward': { layers: [{ synth: 'bolt_forward', gain: 0.7 }], pitchVariance: 0.05 },
  'reload.shotgun.start': { layers: [{ synth: 'cloth', gain: 0.5 }] },
  'reload.shotgun.shell': { layers: [{ synth: 'shell_insert', gain: 0.7 }], pitchVariance: 0.05 },

  'impact.concrete': { layers: [{ synth: 'impact_concrete', gain: 0.35 }], pitchVariance: 0.12, maxVoices: 8 },
  'impact.metal': { layers: [{ synth: 'impact_metal', gain: 0.4 }], pitchVariance: 0.1, maxVoices: 6 },
  'impact.robot': { layers: [{ synth: 'impact_robot', gain: 0.45 }], pitchVariance: 0.1, maxVoices: 6 },
  'impact.robotweak': { layers: [{ synth: 'impact_robotweak', gain: 0.5 }], pitchVariance: 0.06, maxVoices: 4 },
  'impact.prop': { layers: [{ synth: 'prop_hit', gain: 0.4 }], pitchVariance: 0.15, maxVoices: 6 },
  'shell.brass': { layers: [{ synth: 'shell_brass', gain: 0.12 }], pitchVariance: 0.15, maxVoices: 4 },
  'shell.plastic': { layers: [{ synth: 'shell_plastic', gain: 0.2 }], pitchVariance: 0.15, maxVoices: 3 },

  'ui.firemode': { layers: [{ synth: 'firemode_click', gain: 0.5 }], bus: 'ui' },
  'impact.ricochet': { layers: [{ synth: 'ricochet', gain: 0.35 }], pitchVariance: 0.2, maxVoices: 4 },
  'ui.hit': { layers: [{ synth: 'hit_tick', gain: 0.35 }], pitchVariance: 0.04, maxVoices: 3, bus: 'ui' },
  'ui.crit': { layers: [{ synth: 'hit_crit', gain: 0.4 }], pitchVariance: 0.03, maxVoices: 3, bus: 'ui' },
  'ui.kill': { layers: [{ synth: 'kill', gain: 0.55 }], maxVoices: 2, bus: 'ui' },
  'robot.death': { layers: [{ synth: 'robot_death', gain: 0.6 }], pitchVariance: 0.08, maxVoices: 3 },
  'robot.boot': { layers: [{ synth: 'robot_boot', gain: 0.35 }], pitchVariance: 0.08, maxVoices: 3 },
  'player.land': { layers: [{ synth: 'land', gain: 0.5 }], pitchVariance: 0.08, bus: 'ui' },
  'player.jump': { layers: [{ synth: 'jump', gain: 0.4 }], pitchVariance: 0.1, bus: 'ui' },
};
