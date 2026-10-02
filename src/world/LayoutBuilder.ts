import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { MeshBuilder } from './MeshBuilder';

export type Rect = [x0: number, z0: number, x1: number, z1: number];

export interface RoomStyle {
  floor: THREE.Material;
  wall: THREE.Material;
  ceiling: THREE.Material;
  /** Ceiling lamp panel material (null = no grid lamps). */
  lamp: THREE.Material | null;
  lampSpacing: number;
  /** Colour of the soft light pool painted under each lamp (0 = none). */
  glow: number;
}

export interface RoomDef {
  id: string;
  name: string;
  rect: Rect;
  /** Ceiling height; for open-air rooms the height of the surrounding walls. */
  h: number;
  style: string;
  /** Purchase zone: rooms of a zone unlock together. */
  zone: string;
  /** Open to the sky (no ceiling). */
  sky?: boolean;
  /** Glass skylight instead of a solid ceiling. */
  skylight?: boolean;
}

export interface LinkDef {
  a: string;
  b: string;
  /** Centre along the shared boundary (x for a horizontal boundary, z for a vertical one). */
  at: number;
  width: number;
  kind: 'open' | 'buy';
  cost?: number;
  height?: number;
}

/** A purchasable door produced by the builder (Survival owns opening it). */
export interface DoorSlot {
  link: LinkDef;
  /** Door centre on the floor. */
  center: THREE.Vector3;
  /** Boundary runs along X (true) or Z (false). */
  alongX: boolean;
  width: number;
  height: number;
}

/** Wall run for the map overlay. */
export interface WallRun {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface BuiltRoom {
  def: RoomDef;
  group: THREE.Group;
  /** Opaque world-UV geometry of this room. */
  b: MeshBuilder;
  /** Glass, decals, glow planes (no world UVs, no shadows). */
  clear: MeshBuilder;
  /** Ceiling-mounted pieces (no shadow casting). */
  ceil: MeshBuilder;
  lamps: THREE.Vector3[];
}

const T = 0.3;
const CELL = 1;

/**
 * Builds a single-level facility from axis-aligned room rectangles on a 1 m grid:
 * walls appear wherever two different rooms (or a room and solid rock) meet,
 * except where a link opens the boundary (archway or purchasable door).
 *
 * Every wall is built as two half-thickness skins, one per room, so each side
 * gets its own room's material and height. Each room's geometry is merged into
 * its own meshes (frustum culling per room), plus cheap lighting fakes: contact
 * shadow strips along wall bases and soft light pools under ceiling lamps.
 */
export class LayoutBuilder {
  readonly rooms = new Map<string, BuiltRoom>();
  readonly doors: DoorSlot[] = [];
  readonly wallRuns: WallRun[] = [];
  readonly bounds: Rect;
  private grid: Int16Array;
  private cols: number;
  private rowsN: number;
  private defs: RoomDef[];

  constructor(
    private physics: Physics,
    defs: RoomDef[],
    private links: LinkDef[],
    private styles: Record<string, RoomStyle>,
    private shared: { ao: THREE.Material; pool: (color: number) => THREE.Material; skyFrame: THREE.Material; skyGlass: THREE.Material; trim: THREE.Material },
    private wallReceiver?: HitReceiver,
  ) {
    this.defs = defs;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const d of defs) {
      x0 = Math.min(x0, d.rect[0]);
      z0 = Math.min(z0, d.rect[1]);
      x1 = Math.max(x1, d.rect[2]);
      z1 = Math.max(z1, d.rect[3]);
    }
    this.bounds = [x0, z0, x1, z1];
    this.cols = Math.round((x1 - x0) / CELL);
    this.rowsN = Math.round((z1 - z0) / CELL);
    this.grid = new Int16Array(this.cols * this.rowsN).fill(-1);
    defs.forEach((d, i) => {
      for (let z = d.rect[1]; z < d.rect[3]; z++) for (let x = d.rect[0]; x < d.rect[2]; x++) this.grid[this.idx(x, z)] = i;
      this.rooms.set(d.id, {
        def: d, group: new THREE.Group(), b: new MeshBuilder(true), clear: new MeshBuilder(false), ceil: new MeshBuilder(true), lamps: [],
      });
    });
  }

  private idx(x: number, z: number): number {
    return (z - this.bounds[1]) * this.cols + (x - this.bounds[0]);
  }

  /** Room index of the 1 m cell whose min corner is (x, z), or -1. */
  private at(x: number, z: number): number {
    const cx = x - this.bounds[0];
    const cz = z - this.bounds[1];
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rowsN) return -1;
    return this.grid[cz * this.cols + cx];
  }

  roomAt(x: number, z: number): RoomDef | null {
    const i = this.at(Math.floor(x), Math.floor(z));
    return i >= 0 ? this.defs[i] : null;
  }

  private wallHeight(i: number): number {
    return i < 0 ? 0 : this.defs[i].h;
  }

  private findLink(a: number, b: number, coord: number, vertical: number): LinkDef | null {
    if (a < 0 || b < 0) return null;
    const ida = this.defs[a].id;
    const idb = this.defs[b].id;
    for (const l of this.links) {
      if (!((l.a === ida && l.b === idb) || (l.a === idb && l.b === ida))) continue;
      if (Math.abs(coord - l.at) < l.width / 2) return l;
    }
    void vertical;
    return null;
  }

  build(parent: THREE.Object3D): void {
    // Floor collider for everything (rooms add their own floor visuals).
    const [bx0, bz0, bx1, bz1] = this.bounds;
    this.physics.addStaticBox(new THREE.Vector3((bx0 + bx1) / 2, -0.5, (bz0 + bz1) / 2), new THREE.Vector3((bx1 - bx0) / 2, 0.5, (bz1 - bz0) / 2));

    // Vertical grid lines (constant x): left cell (x-1, z) vs right cell (x, z).
    for (let x = bx0; x <= bx1; x++) this.scanLine(x, bz0, bz1, false);
    // Horizontal grid lines (constant z): upper cell (x, z-1) vs lower cell (x, z).
    for (let z = bz0; z <= bz1; z++) this.scanLine(z, bx0, bx1, true);

    for (const room of this.rooms.values()) {
      this.buildRoomShell(room);
    }
    for (const room of this.rooms.values()) {
      room.b.build(room.group);
      room.ceil.build(room.group, { castShadow: false, receiveShadow: true });
      room.clear.build(room.group, { castShadow: false, receiveShadow: false });
      parent.add(room.group);
    }
  }

  /** Walk one grid line and emit merged wall runs. */
  private scanLine(line: number, from: number, to: number, alongX: boolean): void {
    let runStart = from;
    let prevKey = '';
    let prev: { a: number; b: number; link: LinkDef | null } | null = null;
    const flush = (end: number) => {
      if (prev && (prev.a >= 0 || prev.b >= 0) && prev.a !== prev.b) this.emitRun(line, runStart, end, alongX, prev.a, prev.b, prev.link);
    };
    for (let s = from; s <= to; s++) {
      let cur: { a: number; b: number; link: LinkDef | null } | null = null;
      if (s < to) {
        const a = alongX ? this.at(s, line - 1) : this.at(line - 1, s);
        const b = alongX ? this.at(s, line) : this.at(line, s);
        cur = { a, b, link: a !== b ? this.findLink(a, b, s + 0.5, line) : null };
      }
      const key = cur ? `${cur.a}|${cur.b}|${cur.link ? this.links.indexOf(cur.link) : -1}` : 'end';
      if (key !== prevKey) {
        flush(s);
        runStart = s;
        prevKey = key;
        prev = cur;
      }
    }
  }

  /**
   * One straight boundary run between room a (left/up) and room b (right/down).
   * Emits physics, the two skins, contact-shadow strips, lintels or door slots.
   */
  private emitRun(line: number, s0: number, s1: number, alongX: boolean, a: number, b: number, link: LinkDef | null): void {
    const len = s1 - s0;
    const mid = (s0 + s1) / 2;
    const ha = this.wallHeight(a);
    const hb = this.wallHeight(b);
    const hMax = Math.max(ha, hb) + 0.3;
    const pos = (along: number, y: number, off: number) => (alongX ? new THREE.Vector3(along, y, line + off) : new THREE.Vector3(line + off, y, along));
    const size = (l: number, h: number, t: number): [number, number, number] => (alongX ? [l, h, t] : [t, h, l]);
    const box = (center: THREE.Vector3, sz: [number, number, number]) =>
      this.physics.addStaticBox(center, new THREE.Vector3(sz[0] / 2, sz[1] / 2, sz[2] / 2), undefined, this.wallReceiver);

    let bottom = 0;
    if (link) {
      const lowRoom = Math.min(ha || Infinity, hb || Infinity);
      const oh = Math.min(link.height ?? 4, lowRoom - 0.4);
      bottom = oh;
      if (link.kind === 'buy') {
        this.doors.push({ link, center: pos(mid, 0, 0), alongX, width: len, height: oh });
      }
      // Door frame trims on both sides of the opening.
      for (const side of [a, b]) {
        if (side < 0) continue;
        const r = this.rooms.get(this.defs[side].id)!;
        const off = side === a ? -T / 2 : T / 2;
        for (const e of [s0, s1]) {
          const p = pos(e + (e === s0 ? 0.06 : -0.06), oh / 2, off);
          r.b.box(this.shared.trim, size(0.12, oh, 0.08), [p.x, p.y, p.z]);
        }
        const top = pos(mid, oh + 0.06, off);
        r.b.box(this.shared.trim, size(len, 0.12, 0.08), [top.x, top.y, top.z]);
      }
      if (link.kind === 'open' || link.kind === 'buy') {
        // Lintel only above the opening.
        if (hMax > oh) box(pos(mid, (oh + hMax) / 2, 0), size(len, hMax - oh, T));
      }
    } else {
      box(pos(mid, hMax / 2, 0), size(len, hMax, T));
      this.wallRuns.push(alongX ? { x0: s0, z0: line, x1: s1, z1: line } : { x0: line, z0: s0, x1: line, z1: s1 });
    }

    // Visual skins (each side in its own room's material, up to its own height).
    for (const side of [a, b]) {
      if (side < 0) continue;
      const def = this.defs[side];
      const r = this.rooms.get(def.id)!;
      const style = this.styles[def.style];
      const h = def.h + 0.3;
      const off = side === a ? -T / 4 : T / 4;
      if (h > bottom) {
        const c = pos(mid, (bottom + h) / 2, off);
        r.b.box(style.wall, size(len, h - bottom, T / 2), [c.x, c.y, c.z]);
      }
      if (!link) {
        // Contact shadow along the wall base (faces into this room).
        const face = side === a ? -T / 2 - 0.01 : T / 2 + 0.01;
        const g = new THREE.PlaneGeometry(len, 0.55);
        const rot: [number, number, number] = alongX ? [0, side === a ? Math.PI : 0, 0] : [0, side === a ? -Math.PI / 2 : Math.PI / 2, 0];
        const p = pos(mid, 0.275, face);
        r.clear.add(this.shared.ao, g, [p.x, p.y, p.z], rot);
      }
    }
  }

  private buildRoomShell(room: BuiltRoom): void {
    const d = room.def;
    const s = this.styles[d.style];
    const [x0, z0, x1, z1] = d.rect;
    const w = x1 - x0;
    const dz = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    room.b.box(s.floor, [w, 0.02, dz], [cx, 0.01, cz]);
    if (d.sky) return;
    if (d.skylight) {
      // Glass roof on a steel grid: daylight pours into the room.
      room.clear.box(this.shared.skyGlass, [w, 0.05, dz], [cx, d.h + 0.2, cz]);
      for (let x = x0 + 4; x < x1; x += 4) room.ceil.box(this.shared.skyFrame, [0.25, 0.4, dz], [x, d.h + 0.1, cz]);
      for (let z = z0 + 4; z < z1; z += 4) room.ceil.box(this.shared.skyFrame, [w, 0.4, 0.25], [cx, d.h + 0.1, z]);
      this.physics.addStaticBox(new THREE.Vector3(cx, d.h + 0.35, cz), new THREE.Vector3(w / 2, 0.15, dz / 2));
      return;
    }
    room.ceil.box(s.ceiling, [w, 0.3, dz], [cx, d.h + 0.15, cz]);
    this.physics.addStaticBox(new THREE.Vector3(cx, d.h + 0.15, cz), new THREE.Vector3(w / 2, 0.15, dz / 2));
    if (!s.lamp) return;
    const step = s.lampSpacing;
    const nx = Math.max(1, Math.round(w / step));
    const nz = Math.max(1, Math.round(dz / step));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x = x0 + ((i + 0.5) * w) / nx;
        const z = z0 + ((j + 0.5) * dz) / nz;
        room.ceil.box(s.lamp, [1.6, 0.06, 0.55], [x, d.h - 0.03, z]);
        room.lamps.push(new THREE.Vector3(x, d.h, z));
        if (s.glow) {
          const size = Math.min(step * 0.9, 2.2 + d.h * 0.45);
          room.clear.add(this.shared.pool(s.glow), new THREE.PlaneGeometry(size, size), [x, 0.03, z], [-Math.PI / 2, 0, 0]);
        }
      }
    }
  }
}
