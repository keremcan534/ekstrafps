/**
 * Sound events → layers. Gameplay only ever references event names
 * (e.g. "ar.fire"); what those events sound like is decided here.
 *
 * To use real audio, add `file: 'audio/ar_shot.ogg'` to a layer (files go in
 * /public/audio). The synth recipe stays as a fallback if the file is missing.
 * Phones fetch WAVs in audio/guns and audio/voice as their .mp3 twins (compressedUrl):
 * run `node scripts/encode-audio.mjs` after adding or regenerating one.
 */
import { COMMANDER_LINES } from './CommanderVoice';
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
  /** Base pitch (1 = as recorded): lets one recording voice several guns. */
  pitch?: number;
  /** Max overlapping instances of this event. */
  maxVoices?: number;
  /** Bus: weapon sounds duck nothing, ui bypasses distance attenuation. */
  bus?: 'sfx' | 'ui';
  /** Send level into the room reverb (gunshots ~0.6, impacts ~0.25). */
  reverb?: number;
  /** Positional non-gunfire sounds: not heard beyond this (m, default 30). */
  maxDist?: number;
  /**
   * Voice calls: shouted / radio lines carry. Gentle falloff (never below ~45 %
   * inside maxDist) instead of the steep local curve used for clinks and impacts.
   */
  voice?: boolean;
  /** Phones: exempt from the far-gunfire cull (explosions: their 'farthest' layer is the point). */
  noCull?: boolean;
}

export const SOUND_BANK: Record<string, SoundEvent> = {
  // Layered gunshots: recorded close blast (variations) · synth low-end punch ·
  // mechanical action · room tail (scaled by room size) · distant report.
  'ar.fire': {
    layers: [
      { files: shots('ar', 4), gain: 1.2, range: 'near' },
      { synth: 'ar_punch', gain: 0.75, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.4, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.5,
    pitchVariance: 0.02,
    maxVoices: 16,
  },
  'ak.fire': {
    layers: [
      { files: shots('ak', 4), gain: 1.25, range: 'near' },
      { synth: 'ak_punch', gain: 0.9, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.45, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.55,
    pitchVariance: 0.02,
    maxVoices: 16,
  },
  'mk47.fire': {
    layers: [
      { files: shots('heavy', 2), gain: 1.15, range: 'near' },
      { synth: 'ak_punch', gain: 0.8, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.45, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.55,
    pitchVariance: 0.025,
    maxVoices: 16,
  },
  'rd704.fire': {
    layers: [
      { files: shots('mg', 4), gain: 1.25, range: 'near' },
      { synth: 'ak_punch', gain: 1.0, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.45, tail: true },
      ...distant(1.1),
    ],
    reverb: 0.55,
    pitchVariance: 0.02,
    maxVoices: 16,
  },
  'val.fire': {
    layers: [
      { files: shots('val', 3), gain: 1.0, range: 'near' },
      { synth: 'val_thump', gain: 0.5, range: 'near' },
      { synth: 'val_mech', gain: 0.35, range: 'near', dry: true },
    ],
    reverb: 0.3,
    pitchVariance: 0.03,
    maxVoices: 16,
  },
  'ppsh.fire': {
    layers: [
      { files: shots('p90', 4), gain: 1.1, range: 'near' },
      { synth: 'ar_punch', gain: 0.55, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.25, tail: true },
      ...distant(0.7),
    ],
    reverb: 0.45,
    pitchVariance: 0.025,
    maxVoices: 20,
  },
  'pistol.fire': {
    layers: [
      { files: shots('pistol', 3), gain: 1.25, range: 'near' },
      { synth: 'pistol_punch', gain: 0.85, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.22, tail: true },
      ...distant(0.6),
    ],
    reverb: 0.55,
    pitchVariance: 0.02,
    maxVoices: 8,
  },
  'shotgun.fire': {
    layers: [
      { files: shots('boom', 2), gain: 1.25, range: 'near' },
      { synth: 'shotgun_punch', gain: 1.25, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.32, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.65,
    pitchVariance: 0.025,
    maxVoices: 6,
  },
  // Newer guns voice the same recordings at their own pitch and weight.
  'mp5.fire': {
    layers: [
      { files: shots('p90', 4), gain: 1.0, range: 'near' },
      { synth: 'pistol_punch', gain: 0.5, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.22, tail: true },
      ...distant(0.6),
    ],
    reverb: 0.45,
    pitch: 1.1,
    pitchVariance: 0.025,
    maxVoices: 20,
  },
  'glock.fire': {
    layers: [
      { files: shots('pistol', 3), gain: 1.1, range: 'near' },
      { synth: 'pistol_punch', gain: 0.55, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.2, tail: true },
      ...distant(0.55),
    ],
    reverb: 0.5,
    pitch: 1.16,
    pitchVariance: 0.03,
    maxVoices: 20,
  },
  'saiga.fire': {
    layers: [
      { files: shots('boom', 2), gain: 1.2, range: 'near' },
      { synth: 'shotgun_punch', gain: 1.1, range: 'near' },
      { synth: 'ak_punch', gain: 0.4, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.32, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.6,
    pitch: 1.06,
    pitchVariance: 0.03,
    maxVoices: 8,
  },
  'svd.fire': {
    layers: [
      { files: shots('bolt', 3), gain: 1.25, range: 'near' },
      { synth: 'rifle_boom', gain: 1.0, range: 'near' },
      { synth: 'ak_punch', gain: 0.5, range: 'near' },
      ...distant(1.25),
    ],
    reverb: 0.6,
    pitch: 1.05,
    pitchVariance: 0.02,
    maxVoices: 6,
  },
  'm249.fire': {
    layers: [
      { files: shots('mg', 4), gain: 1.2, range: 'near' },
      { synth: 'ar_punch', gain: 0.8, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.45, tail: true },
      ...distant(1.1),
    ],
    reverb: 0.55,
    pitch: 1.07,
    pitchVariance: 0.02,
    maxVoices: 20,
  },
  'scar.fire': {
    layers: [
      { files: shots('heavy', 2), gain: 1.2, range: 'near' },
      { synth: 'rifle_boom', gain: 0.55, range: 'near' },
      { synth: 'ak_punch', gain: 0.8, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.45, tail: true },
      ...distant(1.15),
    ],
    reverb: 0.55,
    pitch: 0.94,
    pitchVariance: 0.025,
    maxVoices: 16,
  },
  // Bolt actions: N-wave crack, saturated body, deep boom, big room.
  'mosin.fire': {
    layers: [
      { files: shots('bolt', 3), gain: 1.3, range: 'near' },
      { synth: 'rifle_boom', gain: 1.1, range: 'near' },
      ...distant(1.3),
    ],
    reverb: 0.6,
    pitchVariance: 0.015,
    maxVoices: 4,
  },
  'kar98.fire': {
    layers: [
      { files: shots('bolt', 3), gain: 1.25, range: 'near' },
      { synth: 'rifle_boom', gain: 1.15, range: 'near' },
      ...distant(1.3),
    ],
    reverb: 0.6,
    pitchVariance: 0.015,
    maxVoices: 4,
  },
  'bolt.open': { layers: [{ file: 'audio/guns/bolt_open.wav', synth: 'bolt_slide_back', gain: 0.85 }], reverb: 0.15, pitchVariance: 0.03 },
  'bolt.close': { layers: [{ file: 'audio/guns/bolt_close.wav', synth: 'bolt_slide_fwd', gain: 0.9 }], reverb: 0.15, pitchVariance: 0.03 },
  'reload.bolt.start': { layers: [{ files: ['audio/guns/gear0.wav', 'audio/guns/gear1.wav', 'audio/guns/gear2.wav', 'audio/guns/gear3.wav', 'audio/guns/gear4.wav', 'audio/guns/gear5.wav', 'audio/guns/gear6.wav', 'audio/guns/gear7.wav'], synth: 'cloth', gain: 0.35 }], pitchVariance: 0.05, maxDist: 14 },
  'reload.bolt.round': { layers: [{ file: 'audio/guns/round_in.wav', synth: 'round_insert', gain: 0.75 }], pitchVariance: 0.04, maxDist: 14 },
  'impact.heavy': { layers: [{ synth: 'impact_heavy', gain: 0.6 }], reverb: 0.3, pitchVariance: 0.08, maxVoices: 4 },
  'shotgun.pump': { layers: [{ file: 'audio/guns/pump.wav', synth: 'shotgun_pump', gain: 0.85 }], pitchVariance: 0.02 },

  dry_fire: { layers: [{ synth: 'dry_fire', gain: 0.6 }] },
  'equip.rifle': { layers: [{ synth: 'equip', gain: 0.5 }], maxDist: 14 },
  'equip.pistol': { layers: [{ synth: 'equip', gain: 0.45 }], pitchVariance: 0.05, maxDist: 14 },
  'equip.shotgun': { layers: [{ synth: 'equip', gain: 0.55 }, { file: 'audio/guns/pump.wav', synth: 'shotgun_pump', gain: 0.35, delay: 0.18 }], maxDist: 14 },

  'reload.rifle.start': { layers: [{ files: ['audio/guns/gear0.wav', 'audio/guns/gear1.wav', 'audio/guns/gear2.wav', 'audio/guns/gear3.wav', 'audio/guns/gear4.wav', 'audio/guns/gear5.wav', 'audio/guns/gear6.wav', 'audio/guns/gear7.wav'], synth: 'cloth', gain: 0.35 }], pitchVariance: 0.05, maxDist: 14 },
  'reload.rifle.magout': { layers: [{ file: 'audio/guns/rel_magout.wav', synth: 'mag_out', gain: 0.9 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.rifle.magin': { layers: [{ file: 'audio/guns/rel_magin.wav', synth: 'mag_in', gain: 0.95 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.rifle.boltback': { layers: [{ file: 'audio/guns/rel_boltback.wav', synth: 'bolt_back', gain: 0.85 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.rifle.boltforward': { layers: [{ file: 'audio/guns/rel_boltforward.wav', synth: 'bolt_forward', gain: 0.95 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.pistol.start': { layers: [{ files: ['audio/guns/gear0.wav', 'audio/guns/gear1.wav', 'audio/guns/gear2.wav', 'audio/guns/gear3.wav', 'audio/guns/gear4.wav', 'audio/guns/gear5.wav', 'audio/guns/gear6.wav', 'audio/guns/gear7.wav'], synth: 'cloth', gain: 0.35 }], pitchVariance: 0.05, maxDist: 14 },
  'reload.pistol.magout': { layers: [{ file: 'audio/guns/rel_magout.wav', synth: 'mag_out', gain: 0.6 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.pistol.magin': { layers: [{ file: 'audio/guns/rel_magin.wav', synth: 'mag_in', gain: 0.65 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.pistol.slideback': { layers: [{ file: 'audio/guns/rel_boltback.wav', synth: 'bolt_back', gain: 0.6 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.pistol.slideforward': { layers: [{ file: 'audio/guns/rel_boltforward.wav', synth: 'bolt_forward', gain: 0.65 }], pitchVariance: 0.02, maxDist: 14 },
  'reload.shotgun.start': { layers: [{ files: ['audio/guns/gear0.wav', 'audio/guns/gear1.wav', 'audio/guns/gear2.wav', 'audio/guns/gear3.wav', 'audio/guns/gear4.wav', 'audio/guns/gear5.wav', 'audio/guns/gear6.wav', 'audio/guns/gear7.wav'], synth: 'cloth', gain: 0.35 }], pitchVariance: 0.05, maxDist: 14 },
  'reload.shotgun.shell': { layers: [{ file: 'audio/guns/shell_in.wav', synth: 'shell_insert', gain: 0.8 }], pitchVariance: 0.04, maxDist: 14 },

  'impact.concrete': { reverb: 0.22, layers: [{ synth: 'impact_concrete', gain: 0.35 }], pitchVariance: 0.12, maxVoices: 8, maxDist: 24 },
  'impact.metal': { reverb: 0.22, layers: [{ synth: 'impact_metal', gain: 0.45 }], pitchVariance: 0.06, maxVoices: 6, maxDist: 20 },
  'impact.robot': { reverb: 0.22, layers: [{ files: ['audio/guns/metal_hit0.wav', 'audio/guns/metal_hit1.wav', 'audio/guns/metal_hit2.wav'], synth: 'impact_robot', gain: 0.5 }], pitchVariance: 0.03, maxDist: 22, maxVoices: 6 },
  'impact.robotweak': { reverb: 0.22, layers: [{ file: 'audio/guns/metal_hs.wav', gain: 0.75 }, { synth: 'impact_robotweak', gain: 0.25 }], pitchVariance: 0.04, maxDist: 24, maxVoices: 6 },
  'impact.prop': { layers: [{ synth: 'prop_hit', gain: 0.4 }], pitchVariance: 0.15, maxVoices: 6, maxDist: 18 },
  'shell.brass': { layers: [{ synth: 'shell_brass', gain: 0.1 }], pitchVariance: 0.03, maxVoices: 4 },
  'shell.plastic': { layers: [{ synth: 'shell_plastic', gain: 0.2 }], pitchVariance: 0.15, maxVoices: 3 },

  'ui.firemode': { layers: [{ synth: 'firemode_click', gain: 0.5 }], bus: 'ui' },
  'impact.ricochet': { layers: [{ synth: 'ricochet', gain: 0.22 }], pitchVariance: 0.1, maxVoices: 3, maxDist: 15 },
  'ui.hit': { layers: [{ synth: 'hit_tick', gain: 0.3 }], pitchVariance: 0, maxVoices: 3, bus: 'ui' },
  'ui.crit': { layers: [{ synth: 'hit_crit', gain: 0.4 }], pitchVariance: 0, maxVoices: 3, bus: 'ui' },
  'ui.kill': { layers: [{ synth: 'kill', gain: 0.55 }], maxVoices: 2, bus: 'ui' },
  'robot.death': { layers: [{ synth: 'robot_death', gain: 0.6 }], pitchVariance: 0.08, maxDist: 32, maxVoices: 3 },
  'robot.fall': { reverb: 0.25, layers: [{ file: 'audio/guns/metal_clang.wav', gain: 0.55 }, { synth: 'body_fall', gain: 0.35 }], pitchVariance: 0.05, maxDist: 24, maxVoices: 4 },
  // Footsteps: gear / clothing rustle on every step (yours and nearby operators').
  'foley.step': { layers: [{ files: ['audio/guns/gear0.wav', 'audio/guns/gear1.wav', 'audio/guns/gear2.wav', 'audio/guns/gear3.wav', 'audio/guns/gear4.wav', 'audio/guns/gear5.wav', 'audio/guns/gear6.wav', 'audio/guns/gear7.wav'], gain: 0.32 }], pitchVariance: 0.09, maxDist: 14, maxVoices: 6 },
  // Layered under every shot you fire (not other people's).
  'self.kick': { layers: [{ synth: 'chest_kick', gain: 0.75 }], maxVoices: 3, bus: 'ui' },
  'robot.stagger': { layers: [{ synth: 'servo_strain', gain: 0.5 }], pitchVariance: 0.1, maxDist: 20, maxVoices: 2 },
  // ---------- SABLE ----------
  'bd.fire': {
    layers: [
      { files: shots('ak', 4), gain: 1.15, range: 'near' },
      { synth: 'ak_punch', gain: 0.95, range: 'near' },
      { file: 'audio/guns/tail_hall.wav', gain: 0.55, tail: true },
      ...distant(1.0),
    ],
    reverb: 0.8,
    pitchVariance: 0.03,
    maxVoices: 12,
  },
  'bd.see_enemy': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_see_enemy.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.spread_out': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_spread_out.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.contact': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_contact.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.flanking': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_flanking.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.moving': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_moving.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.reloading': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_reloading.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.target_down': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_target_down.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.man_down': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_man_down.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.lost_visual': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_lost_visual.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
  'bd.hit': { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: 'audio/voice/bd_hit.wav', gain: 1.1, delay: 0.06 }], pitchVariance: 0.02, maxVoices: 2, maxDist: 150, voice: true },
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
  'power.down': { reverb: 0.7, layers: [{ file: 'audio/guns/power_out.wav', gain: 1.0 }, { synth: 'power_down', gain: 0.3, delay: 0.12 }], maxVoices: 1, bus: 'ui' },
  // The Choir (blackout cult): the rush sting is for you alone (no position), the rest is in the room.
  'choir.sting': { layers: [{ file: 'audio/guns/choir_sting.wav', gain: 1.0 }], maxVoices: 1, bus: 'ui' },
  'choir.hiss': { layers: [{ file: 'audio/guns/choir_hiss.wav', gain: 0.9 }], pitchVariance: 0.1, maxVoices: 2, reverb: 0.4, maxDist: 26 },
  'choir.whisper': { layers: [{ files: Array.from({ length: 8 }, (_, i) => `audio/voice/choir_voice_${i}.wav`), gain: 0.85 }, { files: ['audio/guns/choir_whisper0.wav', 'audio/guns/choir_whisper1.wav', 'audio/guns/choir_whisper2.wav'], gain: 0.3 }], pitchVariance: 0.08, maxVoices: 3, reverb: 0.5, maxDist: 20 },
  'choir.slash': { layers: [{ file: 'audio/guns/choir_slash.wav', gain: 1.0 }, { synth: 'impact_flesh', gain: 0.5, delay: 0.15 }], pitchVariance: 0.06, maxVoices: 2, reverb: 0.2, maxDist: 20 },
  'bd.encounter': { layers: [{ files: ['audio/guns/bd_encounter.wav', 'audio/guns/bd_encounter2.wav'], gain: 0.9 }], maxVoices: 1, bus: 'ui' },
  // Extraction: helicopter, evac bunker doors, countdown heartbeat, the theme.
  'heli.approach': { layers: [{ file: 'audio/guns/heli_approach.wav', gain: 1.0 }], maxVoices: 1, bus: 'ui' },
  'heli.takeoff': { reverb: 0.3, layers: [{ file: 'audio/guns/heli_takeoff.wav', gain: 1.1 }], maxVoices: 1, bus: 'ui' },
  'blastdoor.open': { reverb: 0.5, layers: [{ file: 'audio/guns/blastdoor_open.wav', gain: 1.1 }], maxDist: 140, voice: true, maxVoices: 1 },
  'blastdoor.slam': { reverb: 0.6, layers: [{ file: 'audio/guns/blastdoor_slam.wav', gain: 1.2 }], maxVoices: 1, bus: 'ui' },
  'extract.beat': { layers: [{ file: 'audio/guns/heartbeat.wav', gain: 0.8 }], maxVoices: 2, bus: 'ui' },
  'extract.theme': { layers: [{ file: 'audio/music/extracted.wav', gain: 0.95 }], maxVoices: 1, bus: 'ui' },
  // Facility PA: a short klaxon, then the automated intruder announcement.
  'alarm.short': { reverb: 0.5, layers: [{ file: 'audio/guns/alarm_short.wav', gain: 0.85 }], maxVoices: 1, bus: 'ui' },
  'announce.intruders': { reverb: 0.4, layers: [{ file: 'audio/voice/announce_intruders.wav', gain: 1.05 }], maxVoices: 1, bus: 'ui' },
  'bd.arrival': { layers: [{ file: 'audio/guns/bd_encounter2.wav', gain: 1.0 }], maxVoices: 1, bus: 'ui' },
  // Explosions carry like gunfire: the full blast up close, a dull low rumble far off.
  'explosion': { reverb: 0.6, layers: [{ file: 'audio/guns/explosion.wav', gain: 1.25, range: 'near' }, { file: 'audio/guns/explosion_far.wav', gain: 1.1, range: 'far' }, { file: 'audio/guns/explosion_far.wav', gain: 0.9, range: 'farthest' }], maxVoices: 3, noCull: true },
  'raid.siren': { reverb: 0.8, layers: [{ synth: 'raid_siren', gain: 0.6 }], maxVoices: 1, bus: 'ui' },
  'director.horde': { reverb: 0.5, layers: [{ file: 'audio/guns/alarm_short.wav', synth: 'horde_alarm', gain: 0.45 }], maxVoices: 1, bus: 'ui' },
  'robot.boot': { layers: [{ synth: 'robot_boot', gain: 0.35 }], pitchVariance: 0.08, maxDist: 18, maxVoices: 3 },
  'player.land': { layers: [{ synth: 'land', gain: 0.5 }], pitchVariance: 0.08, bus: 'ui' },
  'player.jump': { layers: [{ synth: 'jump', gain: 0.4 }], pitchVariance: 0.1, bus: 'ui' },
};

// Lab staff voices: six speakers (0-2 men, 3-4-5 women), one event per speaker and kind,
// so each person keeps their own voice ('civ.panic.3', 'civ.plead.0', 'civ.whimper.5').
const VOICE_FILES = ['civ_panic_00.wav', 'civ_panic_02.wav', 'civ_panic_04.wav', 'civ_panic_06.wav', 'civ_panic_11.wav', 'civ_panic_13.wav', 'civ_panic_15.wav', 'civ_panic_17.wav', 'civ_panic_20.wav', 'civ_panic_22.wav', 'civ_panic_24.wav', 'civ_panic_26.wav', 'civ_panic_31.wav', 'civ_panic_33.wav', 'civ_panic_35.wav', 'civ_panic_37.wav', 'civ_panic_40.wav', 'civ_panic_42.wav', 'civ_panic_44.wav', 'civ_panic_46.wav', 'civ_panic_51.wav', 'civ_panic_53.wav', 'civ_panic_55.wav', 'civ_panic_57.wav', 'civ_plead_00.wav', 'civ_plead_01.wav', 'civ_plead_02.wav', 'civ_plead_10.wav', 'civ_plead_11.wav', 'civ_plead_12.wav', 'civ_plead_20.wav', 'civ_plead_21.wav', 'civ_plead_22.wav', 'civ_plead_30.wav', 'civ_plead_31.wav', 'civ_plead_32.wav', 'civ_plead_40.wav', 'civ_plead_41.wav', 'civ_plead_42.wav', 'civ_plead_50.wav', 'civ_plead_51.wav', 'civ_plead_52.wav', 'civ_whimper_00.wav', 'civ_whimper_02.wav', 'civ_whimper_11.wav', 'civ_whimper_13.wav', 'civ_whimper_20.wav', 'civ_whimper_22.wav', 'civ_whimper_31.wav', 'civ_whimper_33.wav', 'civ_whimper_40.wav', 'civ_whimper_42.wav', 'civ_whimper_51.wav', 'civ_whimper_53.wav'];
for (let sp = 0; sp < 6; sp++) {
  for (const [kind, gain, maxDist] of [['panic', 1.0, 45], ['plead', 1.0, 35], ['whimper', 0.7, 12]] as const) {
    const files = VOICE_FILES.filter((f) => f.startsWith(`civ_${kind}_${sp}`)).map((f) => `audio/voice/${f}`);
    SOUND_BANK[`civ.${kind}.${sp}`] = { layers: [{ files, gain }], reverb: 0.35, pitchVariance: 0.03, maxVoices: 2, maxDist, voice: true };
  }
}

// The Warden (SABLE commander): one event per line, so BlackDivision can subtitle it.
for (const { id } of COMMANDER_LINES) {
  SOUND_BANK[`bd.cmd.${id}`] = { reverb: 0.8, layers: [{ synth: 'radio_click', gain: 0.5, dry: true }, { file: `audio/voice/${id}.wav`, gain: 1.15, delay: 0.06 }], maxVoices: 1, maxDist: 150, voice: true };
}

/**
 * Events the first seconds of a match don't need: voice lines, the cult, civilians,
 * extraction, the facility PA, building noises. Their files load after init() resolves
 * (AudioSystem.deferred), so PLAY unlocks as soon as guns, impacts, steps and UI are in.
 */
const DEFERRED = /^(?:bd\.(?!fire$)|civ\.|choir\.|heli\.|blastdoor\.|extract\.|announce\.|alarm\.|power\.|director\.|amb\.)/;
export const isDeferredEvent = (name: string): boolean => DEFERRED.test(name);

/** Folders that ship an .mp3 next to each .wav (scripts/encode-audio.mjs). Loops and music stay WAV. */
const COMPRESSED = ['audio/guns/', 'audio/voice/'];
/**
 * What phones fetch for a bank file (AudioSystem lowSpec): the .mp3 twin in the encoded
 * folders. Desktop and Electron load the WAVs. Bank keys stay '.wav' (generators keep
 * writing WAV; the loader falls back to it).
 */
export const compressedUrl = (file: string): string => (COMPRESSED.some((d) => file.startsWith(d)) ? file.replace(/\.wav$/, '.mp3') : file);

/** Ambience beds (looped by Ambience.ts; loaded with the deferred set). */
export const AMBIENCE_LOOPS = ['room', 'hvac', 'servers', 'power', 'wind', 'dark'].map((n) => `audio/amb/${n}.wav`);
// Distant building noises (positional: they come through walls muffled).
SOUND_BANK['amb.groan'] = { layers: [{ files: ['audio/amb/groan0.wav', 'audio/amb/groan1.wav', 'audio/amb/groan2.wav'], gain: 0.9 }], pitchVariance: 0.08, maxVoices: 1, reverb: 0.6, maxDist: 70, voice: true };
SOUND_BANK['amb.thump'] = { layers: [{ files: ['audio/amb/thump0.wav', 'audio/amb/thump1.wav'], gain: 1.0 }], pitchVariance: 0.1, maxVoices: 1, reverb: 0.7, maxDist: 80, voice: true };
SOUND_BANK['amb.rattle'] = { layers: [{ files: ['audio/amb/rattle0.wav', 'audio/amb/rattle1.wav'], gain: 0.7 }], pitchVariance: 0.15, maxVoices: 1, reverb: 0.4, maxDist: 40, voice: true };
