import * as THREE from 'three';
import { JOG, RUN, SPRINT, WALK, Soldier, type PlayerTarget, type SoldierDeps } from '../enemies/Soldier';
import type { SoldierPalette } from '../enemies/SoldierSkin';
import type { DamageInfo } from '../targets/Humanoid';
import type { WeaponData } from '../weapons/WeaponData';
import { SIDEARM, type Errand } from './Errands';
import type { Plan } from './Plans';
import { Bot } from '../ai/Bot';

/** Soldier → its operator (whose wallet a bullet's points go to). */
export const agentBySoldier = new WeakMap<object, TeamAgent>();

/** Anyone who can fight or be fought: player, soldiers of any team, robots. */
export interface Combatant {
  team: string;
  kind: 'player' | 'soldier' | 'robot';
  /** Feet. */
  pos: THREE.Vector3;
  /** Where to shoot (chest). */
  aim: THREE.Vector3;
  head: THREE.Vector3;
  alive: boolean;
  downed: boolean;
  /** Melee damage (robot swings). */
  hit(damage: number, from: THREE.Vector3): void;
  /** The object its bullets / noises carry as owner (player controller, soldier, robot). */
  ref?: object;
  /** Current velocity (vision notices movement). */
  vel?: THREE.Vector3;
  /** 0 standing .. 1 crouched (smaller, harder to notice). */
  crouch?(): number;
}

export type Role = 'assault' | 'rifleman' | 'marksman' | 'medic';

export interface Personality {
  name: string;
  role: Role;
  /** 0 = holds back and uses cover, 1 = pushes in. */
  aggression: number;
  /** Chance to wander off alone instead of sticking with the team. */
  loner: number;
}

/** Someone to follow. `yaw` faces along (sin, cos) like the soldiers; `speed` in m/s. */
export interface Leader {
  pos: THREE.Vector3;
  yaw: number;
  speed?: number;
}

export type Order =
  | { kind: 'follow'; leader: () => Leader | null }
  | { kind: 'goto'; at: THREE.Vector3; speed: number }
  | { kind: 'hold' };

const NAMES = [
  'Volkov', 'Reyes', 'Kato', 'Brandt', 'Okafor', 'Silva', 'Novak', 'Haas', 'Ivanova', 'Mercer', 'Duarte', 'Lindqvist', 'Moreau', 'Petrov', 'Adeyemi', 'Tanaka',
  'Keller', 'Rossi', 'Vasquez', 'Holm', 'Sato', 'Becker', 'Nakamura', 'Ortega', 'Kowalski', 'Mensah', 'Dahl', 'Ferreira', 'Hayes', 'Quinn', 'Varga', 'Sokolov',
];
const ROLES: Role[] = ['assault', 'rifleman', 'marksman', 'medic'];
const usedNames = new Set<string>();

export function randomPersonality(teamLoner = 0.15): Personality {
  const role = ROLES[(Math.random() * ROLES.length) | 0];
  if (usedNames.size >= NAMES.length) usedNames.clear();
  let name = NAMES[(Math.random() * NAMES.length) | 0];
  while (usedNames.has(name)) name = NAMES[(Math.random() * NAMES.length) | 0];
  usedNames.add(name);
  return {
    name,
    role,
    aggression: role === 'assault' ? 0.7 + Math.random() * 0.3 : role === 'marksman' ? Math.random() * 0.3 : 0.3 + Math.random() * 0.4,
    loner: teamLoner * (0.5 + Math.random()),
  };
}

const pick = <T>(a: readonly T[]) => a[(Math.random() * a.length) | 0];
const RELOAD = ['Reloading!', 'Changing mags!', 'Cover me, reloading!'];
const CLEAR = ['Clear.', 'Area clear.', 'Got him.', 'Tango down.'];

/** Where each squad slot keeps watch while the squad is standing (radians off the leader's facing). */
const WATCH = [-1.15, 1.15, Math.PI, 0.35, -0.35];

/**
 * One AI operator on any team: the body (Soldier), the economy (money, errands,
 * plans), revives and radio — and a tactical mind (Bot: perception, memory,
 * utility decisions, cover, squad) that takes over whenever there's something
 * to deal with. Calm, it follows its team's orders:
 * - reloads in quiet moments, shops with its own money, works its plan;
 * - when following, doesn't shadow every step: moves only once the gap opens, at
 *   the leader's pace, and keeps watch over its own sector while the squad stands.
 */
export class TeamAgent {
  readonly soldier: Soldier;
  readonly self: Combatant;
  /** Persistent orders the team hands out every frame, mutated in place (no per-frame allocation). */
  readonly holdOrder: Order = { kind: 'hold' };
  readonly gotoOrder: Extract<Order, { kind: 'goto' }> = { kind: 'goto', at: new THREE.Vector3(), speed: 0 };
  /** Who followOrder follows. */
  followTarget: TeamAgent | null = null;
  private leaderState: Leader = { pos: new THREE.Vector3(), yaw: 0, speed: 0 };
  readonly followOrder: Order = {
    kind: 'follow',
    leader: () => {
      const L = this.followTarget;
      if (!L || !L.alive || L.downed) return null;
      const st = this.leaderState;
      st.pos = L.soldier.pos;
      st.yaw = L.soldier.yaw;
      st.speed = Math.hypot(L.soldier.vel.x, L.soldier.vel.z);
      return st;
    },
  };
  order: Order = this.holdOrder;
  /** Teammate (or the player) to pick up; set by the brain. */
  reviveTarget: { pos: THREE.Vector3; revive(): void; downed: boolean } | null = null;
  reviveTime = 0;
  target: Combatant | null = null;
  /** Personal money: same economy as the player. */
  points = 500;
  /** Current shopping trip (weapon / ammo / door). */
  errand: Errand | null = null;
  /** Longer-term intention (save for a gun, open the way, farm, push a team). */
  plan: Plan | null = null;
  private planHold = 0;
  /** Weapon lookup (set by the owner). */
  armory: ((id: string) => WeaponData | undefined) | null = null;
  /** Radio chatter (only wired up for your own squad). */
  onSay: ((a: TeamAgent, text: string) => void) | null = null;
  /** Falling back / kiting right now (HUD, brain). */
  retreating = false;
  /** Elite operator: jump-peeks, ADAD strafes, snaps to heads, reacts fast. */
  chad = false;
  /** Tactical mind (perception, memory, decisions). */
  readonly bot: Bot;
  /** Aim skill before match heat scales it. */
  baseSkill = 1;
  /** Extracted: off the map (no body, no hits, not counted). */
  gone = false;
  private hopT = -1;
  private hopCd = 1 + Math.random() * 2;
  /** Called when this operator first acquires the player as a target. */
  onSpotPlayer: (() => void) | null = null;
  /** How this operator carries the gun on the move. */
  readonly carry: 'low' | 'high';
  private tgt: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: false,
  };
  private repath = 0;
  private sayTimer = Math.random() * 3;
  private hadTarget = false;
  private following = false;
  private followDelay = 0;
  private watchTimer = 0;
  private watchAngle = 0;
  private watchPt = new THREE.Vector3();
  private slot = new THREE.Vector3();
  private aimPt = new THREE.Vector3();

  constructor(
    private deps: SoldierDeps,
    readonly team: string,
    readonly index: number,
    readonly personality: Personality,
    palette?: SoldierPalette,
    hooks?: { onKilled?(a: TeamAgent): void; onDowned?(a: TeamAgent): void; onHit?(a: TeamAgent, info: DamageInfo, killed: boolean): void },
    teamStyle?: string,
  ) {
    this.soldier = new Soldier(deps, 20 + index, {
      onSpotted: () => {},
      onDamaged: (_s, info) => {
        this.bot.onDamaged(info);
        hooks?.onHit?.(this, info, false);
      },
      onKilled: (_s, info) => {
        this.bot.onDeath();
        hooks?.onHit?.(this, info, true);
        hooks?.onKilled?.(this);
      },
      onDowned: () => hooks?.onDowned?.(this),
      say: () => {},
      onThud: (at, s) => deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * s }),
    }, team, palette);
    this.soldier.state = 'combat';
    this.carry = personality.aggression > 0.5 ? (Math.random() < 0.7 ? 'high' : 'low') : Math.random() < 0.3 ? 'high' : 'low';
    agentBySoldier.set(this.soldier, this);
    this.soldier.onDry = () => this.arm(SIDEARM);
    const soldier = this.soldier;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const me = this;
    this.self = {
      team,
      kind: 'soldier',
      pos: soldier.pos,
      aim: new THREE.Vector3(),
      head: new THREE.Vector3(),
      get alive() {
        return !me.gone && soldier.alive;
      },
      get downed() {
        return soldier.downed;
      },
      hit: (d, from) => soldier.body.meleeHit(d, from),
      ref: soldier,
      vel: soldier.vel,
      crouch: () => soldier.stance,
    };
    this.bot = new Bot(this, deps, teamStyle);
  }

  get alive(): boolean {
    return !this.gone && this.soldier.alive;
  }

  /** Extracted: the body leaves the map. */
  leave(): void {
    this.gone = true;
    this.chad = false;
    this.soldier.hopY = 0;
    this.soldier.body.setActive(false);
    this.soldier.dispose();
  }

  get downed(): boolean {
    return this.soldier.downed;
  }

  get range(): number {
    return this.personality.role === 'marksman' ? 55 : this.personality.role === 'assault' ? 28 : 38;
  }

  /** Health left, 0..1. */
  get hp(): number {
    const h = this.soldier.body.health;
    return h.health / h.maxHealth;
  }

  /** Sentry heading while holding (scans around it, doesn't drift off). */
  private holdYaw = 0;

  spawn(at: THREE.Vector3, yaw: number): void {
    this.holdYaw = yaw;
    if (this.gone) {
      this.gone = false;
      this.soldier.body.setActive(true);
    }
    this.soldier.spawn(at, yaw);
    this.soldier.state = 'combat';
    this.bot.reset();
    this.target = null;
    this.reviveTarget = null;
    this.reviveTime = 0;
    this.errand = null;
    this.plan = null;
    this.retreating = false;
    this.following = false;
  }

  add(n: number): void {
    this.points += n;
  }

  /** Told over the radio to watch a point (no identity, no exact position). */
  alert(from: THREE.Vector3): void {
    this.bot.hearAlert(from);
  }

  /** Elite jump-peek (the bot asks; the hop arc runs here). */
  tryHop(): void {
    if (this.hopT >= 0 || this.hopCd > 0) return;
    this.hopT = 0;
    this.hopCd = 1.4 + Math.random() * 2.2;
  }

  /** Radio line, rate-limited so the squad doesn't talk over itself. */
  say(text: string, force = false): void {
    if (!this.onSay || (!force && this.sayTimer > 0)) return;
    this.sayTimer = 5 + Math.random() * 4;
    this.onSay(this, text);
  }

  /** Equip a weapon: bought guns come with spare mags, the sidearm never runs dry. */
  arm(id: string): void {
    const data = this.armory?.(id);
    if (!data) return;
    const m = data.magazineSize;
    this.soldier.setWeapon(data, id === SIDEARM ? Infinity : m <= 6 ? m * 8 : m <= 10 ? m * 6 : m * 4);
    if (id !== SIDEARM) this.deps.audio.play(data.audio.fire === 'shotgun.fire' ? 'equip.shotgun' : 'equip.rifle', { position: this.soldier.pos, volume: 0.6 });
  }

  restock(): void {
    this.soldier.refillReserve();
    this.deps.audio.play('reload.rifle.magin', { position: this.soldier.pos, volume: 0.7 });
  }

  /** Refresh the combatant record (positions others aim at). */
  refreshSelf(): void {
    if (!this.soldier.alive) return;
    this.self.aim.copy(this.soldier.chestPos);
    this.self.head.copy(this.soldier.headPos).y += 0.15;
  }

  update(dt: number, world: Combatant[], mates: Soldier[]): void {
    if (this.gone) return;
    const s = this.soldier;
    this.sayTimer -= dt;
    this.hopCd -= dt;
    // Hop arc (0.5 s, ~0.5 m).
    if (this.hopT >= 0) {
      this.hopT += dt;
      const k = this.hopT / 0.5;
      s.hopY = k < 1 ? Math.sin(k * Math.PI) * 0.5 : 0;
      if (k >= 1) this.hopT = -1;
    }
    if (!s.alive || s.downed) {
      this.retreating = false;
      this.target = null;
      s.update(dt, this.tgt, mates, null, 'low', false);
      return;
    }
    const bot = this.bot;
    bot.sense(dt, world);

    // --- Revive a teammate (only when it's safe: no threat in view, no bullets flying).
    const rv = this.reviveTarget;
    if (rv && rv.downed && bot.safeToRevive()) {
      this.retreating = false;
      this.target = null;
      const d = Math.hypot(rv.pos.x - s.pos.x, rv.pos.z - s.pos.z);
      this.repath -= dt;
      if (d > 1.3) {
        this.reviveTime = 0;
        s.crouchTarget = 0;
        if (this.repath <= 0) {
          if (this.deps.nav.clearLine(s.pos.x, s.pos.z, rv.pos.x, rv.pos.z)) s.steerTo(rv.pos, RUN);
          else this.repath = s.setPath(rv.pos, RUN) ? 0.6 : 1.2;
          this.repath = Math.max(this.repath, 0.4);
        }
        s.update(dt, this.tgt, mates, null, 'ready', false);
        return;
      }
      s.stop();
      s.crouchTarget = 1;
      this.reviveTime += dt * (this.personality.role === 'medic' ? 1.6 : 1);
      this.aimPt.copy(rv.pos).y += 0.3;
      s.update(dt, this.tgt, mates, this.aimPt, 'low', false);
      if (this.reviveTime >= 4) {
        rv.revive();
        this.reviveTarget = null;
        this.reviveTime = 0;
        s.crouchTarget = 0;
        bot.progress('revived');
      }
      return;
    }
    if (rv && !rv.downed) this.reviveTarget = null;

    // --- Something to deal with: the tactical mind drives.
    if (bot.think(dt)) {
      this.target = bot.engaged ?? (bot.target && bot.target.confidence > 0.3 ? bot.target.target : null);
      this.retreating = bot.decision === 'RETREAT';
      this.hadTarget = !!this.target;
      bot.drive(dt, mates);
      return;
    }
    if (this.hadTarget && Math.random() < 0.4) this.say(pick(CLEAR));
    this.hadTarget = false;
    this.target = null;
    this.retreating = false;

    // --- No contact: top up the mag, shopping trip, otherwise follow orders.
    s.crouchTarget = 0;
    if (s.ammo < s.magSize * 0.5 && s.reserve > 0 && s.startReload() && s.ammo < s.magSize * 0.25) this.say(pick(RELOAD));
    const o = this.order;
    this.repath -= dt;
    const e = this.errand;
    let look: THREE.Vector3 | null = null;
    if (e) {
      if (e.time === 0) this.say(e.label, true);
      e.time += dt;
      if (this.distTo(e.at) < 1.5) {
        e.run();
        this.errand = null;
      } else if (e.time > 30) this.errand = null;
      else this.moveTo(e.at, 0.6, JOG);
    } else if (this.plan && this.plan.valid && !this.plan.valid()) {
      this.plan = null;
    } else if (this.plan) {
      const pl = this.plan;
      if (pl.time === 0) {
        this.say(pl.label, true);
        this.planHold = 0;
      }
      pl.time += dt;
      const d = this.distTo(pl.at);
      if (d < 1.8 || (pl.hold && d < 4)) {
        if (pl.run) {
          pl.run();
          pl.run = undefined;
        }
        this.planHold += dt;
        if (!pl.hold || this.planHold > pl.hold) this.plan = null;
        else {
          // Farming a spot: hold and scan around.
          s.stop();
          this.watchTimer -= dt;
          if (this.watchTimer <= 0) {
            this.watchTimer = 2 + Math.random() * 2.5;
            this.watchAngle = Math.random() * Math.PI * 2;
          }
          this.watchPt.set(s.pos.x + Math.sin(this.watchAngle) * 10, 1.3, s.pos.z + Math.cos(this.watchAngle) * 10);
          look = this.watchPt;
        }
      } else if (pl.time > 75) this.plan = null;
      else this.moveTo(pl.at, 1.2, pl.kind === 'regroup' || pl.kind === 'hunt' ? RUN : JOG);
    } else if (o.kind === 'follow') {
      const l = o.leader();
      const prey = l ? this.preyNear(world, l.pos, dt) : null;
      if (prey) {
        // Not just tailing the leader: an awake robot close to them or to us gets dealt
        // with (once it's in sight the tactical mind above takes the fight).
        this.following = false;
        this.moveTo(prey.pos, 5, JOG);
        look = prey.aim;
      } else if (l) {
        // Loose slot behind/beside the leader; spacing grows with caution. Friendly
        // squads get theirs from the squad brain (out of your fire lane, corridor-aware).
        const fslot = this.bot.squad?.friendly ? this.bot.squad.formationSlot(this.bot) : null;
        if (fslot) this.slot.copy(fslot);
        else {
          const side = this.index % 2 === 0 ? 1 : -1;
          const spread = 1.8 + (1 - this.personality.aggression) * 0.8;
          const back = 2.2 + Math.floor((this.index % 4) / 2) * 1.7;
          const fx = Math.sin(l.yaw);
          const fz = Math.cos(l.yaw);
          this.slot.set(l.pos.x - fx * back + fz * side * spread, 0, l.pos.z - fz * back - fx * side * spread);
          if (!this.deps.nav.walkable(this.slot.x, this.slot.z)) this.slot.copy(l.pos);
        }
        const d = this.distTo(this.slot);
        // Don't shadow every step: wait for the gap to open, then go after a beat.
        if (!this.following && d > 3.2) {
          this.following = true;
          this.followDelay = 0.15 + Math.random() * 0.55;
        }
        if (this.following) {
          this.followDelay -= dt;
          if (this.followDelay <= 0) {
            const ls = l.speed ?? 0;
            const sp = d > 14 ? SPRINT : d > 9 || ls > 3.2 ? RUN : d > 5 || ls > 1.9 ? JOG : WALK;
            this.moveTo(this.slot, 0.9, sp);
            if (d < 1.1) {
              this.following = false;
              s.stop();
            }
          }
        } else s.stop();
        // Standing or walking: watch your own sector instead of staring at the leader's back.
        if (!this.following || (l.speed ?? 0) < 2) {
          this.watchTimer -= dt;
          if (this.watchTimer <= 0) {
            this.watchTimer = 2.5 + Math.random() * 3.5;
            this.watchAngle = WATCH[this.index % WATCH.length] + (Math.random() - 0.5) * 0.9;
          }
          const a = l.yaw + this.watchAngle;
          this.watchPt.set(s.pos.x + Math.sin(a) * 10, 1.3, s.pos.z + Math.cos(a) * 10);
          look = this.watchPt;
        }
      }
    } else if (o.kind === 'goto') this.moveTo(o.at, 0.8, o.speed);
    else {
      s.stop();
      // Holding: scan the area like a sentry (new direction every few seconds).
      this.watchTimer -= dt;
      if (this.watchTimer <= 0) {
        this.watchTimer = 2.5 + Math.random() * 3.5;
        this.watchAngle = this.holdYaw + (Math.random() - 0.5) * 2.6;
      }
      this.watchPt.set(s.pos.x + Math.sin(this.watchAngle) * 10, 1.3, s.pos.z + Math.cos(this.watchAngle) * 10);
      look = this.watchPt;
    }
    const running = Math.hypot(s.vel.x, s.vel.z) > 3;
    s.update(dt, this.tgt, mates, running ? null : look, running ? this.carry : 'ready', false);
  }

  private prey: Combatant | null = null;
  private preyTimer = 0;

  /** The nearest robot within 20 m of us and 26 m of the leader (re-checked twice a second). */
  private preyNear(world: Combatant[], leader: THREE.Vector3, dt: number): Combatant | null {
    if ((this.preyTimer -= dt) > 0) return this.prey?.alive && !this.prey.downed ? this.prey : null;
    this.preyTimer = 0.5;
    const s = this.soldier;
    let best: Combatant | null = null;
    let bestD = Infinity;
    for (const c of world) {
      if (c.kind !== 'robot' || !c.alive || c.downed || c.team === s.team) continue;
      const d = c.pos.distanceTo(s.pos);
      if (d > 20 || d >= bestD || c.pos.distanceTo(leader) > 26) continue;
      best = c;
      bestD = d;
    }
    this.prey = best;
    return best;
  }

  /** Path / steer toward a point; stop within `arrive` metres. */
  private moveTo(at: THREE.Vector3, arrive: number, speed?: number): void {
    const s = this.soldier;
    const d = Math.hypot(at.x - s.pos.x, at.z - s.pos.z);
    if (d <= arrive) {
      s.stop();
      return;
    }
    const sp = speed ?? (d > 8 ? RUN : d > 3 ? JOG : WALK);
    if (d < 9 && this.deps.nav.clearLine(s.pos.x, s.pos.z, at.x, at.z)) s.steerTo(at, sp);
    else if (this.repath <= 0) {
      this.repath = s.setPath(at, sp) ? 1 + Math.random() * 0.5 : 1.5;
    }
  }

  /** Distance to a point (for the brain). */
  distTo(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.soldier.pos.x, p.z - this.soldier.pos.z);
  }
}
