import * as THREE from 'three';
import type { SoldierDeps } from '../enemies/Soldier';
import type { SoldierPalette } from '../enemies/SoldierSkin';
import type { WeaponData } from '../weapons/WeaponData';
import type { Site9 } from '../world/Site9';
import { START_POINTS, type Survival } from './Survival';
import type { RogueRobot } from '../enemies/RogueRobot';
import { TeamAgent, randomPersonality, type Combatant } from './TeamAgent';
import type { DamageInfo } from '../targets/Humanoid';
import { SIDEARM, planErrand } from './Errands';
import { payPooled, planFor, type Intel, type PlanContext } from './Plans';
import { SquadBrain } from '../ai/Squad';

export interface TeamDef {
  id: string;
  name: string;
  /** CSS colour for HUD/map. */
  color: string;
  palette: SoldierPalette;
  /** disciplined: moves as a unit · reckless: spreads out, lone wolves · balanced · hunter: SABLE raid. */
  style: 'disciplined' | 'reckless' | 'balanced' | 'hunter';
  start: THREE.Vector3;
  /** Earns/spends points (false for raiders). */
  economy: boolean;
  /** Raiders: the first operator is the SABLE commander. */
  boss?: boolean;
}

export interface TeamContext {
  deps: SoldierDeps;
  map: Site9;
  survival: Survival;
  weaponData(id: string): WeaponData | undefined;
  world(): Combatant[];
  robots(): RogueRobot[];
  /** Random far-away respawn point. */
  respawnPoint(): THREE.Vector3;
  /** A member of this team was killed (kill feed). */
  onKill?(victim: TeamAgent, info: DamageInfo): void;
  /** Enemy operators heard recently (gunfire). */
  intel?(team: string): Intel[];
  /** A SABLE raider has eyes on the player. */
  onRaiderSpotsPlayer?(): void;
  /** The SABLE commander went down (bonus, banner). */
  onBossDown?(info: DamageInfo): void;
  /** Match heat 0..1: fights get harder and more punishing as the clock runs. */
  heat?(): number;
  /** The supply drop (announced or down), or null: every team's objective. */
  drop?(): THREE.Vector3 | null;
}

/** Each downed member gets the nearest standing teammate (one rescuer each). */
export function assignRevives(agents: TeamAgent[]): void {
  for (const a of agents) if (a.reviveTarget && !a.reviveTarget.downed) a.reviveTarget = null;
  for (const d of agents) {
    if (!d.downed || agents.some((a) => a.reviveTarget?.pos === d.soldier.pos)) continue;
    let best: TeamAgent | null = null;
    let bd = Infinity;
    for (const a of agents) {
      if (!a.alive || a.downed || a.reviveTarget) continue;
      const dist = a.distTo(d.soldier.pos);
      if (dist < bd) {
        bd = dist;
        best = a;
      }
    }
    if (best) {
      const body = d.soldier.body;
      best.reviveTarget = {
        pos: d.soldier.pos,
        revive: () => body.revive(),
        get downed() {
          return body.downed;
        },
      };
    }
  }
}

interface Goal {
  kind: 'door' | 'hire' | 'roam' | 'hunt' | 'retreat' | 'farm' | 'rush' | 'extract' | 'contest';
  /** Moving target (a rush follows its victim). */
  track?: () => THREE.Vector3 | null;
  at: THREE.Vector3;
  run?: () => void;
  time: number;
  /** Stay this long once there (farming a spot). */
  hold?: number;
}

/** Core squad size (everyone starts with four; hires come on top). */
export const SQUAD_SIZE = 4;
const MAX_SQUAD = 6;
let agentIndex = 0;

/**
 * An AI team: four operators (up to six with hires), each with their own money
 * like the player. Between fights everyone shops for themselves — a better gun
 * from a wall-buy in reach, a restock when low — and the richest pays for doors
 * and contractors. The leader decides where the squad goes: new ground, awake
 * robots, or a sweep. Downed members get revived by the nearest teammate; a
 * wiped team respawns somewhere random. Raiders ('hunter') just go for the
 * nearest enemy.
 */
export class AITeam {
  readonly agents: TeamAgent[] = [];
  /** Tactical squad brain: shared contacts (radio), roles, plan, progress. */
  readonly squad: SquadBrain;
  respawnTimer = -1;
  private goal: Goal | null = null;
  private thinkTimer = Math.random();
  private errandTimer = Math.random() * 2;
  /** Where the leader last made ground on a goal, and how long ago (the squad's stall watch). */
  private stallAt = new THREE.Vector3(1e9, 0, 1e9);
  private stallTime = 0;
  private tmp = new THREE.Vector3();
  /** Extraction phase: wiped teams don't come back. */
  noRespawn = false;
  /** Made it out (extraction). */
  extracted = false;
  /** Extraction: where to go and what happens on arrival. */
  private exit: { at: THREE.Vector3; done: () => void } | null = null;
  private exitHold = 0;
  /** Hires sent off the map by a redeploy, kept to be hired again (no new bodies). */
  private spare: TeamAgent[] = [];
  /** Everyone's soldier, refreshed in place every frame. */
  private mates: TeamAgent['soldier'][] = [];

  constructor(readonly def: TeamDef, private ctx: TeamContext, size = SQUAD_SIZE) {
    this.squad = new SquadBrain(def.id, false, ctx.deps.nav);
    for (let i = 0; i < size; i++) this.addAgent(def.start.clone().add(new THREE.Vector3((i % 2) * 1.6 - 0.8, 0, ((i / 2) | 0) * 1.5)));
  }

  get leader(): TeamAgent | null {
    for (const a of this.agents) if (a.alive && !a.downed) return a;
    return null;
  }

  /** What the squad is up to (the AI monitor). */
  get goalKind(): string {
    return this.goal?.kind ?? 'free';
  }

  get aliveCount(): number {
    let n = 0;
    for (const a of this.agents) if (a.alive) n++;
    return n;
  }

  private richest(): TeamAgent | null {
    let best: TeamAgent | null = null;
    for (const a of this.agents) if (a.alive && !a.downed && (!best || a.points > best.points)) best = a;
    return best;
  }

  private addAgent(at: THREE.Vector3, points = START_POINTS): TeamAgent {
    const loner = this.def.style === 'reckless' ? 0.45 : this.def.style === 'balanced' ? 0.15 : 0.03;
    // A hire: bring back a spare or a fallen hire before building a new body
    // (a new soldier costs a skinned mesh, physics bodies and a stall).
    if (this.agents.length >= SQUAD_SIZE) {
      let agent = this.spare.pop() ?? null;
      if (agent) this.agents.push(agent);
      else agent = this.agents.find((a, i) => i >= SQUAD_SIZE && !a.alive) ?? null;
      if (agent) {
        Object.assign(agent.personality, randomPersonality(loner));
        agent.chad = false;
        agent.baseSkill = agent.soldier.skill = this.def.style === 'hunter' ? 0.95 : 1.15;
        agent.points = this.def.economy ? points : 0;
        agent.order = agent.holdOrder;
        this.squad.add(agent.bot);
        const at2 = this.ctx.deps.nav.nearestWalkable(at.x, at.z, new THREE.Vector3(), 4) ?? at;
        agent.spawn(at2, Math.random() * Math.PI * 2);
        if (this.def.economy) agent.arm(SIDEARM);
        return agent;
      }
    }
    const isBoss = !!this.def.boss && this.agents.length === 0;
    const personality = randomPersonality(loner);
    if (isBoss) {
      personality.name = 'The Warden';
      personality.role = 'assault';
      personality.aggression = 0.8;
    }
    const agent = new TeamAgent(this.ctx.deps, this.def.id, agentIndex++ % 16, personality, isBoss ? 'bdboss' : this.def.palette, {
      onHit: (a, info, killed) => {
        this.ctx.survival.onSoldierHit(this.def.id, info, killed);
        if (killed) this.ctx.onKill?.(a, info);
        if (killed && isBoss) this.ctx.onBossDown?.(info);
        this.underFire(a, info);
      },
    }, this.def.style);
    this.squad.add(agent.bot);
    if (this.def.style === 'hunter') agent.onSpotPlayer = () => this.ctx.onRaiderSpotsPlayer?.();
    agent.armory = (id) => this.ctx.weaponData(id);
    agent.baseSkill = agent.soldier.skill = this.def.style === 'hunter' ? 0.95 : 1.15;
    agent.points = this.def.economy ? points : 0;
    // Go down (revivable) while a teammate is still standing. Raiders just die.
    agent.soldier.body.canGoDown = () => this.def.style !== 'hunter' && this.agents.some((a) => a !== agent && a.alive && !a.downed);
    const at2 = this.ctx.deps.nav.nearestWalkable(at.x, at.z, new THREE.Vector3(), 4) ?? at;
    agent.spawn(at2, Math.random() * Math.PI * 2);
    if (this.def.economy) agent.arm(SIDEARM);
    if (isBoss) {
      agent.arm('asval'); // compact and suppressed: you hear him late
      agent.baseSkill = agent.soldier.skill = 1.3;
    }
    this.agents.push(agent);
    return agent;
  }

  /**
   * A member was hit (or downed): everyone near turns toward the shooter, and a
   * squad that isn't busy goes after them instead of walking into the same angle.
   */
  private underFire(a: TeamAgent, info: DamageInfo): void {
    const h = info.hit;
    if (h.team === 'robots' || !h.team || h.weaponId === 'melee' || h.weaponId === 'bleed') return;
    // The hit bot shares what it felt with the squad (radio, delayed) itself; the
    // team only decides whether this becomes the squad's errand.
    const from = new THREE.Vector3().copy(h.point).addScaledVector(h.direction, -Math.max(2, h.distance));
    from.x += (Math.random() - 0.5) * (2 + h.distance * 0.1);
    from.z += (Math.random() - 0.5) * (2 + h.distance * 0.1);
    from.y = 0;
    if (this.def.style === 'hunter') return;
    const busy = this.goal && (this.goal.kind === 'retreat' || this.goal.kind === 'hire');
    if (!busy && this.aliveCount >= 2) {
      this.goal = { kind: 'hunt', at: from, time: 20 };
      const L = this.leader;
      if (L) L.plan = null;
    }
  }

  /**
   * Match heat: everyone aims better, and the best of the squad turn into
   * "chads" (jump-peeks, ADAD, head snaps). Raiders always field one.
   */
  escalate(heat: number): void {
    const want = this.def.style === 'hunter' ? 1 : heat > 0.65 ? 2 : heat > 0.3 ? 1 : 0;
    let have = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.chad && have < want) have++;
      else a.chad = false;
    }
    for (const a of this.agents) {
      if (have >= want) break;
      if (!a.alive || a.chad || a.personality.name === 'The Warden') continue;
      a.chad = true;
      have++;
    }
    for (const a of this.agents) {
      a.soldier.skill = (a.chad ? Math.max(1.55, a.baseSkill) : a.baseSkill) * (1 + 0.35 * heat);
      if (a.chad) a.personality.aggression = Math.max(a.personality.aggression, 0.85);
    }
  }

  /** Everyone drops what they're doing and storms `track` (SAIN-style push). */
  rush(track: () => THREE.Vector3 | null): boolean {
    const L = this.leader;
    const at = track();
    if (!L || !at || this.extracted || this.exit) return false;
    this.goal = { kind: 'rush', at: at.clone(), track, time: 0 };
    for (const a of this.agents) {
      a.plan = null;
      a.errand = null;
    }
    return true;
  }

  get rushing(): boolean {
    return this.goal?.kind === 'rush';
  }

  /** Extraction: head for `at`, hold it, leave the map. */
  extractTo(at: THREE.Vector3, done: () => void): void {
    this.exit = { at, done };
    this.noRespawn = true;
    this.goal = null;
    for (const a of this.agents) {
      a.plan = null;
      a.errand = null;
    }
  }

  update(dt: number, world: Combatant[]): void {
    if (this.extracted) return;
    this.squad.update(dt);
    const mates = this.mates;
    mates.length = 0;
    for (const a of this.agents) mates.push(a.soldier);
    for (const a of this.agents) {
      a.refreshSelf();
      a.update(dt, world, mates);
    }
    // Wipe → respawn somewhere random (raiders don't come back).
    const L = this.leader;
    if (!L && this.aliveCount === 0) {
      if (this.def.style === 'hunter' || this.noRespawn) return;
      if (this.respawnTimer < 0) this.respawnTimer = 12;
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.redeploy(this.ctx.respawnPoint());
      return;
    }
    assignRevives(this.agents);
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 1.2 + Math.random() * 0.6;
      this.think();
    }
    if (this.def.economy && !this.exit) {
      this.errandTimer -= dt;
      if (this.errandTimer <= 0) {
        this.errandTimer = 2 + Math.random();
        const sv = this.ctx.survival;
        // No shopping on the way to a drop, a hunt or a rush.
        const busy = this.goal && (this.goal.kind === 'contest' || this.goal.kind === 'hunt' || this.goal.kind === 'rush' || this.goal.kind === 'extract');
        for (const a of this.agents) {
          if (busy || a.target || a.reviveTarget) continue;
          const e = planErrand(a, sv, this.ctx.map, { maxDist: 35, doorsNear: null, doorKeep: 0 });
          if (e) a.errand = e;
        }
      }
    }
    if (L) this.giveOrders(dt, L);
  }

  /** Bring the core members back at `at` (wipe respawn, next raid). They lose their guns, keep their money. */
  redeploy(at: THREE.Vector3): void {
    this.respawnTimer = -1;
    const core = this.agents.slice(0, SQUAD_SIZE);
    // Hires leave the map (body, colliders and light hidden) and wait to be hired again.
    for (let i = SQUAD_SIZE; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.leave();
      this.squad.remove(a.bot);
      this.spare.push(a);
    }
    this.agents.length = 0;
    core.forEach((a, i) => {
      const p = this.ctx.deps.nav.nearestWalkable(at.x + (i % 2) * 1.5 - 0.75, at.z + ((i / 2) | 0) * 1.3, new THREE.Vector3(), 4) ?? at;
      a.spawn(p, Math.random() * Math.PI * 2);
      if (this.def.economy) a.arm(SIDEARM);
      this.agents.push(a);
    });
    this.goal = null;
  }

  private giveOrders(dt: number, L: TeamAgent): void {
    const g = this.goal;
    if (g) {
      g.time += dt;
      if (g.track) {
        const p = g.track();
        if (p) g.at.copy(p);
        else this.goal = null;
      }
      if (g.time > (g.kind === 'rush' ? 70 : g.kind === 'extract' || g.kind === 'contest' ? 120 : 45)) this.goal = null; // stuck: rethink
      // The drop was taken (or lost): back to the squad's own business.
      if (g.kind === 'contest' && !this.ctx.drop?.()) this.goal = null;
      // Walking nowhere (no route, wedged): not 2 minutes of standing still, a rethink.
      if (L.soldier.pos.distanceToSquared(this.stallAt) > 9) {
        this.stallAt.copy(L.soldier.pos);
        this.stallTime = 0;
      } else if ((this.stallTime += dt) > 15 && L.bot.decision === 'FOLLOW' && L.distTo(g.at) > 6) {
        this.goal = null;
        this.stallTime = 0;
      }
    }
    const fast = g && (g.kind === 'hunt' || g.kind === 'retreat' || g.kind === 'rush' || g.kind === 'extract' || g.kind === 'contest');
    // The squad has somewhere to be: every member's tactical mind weighs it (see Bot.objective).
    const urgency = fast ? 1 : 0;
    for (const a of this.agents) a.bot.objective = urgency;
    // Persistent order objects, mutated in place (this runs every frame).
    if (g) {
      const o = L.gotoOrder;
      o.at = g.at;
      o.speed = fast ? (g.kind === 'rush' ? 4.3 : 3.7) : 2.6;
      L.order = o;
    } else L.order = L.holdOrder;
    // At the exit: hold it for a few seconds, then everyone still standing is out.
    if (g && g.kind === 'extract' && this.exit) {
      if (L.distTo(g.at) < 3.2) {
        L.order = L.holdOrder;
        this.exitHold += dt;
        if (this.exitHold >= 6) {
          for (const a of this.agents) if (a.alive && !a.downed && a.distTo(g.at) < 25) a.leave();
          for (const a of this.agents) if (a.alive) a.leave();
          this.extracted = true;
          this.exit.done();
          this.goal = null;
        }
      } else this.exitHold = Math.max(0, this.exitHold - dt);
    } else if (g && g.kind === 'rush' && L.distTo(g.at) < 6) {
      this.goal = null; // on them: the fight takes over
    } else if (g && L.distTo(g.at) < 2.2) {
      if (g.hold && g.time < g.hold) L.order = L.holdOrder;
      else {
        g.run?.();
        this.goal = null;
      }
    }
    for (const a of this.agents) {
      if (a === L || !a.alive || a.downed) continue;
      // Lone wolves sometimes wander after their own target.
      if (a.order.kind === 'goto' && a.distTo(a.order.at) > 1.5 && Math.random() > 0.002) continue;
      if (a.plan) continue;
      a.followTarget = L;
      a.order = a.followOrder;
    }
  }

  // ---------------------------------------------------------------- the brain

  private think(): void {
    const L = this.leader;
    if (!L) return;
    // Swarmed: fall back away from the pack, regroup, then carry on.
    if (this.def.style !== 'hunter' && this.goal?.kind !== 'retreat') {
      const near = this.ctx.robots().filter((r) => r.aggro && r.pos.distanceTo(L.soldier.pos) < 14);
      const hurt = this.agents.filter((a) => a.alive && (a.downed || a.hp < 0.4)).length;
      if (near.length > this.aliveCount * 2 + 1 || (near.length > 2 && hurt >= Math.max(2, this.aliveCount - 1))) {
        const c = new THREE.Vector3();
        for (const r of near) c.add(r.pos);
        c.divideScalar(near.length);
        const away = this.pointAway(L.soldier.pos, c, 14);
        if (away) {
          this.goal = { kind: 'retreat', at: away, time: 0 };
          L.plan = null;
          return;
        }
      }
    }
    if (this.exit && this.goal?.kind !== 'extract') {
      // Extraction overrides everything but a retreat from a swarm.
      if (this.goal?.kind !== 'retreat') this.goal = { kind: 'extract', at: this.exit.at.clone(), time: 0 };
      return;
    }
    // A supply drop is announced or down: everyone goes for it (that's where teams meet).
    // Only a fight already on (a hunt after being shot at) or a retreat comes first.
    const drop = this.ctx.drop?.();
    if (drop && this.def.style !== 'hunter' && this.def.economy !== false && this.goal?.kind !== 'contest' && this.goal?.kind !== 'retreat' && this.goal?.kind !== 'hunt') {
      this.goal = { kind: 'contest', at: drop.clone(), time: 0 };
      for (const a of this.agents) a.plan = null;
      return;
    }
    if (this.goal) return;
    if (this.def.style === 'hunter') return this.hunt(L);
    // Late game: squads go looking for the gunfight instead of farming.
    const heat = this.ctx.heat?.() ?? 0;
    if (heat > 0.25 && Math.random() < heat * 0.35) {
      const heard = (this.ctx.intel?.(this.def.id) ?? []).sort((a, b) => L.distTo(a.pos) - L.distTo(b.pos))[0];
      if (heard && L.distTo(heard.pos) < 90) {
        this.goal = { kind: 'hunt', at: heard.pos.clone(), time: 0 };
        L.plan = null;
        return;
      }
    }
    // Lone wolves go after their own plan now and then.
    for (const a of this.agents) {
      if (a === L || !a.alive || a.downed || a.plan || a.target) continue;
      if (Math.random() < a.personality.loner * 0.25) a.plan = planFor(a, this.planContext());
    }
    // The leader is out shopping: the squad waits for them.
    if (L.errand) return;
    const sv = this.ctx.survival;
    const map = this.ctx.map;
    const rich = this.richest();
    if (!rich) return;
    const reach = sv.reachable(map.zoneAt(L.soldier.pos.x, L.soldier.pos.z));

    // 1) Hire a contractor when short-handed and someone is rich.
    if (rich.points > 2600 && this.aliveCount < MAX_SQUAD) {
      const term = map.terminals
        .filter((t) => reach.has(map.zoneAt(t.pos.x, t.pos.z) ?? ''))
        .sort((a, b) => L.distTo(a.pos) - L.distTo(b.pos))[0];
      if (term && L.distTo(term.pos) < 60) {
        const at = term.pos.clone().add(new THREE.Vector3(Math.sin(term.yaw) * 1.3, -term.pos.y, Math.cos(term.yaw) * 1.3));
        this.goal = {
          kind: 'hire', at, time: 0,
          run: () => {
            if (rich.alive && rich.points >= term.cost) {
              rich.points -= term.cost;
              this.addAgent(at, 0);
            }
          },
        };
        return;
      }
    }

    // 2) The leader's plan: the gun they want (buy / open the way / farm for it), or a push on a team we heard.
    if (L.plan) return;
    const plan = planFor(L, this.planContext());
    if (plan) {
      L.plan = plan;
      return;
    }

    // 3) Nothing to aim for: open a shutter into unexplored space (cheapest/closest first), the squad chips in.
    const doors = sv.doors
      .filter((d) => !d.open && d.cost <= this.agents.reduce((s, a) => s + (a.alive ? a.points : 0), 0) - 200 && reach.has(d.zones[0]) !== reach.has(d.zones[1]))
      .map((d) => {
        const n = d.slot.alongX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const side = this.tmp.copy(d.slot.center).addScaledVector(n, 1.6);
        const zoneA = map.zoneAt(side.x, side.z);
        const at = (zoneA && reach.has(zoneA) ? side.clone() : d.slot.center.clone().addScaledVector(n, -1.6)).setY(0);
        return { d, at, score: L.distTo(at) + d.cost * 0.01 };
      })
      .sort((a, b) => a.score - b.score);
    if (doors.length) {
      const pick = doors[Math.random() < 0.7 ? 0 : Math.min(1, doors.length - 1)];
      this.goal = {
        kind: 'door', at: pick.at, time: 0,
        run: () => {
          const payer = this.richest();
          if (!pick.d.open && payer && payPooled(payer, this.agents, pick.d.cost)) sv.openDoor(pick.d);
        },
      };
      return;
    }

    // 3) Nothing to spend on yet: farm. Either hold a spot and let robots come to
    //    us (safer, steady points), or go hunting the awake ones nearby.
    const early = this.ctx.survival.time < 240;
    if (!early && Math.random() < (this.def.style === 'reckless' ? 0.15 : 0.3)) {
      this.goal = { kind: 'farm', at: L.soldier.pos.clone(), time: 0, hold: 7 + Math.random() * 8 };
      return;
    }
    const bot = this.ctx.robots().filter((r) => r.aggro && r.pos.distanceTo(L.soldier.pos) < 45).sort((a, b) => a.pos.distanceTo(L.soldier.pos) - b.pos.distanceTo(L.soldier.pos))[0];
    const at = bot ? bot.pos.clone() : this.randomUnlockedPoint();
    if (at) this.goal = { kind: 'roam', at, time: 0 };
  }

  /**
   * Raiders hunt by what they know, not by where everyone is: the squad's last
   * known contact, gunfire they could have heard, otherwise a sweep through
   * the rooms.
   */
  private hunt(L: TeamAgent): void {
    if (this.squad.primary && this.squad.primaryConf > 0.15) {
      this.goal = { kind: 'hunt', at: this.squad.primaryPos.clone(), time: 0 };
      return;
    }
    const heard = (this.ctx.intel?.(this.def.id) ?? [])
      .filter((i) => L.distTo(i.pos) < 95)
      .sort((a, b) => L.distTo(a.pos) - L.distTo(b.pos))[0];
    if (heard) {
      this.goal = { kind: 'hunt', at: heard.pos.clone(), time: 0 };
      return;
    }
    const at = this.randomUnlockedPoint();
    if (at) this.goal = { kind: 'roam', at, time: 0 };
  }

  private planContext(): PlanContext {
    return {
      sv: this.ctx.survival,
      map: this.ctx.map,
      robots: this.ctx.robots(),
      pool: this.agents,
      intel: this.ctx.intel?.(this.def.id) ?? [],
    };
  }

  /** A reachable point `dist` m from `from`, away from `threat` (tries angled escapes). */
  private pointAway(from: THREE.Vector3, threat: THREE.Vector3, dist: number): THREE.Vector3 | null {
    const nav = this.ctx.deps.nav;
    const ax = from.x - threat.x;
    const az = from.z - threat.z;
    const al = Math.hypot(ax, az) || 1;
    for (const ang of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const x = from.x + ((ax / al) * c - (az / al) * s) * dist;
      const z = from.z + ((ax / al) * s + (az / al) * c) * dist;
      const p = nav.nearestWalkable(x, z, new THREE.Vector3(), 3);
      if (p && this.ctx.survival.unlocked.has(this.ctx.map.zoneAt(p.x, p.z) ?? '')) return p;
    }
    return null;
  }

  private randomUnlockedPoint(): THREE.Vector3 | null {
    const sv = this.ctx.survival;
    const L = this.leader;
    const reach = L ? sv.reachable(this.ctx.map.zoneAt(L.soldier.pos.x, L.soldier.pos.z)) : sv.unlocked;
    const rooms = this.ctx.map.rooms.filter((r) => reach.has(r.zone));
    if (!rooms.length) return null;
    for (let i = 0; i < 12; i++) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const x = r.rect[0] + 3 + Math.random() * (r.rect[2] - r.rect[0] - 6);
      const z = r.rect[1] + 3 + Math.random() * (r.rect[3] - r.rect[1] - 6);
      if (this.ctx.deps.nav.walkable(x, z)) return new THREE.Vector3(x, 0, z);
    }
    return null;
  }
}
