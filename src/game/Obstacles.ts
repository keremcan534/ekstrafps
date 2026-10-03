/**
 * Player-built blockers (barricades). They don't touch the nav grid on purpose:
 * robots path straight into them and chew through, AI soldiers breach them.
 * Movement code asks `obstacleAt` before stepping.
 */
export interface Obstacle {
  x: number;
  z: number;
  /** Half extents along the obstacle's own axes. */
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  alive: boolean;
  /** Team that built it (its own soldiers walk through). */
  team: string;
  damage(n: number): void;
}

export const OBSTACLES: Obstacle[] = [];

/** Does the straight walk a → b run into an obstacle (sampled every 0.4 m)? */
export function segmentBlocked(ax: number, az: number, bx: number, bz: number, pad: number, team?: string): boolean {
  if (!OBSTACLES.length) return false;
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(len / 0.4));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    if (obstacleAt(ax + (bx - ax) * t, az + (bz - az) * t, pad, team)) return true;
  }
  return false;
}

/** The obstacle covering (x, z), grown by `pad` (the mover's radius). */
export function obstacleAt(x: number, z: number, pad: number, team?: string): Obstacle | null {
  for (const o of OBSTACLES) {
    if (!o.alive || o.team === team) continue;
    const dx = x - o.x;
    const dz = z - o.z;
    // Into the obstacle's frame (rotation by -yaw).
    const lx = dx * o.cos - dz * o.sin;
    const lz = dx * o.sin + dz * o.cos;
    if (Math.abs(lx) < o.hx + pad && Math.abs(lz) < o.hz + pad) return o;
  }
  return null;
}
