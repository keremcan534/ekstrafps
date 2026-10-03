import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { NavGrid } from './NavGrid';
import { canSee } from './Cover';

const DEG = Math.PI / 180;

export interface FlankPlan {
  /** Waypoints to walk (path from the nav grid). */
  route: THREE.Vector3[];
  dest: THREE.Vector3;
  side: 1 | -1;
  /** Angle (rad) between the squad's line and the flank line, seen from the threat. */
  angle: number;
  /** Share of the route the threat could see (0..1). */
  exposure: number;
}

const pathLength = (from: THREE.Vector3, path: THREE.Vector3[]) => {
  let len = 0;
  let a = from;
  for (const p of path) {
    len += Math.hypot(p.x - a.x, p.z - a.z);
    a = p;
  }
  return len;
};

/**
 * A real flank: a destination 50–120° around the threat from where the squad
 * is, that can see the threat area, reached by a path that is not absurdly
 * long and mostly out of the threat's direct sight. Returns null when the map
 * offers nothing sensible (the bot picks another tactic).
 */
export function planFlank(
  nav: NavGrid,
  physics: Physics,
  from: THREE.Vector3,
  threat: THREE.Vector3,
  squadPos: THREE.Vector3,
  preferSide: 1 | -1,
): FlankPlan | null {
  const base = Math.atan2(squadPos.x - threat.x, squadPos.z - threat.z);
  const dT = Math.min(26, Math.max(10, Math.hypot(from.x - threat.x, from.z - threat.z)));
  let searches = 0;
  let rays = 0;
  let best: FlankPlan | null = null;
  let bestScore = Infinity;
  for (const side of [preferSide, -preferSide] as (1 | -1)[]) {
    for (const deg of [75, 100, 55, 120]) {
      for (const rk of [1, 0.75, 1.25]) {
        if (searches >= 5 || rays >= 36) break;
        const b = base + side * deg * DEG;
        const r = dT * rk;
        const cand = nav.nearestWalkable(threat.x + Math.sin(b) * r, threat.z + Math.cos(b) * r, new THREE.Vector3(), 2.5);
        if (!cand) continue;
        rays++;
        if (!canSee(physics, cand, threat, 1.5, 1.2)) continue; // must be able to see them from there
        searches++;
        const path = nav.findPath(from, cand, 5000);
        if (!path || !path.length) continue;
        const len = pathLength(from, path);
        const straight = Math.hypot(cand.x - from.x, cand.z - from.z);
        if (len > Math.max(32, straight * 2.6)) continue; // no kilometre detours
        // How much of the walk is in the threat's sight?
        let seen = 0;
        let samples = 0;
        let prev = from;
        for (const p of path) {
          const seg = Math.hypot(p.x - prev.x, p.z - prev.z);
          const n = Math.max(1, Math.min(4, Math.round(seg / 5)));
          for (let k = 1; k <= n && rays < 36; k++) {
            const q = new THREE.Vector3().lerpVectors(prev, p, k / n);
            samples++;
            rays++;
            if (canSee(physics, threat, q, 1.5, 1.2)) seen++;
          }
          prev = p;
        }
        const exposure = samples ? seen / samples : 0;
        if (exposure > 0.6) continue;
        const score = exposure * 2 + len * 0.02 + Math.abs(deg - 85) / 90 * 0.3 + (side === preferSide ? 0 : 0.15);
        if (score < bestScore) {
          bestScore = score;
          best = { route: path, dest: cand, side, angle: deg * DEG, exposure };
        }
        if (bestScore < 0.6) return best; // good enough: stop searching
      }
    }
  }
  return best;
}

/**
 * Where to look for someone who disappeared: the last known spot, then likely
 * places around it — ahead along the way they were moving, and corners (cells
 * next to cover) — spread out so a squad doesn't all walk the same doorway.
 */
export function planSearch(
  nav: NavGrid,
  center: THREE.Vector3,
  moveDir: THREE.Vector3 | null,
  count: number,
  avoid: (p: THREE.Vector3) => boolean = () => false,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const c0 = nav.nearestWalkable(center.x, center.z, new THREE.Vector3(), 3);
  if (c0 && !avoid(c0)) out.push(c0);
  const cands: { p: THREE.Vector3; s: number }[] = [];
  const md = moveDir && moveDir.lengthSq() > 0.25 ? Math.atan2(moveDir.x, moveDir.z) : null;
  for (const r of [5, 9, 13]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.random() * 0.4;
      const p = nav.nearestWalkable(center.x + Math.sin(a) * r, center.z + Math.cos(a) * r, new THREE.Vector3(), 1.5);
      if (!p || avoid(p)) continue;
      let s = Math.random() * 0.4 + r * 0.03;
      if (md !== null) s -= Math.cos(a - md) * 0.6; // ahead of where they were going
      if (nav.nearWall(p.x, p.z)) s -= 0.25; // corners and cover are where people hide
      cands.push({ p, s });
    }
  }
  cands.sort((a, b) => a.s - b.s);
  for (const { p } of cands) {
    if (out.length >= count) break;
    if (out.some((q) => q.distanceToSquared(p) < 16)) continue;
    out.push(p);
  }
  return out;
}

export const flankLabel = (side: 1 | -1) => (side === 1 ? 'FLANK_LEFT' : 'FLANK_RIGHT');
