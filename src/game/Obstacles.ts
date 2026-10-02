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
