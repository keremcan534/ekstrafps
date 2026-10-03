import * as THREE from 'three';
import { JOG, RUN, SPRINT, WALK, type AimMode, type PlayerTarget, type Soldier, type SoldierDeps } from '../enemies/Soldier';
import type { Combatant, Personality, TeamAgent } from '../game/TeamAgent';
import type { DamageInfo } from '../targets/Humanoid';
import { canSee, coverRegistry, findCover, protectedFrom, type CoverSpot } from './Cover';
import { BotMemory, type Contact } from './Memory';
import { Navigator } from './Navigator';
import { BotPerception } from './Perception';
import { PERSONAS, personaFor, type Persona } from './Persona';
import type { SquadBrain, SquadRole } from './Squad';
import { flankLabel, planFlank, planSearch, type FlankPlan } from './Tactics';
import { AI_TUNING, PROFILES, WEAPON_RANGE, type Profile, type ProfileId } from './Tuning';
import { aiWorld, type AIListener } from './World';

/**
 * Tactical decisions, SAIN-style: picked by ordered rules (self → close quarters →
 * the squad's jobs → what the enemy is doing), and each one carries itself out:
 * a decision changes when its rule stops applying or it finishes, not every tick.
 *
 *   FOLLOW        nothing to fight: the team / economy logic drives
 *   SHOOT         enemy in sight, in the open: shoot, strafing in legs (stand and shoot)
 *   DOGFIGHT      enemy close: shoot while backing off and circling
 *   RUSH          enemy reloading / pinned / the squad pushes: charge
 *   HOLD_COVER    in cover: shoot from it, peek and lean round its edge on a rhythm
 *   RUN_TO_COVER  under fire in the open: sprint to the nearest fighting cover
 *   MOVE_TO_COVER enemy in sight: work to cover while shooting
 *   SHIFT_COVER   this cover's gone stale: the next one (aggressive: closer)
 *   RETREAT       badly hurt: cover away from the enemy
 *   AMBUSH        lost them: hold the angle on the last known spot, leaning to check it
 *   SEARCH        held long enough: go and find them (wait, approach, peek, sweep)
 *   INVESTIGATE   an enemy only heard / a noise / squadmates' gunfire
 *   FLANK         the squad's flanker: around the side
 *   SUPPRESS      pin a known spot while a squadmate moves
 *   RELOAD        empty, or low with nobody in sight (cover first when exposed)
 *   REGROUP       too far from the squad
 *   HELP          a squadmate is fighting something we can't see
 *   ROBOT         a rogue machine close by: shoot it, keeping the gap
 */
export type Decision =
  | 'FOLLOW' | 'SHOOT' | 'DOGFIGHT' | 'RUSH' | 'HOLD_COVER' | 'RUN_TO_COVER' | 'MOVE_TO_COVER' | 'SHIFT_COVER'
  | 'RETREAT' | 'AMBUSH' | 'SEARCH' | 'INVESTIGATE' | 'FLANK' | 'SUPPRESS' | 'RELOAD' | 'REGROUP' | 'HELP' | 'ROBOT';

export const DECISIONS: readonly Decision[] = [
  'FOLLOW', 'SHOOT', 'DOGFIGHT', 'RUSH', 'HOLD_COVER', 'RUN_TO_COVER', 'MOVE_TO_COVER', 'SHIFT_COVER',
  'RETREAT', 'AMBUSH', 'SEARCH', 'INVESTIGATE', 'FLANK', 'SUPPRESS', 'RELOAD', 'REGROUP', 'HELP', 'ROBOT',
];

/** Decisions that answer an enemy in sight: switching into one of them is never held back. */
const SIGHT: ReadonlySet<Decision> = new Set<Decision>(['SHOOT', 'DOGFIGHT', 'HOLD_COVER', 'RUN_TO_COVER', 'MOVE_TO_COVER', 'RUSH']);

/** Moving decisions that still shoot at what shows up (walk / jog pace). */
const SHOOTS_ON_MOVE: ReadonlySet<Decision> = new Set<Decision>(['SEARCH', 'INVESTIGATE', 'FLANK', 'HELP', 'SHIFT_COVER', 'AMBUSH']);

/** Shortest run of a decision before a non-urgent change (seconds): no flip-flopping. */
const MIN_HOLD: Record<Decision, number> = {
  FOLLOW: 0.5, SHOOT: 1.4, DOGFIGHT: 0.9, RUSH: 1.5, HOLD_COVER: 1.6, RUN_TO_COVER: 0.8, MOVE_TO_COVER: 1.2,
  SHIFT_COVER: 1.5, RETREAT: 2.5, AMBUSH: 1.6, SEARCH: 3, INVESTIGATE: 2.5, FLANK: 3, SUPPRESS: 2.5, RELOAD: 1,
  REGROUP: 2, HELP: 2, ROBOT: 0.8,
};

const pick = <T>(a: readonly T[]) => a[(Math.random() * a.length) | 0];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Personality (economy layer) → tactical profile; team style nudges it. */
export function profileFor(p: Personality, style?: string): ProfileId {
  if (p.aggression >= 0.85 && p.loner > 0.25) return 'reckless';
  if (style === 'disciplined' && p.aggression >= 0.3) return Math.random() < 0.7 ? 'tactical' : 'balanced';
  if (p.role === 'marksman' || p.aggression < 0.3) return 'cautious';
  if (p.aggression > 0.66) return Math.random() < 0.8 ? 'aggressive' : 'reckless';
  return Math.random() < 0.3 ? 'tactical' : 'balanced';
}

interface SearchState {
  phase: 'wait' | 'move' | 'corner' | 'look';
  pts: THREE.Vector3[];
  i: number;
  until: number;
  target: Contact | null;
  since: number;
}

/**
 * One bot's tactical mind:
 *   perception (senses) → memory (beliefs) → decision rules (SAIN-style layers) →
 *   tactical movement (navigator, cover, flank, search, leans) → combat (Soldier).
 * The squad brain sits above: it shares contacts, deals roles and sets a plan.
 *
 * Bots never read an enemy's live position unless they currently see it: they
 * act on what they saw, heard, felt or were told, and that belief fades.
 */
export class Bot implements AIListener {
  readonly memory = new BotMemory();
  readonly senses: BotPerception;
  readonly navigator: Navigator;
  profile: Profile;
  /** How this bot fights (when each rule fires). */
  persona: Persona;
  /** Its own personality (the elite flag swaps in the gigachad while it's set). */
  private basePersona: Persona;
  squad: SquadBrain | null = null;
  role: SquadRole = 'none';
  decision: Decision = 'FOLLOW';
  /** Step inside the decision (debug). */
  action = 'calm';
  /** Kept for the debug panel (the rules don't score). */
  scores: Partial<Record<Decision, number>> = {};
  /** The contact that matters most right now. */
  target: Contact | null = null;
  suppression = 0;
  cover: CoverSpot | null = null;
  coverSince = -1e9;
  inCover = false;
  /** Standing at the cover's peek spot (exposed on purpose). */
  atPeek = false;
  flank: FlankPlan | null = null;
  /** Watchdog bookkeeping (seconds). */
  sinceMove = 0;
  sinceProgress = 0;
  sinceContact = 99;
  lastProgress = 'spawn';
  watchdogFlash = 0;
  watchdogCount = 0;
  /** 0..1 skill (reaction, recognition, peeks, decision quality). */
  skill01 = 0.4;
  /**
   * How urgent the squad's objective is (0..1): its team has somewhere to be (a supply
   * drop, a hunt, a rush). Far robots and unidentified noises don't derail it.
   */
  objective = 0;
  /** Debug drawing data. */
  readonly debug = { covers: [] as { pos: THREE.Vector3; ok: boolean }[], searchPts: [] as THREE.Vector3[], investigate: null as THREE.Vector3 | null };
  /** Stats for tests. */
  readonly stats: Record<string, number> = {};

  private decisionAt = -1e9;
  /** No non-urgent change before this. */
  private minUntil = 0;
  /** A proposed change waits for a second agreeing evaluation (debounce). */
  private proposal: Decision | null = null;
  private proposalN = 0;
  /** The running decision finished (or failed): decide again now, no debounce. */
  private done = false;
  /** This evaluation follows a finished decision (the rules don't keep it going). */
  private finished = false;
  private evalTimer = Math.random() * 0.2;
  private interrupt = false;
  /** Watchdog: pushed out of a standoff (search at once, shift cover toward them). */
  private pushOnUntil = 0;
  private progressAt = new THREE.Vector3(1e9, 0, 1e9);

  // Per-decision state.
  private peek = { out: false, until: 0, next: 0, lean: 0, move: false };
  private strafe = { dir: 0, last: 0, until: 0, legs: 0 };
  private adadUntil = 0;
  private adadNext = 0;
  private leanSide = 0;
  private leanCheckAt = 0;
  private suppressUntil = 0;
  private readonly suppressPt = new THREE.Vector3();
  private flankIndex = 0;
  private flankBanUntil = 0;
  private flankPending = 0;
  private search: SearchState | null = null;
  private investigate: { pos: THREE.Vector3; arrived: number; since: number } | null = null;
  private noCoverUntil = 0;
  private coverRetryAt = 0;
  private arrivedCover: CoverSpot | null = null;
  private retreatedAt = -1e9;
  private lastShift = -1e9;
  private rushUntil = 0;
  private rushCooldown = 0;
  private rushSaw = false;
  private crouchCycle = 0;
  private standUp = true;
  private kiteTimer = 0;
  private lookTimer = 0;
  private lookAngle = 0;
  private lastHurt = -1e9;
  private lastThreatAt = -1e9;
  private allyFireAt = -1e9;
  private readonly allyFirePos = new THREE.Vector3();
  private lastShare = new WeakMap<Combatant, number>();
  private lastFireProgress = -1e9;
  /** The current sighting: when it began and how long to hold ground on it (SAIN). */
  private sight = { target: null as Contact | null, start: 0, on: false, hold: 1 };
  /** The last noise decided on (go and look, or not): once per noise. */
  private noise = { mark: null as object | null, go: false };
  /** Search legs: sprint or not, re-rolled every few seconds. */
  private searchSprint = { at: 0, on: false };
  /** Rolled once per loss of sight: how long to hold the angle before searching. */
  private lost = { target: null as Contact | null, lostAt: -2e9, after: 0 };
  /** Rolled once per heard contact: go and look, or hold and wait. */
  private heard = { target: null as Contact | null, go: false };
  /** Who the aim has been settling on. */
  private aimedAt: Combatant | null = null;
  private readonly aimTgt: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: false,
  };
  private face: THREE.Vector3 | null = null;
  private readonly faceBuf = new THREE.Vector3();
  private aimMode: AimMode = 'ready';
  private fire = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(readonly agent: TeamAgent, private deps: SoldierDeps, teamStyle?: string) {
    this.navigator = new Navigator(agent.soldier, deps.nav);
    this.senses = new BotPerception(this, deps.physics);
    this.profile = PROFILES[profileFor(agent.personality, teamStyle)];
    this.basePersona = this.persona = personaFor(this.profile.id, agent.personality, false);
    aiWorld.listeners.add(this);
  }

  // ------------------------------------------------------------ identity (AIListener)

  /** When this bot last took a hit (aiWorld time). */
  get hurtAt(): number {
    return this.lastHurt;
  }

  get team(): string {
    return this.agent.team;
  }

  get owner(): object {
    return this.agent.soldier;
  }

  get soldier(): Soldier {
    return this.agent.soldier;
  }

  get alive(): boolean {
    return this.agent.alive && !this.agent.downed;
  }

  get name(): string {
    return this.agent.personality.name;
  }

  chest(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.agent.soldier.chestPos);
  }

  /** Any threat worth acting on (robots only when close). */
  get hasThreat(): boolean {
    const t = this.target;
    if (!t || t.confidence < 0.12) return false;
    return t.kind !== 'robot' || Math.hypot(t.pos.x - this.soldier.pos.x, t.pos.z - this.soldier.pos.z) < 16;
  }

  /** Currently shooting at this (visible) enemy — the team brain's "target". */
  get engaged(): Combatant | null {
    return this.target?.visible ? this.target.target : null;
  }

  /** Give this bot a fighting personality (it keeps it through respawns). */
  setPersona(p: Persona): void {
    this.basePersona = this.persona = p;
  }

  /** The elite flag (the team logic sets it after spawn): the personality follows. */
  private syncPersona(): void {
    this.persona = this.agent.chad ? PERSONAS.gigachad : this.basePersona;
  }

  private stat(k: string): void {
    this.stats[k] = (this.stats[k] ?? 0) + 1;
  }

  // ------------------------------------------------------------ events from the world

  /** A round passed close: suppression, and a rough idea where it came from. */
  onNearMiss(dist: number, origin: THREE.Vector3, owner: object | null, team: string): void {
    const now = aiWorld.time;
    const k = Math.max(0, (2.2 - dist) / 2.2);
    const before = this.suppression;
    this.suppression = Math.min(1.6, this.suppression + (0.16 + 0.34 * k) * AI_TUNING.suppressionGain);
    this.lastThreatAt = now;
    if (before < AI_TUNING.suppressedLevel && this.suppression >= AI_TUNING.suppressedLevel) this.interrupt = true;
    const who = aiWorld.resolveOwner(owner);
    if (who && who.team !== this.team && who.team === team && who.alive) {
      const d = origin.distanceTo(this.soldier.pos);
      const err = 2 + d * 0.15;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * err;
      this.tmp.set(origin.x + Math.sin(a) * r, 0, origin.z + Math.cos(a) * r);
      const c = this.memory.hear(who, this.tmp, 0.5, err, now, 'bullets');
      c.lastShotNearMe = now;
      if (this.decision === 'FOLLOW') this.interrupt = true;
    }
  }

  onDamaged(info: DamageInfo): void {
    const now = aiWorld.time;
    const h = info.hit;
    this.lastHurt = now;
    this.lastThreatAt = now;
    this.suppression = Math.min(1.6, this.suppression + 0.5);
    this.memory.addDanger(this.soldier.pos, 3.5, now);
    this.interrupt = true;
    const who = aiWorld.resolveOwner(h.owner ?? null);
    if (who && who.team !== this.team && who.alive && h.weaponId !== 'bleed') {
      const err = 1.5 + h.distance * 0.08;
      this.tmp.copy(h.point).addScaledVector(h.direction, -Math.max(2, h.distance));
      this.tmp.x += (Math.random() - 0.5) * err;
      this.tmp.z += (Math.random() - 0.5) * err;
      this.tmp.y = 0;
      const c = this.memory.hear(who, this.tmp, 0.85, err, now, 'damage');
      c.lastHurtMe = now;
      this.share(c, true);
    }
    this.squad?.memberHurt(this);
  }

  /** A squadmate is shooting nearby: there's a fight over there. */
  onAllyGunfire(pos: THREE.Vector3): void {
    if (pos.distanceToSquared(this.soldier.pos) > 45 * 45) return;
    this.allyFireAt = aiWorld.time;
    this.allyFirePos.copy(pos);
  }

  onDeath(): void {
    coverRegistry.release(this);
    this.cover = null;
    this.inCover = false;
    this.navigator.stop();
    this.squad?.memberDied(this);
  }

  /** Fresh spawn: no memories, calm. */
  reset(): void {
    this.memory.contacts.clear();
    this.memory.sounds.length = 0;
    this.memory.danger.length = 0;
    this.target = null;
    this.suppression = 0;
    this.cover = null;
    this.inCover = false;
    this.flank = null;
    this.search = null;
    this.investigate = null;
    this.decision = 'FOLLOW';
    this.action = 'calm';
    this.sinceProgress = 0;
    this.proposal = null;
    this.navigator.stop();
    coverRegistry.release(this);
    this.syncPersona();
  }

  /** Called when someone tells this bot (radio) about a point to watch (no identity). */
  hearAlert(from: THREE.Vector3): void {
    this.memory.addSound(from, 0.55, 'alert', aiWorld.time);
    if (this.decision === 'FOLLOW') this.interrupt = true;
  }

  /** Nobody kneels next to a body with a threat in view or bullets flying. */
  safeToRevive(): boolean {
    const now = aiWorld.time;
    if (this.suppression > 0.3 || now - this.lastHurt < 4 || now - this.lastThreatAt < 3) return false;
    const t = this.target;
    if (t && t.kind !== 'robot' && t.confidence > 0.4 && (t.visible || t.age(now) < 4)) return false;
    if (t && t.kind === 'robot' && t.visible && Math.hypot(t.pos.x - this.soldier.pos.x, t.pos.z - this.soldier.pos.z) < 10) return false;
    return true;
  }

  // ------------------------------------------------------------ perception

  /** Senses + memory; every frame (the expensive parts run on a staggered tick). */
  sense(dt: number, world: readonly Combatant[]): void {
    const now = aiWorld.time;
    this.skill01 = clamp01((this.soldier.skill - 0.8) / 0.8);
    this.suppression = Math.max(0, this.suppression - AI_TUNING.suppressionDecay * dt * (this.inCover ? 1.4 : 1));
    this.memory.update(now, dt);
    this.sinceContact += dt;
    if (!this.senses.update(dt, world)) return;
    const ev = this.senses.events;
    if (ev.spotted) this.onSpotted(ev.spotted);
    if (ev.lost && ev.lost === this.target) this.interrupt = true;
    if (ev.heard && this.decision === 'FOLLOW') this.interrupt = true;
    for (const c of this.memory.contacts.values()) {
      if (c.visible) this.sinceContact = 0;
      if (c.visible || (c.age(now) < 0.35 && c.confidence > 0.3 && !c.reported)) this.share(c, false);
    }
  }

  private onSpotted(c: Contact): void {
    const now = aiWorld.time;
    this.sinceContact = 0;
    this.interrupt = true;
    this.progress('spotted');
    const s = this.soldier;
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    // Reaction: expected (heard, told, just lost behind cover) is fast; a surprise is slow.
    const expected = now - c.lastHeardTime < 5 || c.reported || now - c.lostAt < 6;
    const delay = (0.95 - 0.55 * this.skill01) * (expected ? 0.45 : 1.15) * (0.8 + Math.random() * 0.4) + d * 0.004;
    s.react(this.agent.chad ? Math.min(delay, 0.28) : delay);
    s.settle(expected ? 0.9 : this.agent.chad ? 1.4 : 0.2);
    if (c.kind === 'player') this.agent.onSpotPlayer?.();
    if (now - c.firstTime < 0.5 || now - c.lostAt > 8) {
      this.agent.say(pick(c.kind === 'robot' ? ['Contact, bot!', 'Robot, on me!', 'Got one here!'] : ['Contact!', 'Hostile, eyes on!', 'Enemy spotted!', 'Shooters!']));
    }
  }

  /** Tell the squad (radio, with delay); throttled per contact. */
  private share(c: Contact, force: boolean): void {
    if (!this.squad) return;
    const now = aiWorld.time;
    const last = this.lastShare.get(c.target) ?? -1e9;
    if (!force && now - last < 0.9) return;
    this.lastShare.set(c.target, now);
    this.squad.report(this, c);
  }

  /** Something meaningful happened (resets the passivity watchdog). */
  progress(kind: string): void {
    this.sinceProgress = 0;
    this.lastProgress = kind;
    this.squad?.noteProgress(kind);
  }

  // ------------------------------------------------------------ the brain

  /** Re-evaluate when due (or on events). True while a tactical decision is active. */
  think(dt: number): boolean {
    const now = aiWorld.time;
    this.evalTimer -= dt;
    this.watchdogFlash -= dt;
    this.syncPersona();
    const s = this.soldier;
    if (Math.hypot(s.vel.x, s.vel.z) > 0.35) this.sinceMove = 0;
    else this.sinceMove += dt;
    this.sinceProgress += dt;
    // Ground made counts as progress; choosing a decision or peeking again doesn't.
    if (s.pos.distanceToSquared(this.progressAt) > 9) {
      this.progressAt.copy(s.pos);
      this.sinceProgress = 0;
    }
    // Anti-passivity: something to deal with and nothing happening → push on.
    if (this.hasTask && this.sinceProgress > AI_TUNING.passivityTimeout * this.profile.patience * 1.6) {
      this.watchdogFlash = 2.4;
      this.watchdogCount++;
      this.stat('watchdog');
      this.sinceProgress = 0;
      this.pushOnUntil = now + 6;
      this.done = true;
    }
    if (!this.hasTask && this.decision === 'FOLLOW') this.sinceProgress = 0;
    if (this.done || this.interrupt || this.evalTimer <= 0) {
      this.evalTimer = AI_TUNING.decisionInterval * (0.85 + Math.random() * 0.3);
      const finished = this.done;
      this.finished = finished;
      this.done = false;
      this.interrupt = false;
      this.target = this.memory.primary(s.pos, now, this.target);
      this.updateCover(this.target, now);
      const { d, urgent } = this.decide(now);
      if (d === this.decision && !finished) {
        this.proposal = null;
        this.proposalN = 0;
      } else if (finished || urgent || (SIGHT.has(d) && !SIGHT.has(this.decision))) {
        this.enter(d, now);
      } else if (now >= this.minUntil) {
        if (this.proposal === d) {
          if (++this.proposalN >= 2) this.enter(d, now);
        } else {
          this.proposal = d;
          this.proposalN = 1;
        }
      }
    }
    return this.decision !== 'FOLLOW';
  }

  /** Has a reason to be doing something tactical (watchdog applies). */
  get hasTask(): boolean {
    if (this.investigate || this.search) return true;
    const t = this.target;
    if (t && t.kind !== 'robot' && t.confidence > 0.2) return true;
    return !!this.squad?.inCombat && this.decision !== 'FOLLOW';
  }

  /**
   * The rules, in priority order (first match wins). `urgent` changes skip the
   * debounce: the mag ran dry, falling back, close quarters, hit in the open.
   */
  private decide(now: number): { d: Decision; urgent: boolean } {
    const s = this.soldier;
    const P = this.persona;
    const t = this.target;
    const sq = this.squad;
    const cur = this.decision;
    const hp = this.agent.hp;
    const mag = s.magSize > 0 ? s.ammo / s.magSize : 1;
    const reserve = s.reserve > 0;
    const pushOn = now < this.pushOnUntil;

    // --- No soldier to fight: robots, or the calm layer (squad help, noises, orders).
    if (!t || t.kind === 'robot' || t.confidence < 0.12 || t.target.downed) {
      if (t && t.kind === 'robot') {
        const d = this.flat(t.pos);
        // Keep at it through a blink out of sight (no on-off-on with every pillar).
        const keep = cur === 'ROBOT' && now - t.lastSeenTime < 1.5;
        if ((t.visible || keep) && d < (this.objective > 0 ? 14 : 30) + (cur === 'ROBOT' ? 4 : 0)) return { d: 'ROBOT', urgent: cur === 'FOLLOW' || d < 8 };
      }
      return { d: this.calm(now), urgent: false };
    }

    const d = this.flat(t.pos);
    const seenAgo = now - t.lastSeenTime;
    const everSeen = t.lastSeenTime > -1e8;
    // Out of sight for a blink still counts as in sight; a gunfight in the open keeps its
    // aim on the spot a few seconds (they ducked: they'll come back up).
    const vis = t.visible || seenAgo < (cur === 'SHOOT' || cur === 'DOGFIGHT' ? 2.5 : 0.5);
    const shotAt = now - this.lastThreatAt < 1.8;
    const hurt = now - this.lastHurt < 2.5;
    const theyShotMe = now - t.lastHurtMe < 2 || now - t.lastShotNearMe < 2;
    this.trackSight(t, now);

    // 1. Self: an empty mag comes first (on the move to cover when exposed).
    if (s.ammo === 0 && reserve) return { d: 'RELOAD', urgent: true };
    if (cur === 'RELOAD' && !this.finished) return { d: 'RELOAD', urgent: false };
    // 2. Badly hurt and still in the line of fire: fall back.
    if (P.retreatHp > 0 && hp < P.retreatHp && (vis || shotAt) && now - this.retreatedAt > 10 && cur !== 'RETREAT') return { d: 'RETREAT', urgent: true };
    if (cur === 'RETREAT' && now - this.decisionAt < 12 && !this.finished) return { d: 'RETREAT', urgent: false };
    // 3. Close quarters (seen, or shooting at us from there): no cover runs, no peeks — fight.
    const [dfIn, dfOut] = P.dogfight;
    if ((vis || theyShotMe) && d < (cur === 'DOGFIGHT' ? dfOut : dfIn) && s.reloadTimer <= 0) return { d: 'DOGFIGHT', urgent: cur !== 'DOGFIGHT' };
    // 4. Rush: they're reloading close by, or a squadmate has them pinned.
    if (cur === 'RUSH' && now < this.rushUntil) return { d: 'RUSH', urgent: false };
    if (P.rushes && now > this.rushCooldown && hp > 0.45 && mag >= 0.5 && everSeen && this.suppression < 1) {
      const reloading = now - t.lastReloadHeard < 4 && d < (P.sprints ? 20 : 10);
      const pinnedBySquad = !!sq && d < (P.sprints ? 75 : 50) && !vis && sq.members.some((m) => m !== this && m.alive && m.decision === 'SUPPRESS' && m.target?.target === t.target);
      const squadPush = sq?.plan === 'push' && (this.role === 'assault' || this.role === 'flanker') && d < 32;
      if (reloading || pinnedBySquad || squadPush || (pushOn && !vis && d < 40)) return { d: 'RUSH', urgent: reloading };
    }
    // 5. The squad's jobs (only while this bot isn't in its own gunfight).
    if (cur === 'FLANK' && this.flank) return { d: 'FLANK', urgent: false };
    if (cur === 'SUPPRESS' && now < this.suppressUntil) return { d: 'SUPPRESS', urgent: false };
    if (sq && !t.visible) {
      if (this.role === 'flanker' && sq.plan === 'flank' && now > this.flankBanUntil && now > sq.flankBanUntil && !(vis && d < 25) && hp > 0.45) return { d: 'FLANK', urgent: false };
      if (P.suppresses && everSeen && seenAgo < 12 && mag >= 0.5) {
        // Cover fire: a squadmate on the same enemy is reloading or falling back near us,
        // or our flanker is on the move.
        const mate = sq.members.find((m) => m !== this && m.alive && (m.decision === 'RELOAD' || m.decision === 'RETREAT') && m.target?.target === t.target && m.soldier.pos.distanceToSquared(s.pos) < 900);
        const flankCover = this.role === 'suppressor' && sq.flankActive;
        if ((mate || flankCover) && this.canSeeArea(t)) {
          if (mate) this.agent.say(pick(['Covering!', 'Got you covered!', 'Reload, I got it!']), true);
          return { d: 'SUPPRESS', urgent: false };
        }
      }
    }
    // 6. Topping up: when the enemy's far enough, or out of sight long enough (SAIN rules).
    if (this.wantsReload(t, d, now)) return { d: 'RELOAD', urgent: false };

    // 7. Enemy in sight.
    if (vis) {
      if (this.inCover && this.cover) {
        const canShift = P.shifts && this.suppression < 0.6 && now - this.decisionAt > 6 && now - this.lastShift > 10;
        if (canShift && now - this.coverSince > P.shiftCoverAfter * (pushOn ? 0.4 : 1)) return { d: 'SHIFT_COVER', urgent: false };
        return { d: 'HOLD_COVER', urgent: false };
      }
      // Already on the way to cover: get there.
      if ((cur === 'RUN_TO_COVER' || cur === 'MOVE_TO_COVER') && this.cover) return { d: cur, urgent: false };
      // Hold ground: on sight, stand and shoot a moment before going for cover — and keep
      // shooting while they aren't shooting back (busy with someone else, or unaware).
      const range = WEAPON_RANGE[s.weaponClass] ?? WEAPON_RANGE.rifle;
      const shootable = t.lineOfFire && d <= range.max * 1.25;
      const visFor = now - this.sight.start;
      if (shootable && (!theyShotMe || visFor < this.sight.hold) && (!hurt || visFor < this.sight.hold * 0.5)) return { d: 'SHOOT', urgent: false };
      const underFire = shotAt || hurt || this.suppression > AI_TUNING.suppressedLevel;
      if (now < this.noCoverUntil) return { d: 'SHOOT', urgent: false };
      if (underFire && P.standAndShoot < 0.8) return { d: 'RUN_TO_COVER', urgent: hurt };
      return { d: 'MOVE_TO_COVER', urgent: false };
    }

    // 8. Seen before, out of sight now: hold the angle, then go and look.
    if (everSeen) {
      const after = this.rollSearch(t, now) * (sq?.plan === 'search' ? 0.6 : 1) * (pushOn ? 0 : 1);
      if (seenAgo < after) {
        if (this.inCover && this.cover) return { d: 'HOLD_COVER', urgent: false };
        if (cur === 'MOVE_TO_COVER' && this.cover) return { d: cur, urgent: false };
        if (seenAgo < 2.5 && now > this.noCoverUntil && P.standAndShoot < 0.6 && d < 45) return { d: 'MOVE_TO_COVER', urgent: false };
        return { d: 'AMBUSH', urgent: false };
      }
      if (cur === 'SEARCH' && this.search) return { d: 'SEARCH', urgent: false };
      if (!t.searched && now - t.lastInfoTime < AI_TUNING.searchDuration) return { d: 'SEARCH', urgent: false };
      return { d: this.calm(now), urgent: false };
    }

    // 9. Only heard, or told by the radio.
    if (t.confidence > 0.22) {
      if (this.objective > 0 && d > 25) return { d: this.calm(now), urgent: false };
      if (cur === 'INVESTIGATE' && this.investigate) return { d: 'INVESTIGATE', urgent: false };
      // The squad is in a fight there: set up facing it (cover, then peeks) or go see.
      if (sq?.inCombat && d < 45) {
        if (this.inCover && this.cover) {
          return P.shifts && now - this.coverSince > P.shiftCoverAfter && now - this.lastShift > 10 ? { d: 'SHIFT_COVER', urgent: false } : { d: 'HOLD_COVER', urgent: false };
        }
        if (now > this.noCoverUntil && !this.rollHeard(t)) return { d: 'MOVE_TO_COVER', urgent: false };
        return { d: 'INVESTIGATE', urgent: false };
      }
      // Heard from calm: the hunters go and look; the rest freeze and listen first.
      if (this.rollHeard(t) || pushOn || now - t.firstTime > this.rollSearch(t, now)) return { d: 'INVESTIGATE', urgent: false };
      return { d: 'AMBUSH', urgent: false };
    }
    return { d: this.calm(now), urgent: false };
  }

  /** Nothing to fight: help the squad, check a noise, or carry on with orders. */
  private calm(now: number): Decision {
    const sq = this.squad;
    const busy = this.objective > 0;
    if (sq) {
      const far = sq.distanceFromSquad(this);
      if (far > (sq.friendly ? AI_TUNING.friendlyTooFar : 30)) return 'REGROUP';
      if (!busy && sq.helpFor(this)) return 'HELP';
    }
    if (this.decision === 'INVESTIGATE' && this.investigate) return 'INVESTIGATE';
    if (busy) return 'FOLLOW';
    // A noise: decided once per noise (not re-rolled every tick), close ones only unless
    // this bot chases distant gunfire.
    const sound = this.memory.sounds[this.memory.sounds.length - 1];
    if (sound && now - sound.time < 10 && sound.conf > 0.2) {
      if (this.noise.mark !== sound) {
        this.noise.mark = sound;
        this.noise.go = this.flat(sound.pos) < (this.persona.chasesShots ? 70 : 40) && Math.random() < this.persona.investigates;
      }
      if (this.noise.go) return 'INVESTIGATE';
    }
    return 'FOLLOW';
  }

  private flat(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.soldier.pos.x, p.z - this.soldier.pos.z);
  }

  /** When the current sighting began, and how long this bot holds its ground on it. */
  private trackSight(t: Contact, now: number): void {
    const sg = this.sight;
    if (t.visible) {
      if (!sg.on || sg.target !== t) {
        sg.on = true;
        sg.target = t;
        sg.start = now;
        const P = this.persona;
        sg.hold = P.holdGround * rand(P.holdGroundRange[0], P.holdGroundRange[1]);
      }
    } else if (now - t.lastSeenTime > 1.5) sg.on = false;
  }

  /**
   * Reload now? Never at 80%+; with only noises to go on under 70%; otherwise only when
   * the enemy is far enough, or out of sight long enough, for how full the mag still is.
   */
  private wantsReload(t: Contact, d: number, now: number): boolean {
    const s = this.soldier;
    if (s.reserve <= 0 || s.reloadTimer > 0 || s.magSize <= 0) return false;
    const mag = s.ammo / s.magSize;
    if (mag >= 0.8) return false;
    const unseen = now - t.lastSeenTime;
    if (t.visible || unseen < 2) return false;
    const never = t.lastSeenTime < -1e8 && now - t.lastHurtMe > 10 && now - t.lastShotNearMe > 10;
    if (never) return mag < 0.7;
    if (mag > 0.66) return d > 32 && unseen > 3;
    if (mag > 0.5) return (d > 16 && unseen > 4) || (d > 32 && unseen > 2);
    if (mag > 0.25) return d > 8 && (d <= 16 ? unseen > 2 : unseen > 1);
    return unseen > 2;
  }

  /** Once per loss of sight: seconds to hold the angle before searching. */
  private rollSearch(t: Contact, now: number): number {
    const r = this.lost;
    if (r.target !== t || r.lostAt !== t.lostAt) {
      r.target = t;
      r.lostAt = t.lostAt;
      r.after = rand(this.persona.searchAfter[0], this.persona.searchAfter[1]);
    }
    void now;
    return r.after;
  }

  /** Once per heard contact: go and look, or hold and wait for them. */
  private rollHeard(t: Contact): boolean {
    const r = this.heard;
    if (r.target !== t) {
      r.target = t;
      r.go = Math.random() < this.persona.investigates;
    }
    return r.go;
  }

  private enter(d: Decision, now: number): void {
    const prev = this.decision;
    this.decision = d;
    this.decisionAt = now;
    this.minUntil = now + MIN_HOLD[d];
    this.proposal = null;
    this.proposalN = 0;
    if (d !== 'FLANK') this.stat(d);
    if (prev === 'FLANK' && d !== 'FLANK') {
      this.squad?.flankDone(this, false);
      this.flank = null;
    }
    if (d !== 'SEARCH') this.search = null;
    if (d !== 'INVESTIGATE') this.investigate = null;
    this.peek.out = false;
    this.peek.next = now + (d === 'HOLD_COVER' ? rand(1.2, 2.2) : rand(0.4, 1.2));
    this.strafe.until = 0;
    this.strafe.legs = 0;
    const t = this.target;
    const s = this.soldier;
    switch (d) {
      case 'RUN_TO_COVER':
      case 'MOVE_TO_COVER':
        // Keep a cover already picked for this fight; otherwise a fresh search.
        if (this.cover && (this.inCover || this.cover.pos.distanceTo(s.pos) > 18)) this.cover = null;
        this.action = 'finding cover';
        break;
      case 'SHIFT_COVER':
        this.lastShift = now;
        if (this.cover) this.memory.markCover(this.cover.pos, now);
        this.cover = null;
        this.inCover = false;
        coverRegistry.release(this);
        this.action = 'shifting cover';
        break;
      case 'RETREAT':
        this.cover = null;
        this.inCover = false;
        coverRegistry.release(this);
        this.action = 'falling back';
        this.agent.say(pick(["I'm hit, falling back!", 'Falling back!', 'Moving to cover, back!']), true);
        break;
      case 'RUSH':
        this.rushUntil = now + rand(4, 7);
        this.rushSaw = false;
        this.action = 'rushing';
        this.agent.say(pick(['Pushing!', 'Moving up!', 'Go, go, go!', "He's reloading, push!"]), true);
        break;
      case 'FLANK':
        this.startFlank(now, prev);
        break;
      case 'SEARCH': {
        this.action = 'searching';
        if (t) {
          const extra = this.squad?.searchPointsFor(this, t) ?? planSearch(this.deps.nav, t.pos, t.vel, 3, (p) => this.memory.wasSearched(p, now));
          // The last known spot first, then the squad's share of the area around it.
          const pts = [t.pos.clone(), ...extra.filter((p) => p.distanceToSquared(t.pos) > 9)].slice(0, 4);
          this.search = { phase: 'wait', pts, i: 0, until: now + this.persona.searchWait * rand(0.6, 1.4), target: t, since: now };
          this.debug.searchPts = pts;
          if (Math.random() < 0.6) this.agent.say(pick(['Checking last known.', 'Lost him, searching.', 'Moving to last position.', 'Going to find him.']));
        }
        break;
      }
      case 'INVESTIGATE': {
        const sound = this.memory.sounds[this.memory.sounds.length - 1];
        const at = t && t.kind !== 'robot' && t.confidence > 0.2 ? t.pos : sound && now - sound.time < 12 ? sound.pos : now - this.allyFireAt < 6 ? this.allyFirePos : null;
        this.investigate = at ? { pos: at.clone(), arrived: -1, since: now } : null;
        this.debug.investigate = this.investigate?.pos ?? null;
        this.action = 'investigating';
        if (!this.investigate) this.done = true;
        break;
      }
      case 'SUPPRESS':
        this.suppressUntil = now + rand(3, 5);
        if (t) this.suppressPt.set(t.pos.x, 1.1, t.pos.z);
        s.react(0.2 + Math.random() * 0.2);
        this.action = 'suppressing';
        this.agent.say(pick(['Suppressing!', 'Covering fire!', 'Keep their heads down!']));
        this.progress('suppress');
        break;
      default:
        this.action = d === 'FOLLOW' ? 'calm' : d.toLowerCase().replace('_', ' ');
        if (d === 'FOLLOW') this.navigator.stop(); // the team logic moves us now
    }
  }

  private startFlank(now: number, prev: Decision): void {
    const t = this.target;
    const s = this.soldier;
    let plan: FlankPlan | null | 'pending' = null;
    if (t) {
      const anchor = this.squad?.anchorPos(this) ?? s.pos;
      // Phones: as heavy as a cover search, so it shares its one-per-frame slot.
      const budget = !this.deps.lowSpec || (aiWorld.takeRay() && aiWorld.takeCoverQuery());
      plan = budget ? planFlank(this.deps.nav, this.deps.physics, s.pos, t.pos, anchor, Math.random() < 0.5 ? 1 : -1, this.deps.lowSpec) : 'pending';
    }
    void prev;
    if (plan === 'pending') {
      // Out of AI budget this frame: try again shortly (a few times), else give up for a while.
      if (++this.flankPending > 4) {
        this.flankPending = 0;
        this.flankBanUntil = now + 10;
      }
      this.flank = null;
      this.done = true;
      this.action = 'planning flank';
      return;
    }
    this.flankPending = 0;
    this.flankIndex = 0;
    this.flank = plan;
    this.stat('FLANK');
    if (!plan) {
      this.flankBanUntil = now + 10;
      this.squad?.flankDone(this, false);
      this.stat('flankFailed');
      this.done = true;
      this.action = 'no flank route';
      return;
    }
    this.minUntil = now + 6;
    this.action = flankLabel(plan.side);
    this.squad?.flankStarted(this);
    this.agent.say(plan.side === 1 ? 'Flanking left!' : 'Flanking right!', true);
  }

  // ------------------------------------------------------------ cover bookkeeping

  private updateCover(t: Contact | null, now: number): void {
    const c = this.cover;
    if (!c) {
      this.inCover = false;
      return;
    }
    const s = this.soldier;
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    if (d > 6) {
      // Moved on: the spot is someone else's now.
      if (this.decision !== 'RUN_TO_COVER' && this.decision !== 'MOVE_TO_COVER' && this.decision !== 'SHIFT_COVER' && this.decision !== 'RETREAT' && this.decision !== 'RELOAD') {
        coverRegistry.release(this);
        this.cover = null;
        this.inCover = false;
      }
      return;
    }
    const was = this.inCover;
    const dp = c.peek ? Math.hypot(c.peek.x - s.pos.x, c.peek.z - s.pos.z) : Infinity;
    // Hysteresis: in at 1.3 m, out past 2.2 m (peeking out doesn't count as leaving).
    this.inCover = (was ? d < 2.2 : d < 1.3) || dp < 1;
    this.atPeek = dp < d;
    if (this.inCover && !was) {
      this.coverSince = now;
      this.memory.markCover(c.pos, now);
    }
    // The threat moved a lot: is this still cover from where they are now?
    if (this.inCover && t && t.kind !== 'robot' && c.threat.distanceToSquared(t.pos) > 36 && aiWorld.takeRay()) {
      if (!protectedFrom(this.deps.physics, c.pos, t.pos, c.low)) {
        this.inCover = false;
        this.cover = null;
        coverRegistry.release(this);
        this.interrupt = true;
      } else c.threat.copy(t.pos);
    }
  }

  private queryCover(mode: 'fight' | 'hide' | 'retreat', threat: THREE.Vector3, around?: THREE.Vector3): CoverSpot | null | 'pending' {
    if (!aiWorld.takeCoverQuery()) return 'pending';
    const s = this.soldier;
    const now = aiWorld.time;
    this.debug.covers.length = 0;
    const range = WEAPON_RANGE[s.weaponClass] ?? WEAPON_RANGE.rifle;
    const spot = findCover({
      nav: this.deps.nav,
      physics: this.deps.physics,
      from: s.pos,
      threat,
      mode,
      owner: this,
      now,
      maxDist: mode === 'retreat' ? 18 : 14,
      around,
      preferRange: range.ideal,
      exclude: this.memory.covers,
      avoid: (p) => this.memory.dangerAt(p, now) * 1.2 + (this.squad?.lanePenalty(this, p) ?? 0) + (this.navigator.failedNear(p, now) ? 2 : 0),
      debug: AI_TUNING.debug ? this.debug.covers : undefined,
      lowSpec: this.deps.lowSpec,
    });
    this.stat('coverQuery');
    if (spot) coverRegistry.reserve(this, spot.pos, now, 16);
    return spot;
  }

  /** One ray: can we put rounds into the area around the contact from here (or our peek spot)? */
  private canSeeArea(t: Contact): boolean {
    if (!aiWorld.takeRay()) return false;
    const from = this.inCover && this.cover?.peek ? this.cover.peek : this.soldier.pos;
    return canSee(this.deps.physics, from, t.pos, 1.5, 1.0);
  }

  // ------------------------------------------------------------ execution

  /** Run the current decision for this frame and drive the soldier. */
  drive(dt: number, mates: Soldier[]): void {
    const now = aiWorld.time;
    const s = this.soldier;
    this.face = null;
    this.fire = false;
    this.aimMode = 'ready';
    this.aimTgt.alive = false;
    this.navigator.update(dt, now);
    const t = this.target;
    // Standing unless a decision says otherwise; upright unless one leans.
    s.crouchTarget = 0;
    s.leanTarget = 0;
    switch (this.decision) {
      case 'SHOOT':
        this.doShoot(dt, now);
        break;
      case 'DOGFIGHT':
        this.doDogfight(dt, now);
        break;
      case 'RUSH':
        this.doRush(dt, now);
        break;
      case 'HOLD_COVER':
        this.doHoldCover(dt, now);
        break;
      case 'RUN_TO_COVER':
        this.doCoverMove(now, 'run');
        break;
      case 'MOVE_TO_COVER':
        this.doCoverMove(now, 'move');
        break;
      case 'SHIFT_COVER':
        this.doCoverMove(now, 'shift');
        break;
      case 'RETREAT':
        this.doCoverMove(now, 'retreat');
        break;
      case 'AMBUSH':
        this.doAmbush(dt, now);
        break;
      case 'SEARCH':
        this.doSearch(dt, now);
        break;
      case 'INVESTIGATE':
        this.doInvestigate(dt, now);
        break;
      case 'FLANK':
        this.doFlank(dt, now);
        break;
      case 'SUPPRESS':
        this.doSuppress(dt, now);
        break;
      case 'RELOAD':
        this.doReload(dt, now);
        break;
      case 'REGROUP':
        this.doRegroup(dt, now);
        break;
      case 'HELP':
        this.doHelp(dt, now);
        break;
      case 'ROBOT':
        this.doRobot(dt, now);
        break;
      default:
        break;
    }
    // Shoot what shows up while searching, flanking, helping (walk / jog: aim suffers).
    if (!this.fire && t?.visible && t.lineOfFire && SHOOTS_ON_MOVE.has(this.decision)) {
      if (Math.hypot(s.vel.x, s.vel.z) <= JOG * 1.05) this.aimAt(t, false);
    }
    // The aim settles while it stays on a target (and drifts off when it doesn't).
    if (this.aimTgt.alive && t?.visible && this.face) {
      if (this.aimedAt !== t.target) {
        this.aimedAt = t.target;
        s.visibleTime = Math.min(s.visibleTime, 0.5);
      }
      s.visibleTime = Math.min(8, s.visibleTime + dt);
    } else s.visibleTime = Math.max(0, s.visibleTime - dt * 1.5);
    // Firing at something we can see counts as doing something.
    if (this.fire && this.aimTgt.alive && t?.visible && now - this.lastFireProgress > 2.5) {
      this.lastFireProgress = now;
      this.progress('firing');
    }
    s.burstScale = 1 - 0.35 * this.skill01;
    s.update(dt, this.aimTgt, mates, this.face, this.aimMode, this.fire);
  }

  /** Aim at a visible contact (head on calm close shots when skilled; chads always). */
  private aimAt(c: Contact, allowHead: boolean): void {
    const s = this.soldier;
    const tg = c.target;
    const a = this.aimTgt;
    a.alive = true;
    a.feet.copy(tg.pos);
    a.chest.copy(tg.aim);
    a.head.copy(tg.head);
    // Lead: an estimate, never perfect.
    a.velocity.copy(c.vel).multiplyScalar(0.45 + 0.45 * this.skill01);
    const d = Math.hypot(tg.pos.x - s.pos.x, tg.pos.z - s.pos.z);
    const head = this.agent.chad ? d < 45 : allowHead && s.visibleTime > 1.2 && d < 24 && this.skill01 > 0.35 && Math.hypot(s.vel.x, s.vel.z) < 0.5;
    this.face = head ? a.head : a.chest;
    this.aimMode = 'aim';
    this.fire = c.lineOfFire;
  }

  /** Face a point (estimate) at chest height. */
  private look(p: THREE.Vector3, y = 1.3, mode: AimMode = 'ready'): void {
    this.face = this.faceBuf.set(p.x, y, p.z);
    this.aimMode = mode;
  }

  /** Carry the gun for movement (run: low/high port; walk: ready, facing ahead). */
  private carry(): void {
    const s = this.soldier;
    const v = Math.hypot(s.vel.x, s.vel.z);
    this.face = null;
    this.aimMode = v > 3 ? this.agent.carry : 'ready';
  }

  /** Shoot it if we can, else keep the gun on where it was. */
  private aimOrWatch(t: Contact, head = true): void {
    if (t.visible) this.aimAt(t, head);
    else this.look(t.pos, 1.3, 'aim');
  }

  // --- SHOOT: stand and shoot, strafing in legs.
  private doShoot(dt: number, now: number): void {
    const t = this.target;
    if (!t) {
      this.done = true;
      return;
    }
    const s = this.soldier;
    const d = this.flat(t.pos);
    this.aimOrWatch(t);
    this.action = 'shooting';
    this.strafeTick(now, t.pos, d);
    s.crouchTarget = this.persona.crouchesAtRange && d > 25 && this.strafe.dir === 0 ? 1 : 0;
    void dt;
  }

  /**
   * Stand and shoot, SAIN-style: on entry one long leg across their line of fire
   * (~4-5 m, walking and shooting), then stand still so the aim settles; now and then
   * another, shorter leg the other way. Chads add short A-D-A-D bursts up close.
   */
  private strafeTick(now: number, from: THREE.Vector3, d: number): void {
    const st = this.strafe;
    const P = this.persona;
    if (P.adad && now > this.adadNext) {
      this.adadUntil = now + rand(1.1, 1.8);
      this.adadNext = now + rand(4, 7);
    }
    const adad = P.adad && d < 25 && now < this.adadUntil;
    const moving = st.dir !== 0 && this.navigator.status === 'moving';
    if (now < st.until && (moving || st.dir === 0) && !adad) return;
    if (adad) {
      if (now < st.until) return;
      let dir = st.last === 0 ? (Math.random() < 0.5 ? -1 : 1) : -st.last;
      const len = rand(0.8, 1.2);
      let ok = this.sideStep(from, len, JOG, dir);
      if (!ok) {
        dir = -dir;
        ok = this.sideStep(from, len, JOG, dir);
      }
      st.dir = ok ? dir : 0;
      if (ok) st.last = dir;
      else this.navigator.stop();
      st.until = now + rand(0.3, 0.5);
      return;
    }
    if (st.dir !== 0) {
      // Leg done: stand and shoot for a while.
      st.dir = 0;
      this.navigator.stop();
      st.until = now + rand(2.5, 4.5) * (d > 30 ? 1.4 : 1);
      return;
    }
    if (d < 50 && (st.legs === 0 || Math.random() < 0.55)) {
      const len = st.legs === 0 ? rand(3.5, 5.5) : rand(2, 3.5);
      const speed = this.suppression > 0.5 || now - this.lastThreatAt < 2 ? JOG : WALK;
      let dir = st.last === 0 ? (Math.random() < 0.5 ? -1 : 1) : -st.last;
      let ok = this.sideStep(from, len, speed, dir);
      if (!ok) {
        dir = -dir;
        ok = this.sideStep(from, len, speed, dir);
      }
      st.legs++;
      if (ok) {
        st.dir = dir;
        st.last = dir;
        st.until = now + 4; // walk it out (the leg ends on arrival)
        return;
      }
    }
    st.dir = 0;
    this.navigator.stop();
    st.until = now + rand(2, 3.5);
  }

  // --- DOGFIGHT: close quarters, shoot while backing off and circling.
  private doDogfight(dt: number, now: number): void {
    const t = this.target;
    if (!t) {
      this.done = true;
      return;
    }
    const s = this.soldier;
    this.aimOrWatch(t);
    this.action = 'dogfight';
    s.crouchTarget = 0;
    const st = this.strafe;
    if (now >= st.until || this.navigator.status !== 'moving') {
      const d = this.flat(t.pos);
      const ax = s.pos.x - t.pos.x;
      const az = s.pos.z - t.pos.z;
      const al = Math.hypot(ax, az) || 1;
      // Back off while circling; the aggressive ones circle and hold their ground.
      const back = this.persona.rushes && d > 3.5 ? 0.2 : 1.4;
      // Mostly keep circling the same way (a switch now and then, not every step).
      let dir = st.last === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.random() < 0.3 ? -st.last : st.last;
      let ok = false;
      for (let k = 0; k < 2 && !ok; k++, dir = -dir) {
        const x = s.pos.x + (ax / al) * back + (-az / al) * dir * 1.6;
        const z = s.pos.z + (az / al) * back + (ax / al) * dir * 1.6;
        if (this.deps.nav.walkable(x, z) && this.deps.nav.clearLine(s.pos.x, s.pos.z, x, z)) {
          this.navigator.go(this.tmp2.set(x, 0, z), this.persona.adad ? JOG : WALK * 1.3, 0.3);
          st.last = dir;
          ok = true;
        }
      }
      if (!ok) this.navigator.stop();
      st.until = now + rand(0.9, 1.5);
    }
    if (this.persona.adad) this.agent.tryHop();
    void dt;
  }

  // --- RUSH: charge their position, shooting when they show.
  private doRush(dt: number, now: number): void {
    const t = this.target;
    if (!t) {
      this.done = true;
      return;
    }
    const d = this.flat(t.pos);
    this.navigator.go(t.pos, t.visible ? JOG : this.persona.sprints ? SPRINT : RUN, 2.5);
    this.action = 'rushing';
    if (t.visible && !this.rushSaw) {
      this.rushSaw = true;
      if (Math.random() < this.persona.hops) this.agent.tryHop();
    }
    if (t.visible) this.aimAt(t, false);
    else if (d < 14) this.look(t.pos, 1.3, 'aim');
    else this.carry();
    if (d < 4 || now > this.rushUntil || this.navigator.status === 'failed' || this.navigator.status === 'arrived') {
      this.rushCooldown = now + rand(5, 9);
      this.rushUntil = 0;
      this.done = true;
    }
    void dt;
  }

  // --- HOLD_COVER: fight from cover on a rhythm (hidden → peek / lean → back).
  private doHoldCover(dt: number, now: number): void {
    const t = this.target;
    const c = this.cover;
    const s = this.soldier;
    if (!t || !c) {
      this.done = true;
      return;
    }
    const P = this.persona;
    const pk = this.peek;
    const dc = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    this.action = c.low ? 'holding low cover' : 'holding cover';
    // They're in sight from where we are: shoot (low cover: stand up for it).
    if (t.visible && t.lineOfFire) {
      this.aimAt(t, true);
      if (!pk.out && dc > 0.9) this.navigator.go(c.pos, WALK, 0.5);
      else if (!pk.out) this.navigator.stop();
      if (c.low) {
        const up = this.lowCoverCycle(dt, now);
        s.crouchTarget = up ? 0 : 1;
        if (!up) this.fire = false;
      }
      if (pk.out) {
        s.leanTarget = pk.lean * 0.9;
        // Exposed and on them: keep at it while they're in sight (a few seconds at most).
        if (now > pk.until + 3) this.endPeek(now, c);
      }
      return;
    }
    if (!pk.out) {
      // Hidden: on the spot, gun on where they were.
      if (dc > 0.9) this.navigator.go(c.pos, JOG, 0.5);
      else this.navigator.stop();
      s.crouchTarget = c.low ? 1 : 0;
      this.look(t.pos, 1.3, 'aim');
      const pinned = this.suppression > 0.6; // no peeking into heavy fire
      if (now >= pk.next && !pinned) {
        // Peek: low cover stands up; full cover leans round its edge (Q / E), stepping
        // to the peek spot when the lean alone doesn't clear it.
        pk.out = true;
        pk.until = now + rand(0.5, 2) * P.exposure * (1.15 - 0.3 * this.skill01);
        const lean = this.leanProbe(t.pos, now);
        pk.lean = c.low ? 0 : lean !== 0 ? lean : this.peekSide(c);
        pk.move = !c.low && lean === 0 && !!c.peek;
        this.stat('peek');
      }
      return;
    }
    // Out: looking for them.
    if (c.low) s.crouchTarget = 0;
    else {
      s.leanTarget = pk.lean * 0.9;
      if (pk.move && c.peek) this.navigator.go(c.peek, WALK * 1.4, 0.35);
      else this.navigator.stop();
    }
    this.look(t.pos, 1.3, 'aim');
    // Back in once the peek's done and they haven't shown for a moment.
    if (now > pk.until && now - t.lastSeenTime > 0.66) this.endPeek(now, c);
  }

  private endPeek(now: number, c: CoverSpot): void {
    const pk = this.peek;
    pk.out = false;
    pk.lean = 0;
    pk.next = now + rand(this.persona.peekEvery[0], this.persona.peekEvery[1]) * (1.2 - 0.4 * this.skill01) * (this.suppression > 0.6 ? 1.6 : 1);
    if (pk.move && !c.low) this.navigator.go(c.pos, JOG, 0.5);
    pk.move = false;
  }

  /** Low cover: up to shoot, down now and then (reloads, heavy fire). */
  private lowCoverCycle(dt: number, now: number): boolean {
    this.crouchCycle -= dt;
    if (this.crouchCycle <= 0) {
      this.standUp = !this.standUp;
      this.crouchCycle = this.standUp ? rand(1.2, 1.2 + 1.4 * this.persona.exposure) : rand(0.5, 1.1);
    }
    void now;
    return this.standUp && this.soldier.reloadTimer <= 0 && this.suppression < 1;
  }

  /**
   * Lean check (Q / E): can't see `p` from here, but could with the head out to one
   * side? Two rays, cached for half a second. 0 = straight view (or no lean helps).
   */
  private leanProbe(p: THREE.Vector3, now: number): number {
    if (now < this.leanCheckAt) return this.leanSide;
    this.leanCheckAt = now + 0.45 + Math.random() * 0.3;
    const s = this.soldier;
    const dx = p.x - s.pos.x;
    const dz = p.z - s.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    if (l > 45 || !aiWorld.takeRay()) return this.leanSide;
    if (canSee(this.deps.physics, s.pos, p, 1.55, 1.2)) return (this.leanSide = 0);
    const rx = -dz / l;
    const rz = dx / l;
    const first = this.leanSide || (Math.random() < 0.5 ? -1 : 1);
    for (const side of [first, -first]) {
      if (!aiWorld.takeRay()) break;
      this.tmp.set(s.pos.x + rx * side * 0.4, 0, s.pos.z + rz * side * 0.4);
      if (canSee(this.deps.physics, this.tmp, p, 1.5, 1.2)) return (this.leanSide = side);
    }
    return (this.leanSide = 0);
  }

  /** Which way the open side of a full cover is (lean that way): -1 left, 1 right, 0 none. */
  private peekSide(c: CoverSpot): number {
    if (!c.peek) return 0;
    const fx = c.threat.x - c.pos.x;
    const fz = c.threat.z - c.pos.z;
    const l = Math.hypot(fx, fz) || 1;
    // Right of a body facing the threat.
    return Math.sign((c.peek.x - c.pos.x) * (-fz / l) + (c.peek.z - c.pos.z) * (fx / l));
  }

  // --- RUN / MOVE / SHIFT to cover, RETREAT.
  private doCoverMove(now: number, mode: 'run' | 'move' | 'shift' | 'retreat'): void {
    const s = this.soldier;
    const t = this.target;
    if (!t) {
      this.done = true;
      return;
    }
    if (!this.cover) {
      if (now < this.coverRetryAt) {
        // Nothing found a moment ago.
        if (mode === 'retreat') {
          if (!this.navigator.hasDest) this.stepAway(t.pos, 8, RUN);
          this.action = 'backing off';
          this.carry();
        } else this.done = true;
        return;
      }
      // Shifting: aggressive bots look for the next cover between them and the enemy.
      const around = mode === 'shift' && (this.persona.rushes || now < this.pushOnUntil) ? this.tmp.copy(s.pos).lerp(t.pos, 0.35) : undefined;
      const res = this.queryCover(mode === 'retreat' ? 'retreat' : 'fight', t.pos, around);
      if (res === 'pending') {
        // Waiting a frame for the cover search: keep fighting meanwhile.
        this.aimOrWatch(t, false);
        return;
      }
      if (!res) {
        this.noCoverUntil = now + 4;
        this.coverRetryAt = now + 2.5;
        this.stat('noCover');
        if (mode === 'retreat') {
          this.stepAway(t.pos, 8, RUN);
          this.action = 'backing off';
          this.retreatedAt = now;
        } else this.done = true;
        return;
      }
      this.cover = res;
      this.action = mode === 'retreat' ? 'running back to cover' : mode === 'run' ? 'running to cover' : 'moving to cover';
    }
    const c = this.cover;
    const fast = mode === 'run' || mode === 'retreat' || (mode !== 'move' && !t.visible);
    const speed = fast ? (this.persona.sprints && !t.visible ? SPRINT : RUN) : t.visible ? WALK * 1.3 : JOG * this.profile.pace;
    this.navigator.go(c.pos, speed, 0.7);
    if (this.navigator.status === 'failed') {
      this.cover = null;
      coverRegistry.release(this);
      this.noCoverUntil = now + 3;
      this.done = true;
      return;
    }
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    if (d < 1.0) {
      // Arrived (counted once per cover): the next rule picks HOLD_COVER from here.
      if (this.arrivedCover !== c) {
        this.arrivedCover = c;
        if (mode === 'retreat') this.retreatedAt = now;
        this.inCover = true;
        this.coverSince = now;
        this.memory.markCover(c.pos, now);
        this.progress(mode === 'retreat' ? 'fell back' : 'reached cover');
        this.stat('coverReached');
      }
      this.navigator.stop();
      this.done = true;
      s.crouchTarget = c.low ? 1 : 0;
      this.look(t.pos, 1.3, 'aim');
      return;
    }
    s.crouchTarget = 0;
    if (!fast && t.visible) this.aimAt(t, false);
    else if (!fast) this.look(t.pos, 1.3, 'ready');
    else this.carry();
  }

  // --- AMBUSH: lost them; hold the angle on the last known spot.
  private doAmbush(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!t) {
      this.done = true;
      return;
    }
    this.navigator.stop();
    this.action = 'holding the angle';
    // Small sweeps around where they should be.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(0.8, 2);
      this.lookAngle = (Math.random() - 0.5) * 0.35;
    }
    const dx = t.pos.x - s.pos.x;
    const dz = t.pos.z - s.pos.z;
    const a = Math.atan2(dx, dz) + this.lookAngle;
    const r = Math.hypot(dx, dz);
    this.tmp.set(s.pos.x + Math.sin(a) * r, 0, s.pos.z + Math.cos(a) * r);
    this.look(this.tmp, 1.3, t.confidence > 0.4 ? 'aim' : 'ready');
    // At a corner: lean out to watch it (Q / E).
    s.leanTarget = this.leanProbe(t.pos, now) * 0.9;
    s.crouchTarget = this.persona.crouchesAtRange && r > 12 && s.leanTarget === 0 ? 1 : 0;
  }

  // --- SEARCH: wait and listen, approach the last known spot, peek corners, sweep.
  private doSearch(dt: number, now: number): void {
    const s = this.soldier;
    const sr = this.search;
    if (!sr || !sr.pts.length) {
      if (this.target) this.target.searched = true;
      this.done = true;
      return;
    }
    const tgt = sr.target;
    const p = sr.pts[Math.min(sr.i, sr.pts.length - 1)];
    const dist = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
    switch (sr.phase) {
      case 'wait':
        this.navigator.stop();
        this.action = 'listening';
        this.look(p, 1.3, 'aim');
        s.leanTarget = this.leanProbe(p, now) * 0.9;
        if (now > sr.until) sr.phase = 'move';
        return;
      case 'corner':
        // Peeking a corner on the way in.
        this.navigator.stop();
        this.action = 'peeking corner';
        s.leanTarget = this.leanSide * 0.9;
        this.look(p, 1.3, 'aim');
        if (now > sr.until) {
          sr.phase = 'move';
          sr.until = now + 1.2; // don't stop at the same corner again right away
        }
        return;
      case 'look':
        this.navigator.stop();
        this.action = `checking ${sr.i + 1}/${sr.pts.length}`;
        this.lookTimer -= dt;
        if (this.lookTimer <= 0) {
          this.lookTimer = rand(0.5, 1.1);
          this.lookAngle = s.yaw + (Math.random() - 0.5) * 2.6;
        }
        this.tmp.set(s.pos.x + Math.sin(this.lookAngle) * 8, 0, s.pos.z + Math.cos(this.lookAngle) * 8);
        this.look(this.tmp, 1.3, 'aim');
        if (now > sr.until) {
          this.memory.markSearched(p, now);
          sr.i++;
          this.progress('search advanced');
          if (sr.i >= sr.pts.length) {
            // Nothing: the trail is cold.
            if (tgt) {
              tgt.searched = true;
              tgt.confidence *= 0.4;
            }
            this.stat('searchDone');
            this.search = null;
            this.done = true;
            return;
          }
          sr.phase = 'move';
        }
        return;
      default:
        break;
    }
    // Moving: sprint legs by roll while far, then the gun up and a walk (sneaky ones
    // crouch-walk the last stretch).
    const P = this.persona;
    const close = dist < 14;
    if (now > this.searchSprint.at) {
      this.searchSprint.at = now + 4 * rand(0.5, 1.5);
      this.searchSprint.on = Math.random() < P.searchSprint;
    }
    const pace = this.searchSprint.on ? (P.sprints ? SPRINT : RUN) : P.sneaky ? WALK * 1.3 : JOG;
    this.navigator.go(p, close ? (P.sneaky ? WALK : WALK * 1.25) : pace, 1.2);
    this.action = `search → ${sr.i + 1}/${sr.pts.length}`;
    if (close) {
      this.look(p, 1.3, 'aim');
      if (P.sneaky && dist < 12) s.crouchTarget = 0.6;
      // A corner between us and the spot: stop at it and lean round.
      if (now > sr.until) {
        const side = this.leanProbe(p, now);
        if (side !== 0) {
          sr.phase = 'corner';
          sr.until = now + rand(0.7, 1.3);
          this.stat('cornerPeek');
          return;
        }
      }
    } else this.carry();
    if (this.navigator.status === 'arrived' || this.navigator.status === 'failed' || dist < 1.4) {
      sr.phase = 'look';
      sr.until = now + rand(1, 2.2) * (P.sneaky ? 1.4 : 1);
    }
  }

  // --- INVESTIGATE: go and see what that was.
  private doInvestigate(dt: number, now: number): void {
    const s = this.soldier;
    const iv = this.investigate;
    if (!iv) {
      this.done = true;
      return;
    }
    const d = Math.hypot(iv.pos.x - s.pos.x, iv.pos.z - s.pos.z);
    if (iv.arrived < 0) {
      const P = this.persona;
      this.navigator.go(iv.pos, d < 12 ? WALK * 1.3 : P.sneaky ? JOG : RUN, 3.5);
      this.action = 'investigating';
      if (d < 16) {
        this.look(iv.pos, 1.3, d < 10 ? 'aim' : 'ready');
        s.leanTarget = this.leanProbe(iv.pos, now) * 0.6;
      } else this.carry();
      if (this.navigator.status === 'arrived' || this.navigator.status === 'failed' || d < 3.6) {
        iv.arrived = now;
        this.navigator.stop();
        this.progress('investigated');
      }
      if (now - iv.since > 30) this.done = true;
      return;
    }
    // There: look around it for a moment.
    this.action = 'looking around';
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(0.5, 1.1);
      this.lookAngle = Math.atan2(iv.pos.x - s.pos.x, iv.pos.z - s.pos.z) + (Math.random() - 0.5) * 2.2;
    }
    this.tmp.set(s.pos.x + Math.sin(this.lookAngle) * 8, 0, s.pos.z + Math.cos(this.lookAngle) * 8);
    this.look(this.tmp, 1.3, 'aim');
    if (now - iv.arrived > 2.4) {
      this.memory.markSearched(iv.pos, now);
      const snd = this.memory.sounds;
      for (let i = snd.length - 1; i >= 0; i--) if (snd[i].pos.distanceToSquared(iv.pos) < 64) snd.splice(i, 1);
      if (this.target && this.target.lastSeenTime < -1e8) {
        this.target.confidence *= 0.5;
        this.target.searched = true;
      }
      this.allyFireAt = -1e9;
      this.investigate = null;
      this.stat('investigated');
      this.done = true;
    }
  }

  // --- SUPPRESS: walk the fire around the last known spot.
  private doSuppress(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!t || now > this.suppressUntil || (s.ammo <= 0 && s.reserve <= 0)) {
      this.done = true;
      return;
    }
    if (t.visible) {
      this.aimAt(t, false);
      this.action = 'suppressing (visible)';
      return;
    }
    // From cover with a side peek: step out to put rounds downrange.
    const c = this.cover;
    if (this.inCover && c?.peek && !c.low) {
      this.navigator.go(c.peek, WALK * 1.4, 0.35);
      s.leanTarget = this.peekSide(c) * 0.9;
    } else this.navigator.stop();
    this.suppressPt.x += (t.pos.x - this.suppressPt.x) * Math.min(1, dt * 0.8) + (Math.random() - 0.5) * dt * 3;
    this.suppressPt.z += (t.pos.z - this.suppressPt.z) * Math.min(1, dt * 0.8) + (Math.random() - 0.5) * dt * 3;
    const a = this.aimTgt;
    a.alive = true;
    a.feet.set(this.suppressPt.x, 0, this.suppressPt.z);
    a.chest.set(this.suppressPt.x, 1.1, this.suppressPt.z);
    a.head.set(this.suppressPt.x, 1.5, this.suppressPt.z);
    a.velocity.set(0, 0, 0);
    this.face = a.chest;
    this.aimMode = 'aim';
    this.fire = s.ammo > 0;
    if (s.ammo <= 0) s.startReload();
    this.lastFireProgress = now;
    this.action = 'suppressing';
  }

  // --- FLANK: walk the planned route round the side.
  private doFlank(dt: number, now: number): void {
    const s = this.soldier;
    const f = this.flank;
    const t = this.target;
    if (!f || !t) {
      this.done = true;
      return;
    }
    const wp = f.route[Math.min(this.flankIndex, f.route.length - 1)];
    const far = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) > 25;
    this.navigator.go(wp, far && !t.visible ? (this.persona.sprints ? SPRINT : RUN) : JOG * this.profile.pace, this.flankIndex >= f.route.length - 1 ? 0.8 : 1.2);
    if (this.navigator.status === 'arrived') {
      this.flankIndex++;
      this.progress('flank leg');
      if (this.flankIndex >= f.route.length) {
        this.stat('flankDone');
        this.squad?.flankDone(this, true);
        this.flank = null;
        this.action = 'flank position';
        this.look(t.pos, 1.3, 'aim');
        this.done = true;
        return;
      }
    } else if (this.navigator.status === 'failed') {
      this.flankBanUntil = now + 10;
      this.squad?.flankDone(this, false);
      this.flank = null;
      this.stat('flankFailed');
      this.done = true;
      return;
    }
    s.crouchTarget = 0;
    this.action = flankLabel(f.side);
    if (t.visible && !far) this.aimAt(t, false);
    else this.carry();
    void dt;
  }

  // --- RELOAD: behind something first if exposed.
  private doReload(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!this.inCover && t && (t.visible || now - this.lastThreatAt < 2) && now > this.noCoverUntil && now > this.coverRetryAt && !this.cover) {
      const res = this.queryCover('hide', t.pos);
      if (res && res !== 'pending' && res.pos.distanceTo(s.pos) < 7) this.cover = res;
      else if (res !== 'pending') {
        this.noCoverUntil = now + 3;
        this.coverRetryAt = now + 3;
      }
    }
    if (this.cover && !this.inCover && this.cover.pos.distanceTo(s.pos) < 8) {
      this.navigator.go(this.cover.pos, RUN, 0.7);
      if (Math.hypot(this.cover.pos.x - s.pos.x, this.cover.pos.z - s.pos.z) < 1) this.inCover = true;
      if (s.ammo === 0) s.startReload(); // reload on the run when dry
    } else {
      this.navigator.stop();
      if (s.reloadTimer <= 0 && !s.startReload()) {
        this.done = true;
        return;
      }
      if (Math.random() < 0.01) this.agent.say(pick(['Reloading!', 'Changing mags!', 'Cover me, reloading!']));
    }
    s.crouchTarget = this.inCover && this.cover?.low ? 1 : t?.visible ? 1 : 0;
    if (t) this.look(t.pos);
    if (s.reloadTimer <= 0 && s.ammo >= s.magSize * 0.9) {
      this.progress('reloaded');
      this.done = true;
    }
    void dt;
  }

  // --- REGROUP: back to the squad.
  private doRegroup(dt: number, now: number): void {
    const p = this.squad?.regroupPoint(this);
    if (!p) {
      this.done = true;
      return;
    }
    const s = this.soldier;
    const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
    this.navigator.go(p, d > 20 ? SPRINT : d > 12 ? RUN : JOG, 2.5);
    this.carry();
    if (this.navigator.status === 'arrived' || d < 3) {
      this.progress('regrouped');
      this.done = true;
    } else if (this.navigator.status === 'failed') this.done = true;
    s.crouchTarget = 0;
    void dt;
    void now;
  }

  // --- HELP: a squadmate (or the player) is in a fight: get into it, from cover.
  private doHelp(dt: number, now: number): void {
    const s = this.soldier;
    const help = this.squad?.helpFor(this);
    if (!help) {
      this.done = true;
      return;
    }
    if ((!this.cover || this.cover.threat.distanceToSquared(help.threat) > 64) && now > this.coverRetryAt) {
      const res = this.queryCover('fight', help.threat, help.pos);
      if (res === null) this.coverRetryAt = now + 2.5;
      if (res === 'pending' || !res) {
        this.navigator.go(help.pos, RUN, 4);
        this.look(help.threat);
        if (!res && Math.hypot(help.pos.x - s.pos.x, help.pos.z - s.pos.z) < 5) {
          this.memory.addSound(help.threat, 0.5, 'assist', now);
          this.done = true;
        }
        return;
      }
      this.cover = res;
    }
    const c = this.cover;
    if (!c) {
      this.navigator.go(help.pos, RUN, 4);
      this.carry();
      return;
    }
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    this.navigator.go(c.pos, d > 10 ? (this.persona.sprints ? SPRINT : RUN) : JOG, 0.8);
    this.action = help.player ? 'covering you' : 'moving to help';
    if (d < 6) this.look(help.threat, 1.3, 'aim');
    else this.carry();
    if (d < 1.1) {
      this.inCover = true;
      this.coverSince = now;
      this.progress('assist position');
      // Whatever they were fighting is now our business too.
      this.memory.addSound(help.threat, 0.5, 'assist', now);
      this.done = true;
    }
    if (this.navigator.status === 'failed') {
      this.cover = null;
      this.done = true;
    }
    void dt;
  }

  // --- ROBOT: shoot it, keeping the gap (they only hurt up close).
  private doRobot(dt: number, now: number): void {
    const t = this.target;
    const s = this.soldier;
    if (!t) {
      this.done = true;
      return;
    }
    const d = this.flat(t.pos);
    this.aimOrWatch(t);
    const kite = 4.2 + (1.4 - this.profile.push) * 2;
    if (d < kite) {
      this.action = 'kiting';
      this.kiteTimer -= dt;
      if (this.kiteTimer <= 0) {
        this.kiteTimer = 0.4;
        this.stepAway(t.pos, 3.5, this.agent.hp < 0.35 ? RUN : JOG);
      }
    } else {
      this.action = 'shooting robot';
      this.navigator.stop();
    }
    s.crouchTarget = 0;
    void now;
  }

  // ------------------------------------------------------------ movement helpers

  /** Step `dist` m away from `from` (straight back first, then angled escapes). */
  private stepAway(from: THREE.Vector3, dist: number, speed: number): void {
    const s = this.soldier;
    const ax = s.pos.x - from.x;
    const az = s.pos.z - from.z;
    const al = Math.hypot(ax, az) || 1;
    for (const ang of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const dx = (ax / al) * c - (az / al) * sn;
      const dz = (ax / al) * sn + (az / al) * c;
      const x = s.pos.x + dx * dist;
      const z = s.pos.z + dz * dist;
      if (this.deps.nav.walkable(x, z) && this.deps.nav.clearLine(s.pos.x, s.pos.z, x, z)) {
        this.navigator.go(this.tmp2.set(x, 0, z), speed, 0.6);
        return;
      }
    }
  }

  /** Side-step across the line to `from` (spoils their aim). */
  private sideStep(from: THREE.Vector3, dist: number, speed: number, side = Math.random() < 0.5 ? -1 : 1): boolean {
    const s = this.soldier;
    const dx = from.x - s.pos.x;
    const dz = from.z - s.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const x = s.pos.x + (-dz / l) * side * dist;
    const z = s.pos.z + (dx / l) * side * dist;
    if (!this.deps.nav.walkable(x, z) || !this.deps.nav.clearLine(s.pos.x, s.pos.z, x, z)) return false;
    this.navigator.go(this.tmp2.set(x, 0, z), speed, 0.4);
    return true;
  }

  /** Debug label text. */
  label(): string {
    const now = aiWorld.time;
    const t = this.target;
    const dec = this.decision === 'FLANK' && this.flank ? flankLabel(this.flank.side) : this.decision;
    const tgt = t ? `${t.target.kind}${t.visible ? ' (vis)' : ''} ${Math.round(t.confidence * 100)}%` : '—';
    const cover = this.inCover ? (this.cover?.low ? 'low cover' : 'cover') : this.cover ? '→ cover' : 'open';
    const lines = [
      `${this.name} [${this.team}] ${this.persona.id} · ${this.role}${this.squad ? ` · ${this.squad.plan}` : ''}`,
      `${dec} ${(now - this.decisionAt).toFixed(1)}s · ${this.action}`,
      `tgt ${tgt} · ${cover} · supp ${this.suppression.toFixed(2)}`,
      `move ${this.sinceMove.toFixed(1)}s · prog ${this.sinceProgress.toFixed(1)}s (${this.lastProgress})`,
    ];
    if (this.watchdogFlash > 0) lines.push('PASSIVE WATCHDOG TRIGGERED');
    return lines.join('\n');
  }
}
