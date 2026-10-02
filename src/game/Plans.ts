import * as THREE from 'three';
import type { Site9, WallBuy } from '../world/Site9';
import type { Survival } from './Survival';
import type { TeamAgent } from './TeamAgent';
import type { RogueRobot } from '../enemies/RogueRobot';
import { tier } from './Errands';

/**
 * A longer-term intention, the way a player thinks about a round:
 * "I want the ASVAL — I have 900 of 1600, so I farm the lifts; it's behind the
 * clean-room shutter, so we chip in and open it; now I'm strong, let's push the
 * team we heard in the atrium."
 */
export interface Plan {
  kind: 'buy' | 'door' | 'farm' | 'hunt' | 'regroup' | 'roam';
  at: THREE.Vector3;
  /** Radio line when the plan starts. */
  label: string;
  /** Done on arrival. */
  run?: () => void;
  /** Stay this long once there (farming). */
  hold?: number;
  time: number;
  /** Squad panel: what they're up to. */
  status: string;
  /** Still worth doing? (someone else opened that door, the money went...) */
  valid?: () => boolean;
}

export interface Intel {
  team: string;
  pos: THREE.Vector3;
}

export interface PlanContext {
  sv: Survival;
  map: Site9;
  robots: RogueRobot[];
  /** Teammates whose money can be pooled for doors (not the player). */
  pool: TeamAgent[];
  /** Where enemy operators were last heard (gunfire). */
  intel: Intel[];
  /** Your own squad: stay within `leash` m of this point (the player). */
  anchor?: THREE.Vector3;
  leash?: number;
}

const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
const pretty = (id: string) => id.replace(/_/g, ' ').toUpperCase();

function standAt(wb: WallBuy): THREE.Vector3 {
  return new THREE.Vector3(wb.pos.x + Math.sin(wb.yaw) * 1.2, 0, wb.pos.z + Math.cos(wb.yaw) * 1.2);
}

/** Money the squad can put together for a door (each keeps a little). */
export function poolMoney(payer: TeamAgent, pool: TeamAgent[]): number {
  let sum = payer.points;
  for (const m of pool) if (m !== payer && m.alive) sum += Math.max(0, m.points - 150);
  return sum;
}

/** Pay `cost` from the payer first, then the others. */
export function payPooled(payer: TeamAgent, pool: TeamAgent[], cost: number): boolean {
  if (poolMoney(payer, pool) < cost) return false;
  let left = cost;
  const take = (a: TeamAgent, keep: number) => {
    const t = Math.min(left, Math.max(0, a.points - keep));
    a.points -= t;
    left -= t;
  };
  take(payer, 0);
  for (const m of pool) if (left > 0 && m !== payer && m.alive) take(m, 150);
  return left <= 0;
}

export function planFor(a: TeamAgent, c: PlanContext): Plan | null {
  const { sv, map } = c;
  const pos = a.soldier.pos;
  const zoneOf = (p: THREE.Vector3) => map.zoneAt(p.x, p.z) ?? '';
  // Only what this operator can walk to counts (other teams open doors elsewhere too).
  const reach = sv.reachable(map.zoneAt(pos.x, pos.z));
  const open = (p: THREE.Vector3) => reach.has(zoneOf(p));

  // Too far from the squad: regroup first.
  if (c.anchor && c.leash && flat(pos, c.anchor) > c.leash) {
    return { kind: 'regroup', at: c.anchor.clone(), label: 'Coming back to you.', time: 0, status: 'regroup' };
  }

  // 1) The gun I want: the best upgrade I could afford soon (unlocked or one shutter away).
  const myTier = tier(a.soldier.weaponId);
  const budget = Math.max(1100, a.points + 1300);
  let want: { wb: WallBuy; door: (typeof sv.doors)[number] | null } | null = null;
  for (const wb of map.wallBuys) {
    if (tier(wb.weapon) <= myTier || wb.cost > budget) continue;
    let door: (typeof sv.doors)[number] | null = null;
    if (!open(wb.pos)) {
      // Behind a closed shutter between open ground and the weapon's zone?
      const z = map.zoneAt(wb.pos.x, wb.pos.z);
      door = sv.doors.find((d) => !d.open && d.zones.includes(z ?? '') && d.zones.some((x) => x !== z && reach.has(x))) ?? null;
      if (!door) continue;
    }
    if (!want || tier(wb.weapon) > tier(want.wb.weapon) || (tier(wb.weapon) === tier(want.wb.weapon) && flat(wb.pos, pos) < flat(want.wb.pos, pos))) want = { wb, door };
  }

  if (want && !want.door && a.points >= want.wb.cost) {
    const wb = want.wb;
    return {
      kind: 'buy', at: standAt(wb), time: 0, status: `buying ${pretty(wb.weapon)}`,
      valid: () => a.points >= wb.cost,
      label: `Got the cash, going for the ${pretty(wb.weapon)}.`,
      run: () => {
        if (a.points >= wb.cost && tier(wb.weapon) > tier(a.soldier.weaponId)) {
          a.points -= wb.cost;
          a.arm(wb.weapon);
          a.say(`${pretty(wb.weapon)} acquired.`, true);
        }
      },
    };
  }
  if (want?.door && poolMoney(a, c.pool) >= want.door.cost + (a.points >= want.wb.cost ? 0 : 0)) {
    const d = want.door;
    const n = d.slot.alongX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const side = d.slot.center.clone().addScaledVector(n, 1.6).setY(0);
    const at = open(side) ? side : d.slot.center.clone().addScaledVector(n, -1.6).setY(0);
    const chip = a.points < d.cost;
    return {
      kind: 'door', at, time: 0, status: `opening $${d.cost}`,
      valid: () => !d.open,
      label: `Opening the shutter to the ${pretty(want.wb.weapon)} ($${d.cost}${chip ? ', chipping in together' : ''}).`,
      run: () => {
        if (!d.open && payPooled(a, c.pool, d.cost)) sv.openDoor(d);
      },
    };
  }

  // 2) Strong enough: go after a team we heard.
  if (myTier >= 1400 && a.personality.aggression > 0.35 && c.intel.length && Math.random() < 0.5 + a.personality.aggression * 0.4) {
    const target = c.intel
      .filter((i) => open(i.pos))
      .sort((x, y) => flat(x.pos, pos) - flat(y.pos, pos))[0];
    if (target && (!c.anchor || !c.leash || flat(target.pos, c.anchor) < c.leash)) {
      const name = target.team === 'alpha' ? 'Vanta' : target.team[0].toUpperCase() + target.team.slice(1);
      return { kind: 'hunt', at: target.pos.clone(), time: 0, status: `pushing ${name}`, label: `Heard ${name} nearby. Pushing them.` };
    }
  }

  // 3) Farm for it: awake robots nearby, otherwise watch a lift (they come out of those).
  const goal = want ? `${pretty(want.wb.weapon)} ${a.points}/${want.door ? want.door.cost : want.wb.cost}` : 'points';
  const bots = c.robots.filter((r) => r.aggro && flat(r.pos, pos) < 45);
  if (bots.length) {
    const r = bots.sort((x, y) => flat(x.pos, pos) - flat(y.pos, pos))[0];
    return { kind: 'farm', at: r.pos.clone(), time: 0, hold: 6, status: `farming (${goal})`, label: `Saving for the ${goal}. Hunting bots.` };
  }
  // Early game: keep moving. Sweep a room you can reach (bots wake up as you pass)
  // instead of camping a lift with nothing to buy yet.
  if (sv.time < 240 && Math.random() < 0.7) {
    const rooms = map.rooms.filter((r) => reach.has(r.zone));
    for (let i = 0; i < 10 && rooms.length; i++) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const at = new THREE.Vector3(r.rect[0] + 3 + Math.random() * (r.rect[2] - r.rect[0] - 6), 0, r.rect[1] + 3 + Math.random() * (r.rect[3] - r.rect[1] - 6));
      if (flat(at, pos) < 15 || (c.anchor && c.leash && flat(at, c.anchor) > c.leash)) continue;
      return { kind: 'roam', at, time: 0, status: 'sweeping', label: `Sweeping the ${r.name} for bots.` };
    }
  }
  const lifts = map.spawnPoints
    .filter((s) => s.kind === 'lift' && reach.has(s.zone) && (!c.anchor || !c.leash || flat(s.pos, c.anchor) < c.leash))
    .sort((x, y) => flat(x.pos, pos) - flat(y.pos, pos));
  if (lifts.length) {
    const s = lifts[Math.min(lifts.length - 1, (Math.random() * 2) | 0)];
    // Stand back from the doors, not in them.
    const away = new THREE.Vector3(pos.x - s.pos.x, 0, pos.z - s.pos.z).normalize().multiplyScalar(7);
    const at = s.pos.clone().add(away);
    return { kind: 'farm', at, time: 0, hold: 9 + Math.random() * 9, status: `farming (${goal})`, label: `Saving for the ${goal}. Watching the lift.` };
  }
  return null;
}
