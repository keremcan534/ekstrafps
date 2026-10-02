import * as THREE from 'three';
import { GROUPS } from '../core/Physics';
import { JOG, RUN, WALK, Soldier, type PlayerTarget, type SoldierDeps } from '../enemies/Soldier';
import type { SoldierPalette } from '../enemies/SoldierSkin';
import type { DamageInfo } from '../targets/Humanoid';
import type { WeaponData } from '../weapons/WeaponData';
import { SIDEARM, type Errand } from './Errands';

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
  'Keller', 'Rossi', 'Vasquez', 'Holm', 'Sato', 'Becker', 'Nakamura', 'Ortega', 'Kowalski', 'Mensah', 'Dahl', 'Ferreira', 'Yilmaz', 'Quinn', 'Varga', 'Sokolov',
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
const CONTACT_BOT = ['Contact, bot!', 'Robot, on me!', 'Tango moving!', 'Got one here!'];
const CONTACT_SQUAD = ['Hostile squad!', 'Operators, contact!', 'Enemy team!', 'Shooters!'];
const RELOAD = ['Reloading!', 'Changing mags!', 'Cover me, reloading!'];
const HURT = ["I'm hit, falling back!", 'Taking fire, backing off!', 'Need a sec, I\'m hurt!'];
const CLEAR = ['Clear.', 'Area clear.', 'Got him.', 'Tango down.'];

/** Where each squad slot keeps watch while the squad is standing (radians off the leader's facing). */
const WATCH = [-1.15, 1.15, Math.PI, 0.35, -0.35];

/**
 * One AI operator on any team. The team brain gives orders (follow the leader,
 * go somewhere, hold); the agent fights on its own like a person would:
 * - picks the nearest hostile it can see; on calm, close targets goes for the
 *   head (headshots pay more);
 * - backs off from robots while shooting (they only hit up close) and falls back
 *   when badly hurt; assaults push in, riflemen strafe between bursts, careful
 *   ones crouch-peek, marksmen settle and stay low;
 * - reloads in quiet moments, not in the middle of a fight;
 * - when following, doesn't shadow every step: moves only once the gap opens, at
 *   the leader's pace, and keeps watch over its own sector while the squad stands;
 * - revives downed teammates, shops with its own money (errands), talks on the radio.
 */
export class TeamAgent {
  readonly soldier: Soldier;
  readonly self: Combatant;
  order: Order = { kind: 'hold' };
  /** Teammate (or the player) to pick up; set by the brain. */
  reviveTarget: { pos: THREE.Vector3; revive(): void; downed: boolean } | null = null;
  reviveTime = 0;
  target: Combatant | null = null;
  /** Personal money: same economy as the player. */
  points = 500;
  /** Current shopping trip (weapon / ammo / door). */
  errand: Errand | null = null;
  /** Weapon lookup (set by the owner). */
  armory: ((id: string) => WeaponData | undefined) | null = null;
  /** Radio chatter (only wired up for your own squad). */
  onSay: ((a: TeamAgent, text: string) => void) | null = null;
  /** Falling back / kiting right now (HUD, brain). */
  retreating = false;
  private tgt: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: false,
  };
  private scanTimer = Math.random() * 0.25;
  private repath = 0;
  private strafeTimer = 0;
  private peekTimer = 0;
  private kiteTimer = 0;
  private sayTimer = Math.random() * 3;
  private hadTarget = false;
  private following = false;
  private followDelay = 0;
  private watchTimer = 0;
  private watchAngle = 0;
  private watchPt = new THREE.Vector3();
  private slot = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private aimPt = new THREE.Vector3();

  constructor(
    private deps: SoldierDeps,
    readonly team: string,
    readonly index: number,
    readonly personality: Personality,
    palette?: SoldierPalette,
    hooks?: { onKilled?(a: TeamAgent): void; onDowned?(a: TeamAgent): void; onHit?(a: TeamAgent, info: DamageInfo, killed: boolean): void },
  ) {
    this.soldier = new Soldier(deps, 20 + index, {
      onSpotted: () => {},
      onDamaged: (_s, info) => hooks?.onHit?.(this, info, false),
      onKilled: (_s, info) => {
        hooks?.onHit?.(this, info, true);
        hooks?.onKilled?.(this);
      },
      onDowned: () => hooks?.onDowned?.(this),
      say: () => {},
      onThud: (at, s) => deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * s }),
    }, team, palette);
    this.soldier.state = 'combat';
    agentBySoldier.set(this.soldier, this);
    this.soldier.onDry = () => this.arm(SIDEARM);
    const soldier = this.soldier;
    this.self = {
      team,
      kind: 'soldier',
      pos: soldier.pos,
      aim: new THREE.Vector3(),
      head: new THREE.Vector3(),
      get alive() {
        return soldier.alive;
      },
      get downed() {
        return soldier.downed;
      },
      hit: (d, from) => soldier.body.meleeHit(d, from),
    };
  }

  get alive(): boolean {
    return this.soldier.alive;
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

  spawn(at: THREE.Vector3, yaw: number): void {
    this.soldier.spawn(at, yaw);
    this.soldier.state = 'combat';
    this.target = null;
    this.reviveTarget = null;
    this.reviveTime = 0;
    this.errand = null;
    this.retreating = false;
    this.following = false;
  }

  add(n: number): void {
    this.points += n;
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
    const s = this.soldier;
    this.sayTimer -= dt;
    if (!s.alive || s.downed) {
      this.retreating = false;
      s.update(dt, this.tgt, mates, null, 'low', false);
      return;
    }

    // --- Target: nearest hostile it can see (others' teams, robots), not the downed.
    this.scanTimer -= dt;
    if (this.scanTimer <= 0 || (this.target && (!this.target.alive || this.target.downed))) {
      const lost = this.target && (!this.target.alive || this.target.downed);
      this.scanTimer = 0.25;
      this.eye.copy(s.headPos).y += 0.1;
      let best: Combatant | null = null;
      let bd = this.range * this.range;
      for (const c of world) {
        if (c.team === this.team || !c.alive || c.downed) continue;
        const d = c.pos.distanceToSquared(s.pos);
        if (d > bd) continue;
        if (!this.deps.physics.lineOfSight(this.eye, c.aim, GROUPS.sight)) continue;
        bd = d;
        best = c;
      }
      if (best && best !== this.target) {
        s.onAcquire();
        s.visibleTime = 0;
        if (!this.hadTarget && Math.random() < 0.7) this.say(pick(best.kind === 'robot' ? CONTACT_BOT : CONTACT_SQUAD));
      }
      if (!best && lost && Math.random() < 0.4) this.say(pick(CLEAR));
      this.target = best;
      this.hadTarget = !!best;
    }
    const t = this.target;
    this.tgt.alive = !!t;
    if (t) {
      this.tgt.feet.copy(t.pos);
      this.tgt.chest.copy(t.aim);
      this.tgt.head.copy(t.head);
      s.visibleTime += dt;
    }

    // --- Revive a teammate (unless something is right on top of us).
    const rv = this.reviveTarget;
    if (rv && rv.downed && !(t && t.pos.distanceTo(s.pos) < 7)) {
      this.retreating = false;
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
      }
      return;
    }
    if (rv && !rv.downed) this.reviveTarget = null;

    // --- Fighting: move like a person.
    if (t) {
      const dist = t.pos.distanceTo(s.pos);
      const p = this.personality;
      const hp = this.hp;
      this.strafeTimer -= dt;
      this.peekTimer -= dt;
      // Robots only hurt up close: keep the gap while shooting. Badly hurt: fall back.
      const kiteRange = 4.2 + (1 - p.aggression) * 2.5;
      const kite = (t.kind === 'robot' && dist < kiteRange) || (hp < 0.35 && dist < 18 && p.aggression < 0.95);
      if (kite) {
        if (!this.retreating && hp < 0.35) this.say(pick(HURT), true);
        this.retreating = true;
        s.crouchTarget = 0;
        this.kiteTimer -= dt;
        if (this.kiteTimer <= 0) {
          this.kiteTimer = 0.3;
          const ax = s.pos.x - t.pos.x;
          const az = s.pos.z - t.pos.z;
          const al = Math.hypot(ax, az) || 1;
          // Straight back first, then angled escapes (never into a wall).
          for (const ang of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
            const c = Math.cos(ang);
            const sn = Math.sin(ang);
            const dx = (ax / al) * c - (az / al) * sn;
            const dz = (ax / al) * sn + (az / al) * c;
            const x = s.pos.x + dx * 3.5;
            const z = s.pos.z + dz * 3.5;
            if (this.deps.nav.walkable(x, z) && this.deps.nav.clearLine(s.pos.x, s.pos.z, x, z)) {
              s.steerTo(this.tmp.set(x, 0, z), hp < 0.35 ? RUN : JOG);
              break;
            }
          }
        }
      } else {
        this.retreating = false;
        if (p.role === 'marksman') {
          s.stop();
          s.crouchTarget = dist > 12 ? 1 : 0;
        } else if (p.aggression > 0.6 && dist > 11) {
          // Push in.
          s.crouchTarget = 0;
          this.repath -= dt;
          if (this.repath <= 0) {
            if (this.deps.nav.clearLine(s.pos.x, s.pos.z, t.pos.x, t.pos.z)) s.steerTo(t.pos, JOG);
            else s.setPath(t.pos, JOG);
            this.repath = 0.8 + Math.random() * 0.4;
          }
        } else if (this.strafeTimer <= 0) {
          // Side-step between bursts; careful operators crouch-peek instead.
          this.strafeTimer = 1.4 + Math.random() * 1.8;
          if (p.aggression < 0.35 && Math.random() < 0.5) {
            s.stop();
            this.peekTimer = 1.0 + Math.random();
          } else {
            const dx = t.pos.x - s.pos.x;
            const dz = t.pos.z - s.pos.z;
            const l = Math.hypot(dx, dz) || 1;
            const side = Math.random() < 0.5 ? -1 : 1;
            const r = 1.8 + Math.random() * 2;
            this.tmp.set(s.pos.x + (-dz / l) * side * r, 0, s.pos.z + (dx / l) * side * r);
            if (this.deps.nav.clearLine(s.pos.x, s.pos.z, this.tmp.x, this.tmp.z)) s.steerTo(this.tmp, WALK);
          }
        }
        if (p.role !== 'marksman') s.crouchTarget = this.peekTimer > 0 && this.peekTimer < 0.6 ? 1 : this.peekTimer > 0 ? 0 : s.crouchTarget > 0.5 && dist > 6 ? 1 : 0;
      }
      // Settled on a close, calm target: go for the head (pays more, kills faster).
      const head = !kite && s.visibleTime > 1.2 && dist < 24 && p.role !== 'assault';
      s.update(dt, this.tgt, mates, head ? this.tgt.head : this.tgt.chest, 'aim', true);
      return;
    }
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
    } else if (o.kind === 'follow') {
      const l = o.leader();
      if (l) {
        // Loose slot behind/beside the leader; spacing grows with caution.
        const side = this.index % 2 === 0 ? 1 : -1;
        const spread = 1.8 + (1 - this.personality.aggression) * 0.8;
        const back = 2.2 + Math.floor((this.index % 4) / 2) * 1.7;
        const fx = Math.sin(l.yaw);
        const fz = Math.cos(l.yaw);
        this.slot.set(l.pos.x - fx * back + fz * side * spread, 0, l.pos.z - fz * back - fx * side * spread);
        if (!this.deps.nav.walkable(this.slot.x, this.slot.z)) this.slot.copy(l.pos);
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
            const sp = d > 9 || ls > 3.2 ? RUN : d > 5 || ls > 1.9 ? JOG : WALK;
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
    else s.stop();
    s.update(dt, this.tgt, mates, look, 'ready', false);
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
