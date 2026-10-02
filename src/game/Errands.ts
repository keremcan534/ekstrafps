import * as THREE from 'three';
import { WEAPON_PRICES, type Site9 } from '../world/Site9';
import type { Survival } from './Survival';
import type { TeamAgent } from './TeamAgent';

/** A short trip an operator makes with their own money: buy a gun, restock, open a door. */
export interface Errand {
  kind: 'weapon' | 'ammo' | 'door';
  /** What the operator says on the radio when setting off. */
  label: string;
  at: THREE.Vector3;
  run(): void;
  time: number;
}

export const SIDEARM = 'heavy_pistol';
export const AMMO_COST = 400;
export const tier = (id: string) => WEAPON_PRICES[id] ?? 0;

export interface ErrandOptions {
  /** Only consider things this close to the operator. */
  maxDist: number;
  /** Doors: open one near this point (the squad leader / player), or never when null. */
  doorsNear: THREE.Vector3 | null;
  /** Money an operator keeps in reserve after a door. */
  doorKeep: number;
  /** How far from `doorsNear` a door may be. */
  doorDist?: number;
}

const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * What would this operator do with their money right now? A better gun from a
 * wall-buy in reach, a restock when running low, or a shutter into new ground.
 * Everyone plays the same economy as the player: same prices, same places.
 */
export function planErrand(a: TeamAgent, sv: Survival, map: Site9, o: ErrandOptions): Errand | null {
  if (!a.alive || a.downed || a.errand) return null;
  const s = a.soldier;
  const pos = s.pos;
  const zoneOk = (p: THREE.Vector3) => sv.unlocked.has(map.zoneAt(p.x, p.z) ?? '');

  // 1) A better weapon (best tier we can afford, nearest of those).
  let wb: { at: THREE.Vector3; cost: number; id: string } | null = null;
  for (const w of map.wallBuys) {
    if (tier(w.weapon) <= tier(s.weaponId) || w.cost > a.points - 50 || !zoneOk(w.pos)) continue;
    const at = w.pos.clone().add(new THREE.Vector3(Math.sin(w.yaw) * 1.2, -w.pos.y, Math.cos(w.yaw) * 1.2));
    if (flat(at, pos) > o.maxDist) continue;
    if (!wb || tier(w.weapon) > tier(wb.id) || (tier(w.weapon) === tier(wb.id) && flat(at, pos) < flat(wb.at, pos))) wb = { at, cost: w.cost, id: w.weapon };
  }
  if (wb) {
    const w = wb;
    return {
      kind: 'weapon', at: w.at, time: 0, label: `Grabbing the ${w.id.replace(/_/g, ' ').toUpperCase()}, I've got the cash.`,
      run: () => {
        if (a.points >= w.cost) {
          a.points -= w.cost;
          a.arm(w.id);
        }
      },
    };
  }

  // 2) Restock when the bought gun is running dry.
  if (s.weaponId !== SIDEARM && s.reserve < s.magSize * 2 && a.points >= AMMO_COST) {
    let best: THREE.Vector3 | null = null;
    for (const c of sv.ammoCaches) if (zoneOk(c) && flat(c, pos) < o.maxDist && (!best || flat(c, pos) < flat(best, pos))) best = c;
    if (best) {
      return {
        kind: 'ammo', at: best, time: 0, label: 'Running low, restocking ammo.',
        run: () => {
          if (a.points >= AMMO_COST) {
            a.points -= AMMO_COST;
            a.restock();
          }
        },
      };
    }
  }

  // 3) Open the way: a shutter between opened and closed ground, near the squad.
  if (o.doorsNear) {
    const near = o.doorsNear;
    let pick: { at: THREE.Vector3; d: (typeof sv.doors)[number]; dist: number } | null = null;
    for (const d of sv.doors) {
      if (d.open || d.cost > a.points - o.doorKeep) continue;
      if (sv.unlocked.has(d.zones[0]) === sv.unlocked.has(d.zones[1])) continue;
      const n = d.slot.alongX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const side = d.slot.center.clone().addScaledVector(n, 1.6);
      const at = zoneOk(side) ? side : d.slot.center.clone().addScaledVector(n, -1.6);
      const dist = flat(at, near);
      if (dist > (o.doorDist ?? o.maxDist) || (pick && dist >= pick.dist)) continue;
      pick = { at, d, dist };
    }
    if (pick) {
      const p = pick;
      return {
        kind: 'door', at: p.at.setY(0), time: 0, label: `I'll open this one, ${p.d.cost} on me.`,
        run: () => {
          if (!p.d.open && a.points >= p.d.cost) {
            a.points -= p.d.cost;
            sv.openDoor(p.d);
          }
        },
      };
    }
  }
  return null;
}
