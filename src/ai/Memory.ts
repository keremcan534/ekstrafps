import * as THREE from 'three';
import type { Combatant } from '../game/TeamAgent';
import { AI_TUNING } from './Tuning';

export type ContactSource = 'vision' | 'hearing' | 'damage' | 'bullets' | 'squad';

/**
 * What one bot believes about one enemy. Positions are beliefs: while the enemy
 * is visible they track it, otherwise they hold the last thing the bot saw,
 * heard or was told, and the belief fades.
 */
export class Contact {
  /** Best estimate of where it is now. */
  readonly pos = new THREE.Vector3();
  readonly lastSeenPos = new THREE.Vector3();
  readonly lastHeardPos = new THREE.Vector3();
  /** Estimated velocity (from consecutive sightings). */
  readonly vel = new THREE.Vector3();
  lastSeenTime = -1e9;
  lastHeardTime = -1e9;
  /** Last time anything at all was learned about it. */
  lastInfoTime: number;
  readonly firstTime: number;
  /** Vision: 0..1, sightings turn into a confirmed contact at 1. */
  recognition = 0;
  visible = false;
  /** The bot could hit it from where it stands (chest-height line). */
  lineOfFire = false;
  /** 0..1: how much the bot trusts `pos`. */
  confidence = 0;
  /** Radius (m) the enemy could be in around `pos`. */
  uncertainty = 0;
  /** Base danger (robots only matter up close). */
  threat = 1;
  /** Came from a squadmate, not the bot's own senses. */
  reported = false;
  source: ContactSource = 'hearing';
  lastHurtMe = -1e9;
  lastShotNearMe = -1e9;
  /** It was searched for after being lost. */
  searched = false;
  /** Last time it was visible from here (for the "it just disappeared" logic). */
  lostAt = -1e9;
  /** Heard it reloading (a moment to push). */
  lastReloadHeard = -1e9;
  /** Last perception tick it was (partly) in sight; recognition only fades after that. */
  lastGlimpse = -1e9;

  constructor(readonly target: Combatant, now: number) {
    this.lastInfoTime = now;
    this.firstTime = now;
    this.threat = target.kind === 'robot' ? 0.4 : 1;
  }

  get kind(): Combatant['kind'] {
    return this.target.kind;
  }

  age(now: number): number {
    return now - this.lastInfoTime;
  }

  seenAgo(now: number): number {
    return now - this.lastSeenTime;
  }
}

interface Mark {
  pos: THREE.Vector3;
  time: number;
}

/**
 * A bot's tactical memory: contacts (above) plus the places that matter —
 * where shots came from, where friends died, what was already searched,
 * which covers it used, unexplained sounds to check.
 */
export class BotMemory {
  readonly contacts = new Map<Combatant, Contact>();
  /** Sounds without a known enemy behind them (to investigate). */
  readonly sounds: (Mark & { conf: number; kind: string })[] = [];
  /** Places that got people shot (avoid standing there). */
  readonly danger: (Mark & { radius: number })[] = [];
  readonly searched: Mark[] = [];
  readonly covers: Mark[] = [];
  readonly friendlyDeaths: Mark[] = [];
  /** Where gunfire came from recently (any hostile). */
  readonly gunfire: Mark[] = [];

  ensure(target: Combatant, now: number): Contact {
    let c = this.contacts.get(target);
    if (!c) {
      c = new Contact(target, now);
      this.contacts.set(target, c);
    }
    return c;
  }

  /** Own eyes: exact position while visible. */
  see(target: Combatant, now: number): Contact {
    const c = this.ensure(target, now);
    const dtSeen = now - c.lastSeenTime;
    if (dtSeen > 0.02 && dtSeen < 0.8) {
      const k = Math.min(1, dtSeen * 3);
      c.vel.x += ((target.pos.x - c.lastSeenPos.x) / dtSeen - c.vel.x) * k;
      c.vel.z += ((target.pos.z - c.lastSeenPos.z) / dtSeen - c.vel.z) * k;
    } else if (dtSeen >= 0.8) c.vel.set(0, 0, 0);
    c.lastSeenPos.copy(target.pos);
    c.pos.copy(target.pos);
    c.lastSeenTime = now;
    c.lastInfoTime = now;
    c.visible = true;
    c.confidence = 1;
    c.uncertainty = 0;
    c.reported = false;
    c.source = 'vision';
    c.searched = false;
    return c;
  }

  /** Out of sight now: keep the belief where it was last seen. */
  lose(c: Contact, now: number): void {
    if (!c.visible) return;
    c.visible = false;
    c.lineOfFire = false;
    c.lostAt = now;
  }

  /** Heard / felt / bullets: an estimated position with an error radius. */
  hear(target: Combatant, est: THREE.Vector3, conf: number, err: number, now: number, source: ContactSource): Contact {
    const c = this.ensure(target, now);
    if (c.visible) return c; // eyes beat ears
    // Take the new estimate if it's better than what we have, or ours is stale.
    if (now - c.lastInfoTime > 1.5 || err <= c.uncertainty + 1 || conf >= c.confidence) {
      c.pos.copy(est);
      c.uncertainty = err;
      c.vel.set(0, 0, 0);
    }
    // Repeated noises build certainty (a sustained fight heard through walls becomes
    // something to act on), not just the loudest single one.
    c.confidence = Math.min(0.85, Math.max(c.confidence, conf) + conf * 0.25);
    c.lastHeardPos.copy(est);
    c.lastHeardTime = now;
    c.lastInfoTime = now;
    c.source = source;
    c.reported = false;
    c.searched = false;
    return c;
  }

  /** A squadmate's report: approximate, slightly old, never better than own fresh info. */
  receive(target: Combatant, approx: THREE.Vector3, conf: number, time: number, now: number): Contact {
    const c = this.ensure(target, now);
    if (c.visible || c.lastInfoTime >= time) return c;
    c.pos.copy(approx);
    c.uncertainty = 2 + (now - time) * 2.5;
    c.confidence = Math.max(c.confidence * 0.9, Math.min(0.8, conf));
    c.lastInfoTime = time;
    c.reported = true;
    c.source = 'squad';
    c.searched = false;
    return c;
  }

  addSound(pos: THREE.Vector3, conf: number, kind: string, now: number): void {
    // Merge with a recent nearby sound.
    for (const s of this.sounds) {
      if (s.pos.distanceToSquared(pos) < 25) {
        s.pos.lerp(pos, 0.5);
        s.time = now;
        s.conf = Math.max(s.conf, conf);
        return;
      }
    }
    this.sounds.push({ pos: pos.clone(), time: now, conf, kind });
    if (this.sounds.length > 6) this.sounds.shift();
  }

  addDanger(pos: THREE.Vector3, radius: number, now: number): void {
    this.danger.push({ pos: pos.clone(), time: now, radius });
    if (this.danger.length > 8) this.danger.shift();
  }

  markSearched(pos: THREE.Vector3, now: number): void {
    this.searched.push({ pos: pos.clone(), time: now });
    if (this.searched.length > 12) this.searched.shift();
  }

  markCover(pos: THREE.Vector3, now: number): void {
    this.covers.push({ pos: pos.clone(), time: now });
    if (this.covers.length > 6) this.covers.shift();
  }

  wasSearched(pos: THREE.Vector3, now: number, radius = 4, window = 25): boolean {
    for (const s of this.searched) if (now - s.time < window && s.pos.distanceToSquared(pos) < radius * radius) return true;
    return false;
  }

  /** 0..1 danger at a point (recent hits, friendly deaths). */
  dangerAt(p: THREE.Vector3, now: number): number {
    let d = 0;
    for (const z of this.danger) {
      const age = now - z.time;
      if (age > 40) continue;
      const k = 1 - p.distanceTo(z.pos) / z.radius;
      if (k > 0) d = Math.max(d, k * (1 - age / 40));
    }
    for (const z of this.friendlyDeaths) {
      const age = now - z.time;
      if (age > 60) continue;
      const k = 1 - p.distanceTo(z.pos) / 6;
      if (k > 0) d = Math.max(d, k * 0.8 * (1 - age / 60));
    }
    return d;
  }

  /** Beliefs fade out of sight; uncertainty grows with how far the enemy could have moved. */
  update(now: number, dt: number): void {
    const tau = AI_TUNING.contactMemory;
    for (const [t, c] of this.contacts) {
      if (!t.alive) {
        this.contacts.delete(t);
        continue;
      }
      if (c.visible) continue;
      c.confidence *= Math.exp(-dt / (c.reported ? tau * 0.7 : tau));
      const speed = t.kind === 'robot' ? 2 : 2.6;
      c.uncertainty = Math.min(18, c.uncertainty + dt * speed * 0.6);
      if (now - c.lastGlimpse > 0.4) c.recognition = Math.max(0, c.recognition - dt * 0.45);
      if (c.confidence < 0.04 && c.age(now) > AI_TUNING.forgetAfter) this.contacts.delete(t);
    }
    const old = (list: Mark[], window: number) => {
      while (list.length && now - list[0].time > window) list.shift();
    };
    old(this.sounds, 14);
    old(this.searched, 40);
    old(this.covers, 30);
    old(this.gunfire, 20);
    old(this.danger, 40);
    old(this.friendlyDeaths, 60);
  }

  /** How much a contact matters right now (target choice). */
  score(c: Contact, from: THREE.Vector3, now: number): number {
    const d = Math.hypot(c.pos.x - from.x, c.pos.z - from.z);
    let threat = c.threat;
    if (c.kind === 'robot') threat = d < 8 ? 0.9 : d < 16 ? 0.5 : 0.25;
    if (c.target.downed) threat *= 0.15;
    let s = c.confidence * threat * (c.visible ? 1.6 : 1) / (1 + d / 28);
    if (now - c.lastHurtMe < 4) s *= 1.7;
    else if (now - c.lastShotNearMe < 3) s *= 1.3;
    return s;
  }

  /** The contact that matters most; the current one is kept unless another is clearly worse to ignore. */
  primary(from: THREE.Vector3, now: number, current: Contact | null, minConf = 0.08): Contact | null {
    let best: Contact | null = null;
    let bs = 0;
    for (const c of this.contacts.values()) {
      if (c.confidence < minConf || !c.target.alive) continue;
      let s = this.score(c, from, now);
      if (c === current) s *= 1.35; // target persistence
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    return best;
  }

  /** Hostile contacts we're reasonably sure about (not robots). */
  countKnown(minConf: number, now: number, robots = false): number {
    let n = 0;
    for (const c of this.contacts.values()) if (c.confidence >= minConf && (robots || c.kind !== 'robot') && !c.target.downed && c.age(now) < 20) n++;
    return n;
  }
}
