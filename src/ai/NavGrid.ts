import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from '../core/Physics';

const BLOCKED = 255;

/**
 * Ground-level navigation grid baked from the physics world at startup.
 * A cell is walkable when there is floor near y = 0 and nothing solid in a
 * body-sized box above it. Cells next to walls cost more, so paths keep a
 * little distance from cover instead of scraping along it.
 *
 * findPath(): 8-way A* + line-of-sight smoothing (string pulling).
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  /** 0 = walkable (higher = closer to walls), BLOCKED = solid. */
  private cost: Uint8Array;
  // A* scratch, reused between searches.
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private search = 0;
  private heap: number[] = [];
  private heapF: number[] = [];
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
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);

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
  }

  private inside(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)];
  }

  walkable(x: number, z: number): boolean {
    const [c, r] = this.cellOf(x, z);
    return this.inside(c, r) && this.cost[r * this.cols + c] !== BLOCKED;
  }

  /** Nearest walkable cell centre (spiral search), or null. */
  nearestWalkable(x: number, z: number, out: THREE.Vector3, maxRadius = 6): THREE.Vector3 | null {
    const [c0, r0] = this.cellOf(x, z);
    const maxR = Math.ceil(maxRadius / this.cell);
    for (let rad = 0; rad <= maxR; rad++) {
      let best = -1;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (!this.inside(c, r) || this.cost[r * this.cols + c] === BLOCKED) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = r * this.cols + c;
          }
        }
      }
      if (best >= 0) return this.center(best, out);
    }
    return null;
  }

  private center(i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = i % this.cols;
    const r = (i / this.cols) | 0;
    return out.set(this.minX + (c + 0.5) * this.cell, 0, this.minZ + (r + 0.5) * this.cell);
  }

  /** Straight walk a → b stays on walkable cells (supercover DDA). */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (this.cell * 0.4));
    for (let k = 0; k <= steps; k++) {
      const t = steps === 0 ? 0 : k / steps;
      if (!this.walkable(ax + dx * t, az + dz * t)) return false;
    }
    return true;
  }

  /**
   * Smoothed path from a to b (world XZ). Returns waypoints excluding the start,
   * or null when unreachable. maxNodes bounds the search cost.
   */
  /** Nodes all searches may expand per frame; callers retry later when it's spent. */
  frameBudget = 9000;
  private frameUsed = 0;

  beginFrame(): void {
    this.frameUsed = 0;
  }

  findPath(from: THREE.Vector3, to: THREE.Vector3, maxNodes = 6000): THREE.Vector3[] | null {
    if (this.frameUsed > this.frameBudget) return null;
    const start = this.nearestWalkable(from.x, from.z, new THREE.Vector3(), 2);
    const goal = this.nearestWalkable(to.x, to.z, new THREE.Vector3(), 4);
    if (!start || !goal) return null;
    const [sc, sr] = this.cellOf(start.x, start.z);
    const [gc, gr] = this.cellOf(goal.x, goal.z);
    const si = sr * this.cols + sc;
    const gi = gr * this.cols + gc;
    const id = ++this.search;
    const h = (i: number) => {
      const dc = Math.abs((i % this.cols) - gc);
      const dr = Math.abs(((i / this.cols) | 0) - gr);
      return Math.max(dc, dr) + 0.414 * Math.min(dc, dr);
    };
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
      if (++expanded > maxNodes) break;
      const c = cur % this.cols;
      const r = (cur / this.cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (!this.inside(nc, nr)) continue;
          const ni = nr * this.cols + nc;
          if (this.cost[ni] === BLOCKED || this.closed[ni] === id) continue;
          // No corner cutting.
          if (dc && dr && (this.cost[r * this.cols + nc] === BLOCKED || this.cost[nr * this.cols + c] === BLOCKED)) continue;
          const step = (dc && dr ? 1.414 : 1) * (1 + this.cost[ni] * 0.6);
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
    this.frameUsed += expanded + 50;
    if (!found) return null;
    const cells: number[] = [];
    for (let i = gi; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    // String pulling: keep only the corners we can't walk straight past.
    const pts = cells.map((i) => this.center(i, new THREE.Vector3()));
    pts[pts.length - 1].set(to.x, 0, to.z);
    if (!this.walkable(to.x, to.z)) pts[pts.length - 1].copy(goal);
    const out: THREE.Vector3[] = [];
    let anchor = new THREE.Vector3(from.x, 0, from.z);
    let k = 0;
    while (k < pts.length - 1) {
      let far = k + 1;
      for (let j = pts.length - 1; j > k + 1; j--) {
        if (this.clearLine(anchor.x, anchor.z, pts[j].x, pts[j].z)) {
          far = j;
          break;
        }
      }
      out.push(pts[far]);
      anchor = pts[far];
      k = far;
    }
    if (!out.length) out.push(pts[pts.length - 1]);
    return out;
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
      [h[p], h[k]] = [h[k], h[p]];
      [hf[p], hf[k]] = [hf[k], hf[p]];
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
        [h[m], h[k]] = [h[k], h[m]];
        [hf[m], hf[k]] = [hf[k], hf[m]];
        k = m;
      }
    }
    return top;
  }
}
