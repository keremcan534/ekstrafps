/**
 * Path worker: the nav grid's A* on its own CPU core (see NavGrid.findPathFor).
 * Holds a copy of the grid (patched when doors open) and of the team barricades;
 * answers each 'find' with the waypoints as flat x, z pairs (null: no path).
 */
import { PathSearch, type PathObstacle } from './PathSearch';

type Msg =
  | { type: 'init'; cost: Uint8Array; cols: number; rows: number; minX: number; minZ: number; cell: number }
  | { type: 'cells'; at: number; cost: Uint8Array }
  | { type: 'obstacles'; list: PathObstacle[] }
  | { type: 'find'; id: number; fx: number; fz: number; tx: number; tz: number; maxNodes: number; team?: string };

let search: PathSearch | null = null;
let obstacles: PathObstacle[] = [];

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      search = new PathSearch({ cost: m.cost, cols: m.cols, rows: m.rows, minX: m.minX, minZ: m.minZ, cell: m.cell });
      break;
    case 'cells':
      search?.grid.cost.set(m.cost, m.at);
      break;
    case 'obstacles':
      obstacles = m.list;
      break;
    case 'find': {
      const r = search ? search.find(m.fx, m.fz, m.tx, m.tz, m.maxNodes, m.team !== undefined && obstacles.length ? obstacles : null, m.team) : null;
      self.postMessage({ id: m.id, pts: r?.pts ?? null });
      break;
    }
  }
};
