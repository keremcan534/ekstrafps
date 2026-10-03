import * as THREE from 'three';
import { JOG, RUN, SPRINT, WALK, type AimMode, type PlayerTarget, type Soldier, type SoldierDeps } from '../enemies/Soldier';
import type { Combatant, Personality, TeamAgent } from '../game/TeamAgent';
import type { DamageInfo } from '../targets/Humanoid';
import { canSee, coverRegistry, findCover, protectedFrom, type CoverSpot } from './Cover';
import { BotMemory, type Contact } from './Memory';
import { Navigator } from './Navigator';
import { BotPerception } from './Perception';
import type { SquadBrain, SquadRole } from './Squad';
import { flankLabel, planFlank, planSearch, type FlankPlan } from './Tactics';
import { AI_TUNING, PROFILES, WEAPON_RANGE, type Profile, type ProfileId } from './Tuning';
import { aiWorld, type AIListener } from './World';

/** Tactical decisions (utility-scored). FOLLOW = calm: the team/economy logic drives. */
export type Decision =
  | 'ENGAGE' | 'SEEK_COVER' | 'HOLD_ANGLE' | 'PEEK' | 'SUPPRESS' | 'FLANK' | 'PUSH' | 'RETREAT'
  | 'REPOSITION' | 'SEARCH' | 'INVESTIGATE' | 'RELOAD' | 'REGROUP' | 'ASSIST' | 'FOLLOW';

export const DECISIONS: readonly Decision[] = [
  'ENGAGE', 'SEEK_COVER', 'HOLD_ANGLE', 'PEEK', 'SUPPRESS', 'FLANK', 'PUSH', 'RETREAT',
  'REPOSITION', 'SEARCH', 'INVESTIGATE', 'RELOAD', 'REGROUP', 'ASSIST', 'FOLLOW',
];

/** Decisions that change the bot's position (the watchdog pushes toward these). */
const MOVES: readonly Decision[] = ['REPOSITION', 'PEEK', 'FLANK', 'SEARCH', 'PUSH', 'INVESTIGATE', 'ASSIST', 'REGROUP'];

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

/**
 * One bot's tactical mind, layered:
 *   perception (senses) → memory (beliefs) → decision brain (utility) →
 *   tactical movement (navigator, cover, flank, search) → combat execution (Soldier).
 * The squad brain sits above and shares contacts, roles and a plan.
 *
 * Bots never read an enemy's live position unless they currently see it: they
 * act on what they saw, heard, felt or were told, and that belief fades.
 */
export class Bot implements AIListener {
  readonly memory = new BotMemory();
  readonly senses: BotPerception;
  readonly navigator: Navigator;
  profile: Profile;
  squad: SquadBrain | null = null;
  role: SquadRole = 'none';
  decision: Decision = 'FOLLOW';
  /** Step inside the decision (debug). */
  action = 'calm';
  /** Last utility scores (debug). */
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
  /** Debug drawing data. */
  readonly debug = { covers: [] as { pos: THREE.Vector3; ok: boolean }[], searchPts: [] as THREE.Vector3[], investigate: null as THREE.Vector3 | null };
  /** Stats for tests. */
  readonly stats: Record<string, number> = {};

  private decisionAt = -1e9;
  private commitUntil = 0;
  private evalTimer = Math.random() * 0.2;
  private interrupt = false;
  private wasInterrupt = false;
  private peek = { phase: 'none' as 'none' | 'out' | 'back', until: 0, next: 0, at: new THREE.Vector3() };
  private suppressUntil = 0;
  private readonly suppressPt = new THREE.Vector3();
  private flankIndex = 0;
  private flankBanUntil = 0;
  /** Flank plans put off for lack of AI budget in a row (and when the last was). */
  private flankPending = 0;
  private flankPendingAt = -1e9;
  /** A watchdog re-plan of a running flank was put off: re-enter FLANK at the next evaluation. */
  private flankRetry = false;
  private search: { pts: THREE.Vector3[]; i: number; pauseUntil: number; target: Contact | null; since: number } | null = null;
  private investigate: { pos: THREE.Vector3; arrived: number; since: number } | null = null;
  private noCoverUntil = 0;
  /** After a cover search found nothing, don't search again right away. */
  private coverRetryAt = 0;
  /** The cover whose arrival was already counted. */
  private arrivedCover: CoverSpot | null = null;
  /** When a fall-back position was last reached. */
  private retreatedAt = -1e9;
  private lastReposition = -1e9;
  private strafeTimer = 0;
  /** Fighting from full cover on one knee (a few shots at a time). */
  private kneel = false;
  private crouchCycle = 0;
  private standUp = true;
  private kiteTimer = 0;
  private lookTimer = 0;
  private lookAngle = 0;
  /** Seconds spent holding angles lately (fades slowly): holding gets old, it doesn't reset by switching. */
  private holdFatigue = 0;
  private lastHurt = -1e9;
  private lastThreatAt = -1e9;
  private allyFireAt = -1e9;
  private readonly allyFirePos = new THREE.Vector3();
  private lastShare = new WeakMap<Combatant, number>();
  private lastFireProgress = -1e9;
  private adadT = 0;
  private adadSide = 1;
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
  /**
   * How urgent the squad's objective is (0..1): its team has somewhere to be (a supply
   * drop, a hunt, a rush). Weighs FOLLOW (which carries out the team's order) against
   * distractions: far robots and unidentified noises.
   */
  objective = 0;
  /** Where the bot last made ground (progress = 3 m moved, not a decision entered). */
  private progressAt = new THREE.Vector3(1e9, 0, 1e9);

  get hasThreat(): boolean {
    const t = this.target;
    if (!t || t.confidence < 0.12) return false;
    return t.kind !== 'robot' || Math.hypot(t.pos.x - this.soldier.pos.x, t.pos.z - this.soldier.pos.z) < 16;
  }

  /** Currently shooting at this (visible) enemy — the team brain's "target". */
  get engaged(): Combatant | null {
    return this.target?.visible ? this.target.target : null;
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
    this.navigator.stop();
    coverRegistry.release(this);
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
    s.settle(expected ? 0.7 : this.agent.chad ? 1.4 : 0);
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
    const s = this.soldier;
    if (Math.hypot(s.vel.x, s.vel.z) > 0.35) this.sinceMove = 0;
    else this.sinceMove += dt;
    this.sinceProgress += dt;
    // Ground made counts as progress; choosing a decision or peeking again doesn't.
    if (s.pos.distanceToSquared(this.progressAt) > 9) {
      this.progressAt.copy(s.pos);
      this.sinceProgress = 0;
    }
    // Anti-passivity: a bot with something to deal with that hasn't done anything
    // meaningful for a while gets shaken out of its decision.
    let watchdog = false;
    const task = this.hasTask;
    if (task && this.sinceProgress > AI_TUNING.passivityTimeout * this.profile.patience) {
      watchdog = true;
      this.watchdogFlash = 2.4;
      this.watchdogCount++;
      this.stat('watchdog');
      this.sinceProgress = 0;
    }
    if (!task && this.decision === 'FOLLOW' && this.sinceProgress > 5) this.sinceProgress = 0;
    if (this.interrupt || watchdog || this.evalTimer <= 0) {
      this.wasInterrupt = this.interrupt;
      this.interrupt = false;
      this.evalTimer = AI_TUNING.decisionInterval * (0.8 + Math.random() * 0.4);
      this.evaluate(watchdog, now);
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

  private evaluate(watchdog: boolean, now: number): void {
    const s = this.soldier;
    const P = this.profile;
    const T = AI_TUNING;
    const t = (this.target = this.memory.primary(s.pos, now, this.target));
    this.updateCover(t, now);
    const hp = this.agent.hp;
    const mag = s.magSize > 0 ? s.ammo / s.magSize : 1;
    const reserveOk = s.reserve > 0;
    const reloading = s.reloadTimer > 0;
    const supp = this.suppression;
    const suppressed = supp > T.suppressedLevel;
    const robot = t?.kind === 'robot';
    const conf = t?.confidence ?? 0;
    const dist = t ? Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) : Infinity;
    const vis = !!t?.visible;
    const range = WEAPON_RANGE[s.weaponClass] ?? WEAPON_RANGE.rifle;
    const inRange = dist <= range.max;
    const threat = this.hasThreat;
    const soldierThreat = threat && !robot;
    const seenAgo = t ? now - t.lastSeenTime : 1e9;
    const infoAge = t ? t.age(now) : 1e9;
    const inCover = this.inCover;
    const coverAge = now - this.coverSince;
    const sq = this.squad;
    const friendly = !!sq?.friendly;
    const allies = sq ? sq.aliveNear(this, 35) : 0;
    const enemies = Math.max(soldierThreat ? 1 : 0, this.memory.countKnown(0.3, now));
    const outnumbered = enemies >= allies + 2;
    const advantage = Math.max(-1, Math.min(1, (allies + 1 - enemies) / 3));
    const role = this.role;
    const plan = sq?.plan ?? 'idle';
    const shotAt = now - this.lastThreatAt < 3;
    const moving = Math.hypot(s.vel.x, s.vel.z) > 0.5;
    const sc: Record<Decision, number> = {
      ENGAGE: 0, SEEK_COVER: 0, HOLD_ANGLE: 0, PEEK: 0, SUPPRESS: 0, FLANK: 0, PUSH: 0, RETREAT: 0,
      REPOSITION: 0, SEARCH: 0, INVESTIGATE: 0, RELOAD: 0, REGROUP: 0, ASSIST: 0, FOLLOW: 0.22,
    };
    // Nothing to deal with: carry on (0.40), low enough that a heard gunshot, a squadmate's
    // fight or a call for help wins. A squad objective weighs in unless a soldier is in sight.
    if (!threat) sc.FOLLOW += 0.18;
    if (this.objective > 0 && !(vis && !robot)) sc.FOLLOW += 0.3 * this.objective;

    // ENGAGE: shoot what we see from where we are.
    if (vis && t) {
      // Robots: anything in range gets shot; on the way to an objective only the close ones
      // (the rest follow anyway and come into range).
      if (robot) sc.ENGAGE = dist < 14 ? 0.9 : (dist < 30 ? 0.85 : 0.7) - 0.6 * this.objective;
      else {
        sc.ENGAGE = 0.62 + (inCover ? 0.18 : -0.12 * P.cover) + (inRange ? 0.08 : -0.18) + (t.lineOfFire ? 0.05 : -0.4);
        if (suppressed) sc.ENGAGE -= 0.3 * (1.3 - P.exposure);
        if (hp < P.retreatHp) sc.ENGAGE -= 0.2;
      }
    }

    // SEEK_COVER: exposed to a known threat, or being shot at.
    if (soldierThreat && !inCover && now > this.noCoverUntil) {
      const exposedLvl = vis || shotAt ? 1 : 0.3;
      sc.SEEK_COVER = (0.3 + 0.32 * exposedLvl + 0.35 * Math.min(1, supp) + (hp < 0.6 ? 0.15 : 0)) * P.cover + (vis ? 0.1 : 0);
      if (vis && inRange && P.push > 1.3) sc.SEEK_COVER -= 0.15;
      if (dist < 6 && vis) sc.SEEK_COVER -= 0.25; // too close to turn your back
      // Spotted them first and not under fire: shoot before running for cover.
      if (vis && inRange && !shotAt && t?.lineOfFire) sc.SEEK_COVER -= 0.12;
    }

    // HOLD_ANGLE: watch where they were. Gets old (fatigue persists across switches).
    if (soldierThreat && t && !vis && conf > 0.25 && infoAge < 15) {
      const team = sq && sq.alive.length > 1;
      sc.HOLD_ANGLE = 0.36 + (inCover ? 0.12 : 0) + (team && (role === 'anchor' || role === 'overwatch') ? 0.2 : 0) + (P.cover - 1) * 0.2;
      sc.HOLD_ANGLE -= Math.min(0.7, (this.holdFatigue / (T.maxHoldCover * P.hold)) * 0.7);
      if (seenAgo < 2.5) sc.HOLD_ANGLE += 0.1; // just ducked out of sight: they'll reappear
      if (t.lastSeenTime < 0) sc.HOLD_ANGLE -= 0.15; // only heard: find out what it is
    }

    // PEEK: from cover, have a look.
    if (soldierThreat && inCover && !vis && conf > 0.25 && now > this.peek.next) {
      // Only heard, never seen: there's nothing to peek at yet (go find out instead).
      const neverSeen = t!.lastSeenTime < 0;
      sc.PEEK = 0.42 + 0.25 * Math.min(1, neverSeen ? 0 : seenAgo / 4) - 0.45 * Math.min(1, supp) + (P.exposure - 1) * 0.2 - (neverSeen ? 0.1 : 0);
    }

    // SUPPRESS: pin a known position, especially while a squadmate moves.
    const ammoOk = mag > 0.3 || reserveOk;
    if (soldierThreat && conf > 0.35 && seenAgo < 7 && ammoOk && (!vis || dist > range.max)) {
      const base = (0.3 + (role === 'suppressor' ? 0.4 : 0) + (sq?.flankActive ? 0.35 : 0) - (supp > 0.6 ? 0.2 : 0)) * P.suppress * T.suppressUtility;
      if (base > 0.2 && this.canSeeArea(t!)) sc.SUPPRESS = base;
    }

    // FLANK: they're holding a spot and someone else is keeping them busy.
    if (soldierThreat && t && conf > 0.35 && now > this.flankBanUntil && (sq ? now > sq.flankBanUntil : true)) {
      const still = Math.hypot(t.vel.x, t.vel.z) < 1.2;
      if (still && dist > 8 && dist < 50 && hp > 0.45 && !suppressed && allies >= 1) {
        sc.FLANK = (0.26 + (role === 'flanker' ? 0.5 : 0) + (plan === 'flank' && role === 'flanker' ? 0.15 : 0)) * P.flank * T.flankUtility;
      }
    }

    // PUSH: the fight favours us.
    if (soldierThreat && t && conf > 0.3) {
      const enemyReloading = now - t.lastReloadHeard < 2.5;
      const enemySuppressed = now - this.lastFireProgress < 2 && !vis; // we've been hammering their spot
      const closeWeapon = (s.weaponClass === 'shotgun' || s.weaponClass === 'smg' || s.weaponClass === 'pistol') && dist > range.ideal;
      let push = 0.1 + 0.3 * (enemySuppressed ? 1 : 0) + 0.3 * (enemyReloading ? 1 : 0) + 0.25 * Math.max(0, advantage) + (closeWeapon ? 0.2 : 0);
      push += (role === 'assault' ? 0.25 : 0) + (plan === 'push' ? 0.25 : 0);
      push -= (hp < 0.5 ? 0.35 : 0) + (mag < 0.3 && !reserveOk ? 0.3 : 0) + (allies === 0 && !friendly ? 0.25 : 0) + 0.4 * Math.min(1, supp) + (conf < 0.5 ? 0.2 : 0);
      // Already in their face: the push is done, fight it out.
      if (dist < Math.max(4, range.ideal * 0.6)) push *= 0.25;
      sc.PUSH = Math.max(0, push) * P.push * T.pushUtility;
    }

    // RETREAT: this fight is bad.
    if (soldierThreat) {
      let r = Math.max(0, (P.retreatHp - hp) / P.retreatHp) * 0.9;
      r += (outnumbered ? 0.25 : 0) + (mag <= 0 && !reserveOk ? 0.6 : 0) + (supp > 1 && !inCover ? 0.3 : 0) + (plan === 'retreat' ? 0.45 : 0);
      // Already fell back to cover: stay and recover there for a while.
      if (inCover && now - this.retreatedAt < 10) r *= 0.3;
      sc.RETREAT = r * T.retreatUtility;
    }

    // REPOSITION: stale cover, stale angle (never right after arriving somewhere new).
    if (soldierThreat && now - this.lastReposition > Math.max(T.minRepositionInterval, 4)) {
      // Firing from the same spot for too long: they know where we are now. Relocate.
      if (inCover && vis && coverAge > T.maxHoldCover * P.hold * 2) sc.REPOSITION = 1.1;
      else if (inCover && coverAge > T.maxHoldCover * P.hold) sc.REPOSITION = 0.55;
      else if (!vis && seenAgo > 6 && infoAge < 12 && conf > 0.3 && !moving && (!inCover || coverAge > 6)) sc.REPOSITION = 0.42;
      else if (!inCover && now < this.noCoverUntil && (vis || shotAt)) sc.REPOSITION = 0.35;
    }

    // SEARCH: lost them; go look where they were.
    if (soldierThreat && t && !vis && infoAge > 3 && conf < 0.75 && now - t.lastInfoTime < T.searchDuration && !t.searched) {
      sc.SEARCH = 0.4 + (P.push - 1) * 0.15 + (plan === 'search' ? 0.25 : 0);
      if (t.lastSeenTime < 0) sc.SEARCH -= 0.15; // never seen: investigating suits better
    }

    // A search / an investigation under way is finished, even as the trail goes cold.
    if (this.search && now - this.search.since < T.searchDuration && !vis) sc.SEARCH = Math.max(sc.SEARCH, 0.55);
    if (this.investigate && now - this.investigate.since < 30 && !vis) sc.INVESTIGATE = Math.max(sc.INVESTIGATE, 0.55);

    // INVESTIGATE: a sound, or an enemy only heard.
    const sound = this.memory.sounds[this.memory.sounds.length - 1];
    if (!soldierThreat || (t && t.lastSeenTime < 0 && !vis)) {
      if (sound && now - sound.time < 12 && sound.conf > 0.15) sc.INVESTIGATE = (Math.min(0.62, 0.3 + sound.conf * 0.6) + (P.push - 1) * 0.1) * (1 - 0.6 * this.objective);
      if (t && soldierThreat && t.lastSeenTime < 0) sc.INVESTIGATE = Math.max(sc.INVESTIGATE, 0.5);
      if (now - this.allyFireAt < 6 && !soldierThreat) sc.INVESTIGATE = Math.max(sc.INVESTIGATE, 0.45 * P.cooperation);
    }

    // RELOAD: low mag, ideally in cover.
    if (mag < 0.35 && reserveOk && !reloading) sc.RELOAD = vis ? (s.ammo === 0 ? 0.95 : 0.15) : 0.6 + (inCover ? 0.15 : 0);

    // REGROUP: too far from the squad (friendlies: from you).
    if (sq && !vis) {
      const far = sq.distanceFromSquad(this);
      if (far > (friendly ? T.friendlyTooFar : 30)) sc.REGROUP = friendly ? 0.8 : 0.55;
      if (plan === 'regroup') sc.REGROUP = Math.max(sc.REGROUP, 0.5);
    }

    // ASSIST: a squadmate (or the player) is in a fight we're not part of.
    if (sq && !vis && !soldierThreat) {
      const help = sq.helpFor(this);
      if (help) sc.ASSIST = (friendly && help.player ? 0.66 : 0.52) * P.cooperation;
    }

    // Decision quality: worse bots weigh things less accurately.
    const noise = 0.14 * (1 - this.skill01 * 0.7);
    for (const d of DECISIONS) if (sc[d] > 0) sc[d] += (Math.random() - 0.5) * noise;
    // Stick with what we're doing unless something is clearly better (calm never clings).
    if (sc[this.decision] > 0 && this.decision !== 'FOLLOW') sc[this.decision] += 0.12;
    if (watchdog) {
      sc[this.decision] *= 0.35;
      sc.HOLD_ANGLE *= 0.4;
      let any = false;
      for (const d of MOVES) if (sc[d] > 0) {
        sc[d] += 0.25;
        any = true;
      }
      if (!any && soldierThreat && t) {
        if (!vis && conf < 0.75) sc.SEARCH = Math.max(sc.SEARCH, 0.6);
        else sc.REPOSITION = Math.max(sc.REPOSITION, 0.6);
      }
      this.lastReposition = -1e9;
    }
    let best: Decision = 'FOLLOW';
    for (const d of DECISIONS) if (sc[d] > sc[best]) best = d;
    // Commitment: finish what was started unless something interrupts or is much better.
    if (best !== this.decision && now < this.commitUntil && !this.wasInterrupt && !watchdog && sc[best] < sc[this.decision] + 0.35) best = this.decision;
    this.scores = sc;
    if (best !== this.decision || (watchdog && MOVES.includes(best)) || (this.flankRetry && best === 'FLANK')) this.enter(best, now);
  }

  private enter(d: Decision, now: number): void {
    const prev = this.decision;
    this.decision = d;
    this.decisionAt = now;
    this.flankRetry = false;
    if (d !== 'FLANK') this.stat(d); // FLANK: counted once a plan is in (see below)
    if (prev === 'FLANK' && d !== 'FLANK') this.squad?.flankDone(this, false);
    if (d !== 'SEARCH') this.search = null;
    if (d !== 'INVESTIGATE') this.investigate = null;
    this.peek.phase = 'none';
    const t = this.target;
    const s = this.soldier;
    switch (d) {
      case 'SEEK_COVER':
        this.cover = null;
        this.commitUntil = now + 6;
        this.action = 'finding cover';
        break;
      case 'REPOSITION':
        this.lastReposition = now;
        if (this.cover) this.memory.markCover(this.cover.pos, now);
        this.cover = null;
        this.inCover = false;
        coverRegistry.release(this);
        this.commitUntil = now + 5;
        this.action = 'repositioning';
        break;
      case 'RETREAT':
        this.cover = null;
        this.inCover = false;
        this.commitUntil = now + 7;
        this.action = 'falling back';
        this.agent.say(pick(["I'm hit, falling back!", 'Falling back!', 'Moving to cover, back!']), true);
        break;
      case 'FLANK': {
        let plan: FlankPlan | null | 'pending' = null;
        if (t) {
          const anchor = this.squad?.anchorPos(this) ?? s.pos;
          // Phones: as heavy as a cover search, so it shares its one-per-frame slot (and needs
          // a ray left; checked first so the slot isn't spent when the ray budget is gone).
          const budget = !this.deps.lowSpec || (aiWorld.takeRay() && aiWorld.takeCoverQuery());
          plan = budget ? planFlank(this.deps.nav, this.deps.physics, s.pos, t.pos, anchor, Math.random() < 0.5 ? 1 : -1, this.deps.lowSpec) : 'pending';
        }
        if (now - this.flankPendingAt > 3) this.flankPending = 0;
        if (plan === 'pending') {
          // Out of AI budget this frame, nothing learned about the map: no squad flank ban.
          this.stat('flankPending');
          const replan = prev === 'FLANK' && !!this.flank;
          // Leaving a flank without a route to keep: free the squad's flanker slot (no squad ban).
          if (prev === 'FLANK' && !(replan && this.flankPending < 4) && this.squad?.flanker === this) this.squad.flanker = null;
          if (this.flankPending < 4) {
            this.flankPending++;
            this.flankPendingAt = now;
            this.evalTimer = 0.2; // ask again shortly
            if (replan) {
              // Watchdog re-plan of a flank under way: keep walking the current route meanwhile.
              this.decision = 'FLANK';
              this.flankRetry = true;
              return;
            }
            this.flank = null;
            this.decision = 'HOLD_ANGLE';
            this.commitUntil = now + 0.2;
            this.action = 'planning flank';
            return;
          }
          // Still no budget after a few tries: this bot gives up for a while; the squad doesn't.
          this.flankPending = 0;
          this.flank = null;
          this.flankBanUntil = now + 10;
          this.decision = 'HOLD_ANGLE';
          this.commitUntil = now + 1;
          this.action = 'no flank route';
          return;
        }
        this.stat('FLANK');
        this.flankPending = 0;
        this.flankIndex = 0;
        this.flank = plan;
        if (!this.flank) {
          this.flankBanUntil = now + 10;
          this.squad?.flankDone(this, false);
          this.decision = 'HOLD_ANGLE';
          this.commitUntil = now + 1;
          this.action = 'no flank route';
          this.stat('flankFailed');
          return;
        }
        this.commitUntil = now + 20;
        this.action = flankLabel(this.flank.side);
        this.squad?.flankStarted(this);
        this.agent.say(this.flank.side === 1 ? 'Flanking left!' : 'Flanking right!', true);
        break;
      }
      case 'SEARCH':
        this.commitUntil = now + 8;
        this.action = 'searching';
        if (t) {
          const pts = this.squad?.searchPointsFor(this, t) ?? planSearch(this.deps.nav, t.pos, t.vel, 3, (p) => this.memory.wasSearched(p, now));
          this.search = { pts, i: 0, pauseUntil: 0, target: t, since: now };
          this.debug.searchPts = pts;
          if (Math.random() < 0.5) this.agent.say(pick(['Checking last known.', 'Lost him, searching.', 'Moving to last position.']));
        }
        break;
      case 'INVESTIGATE': {
        this.commitUntil = now + 6;
        const sound = this.memory.sounds[this.memory.sounds.length - 1];
        const at = t && t.lastSeenTime < 0 && t.confidence > 0.2 ? t.pos : sound && now - sound.time < 12 ? sound.pos : now - this.allyFireAt < 6 ? this.allyFirePos : null;
        this.investigate = at ? { pos: at.clone(), arrived: -1, since: now } : null;
        this.debug.investigate = this.investigate?.pos ?? null;
        this.action = 'investigating';
        break;
      }
      case 'PEEK':
        this.commitUntil = now + 3;
        this.peek.phase = 'out';
        this.peek.until = 0;
        this.action = 'peeking';
        break;
      case 'SUPPRESS':
        this.suppressUntil = now + rand(2.6, 4.6);
        this.commitUntil = this.suppressUntil;
        if (t) this.suppressPt.set(t.pos.x, 1.1, t.pos.z);
        s.react(0.2 + Math.random() * 0.2);
        this.action = 'suppressing';
        this.agent.say(pick(['Suppressing!', 'Covering fire!', 'Keep their heads down!']));
        this.progress('suppress');
        break;
      case 'PUSH':
        this.commitUntil = now + 4;
        this.action = 'pushing';
        if (Math.random() < 0.5) this.agent.say(pick(['Pushing!', 'Moving up!', 'Go, go!']));
        break;
      case 'RELOAD':
        this.commitUntil = now + 2;
        this.action = 'reloading';
        break;
      case 'REGROUP':
      case 'ASSIST':
        this.commitUntil = now + 5;
        this.action = d === 'REGROUP' ? 'regrouping' : 'assisting';
        break;
      default:
        this.commitUntil = now + 0.8;
        this.action = d === 'FOLLOW' ? 'calm' : d.toLowerCase();
        if (d === 'FOLLOW') this.navigator.stop(); // the team logic moves us now
    }
    // (Entering a move isn't progress by itself: the watchdog counts ground made.)
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
      if (this.decision !== 'SEEK_COVER' && this.decision !== 'RETREAT' && this.decision !== 'REPOSITION' && this.decision !== 'PEEK') {
        coverRegistry.release(this);
        this.cover = null;
        this.inCover = false;
      }
      return;
    }
    const was = this.inCover;
    const dp = c.peek ? Math.hypot(c.peek.x - s.pos.x, c.peek.z - s.pos.z) : Infinity;
    this.inCover = d < 1.3 || dp < 1;
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
  drive(dt: number, mates: import('../enemies/Soldier').Soldier[]): void {
    const now = aiWorld.time;
    const s = this.soldier;
    this.face = null;
    this.fire = false;
    this.aimMode = 'ready';
    this.aimTgt.alive = false;
    this.navigator.update(dt, now);
    const t = this.target;
    // Holding gets old; anything else lets it recover slowly. New sightings reset it.
    if (this.decision === 'HOLD_ANGLE') this.holdFatigue += dt;
    else this.holdFatigue = Math.max(0, this.holdFatigue - dt * 0.25);
    if (t?.visible) this.holdFatigue = 0;
    // Standing unless a decision says otherwise (hold / cover / peek / reload crouch on their own).
    s.crouchTarget = 0;
    switch (this.decision) {
      case 'ENGAGE':
        this.doEngage(dt, now);
        break;
      case 'SEEK_COVER':
      case 'REPOSITION':
        this.doCover(dt, now, 'fight');
        break;
      case 'RETREAT':
        this.doCover(dt, now, 'retreat');
        break;
      case 'HOLD_ANGLE':
        this.doHold(dt, now);
        break;
      case 'PEEK':
        this.doPeek(dt, now);
        break;
      case 'SUPPRESS':
        this.doSuppress(dt, now);
        break;
      case 'FLANK':
        this.doFlank(dt, now);
        break;
      case 'PUSH':
        this.doPush(dt, now);
        break;
      case 'SEARCH':
        this.doSearch(dt, now);
        break;
      case 'INVESTIGATE':
        this.doInvestigate(dt, now);
        break;
      case 'RELOAD':
        this.doReload(dt, now);
        break;
      case 'REGROUP':
        this.doRegroup(dt, now);
        break;
      case 'ASSIST':
        this.doAssist(dt, now);
        break;
      default:
        break;
    }
    // Opportunistic fire: a visible enemy while moving at a walk/jog (aim suffers).
    if (!this.fire && t?.visible && t.lineOfFire && this.decision !== 'RETREAT' && this.decision !== 'REGROUP') {
      const v = Math.hypot(s.vel.x, s.vel.z);
      if (v <= JOG * 1.05 && (this.skill01 > 0.35 || this.profile.push > 1.2 || t.kind === 'robot')) this.aimAt(t, false);
    }
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

  private doEngage(dt: number, now: number): void {
    const t = this.target;
    const s = this.soldier;
    if (!t || !t.visible) {
      this.interrupt = true;
      if (t) this.look(t.pos, 1.3, 'aim');
      return;
    }
    const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
    this.aimAt(t, true);
    if (t.kind === 'robot') {
      // Robots only hurt up close: keep the gap while shooting.
      const kite = 4.2 + (1.4 - this.profile.push) * 2;
      if (d < kite) {
        this.action = 'kiting';
        this.kiteTimer -= dt;
        if (this.kiteTimer <= 0) {
          this.kiteTimer = 0.3;
          this.stepAway(t.pos, 3.5, this.agent.hp < 0.35 ? RUN : JOG);
        }
      } else {
        this.action = 'shooting';
        this.navigator.stop();
      }
      s.crouchTarget = 0;
      return;
    }
    if (this.inCover && this.cover) {
      this.action = this.cover.low ? 'firing over cover' : 'firing from cover';
      if (!this.cover.low && this.atPeek) {
        // Shooting from the side of full cover: limited exposure, then back in.
        if (this.peek.until === 0) this.peek.until = now + AI_TUNING.peekExposure * 2 * this.profile.exposure * (1.3 - 0.6 * this.skill01);
        if (now > this.peek.until) {
          this.navigator.go(this.cover.pos, JOG, 0.4);
          this.action = 'ducking back';
          this.fire = false;
        } else this.navigator.stop();
      } else {
        if (!this.atPeek) this.peek.until = 0;
        // Behind full cover: shuffle along it now and then and drop to a knee for a few
        // shots (a man fighting from cover keeps adjusting; a statue doesn't).
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = rand(1.4, 3.2);
          this.kneel = !this.cover.low && Math.random() < 0.35;
          // Along the cover: whichever way is open (one side is usually the wall).
          const side = Math.random() < 0.5 ? -1 : 1;
          const dist = rand(0.6, 1.1);
          if (Math.random() < 0.15 || !(this.sideStep(t.pos, dist, WALK, side) || this.sideStep(t.pos, dist, WALK, -side))) this.navigator.stop();
        }
      }
      if (this.cover.low) {
        // Low cover: up to shoot, down to reload / when the fire gets heavy.
        this.crouchCycle -= dt;
        if (this.crouchCycle <= 0) {
          this.standUp = !this.standUp;
          this.crouchCycle = this.standUp ? rand(1.1, 1.1 + 1.3 * this.profile.exposure) : rand(0.6, 1.3);
        }
        const up = this.standUp && s.reloadTimer <= 0 && this.suppression < 1;
        s.crouchTarget = up ? 0 : 1;
        if (!up) this.fire = false;
      } else s.crouchTarget = this.kneel && !this.navigator.hasDest && s.reloadTimer <= 0 ? 0.6 : 0;
    } else {
      this.action = 'shooting';
      // In the open nobody stands still (a standing man is an easy shot): side-steps to
      // spoil aim, the pushy ones edging in, the careful ones giving ground up close,
      // a beat of stillness now and then to settle the aim.
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = rand(0.8, 1.9) / Math.max(0.7, Math.sqrt(this.profile.push));
        const pushy = this.profile.push > 1.05;
        const r = Math.random();
        if (r < 0.15 && now - this.lastThreatAt > 2) this.navigator.stop();
        else if (r < 0.35 && pushy && d > 10) this.navigator.go(this.tmp2.copy(s.pos).lerp(t.pos, Math.min(0.35, 3 / d)), WALK, 0.4);
        else if (r < 0.35 && !pushy && d < 9) this.stepAway(t.pos, 2.5, WALK);
        else this.sideStep(t.pos, rand(1.4, 3.2), this.suppression > 0.5 || now - this.lastThreatAt < 2 ? JOG : WALK);
      }
      s.crouchTarget = this.profile.cover > 1.2 && d > 15 && !this.navigator.hasDest ? 1 : 0;
    }
    // Elite: jump-peeks and ADAD between shots.
    if (this.agent.chad) {
      this.agent.tryHop();
      this.adadT -= dt;
      if (this.adadT <= 0) {
        this.adadT = rand(0.22, 0.47);
        this.adadSide = -this.adadSide;
        this.sideStep(t.pos, 1.4, JOG, this.adadSide);
      }
    }
  }

  private doCover(dt: number, now: number, mode: 'fight' | 'retreat'): void {
    const s = this.soldier;
    const t = this.target;
    if (!t) {
      this.interrupt = true;
      return;
    }
    // Repositioning again from a spot we already reached: pick a new one, not the same.
    if (this.decision === 'REPOSITION' && this.cover && this.inCover && !this.navigator.hasDest && now - this.coverSince > 1) {
      this.memory.markCover(this.cover.pos, now);
      this.cover = null;
      this.inCover = false;
      coverRegistry.release(this);
    }
    if (!this.cover) {
      if (now < this.coverRetryAt) {
        // Nothing found a moment ago: back off from the threat instead of searching every frame.
        if (mode === 'retreat') {
          if (!this.navigator.hasDest) this.stepAway(t.pos, 8, RUN);
          this.action = 'backing off';
          this.carry();
        } else {
          this.commitUntil = 0;
          this.interrupt = true;
        }
        return;
      }
      const res = this.queryCover(mode, t.pos);
      if (res === 'pending') {
        // Waiting a frame for the cover search: keep fighting / move off the line.
        if (t.visible) this.aimAt(t, false);
        else this.look(t.pos);
        return;
      }
      if (!res) {
        this.noCoverUntil = now + 4;
        this.coverRetryAt = now + 2.5;
        this.stat('noCover');
        if (mode === 'retreat') {
          this.stepAway(t.pos, 8, RUN);
          this.action = 'backing off';
          this.commitUntil = now + 2;
        } else this.interrupt = true;
        return;
      }
      this.cover = res;
      this.action = mode === 'retreat' ? 'running to cover' : 'moving to cover';
    }
    const c = this.cover;
    const exposed = t.visible || now - this.lastThreatAt < 2;
    const speed = mode === 'retreat' || this.suppression > 0.8 ? RUN : exposed ? RUN : JOG * this.profile.pace;
    this.navigator.go(c.pos, speed, 0.7);
    if (this.navigator.status === 'failed') {
      this.cover = null;
      coverRegistry.release(this);
      this.noCoverUntil = now + 3;
      this.interrupt = true;
      return;
    }
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    if (d < 1.0) {
      // Arrived (counted once per cover): the decision is done, re-evaluate from the new spot.
      if (this.arrivedCover !== c) {
        this.arrivedCover = c;
        if (mode === 'retreat') this.retreatedAt = now;
        this.inCover = true;
        this.coverSince = now;
        this.memory.markCover(c.pos, now);
        this.progress(mode === 'retreat' ? 'fell back' : 'reached cover');
        this.stat('coverReached');
        if (this.decision === 'REPOSITION') this.lastReposition = now;
      }
      this.navigator.stop();
      this.commitUntil = 0;
      this.interrupt = true;
      s.crouchTarget = c.low ? 1 : 0;
      this.look(t.pos);
      return;
    }
    s.crouchTarget = 0;
    if (t.visible && speed <= JOG * 1.05) this.aimAt(t, false);
    else this.carry();
  }

  private doHold(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!t) {
      this.interrupt = true;
      return;
    }
    this.navigator.stop();
    this.action = this.inCover ? 'holding angle (cover)' : 'holding angle';
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
    this.look(this.tmp, 1.3, t.confidence > 0.45 ? 'aim' : 'ready');
    s.crouchTarget = this.inCover && this.cover?.low ? 1 : this.profile.cover > 1.2 ? 1 : 0;
    void now;
  }

  private doPeek(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    const c = this.cover;
    if (!t || !c) {
      this.interrupt = true;
      return;
    }
    const exposure = AI_TUNING.peekExposure * this.profile.exposure * (1.3 - 0.6 * this.skill01) * rand(0.8, 1.25);
    if (c.low || !c.peek) {
      // Low cover (or no side): stand up, look, get down.
      this.navigator.stop();
      if (this.peek.until === 0) this.peek.until = now + exposure;
      const out = now < this.peek.until;
      s.crouchTarget = out ? 0 : 1;
      this.action = out ? 'peeking (up)' : 'back down';
      if (t.visible) this.aimAt(t, false);
      else this.look(t.pos, 1.3, 'aim');
      if (!out) this.endPeek(now);
      return;
    }
    if (this.peek.phase === 'out') {
      this.navigator.go(c.peek, WALK * 1.4, 0.35);
      this.action = 'peeking out';
      const d = Math.hypot(c.peek.x - s.pos.x, c.peek.z - s.pos.z);
      if (d < 0.5 && this.peek.until === 0) this.peek.until = now + exposure;
      if (this.peek.until > 0 && now > this.peek.until) this.peek.phase = 'back';
      if (this.navigator.status === 'failed') this.peek.phase = 'back';
      if (t.visible) this.aimAt(t, false);
      else this.look(t.pos, 1.3, 'aim');
    } else {
      this.navigator.go(c.pos, JOG, 0.5);
      this.action = 'back in cover';
      this.look(t.pos);
      if (Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z) < 0.7 || this.navigator.status !== 'moving') this.endPeek(now);
    }
  }

  private endPeek(now: number): void {
    this.peek.phase = 'none';
    this.peek.until = 0;
    // Irregular rhythm: skilled bots peek sooner and less predictably.
    this.peek.next = now + rand(1.2, 4) * (1.2 - 0.4 * this.skill01);
    this.stat('peek');
    this.commitUntil = 0;
    this.interrupt = true;
  }

  private doSuppress(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!t || now > this.suppressUntil || (s.ammo <= 0 && s.reserve <= 0)) {
      this.commitUntil = 0;
      this.interrupt = true;
      return;
    }
    if (t.visible) {
      this.aimAt(t, false);
      this.action = 'suppressing (visible)';
      return;
    }
    // From cover with a side peek: step out to put rounds downrange.
    const c = this.cover;
    if (this.inCover && c?.peek && !c.low) this.navigator.go(c.peek, WALK * 1.4, 0.35);
    else this.navigator.stop();
    s.crouchTarget = 0;
    // Walk the fire around the last known spot.
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

  private doFlank(dt: number, now: number): void {
    const s = this.soldier;
    const f = this.flank;
    const t = this.target;
    if (!f || !t) {
      this.interrupt = true;
      return;
    }
    const wp = f.route[Math.min(this.flankIndex, f.route.length - 1)];
    const far = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) > 25;
    this.navigator.go(wp, far && !t.visible ? RUN : JOG * this.profile.pace, this.flankIndex >= f.route.length - 1 ? 0.8 : 1.2);
    if (this.navigator.status === 'arrived') {
      this.flankIndex++;
      this.progress('flank leg');
      if (this.flankIndex >= f.route.length) {
        this.stat('flankDone');
        this.squad?.flankDone(this, true);
        this.action = 'flank position';
        this.commitUntil = 0;
        this.interrupt = true;
        this.look(t.pos, 1.3, 'aim');
        return;
      }
    } else if (this.navigator.status === 'failed') {
      this.flankBanUntil = now + 10;
      this.squad?.flankDone(this, false);
      this.stat('flankFailed');
      this.commitUntil = 0;
      this.interrupt = true;
      return;
    }
    s.crouchTarget = 0;
    this.action = flankLabel(f.side);
    if (t.visible && !far) this.aimAt(t, false);
    else this.carry();
  }

  private doPush(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    if (!t) {
      this.interrupt = true;
      return;
    }
    const range = WEAPON_RANGE[s.weaponClass] ?? WEAPON_RANGE.rifle;
    const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
    s.crouchTarget = 0;
    if (d > Math.max(3.5, range.ideal * 0.55)) {
      this.navigator.go(t.pos, t.visible ? JOG : RUN, Math.max(3, range.ideal * 0.5));
      this.action = 'pushing';
    } else {
      this.navigator.stop();
      this.action = 'pushed in';
      this.commitUntil = 0;
    }
    if (this.navigator.status === 'failed') {
      this.commitUntil = 0;
      this.interrupt = true;
    }
    if (t.visible) this.aimAt(t, false);
    else this.look(t.pos, 1.3, 'aim');
    void dt;
    void now;
  }

  private doSearch(dt: number, now: number): void {
    const s = this.soldier;
    const sr = this.search;
    if (!sr || !sr.pts.length) {
      if (this.target) this.target.searched = true;
      this.commitUntil = 0;
      this.interrupt = true;
      return;
    }
    const p = sr.pts[sr.i];
    if (sr.pauseUntil > 0) {
      // At a search point: hold, listen, look around.
      this.navigator.stop();
      this.action = `checking ${sr.i + 1}/${sr.pts.length}`;
      this.lookTimer -= dt;
      if (this.lookTimer <= 0) {
        this.lookTimer = rand(0.6, 1.2);
        this.lookAngle = s.yaw + (Math.random() - 0.5) * 2.4;
      }
      this.tmp.set(s.pos.x + Math.sin(this.lookAngle) * 8, 0, s.pos.z + Math.cos(this.lookAngle) * 8);
      this.look(this.tmp, 1.3, 'ready');
      if (now > sr.pauseUntil) {
        sr.pauseUntil = 0;
        this.memory.markSearched(p, now);
        sr.i++;
        this.progress('search advanced');
        if (sr.i >= sr.pts.length) {
          // Nothing: the trail is cold.
          if (sr.target) {
            sr.target.searched = true;
            sr.target.confidence *= 0.4;
          }
          this.stat('searchDone');
          this.search = null;
          this.commitUntil = 0;
          this.interrupt = true;
        }
      }
      return;
    }
    const close = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
    this.navigator.go(p, close < 10 ? WALK * 1.3 : JOG * this.profile.pace, 1.2);
    this.action = `search → ${sr.i + 1}/${sr.pts.length}`;
    if (this.navigator.status === 'arrived' || this.navigator.status === 'failed') {
      sr.pauseUntil = now + rand(1, 2.4) * (2 - this.profile.pace);
    }
    // Weapon up toward where they were, while close to it.
    const t = sr.target;
    if (t && close < 14) this.look(t.pos, 1.3, 'ready');
    else this.carry();
    s.crouchTarget = 0;
  }

  private doInvestigate(dt: number, now: number): void {
    const s = this.soldier;
    const iv = this.investigate;
    if (!iv) {
      this.interrupt = true;
      return;
    }
    const d = Math.hypot(iv.pos.x - s.pos.x, iv.pos.z - s.pos.z);
    if (iv.arrived < 0) {
      this.navigator.go(iv.pos, d < 12 ? WALK * 1.3 : JOG * this.profile.pace, 3.5);
      this.action = 'investigating';
      if (d < 16) this.look(iv.pos, 1.3, 'ready');
      else this.carry();
      if (this.navigator.status === 'arrived' || this.navigator.status === 'failed' || d < 3.6) {
        iv.arrived = now;
        this.navigator.stop();
        this.progress('investigated');
      }
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
    this.look(this.tmp);
    if (now - iv.arrived > 2.4) {
      this.memory.markSearched(iv.pos, now);
      const snd = this.memory.sounds;
      for (let i = snd.length - 1; i >= 0; i--) if (snd[i].pos.distanceToSquared(iv.pos) < 64) snd.splice(i, 1);
      if (this.target && this.target.lastSeenTime < 0) this.target.confidence *= 0.5;
      this.allyFireAt = -1e9;
      this.investigate = null;
      this.stat('investigated');
      this.commitUntil = 0;
      this.interrupt = true;
    }
  }

  private doReload(dt: number, now: number): void {
    const s = this.soldier;
    const t = this.target;
    // Exposed with cover close by: get behind it first.
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
    } else {
      this.navigator.stop();
      if (s.reloadTimer <= 0 && !s.startReload()) {
        this.commitUntil = 0;
        this.interrupt = true;
      } else if (Math.random() < 0.01) this.agent.say(pick(['Reloading!', 'Changing mags!', 'Cover me, reloading!']));
    }
    s.crouchTarget = this.inCover && this.cover?.low ? 1 : t?.visible ? 1 : 0;
    if (t) this.look(t.pos);
    if (s.reloadTimer <= 0 && s.ammo >= s.magSize * 0.9) {
      this.progress('reloaded');
      this.commitUntil = 0;
      this.interrupt = true;
    }
    void dt;
  }

  private doRegroup(dt: number, now: number): void {
    const p = this.squad?.regroupPoint(this);
    if (!p) {
      this.interrupt = true;
      return;
    }
    const s = this.soldier;
    const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
    this.navigator.go(p, d > 20 ? SPRINT : d > 12 ? RUN : JOG, 2.5);
    this.carry();
    if (this.navigator.status === 'arrived' || d < 3) {
      this.progress('regrouped');
      this.commitUntil = 0;
      this.interrupt = true;
    } else if (this.navigator.status === 'failed') {
      this.commitUntil = 0;
      this.interrupt = true;
    }
    s.crouchTarget = 0;
    void dt;
    void now;
  }

  private doAssist(dt: number, now: number): void {
    const s = this.soldier;
    const help = this.squad?.helpFor(this);
    if (!help) {
      this.commitUntil = 0;
      this.interrupt = true;
      return;
    }
    if ((!this.cover || this.cover.threat.distanceToSquared(help.threat) > 64) && now > this.coverRetryAt) {
      const res = this.queryCover('fight', help.threat, help.pos);
      if (res === null) this.coverRetryAt = now + 2.5;
      if (res === 'pending') {
        this.navigator.go(help.pos, RUN, 4);
        this.carry();
        return;
      }
      if (!res) {
        // No cover there: just get close to them, facing their threat.
        this.navigator.go(help.pos, RUN, 4);
        this.look(help.threat);
        if (Math.hypot(help.pos.x - s.pos.x, help.pos.z - s.pos.z) < 5) {
          this.commitUntil = 0;
          this.interrupt = true;
        }
        return;
      }
      this.cover = res;
    }
    const c = this.cover;
    if (!c) {
      // Waiting out a failed cover search: close in on them meanwhile.
      this.navigator.go(help.pos, RUN, 4);
      this.carry();
      return;
    }
    const d = Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    this.navigator.go(c.pos, d > 10 ? RUN : JOG, 0.8);
    this.action = help.player ? 'covering you' : 'moving to help';
    if (d < 4) this.look(help.threat, 1.3, 'aim');
    else this.carry();
    if (d < 1.1) {
      this.inCover = true;
      this.coverSince = now;
      this.progress('assist position');
      this.commitUntil = 0;
      this.interrupt = true;
      // Whatever they were fighting is now our business too.
      this.memory.addSound(help.threat, 0.5, 'assist', now);
    }
    if (this.navigator.status === 'failed') {
      this.cover = null;
      this.commitUntil = 0;
      this.interrupt = true;
    }
    void dt;
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
    if (!this.deps.nav.clearLine(s.pos.x, s.pos.z, x, z)) return false;
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
      `${this.name} [${this.team}] ${this.profile.id} · ${this.role}${this.squad ? ` · ${this.squad.plan}` : ''}`,
      `${dec} ${(now - this.decisionAt).toFixed(1)}s · ${this.action}`,
      `tgt ${tgt} · ${cover} · supp ${this.suppression.toFixed(2)}`,
      `move ${this.sinceMove.toFixed(1)}s · prog ${this.sinceProgress.toFixed(1)}s (${this.lastProgress})`,
    ];
    if (this.watchdogFlash > 0) lines.push('PASSIVE WATCHDOG TRIGGERED');
    return lines.join('\n');
  }
}
