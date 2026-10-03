import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from '../core/Physics';
import { OBSTACLES } from '../game/Obstacles';
import { trailerMode } from '../../production/trailer/capture/determinism';
import { BLOCKED, PathSearch } from './PathSearch';
/** Path nodes per frame on desktop (phones set a lower NavGrid.frameBudget). */
const DESKTOP_FRAME_BUDGET = 9000;

/**
 * Ground-level navigation grid baked from the physics world at startup.
 * A cell is walkable when there is floor near y = 0 and nothing solid in a
 * body-sized box above it. Cells next to walls cost more, so paths keep a
 * little distance from cover instead of scraping along it.
 *
 * findPath(): 8-way A* + line-of-sight smoothing (string pulling), on this thread
 * under a per-frame budget. findPathFor(): the same search on the path worker's own
 * CPU core (src/ai/pathWorker.ts): the answer comes a frame or two later, without
 * costing this thread anything. The search code is shared (src/ai/PathSearch.ts).
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  /** 0 = walkable (higher = closer to walls), BLOCKED = solid. */
  private cost: Uint8Array;
  /** The A* (scratch arrays reused between searches). */
  private searcher!: PathSearch;
  private physicsRef: Physics;
  private agentRadius: number;

  constructor(
    physics: Physics,
    readonly minX: number,
    readonly minZ: number,
    maxX: number,
    maxZ: number,
    readonly cell = 0.5,
    agentRadius = 0.32,
    extraBlockers: { pos: THREE.Vector3; radius: number }[] = [],
  ) {
    this.physicsRef = physics;
    this.agentRadius = agentRadius;
    this.cols = Math.ceil((maxX - minX) / cell);
    this.rows = Math.ceil((maxZ - minZ) / cell);
    const n = this.cols * this.rows;
    this.cost = new Uint8Array(n);

    const world = physics.world;
    // Scene queries only see colliders after a step (the broad phase is built there).
    world.step();
    const solid = groups(G.RAY, G.WORLD);
    const body = new RAPIER.Cuboid(agentRadius, 0.62, agentRadius);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = minX + (c + 0.5) * cell;
        const z = minZ + (r + 0.5) * cell;
        const i = r * this.cols + c;
        // Floor at ground level?
        ray.origin = { x, y: 0.5, z };
        const floor = world.castRay(ray, 0.8, true, undefined, solid);
        if (!floor || floor.timeOfImpact > 0.62) {
          this.cost[i] = BLOCKED;
          continue;
        }
        // Body-sized clearance from knee to head height.
        if (world.intersectionWithShape({ x, y: 1.0, z }, rot, body, undefined, solid)) this.cost[i] = BLOCKED;
      }
    }
    for (const b of extraBlockers) {
      const r = Math.ceil((b.radius + agentRadius) / cell);
      const [cc, cr] = this.cellOf(b.pos.x, b.pos.z);
      for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
          if (Math.hypot(dc, dr) * cell <= b.radius + agentRadius && this.inside(cc + dc, cr + dr)) this.cost[(cr + dr) * this.cols + cc + dc] = BLOCKED;
        }
      }
    }
    // Wall proximity cost (2 rings).
    const near = new Uint8Array(n);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.cost[r * this.cols + c] !== BLOCKED) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (!this.inside(c + dc, r + dr)) continue;
            const j = (r + dr) * this.cols + c + dc;
            const v = Math.max(Math.abs(dc), Math.abs(dr)) === 1 ? 3 : 1;
            if (v > near[j]) near[j] = v;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) if (this.cost[i] !== BLOCKED) this.cost[i] = near[i];
    this.searcher = new PathSearch({ cost: this.cost, cols: this.cols, rows: this.rows, minX, minZ, cell });
    this.startWorker();
  }

  /** Re-probe cells in a rectangle (a door opened / an obstacle moved). Call after a physics step. */
  refreshArea(x0: number, z0: number, x1: number, z1: number): void {
    const world = this.physicsRef.world;
    const solid = groups(G.RAY, G.WORLD);
    const body = new RAPIER.Cuboid(this.agentRadius, 0.62, this.agentRadius);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const [c0, r0] = this.cellOf(x0, z0);
    const [c1, r1] = this.cellOf(x1, z1);
    for (let r = Math.max(0, r0); r <= Math.min(this.rows - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(this.cols - 1, c1); c++) {
        const x = this.minX + (c + 0.5) * this.cell;
        const z = this.minZ + (r + 0.5) * this.cell;
        const blocked = !!world.intersectionWithShape({ x, y: 1.0, z }, rot, body, undefined, solid);
        this.cost[r * this.cols + c] = blocked ? BLOCKED : 0;
      }
    }
    // The worker's copy of the grid.
    if (this.worker) {
      const i0 = Math.max(0, r0) * this.cols;
      const i1 = (Math.min(this.rows - 1, r1) + 1) * this.cols;
      this.worker.postMessage({ type: 'cells', at: i0, cost: this.cost.slice(i0, i1) });
    }
  }

  private inside(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)];
  }

  // Hot (path smoothing, clearLine, cover rings): the cell maths is inlined, no tuple per call.
  walkable(x: number, z: number): boolean {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.cost[r * this.cols + c] !== BLOCKED;
  }

  /** Walkable and right next to something solid (wall, crate, barrier): where cover is. */
  nearWall(x: number, z: number): boolean {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.cost[r * this.cols + c] === 3;
  }

  /** Cell index (for reservations), -1 outside. */
  cellIndex(x: number, z: number): number {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows ? r * this.cols + c : -1;
  }

  /**
   * Free room either side of (x, z) across the direction (dx, dz): roughly the
   * corridor width there (formation spacing compresses in tight spaces).
   */
  clearance(x: number, z: number, dx: number, dz: number, max = 6): number {
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    let w = 0;
    for (const s of [-1, 1]) {
      let d = 0;
      while (d < max && this.walkable(x + nx * s * (d + this.cell), z + nz * s * (d + this.cell))) d += this.cell;
      w += d;
    }
    return w;
  }

  /** Nearest walkable cell centre (spiral search), or null. */
  nearestWalkable(x: number, z: number, out: THREE.Vector3, maxRadius = 6): THREE.Vector3 | null {
    const p = this.nearTmp;
    if (!this.searcher.nearestWalkable(x, z, p, maxRadius)) return null;
    return out.set(p.x, 0, p.z);
  }
  private nearTmp = { x: 0, z: 0 };

  /** Straight walk a → b stays on walkable cells (supercover DDA). */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    return this.searcher.clearLine(ax, az, bx, bz);
  }

  /**
   * Smoothed path from a to b (world XZ). Returns waypoints excluding the start,
   * or null when unreachable. maxNodes bounds the search cost.
   */
  /** Nodes all searches may expand per frame; callers retry later when it's spent. */
  frameBudget = DESKTOP_FRAME_BUDGET;
  /**
   * Phones: the strict budget rules in findPath (cap each search at what is left, refuse
   * late searches, charge smoothing). Implied when Game lowers frameBudget for phones.
   */
  lowSpec = false;
  private frameUsed = 0;
  /** Searches started this frame after the budget ran out. */
  private lateSearches = 0;
  /**
   * The last findPath() returned null (or stopped short) because of the frame budget,
   * not because the goal is unreachable: retry next frame, don't count it as a failure.
   */
  lastTruncated = false;

  beginFrame(): void {
    this.frameUsed = 0;
    this.lateSearches = 0;
    if (this.worker && OBSTACLES.length + this.obstacleSig.length > 0) this.syncObstacles();
  }

  /**
   * @param avoidTeam route around other teams' barricades (the grid itself doesn't
   *                  know them: robots walk into them on purpose and tear them down).
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, maxNodes = 6000, avoidTeam?: string): THREE.Vector3[] | null {
    this.lastTruncated = false;
    const strict = this.lowSpec || this.frameBudget < DESKTOP_FRAME_BUDGET;
    const wanted = maxNodes;
    if (strict) {
      // Phones: never expand more than what is left of this frame's budget. Once it's spent,
      // a few short searches still go through (nearby moves never starve); the rest wait a frame.
      const left = this.frameBudget - this.frameUsed;
      if (left <= 0 && ++this.lateSearches > 3) {
        this.lastTruncated = true;
        return null;
      }
      maxNodes = Math.min(maxNodes, Math.max(700, left));
    } else if (this.frameUsed > this.frameBudget) {
      // Budget spent this frame: short searches still go through (nearby moves never starve).
      maxNodes = Math.min(maxNodes, 700);
    }
    const r = this.searcher.find(from.x, from.z, to.x, to.z, maxNodes, avoidTeam !== undefined && OBSTACLES.length ? OBSTACLES : null, avoidTeam);
    this.frameUsed += r.expanded + 50;
    // Phones: smoothing is real work too (long paths probe thousands of cells): ~4 probes per node.
    if (strict) this.frameUsed += Math.ceil(r.samples / 4);
    // Cut short by the frame budget rather than the caller's own limit: retry next frame.
    if (r.stopped && maxNodes < wanted) this.lastTruncated = true;
    return r.pts ? toPath(r.pts) : null;
  }

  // ------------------------------------------------------------ path worker

  private worker: Worker | null = null;
  private nextRequest = 1;
  /** Per asker: the request in flight (its id) or its answer. */
  private asks = new Map<object, { id: number; at: number; pts?: number[] | null }>();
  private byId = new Map<number, object>();
  private obstacleSig = '';

  private startWorker(): void {
    // Trailer capture must be deterministic (same paths, same frame); ?syncnav (bisecting) too.
    if (trailerMode || typeof Worker === 'undefined' || new URLSearchParams(location.search).has('syncnav')) return;
    try {
      const w = new Worker(new URL('./pathWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; pts: number[] | null }>) => {
        const owner = this.byId.get(e.data.id);
        this.byId.delete(e.data.id);
        if (!owner) return;
        const ask = this.asks.get(owner);
        if (ask && ask.id === e.data.id) ask.pts = e.data.pts;
      };
      w.onerror = () => this.stopWorker();
      w.postMessage({ type: 'init', cost: this.cost.slice(), cols: this.cols, rows: this.rows, minX: this.minX, minZ: this.minZ, cell: this.cell });
      this.worker = w;
    } catch {
      this.worker = null;
    }
  }

  /** The worker failed (or never answers): everything goes back to findPath on this thread. */
  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.asks.clear();
    this.byId.clear();
  }

  /**
   * Path for one asker (an agent), searched on the path worker. Returns the answer to
   * this asker's last request once it is in (one request in flight per asker), else
   * null with lastTruncated set: "not yet, ask again next frame". Without the worker it
   * is findPath. The answer may be for where the asker stood a frame or two ago.
   */
  findPathFor(asker: object, from: THREE.Vector3, to: THREE.Vector3, maxNodes = 6000, avoidTeam?: string): THREE.Vector3[] | null {
    // On this thread a search costs frame time: keep to the usual size there.
    if (!this.worker) return this.findPath(from, to, Math.min(maxNodes, 6000), avoidTeam);
    const now = performance.now();
    const ask = this.asks.get(asker);
    if (ask && ask.pts !== undefined) {
      this.asks.delete(asker);
      this.lastTruncated = false;
      return ask.pts ? toPath(ask.pts) : null;
    }
    if (ask) {
      // No answer in 3 s: the worker is stuck. Search here from now on.
      if (now - ask.at > 3000) {
        this.stopWorker();
        return this.findPath(from, to, Math.min(maxNodes, 6000), avoidTeam);
      }
      this.lastTruncated = true;
      return null;
    }
    const id = this.nextRequest++;
    this.asks.set(asker, { id, at: now });
    this.byId.set(id, asker);
    this.worker.postMessage({ type: 'find', id, fx: from.x, fz: from.z, tx: to.x, tz: to.z, maxNodes, team: avoidTeam });
    this.lastTruncated = true;
    return null;
  }

  /** Keep the worker's copy of the team barricades current (cheap when nothing changed). */
  private syncObstacles(): void {
    if (!this.worker) return;
    let sig = String(OBSTACLES.length);
    for (const o of OBSTACLES) sig += `|${o.x.toFixed(2)},${o.z.toFixed(2)},${o.alive ? 1 : 0}`;
    if (sig === this.obstacleSig) return;
    this.obstacleSig = sig;
    this.worker.postMessage({ type: 'obstacles', list: OBSTACLES.map((o) => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, cos: o.cos, sin: o.sin, alive: o.alive, team: o.team })) });
  }

}

/** Flat x, z pairs → waypoints on the ground. */
function toPath(pts: number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(new THREE.Vector3(pts[i], 0, pts[i + 1]));
  return out;
}
