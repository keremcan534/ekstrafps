import * as THREE from 'three';
import type { Combatant } from '../game/TeamAgent';
import type { Bot } from './Bot';
import type { Contact } from './Memory';
import type { NavGrid } from './NavGrid';
import { planSearch } from './Tactics';
import { AI_TUNING } from './Tuning';
import { aiWorld } from './World';

export type SquadRole = 'none' | 'leader' | 'anchor' | 'suppressor' | 'flanker' | 'assault' | 'overwatch' | 'support';
export type SquadPlan = 'idle' | 'contact' | 'flank' | 'push' | 'search' | 'regroup' | 'retreat';

/** The player, for a friendly squad. */
export interface LeaderInfo {
  pos: THREE.Vector3;
  /** Facing as (sin, cos) of the view direction. */
  yaw: number;
  speed: number;
  alive: boolean;
}

interface Report {
  at: number;
  target: Combatant;
  pos: THREE.Vector3;
  conf: number;
  time: number;
  from: Bot;
}

interface Help {
  pos: THREE.Vector3;
  threat: THREE.Vector3;
  time: number;
  bot: Bot | null;
}

/**
 * Squad brain: shared knowledge, temporary roles, a plan, and a sense of
 * progress. Separate from the bots' own brains: it never moves anyone, it
 * informs (radio reports with a delay) and nudges (roles and plan add utility).
 *
 * - Contacts: a member's sighting reaches the others ~0.2–0.9 s later, as an
 *   approximate position. They still need their own eyes to shoot accurately.
 * - Roles (re-dealt as the fight changes): anchor holds, suppressor pins,
 *   flanker goes around, assault pushes, overwatch watches from range, support covers.
 * - Plan: contact → flank → push / search / regroup / retreat. If nobody makes
 *   tactical progress for a while, the plan changes (no six-man staring contests).
 */
export class SquadBrain {
  readonly members: Bot[] = [];
  plan: SquadPlan = 'idle';
  planSince = 0;
  inCombat = false;
  lastProgress = 0;
  progressNote = '';
  readonly centroid = new THREE.Vector3();
  primary: Combatant | null = null;
  readonly primaryPos = new THREE.Vector3();
  primaryConf = 0;
  flanker: Bot | null = null;
  flankSince = 0;
  flankBanUntil = 0;
  /** Friendly squads: how hard the player is being pressed (0..1+). */
  playerPressure = 0;
  /** Plan changes (debug / tests). */
  planChanges = 0;
  private queue: Report[] = [];
  private timer = Math.random() * AI_TUNING.squadInterval;
  private roleTimer = 0;
  private help: Help[] = [];
  private searchFor: Combatant | null = null;
  private searchPts: THREE.Vector3[] = [];
  private searchTaken = new Map<Bot, THREE.Vector3[]>();
  private playerThreat: { pos: THREE.Vector3; time: number } | null = null;
  private tmp = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly friendly: boolean,
    private nav: NavGrid,
    /** Friendly squads: the player. */
    readonly leader: (() => LeaderInfo | null) | null = null,
  ) {}

  add(b: Bot): void {
    if (!this.members.includes(b)) this.members.push(b);
    b.squad = this;
  }

  remove(b: Bot): void {
    const i = this.members.indexOf(b);
    if (i >= 0) this.members.splice(i, 1);
    if (b.squad === this) b.squad = null;
  }

  get alive(): Bot[] {
    return this.members.filter((m) => m.alive);
  }

  /** True while a flanker is on the move (suppressors lean on the trigger). */
  get flankActive(): boolean {
    return !!this.flanker && this.flanker.alive && this.flanker.decision === 'FLANK';
  }

  // ------------------------------------------------------------ radio

  /** A member saw / heard something: the others learn it after a radio delay. */
  report(from: Bot, c: Contact): void {
    const now = aiWorld.time;
    // Robots far from the squad aren't worth the airtime.
    if (c.kind === 'robot' && from.soldier.pos.distanceToSquared(this.centroid) > 400 && this.members.length > 1) return;
    const err = c.visible ? 1 : Math.min(6, c.uncertainty * 0.6);
    const pos = c.pos.clone();
    pos.x += (Math.random() - 0.5) * err;
    pos.z += (Math.random() - 0.5) * err;
    const delay = AI_TUNING.commDelayMin + Math.random() * (AI_TUNING.commDelayMax - AI_TUNING.commDelayMin);
    this.queue.push({ at: now + delay, target: c.target, pos, conf: c.visible ? 0.85 : c.confidence * 0.8, time: now, from });
    if (this.queue.length > 64) this.queue.shift();
  }

  /** Someone made tactical progress (cover reached, flank leg, enemy spotted...). */
  noteProgress(kind: string): void {
    this.lastProgress = aiWorld.time;
    this.progressNote = kind;
  }

  memberHurt(b: Bot): void {
    const t = b.target;
    this.help.push({ pos: b.soldier.pos.clone(), threat: t ? t.pos.clone() : b.soldier.pos.clone(), time: aiWorld.time, bot: b });
    if (this.help.length > 6) this.help.shift();
  }

  memberDied(b: Bot): void {
    const now = aiWorld.time;
    for (const m of this.members) {
      if (m === b) continue;
      m.memory.friendlyDeaths.push({ pos: b.soldier.pos.clone(), time: now });
      m.memory.addDanger(b.soldier.pos, 5, now);
    }
    if (this.flanker === b) this.flanker = null;
    this.roleTimer = 0;
  }

  // ------------------------------------------------------------ friendly squad: the player

  /** The player took fire from around `from` (shooter known when possible). */
  playerHurt(from: THREE.Vector3, who: Combatant | null): void {
    const now = aiWorld.time;
    this.playerPressure = Math.min(2, this.playerPressure + 0.35);
    this.playerThreat = { pos: from.clone().setY(0), time: now };
    const l = this.leader?.();
    if (l) this.help.push({ pos: l.pos.clone(), threat: from.clone().setY(0), time: now, bot: null });
    if (who && who.team !== this.id) {
      for (const m of this.members) {
        if (!m.alive) continue;
        const delay = AI_TUNING.commDelayMin + Math.random() * (AI_TUNING.commDelayMax - AI_TUNING.commDelayMin);
        this.queue.push({ at: now + delay, target: who, pos: from.clone().setY(0), conf: 0.55, time: now, from: m });
      }
    }
  }

  /** The player is shooting at something there: teammates look that way. */
  playerFiresAt(point: THREE.Vector3, who: Combatant | null): void {
    const now = aiWorld.time;
    this.playerThreat = { pos: point.clone().setY(0), time: now };
    for (const m of this.members) {
      if (!m.alive) continue;
      if (who && who.team !== this.id) m.memory.receive(who, this.playerThreat.pos, 0.45, now - 0.3, now);
      else if (!m.target || m.target.confidence < 0.3) m.memory.addSound(this.playerThreat.pos, 0.35, 'player-fire', now);
    }
  }

  // ------------------------------------------------------------ queries from bots

  aliveNear(b: Bot, r: number): number {
    let n = 0;
    for (const m of this.members) if (m !== b && m.alive && m.soldier.pos.distanceToSquared(b.soldier.pos) < r * r) n++;
    if (this.friendly) {
      const l = this.leader?.();
      if (l?.alive && l.pos.distanceToSquared(b.soldier.pos) < r * r) n++;
    }
    return n;
  }

  /** How far a bot is from the group (friendlies: from the player). */
  distanceFromSquad(b: Bot): number {
    const p = b.soldier.pos;
    if (this.friendly) {
      const l = this.leader?.();
      return l?.alive ? Math.hypot(l.pos.x - p.x, l.pos.z - p.z) : 0;
    }
    return Math.hypot(this.centroid.x - p.x, this.centroid.z - p.z);
  }

  /** Where to regroup: near the player (friendly) or the squad's centre. */
  regroupPoint(b: Bot): THREE.Vector3 | null {
    if (this.friendly) return this.formationSlot(b);
    const others = this.alive.filter((m) => m !== b);
    if (!others.length) return null;
    const c = this.tmp.set(0, 0, 0);
    for (const m of others) c.add(m.soldier.pos);
    c.divideScalar(others.length);
    return this.nav.nearestWalkable(c.x, c.z, new THREE.Vector3(), 3);
  }

  /** The squad's line toward the threat (flanks swing away from it). */
  anchorPos(b: Bot): THREE.Vector3 {
    for (const m of this.members) if (m !== b && m.alive && m.role === 'anchor') return m.soldier.pos;
    return this.centroid;
  }

  /** Someone (a squadmate, or the player) needs help: where they are and what they face. */
  helpFor(b: Bot): { pos: THREE.Vector3; threat: THREE.Vector3; player: boolean } | null {
    const now = aiWorld.time;
    let best: Help | null = null;
    let bd = Infinity;
    for (const h of this.help) {
      if (now - h.time > 7 || h.bot === b) continue;
      if (h.bot && !h.bot.alive) continue;
      const d = h.pos.distanceTo(b.soldier.pos);
      if (d > 45 || d < 4) continue;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    if (!best && this.friendly && this.playerThreat && now - this.playerThreat.time < 5) {
      const l = this.leader?.();
      if (l?.alive && this.playerPressure > 0.3) return { pos: l.pos, threat: this.playerThreat.pos, player: true };
    }
    return best ? { pos: best.pos, threat: best.threat, player: !best.bot } : null;
  }

  /** Friendly bots stay out of the player's line of fire. */
  lanePenalty(b: Bot, p: THREE.Vector3): number {
    if (!this.friendly) return 0;
    const l = this.leader?.();
    if (!l?.alive) return 0;
    const dx = p.x - l.pos.x;
    const dz = p.z - l.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.6) return 2; // the player's own spot
    if (d > 28) return 0;
    const fx = Math.sin(l.yaw);
    const fz = Math.cos(l.yaw);
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d)));
    void b;
    return ang < 0.25 ? 1.5 : ang < 0.4 ? 0.5 : 0;
  }

  flankStarted(b: Bot): void {
    this.flanker = b;
    this.flankSince = aiWorld.time;
    this.noteProgress('flank started');
  }

  flankDone(b: Bot, ok: boolean): void {
    if (this.flanker !== b) return;
    this.flanker = null;
    if (!ok) this.flankBanUntil = aiWorld.time + 8;
    if (this.plan === 'flank') this.setPlan(ok ? 'push' : 'contact');
  }

  /** Coordinated search: each member gets its own points around the last known position. */
  searchPointsFor(b: Bot, c: Contact): THREE.Vector3[] {
    const now = aiWorld.time;
    if (this.searchFor !== c.target || !this.searchPts.length) {
      this.searchFor = c.target;
      const n = Math.max(4, this.alive.length * 2 + 1);
      this.searchPts = planSearch(this.nav, c.pos, c.vel, n, (p) => b.memory.wasSearched(p, now));
      this.searchTaken.clear();
    }
    const mine = this.searchTaken.get(b);
    if (mine) return mine;
    // Greedy: the free points closest to this bot (others took theirs already).
    const taken = new Set<THREE.Vector3>();
    for (const v of this.searchTaken.values()) for (const p of v) taken.add(p);
    const free = this.searchPts.filter((p) => !taken.has(p)).sort((x, y) => x.distanceToSquared(b.soldier.pos) - y.distanceToSquared(b.soldier.pos));
    const out = free.slice(0, this.alive.length > 1 ? 2 : 4);
    if (!out.length) out.push(...planSearch(this.nav, c.pos, null, 2));
    this.searchTaken.set(b, out);
    return out;
  }

  /**
   * Loose formation slot. Friendly: around the player — never in front of the
   * gun, never right behind them, compressed in corridors, spread in the open.
   */
  formationSlot(b: Bot): THREE.Vector3 | null {
    const l = this.friendly ? this.leader?.() : null;
    if (!l || !l.alive) return null;
    const idx = Math.max(0, this.members.indexOf(b));
    const fx = Math.sin(l.yaw);
    const fz = Math.cos(l.yaw);
    const width = this.nav.clearance(l.pos.x, l.pos.z, fx, fz, 6);
    const sp = AI_TUNING.formationSpacing;
    let back: number;
    let side: number;
    if (width < 4) {
      // Corridor: a loose column behind, alternating a little side to side.
      back = 2.6 + idx * 2;
      side = (idx % 2 ? -1 : 1) * Math.min(0.5, width * 0.15);
    } else {
      // Open: a wedge, wider with room.
      const row = 1 + ((idx / 2) | 0);
      back = 1.2 + row * 1.6;
      side = (idx % 2 ? -1 : 1) * Math.min(sp * row, width * 0.45);
    }
    let x = l.pos.x - fx * back + fz * side;
    let z = l.pos.z - fz * back - fx * side;
    // Not straight behind the player in the open (blocks backing up).
    if (width >= 4 && Math.abs(side) < 1.2) {
      x += fz * 1.4;
      z -= fx * 1.4;
    }
    return this.nav.nearestWalkable(x, z, new THREE.Vector3(), 3);
  }

  // ------------------------------------------------------------ the squad brain

  update(dt: number): void {
    const now = aiWorld.time;
    // Deliver radio reports.
    if (this.queue.length) {
      let k = 0;
      for (const r of this.queue) {
        if (r.at > now) {
          this.queue[k++] = r;
          continue;
        }
        if (!r.target.alive) continue;
        for (const m of this.members) if (m !== r.from && m.alive) m.memory.receive(r.target, r.pos, r.conf, r.time, now);
      }
      this.queue.length = k;
    }
    this.playerPressure = Math.max(0, this.playerPressure - dt * 0.25);
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = AI_TUNING.squadInterval * (0.85 + Math.random() * 0.3);
    this.think(now);
  }

  private setPlan(p: SquadPlan): void {
    if (p === this.plan) return;
    this.plan = p;
    this.planSince = aiWorld.time;
    this.planChanges++;
    this.noteProgress(`plan:${p}`);
  }

  private think(now: number): void {
    const alive = this.alive;
    if (!alive.length) {
      this.inCombat = false;
      this.plan = 'idle';
      return;
    }
    this.centroid.set(0, 0, 0);
    for (const m of alive) this.centroid.add(m.soldier.pos);
    this.centroid.divideScalar(alive.length);
    // The squad's picture: the most important non-robot contact anyone holds.
    let best: Contact | null = null;
    let bs = 0;
    let visibleBy = 0;
    for (const m of alive) {
      for (const c of m.memory.contacts.values()) {
        if (c.kind === 'robot' || c.target.downed) continue;
        const s = c.confidence * (c.visible ? 1.5 : 1);
        if (c.visible) visibleBy++;
        if (s > bs) {
          bs = s;
          best = c;
        }
      }
    }
    this.primary = best?.target ?? null;
    if (best) this.primaryPos.copy(best.pos);
    this.primaryConf = best?.confidence ?? 0;
    const combat = this.primaryConf > 0.25;
    if (combat && !this.inCombat) {
      this.inCombat = true;
      this.lastProgress = now;
      this.setPlan('contact');
      this.roleTimer = 0;
    } else if (!combat && this.inCombat) {
      this.inCombat = false;
      this.setPlan(best && best.confidence > 0.08 ? 'search' : 'idle');
      for (const m of this.members) m.role = 'none';
    }
    if (!this.inCombat) {
      if (this.plan === 'search' && now - this.planSince > AI_TUNING.searchDuration) this.setPlan('idle');
      return;
    }
    this.roleTimer -= AI_TUNING.squadInterval;
    if (this.roleTimer <= 0) {
      this.roleTimer = 6 + Math.random() * 4;
      this.assignRoles(alive);
    }
    // Plan transitions.
    const age = now - this.planSince;
    const avgHp = alive.reduce((s, m) => s + m.agent.hp, 0) / alive.length;
    const enemies = Math.max(1, ...alive.map((m) => m.memory.countKnown(0.3, now)));
    const friends = alive.length + (this.friendly && this.leader?.()?.alive ? 1 : 0);
    if ((avgHp < 0.35 || (friends <= 1 && enemies >= 2)) && this.plan !== 'retreat') {
      this.setPlan('retreat');
      return;
    }
    if (this.plan === 'retreat' && age > 9) this.setPlan(avgHp > 0.4 ? 'contact' : 'regroup');
    if (this.plan === 'regroup' && age > 8) this.setPlan('contact');
    if (this.plan === 'contact' && age > 5 && friends >= 2 && now > this.flankBanUntil && !this.flanker) {
      if (alive.some((m) => m.role === 'flanker')) this.setPlan('flank');
    }
    if (this.plan === 'flank' && (age > 25 || (!this.flanker && age > 6))) this.setPlan(friends > enemies ? 'push' : 'contact');
    if (this.plan === 'push' && age > 14) this.setPlan('contact');
    if (visibleBy === 0 && this.plan === 'contact' && best && best.age(now) > 5) this.setPlan('search');
    if (this.plan === 'search' && visibleBy > 0) this.setPlan('contact');
    // Stalled: nobody has made tactical progress in a while → change the plan.
    if (now - this.lastProgress > AI_TUNING.squadStallTime) {
      const next: SquadPlan = this.plan === 'contact' ? (now > this.flankBanUntil && friends >= 2 ? 'flank' : 'push') : this.plan === 'flank' ? 'push' : this.plan === 'push' ? 'search' : 'contact';
      this.setPlan(next);
      this.roleTimer = 0;
    }
  }

  /** Deal roles for this moment of the fight (they change as it does). */
  private assignRoles(alive: Bot[]): void {
    const now = aiWorld.time;
    const ranked = (score: (m: Bot) => number, pool: Bot[]) => pool.slice().sort((a, b) => score(b) - score(a));
    let pool = alive.slice();
    const take = (m: Bot | undefined, r: Bot['role']) => {
      if (!m) return;
      m.role = r;
      pool = pool.filter((x) => x !== m);
    };
    // Anchor: whoever has eyes on (or is in cover facing) the threat; marksmen take overwatch.
    const sees = (m: Bot) => (m.target?.visible ? 2 : 0) + (m.inCover ? 1 : 0) + (m.target ? m.target.confidence : 0);
    const anchor = ranked(sees, pool)[0];
    take(anchor, anchor?.agent.personality.role === 'marksman' ? 'overwatch' : 'anchor');
    if (!pool.length) return;
    // Flanker: healthy, flank-minded, not the one in a firefight right now.
    if (now > this.flankBanUntil) {
      const fl = ranked((m) => m.profile.flank * m.agent.hp - (m.target?.visible ? 0.4 : 0) + (m.flank ? 0.5 : 0), pool)[0];
      if (fl && fl.agent.hp > 0.45) take(fl, 'flanker');
    }
    if (!pool.length) return;
    // Suppressor: ammo and the inclination.
    const su = ranked((m) => m.profile.suppress + (m.soldier.ammo / Math.max(1, m.soldier.magSize)) * 0.5 + (m.target?.confidence ?? 0) * 0.3, pool)[0];
    take(su, 'suppressor');
    for (const m of pool) m.role = m.profile.push > 1.2 ? 'assault' : m.agent.personality.role === 'medic' ? 'support' : 'assault';
  }
}
