import * as THREE from 'three';
import { GROUPS, type Physics } from '../core/Physics';
import type { NavGrid } from './NavGrid';

/** A place to fight or hide from one threat position. */
export interface CoverSpot {
  pos: THREE.Vector3;
  /** Where to stand to see the threat: the same spot for low cover (stand up), a side step for full cover, null = hide only. */
  peek: THREE.Vector3 | null;
  /** Waist-high cover: crouch to hide, stand to shoot. */
  low: boolean;
  score: number;
  /** Threat position it was judged against. */
  threat: THREE.Vector3;
}

export interface CoverQuery {
  nav: NavGrid;
  physics: Physics;
  /** Bot position. */
  from: THREE.Vector3;
  /** Estimated threat position (feet). */
  threat: THREE.Vector3;
  /** fight: must be able to peek/shoot · hide: just protection · retreat: away from the threat. */
  mode: 'fight' | 'hide' | 'retreat';
  owner: object;
  now: number;
  /** Search radius around `around` (default 14 m). */
  maxDist?: number;
  /** Search centre (default: the bot). */
  around?: THREE.Vector3;
  /** Ideal distance to the threat (weapon range) for fighting cover. */
  preferRange?: number;
  /** Extra penalty for a point (danger zones, the player's fire lane...). */
  avoid?: (p: THREE.Vector3) => number;
  /** Covers used recently (don't bounce between the same two). */
  exclude?: readonly { pos: THREE.Vector3 }[];
  /** Debug sink: every candidate that got ray-tested. */
  debug?: { pos: THREE.Vector3; ok: boolean }[];
  /** Phones: ray-test fewer candidates. */
  lowSpec?: boolean;
}

/**
 * Cover reservations: one bot per spot. A reservation lapses on its own, so a
 * bot that dies or forgets never blocks a cover forever.
 */
class CoverRegistry {
  private res = new Map<object, { pos: THREE.Vector3; until: number }>();

  reserve(owner: object, pos: THREE.Vector3, now: number, hold = 14): void {
    const r = this.res.get(owner);
    if (r) {
      r.pos.copy(pos);
      r.until = now + hold;
    } else this.res.set(owner, { pos: pos.clone(), until: now + hold });
  }

  release(owner: object): void {
    this.res.delete(owner);
  }

  /** Someone else holds (or stands on) a spot within `r` of `p`. */
  taken(p: THREE.Vector3, owner: object, now: number, r = 1.7): boolean {
    for (const [o, v] of this.res) {
      if (o === owner) continue;
      if (v.until < now) {
        this.res.delete(o);
        continue;
      }
      const dx = v.pos.x - p.x;
      const dz = v.pos.z - p.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** Debug: all live reservations. */
  *all(now: number): Generator<THREE.Vector3> {
    for (const v of this.res.values()) if (v.until >= now) yield v.pos;
  }
}

export const coverRegistry = new CoverRegistry();

const A = new THREE.Vector3();
const B = new THREE.Vector3();
/** findCover scratch: ring probes and peek steps (only keepers get cloned). */
const PROBE = new THREE.Vector3();
const PEEK = new THREE.Vector3();
const at = (p: THREE.Vector3, y: number) => B.set(p.x, y, p.z);

/** Line from the threat's eyes to a height at `p` is blocked. */
function blocked(physics: Physics, eye: THREE.Vector3, p: THREE.Vector3, y: number): boolean {
  return !physics.lineOfSight(eye, at(p, y), GROUPS.sight);
}

/** Is `pos` hidden from `threat` (chest line blocked; crouched: the crouched head line)? */
export function protectedFrom(physics: Physics, pos: THREE.Vector3, threat: THREE.Vector3, crouched: boolean): boolean {
  A.set(threat.x, 1.5, threat.z);
  return blocked(physics, A, pos, crouched ? 0.95 : 1.3);
}

/** Can someone at `from` (standing) see the area around `to`? */
export function canSee(physics: Physics, from: THREE.Vector3, to: THREE.Vector3, fromY = 1.5, toY = 1.2): boolean {
  A.set(from.x, fromY, from.z);
  return physics.lineOfSight(A, at(to, toY), GROUPS.sight);
}

/**
 * Dynamic cover: no hand-placed points. Candidates are walkable nav cells that
 * touch something solid, sampled in rings; the cheapest-looking few are tested
 * with rays from the threat (protection standing / crouched), for a peek spot
 * (fighting cover), for an exposed approach, and for a way out behind.
 */
export function findCover(q: CoverQuery): CoverSpot | null {
  const { nav, physics } = q;
  const center = q.around ?? q.from;
  const maxDist = q.maxDist ?? 14;
  const eye = new THREE.Vector3(q.threat.x, 1.5, q.threat.z);
  const ax = q.from.x - q.threat.x;
  const az = q.from.z - q.threat.z;
  const al = Math.hypot(ax, az) || 1;
  const away = new THREE.Vector3(ax / al, 0, az / al);
  const perp = new THREE.Vector3(-away.z, 0, away.x);
  const dFrom = al;
  const pr = q.preferRange ?? 20;

  // 1) Candidates: cells hugging geometry, in rings around the centre.
  const cands: { p: THREE.Vector3; pre: number }[] = [];
  const seen = new Set<number>();
  for (let r = 1.5; r <= maxDist; r += 1.5) {
    const n = Math.max(6, Math.round((2 * Math.PI * r) / 1.6));
    const off = Math.random() * ((2 * Math.PI) / n);
    for (let k = 0; k < n; k++) {
      const a = off + (k * 2 * Math.PI) / n;
      const p = nav.nearestWalkable(center.x + Math.sin(a) * r, center.z + Math.cos(a) * r, PROBE, 0.75);
      if (!p || !nav.nearWall(p.x, p.z)) continue;
      const cell = nav.cellIndex(p.x, p.z);
      if (seen.has(cell)) continue;
      seen.add(cell);
      if (coverRegistry.taken(p, q.owner, q.now)) continue;
      if (q.exclude?.some((e) => e.pos.distanceToSquared(p) < 4)) continue;
      const dT = Math.hypot(p.x - q.threat.x, p.z - q.threat.z);
      if (q.mode === 'retreat' ? dT < dFrom + 3 : dT < 4) continue;
      const travel = Math.hypot(p.x - q.from.x, p.z - q.from.z);
      let pre = travel * 0.07;
      if (q.mode === 'fight') pre += (Math.abs(dT - pr) / pr) * 0.8;
      else if (q.mode === 'retreat') pre -= Math.min(30, dT - dFrom) * 0.04;
      // Moving toward the threat to get to cover is riskier.
      if (q.mode !== 'retreat' && dT < dFrom - 2) pre += (dFrom - dT) * 0.03;
      pre += q.avoid?.(p) ?? 0;
      pre += Math.random() * 0.12;
      cands.push({ p: p.clone(), pre });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.pre - b.pre);

  // 2) Ray-test the best few.
  let best: CoverSpot | null = null;
  const K = Math.min(cands.length, q.lowSpec ? 4 : 7);
  for (let i = 0; i < K; i++) {
    const { p, pre } = cands[i];
    // Standing head and chest hidden = full cover; a crouched head (~0.95 m) hidden = low cover.
    const head = blocked(physics, eye, p, 1.6);
    const chest = head ? blocked(physics, eye, p, 1.25) : false;
    const full = head && chest;
    const lowCover = !full && blocked(physics, eye, p, 0.95);
    const ok = full || lowCover;
    q.debug?.push({ pos: p, ok });
    if (!ok) continue;
    let score = pre + (full ? 0 : 0.2);
    let peek: THREE.Vector3 | null = null;
    if (lowCover) peek = p.clone();
    else if (q.mode !== 'retreat') {
      const sides = Math.random() < 0.5 ? [1, -1] : [-1, 1];
      outer: for (const s of sides) {
        for (const o of [0.9, 1.4]) {
          const pk = PEEK.set(p.x + perp.x * s * o, 0, p.z + perp.z * s * o);
          if (!nav.walkable(pk.x, pk.z) || !nav.clearLine(p.x, p.z, pk.x, pk.z)) continue;
          A.set(pk.x, 1.5, pk.z);
          if (physics.lineOfSight(A, B.set(q.threat.x, 1.3, q.threat.z), GROUPS.sight)) {
            peek = pk.clone();
            break outer;
          }
        }
      }
    }
    if (q.mode === 'fight' && !peek) score += 0.8;
    // Exposed on the way there?
    const mid = A.set((q.from.x + p.x) / 2, 0, (q.from.z + p.z) / 2);
    if (!blocked(physics, eye, mid, 1.2)) score += q.mode === 'retreat' ? 0.5 : 0.3;
    // A way out behind.
    if (nav.walkable(p.x + away.x * 2.5, p.z + away.z * 2.5)) score -= 0.12;
    if (!best || score < best.score) best = { pos: p, peek, low: lowCover, score, threat: q.threat.clone() };
  }
  return best;
}
