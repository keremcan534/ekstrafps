import * as THREE from 'three';
import type { SoldierDeps } from '../enemies/Soldier';
import type { SoldierPalette } from '../enemies/SoldierSkin';
import type { WeaponData } from '../weapons/WeaponData';
import type { Site9 } from '../world/Site9';
import type { Survival } from './Survival';
import type { RogueRobot } from '../enemies/RogueRobot';
import { TeamAgent, randomPersonality, type Combatant } from './TeamAgent';
import type { DamageInfo } from '../targets/Humanoid';
import { SIDEARM, planErrand } from './Errands';
import { payPooled, planFor, type Intel, type PlanContext } from './Plans';

export interface TeamDef {
  id: string;
  name: string;
  /** CSS colour for HUD/map. */
  color: string;
  palette: SoldierPalette;
  /** disciplined: moves as a unit · reckless: spreads out, lone wolves · balanced · hunter: Black Division raid. */
  style: 'disciplined' | 'reckless' | 'balanced' | 'hunter';
  start: THREE.Vector3;
  /** Earns/spends points (false for raiders). */
  economy: boolean;
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
  kind: 'door' | 'hire' | 'roam' | 'hunt' | 'retreat' | 'farm';
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
  /** Focus fire: the squad's current priority target. */
  private shared = { focus: null as Combatant | null, focusTime: 0 };
  respawnTimer = -1;
  private goal: Goal | null = null;
  private thinkTimer = Math.random();
  private errandTimer = Math.random() * 2;
  private tmp = new THREE.Vector3();

  constructor(readonly def: TeamDef, private ctx: TeamContext, size = SQUAD_SIZE) {
    for (let i = 0; i < size; i++) this.addAgent(def.start.clone().add(new THREE.Vector3((i % 2) * 1.6 - 0.8, 0, ((i / 2) | 0) * 1.5)));
  }

  get leader(): TeamAgent | null {
    return this.agents.find((a) => a.alive && !a.downed) ?? null;
  }

  get aliveCount(): number {
    return this.agents.filter((a) => a.alive).length;
  }

  private richest(): TeamAgent | null {
    let best: TeamAgent | null = null;
    for (const a of this.agents) if (a.alive && !a.downed && (!best || a.points > best.points)) best = a;
    return best;
  }

  private addAgent(at: THREE.Vector3, points = 500): TeamAgent {
    const loner = this.def.style === 'reckless' ? 0.45 : this.def.style === 'balanced' ? 0.15 : 0.03;
    const agent = new TeamAgent(this.ctx.deps, this.def.id, agentIndex++ % 16, randomPersonality(loner), this.def.palette, {
      onHit: (a, info, killed) => {
        this.ctx.survival.onSoldierHit(this.def.id, info, killed);
        if (killed) this.ctx.onKill?.(a, info);
        this.underFire(a, info);
      },
    });
    agent.squad = this.shared;
    agent.armory = (id) => this.ctx.weaponData(id);
    agent.soldier.skill = this.def.style === 'hunter' ? 0.95 : 1.15;
    agent.points = this.def.economy ? points : 0;
    // Go down (revivable) while a teammate is still standing. Raiders just die.
    agent.soldier.body.canGoDown = () => this.def.style !== 'hunter' && this.agents.some((a) => a !== agent && a.alive && !a.downed);
    const at2 = this.ctx.deps.nav.nearestWalkable(at.x, at.z, new THREE.Vector3(), 4) ?? at;
    agent.spawn(at2, Math.random() * Math.PI * 2);
    if (this.def.economy) agent.arm(SIDEARM);
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
    const from = new THREE.Vector3().copy(h.point).addScaledVector(h.direction, -Math.max(2, h.distance));
    from.y = 0;
    for (const m of this.agents) if (m.alive && !m.downed && m.distTo(a.soldier.pos) < 45) m.alert(from, m === a);
    if (this.def.style === 'hunter') return;
    const busy = this.goal && (this.goal.kind === 'retreat' || this.goal.kind === 'hire');
    if (!busy && this.aliveCount >= 2) {
      this.goal = { kind: 'hunt', at: from, time: 20 };
      const L = this.leader;
      if (L) L.plan = null;
    }
  }

  update(dt: number, world: Combatant[]): void {
    this.shared.focusTime -= dt;
    if (this.shared.focusTime <= 0 || (this.shared.focus && (!this.shared.focus.alive || this.shared.focus.downed))) this.shared.focus = null;
    const mates = this.agents.map((a) => a.soldier);
    for (const a of this.agents) {
      a.refreshSelf();
      a.update(dt, world, mates);
    }
    // Wipe → respawn somewhere random (raiders don't come back).
    if (this.aliveCount === 0) {
      if (this.def.style === 'hunter') return;
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
    if (this.def.economy) {
      this.errandTimer -= dt;
      if (this.errandTimer <= 0) {
        this.errandTimer = 2 + Math.random();
        const sv = this.ctx.survival;
        for (const a of this.agents) {
          if (a.target || a.reviveTarget) continue;
          const e = planErrand(a, sv, this.ctx.map, { maxDist: 35, doorsNear: null, doorKeep: 0 });
          if (e) a.errand = e;
        }
      }
    }
    this.giveOrders(dt);
  }

  /** Bring the core members back at `at` (wipe respawn, next raid). They lose their guns, keep their money. */
  redeploy(at: THREE.Vector3): void {
    this.respawnTimer = -1;
    const core = this.agents.slice(0, SQUAD_SIZE);
    this.agents.length = 0;
    core.forEach((a, i) => {
      const p = this.ctx.deps.nav.nearestWalkable(at.x + (i % 2) * 1.5 - 0.75, at.z + ((i / 2) | 0) * 1.3, new THREE.Vector3(), 4) ?? at;
      a.spawn(p, Math.random() * Math.PI * 2);
      if (this.def.economy) a.arm(SIDEARM);
      this.agents.push(a);
    });
    this.goal = null;
  }

  private giveOrders(dt: number): void {
    const L = this.leader;
    if (!L) return;
    const g = this.goal;
    if (g) {
      g.time += dt;
      if (g.time > 45) this.goal = null; // stuck: rethink
    }
    L.order = g ? { kind: 'goto', at: g.at, speed: g.kind === 'hunt' || g.kind === 'retreat' ? 3.7 : 2.6 } : { kind: 'hold' };
    if (g && L.distTo(g.at) < 2.2) {
      if (g.hold && g.time < g.hold) L.order = { kind: 'hold' };
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
      a.order = { kind: 'follow', leader: () => (L.alive && !L.downed ? { pos: L.soldier.pos, yaw: L.soldier.yaw, speed: Math.hypot(L.soldier.vel.x, L.soldier.vel.z) } : null) };
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
    if (this.goal) return;
    if (this.def.style === 'hunter') return this.hunt(L);
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
    if (Math.random() < (this.def.style === 'reckless' ? 0.2 : 0.5)) {
      this.goal = { kind: 'farm', at: L.soldier.pos.clone(), time: 0, hold: 15 + Math.random() * 15 };
      return;
    }
    const bot = this.ctx.robots().filter((r) => r.aggro && r.pos.distanceTo(L.soldier.pos) < 45).sort((a, b) => a.pos.distanceTo(L.soldier.pos) - b.pos.distanceTo(L.soldier.pos))[0];
    const at = bot ? bot.pos.clone() : this.randomUnlockedPoint();
    if (at) this.goal = { kind: 'roam', at, time: 0 };
  }

  /** Raiders: straight for the nearest enemy anywhere. */
  private hunt(L: TeamAgent): void {
    let best: Combatant | null = null;
    let bd = Infinity;
    for (const c of this.ctx.world()) {
      if (c.team === this.def.id || !c.alive || c.kind === 'robot') continue;
      const d = L.distTo(c.pos);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) this.goal = { kind: 'hunt', at: best.pos.clone(), time: 30 };
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
