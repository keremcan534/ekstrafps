/**
 * The path search itself, free of three.js and the physics world, so the main
 * thread (NavGrid) and the path worker (pathWorker.ts) run the same code:
 * 8-way A* over the nav grid (cells near walls cost more, no corner cutting),
 * then line-of-sight smoothing (string pulling). Positions are world XZ.
 */
export const BLOCKED = 255;

export interface PathGrid {
  /** 0 = walkable (higher = closer to walls), BLOCKED = solid. */
  cost: Uint8Array;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  cell: number;
}

/** A team barricade (see game/Obstacles): oriented box, other teams route around it. */
export interface PathObstacle {
  x: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  alive: boolean;
  team?: string;
}

export interface PathResult {
  /** Waypoints x0, z0, x1, z1… (start excluded), or null: no path within maxNodes. */
  pts: number[] | null;
  /** Nodes expanded. */
  expanded: number;
  /** Cell probes made while smoothing. */
  samples: number;
  /** The search ran out of nodes (maxNodes) before reaching the goal. */
  stopped: boolean;
}

export class PathSearch {
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private search = 0;
  private heap: number[] = [];
  private heapF: number[] = [];
  private samples = 0;
  private nearOut = { x: 0, z: 0 };

  constructor(public grid: PathGrid) {
    const n = grid.cols * grid.rows;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  walkable(x: number, z: number): boolean {
    const gr = this.grid;
    const c = Math.floor((x - gr.minX) / gr.cell);
    const r = Math.floor((z - gr.minZ) / gr.cell);
    return c >= 0 && r >= 0 && c < gr.cols && r < gr.rows && gr.cost[r * gr.cols + c] !== BLOCKED;
  }

  /** Nearest walkable cell centre (spiral search) into `out`, false if none within maxRadius. */
  nearestWalkable(x: number, z: number, out: { x: number; z: number }, maxRadius: number): boolean {
    const gr = this.grid;
    const c0 = Math.floor((x - gr.minX) / gr.cell);
    const r0 = Math.floor((z - gr.minZ) / gr.cell);
    const maxR = Math.ceil(maxRadius / gr.cell);
    for (let rad = 0; rad <= maxR; rad++) {
      let best = -1;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (c < 0 || r < 0 || c >= gr.cols || r >= gr.rows || gr.cost[r * gr.cols + c] === BLOCKED) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = r * gr.cols + c;
          }
        }
      }
      if (best >= 0) {
        out.x = gr.minX + ((best % gr.cols) + 0.5) * gr.cell;
        out.z = gr.minZ + (((best / gr.cols) | 0) + 0.5) * gr.cell;
        return true;
      }
    }
    return false;
  }

  /** Straight walk a → b stays on walkable cells (supercover DDA). */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (this.grid.cell * 0.4));
    for (let k = 0; k <= steps; k++) {
      const t = steps === 0 ? 0 : k / steps;
      if (!this.walkable(ax + dx * t, az + dz * t)) {
        this.samples += k + 1;
        return false;
      }
    }
    this.samples += steps + 1;
    return true;
  }

  /**
   * Path from (fx, fz) to (tx, tz). `obstacles` + `team`: route around other teams'
   * barricades (null: ignore them).
   */
  find(fx: number, fz: number, tx: number, tz: number, maxNodes: number, obstacles: PathObstacle[] | null, team?: string): PathResult {
    const gr = this.grid;
    const avoid = !!obstacles && obstacles.length > 0 && team !== undefined;
    const res: PathResult = { pts: null, expanded: 0, samples: 0, stopped: false };
    const start = { x: 0, z: 0 };
    const goal = this.nearOut;
    if (!this.nearestWalkable(fx, fz, start, 2) || !this.nearestWalkable(tx, tz, goal, 4)) return res;
    const cols = gr.cols;
    const cost = gr.cost;
    const sc = Math.floor((start.x - gr.minX) / gr.cell);
    const sr = Math.floor((start.z - gr.minZ) / gr.cell);
    const gc = Math.floor((goal.x - gr.minX) / gr.cell);
    const grr = Math.floor((goal.z - gr.minZ) / gr.cell);
    const si = sr * cols + sc;
    const gi = grr * cols + gc;
    const id = ++this.search;
    const h = (i: number) => {
      const dc = Math.abs((i % cols) - gc);
      const dr = Math.abs(((i / cols) | 0) - grr);
      return Math.max(dc, dr) + 0.414 * Math.min(dc, dr);
    };
    const blockedAt = (x: number, z: number) => avoid && obstacleAt(obstacles!, x, z, 0.4, team);
    this.heap.length = 0;
    this.heapF.length = 0;
    this.stamp[si] = id;
    this.g[si] = 0;
    this.parent[si] = -1;
    this.push(si, h(si));
    let expanded = 0;
    let found = false;
    while (this.heap.length) {
      const cur = this.pop();
      if (this.closed[cur] === id) continue;
      this.closed[cur] = id;
      if (cur === gi) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) {
        res.stopped = true;
        break;
      }
      const c = cur % cols;
      const r = (cur / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= gr.rows) continue;
          const ni = nr * cols + nc;
          if (cost[ni] === BLOCKED || this.closed[ni] === id) continue;
          if (avoid && blockedAt(gr.minX + (nc + 0.5) * gr.cell, gr.minZ + (nr + 0.5) * gr.cell)) continue;
          // No corner cutting.
          if (dc && dr && (cost[r * cols + nc] === BLOCKED || cost[nr * cols + c] === BLOCKED)) continue;
          const step = (dc && dr ? 1.414 : 1) * (1 + cost[ni] * 0.6);
          const ng = this.g[cur] + step;
          if (this.stamp[ni] !== id || ng < this.g[ni]) {
            this.stamp[ni] = id;
            this.g[ni] = ng;
            this.parent[ni] = cur;
            this.push(ni, ng + h(ni));
          }
        }
      }
    }
    res.expanded = expanded;
    if (!found) return res;
    // Cell centres along the path; the last one is the exact target when that is walkable.
    const cells: number[] = [];
    for (let i = gi; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    const px: number[] = [];
    const pz: number[] = [];
    for (const i of cells) {
      px.push(gr.minX + ((i % cols) + 0.5) * gr.cell);
      pz.push(gr.minZ + (((i / cols) | 0) + 0.5) * gr.cell);
    }
    const last = px.length - 1;
    if (this.walkable(tx, tz)) {
      px[last] = tx;
      pz[last] = tz;
    } else {
      px[last] = goal.x;
      pz[last] = goal.z;
    }
    // String pulling: keep only the corners we can't walk straight past.
    const out: number[] = [];
    let ax = fx;
    let az = fz;
    let k = 0;
    this.samples = 0;
    while (k < last) {
      let far = k + 1;
      // Look ahead at most ~20 m: full-length scans are quadratic on long paths.
      for (let j = Math.min(last, k + 40); j > k + 1; j--) {
        if (this.clearLine(ax, az, px[j], pz[j]) && !(avoid && this.segmentBlocked(obstacles!, ax, az, px[j], pz[j], team))) {
          far = j;
          break;
        }
      }
      out.push(px[far], pz[far]);
      ax = px[far];
      az = pz[far];
      k = far;
    }
    if (!out.length) out.push(px[last], pz[last]);
    res.pts = out;
    res.samples = this.samples;
    return res;
  }

  private segmentBlocked(obstacles: PathObstacle[], ax: number, az: number, bx: number, bz: number, team?: string): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 0.4));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (obstacleAt(obstacles, ax + (bx - ax) * t, az + (bz - az) * t, 0.4, team)) {
        this.samples += k + 1;
        return true;
      }
    }
    this.samples += n + 1;
    return false;
  }

  // Binary min-heap on f.
  private push(i: number, f: number): void {
    const h = this.heap;
    const hf = this.heapF;
    h.push(i);
    hf.push(f);
    let k = h.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p] <= hf[k]) break;
      const ti = h[p];
      h[p] = h[k];
      h[k] = ti;
      const tf = hf[p];
      hf[p] = hf[k];
      hf[k] = tf;
      k = p;
    }
  }

  private pop(): number {
    const h = this.heap;
    const hf = this.heapF;
    const top = h[0];
    const lastI = h.pop()!;
    const lastF = hf.pop()!;
    if (h.length) {
      h[0] = lastI;
      hf[0] = lastF;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < h.length && hf[l] < hf[m]) m = l;
        if (r < h.length && hf[r] < hf[m]) m = r;
        if (m === k) break;
        const ti = h[m];
        h[m] = h[k];
        h[k] = ti;
        const tf = hf[m];
        hf[m] = hf[k];
        hf[k] = tf;
        k = m;
      }
    }
    return top;
  }
}

/** The obstacle (of another team) at (x, z), padded; same test as game/Obstacles.obstacleAt. */
export function obstacleAt(list: PathObstacle[], x: number, z: number, pad: number, team?: string): PathObstacle | null {
  for (const o of list) {
    if (!o.alive || o.team === team) continue;
    const dx = x - o.x;
    const dz = z - o.z;
    const lx = dx * o.cos - dz * o.sin;
    const lz = dx * o.sin + dz * o.cos;
    if (Math.abs(lx) < o.hx + pad && Math.abs(lz) < o.hz + pad) return o;
  }
  return null;
}
