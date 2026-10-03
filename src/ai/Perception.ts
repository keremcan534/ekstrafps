import * as THREE from 'three';
import { GROUPS, type Physics } from '../core/Physics';
import type { Combatant } from '../game/TeamAgent';
import type { Contact } from './Memory';
import type { Bot } from './Bot';
import { NOISE_RANGE, NOISE_WEIGHT } from './NoiseBus';
import { AI_TUNING } from './Tuning';
import { aiWorld } from './World';

const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Distance factor on how fast something gets noticed. */
const distFactor = (d: number) => (d < 4 ? 4 : d < 10 ? 2 : d < 20 ? 1.3 : d < 35 ? 0.8 : d < 55 ? 0.5 : 0.3);

/** What a perception tick found (the brain reacts to these immediately). */
export interface SenseEvents {
  /** A contact just became visible (confirmed). */
  spotted: Contact | null;
  /** A visible contact just went out of sight. */
  lost: Contact | null;
  /** Heard a hostile gunshot / footsteps / something new. */
  heard: boolean;
}

/**
 * The bot's senses. Vision builds recognition over time (a pixel of someone at
 * 50 m in the dark takes a while; someone sprinting past at 5 m is instant);
 * hearing turns noises into estimated positions with an error that grows with
 * distance and walls. Runs on a staggered tick and a shared ray budget.
 */
export class BotPerception {
  private tick: number;
  private lastNoiseId = 0;
  private lastNoiseTime = 0;
  private eye = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private cands: { c: Combatant; d: number; fov: number; pri: number }[] = [];
  readonly events: SenseEvents = { spotted: null, lost: null, heard: false };

  constructor(private bot: Bot, private physics: Physics) {
    this.tick = Math.random() * AI_TUNING.perceptionInterval;
    this.lastNoiseId = aiWorld.noise.lastId;
    this.lastNoiseTime = aiWorld.time;
  }

  /** Returns true on a tick (events are fresh). */
  update(dt: number, world: readonly Combatant[]): boolean {
    this.tick -= dt;
    if (this.tick > 0) return false;
    const step = AI_TUNING.perceptionInterval - this.tick;
    this.tick = AI_TUNING.perceptionInterval * (0.85 + Math.random() * 0.3);
    this.events.spotted = null;
    this.events.lost = null;
    this.events.heard = false;
    this.vision(Math.min(0.3, step), world);
    this.hearing();
    return true;
  }

  private vision(step: number, world: readonly Combatant[]): void {
    const b = this.bot;
    const s = b.soldier;
    const mem = b.memory;
    const now = aiWorld.time;
    this.eye.copy(s.headPos).y += 0.08;
    const engaged = b.hasThreat;
    const half = (engaged ? 78 : 62) * DEG;
    const cands = this.cands;
    cands.length = 0;
    for (const c of world) {
      if (c.team === b.team || !c.alive) continue;
      const dx = c.pos.x - s.pos.x;
      const dz = c.pos.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      const ct = mem.contacts.get(c);
      if (d > AI_TUNING.visionRange) {
        if (ct?.visible) this.lose(ct);
        continue;
      }
      const ang = Math.abs(wrap(Math.atan2(dx, dz) - s.yaw));
      let fov = ang < 32 * DEG ? 1 : ang < half ? 0.6 : ang < half + 25 * DEG ? 0.22 : 0;
      if (d < 2.6) fov = Math.max(fov, 0.8); // right next to us: felt, heard
      if (fov === 0) {
        if (ct?.visible) this.lose(ct);
        continue;
      }
      // Keep tracking what we see first, then half-seen things, then the nearest new ones.
      const pri = (ct?.visible ? 0 : ct && ct.recognition > 0.05 ? 1 : 2) * 1000 + d;
      cands.push({ c, d, fov, pri });
    }
    cands.sort((a, b) => a.pri - b.pri);
    const maxRays = 5;
    let rays = 0;
    const dark = aiWorld.darkness;
    for (const k of cands) {
      if (rays >= maxRays || !aiWorld.takeRay()) break; // the rest keep their state until next tick
      rays++;
      const c = k.c;
      const chest = this.physics.lineOfSight(this.eye, c.aim, GROUPS.sight);
      let head = chest;
      if (!chest && rays < maxRays && aiWorld.takeRay()) {
        rays++;
        head = this.physics.lineOfSight(this.eye, c.head, GROUPS.sight);
      }
      const exposure = chest ? 1 : head ? 0.45 : 0;
      const ct = mem.contacts.get(c);
      if (exposure === 0) {
        if (ct?.visible) this.lose(ct);
        continue;
      }
      if (ct?.visible) {
        mem.see(c, now);
        ct.lineOfFire = chest;
        continue;
      }
      // Recognition builds up: distance, angle, stance, motion, light, expectation.
      const crouch = c.crouch?.() ?? 0;
      const speed = c.vel ? Math.hypot(c.vel.x, c.vel.z) : 0;
      const motion = speed > 3 ? 1.5 : speed > 1 ? 1.15 : 0.85;
      const lit = aiWorld.isLit(c) || (c.ref ? aiWorld.noise.firedRecently(c.ref, now, 0.35) : false);
      const light = (1 - 0.6 * dark * (k.d > 8 ? 1 : 0.3)) * (lit ? 1.8 : 1);
      const expected = ct && ct.confidence > 0.3 && ct.pos.distanceTo(c.pos) < ct.uncertainty + 3 ? 2.2 : 1;
      const score = exposure * k.fov * distFactor(k.d) * (crouch > 0.5 ? 0.6 : 1) * motion * light * expected;
      const rec = (ct?.recognition ?? 0) + score * step * AI_TUNING.recognitionSpeed * (0.75 + 0.5 * b.skill01);
      if (rec < 0.04 && !ct) continue;
      const contact = ct ?? mem.ensure(c, now);
      contact.recognition = Math.min(1, rec);
      contact.lastGlimpse = now;
      if (contact.recognition >= 1) {
        mem.see(c, now);
        contact.lineOfFire = chest;
        this.events.spotted = contact;
      } else if (contact.recognition >= AI_TUNING.suspicionLevel && contact.confidence < 0.35) {
        // Half-seen: "something moved there". A rough belief, enough to turn and look.
        this.tmp.set(c.pos.x + (Math.random() - 0.5) * 2, 0, c.pos.z + (Math.random() - 0.5) * 2);
        mem.hear(c, this.tmp, 0.3, 2.5, now, 'vision');
      }
    }
  }

  private lose(c: Contact): void {
    this.bot.memory.lose(c, aiWorld.time);
    if (!this.events.lost) this.events.lost = c;
  }

  private hearing(): void {
    const b = this.bot;
    const s = b.soldier;
    const mem = b.memory;
    const now = aiWorld.time;
    const bus = aiWorld.noise;
    const eye = this.eye.copy(s.headPos);
    for (const n of bus.since(this.lastNoiseId, this.lastNoiseTime)) {
      if (n.source === b.owner || n.kind === 'impact') continue;
      if (n.team === b.team) {
        // A squadmate shooting: there's a fight over there.
        if (n.kind === 'gunshot' || n.kind === 'gunshot_sup') b.onAllyGunfire(n.pos);
        continue;
      }
      const range = NOISE_RANGE[n.kind] * n.loud * AI_TUNING.hearingScale;
      const d = eye.distanceTo(n.pos);
      if (d > range) continue;
      let occluded = false;
      if (d > 6) {
        if (aiWorld.takeRay()) occluded = !this.physics.lineOfSight(eye, this.tmp.set(n.pos.x, n.pos.y + 0.4, n.pos.z), GROUPS.sight);
        else occluded = d > 15;
      }
      // Through walls a sound carries less far and points less precisely.
      if (occluded && d > range * 0.6) continue;
      const err = 1 + d * (occluded ? 0.2 : 0.09);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * err;
      const est = this.tmp.set(n.pos.x + Math.sin(a) * r, 0, n.pos.z + Math.cos(a) * r);
      const conf = Math.min(0.85, Math.max(0.12, 1 - d / range)) * (occluded ? 0.6 : 1) * NOISE_WEIGHT[n.kind];
      const who = aiWorld.resolveOwner(n.source);
      if (who && who.team !== b.team && who.alive) {
        const c = mem.hear(who, est, conf, err, now, 'hearing');
        if (n.kind === 'reload') c.lastReloadHeard = now;
        if (n.kind === 'gunshot' || n.kind === 'gunshot_sup') mem.gunfire.push({ pos: est.clone(), time: now });
      } else mem.addSound(est, conf, n.kind, now);
      this.events.heard = true;
    }
    this.lastNoiseId = bus.lastId;
    this.lastNoiseTime = now;
  }
}
