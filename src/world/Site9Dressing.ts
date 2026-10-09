import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { MOBILE_ANISOTROPY } from '../config/Graphics';
import { glowTexture } from '../fx/Textures';
import { applyGrime } from '../fx/WorldGrime';
import type { BuiltRoom, LinkDef, RoomDef } from './LayoutBuilder';
import type { MeshBuilder } from './MeshBuilder';
import type { PropId } from './Props';
import { vLogo, type Site9Atlas } from './Site9Atlas';

type V3 = [number, number, number];
type Rnd = () => number;

/** What the dressing pass may use of the map (Site9 hands it over; all world coordinates unless noted). */
export interface DressKit {
  mobile: boolean;
  rooms: RoomDef[];
  links: LinkDef[];
  mats: Record<string, THREE.Material>;
  physics: Physics;
  /** Gameplay spots on the floor / walls (lifts, wall weapons, terminals, ammo, free wall spots). */
  reserved: THREE.Vector3[];
  spawns: { pos: THREE.Vector3 }[];
  /** Wall fixtures (x, z, radius): the random fixture passes keep off them. */
  fixtures: [number, number, number][];
  room(id: string): BuiltRoom;
  /** Design point in room `id` → world (x, z). */
  W(room: string, x: number, z: number): [number, number];
  box(room: string, mat: string, size: V3, pos: V3, solid?: boolean, rot?: V3, receiver?: HitReceiver): void;
  cyl(room: string, mat: string, r: number, h: number, pos: V3, solid?: boolean, rot?: V3, segments?: number): void;
  prop(room: string, id: PropId, pos: V3, yaw?: number, o?: { scale?: number; tilt?: V3; solid?: boolean; collider?: V3 }): void;
  /** Is this floor area (centre, half extents) clear of doors, gameplay spots, hazards and everything standing? */
  free(room: string, x: number, z: number, hx: number, hz: number, pad?: number): boolean;
  /** Mark floor area as taken (later clutter keeps off it). */
  claim(x0: number, z0: number, x1: number, z1: number): void;
  /** A spot the practical lights may park on (like a ceiling lamp). */
  lampSpot(pos: THREE.Vector3, color: number, h: number): void;
}

/** Local frame: r = right, f = forward (the way the thing faces), y up. */
interface Frame {
  x: number;
  z: number;
  yaw: number;
  P(r: number, y: number, f: number): V3;
}

function frame(x: number, z: number, yaw: number): Frame {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return { x, z, yaw, P: (r, y, f) => [x + c * r + s * f, y, z - s * r + c * f] };
}

/** World half extents of a yawed rectangle (half width along r, half depth along f). */
function extents(hw: number, hd: number, yaw: number): [number, number] {
  const s = Math.abs(Math.sin(yaw));
  const c = Math.abs(Math.cos(yaw));
  return [c * hw + s * hd, s * hw + c * hd];
}

/** (x, z) of a point. */
function xz(p: V3): [number, number] {
  return [p[0], p[2]];
}

function seeded(seed: number): Rnd {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A spot on a wall: on the wall face, normal into the room. */
interface WallPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
  yaw: number;
}

const INDUSTRIAL = new Set(['factory', 'hangar', 'servers']);
const LAMP_SPACING: Record<string, number> = { lobby: 6, cafe: 6, security: 5, medical: 5, factory: 10, hangar: 11, labs: 5, servers: 7, barracks: 6 };

/**
 * Third dressing pass for Site-9: the detail that makes each room read as a place
 * people worked in and left in a hurry. Architecture (wainscots, trusses, columns),
 * room-specific sets (a kitchen line, a CCTV wall, cells, robot arms, a coolant loop
 * with a catwalk, a reactor railing, bunks that were slept in), printed matter from
 * the atlas, the lore plates, and grime (cracks, oil, frost, leaks, bullet holes).
 *
 * Everything merges into the rooms' existing meshes (signs and decals add one draw
 * call per material per room). Solid pieces get one collider per object; the floor
 * placements go through `free` so doors, spawns, gameplay spots and paths stay clear.
 */
export class Site9Dressing {
  private rnd: Rnd = Math.random;
  private decalY = 0;
  private plates = new Map<string, THREE.MeshStandardMaterial>();

  constructor(private k: DressKit, private atlas: Site9Atlas) {
    this.materials();
  }

  build(): void {
    const k = this.k;
    for (const r of k.rooms) {
      this.rnd = seeded(hash(r.id));
      this.architecture(r);
    }
    const rooms: [string, () => void][] = [
      ['lobby', () => this.lobby()],
      ['cafeteria', () => this.cafeteria()],
      ['security', () => this.security()],
      ['garden', () => this.garden()],
      ['medbay', () => this.medbay()],
      ['atrium', () => this.atrium()],
      ['assembly', () => this.assembly()],
      ['warehouse', () => this.warehouse()],
      ['hangar', () => this.hangar()],
      ['labs', () => this.labs()],
      ['cleanroom', () => this.cleanroom()],
      ['prototypes', () => this.prototypes()],
      ['servers', () => this.servers()],
      ['cooling', () => this.cooling()],
      ['barracks', () => this.barracks()],
      ['power', () => this.power()],
    ];
    for (const [id, f] of rooms) {
      this.rnd = seeded(hash(id) ^ 0x51ed);
      f();
    }
    for (const r of k.rooms) {
      this.rnd = seeded(hash(r.id) ^ 0x9a1);
      this.grime(r);
    }
  }

  // ---------------------------------------------------------------- materials

  private materials(): void {
    const m = this.k.mats;
    const std = (o: THREE.MeshStandardMaterialParameters, grime = true) => {
      const mat = new THREE.MeshStandardMaterial(o);
      if (grime) applyGrime(mat, this.k.mobile);
      return mat;
    };
    const add: Record<string, THREE.Material> = {
      d_red: std({ color: 0x9e1f18, roughness: 0.45, metalness: 0.2 }),
      d_blue: std({ color: 0x2a4f80, roughness: 0.5 }),
      d_army: std({ color: 0x3e4a33, roughness: 0.7 }),
      d_orange: std({ color: 0xc4561a, roughness: 0.6 }),
      d_chrome: std({ color: 0xb8bcc0, metalness: 0.9, roughness: 0.22 }, false),
      d_black: std({ color: 0x0e0f10, roughness: 0.55 }, false),
      d_rubber: std({ color: 0x17181a, roughness: 0.95 }),
      d_cream: std({ color: 0xb9b2a2, roughness: 0.8 }),
      d_mattress: std({ color: 0x8a9496, roughness: 0.95 }),
      d_blanket: std({ color: 0x3d4a33, roughness: 1 }),
      d_blanket2: std({ color: 0x5a3e31, roughness: 1 }),
      d_sheet: std({ color: 0xb8bcb8, roughness: 0.95 }),
      d_copper: std({ color: 0x8a5531, metalness: 0.75, roughness: 0.4 }),
      d_stone: std({ color: 0x5f5b55, roughness: 0.95 }),
      d_concrete: std({ color: 0x6d6a64, roughness: 0.95 }),
      d_paintSec: std({ color: 0x353e47, roughness: 0.7 }),
      d_paintMed: std({ color: 0x55786f, roughness: 0.7 }),
      d_paintLab: std({ color: 0x5f676d, roughness: 0.7 }),
      d_paintOlive: std({ color: 0x3e4334, roughness: 0.75 }),
      d_paintInd: std({ color: 0x2f3338, roughness: 0.75 }),
      d_flower1: std({ color: 0xa82a3c, roughness: 0.8 }, false),
      d_flower2: std({ color: 0xc69a22, roughness: 0.8 }, false),
      d_flower3: std({ color: 0x67408f, roughness: 0.8 }, false),
      d_leafAutumn: std({ color: 0x7e4a1c, roughness: 0.9 }, false),
      d_leafDry: std({ color: 0x5f5530, roughness: 0.9 }, false),
      d_grass: std({ color: 0x3f6a2c, roughness: 0.95 }, false),
      d_plastic: std({ color: 0xc8c6bf, roughness: 0.5 }),
      d_yellowBin: std({ color: 0xc89a12, roughness: 0.5 }),
      d_greenBin: std({ color: 0x2e5a36, roughness: 0.55 }),
      d_wrap: new THREE.MeshStandardMaterial({ color: 0xb8c8d4, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false }),
      d_ivBag: new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.2, transparent: true, opacity: 0.55, depthWrite: false }),
      d_bottle: new THREE.MeshStandardMaterial({ color: 0x6f9f8a, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.5, depthWrite: false }),
      d_ice: new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.6, depthWrite: false }),
      d_holo: new THREE.MeshBasicMaterial({ color: 0x46c8ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false }),
      d_marble: this.marble(),
      d_holoLine: new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      a_sign: this.atlas.mats.sign,
      a_lit: this.atlas.mats.lit,
      a_exit: this.atlas.mats.exit,
      a_decal: this.atlas.mats.decal,
      a_wet: this.atlas.mats.wet,
      a_frost: this.atlas.mats.frost,
    };
    Object.assign(m, add);
  }

  // ---------------------------------------------------------------- primitives

  private def(R: string): RoomDef {
    return this.k.rooms.find((r) => r.id === R)!;
  }

  /**
   * Builder for a material: atlas pieces keep their own UVs (the opaque builders project
   * world UVs), transparent / unlit pieces go to the no-shadow builder.
   */
  private builder(R: string, mat: string, ceil = false): MeshBuilder {
    const m = this.k.mats[mat];
    const room = this.k.room(R);
    if (mat.startsWith('a_') || m.transparent || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return room.clear;
    return ceil ? room.ceil : room.b;
  }

  /** Visual box in a yawed frame, optionally tilted in the frame (x then z). */
  private part(R: string, mat: string, size: V3, pos: V3, yaw = 0, tx = 0, tz = 0, ceil = false): void {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    if (tz) g.rotateZ(tz);
    if (tx) g.rotateX(tx);
    this.builder(R, mat, ceil).add(this.k.mats[mat], g, pos, [0, yaw, 0]);
  }

  /** Visual cylinder (Y axis), tilted in the frame (x then z), then yawed. */
  private cpart(R: string, mat: string, r: number, h: number, pos: V3, yaw = 0, tx = 0, tz = 0, seg = 10, ceil = false, r2 = r): void {
    const g = new THREE.CylinderGeometry(r2, r, h, seg);
    if (tz) g.rotateZ(tz);
    if (tx) g.rotateX(tx);
    this.builder(R, mat, ceil).add(this.k.mats[mat], g, pos, [0, yaw, 0]);
  }

  private geo(R: string, mat: string, g: THREE.BufferGeometry, pos: V3, rot: V3 = [0, 0, 0], ceil = false): void {
    this.builder(R, mat, ceil).add(this.k.mats[mat], g, pos, rot);
  }

  /** One collider for a whole object (box in its frame) and its floor footprint. */
  private solid(F: Frame, hw: number, hh: number, hd: number, y0 = 0, r0 = 0, f0 = 0, receiver?: HitReceiver): void {
    const c = F.P(r0, y0 + hh, f0);
    this.k.physics.addStaticBox(new THREE.Vector3(...c), new THREE.Vector3(hw, hh, hd), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, F.yaw, 0)), receiver);
    const [ex, ez] = extents(hw, hd, F.yaw);
    if (y0 < 1.2) this.k.claim(c[0] - ex, c[2] - ez, c[0] + ex, c[2] + ez);
  }

  /** Is a yawed rectangle (half width, half depth around a frame offset) free? */
  private fits(R: string, F: Frame, hw: number, hd: number, pad = 0.15, r0 = 0, f0 = 0): boolean {
    const [ex, ez] = extents(hw, hd, F.yaw);
    const c = F.P(r0, 0, f0);
    return this.k.free(R, c[0], c[2], ex, ez, pad);
  }

  /** Frame at a design point in a room. */
  private F(R: string, xd: number, zd: number, yaw: number): Frame {
    const [x, z] = this.k.W(R, xd, zd);
    return frame(x, z, yaw);
  }

  /** Try candidate design points in order; build at the first that fits. */
  private place(R: string, cands: [number, number, number][], hw: number, hd: number, build: (F: Frame) => void, pad = 0.2): boolean {
    for (const [xd, zd, yaw] of cands) {
      const F = this.F(R, xd, zd, yaw);
      if (!this.fits(R, F, hw, hd, pad)) continue;
      build(F);
      return true;
    }
    return false;
  }

  /** Random placements in the room (world), `n` successes out of `tries`. */
  private scatter(R: string, n: number, hw: number, hd: number, build: (F: Frame) => void, o: { margin?: number; yaw?: () => number; pad?: number; tries?: number } = {}): number {
    const [x0, z0, x1, z1] = this.def(R).rect;
    const mg = o.margin ?? 1;
    let made = 0;
    for (let t = 0; t < (o.tries ?? n * 12) && made < n; t++) {
      const x = x0 + mg + this.rnd() * (x1 - x0 - 2 * mg);
      const z = z0 + mg + this.rnd() * (z1 - z0 - 2 * mg);
      const F = frame(x, z, o.yaw ? o.yaw() : this.rnd() * Math.PI * 2);
      if (!this.fits(R, F, hw, hd, o.pad ?? 0.2)) continue;
      build(F);
      made++;
    }
    return made;
  }

  // ---------------------------------------------------------------- walls

  /** Snap a design point to the nearest wall face of its room. */
  private wall(R: string, xd: number, zd: number): WallPt {
    const [x, z] = this.k.W(R, xd, zd);
    return this.wallW(R, x, z);
  }

  private wallW(R: string, x: number, z: number): WallPt {
    const [x0, z0, x1, z1] = this.def(R).rect;
    const d = [x - x0, x1 - x, z - z0, z1 - z];
    const i = d.indexOf(Math.min(...d));
    const nx = i === 0 ? 1 : i === 1 ? -1 : 0;
    const nz = i === 2 ? 1 : i === 3 ? -1 : 0;
    const wx = i === 0 ? x0 + 0.15 : i === 1 ? x1 - 0.15 : Math.min(x1 - 0.3, Math.max(x0 + 0.3, x));
    const wz = i === 2 ? z0 + 0.15 : i === 3 ? z1 - 0.15 : Math.min(z1 - 0.3, Math.max(z0 + 0.3, z));
    return { x: wx, z: wz, nx, nz, yaw: Math.atan2(nx, nz) };
  }

  /** Door centres on this room's walls, with their widths. */
  private doors(R: string): { x: number; z: number; w: number }[] {
    const room = this.def(R);
    const out: { x: number; z: number; w: number }[] = [];
    for (const l of this.k.links) {
      if (l.a !== R && l.b !== R) continue;
      const o = this.def(l.a === R ? l.b : l.a);
      const vertical = room.rect[2] === o.rect[0] || room.rect[0] === o.rect[2];
      if (vertical) out.push({ x: room.rect[2] === o.rect[0] ? room.rect[2] : room.rect[0], z: l.at, w: l.width });
      else out.push({ x: l.at, z: room.rect[3] === o.rect[1] ? room.rect[3] : room.rect[1], w: l.width });
    }
    return out;
  }

  /** Can a wall fixture of half width `half` go here? `high`: above the furniture, only doors and other fixtures matter. */
  private wallFree(R: string, p: WallPt, half: number, high = false): boolean {
    // Only this room's side of the wall counts (the room next door has its own things on it).
    const [x0, z0, x1, z1] = this.def(R).rect;
    const here = (x: number, z: number) => x > x0 && x < x1 && z > z0 && z < z1;
    for (const d of this.doors(R)) if (Math.hypot(d.x - p.x, d.z - p.z) < d.w / 2 + half + 0.6) return false;
    for (const [x, z, r] of this.k.fixtures) if (here(x, z) && Math.hypot(x - p.x, z - p.z) < r + half + 0.15) return false;
    if (high) return true;
    for (const q of this.k.reserved) if (here(q.x, q.z) && Math.hypot(q.x - p.x, q.z - p.z) < half + 1.7) return false;
    for (const s of this.k.spawns) if (here(s.pos.x, s.pos.z) && Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < half + 1.4) return false;
    return true;
  }

  /** Something standing against the wall here (raise the sign above it)? */
  private wallBlocked(R: string, p: WallPt, half: number): boolean {
    const t = [-p.nz, p.nx];
    return !this.k.free(R, p.x + p.nx * 0.45 + t[0] * 0, p.z + p.nz * 0.45 + t[1] * 0, Math.abs(t[0]) * half + 0.3, Math.abs(t[1]) * half + 0.3, 0);
  }

  /** Atlas sign on a wall (design point snapped to the wall). Returns false if the spot was taken. */
  private sign(R: string, id: string, xd: number, zd: number, y: number, h: number, o: { mat?: string; high?: boolean; frame?: boolean } = {}): boolean {
    return this.signW(R, id, this.wall(R, xd, zd), y, h, o);
  }

  private signW(R: string, id: string, p: WallPt, y: number, h: number, o: { mat?: string; high?: boolean; frame?: boolean } = {}): boolean {
    const w = h * this.atlas.aspect(id);
    if (!this.wallFree(R, p, w / 2, o.high || y - h / 2 > 2.3)) return false;
    // Furniture in front: lift the sign clear of it.
    const room = this.def(R);
    if (!o.high && y - h / 2 < 2.3 && this.wallBlocked(R, p, w / 2)) {
      if (room.h < 4.5) return false;
      y = 2.45 + h / 2;
    }
    const mat = o.mat ?? 'a_sign';
    this.geo(R, mat, this.atlas.plane(id, w, h), [p.x + p.nx * 0.022, y, p.z + p.nz * 0.022], [0, p.yaw, 0]);
    if (o.frame !== false) this.part(R, 'dark', [w + 0.05, h + 0.05, 0.02], [p.x + p.nx * 0.01, y, p.z + p.nz * 0.01], p.yaw);
    this.k.fixtures.push([p.x, p.z, w / 2]);
    return true;
  }

  /** Flat decal on the floor. `read`: yaw of a viewer reading it (text up = that way). */
  private floor(R: string, id: string, x: number, z: number, w: number, h: number, read: number, mat = 'a_decal'): void {
    // Phones: puddles and frost are a draw call per room each; the plain decals carry the grime.
    if (this.k.mobile && (mat === 'a_wet' || mat === 'a_frost')) return;
    this.decalY = (this.decalY + 1) % 12;
    this.geo(R, mat, this.atlas.plane(id, w, h), [x, 0.024 + this.decalY * 0.0006, z], [-Math.PI / 2, 0, read + Math.PI]);
  }

  /** Decal on a wall face. */
  private wallDecal(R: string, id: string, p: WallPt, y: number, w: number, h: number, mat = 'a_decal'): void {
    this.decalY = (this.decalY + 1) % 12;
    const o = 0.012 + this.decalY * 0.0006;
    this.geo(R, mat, this.atlas.plane(id, w, h), [p.x + p.nx * o, y, p.z + p.nz * o], [0, p.yaw, 0]);
  }

  /** One of the lore plates (public/signs): enamelled steel, bolted to the wall. */
  private plate(R: string, file: string, xd: number, zd: number, y: number, h: number): boolean {
    const p = this.wall(R, xd, zd);
    const w = h * 0.8;
    if (!this.wallFree(R, p, w / 2)) return false;
    let mat = this.plates.get(file);
    if (!mat) {
      const t = new THREE.TextureLoader().load(`signs/${this.k.mobile ? 'm/' : ''}${file}.webp`);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.k.mobile ? MOBILE_ANISOTROPY : 8;
      mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, metalness: 0.35 });
      this.plates.set(file, mat);
    }
    this.k.room(R).clear.add(mat, new THREE.PlaneGeometry(w, h), [p.x + p.nx * 0.026, y, p.z + p.nz * 0.026], [0, p.yaw, 0]);
    this.part(R, 'd_black', [w + 0.04, h + 0.04, 0.025], [p.x + p.nx * 0.0125, y, p.z + p.nz * 0.0125], p.yaw);
    this.k.fixtures.push([p.x, p.z, w / 2 + 0.2]);
    return true;
  }

  // ---------------------------------------------------------------- architecture

  /** Wainscot / paint band along every wall, trusses in the tall halls, holes in office ceilings. */
  private architecture(room: RoomDef): void {
    const R = room.id;
    const [x0, z0, x1, z1] = room.rect;
    const style = room.style;
    const band: Record<string, [string, string, number]> = {
      lobby: ['d_marble', 'gunmetal', 2.4],
      cafe: ['woodDark', 'wood', 0.95],
      security: ['d_paintSec', 'gunmetal', 1.1],
      medical: ['d_paintMed', 'steel', 0.85],
      labs: ['d_paintLab', 'gunmetal', 1.0],
      barracks: ['d_paintOlive', 'dark', 1.2],
      factory: ['d_paintInd', 'yellow', 1.4],
      hangar: ['d_paintInd', 'yellow', 1.4],
      atrium: ['d_marble', 'gunmetal', 2.6],
    };
    const b = band[style];
    if (b) {
      const [panel, rail, top] = b;
      const doors = this.doors(R);
      const walls: [number, number, number, number, number, number][] = [
        [x0, z0, x1, z0, 0, 1], [x0, z1, x1, z1, 0, -1], [x0, z0, x0, z1, 1, 0], [x1, z0, x1, z1, -1, 0],
      ];
      const joints = !INDUSTRIAL.has(style) && panel !== 'd_marble';
      for (const [ax, az, bx, bz, nx, nz] of walls) {
        const along = nz !== 0;
        const len = along ? bx - ax : bz - az;
        // Door gaps along this wall (s from a).
        const gaps: [number, number][] = [];
        for (const d of doors) {
          const on = along ? Math.abs(d.z - az) < 0.01 : Math.abs(d.x - ax) < 0.01;
          if (!on) continue;
          const s = along ? d.x - ax : d.z - az;
          gaps.push([s - d.w / 2 - 0.15, s + d.w / 2 + 0.15]);
        }
        gaps.sort((p, q) => p[0] - q[0]);
        const runs: [number, number][] = [];
        let s0 = 0.1;
        for (const [g0, g1] of gaps) {
          if (g0 > s0 + 0.2) runs.push([s0, g0]);
          s0 = Math.max(s0, g1);
        }
        if (len - 0.1 > s0 + 0.2) runs.push([s0, len - 0.1]);
        const face = 0.15;
        for (const [r0, r1] of runs) {
          const l = r1 - r0;
          const mid = (r0 + r1) / 2;
          const at = (s: number, off: number, y: number): V3 => (along ? [ax + s, y, az + nz * (face + off)] : [ax + nx * (face + off), y, az + s]);
          const size = (w: number, h: number, d: number): V3 => (along ? [w, h, d] : [d, h, w]);
          // Visual only (no floor footprint: a skin on the wall must not keep furniture off it).
          this.part(R, panel, size(l, top - 0.14, 0.016), at(mid, 0.008, 0.14 + (top - 0.14) / 2));
          this.part(R, rail, size(l, style === 'factory' || style === 'hangar' ? 0.08 : 0.06, 0.035), at(mid, 0.018, top + 0.02));
          if (joints) for (let s = r0 + 1.2; s < r1 - 0.3; s += 1.2) this.part(R, 'dark', size(0.012, top - 0.2, 0.02), at(s, 0.01, 0.14 + (top - 0.14) / 2));
        }
      }
    }

    // Roof trusses in the tall halls, between the lamp rows (spanning the short way).
    const trussRooms: Record<string, [number, number]> = { assembly: [12.1, 12.8], warehouse: [7.6, 8.75], hangar: [13.4, 14.75], power: [10.0, 10.8] };
    const tr = trussRooms[R];
    if (tr) {
      const w = x1 - x0;
      const d = z1 - z0;
      const longX = w >= d;
      const step = LAMP_SPACING[style] ?? 10;
      const n = Math.max(1, Math.round((longX ? w : d) / step));
      for (let i = 1; i < n; i++) {
        const at = longX ? x0 + (i * w) / n : z0 + (i * d) / n;
        this.truss(R, longX, at, longX ? z0 : x0, longX ? z1 : x1, tr[0], tr[1]);
      }
    }

    // Office ceilings: a few tiles down (a dark hole, the tile hanging by a corner, a loose cable).
    const office = ['lobby', 'cafe', 'security', 'medical', 'labs', 'barracks'].includes(style) && !room.sky && !room.skylight;
    if (office) {
      const step = LAMP_SPACING[style] ?? 6;
      const nx = Math.max(1, Math.round((x1 - x0) / step));
      const nz = Math.max(1, Math.round((z1 - z0) / step));
      const lamps: [number, number][] = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) lamps.push([x0 + ((i + 0.5) * (x1 - x0)) / nx, z0 + ((j + 0.5) * (z1 - z0)) / nz]);
      const holes = Math.max(1, Math.round(((x1 - x0) * (z1 - z0)) / 260));
      for (let t = 0, made = 0; t < 30 && made < holes; t++) {
        const x = x0 + 2 + this.rnd() * (x1 - x0 - 4);
        const z = z0 + 2 + this.rnd() * (z1 - z0 - 4);
        if (lamps.some(([lx, lz]) => Math.abs(lx - x) < 1.6 && Math.abs(lz - z) < 1.2)) continue;
        const h = room.h;
        const yaw = this.rnd() < 0.5 ? 0 : Math.PI / 2;
        this.part(R, 'd_black', [0.62, 0.02, 0.62], [x, h - 0.008, z], yaw, 0, 0, true);
        const F = frame(x, z, yaw);
        // The tile hangs from one edge, swung down ~70°.
        this.part(R, 'offwhite', [0.6, 0.02, 0.6], F.P(0, h - 0.3, 0.31 + 0.1), yaw, 1.25, 0, true);
        this.part(R, 'dark', [0.015, 0.9 + this.rnd() * 0.8, 0.015], F.P(0.15, h - 0.6, 0), yaw, 0.1, 0, true);
        made++;
      }
    }
  }

  /** Steel roof truss across a hall: chords, verticals and alternating diagonals. */
  private truss(R: string, acrossZ: boolean, at: number, from: number, to: number, yBot: number, yTop: number): void {
    const len = to - from - 0.3;
    const mid = (from + to) / 2;
    const dep = yTop - yBot;
    const P = (s: number, y: number): V3 => (acrossZ ? [at, y, mid + s] : [mid + s, y, at]);
    const S = (l: number, h: number, t: number): V3 => (acrossZ ? [t, h, l] : [l, h, t]);
    this.part(R, 'gunmetal', S(len, 0.18, 0.22), P(0, yTop), 0, 0, 0, true);
    this.part(R, 'gunmetal', S(len, 0.16, 0.2), P(0, yBot), 0, 0, 0, true);
    const panel = 2;
    const n = Math.max(1, Math.round(len / panel));
    const pw = len / n;
    const diag = Math.hypot(pw, dep);
    const a = Math.atan2(dep, pw);
    for (let i = 0; i <= n; i++) {
      const s = -len / 2 + i * pw;
      this.part(R, 'gunmetal', S(0.1, dep, 0.12), P(s, (yBot + yTop) / 2), 0, 0, 0, true);
      if (i < n) {
        const sign = i % 2 ? 1 : -1;
        const g = new THREE.BoxGeometry(acrossZ ? 0.08 : diag, 0.08, acrossZ ? diag : 0.08);
        if (acrossZ) g.rotateX(-sign * a);
        else g.rotateZ(sign * a);
        this.geo(R, 'gunmetal', g, P(s + pw / 2, (yBot + yTop) / 2), [0, 0, 0], true);
      }
    }
    // End plates where it meets the walls.
    for (const e of [-1, 1]) this.part(R, 'dark', S(0.1, dep + 0.5, 0.5), P(e * (len / 2 + 0.05), (yBot + yTop) / 2), 0, 0, 0, true);
  }

  // ---------------------------------------------------------------- grime

  private grime(room: RoomDef): void {
    const R = room.id;
    const [x0, z0, x1, z1] = room.rect;
    const area = (x1 - x0) * (z1 - z0);
    const ind = INDUSTRIAL.has(room.style);
    const lite = this.k.mobile ? 0.5 : 1;
    if (room.style !== 'garden') {
      const n = Math.round((area / (ind ? 45 : 60)) * lite);
      for (let i = 0; i < n; i++) {
        const x = x0 + 0.8 + this.rnd() * (x1 - x0 - 1.6);
        const z = z0 + 0.8 + this.rnd() * (z1 - z0 - 1.6);
        const k = this.rnd();
        const s = 0.8 + this.rnd() * 1.6;
        const spin = this.rnd() * Math.PI * 2;
        if (k < (ind ? 0.3 : 0.1)) this.floor(R, 'oil', x, z, s, s, spin);
        else if (k < 0.45) this.floor(R, this.rnd() < 0.5 ? 'crack' : 'crack2', x, z, s * 1.3, s * 1.3, spin);
        else if (k < 0.7) this.floor(R, 'dust', x, z, s * 1.6, s * 1.6, spin);
        else if (k < 0.8) this.floor(R, 'puddle', x, z, s * 1.2, s, spin, 'a_wet');
        else if (k < 0.9) this.floor(R, ind ? 'skid' : 'boots', x, z, s * 2.4, s * 0.6, spin);
        else this.floor(R, 'scorch', x, z, s, s, spin);
      }
    }
    // Leaks and rust run down from the ceiling; now and then a burst of bullet holes or scorch.
    const h = room.h;
    const walls: [number, number, number, number, number, number][] = [
      [x0, z0, x1, z0, 0, 1], [x0, z1, x1, z1, 0, -1], [x0, z0, x0, z1, 1, 0], [x1, z0, x1, z1, -1, 0],
    ];
    for (const [ax, az, bx, bz] of walls) {
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 2 + this.rnd() * 4; s < len - 2; s += (5 + this.rnd() * 6) / lite) {
        const t = s / len;
        const p = this.wallW(R, ax + (bx - ax) * t, az + (bz - az) * t);
        if (!this.wallFree(R, p, 0.5, true)) continue;
        const k = this.rnd();
        const top = Math.min(h - 0.1, room.sky ? 6 : h - 0.1);
        if (k < 0.45) {
          const hh = Math.min(top - 0.3, 1.6 + this.rnd() * 2.6);
          this.wallDecal(R, this.rnd() < 0.55 ? 'leak' : 'rust', p, top - hh / 2, 0.5 + this.rnd() * 0.8, hh);
        } else if (k < 0.55) {
          this.wallDecal(R, 'holes', p, 1.0 + this.rnd() * 0.9, 0.9, 0.9);
        } else if (k < 0.6) {
          this.wallDecal(R, 'scorch', p, 0.7 + this.rnd() * 0.6, 1.5, 1.5);
        }
      }
    }
    // A sector air panel by the first door, an exit sign beside some doors.
    const temp: Record<string, string> = { start: 'temp1', lounge: 'temp1', security: 'temp1', garden: 'temp3', medical: 'temp1', atrium: 'temp2', assembly: 'temp3', hangar: 'temp3', labs: 'temp2', deeplabs: 'temp2', servers: 'temp4', barracks: 'temp1', power: 'temp1' };
    const doors = this.doors(R);
    if (!room.sky && doors.length) {
      const d = doors[Math.floor(this.rnd() * doors.length)];
      for (const side of [1, -1]) {
        const p = this.wallW(R, d.x, d.z);
        const tx = -p.nz;
        const tz = p.nx;
        const q = this.wallW(R, p.x + tx * side * (d.w / 2 + 1.1), p.z + tz * side * (d.w / 2 + 1.1));
        if (this.signW(R, temp[room.zone] ?? 'temp2', q, 1.55, 0.2, { mat: 'a_lit' })) break;
      }
      for (const dd of doors) {
        if (this.rnd() < 0.45) continue;
        const p = this.wallW(R, dd.x, dd.z);
        const off = dd.w / 2 + 0.55;
        const q = this.wallW(R, p.x - p.nz * off, p.z + p.nx * off);
        let ok = true;
        for (const [x, z, r] of this.k.fixtures) if (Math.hypot(x - q.x, z - q.z) < r + 0.4) ok = false;
        if (!ok) continue;
        const y = Math.min(room.h - 0.5, 2.35);
        this.geo(R, 'a_exit', this.atlas.plane('exit', 0.44, 0.22), [q.x + q.nx * 0.05, y, q.z + q.nz * 0.05], [0, q.yaw, 0]);
        this.part(R, 'd_black', [0.48, 0.26, 0.06], [q.x + q.nx * 0.02, y, q.z + q.nz * 0.02], q.yaw);
        this.k.fixtures.push([q.x, q.z, 0.3]);
      }
    }
  }

  // ---------------------------------------------------------------- furniture kit

  /** Things on a desk top: monitors facing the sitter (at -f), keyboard, papers, mug. */
  private deskTop(R: string, F: Frame, w: number, y: number, monitors = 1): void {
    const r = this.rnd;
    for (let i = 0; i < monitors; i++) {
      const mr = monitors === 1 ? (r() - 0.5) * w * 0.3 : (i - (monitors - 1) / 2) * 0.68;
      const yaw = F.yaw + (monitors > 1 ? -(i - (monitors - 1) / 2) * 0.25 : 0);
      this.part(R, 'dark', [0.26, 0.02, 0.18], F.P(mr, y + 0.01, 0.22), F.yaw);
      this.part(R, 'dark', [0.05, 0.3, 0.05], F.P(mr, y + 0.16, 0.26), F.yaw);
      this.part(R, 'd_black', [0.6, 0.37, 0.04], F.P(mr, y + 0.43, 0.24), yaw);
      if (r() < 0.75) this.part(R, 'screen', [0.55, 0.31, 0.01], F.P(mr, y + 0.43, 0.218), yaw);
    }
    this.part(R, 'dark', [0.44, 0.02, 0.15], F.P((r() - 0.5) * 0.1, y + 0.01, -0.12), F.yaw + (r() - 0.5) * 0.15);
    this.part(R, 'd_black', [0.06, 0.02, 0.1], F.P(0.34, y + 0.01, -0.12), F.yaw + r());
    for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) this.part(R, 'paper', [0.21, 0.003 + i * 0.002, 0.29], F.P((r() - 0.5) * w * 0.8, y + 0.003 + i * 0.002, (r() - 0.5) * 0.3), F.yaw + (r() - 0.5) * 0.8);
    if (r() < 0.7) this.cpart(R, r() < 0.5 ? 'white' : 'vanta', 0.045, 0.1, F.P((r() < 0.5 ? -1 : 1) * w * 0.38, y + 0.05, (r() - 0.5) * 0.3), 0, 0, 0, 8);
    if (r() < 0.4) {
      // Binder stack.
      for (let i = 0; i < 3; i++) this.part(R, ['d_blue', 'd_red', 'dark'][i], [0.3, 0.06, 0.25], F.P(-w * 0.38, y + 0.03 + i * 0.06, 0.15), F.yaw + (r() - 0.5) * 0.3);
    }
  }

  /** Office desk (model) with its chair; sitter at -f facing +f. */
  private desk(R: string, F: Frame, monitors = 1, chair = true): void {
    this.k.prop(R, 'desk', F.P(0, 0, 0), F.yaw);
    this.deskTop(R, F, 1.9, 0.79, monitors);
    if (chair) {
      const tipped = this.rnd() < 0.2;
      if (tipped) this.k.prop(R, 'chair', F.P((this.rnd() - 0.5) * 0.8, 0.34, -1.0), F.yaw + Math.PI + (this.rnd() - 0.5), { tilt: [-Math.PI / 2, 0, 0], solid: false });
      else this.k.prop(R, 'chair', F.P((this.rnd() - 0.5) * 0.6, 0, -0.78), F.yaw + (this.rnd() - 0.5) * 0.7, { solid: false });
    }
  }

  /** Steel shelving with stuff on it (faces +f; back to the wall). */
  private shelf(R: string, F: Frame, w = 1.2, levels = 4, kind: 'boxes' | 'lab' | 'binders' | 'parts' = 'boxes'): void {
    const d = 0.5;
    const h = 2.0;
    for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.part(R, 'gunmetal', [0.04, h, 0.04], F.P(sr * (w / 2 - 0.02), h / 2, sf * (d / 2 - 0.02)), F.yaw);
    const r = this.rnd;
    for (let i = 0; i < levels; i++) {
      const y = 0.12 + (i * (h - 0.2)) / (levels - 1);
      this.part(R, 'steel', [w, 0.025, d], F.P(0, y, 0), F.yaw);
      if (i === levels - 1 && r() < 0.5) continue;
      let s = -w / 2 + 0.06;
      while (s < w / 2 - 0.15) {
        const k = r();
        if (k < 0.15) {
          s += 0.15 + r() * 0.2;
          continue;
        }
        if (kind === 'binders') {
          const bw = 0.06 + r() * 0.03;
          this.part(R, ['d_blue', 'd_red', 'dark', 'd_cream', 'd_army'][Math.floor(r() * 5)], [bw, 0.3, 0.26], F.P(s + bw / 2, y + 0.16, 0.05), F.yaw, 0, r() < 0.15 ? 0.25 : 0);
          s += bw + 0.005;
        } else if (kind === 'lab') {
          const br = 0.04 + r() * 0.04;
          const bh = 0.12 + r() * 0.2;
          this.cpart(R, r() < 0.6 ? 'd_bottle' : 'd_plastic', br, bh, F.P(s + br, y + bh / 2 + 0.013, (r() - 0.5) * 0.25), 0, 0, 0, 8);
          s += br * 2 + 0.03;
        } else if (kind === 'parts') {
          const bw = 0.22 + r() * 0.15;
          this.part(R, r() < 0.5 ? 'd_blue' : 'yellow', [bw, 0.16, 0.36], F.P(s + bw / 2, y + 0.09, 0.02), F.yaw);
          if (r() < 0.5) this.part(R, 'gunmetal', [bw * 0.6, 0.08, 0.15], F.P(s + bw / 2, y + 0.2, 0.0), F.yaw + r());
          s += bw + 0.03;
        } else {
          const bw = 0.25 + r() * 0.25;
          const bh = 0.18 + r() * Math.min(0.3, (h - 0.3) / levels - 0.2);
          this.part(R, r() < 0.7 ? 'cardboard' : 'd_plastic', [bw, bh, 0.36 + r() * 0.08], F.P(s + bw / 2, y + bh / 2 + 0.013, 0), F.yaw + (r() - 0.5) * 0.15);
          s += bw + 0.02;
        }
      }
    }
    this.solid(F, w / 2, h / 2, d / 2);
  }

  /** Filing cabinet, a drawer sometimes left open. */
  private cabinet(R: string, F: Frame): void {
    this.part(R, 'gunmetal', [0.48, 1.32, 0.62], F.P(0, 0.66, 0), F.yaw);
    const open = this.rnd() < 0.3 ? Math.floor(this.rnd() * 4) : -1;
    for (let i = 0; i < 4; i++) {
      const y = 0.18 + i * 0.32;
      const pull = i === open ? 0.32 : 0;
      this.part(R, 'grey', [0.44, 0.29, 0.02], F.P(0, y, 0.31 + pull), F.yaw);
      this.part(R, 'd_chrome', [0.14, 0.025, 0.03], F.P(0, y + 0.08, 0.33 + pull), F.yaw);
      if (pull) {
        this.part(R, 'gunmetal', [0.42, 0.25, pull], F.P(0, y, 0.31 + pull / 2), F.yaw);
        for (let j = 0; j < 4; j++) this.part(R, 'd_cream', [0.36, 0.22, 0.01], F.P(0, y + 0.03, 0.34 + j * 0.06), F.yaw, 0.1);
      }
    }
    this.solid(F, 0.24, 0.66, 0.31);
  }

  /** Bench for sitting: slats on two legs, long along r. */
  private bench(R: string, F: Frame, w = 1.8, mat = 'wood'): void {
    for (let i = 0; i < 3; i++) this.part(R, mat, [w, 0.04, 0.11], F.P(0, 0.44, -0.14 + i * 0.14), F.yaw);
    for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.06, 0.44, 0.4], F.P(s * (w / 2 - 0.15), 0.22, 0), F.yaw);
    this.solid(F, w / 2, 0.23, 0.22);
  }

  /** Bin: a lidded cylinder. */
  private bin(R: string, x: number, z: number, mat = 'gunmetal', r = 0.24, h = 0.7): void {
    this.k.cyl(R, mat, r, h, [x, h / 2, z], true, [0, 0, 0], 12);
    this.k.cyl(R, 'dark', r + 0.02, 0.05, [x, h + 0.02, z], false, [0, 0, 0], 12);
  }

  /** K-series carrier, powered down (yellow lamp dark, one glowing on standby now and then). */
  private kSeries(R: string, F: Frame): void {
    this.part(R, 'offwhite', [0.8, 0.5, 1.15], F.P(0, 0.55, 0), F.yaw);
    this.part(R, 'yellow', [0.82, 0.08, 1.17], F.P(0, 0.78, 0), F.yaw);
    for (const s of [-1, 1]) {
      this.part(R, 'd_rubber', [0.2, 0.32, 1.25], F.P(s * 0.5, 0.18, 0), F.yaw);
      for (const f of [-0.45, 0, 0.45]) this.cpart(R, 'gunmetal', 0.13, 0.22, F.P(s * 0.5, 0.18, f), F.yaw, 0, Math.PI / 2, 10);
    }
    this.part(R, 'dark', [0.42, 0.3, 0.34], F.P(0, 0.97, 0.3), F.yaw);
    this.cpart(R, this.rnd() < 0.3 ? 'lampWarm' : 'd_black', 0.11, 0.06, F.P(0, 0.98, 0.48), F.yaw, Math.PI / 2, 0, 14);
    this.cpart(R, 'dark', 0.012, 0.5, F.P(-0.25, 1.3, -0.4), F.yaw, 0.2, 0, 6);
    this.part(R, 'd_black', [0.5, 0.02, 0.4], F.P(0, 0.81, -0.25), F.yaw);
    this.solid(F, 0.6, 0.55, 0.65);
  }

  /** Industrial arm on a round base, facing +f. `slump`: powered down. */
  private robotArm(R: string, F: Frame, slump: boolean, mat = 'yellow'): void {
    const r = this.rnd;
    this.cpart(R, 'dark', 0.48, 0.3, F.P(0, 0.15, 0), 0, 0, 0, 16);
    const turn = (r() - 0.5) * 1.2;
    const G = frame(F.x, F.z, F.yaw + turn);
    this.cpart(R, mat, 0.36, 0.35, G.P(0, 0.47, 0), G.yaw, 0, 0, 14);
    this.part(R, mat, [0.5, 0.45, 0.5], G.P(0, 0.85, 0), G.yaw);
    this.cpart(R, 'dark', 0.22, 0.62, G.P(0, 0.9, 0), G.yaw, 0, Math.PI / 2, 12);
    const a1 = slump ? 0.55 + r() * 0.2 : 0.15 + r() * 0.25;
    const l1 = 1.35;
    const e: V3 = [0, 0.9 + Math.cos(a1) * l1, Math.sin(a1) * l1];
    this.part(R, mat, [0.3, l1, 0.32], G.P(0, 0.9 + (Math.cos(a1) * l1) / 2, (Math.sin(a1) * l1) / 2), G.yaw, a1);
    this.cpart(R, 'dark', 0.19, 0.42, G.P(0, e[1], e[2]), G.yaw, 0, Math.PI / 2, 12);
    const a2 = slump ? 2.5 + r() * 0.3 : 1.5 + r() * 0.5;
    const l2 = 1.15;
    const w: V3 = [0, e[1] + Math.cos(a2) * l2, e[2] + Math.sin(a2) * l2];
    this.part(R, mat, [0.24, l2, 0.26], G.P(0, e[1] + (Math.cos(a2) * l2) / 2, e[2] + (Math.sin(a2) * l2) / 2), G.yaw, a2);
    this.part(R, 'dark', [0.22, 0.22, 0.22], G.P(0, w[1], w[2]), G.yaw, a2);
    for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.05, 0.22, 0.08], G.P(s * 0.08, w[1] + Math.cos(a2) * 0.2, w[2] + Math.sin(a2) * 0.2), G.yaw, a2);
    // Cable loom from the base up the arm.
    this.cpart(R, 'd_black', 0.035, 1.2, G.P(0.2, 1.4, 0.25), G.yaw, a1, 0, 6);
    this.solid(F, 0.5, 0.6, 0.5);
  }

  /** A robot torso / head / limbs lying on a surface at y (half built). */
  private robotParts(R: string, F: Frame, y: number): void {
    const r = this.rnd;
    this.part(R, 'white', [0.6, 0.34, 0.48], F.P(0, y + 0.17, 0), F.yaw + (r() - 0.5) * 0.3);
    this.part(R, 'dark', [0.36, 0.14, 0.2], F.P(0, y + 0.07, 0.36), F.yaw);
    if (r() < 0.7) {
      this.part(R, 'dark', [0.32, 0.28, 0.28], F.P(0.6, y + 0.14, (r() - 0.5) * 0.2), F.yaw + r());
      this.part(R, 'lampBlue', [0.2, 0.04, 0.02], F.P(0.6, y + 0.15, 0.15), F.yaw);
    }
    if (r() < 0.8) this.part(R, 'gunmetal', [0.14, 0.14, 0.75], F.P(-0.55, y + 0.07, 0.1), F.yaw + (r() - 0.5) * 0.6);
    if (r() < 0.4) this.cpart(R, 'd_black', 0.02, 0.9, F.P(-0.1, y + 0.03, -0.4), F.yaw + r(), Math.PI / 2, 0, 5);
  }

  /** Workbench against a wall (back at -f... faces +f), pegboard with tools behind it. */
  private workbench(R: string, F: Frame, w = 2.2): void {
    const r = this.rnd;
    this.part(R, 'woodDark', [w, 0.06, 0.75], F.P(0, 0.92, 0), F.yaw);
    for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.part(R, 'gunmetal', [0.06, 0.9, 0.06], F.P(sr * (w / 2 - 0.06), 0.45, sf * 0.3), F.yaw);
    this.part(R, 'gunmetal', [w - 0.1, 0.03, 0.65], F.P(0, 0.2, 0), F.yaw);
    this.part(R, 'gunmetal', [0.2, 0.14, 0.18], F.P(w / 2 - 0.2, 1.02, 0.25), F.yaw);
    this.part(R, 'd_blue', [0.08, 0.06, 0.24], F.P(w / 2 - 0.2, 1.06, 0.35), F.yaw);
    for (let i = 0; i < 4; i++) this.part(R, ['d_red', 'd_black', 'yellow', 'gunmetal'][i], [0.05 + r() * 0.1, 0.04, 0.2 + r() * 0.15], F.P(-w / 2 + 0.3 + r() * (w - 0.8), 0.97, (r() - 0.5) * 0.4), F.yaw + r() * 3);
    // Pegboard on the wall behind (at -f).
    this.part(R, 'cardboard', [w, 1.0, 0.02], F.P(0, 1.65, -0.38), F.yaw);
    for (let i = 0; i < 9; i++) {
      const tr = -w / 2 + 0.15 + (i / 8) * (w - 0.3);
      const th = 0.15 + r() * 0.35;
      this.part(R, ['gunmetal', 'd_red', 'd_black', 'yellow'][i % 4], [0.04 + r() * 0.05, th, 0.03], F.P(tr, 1.65 + (r() - 0.5) * 0.4, -0.35), F.yaw, 0, (r() - 0.5) * 0.3);
    }
    if (r() < 0.6) for (let i = 0; i < 2; i++) this.k.prop(R, 'plasticCrate', F.P(-w / 2 + 0.4 + i * 0.55, 0.23, 0), F.yaw, { solid: false });
    this.solid(F, w / 2, 0.47, 0.38);
  }

  /** Cable reel (drum) standing on its rim, axis along r. */
  private reel(R: string, F: Frame, rad = 0.6): void {
    for (const s of [-1, 1]) this.cpart(R, 'wood', rad, 0.05, F.P(s * 0.32, rad, 0), F.yaw, 0, Math.PI / 2, 16);
    this.cpart(R, 'd_black', rad * 0.75, 0.58, F.P(0, rad, 0), F.yaw, 0, Math.PI / 2, 16);
    this.solid(F, 0.36, rad, rad);
  }

  /** Gas cylinders in a steel cage (against a wall, opening at +f). */
  private gasCage(R: string, F: Frame): void {
    const w = 1.4;
    for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.part(R, 'gunmetal', [0.05, 1.8, 0.05], F.P(sr * w / 2, 0.9, sf * 0.3), F.yaw);
    this.part(R, 'gunmetal', [w + 0.05, 0.04, 0.65], F.P(0, 1.8, 0), F.yaw);
    for (let i = 0; i < 7; i++) this.part(R, 'gunmetal', [0.02, 1.7, 0.02], F.P(-w / 2 + (i * w) / 6, 0.9, -0.3), F.yaw);
    this.part(R, 'yellow', [w, 0.05, 0.03], F.P(0, 1.1, 0.31), F.yaw);
    for (let i = 0; i < 4; i++) {
      const c = ['d_army', 'd_army', 'd_blue', 'd_red'][Math.floor(this.rnd() * 4)];
      this.cpart(R, c, 0.12, 1.45, F.P(-0.5 + i * 0.33, 0.73, -0.05), F.yaw, 0, (this.rnd() - 0.5) * 0.06, 10);
      this.cpart(R, 'd_chrome', 0.04, 0.12, F.P(-0.5 + i * 0.33, 1.5, -0.05), F.yaw, 0, 0, 6);
    }
    this.solid(F, w / 2 + 0.05, 0.9, 0.34);
  }

  /** Wooden pallet, loaded (boxes, sometimes shrink-wrapped). */
  private pallet(R: string, F: Frame, load = true): void {
    for (const f of [-0.45, 0, 0.45]) this.part(R, 'woodDark', [1.2, 0.1, 0.1], F.P(0, 0.05, f), F.yaw);
    for (let i = 0; i < 5; i++) this.part(R, 'wood', [0.14, 0.025, 1.0], F.P(-0.53 + i * 0.265, 0.115, 0), F.yaw);
    if (!load) {
      this.solid(F, 0.6, 0.07, 0.5);
      return;
    }
    const layers = 1 + Math.floor(this.rnd() * 3);
    for (let l = 0; l < layers; l++) for (const [r, f] of [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]]) this.part(R, 'cardboard', [0.56, 0.4, 0.46], F.P(r, 0.33 + l * 0.41, f), F.yaw + (this.rnd() - 0.5) * 0.05);
    if (this.rnd() < 0.5) this.part(R, 'd_wrap', [1.2, layers * 0.41 + 0.02, 1.0], F.P(0, 0.13 + (layers * 0.41) / 2, 0), F.yaw);
    this.solid(F, 0.6, 0.07 + layers * 0.2, 0.5);
  }

  /** Forklift parked, forks down, facing +f. */
  private forklift(R: string, F: Frame): void {
    this.part(R, 'yellow', [1.15, 0.8, 1.9], F.P(0, 0.75, -0.2), F.yaw);
    this.part(R, 'dark', [1.1, 0.7, 0.55], F.P(0, 0.6, -1.15), F.yaw);
    for (const sr of [-1, 1]) {
      this.part(R, 'gunmetal', [0.06, 1.25, 0.06], F.P(sr * 0.5, 1.75, 0.45), F.yaw);
      this.part(R, 'gunmetal', [0.06, 1.25, 0.06], F.P(sr * 0.5, 1.75, -0.75), F.yaw);
      this.part(R, 'gunmetal', [0.1, 2.6, 0.1], F.P(sr * 0.35, 1.3, 0.85), F.yaw);
      this.part(R, 'steel', [0.12, 0.05, 1.1], F.P(sr * 0.3, 0.05, 1.45), F.yaw);
      this.part(R, 'steel', [0.12, 0.6, 0.05], F.P(sr * 0.3, 0.3, 0.92), F.yaw);
      for (const f of [0.5, -0.9]) this.cpart(R, 'd_rubber', 0.3, 0.25, F.P(sr * 0.55, 0.3, f), F.yaw, 0, Math.PI / 2, 12);
    }
    this.part(R, 'gunmetal', [1.1, 0.05, 1.25], F.P(0, 2.4, -0.15), F.yaw);
    this.part(R, 'd_black', [0.5, 0.1, 0.45], F.P(0, 1.2, -0.45), F.yaw);
    this.part(R, 'd_black', [0.5, 0.5, 0.1], F.P(0, 1.45, -0.7), F.yaw);
    this.cpart(R, 'd_black', 0.16, 0.04, F.P(0, 1.45, 0.15), F.yaw, -0.9, 0, 12);
    this.cpart(R, 'lampWarm', 0.06, 0.05, F.P(0.45, 2.45, 0.5), F.yaw, 0, 0, 8);
    this.solid(F, 0.62, 1.2, 1.4, 0, 0, 0.1);
  }

  /** Pallet jack, handle up. */
  private palletJack(R: string, F: Frame): void {
    for (const s of [-1, 1]) this.part(R, 'd_red', [0.16, 0.07, 1.15], F.P(s * 0.27, 0.05, 0.3), F.yaw);
    this.part(R, 'd_red', [0.7, 0.25, 0.25], F.P(0, 0.15, -0.35), F.yaw);
    this.part(R, 'gunmetal', [0.04, 1.1, 0.04], F.P(0, 0.75, -0.45), F.yaw, -0.25);
    this.part(R, 'd_black', [0.36, 0.05, 0.05], F.P(0, 1.3, -0.6), F.yaw);
    this.solid(F, 0.36, 0.3, 0.7, 0, 0, 0.1);
  }

  /** A-frame step ladder. */
  private ladder(R: string, F: Frame, h = 1.9): void {
    const a = 0.22;
    for (const sf of [-1, 1]) {
      for (const sr of [-1, 1]) this.part(R, 'd_chrome', [0.05, h / Math.cos(a), 0.05], F.P(sr * 0.25, h / 2, sf * Math.tan(a) * h * 0.5), F.yaw, -sf * a);
      if (sf > 0) for (let i = 1; i < 6; i++) {
        const y = (i * h) / 6;
        this.part(R, 'd_chrome', [0.5, 0.03, 0.08], F.P(0, y, Math.tan(a) * (h - y)), F.yaw);
      }
    }
    this.part(R, 'd_orange', [0.56, 0.06, 0.2], F.P(0, h + 0.02, 0), F.yaw);
    this.solid(F, 0.3, h / 2, 0.35);
  }

  /** Rolling maintenance stairs up to a small platform (climbs towards +f). */
  private rollingStairs(R: string, F: Frame): void {
    const steps = 7;
    const rise = 0.3;
    const run = 0.28;
    for (let i = 0; i < steps; i++) this.part(R, 'steel', [0.8, 0.04, 0.3], F.P(0, (i + 1) * rise, -0.9 + i * run), F.yaw);
    this.part(R, 'steel', [0.9, 0.05, 0.9], F.P(0, (steps + 0.1) * rise, -0.9 + steps * run + 0.3), F.yaw);
    for (const s of [-1, 1]) {
      const len = Math.hypot(steps * run, steps * rise);
      this.part(R, 'yellow', [0.05, len, 0.08], F.P(s * 0.42, (steps * rise) / 2 + 0.1, -0.9 + (steps * run) / 2), F.yaw, Math.atan2(steps * run, steps * rise));
      this.part(R, 'yellow', [0.04, 1.0, 0.04], F.P(s * 0.45, steps * rise + 0.6, 1.4), F.yaw);
      this.part(R, 'yellow', [0.04, 0.04, 1.0], F.P(s * 0.45, steps * rise + 1.1, 0.9), F.yaw);
      this.part(R, 'gunmetal', [0.06, steps * rise, 0.06], F.P(s * 0.42, (steps * rise) / 2, 1.4), F.yaw);
      for (const f of [-1.05, 1.4]) this.cpart(R, 'd_rubber', 0.08, 0.06, F.P(s * 0.42, 0.08, f), F.yaw, 0, Math.PI / 2, 8);
    }
    this.solid(F, 0.48, steps * rise * 0.5 + 0.2, 1.25, 0, 0, 0.2);
  }

  /** IV stand: five-spoke base, pole, bag and line. */
  private ivStand(R: string, F: Frame): void {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.part(R, 'd_chrome', [0.03, 0.03, 0.3], F.P(Math.sin(a) * 0.14, 0.06, Math.cos(a) * 0.14), F.yaw + a);
    }
    this.cpart(R, 'd_chrome', 0.014, 1.9, F.P(0, 1.0, 0), 0, 0, 0, 6);
    this.part(R, 'd_chrome', [0.32, 0.015, 0.015], F.P(0, 1.92, 0), F.yaw);
    this.part(R, 'd_ivBag', [0.12, 0.2, 0.04], F.P(0.12, 1.75, 0), F.yaw);
    this.cpart(R, 'd_bottle', 0.004, 0.9, F.P(0.16, 1.2, 0.05), F.yaw, 0.15, 0, 4);
  }

  /** Hospital trolley; `covered`: a sheet over something on it. */
  private gurney(R: string, F: Frame, covered: boolean): void {
    this.part(R, 'd_chrome', [0.65, 0.05, 1.95], F.P(0, 0.72, 0), F.yaw);
    this.part(R, 'd_mattress', [0.6, 0.1, 1.9], F.P(0, 0.8, 0), F.yaw);
    for (const sr of [-1, 1]) for (const sf of [-1, 1]) {
      this.part(R, 'd_chrome', [0.04, 0.6, 0.04], F.P(sr * 0.28, 0.4, sf * 0.85), F.yaw);
      this.cpart(R, 'd_rubber', 0.06, 0.04, F.P(sr * 0.28, 0.07, sf * 0.85), F.yaw, 0, Math.PI / 2, 8);
    }
    if (covered) {
      this.part(R, 'd_sheet', [0.66, 0.22, 1.7], F.P(0, 0.96, 0.05), F.yaw);
      this.part(R, 'd_sheet', [0.4, 0.16, 0.35], F.P(0, 1.12, 0.75), F.yaw);
      this.part(R, 'd_sheet', [0.02, 0.3, 1.6], F.P(0.34, 0.8, 0.05), F.yaw);
    } else {
      this.part(R, 'd_sheet', [0.62, 0.03, 1.2], F.P(0, 0.87, -0.2), F.yaw, 0, 0.05);
      this.part(R, 'white', [0.45, 0.1, 0.3], F.P(0, 0.9, 0.75), F.yaw);
    }
    this.solid(F, 0.34, 0.5, 1.0);
  }

  private wheelchair(R: string, F: Frame): void {
    for (const s of [-1, 1]) {
      this.geo(R, 'd_rubber', new THREE.TorusGeometry(0.3, 0.025, 6, 18), F.P(s * 0.3, 0.32, -0.05), [0, F.yaw + Math.PI / 2, 0]);
      this.cpart(R, 'd_chrome', 0.02, 0.6, F.P(s * 0.3, 0.32, -0.05), F.yaw, Math.PI / 2, 0, 5);
      this.cpart(R, 'd_rubber', 0.06, 0.03, F.P(s * 0.22, 0.06, 0.4), F.yaw, 0, Math.PI / 2, 8);
      this.part(R, 'd_chrome', [0.025, 0.6, 0.025], F.P(s * 0.22, 0.52, -0.25), F.yaw, -0.1);
    }
    this.part(R, 'd_black', [0.46, 0.05, 0.45], F.P(0, 0.5, 0.05), F.yaw);
    this.part(R, 'd_black', [0.46, 0.45, 0.04], F.P(0, 0.8, -0.24), F.yaw, -0.12);
    this.part(R, 'd_chrome', [0.4, 0.03, 0.15], F.P(0, 0.12, 0.42), F.yaw);
    this.solid(F, 0.34, 0.45, 0.45);
  }

  /** Green oxygen bottles chained to a wall. */
  private oxygen(R: string, F: Frame, n = 3): void {
    for (let i = 0; i < n; i++) {
      this.cpart(R, 'd_army', 0.11, 1.3, F.P(-0.25 * (n - 1) / 2 + i * 0.25, 0.65, 0), F.yaw, 0, (this.rnd() - 0.5) * 0.05, 10);
      this.cpart(R, 'white', 0.11, 0.12, F.P(-0.25 * (n - 1) / 2 + i * 0.25, 1.35, 0), F.yaw, 0, 0, 10);
    }
    this.part(R, 'gunmetal', [0.25 * n + 0.1, 0.03, 0.03], F.P(0, 1.0, 0.12), F.yaw);
    this.solid(F, 0.13 * n, 0.65, 0.14);
  }

  /** Red crash cart with a defibrillator on top. */
  private crashCart(R: string, F: Frame): void {
    this.part(R, 'd_red', [0.7, 0.95, 0.5], F.P(0, 0.55, 0), F.yaw);
    for (let i = 0; i < 5; i++) this.part(R, 'dark', [0.66, 0.012, 0.01], F.P(0, 0.2 + i * 0.18, 0.255), F.yaw);
    this.part(R, 'gunmetal', [0.75, 0.04, 0.55], F.P(0, 1.04, 0), F.yaw);
    this.part(R, 'yellow', [0.35, 0.18, 0.25], F.P(-0.1, 1.15, 0), F.yaw);
    this.part(R, 'screen', [0.15, 0.1, 0.01], F.P(-0.1, 1.17, 0.127), F.yaw);
    this.k.prop(R, 'medkit', F.P(0.2, 1.06, 0.05), F.yaw + 0.3, { solid: false });
    for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.cpart(R, 'd_rubber', 0.05, 0.04, F.P(sr * 0.3, 0.05, sf * 0.2), F.yaw, 0, Math.PI / 2, 8);
    this.solid(F, 0.38, 0.55, 0.28);
  }

  /** Vending machine: glass front over rows of products, a lit price strip. Back to the wall. */
  private vending(R: string, F: Frame): void {
    this.part(R, 'd_black', [1.0, 1.9, 0.8], F.P(0, 0.95, 0), F.yaw);
    this.part(R, 'vanta', [1.02, 0.18, 0.82], F.P(0, 1.85, 0), F.yaw);
    const cols = ['d_red', 'd_blue', 'yellow', 'd_army', 'd_orange', 'white'];
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c < 5; c++) {
        if (this.rnd() < 0.25) continue;
        this.part(R, cols[Math.floor(this.rnd() * cols.length)], [0.1, 0.16, 0.08], F.P(-0.32 + c * 0.13, 0.55 + row * 0.24, 0.32), F.yaw);
      }
      this.part(R, 'steel', [0.7, 0.015, 0.2], F.P(-0.06, 0.46 + row * 0.24, 0.3), F.yaw);
    }
    this.part(R, 'd_wrap', [0.74, 1.3, 0.02], F.P(-0.06, 1.0, 0.41), F.yaw);
    this.part(R, 'screen', [0.14, 0.5, 0.01], F.P(0.38, 1.2, 0.405), F.yaw);
    this.part(R, 'dark', [0.7, 0.18, 0.03], F.P(-0.06, 0.2, 0.41), F.yaw);
    this.solid(F, 0.5, 0.95, 0.4);
  }

  /** Stanchion post (+ belt towards (x2, z2) if given). */
  private stanchion(R: string, x: number, z: number, to?: [number, number], belt = 'vanta'): void {
    this.k.cyl(R, 'dark', 0.17, 0.03, [x, 0.035, z], false, [0, 0, 0], 12);
    this.k.cyl(R, 'd_chrome', 0.03, 0.95, [x, 0.5, z], false, [0, 0, 0], 8);
    this.k.cyl(R, 'd_chrome', 0.045, 0.06, [x, 0.98, z], false, [0, 0, 0], 8);
    this.k.physics.addStaticBox(new THREE.Vector3(x, 0.5, z), new THREE.Vector3(0.08, 0.5, 0.08));
    if (to) {
      const dx = to[0] - x;
      const dz = to[1] - z;
      const len = Math.hypot(dx, dz);
      this.part(R, belt, [0.012, 0.05, len - 0.08], [(x + to[0]) / 2, 0.88, (z + to[1]) / 2], Math.atan2(dx, dz), 0.0, 0);
    }
  }

  /** Railing segment from a to b (posts at both ends, top + mid rail), solid. */
  private rail(R: string, a: [number, number], b: [number, number], y0 = 0, h = 1.05, mat = 'yellow', solid = true): void {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    this.part(R, mat, [0.05, 0.05, len], [mx, y0 + h, mz], yaw);
    this.part(R, mat, [0.04, 0.04, len], [mx, y0 + h * 0.5, mz], yaw);
    this.part(R, mat, [0.06, h, 0.06], [a[0], y0 + h / 2, a[1]], yaw);
    if (solid) this.k.physics.addStaticBox(new THREE.Vector3(mx, y0 + h / 2, mz), new THREE.Vector3(0.04, h / 2, len / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
  }

  /** Low traffic cone. */
  private cone(R: string, x: number, z: number, tip = 0): void {
    this.k.box(R, 'd_orange', [0.36, 0.03, 0.36], [x, 0.015, z], false);
    this.geo(R, 'd_orange', new THREE.ConeGeometry(0.14, 0.5, 10), [x, 0.27, z], tip ? [tip, 0, 0.2] : [0, 0, 0]);
    this.geo(R, 'white', new THREE.CylinderGeometry(0.085, 0.105, 0.07, 10), [x, 0.27, z]);
  }

  /** Hazard tape between two points at height y. */
  private tape(R: string, a: [number, number], b: [number, number], y: number): void {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const n = Math.max(1, Math.round(len / 0.5));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const sag = Math.sin(t * Math.PI) * 0.08;
      this.part(R, i % 2 ? 'yellow' : 'd_black', [0.006, 0.06, len / n], [a[0] + dx * t, y - sag, a[1] + dz * t], yaw);
    }
  }

  /** Chain / cable hanging straight down from `top` to `y`. */
  private hang(R: string, x: number, z: number, top: number, y: number, mat = 'dark', r = 0.015): void {
    if (top - y > 0.05) this.cpart(R, mat, r, top - y, [x, (top + y) / 2, z], 0, 0, 0, 5, true);
  }

  /** Hook block: crane hook on a cable. */
  private hook(R: string, x: number, z: number, top: number, y: number): void {
    this.hang(R, x - 0.08, z, top, y + 0.5, 'dark', 0.02);
    this.hang(R, x + 0.08, z, top, y + 0.5, 'dark', 0.02);
    this.part(R, 'yellow', [0.36, 0.5, 0.22], [x, y + 0.3, z], 0, 0, 0, true);
    this.geo(R, 'gunmetal', new THREE.TorusGeometry(0.16, 0.045, 6, 14, Math.PI * 1.4), [x, y - 0.1, z], [0, 0, Math.PI * 0.8], true);
  }

  /** Walkway at height y along a wall: deck, railing on the room side, brackets into the wall. */
  private catwalk(R: string, p: WallPt, from: number, to: number, y: number, depth = 1.1): void {
    // Along the wall: tangent t = (-nz, nx).
    const tx = -p.nz;
    const tz = p.nx;
    const len = to - from;
    const mid = (from + to) / 2;
    const at = (s: number, off: number, yy: number): V3 => [p.x + tx * s + p.nx * off, yy, p.z + tz * s + p.nz * off];
    const yaw = Math.atan2(tx, tz);
    this.part(R, 'gunmetal', [0.05, 0.06, len], at(mid, depth / 2, y), yaw, 0, 0, true);
    for (let k = 0; k < 6; k++) this.part(R, 'steel', [depth / 6 - 0.02, 0.03, len], at(mid, (k + 0.5) * (depth / 6), y + 0.03), yaw, 0, 0, true);
    for (const off of [0.03, depth]) this.part(R, 'gunmetal', [0.06, 0.16, len], at(mid, off, y - 0.05), yaw, 0, 0, true);
    for (let s = from; s <= to + 0.01; s += 1.5) {
      this.part(R, 'yellow', [0.05, 1.05, 0.05], at(s, depth, y + 0.55), yaw, 0, 0, true);
      if (Math.round((s - from) / 1.5) % 2 === 0) this.part(R, 'gunmetal', [0.06, 0.06, Math.hypot(depth, 0.9)], at(s, depth / 2, y - 0.45), p.yaw, -Math.atan2(0.9, depth), 0, true);
    }
    this.part(R, 'yellow', [0.05, 0.05, len], at(mid, depth, y + 1.08), yaw, 0, 0, true);
    this.part(R, 'yellow', [0.04, 0.04, len], at(mid, depth, y + 0.58), yaw, 0, 0, true);
    this.part(R, 'yellow', [0.02, 0.12, len], at(mid, depth, y + 0.1), yaw, 0, 0, true);
  }

  /** Vertical ladder on a wall from the floor up to y. */
  private wallLadder(R: string, p: WallPt, s: number, y: number): void {
    const tx = -p.nz;
    const tz = p.nx;
    const at = (o: number, off: number, yy: number): V3 => [p.x + tx * (s + o) + p.nx * off, yy, p.z + tz * (s + o) + p.nz * off];
    for (const o of [-0.22, 0.22]) this.part(R, 'yellow', [0.05, y + 1.0, 0.05], at(o, 0.18, (y + 1.0) / 2), p.yaw);
    for (let yy = 0.3; yy < y + 0.9; yy += 0.3) this.part(R, 'gunmetal', [0.44, 0.03, 0.03], at(0, 0.18, yy), p.yaw);
  }

  /** Planter box with a shrub. */
  private planter(R: string, F: Frame, w = 1.4): void {
    this.part(R, 'offwhite', [w, 0.6, 0.6], F.P(0, 0.3, 0), F.yaw);
    this.part(R, 'soil', [w - 0.1, 0.03, 0.5], F.P(0, 0.6, 0), F.yaw);
    for (let i = 0; i < Math.round(w * 2.5); i++) this.geo(R, this.rnd() < 0.5 ? 'leaf' : 'leafDark', new THREE.IcosahedronGeometry(0.2 + this.rnd() * 0.15, 0), F.P(-w / 2 + 0.2 + this.rnd() * (w - 0.4), 0.75 + this.rnd() * 0.2, (this.rnd() - 0.5) * 0.3));
    this.solid(F, w / 2, 0.3, 0.3);
  }

  // ---------------------------------------------------------------- rooms

  private lobby(): void {
    const R = 'lobby';
    const k = this.k;
    // Rugs under the waiting areas, things on the coffee tables.
    for (const x of [-12, 12]) {
      const [rx, rz] = k.W(R, x, 61);
      k.box(R, 'd_blanket2', [4.2, 0.012, 5.6], [rx, 0.026, rz], false);
      k.box(R, 'woodDark', [4.4, 0.01, 5.8], [rx, 0.022, rz], false);
      for (let i = 0; i < 4; i++) this.part(R, ['d_red', 'd_blue', 'paper', 'd_cream'][i], [0.22, 0.008, 0.3], [rx - 0.4 + i * 0.25, 0.405 + i * 0.008, rz + (this.rnd() - 0.5) * 0.3], this.rnd());
      this.cpart(R, 'white', 0.045, 0.1, [rx + 0.55, 0.45, rz + 0.15], 0, 0, 0, 8);
    }
    // Reception: the counter's working side (receptionist at +z, facing north).
    const D = this.F(R, 0, 70.6, Math.PI);
    this.part(R, 'dark', [0.44, 0.02, 0.15], D.P(-1.5, 1.19, -0.05), D.yaw);
    this.part(R, 'dark', [0.44, 0.02, 0.15], D.P(1.5, 1.19, -0.05), D.yaw + 0.1);
    this.part(R, 'd_black', [0.22, 0.07, 0.18], D.P(0.3, 1.2, -0.1), D.yaw + 0.3);
    this.part(R, 'offwhite', [0.32, 0.18, 0.3], D.P(-0.4, 1.25, 0.1), D.yaw);
    this.part(R, 'd_black', [0.2, 0.012, 0.28], D.P(-0.4, 1.32, 0.15), D.yaw);
    for (let i = 0; i < 5; i++) this.part(R, 'paper', [0.21, 0.004, 0.29], D.P(-3 + this.rnd() * 6, 1.183 + i * 0.002, (this.rnd() - 0.5) * 0.4), D.yaw + this.rnd());
    this.cpart(R, 'vanta', 0.045, 0.1, D.P(2.2, 1.23, 0.1), 0, 0, 0, 8);
    // Visitor sign-in clipboard on the front edge, and a desk lamp.
    this.part(R, 'cardboard', [0.24, 0.01, 0.32], D.P(0.9, 1.19, -0.65), D.yaw + 0.1);
    this.part(R, 'paper', [0.21, 0.004, 0.28], D.P(0.9, 1.197, -0.66), D.yaw + 0.1);
    this.cpart(R, 'dark', 0.08, 0.02, D.P(-2.6, 1.19, 0.2), 0, 0, 0, 10);
    this.part(R, 'dark', [0.02, 0.45, 0.02], D.P(-2.6, 1.4, 0.15), D.yaw, 0.3);
    this.cpart(R, 'lampWarm', 0.08, 0.1, D.P(-2.6, 1.6, 0.0), D.yaw, 0.9, 0, 10, false, 0.03);
    for (const r of [-0.8, 1.6]) k.prop(R, 'chair', D.P(r, 0, 1.1), D.yaw + Math.PI + (this.rnd() - 0.5) * 0.6, { solid: false });
    // Queue barrier in front of the counter.
    const q = [-3, -1, 1, 3].map((x) => k.W(R, x, 67.2));
    q.forEach((p, i) => this.stanchion(R, p[0], p[1], i < q.length - 1 ? q[i + 1] : undefined));
    // Pendant ring over the reception.
    const [cx, cz] = k.W(R, 0, 70);
    this.geo(R, 'lampWarm', new THREE.TorusGeometry(2.6, 0.06, 6, 48), [cx, 5.6, cz], [Math.PI / 2, 0, 0], true);
    this.geo(R, 'gunmetal', new THREE.TorusGeometry(2.6, 0.1, 6, 48), [cx, 5.68, cz], [Math.PI / 2, 0, 0], true);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this.hang(R, cx + Math.cos(a) * 2.6, cz + Math.sin(a) * 2.6, 7, 5.7);
    }
    // Planters either side of the atrium shutter, benches on the side walls, a vending machine.
    this.place(R, [[-9, 53.4, 0], [-10, 53.4, 0]], 0.7, 0.3, (F) => this.planter(R, F));
    this.place(R, [[9, 53.4, 0], [10, 53.4, 0]], 0.7, 0.3, (F) => this.planter(R, F));
    this.place(R, [[-17.1, 64.5, Math.PI / 2], [-17.1, 63, Math.PI / 2]], 0.9, 0.25, (F) => this.bench(R, F, 1.8, 'woodDark'));
    this.place(R, [[17.2, 64, -Math.PI / 2], [17.2, 76, -Math.PI / 2], [17.2, 63, -Math.PI / 2]], 0.5, 0.4, (F) => this.vending(R, F));
    this.place(R, [[-17.2, 77, Math.PI / 2], [-17.2, 64, Math.PI / 2]], 0.5, 0.4, (F) => this.vending(R, F));
    // Inlaid floor mark between the reception and the shutter.
    const [lx, lz] = k.W(R, 0, 60);
    this.geo(R, 'd_black', new THREE.CylinderGeometry(1.9, 1.9, 0.004, 40), [lx, 0.022, lz]);
    this.geo(R, 'offwhite', new THREE.CylinderGeometry(1.65, 1.65, 0.004, 40), [lx, 0.024, lz]);
    k.box(R, 'vanta', [0.25, 0.006, 1.6], [lx - 0.6, 0.026, lz], false);
    k.box(R, 'd_black', [0.8, 0.006, 0.18], [lx + 0.15, 0.026, lz - 0.5], false);
    k.box(R, 'd_black', [0.8, 0.006, 0.18], [lx + 0.15, 0.026, lz], false);
    k.box(R, 'd_black', [0.8, 0.006, 0.18], [lx + 0.15, 0.026, lz + 0.5], false);
    this.lobbyFitout();
    // Signs and the clock (stopped at 3:12).
    this.sign(R, 'evac', -11, 52, 1.65, 0.7);
    this.sign(R, 'poster1', 11.5, 52, 1.7, 1.1);
    this.sign(R, 'muster', 18, 76, 1.7, 0.6);
    this.sign(R, 'liftOut', 10.4, 84, 1.45, 0.3);
    this.sign(R, 'clock', -18, 72, 3.4, 0.55, { mat: 'a_decal', frame: false, high: true });
    // Somebody sprayed a warning in front of the lifts; footprints lead away from them.
    const [gx, gz] = k.W(R, 0, 81.3);
    this.floor(R, 'graffitiLifts', gx, gz, 3.6, 0.9, 0);
    const [bx, bz] = k.W(R, 7, 79);
    this.floor(R, 'boots', bx - 1.2, bz - 1.5, 3.2, 0.8, Math.PI * 0.8);
  }

  private cafeteria(): void {
    const R = 'cafeteria';
    const k = this.k;
    const r = this.rnd;
    // What was left on the tables.
    for (let x = -60; x <= -30; x += 6) {
      for (const zd of [60, 66, 72]) {
        const [tx, tz] = k.W(R, x, zd);
        for (let i = 0, n = 1 + Math.floor(r() * 5); i < n; i++) {
          const px = tx + (r() - 0.5) * 2.0;
          const pz = tz + (r() - 0.5) * 0.6;
          const kind = r();
          if (kind < 0.35) {
            this.part(R, 'gunmetal', [0.45, 0.015, 0.32], [px, 0.808, pz], r() * 0.4);
            this.cpart(R, 'white', 0.11, 0.015, [px + 0.05, 0.823, pz], 0, 0, 0, 12);
            if (r() < 0.5) this.cpart(R, 'd_cream', 0.035, 0.09, [px - 0.15, 0.86, pz + 0.08], 0, 0, 0, 8);
          } else if (kind < 0.6) {
            this.cpart(R, r() < 0.5 ? 'white' : 'd_red', 0.04, 0.1, [px, 0.85, pz], 0, 0, 0, 8);
          } else if (kind < 0.75) {
            // A cup on its side, a spill.
            this.cpart(R, 'white', 0.04, 0.1, [px, 0.84, pz], r() * 3, Math.PI / 2, 0, 8);
            this.floor(R, 'oil', px, pz, 0.5, 0.5, r() * 6);
          } else if (kind < 0.88) {
            this.cpart(R, 'd_bottle', 0.035, 0.24, [px, 0.92, pz], 0, 0, 0, 8);
          } else {
            this.part(R, 'd_chrome', [0.1, 0.12, 0.08], [px, 0.86, pz], r());
          }
        }
      }
    }
    // Chairs knocked over between the tables.
    this.scatter(R, 9, 0.4, 0.55, (F) => k.prop(R, 'chair', F.P(0, 0.34, 0), F.yaw, { tilt: [-Math.PI / 2, 0, 0], solid: false }), { margin: 3 });
    // Kitchen line along the back wall behind the serving counter.
    const back = this.wall(R, -44, 84);
    const [xa] = k.W(R, -54.5, 80);
    const [xb] = k.W(R, -33.5, 80);
    const cz = back.z + back.nz * 0.33;
    const modules = Math.floor((xb - xa) / 1.2);
    for (let i = 0; i < modules; i++) {
      const x = xa + (i + 0.5) * ((xb - xa) / modules);
      const F = frame(x, cz, Math.PI);
      const kind = i % 4;
      if (kind === 0 || kind === 2) {
        this.part(R, 'gunmetal', [1.16, 0.9, 0.62], F.P(0, 0.45, 0), F.yaw);
        for (const [br, bf] of [[-0.28, -0.14], [0.28, -0.14], [-0.28, 0.14], [0.28, 0.14]]) this.cpart(R, 'd_black', 0.12, 0.02, F.P(br, 0.91, bf), 0, 0, 0, 12);
        for (let j = 0; j < 4; j++) this.cpart(R, 'dark', 0.02, 0.03, F.P(-0.4 + j * 0.27, 0.75, 0.32), F.yaw, Math.PI / 2, 0, 6);
        if (r() < 0.7) this.cpart(R, 'steel', 0.16, 0.22, F.P(-0.28, 1.03, 0.14), 0, 0, 0, 12);
        if (r() < 0.6) {
          this.cpart(R, 'dark', 0.13, 0.04, F.P(0.28, 0.94, -0.14), 0, 0, 0, 12);
          this.part(R, 'dark', [0.03, 0.02, 0.25], F.P(0.28, 0.95, -0.4), F.yaw);
        }
      } else if (kind === 1) {
        this.part(R, 'steel', [1.16, 0.9, 0.62], F.P(0, 0.45, 0), F.yaw);
        this.part(R, 'd_black', [0.6, 0.02, 0.4], F.P(0, 0.905, 0), F.yaw);
        this.cpart(R, 'd_chrome', 0.02, 0.35, F.P(0, 1.08, -0.25), F.yaw, 0, 0, 6);
        this.part(R, 'd_chrome', [0.03, 0.03, 0.2], F.P(0, 1.24, -0.16), F.yaw);
        for (let j = 0; j < 3; j++) this.cpart(R, 'white', 0.12, 0.012, F.P(0.4, 0.92 + j * 0.013, 0.1), 0, 0, 0, 12);
      } else {
        this.part(R, 'steel', [1.16, 0.9, 0.62], F.P(0, 0.45, 0), F.yaw);
        this.part(R, 'woodDark', [0.5, 0.03, 0.35], F.P(-0.2, 0.915, 0), F.yaw + 0.2);
        if (r() < 0.7) this.cpart(R, 'd_orange', 0.05, 0.06, F.P(0.3, 0.93, 0.1), 0, 0, 0, 8);
      }
    }
    this.k.physics.addStaticBox(new THREE.Vector3((xa + xb) / 2, 0.45, cz), new THREE.Vector3((xb - xa) / 2, 0.45, 0.31));
    this.k.claim(xa, cz - 0.31, xb, cz + 0.31);
    // Fridges past the ends of the line.
    for (const xd of [-57.4, -30.6]) {
      this.place(R, [[xd, 83.4, Math.PI]], 0.5, 0.4, (F) => {
        this.part(R, 'steel', [0.95, 2.05, 0.75], F.P(0, 1.025, 0), F.yaw);
        this.part(R, 'dark', [0.01, 1.9, 0.01], F.P(0, 1.0, 0.38), F.yaw);
        for (const s of [-1, 1]) this.part(R, 'd_chrome', [0.03, 0.5, 0.04], F.P(s * 0.08, 1.2, 0.4), F.yaw);
        this.solid(F, 0.48, 1.03, 0.38);
      }, 0.05);
    }
    // On the serving counter: tills, a coffee machine, trays, a sneeze guard.
    const S = this.F(R, -44, 80.5, 0);
    for (const rr of [-6, 5]) {
      this.part(R, 'd_black', [0.36, 0.12, 0.32], S.P(rr, 1.12, 0.2), S.yaw);
      this.part(R, 'screen', [0.28, 0.18, 0.01], S.P(rr, 1.27, 0.1), S.yaw, -0.4);
    }
    this.part(R, 'd_black', [0.5, 0.55, 0.45], S.P(7.2, 1.33, 0.1), S.yaw);
    this.part(R, 'd_chrome', [0.42, 0.08, 0.3], S.P(7.2, 1.1, 0.25), S.yaw);
    for (let i = 0; i < 9; i++) this.part(R, 'gunmetal', [0.45, 0.012, 0.32], S.P(-7.6, 1.07 + i * 0.014, 0), S.yaw + (r() - 0.5) * 0.08);
    this.part(R, 'glass', [13, 0.45, 0.02], S.P(0, 1.55, -0.35), S.yaw);
    for (const rr of [-6.4, 0, 6.4]) this.part(R, 'd_chrome', [0.03, 0.5, 0.03], S.P(rr, 1.3, -0.35), S.yaw);
    // Tray return rack, recycling bins, the menu easel, the wet floor by the kitchen.
    this.place(R, [[-22.5, 80, -Math.PI / 2], [-22.5, 62, -Math.PI / 2]], 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 6, 'boxes'));
    this.place(R, [[-46, 53, 0], [-36, 53, 0], [-60, 53, 0]], 1.0, 0.3, (F) => {
      ['d_blue', 'd_greenBin', 'gunmetal'].forEach((m, i) => this.bin(R, ...xz(F.P(-0.7 + i * 0.7, 0, 0)), m, 0.26, 0.85));
    });
    this.place(R, [[-31, 77, Math.PI], [-31, 76, Math.PI], [-58, 77, Math.PI]], 0.45, 0.4, (F) => {
      for (const s of [-1, 1]) this.geo(R, 'a_sign', this.atlas.plane('menu', 0.9, 0.45), F.P(0, 0.72, s * 0.17), [0, F.yaw + (s < 0 ? 0 : Math.PI), 0]);
      for (const s of [-1, 1]) this.part(R, 'woodDark', [0.94, 1.3, 0.03], F.P(0, 0.62, s * 0.15), F.yaw, s * 0.24);
      this.solid(F, 0.47, 0.6, 0.3);
    });
    const [wx, wz] = k.W(R, -37, 78);
    this.floor(R, 'puddle', wx, wz, 1.8, 1.3, 0.3, 'a_wet');
    k.prop(R, 'wetSign', [wx + 0.9, 0, wz - 0.4], 0.6, { solid: false });
    this.sign(R, 'poster1', -40, 52, 1.7, 1.1);
    this.sign(R, 'notice', -22, 52, 1.6, 0.8);
    this.sign(R, 'wash', -66, 79.5, 1.6, 0.5);
    this.sign(R, 'clock', -66, 70, 3.3, 0.5, { mat: 'a_decal', frame: false, high: true });
    this.sign(R, 'incident', -66, 60, 1.75, 0.7);
  }

  private security(): void {
    const R = 'security';
    const k = this.k;
    const r = this.rnd;
    // CCTV wall over a long console (north wall).
    const C = this.wall(R, 28, 52);
    const tx = -C.nz;
    const tz = C.nx;
    const span = 7.2;
    const free = this.wallFree(R, C, span / 2);
    if (free) {
      const at = (s: number, off: number, y: number): V3 => [C.x + tx * s + C.nx * off, y, C.z + tz * s + C.nz * off];
      this.part(R, 'd_black', [span + 0.3, 2.3, 0.08], at(0, 0.04, 2.55), C.yaw);
      for (let row = 0; row < 3; row++) {
        for (let c = 0; c < 6; c++) {
          const dead = r() < 0.2;
          this.part(R, dead ? 'dark' : 'screen', [1.1, 0.64, 0.02], at(-span / 2 + 0.6 + c * 1.2, 0.09, 1.75 + row * 0.72), C.yaw);
        }
      }
      const F = frame(...xz(at(0, 1.1, 0)), C.yaw);
      this.part(R, 'gunmetal', [span - 0.4, 0.82, 0.85], F.P(0, 0.41, 0), F.yaw);
      this.part(R, 'dark', [span - 0.3, 0.05, 0.95], F.P(0, 0.84, 0.03), F.yaw);
      for (let i = 0; i < 4; i++) {
        const rr = -span / 2 + 1.2 + i * 1.6;
        this.part(R, 'dark', [0.44, 0.02, 0.15], F.P(rr, 0.88, 0.2), F.yaw);
        this.part(R, 'screen', [0.5, 0.3, 0.03], F.P(rr, 1.1, -0.15), F.yaw + Math.PI, 0.25);
        if (r() < 0.6) k.prop(R, 'chair', F.P(rr + (r() - 0.5) * 0.4, 0, 1.0), F.yaw + Math.PI + (r() - 0.5) * 0.8, { solid: false });
        if (r() < 0.5) this.cpart(R, 'white', 0.045, 0.1, F.P(rr + 0.5, 0.92, 0.25), 0, 0, 0, 8);
      }
      // A radio and a logbook.
      this.part(R, 'd_black', [0.08, 0.22, 0.05], F.P(2.8, 0.98, 0.2), F.yaw + 0.4);
      this.part(R, 'd_blue', [0.3, 0.03, 0.42], F.P(-2.9, 0.88, 0.2), F.yaw - 0.2);
      this.solid(F, (span - 0.4) / 2, 0.42, 0.43);
      k.fixtures.push([C.x, C.z, span / 2 + 0.3]);
    }
    this.sign(R, 'headcount', 38, 52, 2.4, 0.8, { mat: 'a_lit' });
    this.plate(R, 'sunhouse', 43.5, 52, 1.7, 1.2);
    // Things on the duty desks; chairs.
    for (const zd of [58, 64, 70]) {
      const D = this.F(R, 30, zd, Math.PI);
      this.deskTop(R, D, 5, 1.0, r() < 0.5 ? 2 : 1);
      for (const rr of [-1.5, 1.2]) if (r() < 0.75) k.prop(R, 'chair', D.P(rr, 0, -0.95), D.yaw + (r() - 0.5) * 0.8, { solid: false });
    }
    for (const zd of [58, 66, 74]) {
      const D = this.F(R, 58, zd, Math.PI);
      this.deskTop(R, D, 2.6, 0.8, 0);
      if (r() < 0.8) k.prop(R, 'chair', D.P(0, 0, -0.95), D.yaw + (r() - 0.5), { solid: false });
    }
    // Weapon racks on the south wall (two slots empty), shields leaning beside them.
    this.place(R, [[32, 83.5, Math.PI], [36, 83.5, Math.PI]], 1.3, 0.2, (F) => {
      this.part(R, 'gunmetal', [2.5, 1.7, 0.08], F.P(0, 1.05, -0.12), F.yaw);
      this.part(R, 'dark', [2.5, 0.08, 0.25], F.P(0, 0.4, 0.0), F.yaw);
      this.part(R, 'dark', [2.5, 0.06, 0.12], F.P(0, 1.55, -0.03), F.yaw);
      for (let i = 0; i < 8; i++) {
        if (i === 2 || i === 5 || r() < 0.15) continue;
        const rr = -1.05 + i * 0.3;
        this.part(R, 'd_black', [0.06, 1.0, 0.1], F.P(rr, 0.95, 0.02), F.yaw, -0.06);
        this.part(R, 'woodDark', [0.07, 0.3, 0.12], F.P(rr, 0.55, 0.03), F.yaw, -0.06);
      }
      this.solid(F, 1.25, 0.85, 0.15);
      this.sign(R, 'armory', 34, 84, 2.35, 0.32, { high: true });
    });
    this.place(R, [[38, 83.4, Math.PI], [28, 83.4, Math.PI]], 0.8, 0.2, (F) => {
      for (let i = 0; i < 3; i++) {
        this.part(R, 'd_black', [0.55, 1.05, 0.04], F.P(-0.5 + i * 0.5, 0.54, 0.05), F.yaw, -0.2);
        this.part(R, 'glass', [0.3, 0.12, 0.05], F.P(-0.5 + i * 0.5, 0.85, 0.1), F.yaw, -0.2);
      }
      this.solid(F, 0.8, 0.5, 0.2);
    });
    // Holding cells: a divider, a cot and a steel toilet in each.
    const [d0x, d0z] = k.W(R, 59, 79.2);
    const [, d1z] = k.W(R, 59, 84);
    for (let z = d0z + 0.2; z < d1z - 0.2; z += 0.3) k.box(R, 'steel', [0.05, 3, 0.05], [d0x, 1.5, z], false);
    k.physics.addStaticBox(new THREE.Vector3(d0x, 1.5, (d0z + d1z) / 2), new THREE.Vector3(0.06, 1.5, (d1z - d0z) / 2));
    for (const xd of [56.5, 61.5]) {
      const [cx, cz] = k.W(R, xd, 83.3);
      this.part(R, 'steel', [2.0, 0.42, 0.75], [cx, 0.21, cz], 0);
      this.part(R, 'd_mattress', [1.9, 0.08, 0.7], [cx, 0.46, cz], 0.02);
      if (r() < 0.6) this.part(R, 'd_blanket', [1.0, 0.05, 0.72], [cx - 0.3, 0.52, cz], 0.1, 0, 0.05);
      k.physics.addStaticBox(new THREE.Vector3(cx, 0.25, cz), new THREE.Vector3(1.0, 0.25, 0.38));
      const [tx2, tz2] = k.W(R, xd + 1.6, 80.6);
      this.cpart(R, 'd_chrome', 0.2, 0.42, [tx2, 0.21, tz2], 0, 0, 0, 12);
      this.cpart(R, 'd_black', 0.16, 0.02, [tx2, 0.43, tz2], 0, 0, 0, 12);
      const p = this.wall(R, xd - 1.2, 84);
      this.wallDecal(R, 'tally', p, 1.3, 0.6, 0.3);
    }
    // Filing cabinets and an evidence shelf on the west wall.
    for (const zd of [55, 56.3, 57.6, 76.5]) this.place(R, [[18.65, zd, Math.PI / 2]], 0.24, 0.31, (F) => this.cabinet(R, F), 0.02);
    this.place(R, [[18.6, 79.5, Math.PI / 2], [18.6, 61.5, Math.PI / 2]], 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 4, 'boxes'));
    this.sign(R, 'schedule', 18, 62.5, 1.65, 0.6);
    this.sign(R, 'poster3', 47, 84, 1.7, 1.1);
    this.sign(R, 'authorized', 49, 52, 2.2, 0.28);
    this.sign(R, 'clock', 66, 74, 3.2, 0.45, { mat: 'a_decal', frame: false, high: true });
  }

  private garden(): void {
    const R = 'garden';
    const k = this.k;
    const r = this.rnd;
    // Lamp posts along the paths (warm globes, dead in a blackout like every lamp).
    for (const [xd, zd] of [[-55.6, 22], [-50.4, 44], [-55.6, 44], [-50.4, 22], [-46, 35.4], [-60, 30.6], [-42, 30.6]] as [number, number][]) {
      this.place(R, [[xd, zd, 0]], 0.2, 0.2, (F) => {
        this.cpart(R, 'dark', 0.14, 0.3, F.P(0, 0.15, 0), 0, 0, 0, 10);
        this.cpart(R, 'gunmetal', 0.055, 3.6, F.P(0, 2.0, 0), 0, 0, 0, 8);
        this.geo(R, 'lampWarm', new THREE.SphereGeometry(0.22, 12, 8), F.P(0, 3.95, 0));
        this.cpart(R, 'dark', 0.26, 0.08, F.P(0, 4.2, 0), 0, 0, 0, 12, false, 0.06);
        this.solid(F, 0.12, 1.9, 0.12);
      }, 0.1);
    }
    // Low hedges along the long path, in short runs.
    for (const xd of [-51.1, -54.9]) {
      for (const [z0, z1] of [[17.5, 22.5], [24.5, 28.5], [38, 42], [44, 49]] as [number, number][]) {
        const [hx, hz0] = k.W(R, xd, z0);
        const [, hz1] = k.W(R, xd, z1);
        const len = hz1 - hz0;
        if (!k.free(R, hx, (hz0 + hz1) / 2, 0.3, len / 2, 0.1)) continue;
        this.part(R, 'leafDark', [0.55, 0.7, len], [hx, 0.35, (hz0 + hz1) / 2]);
        for (let z = hz0 + 0.3; z < hz1; z += 0.5) this.geo(R, r() < 0.5 ? 'leaf' : 'leafDark', new THREE.IcosahedronGeometry(0.3 + r() * 0.1, 0), [hx + (r() - 0.5) * 0.2, 0.68, z]);
        k.physics.addStaticBox(new THREE.Vector3(hx, 0.35, (hz0 + hz1) / 2), new THREE.Vector3(0.28, 0.35, len / 2));
        k.claim(hx - 0.3, hz0, hx + 0.3, hz1);
      }
    }
    // Flowers in the tree planters.
    for (const [xd, zd] of [[-60, 20], [-46, 20], [-60, 46], [-46, 46], [-61, 33], [-45, 27]] as [number, number][]) {
      const [px, pz] = k.W(R, xd, zd);
      for (let i = 0; i < 22; i++) {
        const a = r() * Math.PI * 2;
        const d = 0.5 + r() * 1.3;
        this.geo(R, ['d_flower1', 'd_flower2', 'd_flower3'][i % 3], new THREE.IcosahedronGeometry(0.07 + r() * 0.05, 0), [px + Math.cos(a) * d, 0.6 + r() * 0.08, pz + Math.sin(a) * d]);
        if (i % 2) this.geo(R, 'leafDark', new THREE.ConeGeometry(0.05, 0.22, 4), [px + Math.cos(a) * d + 0.08, 0.6, pz + Math.sin(a) * d]);
      }
    }
    // Grass tufts and fallen leaves (more of them under the trees), stones off the paths.
    const [x0, z0, x1, z1] = this.def(R).rect;
    const [px] = k.W(R, -53, 33);
    const [, pz] = k.W(R, -53, 33);
    const onPath = (x: number, z: number) => Math.abs(x - px) < 1.4 || Math.abs(z - pz) < 1.4;
    for (let i = 0; i < (k.mobile ? 90 : 220); i++) {
      const x = x0 + 0.5 + r() * (x1 - x0 - 1);
      const z = z0 + 0.5 + r() * (z1 - z0 - 1);
      if (onPath(x, z)) continue;
      for (let j = 0; j < 3; j++) this.geo(R, j ? 'd_grass' : 'leafDark', new THREE.ConeGeometry(0.035, 0.2 + r() * 0.15, 3), [x + (r() - 0.5) * 0.15, 0.1, z + (r() - 0.5) * 0.15], [(r() - 0.5) * 0.5, 0, (r() - 0.5) * 0.5]);
    }
    for (let i = 0; i < (k.mobile ? 120 : 320); i++) {
      const x = x0 + 0.5 + r() * (x1 - x0 - 1);
      const z = z0 + 0.5 + r() * (z1 - z0 - 1);
      this.part(R, r() < 0.5 ? 'd_leafAutumn' : 'd_leafDry', [0.07, 0.004, 0.05], [x, 0.026 + r() * 0.01, z], r() * 6, (r() - 0.5) * 0.4);
    }
    this.scatter(R, 9, 0.35, 0.35, (F) => {
      const s = 0.25 + r() * 0.3;
      this.geo(R, 'd_stone', new THREE.DodecahedronGeometry(s, 0), F.P(0, s * 0.4, 0), [r(), r(), r()]);
      if (s > 0.4) this.solid(F, s * 0.8, s * 0.4, s * 0.8);
    }, { margin: 1.5 });
    // Trellises with ivy on the court walls.
    for (const [xd, zd] of [[-66, 20], [-66, 42], [-66, 47], [-40, 20], [-40, 45], [-40, 26]] as [number, number][]) {
      const p = this.wall(R, xd, zd);
      if (!this.wallFree(R, p, 0.9)) continue;
      const tx2 = -p.nz;
      const tz2 = p.nx;
      const at = (s: number, y: number, off: number): V3 => [p.x + tx2 * s + p.nx * off, y, p.z + tz2 * s + p.nz * off];
      for (let s = -0.75; s <= 0.76; s += 0.375) this.part(R, 'woodDark', [0.04, 3.6, 0.04], at(s, 1.8, 0.08), p.yaw);
      for (let y = 0.4; y < 3.6; y += 0.45) this.part(R, 'woodDark', [1.55, 0.04, 0.04], at(0, y, 0.1), p.yaw);
      for (let i = 0; i < 26; i++) this.geo(R, r() < 0.6 ? 'leafDark' : 'leaf', new THREE.IcosahedronGeometry(0.12 + r() * 0.12, 0), at((r() - 0.5) * 1.6, r() * r() * 3.8 + 0.1, 0.16), [r(), r(), r()]);
      k.fixtures.push([p.x, p.z, 0.9]);
    }
    // Gardener's corner: tools on the wall, a wheelbarrow, a hose reel.
    this.place(R, [[-60, 14.6, 0], [-62, 14.6, 0], [-48, 51.4, Math.PI]], 0.8, 0.3, (F) => {
      this.part(R, 'woodDark', [1.5, 0.06, 0.06], F.P(0, 1.6, -0.25), F.yaw);
      for (let i = 0; i < 4; i++) {
        this.part(R, 'wood', [0.035, 1.5, 0.035], F.P(-0.55 + i * 0.36, 0.78, -0.12), F.yaw, -0.15);
        this.part(R, i % 2 ? 'gunmetal' : 'd_rubber', [0.25, 0.18, 0.03], F.P(-0.55 + i * 0.36, 0.1, -0.02), F.yaw, -0.15);
      }
      this.geo(R, 'd_army', new THREE.TorusGeometry(0.28, 0.04, 6, 16), F.P(0.95, 0.35, -0.1), [0, F.yaw, 0]);
      this.cpart(R, 'gunmetal', 0.08, 0.2, F.P(0.95, 0.35, -0.1), F.yaw, Math.PI / 2, 0, 8);
      this.solid(F, 0.8, 0.5, 0.25);
    });
    this.scatter(R, 1, 0.45, 0.8, (F) => {
      this.part(R, 'd_army', [0.62, 0.3, 0.85], F.P(0, 0.48, 0), F.yaw, 0.12);
      this.cpart(R, 'd_rubber', 0.18, 0.08, F.P(0, 0.2, 0.55), F.yaw, 0, Math.PI / 2, 10);
      for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.04, 0.04, 0.9], F.P(s * 0.28, 0.45, -0.3), F.yaw, -0.2);
      this.part(R, 'soil', [0.5, 0.05, 0.6], F.P(0, 0.62, 0), F.yaw, 0.12);
      this.solid(F, 0.35, 0.35, 0.6);
    }, { margin: 3 });
    // The fountain gets its tiers.
    const [fx, fz] = k.W(R, -53, 33);
    this.cpart(R, 'offwhite', 0.35, 1.2, [fx, 1.2, fz], 0, 0, 0, 14);
    this.cpart(R, 'offwhite', 1.1, 0.25, [fx, 1.85, fz], 0, 0, 0, 20);
    this.cpart(R, 'water', 1.0, 0.03, [fx, 1.98, fz], 0, 0, 0, 20);
    this.cpart(R, 'offwhite', 0.12, 0.4, [fx, 2.15, fz], 0, 0, 0, 8);
    this.geo(R, 'leafDark', new THREE.TorusGeometry(2.7, 0.06, 4, 32), [fx, 0.62, fz], [Math.PI / 2, 0, 0]);
    // Stepping stones from the cross path to the benches.
    for (let i = 0; i < 6; i++) {
      const [sx, sz] = k.W(R, -49.5 + (i % 2) * 0.4, 26 + i * 1.0);
      if (!onPath(sx, sz)) this.cpart(R, 'd_stone', 0.28, 0.04, [sx, 0.03, sz], 0, 0, 0, 9);
    }
  }

  private medbay(): void {
    const R = 'medbay';
    const k = this.k;
    const r = this.rnd;
    for (const zd of [18, 24, 30, 36, 42, 48]) {
      const [bx, bz] = k.W(R, 62.5, zd);
      // Pillow at the wall end, a blanket thrown back.
      this.part(R, 'white', [0.42, 0.12, 0.62], [bx + 0.72, 0.98, bz], r() * 0.2);
      if (r() < 0.75) this.part(R, r() < 0.5 ? 'd_sheet' : 'd_blanket', [1.1, 0.05, 0.98], [bx - 0.3, 0.95, bz], (r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.08);
      // IV stand by the bed, a monitor on the wall over it.
      if (r() < 0.75) this.ivStand(R, frame(bx + 0.5, bz - 0.75, r() * 6));
      const p = this.wallW(R, k.W(R, 66, zd)[0], bz);
      this.part(R, 'd_black', [0.42, 0.32, 0.12], [p.x + p.nx * 0.06, 1.75, p.z], p.yaw);
      this.part(R, r() < 0.7 ? 'screen' : 'dark', [0.36, 0.24, 0.01], [p.x + p.nx * 0.125, 1.75, p.z], p.yaw);
      this.part(R, 'gunmetal', [0.06, 0.4, 0.06], [p.x + p.nx * 0.03, 1.4, p.z], p.yaw);
      k.fixtures.push([p.x, p.z, 0.3]);
      // Curtain rail and the bunched curtain at the bay edge.
      const [cx] = k.W(R, 60.3, zd);
      this.part(R, 'd_chrome', [0.03, 0.03, 2.4], [cx, 2.45, bz], 0, 0, 0, true);
      this.part(R, 'mint', [0.18, 1.9, 0.35], [cx, 1.45, bz + 1.0], 0.1);
    }
    // The operating corner: instrument stand, anaesthesia cart, a boom monitor.
    const O = this.F(R, 48, 30, 0);
    this.place(R, [[45.5, 30, Math.PI / 2], [45.5, 32, Math.PI / 2]], 0.4, 0.3, (F) => {
      this.part(R, 'white', [0.6, 1.2, 0.55], F.P(0, 0.6, 0), F.yaw);
      this.part(R, 'screen', [0.4, 0.3, 0.01], F.P(0, 1.35, 0.2), F.yaw, -0.3);
      this.part(R, 'd_black', [0.45, 0.35, 0.05], F.P(0, 1.35, 0.17), F.yaw, -0.3);
      this.cpart(R, 'd_blue', 0.08, 0.55, F.P(0.2, 1.48, -0.1), F.yaw, 0, 0, 8);
      this.solid(F, 0.32, 0.65, 0.3);
    });
    this.part(R, 'd_chrome', [0.45, 0.02, 0.3], O.P(0.2, 1.1, 0.75), O.yaw);
    this.cpart(R, 'd_chrome', 0.015, 1.1, O.P(0.2, 0.55, 0.75), 0, 0, 0, 6);
    for (let i = 0; i < 5; i++) this.part(R, 'd_chrome', [0.015, 0.01, 0.15], O.P(0.05 + i * 0.07, 1.115, 0.75), O.yaw + (r() - 0.5) * 0.2);
    this.part(R, 'gunmetal', [0.05, 0.05, 1.2], O.P(-0.6, 3.9, 0), O.yaw, 0, 0, true);
    this.hang(R, ...xz(O.P(-0.6, 0, 0.6)), 3.9, 2.5, 'gunmetal', 0.03);
    this.part(R, 'd_black', [0.6, 0.4, 0.05], O.P(-0.6, 2.3, 0.6), O.yaw + 0.5);
    this.part(R, 'screen', [0.54, 0.34, 0.01], O.P(-0.62, 2.3, 0.63), O.yaw + 0.5);
    const [ox, oz] = k.W(R, 48, 30);
    this.floor(R, 'oil', ox + 0.6, oz + 0.3, 1.2, 1.0, 1);
    // Trolleys, a wheelchair, oxygen, a crash cart, bins.
    this.scatter(R, 2, 0.35, 1.0, (F) => this.gurney(R, F, this.rnd() < 0.5), { margin: 3 });
    this.scatter(R, 1, 0.35, 0.45, (F) => this.wheelchair(R, F), { margin: 2 });
    this.place(R, [[44, 14.6, 0], [58, 14.6, 0], [64, 51.4, Math.PI]], 0.4, 0.15, (F) => this.oxygen(R, F, 3));
    this.place(R, [[56, 14.8, 0], [47, 51.2, Math.PI], [42, 51.2, Math.PI]], 0.38, 0.28, (F) => this.crashCart(R, F));
    this.place(R, [[60, 51.4, Math.PI], [50, 14.6, 0], [64, 14.6, 0]], 0.75, 0.3, (F) => {
      this.part(R, 'steel', [1.4, 0.85, 0.6], F.P(0, 0.43, 0), F.yaw);
      this.part(R, 'd_black', [0.5, 0.02, 0.38], F.P(-0.3, 0.86, 0.02), F.yaw);
      this.cpart(R, 'd_chrome', 0.02, 0.3, F.P(-0.3, 1.0, -0.22), F.yaw, 0, 0, 6);
      this.part(R, 'd_chrome', [0.03, 0.03, 0.18], F.P(-0.3, 1.14, -0.14), F.yaw);
      this.part(R, 'white', [0.22, 0.28, 0.1], F.P(0.3, 1.3, -0.25), F.yaw);
      this.solid(F, 0.7, 0.43, 0.3);
      const p = this.wallW(R, F.x - Math.sin(F.yaw) * 0.3, F.z - Math.cos(F.yaw) * 0.3);
      this.signW(R, 'wash', this.wallW(R, p.x - p.nz * 1.2, p.z + p.nx * 1.2), 1.6, 0.45);
    });
    for (const [xd, zd, m] of [[52, 15, 'd_yellowBin'], [53.4, 15, 'd_red'], [41.5, 50.5, 'd_yellowBin']] as [number, number, string][]) {
      const [bx, bz] = k.W(R, xd, zd);
      if (k.free(R, bx, bz, 0.25, 0.25, 0.05)) this.bin(R, bx, bz, m, 0.22, 0.6);
    }
    // Medkits on top of the west cabinets.
    for (let zd = 16; zd < 50; zd += 4.4) {
      if (Math.abs(zd - 33) < 4) continue;
      const [cx, cz] = k.W(R, 40.6, zd);
      if (r() < 0.6) k.prop(R, 'medkit', [cx, 2.0, cz], Math.PI / 2 + (r() - 0.5) * 0.4, { solid: false });
    }
    this.sign(R, 'quiet', 66, 33, 2.75, 0.32, { high: true });
    this.sign(R, 'bio', 52.8, 14, 1.65, 0.45);
    this.sign(R, 'xray', 40, 27, 2.75, 0.6, { mat: 'a_lit', high: true });
    this.sign(R, 'notice', 40, 46, 2.7, 0.7, { high: true });
  }

  private atrium(): void {
    const R = 'atrium';
    const k = this.k;
    const r = this.rnd;
    // Columns under the balcony fronts.
    for (const side of [-1, 1]) {
      for (const zd of [12, 18, 24, 40, 46]) {
        this.place(R, [[side * 36.7, zd, 0]], 0.4, 0.4, (F) => {
          this.part(R, 'offwhite', [0.7, 12.2, 0.7], F.P(0, 6.1, 0));
          this.part(R, 'd_concrete', [0.9, 0.5, 0.9], F.P(0, 0.25, 0));
          for (const y of [6.2, 11.85]) this.part(R, 'offwhite', [0.95, 0.25, 0.95], F.P(0, y, 0));
          this.part(R, 'gunmetal', [0.72, 0.06, 0.72], F.P(0, 1.2, 0));
          // Red light strips on the face towards the hall.
          for (const y of [3.2, 9.0]) this.part(R, 'lampRed', [0.04, 2.6, 0.1], F.P(-side * 0.37, y, 0));
          this.solid(F, 0.35, 6.1, 0.35);
        }, 0.05);
      }
    }
    // A cordon round the statue's plinth and a plaque.
    const [sx, sz] = k.W(R, 0, 22);
    const n = 14;
    const ring = 5.7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const b = ((i + 1) / n) * Math.PI * 2;
      this.stanchion(R, sx + Math.cos(a) * ring, sz + Math.sin(a) * ring, [sx + Math.cos(b) * ring, sz + Math.sin(b) * ring]);
    }
    const L = frame(sx, sz + ring + 0.7, 0);
    this.part(R, 'gunmetal', [0.6, 1.0, 0.3], L.P(0, 0.5, 0), L.yaw, -0.2);
    this.geo(R, 'a_sign', this.atlas.plane('vanta', 0.5, 0.25), L.P(0, 1.03, 0.08), [-0.95, 0, 0]);
    this.solid(L, 0.3, 0.5, 0.15);
    // Banners hanging from the skylight frame.
    for (const [xd, zd] of [[-16, 14], [16, 14], [-16, 32], [16, 32]] as [number, number][]) {
      const [bx, bz] = k.W(R, xd, zd);
      this.part(R, 'vanta', [2.6, 7.8, 0.03], [bx, 12.9, bz], 0, 0, 0, true);
      for (const s of [1, -1]) this.geo(R, 'a_sign', this.atlas.plane('banner', 2.6, 7.8), [bx, 12.9, bz + s * 0.02], [0, s > 0 ? 0 : Math.PI, 0]);
      this.part(R, 'gunmetal', [2.9, 0.07, 0.07], [bx, 16.85, bz], 0, 0, 0, true);
      this.hang(R, bx - 1.3, bz, 18, 16.85);
      this.hang(R, bx + 1.3, bz, 18, 16.85);
    }
    // The wall banners under the north balcony get the print too.
    for (const xd of [-26, -9, 9, 26]) {
      const [wx, wz] = k.W(R, xd, -5.7);
      this.geo(R, 'a_sign', this.atlas.plane('banner', 2.33, 7), [wx, 11, wz + 0.046]);
    }
    this.atriumHall(sx, sz);
    // Plants along the balcony edges, trash bins by the benches, a coffee cart.
    for (const y of [6.68, 12.18]) {
      for (const side of [-1, 1]) {
        for (let zd = 3; zd < 46; zd += 7) {
          const [px, pz] = k.W(R, side * 38.0, zd);
          this.part(R, 'gunmetal', [0.5, 0.35, 0.5], [px, y + 0.17, pz], 0, 0, 0, true);
          this.geo(R, 'leaf', new THREE.IcosahedronGeometry(0.35, 0), [px, y + 0.55, pz], [0, 0, 0], true);
        }
      }
    }
    for (const [xd, zd] of [[-12.5, 8], [12.5, 38], [-30, 25], [30, 19]] as [number, number][]) {
      const [bx, bz] = k.W(R, xd, zd);
      if (k.free(R, bx, bz, 0.25, 0.25, 0.05)) this.bin(R, bx, bz);
    }
    this.place(R, [[20, 46, Math.PI], [-20, 46, Math.PI], [24, 30, -Math.PI / 2]], 0.9, 0.6, (F) => {
      this.part(R, 'woodDark', [1.6, 0.95, 0.8], F.P(0, 0.55, 0), F.yaw);
      for (const sr of [-1, 1]) this.cpart(R, 'd_rubber', 0.15, 0.08, F.P(sr * 0.6, 0.15, -0.2), F.yaw, 0, Math.PI / 2, 10);
      for (const sr of [-1, 1]) this.part(R, 'gunmetal', [0.04, 1.2, 0.04], F.P(sr * 0.75, 1.6, 0.0), F.yaw);
      this.part(R, 'vanta', [1.9, 0.08, 1.1], F.P(0, 2.22, 0.05), F.yaw, 0.08);
      this.part(R, 'd_black', [0.45, 0.45, 0.4], F.P(-0.35, 1.25, -0.05), F.yaw);
      this.part(R, 'd_chrome', [0.38, 0.06, 0.3], F.P(-0.35, 1.08, 0.05), F.yaw);
      for (let i = 0; i < 6; i++) this.cpart(R, 'white', 0.04, 0.1, F.P(0.2 + (i % 3) * 0.12, 1.08, -0.1 + Math.floor(i / 3) * 0.12), 0, 0, 0, 8);
      this.solid(F, 0.8, 0.55, 0.4);
    });
    // Dormant K-series units.
    this.place(R, [[28, 46, Math.PI * 0.8], [-26, 2, 0.4], [10, 46, Math.PI]], 0.6, 0.7, (F) => this.kSeries(R, F));
    // A broken skylight pane: glass, a puddle and leaves under it.
    const [gx, gz] = k.W(R, -14, 28);
    this.floor(R, 'puddle', gx, gz, 3.2, 2.4, 0.4, 'a_wet');
    for (let i = 0; i < 26; i++) this.part(R, 'glass', [0.08 + r() * 0.2, 0.01, 0.06 + r() * 0.16], [gx + (r() - 0.5) * 3, 0.03, gz + (r() - 0.5) * 2.4], r() * 6);
    for (let i = 0; i < 40; i++) this.part(R, r() < 0.5 ? 'd_leafAutumn' : 'd_leafDry', [0.07, 0.004, 0.05], [gx + (r() - 0.5) * 4, 0.03, gz + (r() - 0.5) * 3.5], r() * 6);
    // Robots walked out of the lifts: oil drag marks.
    for (const xd of [-30, 30]) {
      const [lx, lz] = k.W(R, xd, -4);
      this.floor(R, 'drag', lx + (r() - 0.5), lz + 2.2, 4, 1, Math.PI / 2 + (r() - 0.5) * 0.4);
    }
    this.sign(R, 'warden', -20, -6, 2.6, 0.45, { mat: 'a_lit' });
    this.sign(R, 'warden', 20, -6, 2.6, 0.45, { mat: 'a_lit' });
    this.sign(R, 'evac', -14, 52, 1.65, 0.7);
    this.sign(R, 'poster2', 14, 52, 1.7, 1.1);
    const p = this.wall(R, -40, 16);
    if (this.wallFree(R, p, 1.8, true)) {
      this.wallDecal(R, 'graffitiSees', p, 2.2, 3.6, 0.9);
      k.fixtures.push([p.x, p.z, 1.8]);
    }
  }

  /**
   * Light from above: most of the atrium's glass roof is panelled over, a dozen cells
   * stay open. The moonlight through them lands as bright patches (shadows from the
   * panels where the moonlight casts them, a glow decal everywhere) and parks practical
   * lights there.
   * The direction matches Site9's moonlight (from +14, +40, +9).
   */
  private skyLights(R: string): void {
    const k = this.k;
    const room = this.def(R);
    const [x0, z0, x1, z1] = room.rect;
    const h = room.h;
    const d = new THREE.Vector3(-14, -40, -9).normalize();
    // Open cells (cell centres on the 4 m skylight grid), placed so the light lands round the statue.
    const open: [number, number][] = [[6, 21], [2, 25], [10, 17], [-6, 29], [14, 9], [-10, 13], [18, 33], [-14, 37], [22, 1], [26, 25], [-18, 21], [-22, 5], [6, 37], [-2, 9]];
    const isOpen = (cx: number, cz: number) => open.some(([ox, oz]) => Math.abs(ox - cx) < 0.5 && Math.abs(oz - cz) < 0.5);
    for (let cx = x0 + 2; cx < x1; cx += 4) {
      for (let cz = z0 + 2; cz < z1; cz += 4) {
        if (isOpen(cx, cz)) continue;
        // Roof panel under the glass (part of the shadow-casting room mesh).
        this.part(R, 'grey', [3.76, 0.06, 3.76], [cx, h + 0.13, cz]);
      }
    }
    k.mats.d_beamPool = new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xbfd2ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const len = (h + 0.1) / -d.y;
    for (const [cx, cz] of open) {
      const top = new THREE.Vector3(cx, h + 0.1, cz);
      const land = top.clone().addScaledVector(d, len);
      // The patch where it lands, stretched along the light's slant.
      const pool = new THREE.PlaneGeometry(4.6, 5.6);
      pool.rotateX(-Math.PI / 2);
      pool.rotateY(Math.atan2(d.x, d.z));
      this.geo(R, 'd_beamPool', pool, [land.x, 0.035, land.z]);
      k.lampSpot(new THREE.Vector3(land.x, 5.0, land.z), 0xc8d8ff, h);
    }
  }

  /** Dark polished marble with pale veins (one tile per 4 m of wall). */
  private marble(): THREE.MeshStandardMaterial {
    const S = this.k.mobile ? 256 : 512;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    const r = seeded(0x3a7b1e);
    g.fillStyle = '#141619';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 1200; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '60,64,70' : '8,9,10'},${0.15 + r() * 0.2})`;
      g.fillRect(r() * S, r() * S, 2 + r() * 10, 2 + r() * 10);
    }
    // Veins: long wandering strokes that wrap (the texture tiles).
    for (let i = 0; i < 16; i++) {
      g.strokeStyle = `rgba(200,205,212,${0.12 + r() * 0.35})`;
      g.lineWidth = (0.6 + r() * 2.2) * (S / 512);
      let x = r() * S;
      let y = r() * S;
      let a = r() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 40; k++) {
        a += (r() - 0.5) * 0.7;
        x += Math.cos(a) * S * 0.03;
        y += Math.sin(a) * S * 0.03;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.25, 0.25);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.22, metalness: 0.15 });
  }

  /** Long planter: rounded ends, dark slatted sides on a white seat plinth, rocks, moss and a dead tree. Long along f. */
  private longPlanter(R: string, F: Frame, len: number): void {
    const r = this.rnd;
    const w = 1.5;
    const straight = len - w;
    // White seat plinth, wider than the box, rounded ends; a light strip under its lip.
    this.part(R, 'white', [w + 0.7, 0.42, straight], F.P(0, 0.21, 0), F.yaw);
    for (const s of [-1, 1]) this.cpart(R, 'white', (w + 0.7) / 2, 0.42, F.P(0, 0.21, (s * straight) / 2), F.yaw, 0, 0, 20);
    for (const s of [-1, 1]) this.part(R, 'lampCool', [0.03, 0.02, straight], F.P(s * ((w + 0.7) / 2 - 0.05), 0.012, 0), F.yaw);
    // The box: dark sides with vertical slats.
    this.part(R, 'd_black', [w, 0.75, straight], F.P(0, 0.79, 0), F.yaw);
    for (const s of [-1, 1]) this.cpart(R, 'd_black', w / 2, 0.75, F.P(0, 0.79, (s * straight) / 2), F.yaw, 0, 0, 20);
    for (let f = -straight / 2 + 0.06; f < straight / 2; f += 0.14) for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.03, 0.72, 0.05], F.P(s * (w / 2 + 0.01), 0.79, f), F.yaw);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 11) * Math.PI - Math.PI / 2;
        const p = F.P(Math.sin(a) * (w / 2 + 0.01), 0.79, (s * straight) / 2 + s * Math.cos(a) * (w / 2 + 0.01));
        this.part(R, 'gunmetal', [0.05, 0.72, 0.03], p, F.yaw + (s > 0 ? -a : a + Math.PI));
      }
    }
    this.part(R, 'soil', [w - 0.1, 0.04, straight], F.P(0, 1.15, 0), F.yaw);
    for (const s of [-1, 1]) this.cpart(R, 'soil', w / 2 - 0.05, 0.04, F.P(0, 1.15, (s * straight) / 2), F.yaw, 0, 0, 16);
    // Rocks with moss, ferns.
    for (let i = 0; i < 4; i++) {
      const f = -straight / 2 + r() * straight;
      const s2 = 0.35 + r() * 0.45;
      const g = new THREE.DodecahedronGeometry(s2, 0);
      g.scale(1.3, 0.55, 0.9);
      this.geo(R, 'd_stone', g, F.P((r() - 0.5) * 0.4, 1.17 + s2 * 0.25, f), [r() * 0.3, r() * 6, r() * 0.3]);
      const m = new THREE.IcosahedronGeometry(s2 * 0.6, 0);
      m.scale(1.4, 0.18, 1.0);
      this.geo(R, 'd_grass', m, F.P((r() - 0.5) * 0.3, 1.17 + s2 * 0.5, f + (r() - 0.5) * 0.2), [0, r() * 6, 0]);
    }
    for (let i = 0; i < 16; i++) {
      const g = new THREE.IcosahedronGeometry(0.12 + r() * 0.1, 0);
      g.scale(1.2, 0.4, 1.2);
      this.geo(R, r() < 0.6 ? 'd_grass' : 'leafDark', g, F.P((r() - 0.5) * (w - 0.3), 1.2, -straight / 2 + r() * straight));
    }
    // The dead tree: a trunk and forking branches.
    const base = F.P((r() - 0.5) * 0.3, 1.15, (r() - 0.5) * straight * 0.4);
    const branch = (from: V3, dir: THREE.Vector3, l: number, rad: number, depth: number) => {
      const to: V3 = [from[0] + dir.x * l, from[1] + dir.y * l, from[2] + dir.z * l];
      this.rod(R, 'bark', rad, from, to, 6);
      if (depth <= 0) return;
      for (let k = 0, n = depth > 2 ? 2 : 2 + Math.floor(r() * 2); k < n; k++) {
        const d = dir.clone().add(new THREE.Vector3((r() - 0.5) * 1.3, (r() - 0.2) * 0.7, (r() - 0.5) * 1.3)).normalize();
        branch(to, d, l * (0.62 + r() * 0.15), rad * 0.62, depth - 1);
      }
    };
    branch(base, new THREE.Vector3((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2).normalize(), 1.6, 0.13, 4);
    this.solid(F, (w + 0.7) / 2, 0.6, len / 2);
  }

  /**
   * The atrium's fit-out: seams in the wood floor, a glowing grid under the glass roof,
   * light lines under the balconies, crossed LED bars hung over the hall, long planters
   * with dead trees, and a backlit wood feature wall with the company mark.
   */
  private atriumFitout(sx: number, sz: number): void {
    const R = 'atrium';
    const k = this.k;
    const room = this.def(R);
    const [x0, z0, x1, z1] = room.rect;
    const h = room.h;
    // Floor seams every 3 m.
    for (let x = x0 + 3; x < x1; x += 3) this.part(R, 'd_black', [0.035, 0.004, z1 - z0], [x, 0.022, (z0 + z1) / 2]);
    for (let z = z0 + 3; z < z1; z += 3) this.part(R, 'd_black', [x1 - x0, 0.004, 0.035], [(x0 + x1) / 2, 0.022, z]);
    // Light lines along every other skylight bar.
    for (let x = x0 + 8; x < x1 - 1; x += 8) this.part(R, 'lampCool', [0.09, 0.03, z1 - z0 - 0.6], [x, h - 0.12, (z0 + z1) / 2], 0, 0, 0, true);
    for (let z = z0 + 8; z < z1 - 1; z += 8) this.part(R, 'lampCool', [x1 - x0 - 0.6, 0.03, 0.09], [(x0 + x1) / 2, h - 0.12, z], 0, 0, 0, true);
    // Under the balconies.
    for (const y of [6.5, 12]) {
      for (const side of [-1, 1]) {
        const [bx, bz0] = k.W(R, side * 38.2, 0.5);
        const [, bz1] = k.W(R, side * 38.2, 45.5);
        this.part(R, 'lampCool', [0.06, 0.03, bz1 - bz0], [bx, y - 0.2, (bz0 + bz1) / 2], 0, 0, 0, true);
      }
      const [nx0, nz] = k.W(R, -36.5, -4);
      const [nx1] = k.W(R, 36.5, -4);
      this.part(R, 'lampCool', [nx1 - nx0, 0.03, 0.06], [(nx0 + nx1) / 2, y - 0.2, nz], 0, 0, 0, true);
    }
    // Crossed LED bars hung over the hall.
    for (const [xd, zd] of [[-20, 23], [20, 23], [0, 44], [0, 2]] as [number, number][]) {
      const [cx, cz] = k.W(R, xd, zd);
      const y = 9.6;
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        this.part(R, 'gunmetal', [0.12, 0.06, 6.2], [cx, y + 0.05, cz], a, 0, 0, true);
        this.part(R, 'lampCool', [0.07, 0.03, 6.1], [cx, y, cz], a, 0, 0, true);
        for (const s of [-1, 1]) this.hang(R, cx + Math.sin(a) * s * 2.6, cz + Math.cos(a) * s * 2.6, h, y + 0.08, 'dark', 0.008);
      }
    }
    // Long planters on the hall's sides.
    for (const cands of [
      [[-12, 23, 0], [-13, 23, 0]],
      [[12, 23, 0], [13, 23, 0]],
      [[27, 30, 0], [27, 32, 0]],
      [[27, 6, 0], [24, 8, 0]],
      [[-29, 12, 0], [-27, 12, 0]],
    ] as [number, number, number][][]) {
      this.place(R, cands, 1.2, 4.2, (F) => this.longPlanter(R, F, 8.0), 0.4);
    }
    // Feature wall behind the front desk side: wood, diagonal light lines, the lit mark.
    const p = this.wall(R, -28, 52);
    const W = 9;
    const H = 5;
    if (this.wallFree(R, p, W / 2)) {
      const tx = -p.nz;
      const tz = p.nx;
      const at = (s: number, y: number, off: number): V3 => [p.x + tx * s + p.nx * off, y, p.z + tz * s + p.nz * off];
      this.part(R, 'wood', [W, H, 0.06], at(0, H / 2, 0.03), p.yaw);
      // A lattice of light lines across the whole panel: diagonals both ways from evenly
      // spaced feet, clipped to the panel's edges.
      const slope = Math.tan(Math.PI / 3);
      for (const dir of [1, -1]) {
        for (let foot = -W / 2 - H / slope; foot < W / 2 + H / slope; foot += 2.4) {
          // Segment from (foot, 0) going up at 60°, clipped to s in [-W/2, W/2], y in [0, H].
          let sa = foot;
          let ya = 0;
          let sb = foot + (dir * H) / slope;
          let yb = H;
          const clip = (s: number) => Math.max(-W / 2, Math.min(W / 2, s));
          if (sa !== clip(sa)) { ya = ((clip(sa) - foot) / ((dir * H) / slope)) * H; sa = clip(sa); }
          if (sb !== clip(sb)) { yb = ((clip(sb) - foot) / ((dir * H) / slope)) * H; sb = clip(sb); }
          if (yb - ya < 0.2) continue;
          const len = Math.hypot(sb - sa, yb - ya);
          this.part(R, 'lampCool', [0.035, len, 0.02], at((sa + sb) / 2, (ya + yb) / 2, 0.065), p.yaw, 0, Math.atan2(sb - sa, yb - ya));
        }
      }
      for (const s of [-W / 2, W / 2]) this.part(R, 'lampCool', [0.03, H, 0.02], at(s, H / 2, 0.065), p.yaw);
      for (const y of [0.04, H - 0.04]) this.part(R, 'lampCool', [W, 0.03, 0.02], at(0, y, 0.065), p.yaw);
      this.geo(R, 'a_lit', this.atlas.plane('vantaMark', 3.0, 1.0), at(0.6, H * 0.55, 0.07), [0, p.yaw, 0]);
      k.fixtures.push([p.x, p.z, W / 2]);
    }
  }

  /** Two-sided sign hung from the ceiling on two wires (`front` faces +f). */
  private hungSign(R: string, F: Frame, front: string, back: string | null, w: number, h: number, y: number, top: number): void {
    this.part(R, 'd_black', [w + 0.08, h + 0.08, 0.08], F.P(0, y, 0), F.yaw, 0, 0, true);
    this.geo(R, 'a_sign', this.atlas.plane(front, w, h), F.P(0, y, 0.042), [0, F.yaw, 0]);
    if (back) this.geo(R, 'a_sign', this.atlas.plane(back, w, h), F.P(0, y, -0.042), [0, F.yaw + Math.PI, 0]);
    for (const s of [-1, 1]) {
      const p = F.P(s * (w / 2 - 0.2), 0, 0);
      this.hang(R, p[0], p[2], top, y + h / 2 + 0.04, 'dark', 0.008);
    }
  }

  /** Tripod work light, head tilted down towards +f. */
  private workLight(R: string, F: Frame): void {
    const top: V3 = F.P(0, 1.75, 0);
    for (let i = 0; i < 3; i++) {
      const a = F.yaw + (i * Math.PI * 2) / 3;
      this.rod(R, 'yellow', 0.018, top, [F.x + Math.sin(a) * 0.45, 0.02, F.z + Math.cos(a) * 0.45], 5);
    }
    this.part(R, 'd_black', [0.42, 0.3, 0.14], F.P(0, 1.95, 0.02), F.yaw, 0.5);
    this.part(R, 'lampWarm', [0.36, 0.24, 0.01], F.P(0, 1.91, 0.1), F.yaw, 0.5);
    this.cpart(R, 'd_black', 0.012, 2.2, F.P(0.1, 0.9, -0.3), F.yaw, 0.9, 0, 5);
    this.solid(F, 0.3, 0.9, 0.3);
  }

  /** Flexible ventilation duct snaking from a to b (white, ribbed), lying on the floor or sagging between heights. */
  private flexDuct(R: string, pts: V3[], rad = 0.17): void {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const n = Math.max(8, Math.round(curve.getLength() / 0.35));
    const tube = new THREE.TubeGeometry(curve, n, rad, 10, false);
    this.geo(R, 'offwhite', tube, [0, 0, 0]);
    for (let i = 1; i < n; i += 1) {
      const p = curve.getPointAt(i / n);
      const t = curve.getTangentAt(i / n);
      const ring = new THREE.TorusGeometry(rad + 0.01, 0.012, 4, 12);
      ring.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t));
      this.geo(R, 'grey', ring, [p.x, p.y, p.z]);
    }
  }

  /** A white bust of the founder on a wooden pedestal. */
  private bust(R: string, F: Frame): void {
    this.part(R, 'woodDark', [0.62, 1.15, 0.62], F.P(0, 0.575, 0), F.yaw);
    this.part(R, 'd_black', [0.66, 0.04, 0.66], F.P(0, 1.17, 0), F.yaw);
    const shoulders = new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    shoulders.scale(1.25, 0.7, 0.75);
    this.geo(R, 'white', shoulders, F.P(0, 1.19, 0), [0, F.yaw, 0]);
    this.cpart(R, 'white', 0.08, 0.16, F.P(0, 1.47, 0), 0, 0, 0, 10);
    const head = new THREE.SphereGeometry(0.15, 14, 10);
    head.scale(0.95, 1.18, 1.05);
    this.geo(R, 'white', head, F.P(0, 1.68, 0.02), [0, F.yaw, 0]);
    this.part(R, 'gunmetal', [0.3, 0.07, 0.01], F.P(0, 0.9, 0.315), F.yaw);
    this.solid(F, 0.33, 0.9, 0.33);
  }

  /** Atrium: directions hung over the hall, an info totem, the founders' busts by the desk. */
  private atriumExtras(): void {
    const R = 'atrium';
    const k = this.k;
    for (const zd of [35, 6]) {
      const [x, z] = k.W(R, 0, zd);
      this.hungSign(R, frame(x, z, 0), 'wayAtriumN', 'wayAtriumS', 3.6, 1.2, 4.6, this.def(R).h);
    }
    this.place(R, [[-8, 44, 0], [8, 44, 0], [-16, 30, Math.PI / 2]], 0.45, 0.2, (F) => {
      this.part(R, 'd_black', [0.85, 2.5, 0.22], F.P(0, 1.25, 0), F.yaw);
      for (const s of [1, -1]) {
        this.geo(R, 'a_sign', this.atlas.plane('evac', 0.75, 0.5), F.P(0, 1.75, s * 0.112), [0, F.yaw + (s > 0 ? 0 : Math.PI), 0]);
        this.geo(R, 'a_lit', this.atlas.plane('vantaMark', 0.72, 0.24), F.P(0, 0.5, s * 0.112), [0, F.yaw + (s > 0 ? 0 : Math.PI), 0]);
      }
      this.part(R, 'lampCool', [0.86, 0.03, 0.23], F.P(0, 2.51, 0), F.yaw);
      this.solid(F, 0.43, 1.25, 0.12);
    });
    for (const [xd, zd] of [[-30, 48], [-24, 48]] as [number, number][]) {
      this.place(R, [[xd, zd, Math.PI], [xd, zd - 2, Math.PI]], 0.33, 0.33, (F) => this.bust(R, F), 0.3);
    }
  }

  /** Lobby: wood floor seams, linear lights on the ceiling, the desk's lit front, directions. */
  private lobbyFitout(): void {
    const R = 'lobby';
    const k = this.k;
    const room = this.def(R);
    const [x0, z0, x1, z1] = room.rect;
    const h = room.h;
    for (let x = x0 + 2; x < x1; x += 2.4) this.part(R, 'd_black', [0.03, 0.004, z1 - z0], [x, 0.022, (z0 + z1) / 2]);
    for (let z = z0 + 3; z < z1; z += 6) this.part(R, 'd_black', [x1 - x0, 0.004, 0.03], [(x0 + x1) / 2, 0.022, z]);
    // A crossed pair of light lines over each half of the hall, and a cove line round the top.
    for (const zd of [58, 76]) {
      const [cx, cz] = k.W(R, 0, zd);
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        this.part(R, 'gunmetal', [0.14, 0.05, 11], [cx, h - 0.03, cz], a, 0, 0, true);
        this.part(R, 'lampCool', [0.08, 0.02, 10.8], [cx, h - 0.06, cz], a, 0, 0, true);
      }
    }
    for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x0, z1, x1, z1], [x0, z0, x0, z1], [x1, z0, x1, z1]]) {
      const along = az === bz;
      const len = along ? bx - ax : bz - az;
      const inX = ax === x0 && !along ? 0.2 : ax === x1 && !along ? -0.2 : 0;
      const inZ = az === z0 && along ? 0.2 : az === z1 && along ? -0.2 : 0;
      this.part(R, 'lampCool', along ? [len - 0.6, 0.025, 0.05] : [0.05, 0.025, len - 0.6], [along ? (ax + bx) / 2 : ax + inX, h - 0.3, along ? az + inZ : (az + bz) / 2], 0, 0, 0, true);
    }
    // The desk's front: the lit mark and a light line at its foot (visitors stand at -z).
    const D = this.F(R, 0, 70, Math.PI);
    this.geo(R, 'a_lit', this.atlas.plane('vantaMark', 3.0, 1.0), D.P(0, 0.58, 0.705), [0, D.yaw, 0]);
    this.part(R, 'lampCool', [7.9, 0.03, 0.03], D.P(0, 0.05, 0.72), D.yaw);
    this.part(R, 'lampCool', [7.9, 0.03, 0.03], D.P(0, 1.09, 0.72), D.yaw);
    const [wx, wz] = k.W(R, 0, 64.5);
    this.hungSign(R, frame(wx, wz, 0), 'wayLobby', null, 3.6, 1.2, 4.4, h);
  }

  /** R&D Labs: the glass offices get branded friezes and striped kick panels, a duct and work lights. */
  private labsBooths(): void {
    const R = 'labs';
    const k = this.k;
    for (const xd of [-32, -20, 20, 32]) {
      for (const zd of [-30, -14]) {
        const [gx, gz] = k.W(R, xd, zd + 4);
        // Along the glass front (9 m design → 7.2 m): a white frieze with the mark, stripes at the foot.
        const len = 9 * 0.8;
        for (const s of [1, -1]) {
          this.part(R, 'white', [len, 0.42, 0.03], [gx, 2.62, gz + s * 0.06]);
          this.geo(R, 'a_sign', this.atlas.plane('vantaMark', 1.2, 0.4), [gx - len * 0.3, 2.62, gz + s * 0.077], [0, s > 0 ? 0 : Math.PI, 0]);
          const n = 24;
          for (let i = 0; i < n; i++) this.part(R, i % 2 ? 'd_black' : 'd_orange', [len / n, 0.28, 0.02], [gx - len / 2 + (i + 0.5) * (len / n), 0.14, gz + s * 0.055]);
        }
        this.part(R, 'lampCool', [len - 0.2, 0.03, 0.04], [gx, 2.4, gz]);
      }
    }
    // A duct run from the north wall's vent to the core, sagging across the floor.
    const pts: V3[] = [[-6, 3.6, -5.4], [-6.5, 2.0, -6.0], [-7.5, 0.2, -8.5], [-5.5, 0.18, -12], [-2.5, 0.18, -14.5], [-1.4, 0.6, -16.4]].map(([x, y, z]) => [x, y, z] as V3);
    this.part(R, 'grey', [0.6, 0.6, 0.06], [-6, 3.6, -5.2]);
    this.flexDuct(R, pts);
    this.scatter(R, 4, 0.35, 0.35, (F) => this.workLight(R, F), { margin: 3, pad: 0.3 });
  }

  /** Rod (cylinder) from a to b. */
  private rod(R: string, mat: string, r: number, a: V3, b: V3, seg = 6): void {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    this.geo(R, mat, g, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  }

  /** The Vanta compass painted round the statue (its own texture: it is 22 m across). */
  private emblem(): THREE.MeshStandardMaterial {
    const S = this.k.mobile ? 512 : 1024;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    const m = S / 2;
    const r = this.rnd;
    const ring = (r0: number, r1: number, color: string, a0 = 0, a1 = Math.PI * 2) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(m, m, r1 * m, a0, a1);
      g.arc(m, m, r0 * m, a1, a0, true);
      g.closePath();
      g.fill();
    };
    ring(0, 0.74, 'rgba(28,30,33,0.75)');
    // Compass blades: long red ones on the diagonals, dark ones on the axes.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const red = i % 2 === 0;
      const len = red ? 0.9 : 0.72;
      const wd = red ? 0.2 : 0.13;
      g.fillStyle = red ? 'rgba(196,30,26,0.95)' : 'rgba(18,19,21,0.9)';
      g.beginPath();
      g.moveTo(m + Math.cos(a) * len * m, m + Math.sin(a) * len * m);
      g.lineTo(m + Math.cos(a + wd) * 0.42 * m, m + Math.sin(a + wd) * 0.42 * m);
      g.lineTo(m + Math.cos(a) * 0.3 * m, m + Math.sin(a) * 0.3 * m);
      g.lineTo(m + Math.cos(a - wd) * 0.42 * m, m + Math.sin(a - wd) * 0.42 * m);
      g.closePath();
      g.fill();
    }
    ring(0.74, 0.79, 'rgba(196,30,26,0.95)');
    ring(0.79, 0.9, 'rgba(14,15,17,0.92)');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.2;
      ring(0.93, 0.97, 'rgba(196,30,26,0.9)', a, a + Math.PI / 3 - 0.25);
    }
    // Small V marks round the dark band.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      g.save();
      g.translate(m + Math.cos(a) * 0.845 * m, m + Math.sin(a) * 0.845 * m);
      g.rotate(a + Math.PI / 2);
      vLogo(g, 0, 0, 0.03 * m, 'rgba(210,205,198,0.8)');
      g.restore();
    }
    // Worn by boots and dragged crates.
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.5})`;
      g.fillRect(r() * S, r() * S, 1 + r() * 6 * (S / 1024), 1 + r() * 3 * (S / 1024));
    }
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(0,0,0,${0.2 + r() * 0.4})`;
      g.lineWidth = 1 + r() * 4;
      g.beginPath();
      const x = r() * S;
      const y = r() * S;
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * S * 0.3, y + (r() - 0.5) * S * 0.1);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.k.mobile ? MOBILE_ANISOTROPY : 8;
    return new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, roughness: 0.3, metalness: 0.05 });
  }

  /**
   * The atrium as the lobby of a company that still believes in itself: the painted
   * compass, the broken ATLAS dripping cables, a lit front desk, security gates, cases
   * and barriers left where the evacuation dropped them, a wet floor.
   */
  private atriumHall(sx: number, sz: number): void {
    const R = 'atrium';
    const k = this.k;
    const r = this.rnd;
    k.room(R).clear.add(this.emblem(), new THREE.PlaneGeometry(26, 26), [sx, 0.023, sz], [-Math.PI / 2, 0, 0]);
    this.skyLights(R);
    this.floor(R, 'floorSite9', sx, sz + 14.6, 8.5, 3.4, Math.PI);
    // ATLAS, broken: cables hanging out of its chest, rubble on the plinth and the floor.
    for (let i = 0; i < 12; i++) {
      // Out of the chest, hanging nearly straight down, then lying in a curl on the plinth.
      const a = r() * Math.PI * 2;
      const top: V3 = [sx + (r() - 0.5) * 1.4, 4.4 + r() * 1.2, sz + 0.55 + r() * 0.5];
      const land: V3 = [top[0] + (r() - 0.5) * 0.8, 1.04, top[2] + 0.3 + r() * 0.8];
      const end: V3 = [land[0] + Math.cos(a) * (0.8 + r() * 1.6), 1.04, land[2] + Math.sin(a) * (0.8 + r() * 1.6)];
      const mat = i % 5 === 0 ? 'd_red' : i % 7 === 3 ? 'yellow' : 'd_black';
      const rad = 0.018 + r() * 0.02;
      const sway = (r() - 0.5) * 0.5;
      let prev = top;
      for (let t = 1; t <= 6; t++) {
        const u = t / 6;
        // Hangs: falls fast, bows a little sideways.
        const p: V3 = [top[0] + (land[0] - top[0]) * u + Math.sin(u * Math.PI) * sway, top[1] + (land[1] - top[1]) * Math.pow(u, 0.7), top[2] + (land[2] - top[2]) * u * u];
        this.rod(R, mat, rad, prev, p, 5);
        prev = p;
      }
      const mid: V3 = [(land[0] + end[0]) / 2 + (r() - 0.5) * 0.5, 1.04, (land[2] + end[2]) / 2 + (r() - 0.5) * 0.5];
      this.rod(R, mat, rad, land, mid, 5);
      this.rod(R, mat, rad, mid, end, 5);
    }
    for (let i = 0; i < 34; i++) {
      const a = r() * Math.PI * 2;
      const d = 1.0 + r() * 3.4;
      const s2 = 0.15 + r() * 0.5;
      this.part(R, r() < 0.5 ? 'white' : r() < 0.6 ? 'offwhite' : 'rubble', [s2, s2 * (0.4 + r() * 0.6), s2 * (0.6 + r() * 0.6)], [sx + Math.cos(a) * d, 1.04 + s2 * 0.25, sz + Math.sin(a) * d], r() * 6, (r() - 0.5) * 0.8, (r() - 0.5) * 0.8);
    }
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2;
      const d = 4.9 + r() * 0.6;
      const s2 = 0.1 + r() * 0.35;
      this.part(R, r() < 0.6 ? 'offwhite' : 'rubble', [s2, s2 * 0.6, s2 * 0.8], [sx + Math.cos(a) * d, s2 * 0.25, sz + Math.sin(a) * d], r() * 6, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
    }
    // A forearm broken off, lying across the plinth; red status lights still on in the debris.
    this.part(R, 'white', [0.7, 0.62, 2.4], [sx + 1.9, 1.35, sz + 1.4], 0.7, 0.12, 0.2);
    this.part(R, 'gunmetal', [0.4, 0.4, 0.6], [sx + 2.6, 1.3, sz + 2.3], 0.7, 0.3, 0);
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const d = 1.2 + r() * 2.8;
      this.part(R, 'lampRed', [0.08, 0.05, 0.05], [sx + Math.cos(a) * d, 1.1 + r() * 0.15, sz + Math.sin(a) * d], r() * 6);
    }
    // Uplights round the plinth's foot and the company plate on its face.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const x = sx + Math.cos(a) * 5.05;
      const z = sz + Math.sin(a) * 5.05;
      this.part(R, 'gunmetal', [0.2, 0.08, 0.2], [x, 0.06, z], -a);
      this.part(R, 'lampWarm', [0.14, 0.02, 0.14], [x, 0.105, z], -a);
    }
    for (const s of [1, -1]) {
      this.geo(R, 'a_sign', this.atlas.plane('vantaMark', 2.4, 0.8), [sx, 0.52, sz + s * 4.83], [0, s > 0 ? 0 : Math.PI, 0]);
    }
    // Front desk with a lit fascia, by the lobby door.
    this.place(R, [[-27, 44, Math.PI / 2], [-27, 38, Math.PI / 2], [27, 40, -Math.PI / 2]], 2.4, 0.6, (F) => {
      this.part(R, 'd_black', [4.6, 1.05, 0.9], F.P(0, 0.53, 0), F.yaw);
      this.part(R, 'offwhite', [4.8, 0.05, 1.05], F.P(0, 1.08, 0.03), F.yaw);
      this.geo(R, 'a_lit', this.atlas.plane('vantaMark', 2.4, 0.8), F.P(-0.6, 0.55, 0.456), [0, F.yaw, 0]);
      this.part(R, 'lampWarm', [4.5, 0.025, 0.03], F.P(0, 1.03, 0.47), F.yaw);
      this.part(R, 'lampWarm', [4.5, 0.025, 0.03], F.P(0, 0.06, 0.47), F.yaw);
      this.deskTop(R, F, 4.2, 1.1, 3);
      for (const rr of [-1.2, 0.9]) if (r() < 0.8) k.prop(R, 'chair', F.P(rr, 0, -1.0), F.yaw + (r() - 0.5), { solid: false });
      this.solid(F, 2.3, 0.55, 0.45);
    });
    // Security gates in front of the way in from the lobby.
    for (const xd of [-3, 3]) {
      this.place(R, [[xd, 43, 0]], 0.55, 0.35, (F) => {
        for (const s of [-1, 1]) {
          this.part(R, 'offwhite', [0.14, 2.15, 0.6], F.P(s * 0.52, 1.08, 0), F.yaw);
          this.part(R, 'd_black', [0.02, 1.9, 0.5], F.P(s * 0.44, 1.1, 0), F.yaw);
          this.k.physics.addStaticBox(new THREE.Vector3(...F.P(s * 0.52, 1.08, 0)), new THREE.Vector3(0.07, 1.08, 0.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, F.yaw, 0)));
        }
        this.part(R, 'offwhite', [1.2, 0.22, 0.62], F.P(0, 2.25, 0), F.yaw);
        this.part(R, r() < 0.5 ? 'lampRed' : 'leds', [0.2, 0.04, 0.02], F.P(0, 2.28, 0.32), F.yaw);
        this.k.claim(F.x - 0.6, F.z - 0.35, F.x + 0.6, F.z + 0.35);
      }, 0.1);
    }
    // Hard cases, dropped barriers, a knocked-over queue line.
    this.scatter(R, 8, 0.45, 0.35, (F) => {
      const stack = r() < 0.3;
      for (let j = 0; j < (stack ? 2 : 1); j++) {
        const y = j * 0.62;
        const yaw = F.yaw + j * (r() - 0.5) * 0.4;
        const C = frame(F.x, F.z, yaw);
        this.part(R, 'd_black', [0.82, 0.58, 0.56], C.P(0, y + 0.31, 0), yaw);
        for (const ey of [0.03, 0.59]) for (const s of [-1, 1]) this.part(R, 'd_chrome', [0.84, 0.03, 0.03], C.P(0, y + ey, s * 0.28), yaw);
        this.part(R, 'd_chrome', [0.1, 0.06, 0.02], C.P(0, y + 0.45, 0.285), yaw);
        if (!stack && r() < 0.3) {
          this.part(R, 'd_rubber', [0.74, 0.04, 0.48], C.P(0, y + 0.6, 0), yaw);
          this.part(R, 'd_black', [0.82, 0.12, 0.56], C.P(0, y + 0.85, -0.38), yaw, -1.2);
        }
      }
      this.solid(F, 0.42, stack ? 0.6 : 0.3, 0.3);
    }, { margin: 3, pad: 0.5 });
    this.scatter(R, 3, 0.4, 0.4, (F) => {
      for (const s of [-1, 1]) {
        this.geo(R, 'a_sign', this.atlas.plane('barrier', 0.9, 0.45), F.P(0, 0.75, s * 0.17), [s * 0.22, F.yaw + (s > 0 ? 0 : Math.PI), 0]);
        this.part(R, 'gunmetal', [0.95, 1.0, 0.025], F.P(0, 0.5, s * 0.15), F.yaw, -s * 0.22);
      }
      this.solid(F, 0.48, 0.5, 0.3);
    }, { margin: 4, pad: 0.6 });
    for (let i = 0; i < 4; i++) {
      const [qx, qz] = k.W(R, -6 + i * 3 + (r() - 0.5), 35 + (r() - 0.5) * 2);
      const yaw = r() * Math.PI * 2;
      this.cpart(R, 'd_chrome', 0.03, 0.95, [qx, 0.05, qz], yaw, Math.PI / 2, 0, 6);
      this.cpart(R, 'dark', 0.17, 0.03, [qx + Math.sin(yaw) * 0.48, 0.17, qz + Math.cos(yaw) * 0.48], yaw, Math.PI / 2, 0, 12);
      if (i % 2 === 0) this.part(R, 'vanta', [0.012, 0.05, 1.8], [qx + 0.3, 0.03, qz + 0.4], yaw + 0.5);
    }
    // Red cushions on the hall's benches.
    for (const [xd, zd] of [[-10, 8], [10, 8], [-10, 38], [10, 38], [-30, 22], [30, 22]] as [number, number][]) {
      const [bx, bz] = k.W(R, xd, zd);
      this.part(R, 'd_red', [2.7, 0.08, 0.66], [bx, 0.49, bz]);
    }
    // Papers everywhere, a wet floor (rain through the broken skylight).
    const [x0, z0, x1, z1] = this.def(R).rect;
    for (let i = 0; i < (k.mobile ? 70 : 180); i++) {
      this.part(R, 'paper', [0.21, 0.003, 0.29], [x0 + 1 + r() * (x1 - x0 - 2), 0.026 + r() * 0.004, z0 + 1 + r() * (z1 - z0 - 2)], r() * 6, (r() - 0.5) * 0.06);
    }
    for (let i = 0; i < 9; i++) {
      const s2 = 2 + r() * 3.5;
      this.floor(R, 'puddle', x0 + 4 + r() * (x1 - x0 - 8), z0 + 4 + r() * (z1 - z0 - 8), s2 * 1.3, s2, r() * 6, 'a_wet');
    }
    this.scatter(R, 2, 0.2, 0.2, (F) => k.prop(R, 'wetSign', F.P(0, 0, 0), F.yaw, { solid: false }), { margin: 4 });
    this.atriumFitout(sx, sz);
    this.atriumExtras();
  }

  private assembly(): void {
    const R = 'assembly';
    const k = this.k;
    const r = this.rnd;
    const lines: [number, string][] = [[-46, 'lineA'], [-26, 'lineB'], [-6, 'lineC']];
    for (const [zd, label] of lines) {
      // Robots half built on the belts.
      for (const [x0, x1] of [[-104, -88], [-84, -66], [-62, -46]]) {
        for (let xd = x0 + 2; xd < x1 - 1; xd += 3.4 + r() * 1.5) {
          if (r() < 0.25) continue;
          const [px, pz] = k.W(R, xd, zd);
          this.robotParts(R, frame(px, pz, Math.PI / 2 + (r() - 0.5) * 0.4), 0.96);
        }
      }
      // Arms either side of the line, between the gantries.
      for (const xd of [-100, -86, -80, -64, -58, -49]) {
        const side = r() < 0.5 ? -1 : 1;
        this.place(R, [[xd, zd + side * 2.7, side > 0 ? Math.PI : 0], [xd, zd - side * 2.7, side > 0 ? 0 : Math.PI]], 0.55, 0.55, (F) => this.robotArm(R, F, r() < 0.6), 0.1);
      }
      // Line signs hung under the first gantry's beams.
      const [gx, gz] = k.W(R, -96, zd);
      for (const s of [-1, 1]) {
        const [, bz] = k.W(R, -96, zd + s * 1.6);
        this.geo(R, 'a_sign', this.atlas.plane(label, 1.2, 0.6), [gx, 4.95, bz + s * 0.2], [0, s > 0 ? 0 : Math.PI, 0]);
        this.part(R, 'd_black', [1.25, 0.65, 0.03], [gx, 4.95, bz + s * 0.18], 0);
      }
      // Floor numbers at the line heads.
      const [nx, nz] = k.W(R, -86, zd);
      this.floor(R, `num0${lines.findIndex((l) => l[0] === zd) + 1}`, nx, nz, 2.2, 2.2, -Math.PI / 2);
      void gz;
    }
    // Hoists on the central crane beam, one with a torso hanging off it.
    for (const zd of [-36, -16, -56]) {
      const [hx, hz] = k.W(R, -80, zd);
      this.part(R, 'yellow', [1.4, 0.6, 1.0], [hx, 10.7, hz], 0, 0, 0, true);
      this.hook(R, hx, hz, 10.4, zd === -36 ? 5.4 : 6.5 + r() * 2);
      if (zd === -36) {
        this.hang(R, hx - 0.25, hz, 5.3, 4.6, 'dark', 0.02);
        this.hang(R, hx + 0.25, hz, 5.3, 4.6, 'dark', 0.02);
        this.part(R, 'white', [0.62, 0.55, 0.4], [hx, 4.3, hz], 0.3, 0, 0, true);
        this.part(R, 'dark', [0.34, 0.3, 0.3], [hx, 3.85, hz + 0.05], 0.3, 0.5, 0, true);
        this.part(R, 'gunmetal', [0.15, 0.75, 0.15], [hx - 0.42, 3.9, hz], 0.3, 0, 0.2, true);
      }
    }
    for (const zd of [-64, 12]) {
      for (const xd of [-98, -62]) {
        const [hx, hz] = k.W(R, xd, zd);
        this.part(R, 'yellow', [1.0, 0.5, 1.0], [hx, 10.85, hz + (zd < 0 ? 0.6 : -0.6)], 0, 0, 0, true);
        this.hook(R, hx, hz + (zd < 0 ? 0.6 : -0.6), 10.6, 7 + r() * 2);
      }
    }
    // STITCH: the overhead maintenance unit on its rail.
    const [s0x, sz] = k.W(R, -108, -56);
    const [s1x] = k.W(R, -42, -56);
    this.part(R, 'gunmetal', [s1x - s0x, 0.3, 0.22], [(s0x + s1x) / 2, 9.4, sz], 0, 0, 0, true);
    this.part(R, 'gunmetal', [s1x - s0x, 0.04, 0.4], [(s0x + s1x) / 2, 9.25, sz], 0, 0, 0, true);
    for (let x = s0x + 2; x < s1x; x += 6) this.hang(R, x, sz, 14, 9.5, 'gunmetal', 0.04);
    const [ux] = k.W(R, -70, -56);
    this.part(R, 'offwhite', [1.4, 0.75, 1.0], [ux, 8.75, sz], 0, 0, 0, true);
    this.part(R, 'yellow', [1.42, 0.12, 1.02], [ux, 8.45, sz], 0, 0, 0, true);
    this.cpart(R, 'lampRed', 0.08, 0.05, [ux + 0.5, 8.75, sz + 0.51], 0, Math.PI / 2, 0, 10, true);
    for (const [ax, az, a] of [[-0.45, 0.25, 0.4], [0.45, 0.25, -0.5], [0, -0.35, 0.2]] as [number, number, number][]) {
      this.part(R, 'gunmetal', [0.12, 1.1, 0.12], [ux + ax, 7.85, sz + az], 0, a, a * 0.5, true);
      this.part(R, 'dark', [0.16, 0.7, 0.16], [ux + ax + a * 0.4, 7.0, sz + az + a * 0.2], 0, -a, 0, true);
    }
    // Parts bins, reels, a gas cage, the supervisor's desk.
    this.scatter(R, 4, 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 4, 'parts'), { margin: 1.5, pad: 0.4 });
    this.scatter(R, 3, 0.4, 0.65, (F) => this.reel(R, F, 0.55 + r() * 0.2), { margin: 3, pad: 0.5 });
    this.place(R, [[-41, -50, -Math.PI / 2], [-41, -58, -Math.PI / 2], [-41, -12, -Math.PI / 2]], 0.75, 0.35, (F) => this.gasCage(R, F));
    this.place(R, [[-43.5, -34, -Math.PI / 2], [-43.5, -42, -Math.PI / 2], [-44, -2, -Math.PI / 2]], 1.0, 0.5, (F) => this.desk(R, F, 2));
    // Drag marks out of the charging bays.
    for (let xd = -104; xd <= -46; xd += 8) {
      if (r() < 0.4) continue;
      const [bx, bz] = k.W(R, xd, -63);
      this.floor(R, 'drag', bx + (r() - 0.5), bz + 1.8, 3.6, 0.9, Math.PI / 2 + (r() - 0.5) * 0.5);
    }
    this.plate(R, 'cradle_warning', -40, -30, 1.75, 1.25);
    this.sign(R, 'incident', -40, -40, 1.8, 0.8);
    this.sign(R, 'robots', -40, -46, 1.75, 0.7);
    this.sign(R, 'robots', -76, 14, 2.6, 0.8, { high: true });
    this.sign(R, 'stitch', -92, -66, 5.2, 0.45, { high: true });
    this.sign(R, 'hardhat', -79, 14, 2.6, 0.6, { high: true });
    this.sign(R, 'voltage', -40, 9, 1.7, 0.5);
  }

  private warehouse(): void {
    const R = 'warehouse';
    const k = this.k;
    const r = this.rnd;
    this.place(R, [[-45, -82, -Math.PI / 2], [-45, -70, -Math.PI / 2], [-44, -84, -Math.PI / 2]], 0.65, 1.45, (F) => this.forklift(R, F), 0.3);
    this.place(R, [[-108, -79, 0], [-88, -73, Math.PI / 2], [-68, -79, -Math.PI / 2]], 0.4, 0.75, (F) => this.palletJack(R, F));
    this.scatter(R, 5, 0.65, 0.55, (F) => this.pallet(R, F, r() < 0.8), { margin: 1.2, pad: 0.3, yaw: () => (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.2 });
    this.place(R, [[-43, -68, Math.PI], [-46, -84.5, 0.3], [-108, -68, 1]], 0.6, 0.7, (F) => this.kSeries(R, F));
    // Hanging bay signs over the aisle mouths.
    const aisles: [number, string][] = [[-79, 'bay1'], [-73, 'bay2'], [-67.6, 'bay3'], [-84.4, 'bay4']];
    for (const [zd, id] of aisles) {
      const [ax, az] = k.W(R, -47.5, zd);
      this.geo(R, 'a_sign', this.atlas.plane(id, 1.1, 0.55), [ax + 0.02, 7.2, az], [0, Math.PI / 2, 0]);
      this.part(R, 'd_black', [0.03, 0.6, 1.15], [ax, 7.2, az], 0, 0, 0, true);
      this.hang(R, ax, az - 0.45, 10, 7.5);
      this.hang(R, ax, az + 0.45, 10, 7.5);
    }
    for (let i = 0; i < 6; i++) {
      const [sx, sz] = k.W(R, -100 + r() * 55, -86 + r() * 20);
      this.floor(R, 'skid', sx, sz, 4, 0.9, r() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    }
    this.sign(R, 'forklift', -40, -70, 1.7, 0.6);
    this.sign(R, 'hardhat', -40, -82, 1.7, 0.6);
    const [kx, kz] = k.W(R, -44, -76);
    this.floor(R, 'keepClear', kx, kz, 2.8, 0.7, -Math.PI / 2);
  }

  private hangar(): void {
    const R = 'hangar';
    const k = this.k;
    const r = this.rnd;
    // Cordon round the wreck: cones and tape on the pad's edge, two gaps.
    const [ax, az] = k.W(R, -97.8, 40.2);
    const [bx, bz] = k.W(R, -78.2, 59.8);
    const corners: [number, number][] = [[ax, az], [bx, az], [bx, bz], [ax, bz]];
    for (let e = 0; e < 4; e++) {
      const [p0x, p0z] = corners[e];
      const [p1x, p1z] = corners[(e + 1) % 4];
      const len = Math.hypot(p1x - p0x, p1z - p0z);
      const n = Math.round(len / 2.4);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = p0x + (p1x - p0x) * t;
        const z = p0z + (p1z - p0z) * t;
        const gap = (e === 1 && i >= n / 2 - 1 && i < n / 2 + 1) || (e === 3 && i >= n / 2 && i < n / 2 + 2);
        if (!k.free(R, x, z, 0.15, 0.15, 0)) continue;
        const knocked = r() < 0.12;
        this.cone(R, x, z, knocked ? Math.PI / 2 : 0);
        if (!gap && !knocked && i < n) {
          const nx = p0x + (p1x - p0x) * ((i + 1) / n);
          const nz = p0z + (p1z - p0z) * ((i + 1) / n);
          this.tape(R, [x, z], [nx, nz], 0.48);
        }
      }
    }
    // Debris round the heli: panels, a rotor blade on the floor, glass, scorch, fuel.
    const [hx, hz] = k.W(R, -88, 50);
    this.floor(R, 'scorch', hx + 1, hz - 1, 9, 9, 0.5);
    this.floor(R, 'scorch', hx - 3, hz + 3, 5, 5, 2.1);
    this.floor(R, 'puddle', hx + 3, hz + 4, 3.2, 2.2, 1.2, 'a_wet');
    this.floor(R, 'oil', hx - 4, hz - 4, 2.4, 2.4, 0.2);
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2;
      const d = 5 + r() * 2.5;
      const x = hx + Math.cos(a) * d;
      const z = hz + Math.sin(a) * d;
      const s = 0.3 + r() * 0.7;
      this.part(R, r() < 0.5 ? 'offwhite' : 'gunmetal', [s, 0.02, s * (0.4 + r() * 0.6)], [x, 0.04 + r() * 0.08, z], r() * 6, (r() - 0.5) * 0.4, (r() - 0.5) * 0.4);
    }
    for (let i = 0; i < 30; i++) this.part(R, 'glass', [0.06 + r() * 0.15, 0.01, 0.05 + r() * 0.12], [hx + 4 + (r() - 0.5) * 3, 0.03, hz - 2 + (r() - 0.5) * 3], r() * 6);
    this.part(R, 'd_black', [0.42, 0.07, 6.2], [hx + 5.4, 0.12, hz + 1.5], 0.35, 0, 0.06);
    this.part(R, 'gunmetal', [0.5, 0.25, 0.5], [hx + 4.6, 0.13, hz - 1.4], 0.35);
    // Spent extinguishers (simple parts: the model is three draw calls of its own in a room without one).
    this.cpart(R, 'd_red', 0.1, 0.55, [hx - 5.6, 0.1, hz + 2.2], 1.2, Math.PI / 2, 0, 10);
    this.cpart(R, 'd_black', 0.03, 0.12, [hx - 5.6 + Math.sin(1.2) * 0.32, 0.1, hz + 2.2 + Math.cos(1.2) * 0.32], 1.2, Math.PI / 2, 0, 6);
    this.cpart(R, 'd_red', 0.1, 0.55, [hx + 6.2, 0.28, hz - 3.4], 0, 0, 0, 10);
    this.cpart(R, 'd_black', 0.03, 0.1, [hx + 6.2, 0.6, hz - 3.4], 0, 0, 0, 6);
    // Maintenance kit around the hangar floor.
    this.place(R, [[-76, 52, Math.PI / 2], [-76, 46, Math.PI / 2], [-100, 52, -Math.PI / 2]], 0.5, 1.3, (F) => this.rollingStairs(R, F), 0.3);
    this.place(R, [[-67.2, 56, -Math.PI / 2], [-67.2, 62, -Math.PI / 2], [-67.2, 52, -Math.PI / 2]], 1.1, 0.4, (F) => this.workbench(R, F, 2.2));
    this.place(R, [[-100, 34, 0.3], [-98, 28, 0.6]], 0.35, 0.4, (F) => this.ladder(R, F));
    this.place(R, [[-101, 76, Math.PI / 2], [-101, 72, Math.PI / 2]], 0.6, 0.5, (F) => {
      this.part(R, 'd_red', [1.0, 0.7, 0.8], F.P(0, 0.5, 0), F.yaw);
      this.geo(R, 'd_black', new THREE.TorusGeometry(0.32, 0.06, 6, 18), F.P(0, 1.1, 0), [0, F.yaw + Math.PI / 2, 0]);
      this.cpart(R, 'gunmetal', 0.12, 0.6, F.P(0, 1.1, 0), F.yaw, 0, Math.PI / 2, 10);
      for (const s of [-1, 1]) this.cpart(R, 'd_rubber', 0.15, 0.08, F.P(s * 0.45, 0.15, -0.25), F.yaw, 0, Math.PI / 2, 10);
      this.solid(F, 0.5, 0.65, 0.4);
    });
    for (const zd of [25, 31, 33.5]) {
      const [cx, cz] = k.W(R, -75, zd);
      if (k.free(R, cx, cz, 0.15, 0.15, 0)) this.part(R, 'yellow', [0.25, 0.14, 0.18], [cx, 0.07, cz], 0.1);
    }
    this.scatter(R, 3, 0.65, 0.55, (F) => this.pallet(R, F), { margin: 2, pad: 0.5 });
    for (let i = 0; i < 5; i++) {
      const [sx, sz] = k.W(R, -102 + r() * 30, 20 + r() * 60);
      this.floor(R, 'skid', sx, sz, 5, 1.0, r() * 6);
    }
    this.sign(R, 'flame', -110, 70, 1.7, 0.6);
    this.sign(R, 'hardhat', -84, 14, 2.4, 0.6, { high: true });
    this.sign(R, 'forklift', -66, 44.5, 1.8, 0.6);
    this.sign(R, 'poster2', -66, 62, 2.9, 1.1, { high: true });
    this.sign(R, 'muster', -96, 86, 1.8, 0.6);
  }

  private labs(): void {
    const R = 'labs';
    const k = this.k;
    const r = this.rnd;
    // The glass offices: chairs, a second screen, papers, a microscope here and there.
    for (const xd of [-32, -20, 20, 32]) {
      for (const zd of [-30, -14]) {
        const D = this.F(R, xd, zd - 2, Math.PI);
        this.deskTop(R, D, 5, 0.9, 1);
        for (const rr of [-1.5, 1.3]) if (r() < 0.8) k.prop(R, 'chair', D.P(rr, 0, -1.0), D.yaw + (r() - 0.5) * 0.9, { solid: false });
        if (r() < 0.5) {
          const M = frame(...xz(D.P(-2.0, 0, 0.1)), D.yaw + 0.3);
          this.part(R, 'white', [0.22, 0.04, 0.28], M.P(0, 0.92, 0), M.yaw);
          this.part(R, 'white', [0.06, 0.32, 0.06], M.P(0, 1.08, -0.1), M.yaw);
          this.part(R, 'dark', [0.05, 0.18, 0.05], M.P(0, 1.18, 0.02), M.yaw, 0.5);
          this.cpart(R, 'dark', 0.035, 0.12, M.P(0, 1.29, -0.02), M.yaw, -0.4, 0, 8);
        }
        for (let i = 0; i < 4; i++) this.cpart(R, 'd_bottle', 0.035, 0.1 + r() * 0.1, D.P(1.4 + i * 0.12, 0.98, 0.15), 0, 0, 0, 8);
        if (r() < 0.5) this.k.prop(R, 'container', D.P(-1.0 + r() * 2, 0, -2.0), r() * 6, { solid: false });
      }
    }
    // Whiteboards on stands by the core.
    for (const [xd, zd, yaw] of [[-8, -12, Math.PI * 0.85], [9, -12, -Math.PI * 0.85], [-9, -31, Math.PI * 0.15]] as [number, number, number][]) {
      this.place(R, [[xd, zd, yaw]], 0.95, 0.3, (F) => {
        this.geo(R, 'a_sign', this.atlas.plane('whiteboard', 1.8, 0.9), F.P(0, 1.45, 0.03), [0, F.yaw, 0]);
        this.geo(R, 'a_sign', this.atlas.plane('notice', 1.35, 0.9), F.P(0, 1.45, -0.03), [0, F.yaw + Math.PI, 0]);
        this.part(R, 'gunmetal', [1.9, 1.0, 0.04], F.P(0, 1.45, 0), F.yaw);
        for (const s of [-1, 1]) {
          this.part(R, 'gunmetal', [0.04, 1.9, 0.04], F.P(s * 0.92, 0.95, 0), F.yaw);
          this.part(R, 'gunmetal', [0.04, 0.04, 0.6], F.P(s * 0.92, 0.06, 0), F.yaw);
        }
        this.part(R, 'gunmetal', [1.6, 0.04, 0.08], F.P(0, 0.93, 0.06), F.yaw);
        this.solid(F, 0.95, 0.95, 0.15);
      });
    }
    // The core projects: a cone of light and a wire robot turning slowly in it (static here).
    const [cx, cz] = k.W(R, 0, -21);
    this.geo(R, 'd_holo', new THREE.CylinderGeometry(1.25, 1.2, 2.4, 24, 1, true), [cx, 2.15, cz]);
    this.geo(R, 'd_holo', new THREE.CylinderGeometry(1.25, 1.25, 0.02, 24), [cx, 3.35, cz]);
    const holo = (s: V3, p: V3) => this.geo(R, 'd_holoLine', new THREE.BoxGeometry(...s), [cx + p[0], p[1], cz + p[2]], [0, 0.6, 0]);
    holo([0.36, 0.3, 0.22], [0, 2.25, 0]);
    holo([0.18, 0.16, 0.16], [0, 2.52, 0]);
    for (const s of [-1, 1]) {
      holo([0.08, 0.38, 0.08], [s * 0.1, 1.9, 0]);
      holo([0.07, 0.32, 0.07], [s * 0.24, 2.2, 0]);
    }
    for (let i = 0; i < 3; i++) this.geo(R, 'd_holoLine', new THREE.TorusGeometry(1.0 - i * 0.2, 0.008, 4, 40), [cx, 1.3 + i * 0.6, cz], [Math.PI / 2, 0, 0]);
    // Fume hoods and benches along the walls.
    for (const xd of [-12, 12]) {
      this.place(R, [[xd, -35.4, 0]], 0.8, 0.45, (F) => {
        this.part(R, 'white', [1.5, 0.9, 0.8], F.P(0, 0.45, 0), F.yaw);
        this.part(R, 'white', [1.5, 1.2, 0.15], F.P(0, 1.95, -0.32), F.yaw);
        this.part(R, 'white', [1.5, 0.3, 0.8], F.P(0, 2.4, 0), F.yaw);
        for (const s of [-1, 1]) this.part(R, 'white', [0.06, 1.2, 0.8], F.P(s * 0.72, 1.5, 0), F.yaw);
        this.part(R, 'glass', [1.4, 0.8, 0.02], F.P(0, 1.55, 0.38), F.yaw);
        this.part(R, 'lampCool', [1.3, 0.03, 0.2], F.P(0, 2.22, 0.0), F.yaw);
        for (let i = 0; i < 5; i++) this.cpart(R, 'd_bottle', 0.04, 0.15 + r() * 0.1, F.P(-0.5 + i * 0.25, 1.0, (r() - 0.5) * 0.3), 0, 0, 0, 8);
        this.solid(F, 0.75, 1.27, 0.4);
      });
    }
    this.place(R, [[-24, -6.6, Math.PI], [-16, -6.6, Math.PI]], 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 5, 'lab'));
    this.place(R, [[24, -6.6, Math.PI], [30, -6.6, Math.PI]], 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 5, 'binders'));
    this.labsBooths();
    this.plate(R, 'black_data', -6, -36, 1.7, 1.2);
    this.sign(R, 'goggles', 6, -36, 1.7, 0.5);
    this.sign(R, 'poster3', -28, -6, 1.75, 1.1);
    this.sign(R, 'poster2', 28, -6, 1.75, 1.1);
    this.sign(R, 'authorized', -24.5, -36, 2.3, 0.28, { high: true });
    this.sign(R, 'clock', 40, -24, 3.3, 0.45, { mat: 'a_decal', frame: false, high: true });
  }

  private cleanroom(): void {
    const R = 'cleanroom';
    const k = this.k;
    const r = this.rnd;
    // Gowning: a bench, a rack of suits, a sticky mat at the door.
    this.place(R, [[-27, -37.2, Math.PI], [-13, -37.2, Math.PI]], 1.2, 0.25, (F) => this.bench(R, F, 2.2, 'steel'));
    this.place(R, [[-32, -37.4, Math.PI], [-8, -37.4, Math.PI]], 1.0, 0.3, (F) => {
      this.part(R, 'd_chrome', [1.9, 0.04, 0.04], F.P(0, 1.85, 0), F.yaw);
      for (const s of [-1, 1]) this.part(R, 'd_chrome', [0.04, 1.85, 0.04], F.P(s * 0.95, 0.93, 0), F.yaw);
      for (const s of [-1, 1]) this.part(R, 'd_chrome', [0.04, 0.04, 0.5], F.P(s * 0.95, 0.03, 0), F.yaw);
      for (let i = 0; i < 5; i++) {
        if (r() < 0.2) continue;
        this.part(R, 'white', [0.08, 1.35, 0.4], F.P(-0.75 + i * 0.38, 1.12, 0), F.yaw, 0, (r() - 0.5) * 0.05);
        this.part(R, 'white', [0.1, 0.25, 0.25], F.P(-0.75 + i * 0.38, 1.72, 0), F.yaw);
      }
      this.solid(F, 1.0, 0.93, 0.28);
    });
    const [mx, mz] = k.W(R, -20, -37.2);
    k.box(R, 'd_blue', [1.6, 0.012, 1.0], [mx, 0.026, mz], false);
    const g = this.wall(R, -14.5, -36);
    this.signW(R, 'gown', g, 1.7, 0.55);
    // Status beacons and control panels on the tools.
    for (const xd of [-34, -24, -14]) {
      const T = this.F(R, xd, -56, 0);
      const stack = ['lampRed', 'lampWarm', 'leds'];
      this.cpart(R, 'gunmetal', 0.03, 0.4, T.P(1.3, 2.0, -0.7), 0, 0, 0, 6);
      stack.forEach((m, i) => this.cpart(R, r() < 0.4 && i < 2 ? 'dark' : m, 0.055, 0.09, T.P(1.3, 2.25 + i * 0.1, -0.7), 0, 0, 0, 10));
      this.part(R, 'd_black', [0.5, 0.4, 0.06], T.P(-1.0, 1.3, 0.93), T.yaw, -0.3);
      this.part(R, 'screen', [0.44, 0.32, 0.01], T.P(-1.0, 1.3, 0.965), T.yaw, -0.3);
      // Wafer carriers on top.
      for (let i = 0; i < 3; i++) {
        this.part(R, 'd_plastic', [0.32, 0.26, 0.3], T.P(-0.6 + i * 0.45, 1.93, 0.2), T.yaw + (r() - 0.5) * 0.2);
        this.part(R, 'd_blue', [0.33, 0.04, 0.31], T.P(-0.6 + i * 0.45, 2.08, 0.2), T.yaw);
      }
    }
    // HEPA ceiling grid.
    const [x0, z0, x1, z1] = this.def(R).rect;
    const h = this.def(R).h;
    for (let x = x0 + 1.2; x < x1 - 0.5; x += 1.2) this.part(R, 'grey', [0.05, 0.04, z1 - z0 - 0.3], [x, h - 0.02, (z0 + z1) / 2], 0, 0, 0, true);
    for (let z = z0 + 1.2; z < z1 - 0.5; z += 1.2) this.part(R, 'grey', [x1 - x0 - 0.3, 0.04, 0.05], [(x0 + x1) / 2, h - 0.02, z], 0, 0, 0, true);
    // Wafer shelves on the west wall; bootprints across the clean floor (someone in street shoes).
    this.place(R, [[-39.4, -50, Math.PI / 2], [-39.4, -46, Math.PI / 2]], 0.6, 0.25, (F) => this.shelf(R, F, 1.2, 5, 'lab'));
    for (let i = 0; i < 4; i++) {
      const [bx, bz] = k.W(R, -3 - i * 7, -51 - i * 2.4);
      this.floor(R, 'boots', bx, bz, 3, 0.75, Math.PI / 2 + 0.3);
    }
    this.sign(R, 'authorized', -26, -66, 1.75, 0.28);
    this.sign(R, 'notice', -6, -66, 1.7, 0.7);
  }

  private prototypes(): void {
    const R = 'prototypes';
    const k = this.k;
    const r = this.rnd;
    // Paper targets on the boards at the far end, shot through; holes and scorch on the wall behind.
    for (const xd of [8, 16, 24, 32]) {
      const [tx, tz] = k.W(R, xd, -64);
      this.geo(R, 'a_sign', this.atlas.plane('target', 0.9, 1.35), [tx, 1.0, tz + 0.115]);
      const p = this.wallW(R, tx + (r() - 0.5) * 2, tz - 2);
      this.wallDecal(R, 'holes', p, 1.2 + r() * 0.6, 1.2, 1.2);
      if (r() < 0.6) this.wallDecal(R, 'scorch', this.wallW(R, tx + (r() - 0.5) * 3, tz - 2), 0.9, 1.6, 1.6);
    }
    // Shooting benches at the near end of the lanes.
    for (const xd of [8, 16, 32]) {
      this.place(R, [[xd, -43.5, Math.PI], [xd, -45, Math.PI]], 0.75, 0.35, (F) => {
        this.part(R, 'woodDark', [1.5, 0.06, 0.7], F.P(0, 0.9, 0), F.yaw);
        for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.06, 0.87, 0.6], F.P(s * 0.68, 0.44, 0), F.yaw);
        this.part(R, 'd_black', [0.08, 0.1, 0.9], F.P(-0.1, 0.98, 0.0), F.yaw + 0.1);
        this.part(R, 'd_black', [0.06, 0.18, 0.08], F.P(-0.1, 0.92, -0.1), F.yaw + 0.1);
        this.part(R, 'd_black', [0.16, 0.14, 0.08], F.P(0.5, 0.97, 0.1), F.yaw);
        this.geo(R, 'd_black', new THREE.TorusGeometry(0.1, 0.015, 4, 12, Math.PI), F.P(0.5, 1.02, 0.1), [0, F.yaw, 0]);
        for (let i = 0; i < 3; i++) k.prop(R, 'ammoBox', F.P(0.3 + i * 0.12, 0.93, -0.2), F.yaw + (r() - 0.5) * 0.4, { solid: false });
        this.solid(F, 0.75, 0.47, 0.35);
      });
    }
    // Test rig round the prototype on its plinth: a yellow frame, chains, cables.
    const [px, pz] = k.W(R, 20, -40);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this.part(R, 'yellow', [0.15, 4.6, 0.15], [px + sx * 1.9, 2.3, pz + sz * 1.9]);
      k.physics.addStaticBox(new THREE.Vector3(px + sx * 1.9, 2.3, pz + sz * 1.9), new THREE.Vector3(0.08, 2.3, 0.08));
    }
    for (const s of [-1, 1]) {
      this.part(R, 'yellow', [4.0, 0.15, 0.15], [px, 4.6, pz + s * 1.9]);
      this.part(R, 'yellow', [0.15, 0.15, 4.0], [px + s * 1.9, 4.6, pz]);
      this.hang(R, px + s * 0.4, pz, 4.55, 3.0, 'gunmetal', 0.02);
    }
    for (let i = 0; i < 4; i++) this.cpart(R, 'd_black', 0.025, 2.0, [px - 0.9 + i * 0.6, 1.8, pz + 1.4], 0, 0.4 + r() * 0.3, (r() - 0.5) * 0.3, 5);
    this.place(R, [[14, -39, Math.PI / 2], [26, -38.5, -Math.PI / 2]], 1.0, 0.5, (F) => this.desk(R, F, 3));
    // Parts on tables, a pegboard bench, the leg prototype.
    this.scatter(R, 2, 1.0, 0.45, (F) => {
      this.part(R, 'gunmetal', [2.0, 0.06, 0.9], F.P(0, 0.88, 0), F.yaw);
      for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.part(R, 'gunmetal', [0.05, 0.86, 0.05], F.P(sr * 0.95, 0.43, sf * 0.4), F.yaw);
      this.robotParts(R, frame(F.x, F.z, F.yaw + Math.PI / 2), 0.91);
      this.solid(F, 1.0, 0.46, 0.45);
    }, { margin: 2 });
    this.place(R, [[39.4, -54, -Math.PI / 2], [39.4, -48, -Math.PI / 2], [1, -42, Math.PI / 2]], 1.1, 0.4, (F) => this.workbench(R, F, 2.2));
    this.place(R, [[36, -38.5, Math.PI], [3, -62, 0]], 0.7, 0.7, (F) => {
      this.part(R, 'gunmetal', [1.2, 0.3, 1.2], F.P(0, 0.15, 0), F.yaw);
      for (const s of [-1, 1]) {
        this.part(R, 'white', [0.3, 0.9, 0.35], F.P(s * 0.25, 1.75, 0.05), F.yaw, 0.1 * s);
        this.part(R, 'dark', [0.26, 0.1, 0.26], F.P(s * 0.25, 1.25, 0.08), F.yaw);
        this.part(R, 'gunmetal', [0.22, 0.85, 0.24], F.P(s * 0.25, 0.8, 0.12), F.yaw, -0.15 * s);
        this.part(R, 'dark', [0.3, 0.12, 0.5], F.P(s * 0.25, 0.37, 0.2), F.yaw);
      }
      this.part(R, 'dark', [0.75, 0.3, 0.45], F.P(0, 2.32, 0.05), F.yaw);
      this.part(R, 'gunmetal', [0.1, 2.2, 0.1], F.P(0, 1.3, -0.45), F.yaw);
      this.solid(F, 0.6, 1.2, 0.6);
    });
    this.plate(R, 'husk', 40, -50, 1.75, 1.25);
    this.sign(R, 'goggles', 40, -45, 1.7, 0.5);
    this.sign(R, 'robots', 12, -36, 2.4, 0.7, { high: true });
    this.sign(R, 'vanta', 30, -36, 2.4, 0.3, { high: true });
  }

  private servers(): void {
    const R = 'servers';
    const k = this.k;
    const r = this.rnd;
    const [xa] = k.W(R, 44, 0);
    const [xb] = k.W(R, 68, 0);
    const xm = (xa + xb) / 2;
    const len = xb - xa;
    for (let zd = -62, i = 0; zd <= 10; zd += 4, i++) {
      const [, z] = k.W(R, 56, zd);
      // Cable ladder over the row, cables on it, rods to the ceiling.
      for (const s of [-1, 1]) this.part(R, 'gunmetal', [len, 0.06, 0.04], [xm, 2.85, z + s * 0.25], 0, 0, 0, true);
      for (let x = xa + 0.3; x < xb; x += 1.2) this.part(R, 'gunmetal', [0.04, 0.03, 0.5], [x, 2.84, z], 0, 0, 0, true);
      this.part(R, i % 3 === 0 ? 'yellow' : 'd_black', [len - 0.2, 0.08, 0.16], [xm, 2.92, z - 0.08], 0, 0, 0, true);
      this.part(R, i % 2 ? 'd_blue' : 'd_black', [len - 0.2, 0.07, 0.16], [xm, 2.92, z + 0.1], 0, 0, 0, true);
      for (let x = xa + 2; x < xb; x += 5) this.hang(R, x, z, 7, 2.9, 'gunmetal', 0.012);
      // Aisle sign at the row's east end.
      if (zd < 10) {
        const [, az] = k.W(R, 56, zd + 2);
        const id = i % 2 ? 'hotAisle' : 'coldAisle';
        this.geo(R, 'a_sign', this.atlas.plane(id, 0.8, 0.4), [xb + 0.4, 2.65, az], [0, Math.PI / 2, 0], true);
        this.part(R, 'd_black', [0.02, 0.44, 0.84], [xb + 0.39, 2.65, az], 0, 0, 0, true);
        this.hang(R, xb + 0.38, az, 2.87, 2.85);
      }
      // Some racks left open, cables spilling out.
      if (r() < 0.3) {
        const end = r() < 0.5 ? xb : xa;
        const sgn = end === xb ? 1 : -1;
        this.part(R, 'dark', [0.03, 2.2, 1.1], [end + sgn * 0.45, 1.15, z + 0.75], sgn * 0.0, 0, 0);
        for (let j = 0; j < 4; j++) this.cpart(R, ['d_black', 'yellow', 'd_blue'][j % 3], 0.012, 1.6, [end + sgn * (0.1 + j * 0.08), 1.0, z + (r() - 0.5) * 0.6], 0, (r() - 0.5) * 0.3, sgn * 0.4, 4);
      }
    }
    // Lifted floor tiles in the aisles: a dark hole, the tile against a rack, cables coming up.
    for (let t = 0; t < 5; t++) {
      const zd = -60 + Math.floor(r() * 18) * 4;
      const [x, z] = k.W(R, 46 + r() * 20, zd);
      this.part(R, 'd_black', [0.6, 0.006, 0.6], [x, 0.022, z]);
      this.part(R, 'gunmetal', [0.6, 0.03, 0.6], [x + 0.45, 0.33, z - 0.55], 0, -1.2, 0);
      for (let j = 0; j < 3; j++) this.cpart(R, 'd_black', 0.02, 0.6, [x + (r() - 0.5) * 0.3, 0.2, z + (r() - 0.5) * 0.3], r() * 6, (r() - 0.5) * 1.2, (r() - 0.5) * 1.2, 4);
    }
    // Data core: frost on the floor, cables from the ring, WARDEN on the cabinets.
    const [cx, cz] = k.W(R, 88, -26);
    for (let i = 0; i < 10; i++) {
      const a = r() * Math.PI * 2;
      const d = 4.2 + r() * 2.5;
      this.floor(R, 'frost', cx + Math.cos(a) * d, cz + Math.sin(a) * d, 2.2 + r() * 2, 2.2 + r() * 2, r() * 6, 'a_frost');
    }
    for (let a = 0; a < 12; a++) {
      if (a === 3) continue;
      const ang = (a / 12) * Math.PI * 2;
      const R0 = 4.2;
      const R1 = 6.55;
      const mid = (R0 + R1) / 2;
      this.cpart(R, 'd_black', 0.06, R1 - R0, [cx + Math.cos(ang) * mid, 0.06, cz + Math.sin(ang) * mid], -ang + Math.PI / 2, Math.PI / 2, 0, 6);
      if (a === 0 || a === 6) {
        const yaw = Math.atan2(Math.cos(ang), Math.sin(ang));
        const d = 7.2 + 0.62;
        this.geo(R, 'a_lit', this.atlas.plane('warden', 0.9, 0.22), [cx + Math.cos(ang) * d, 1.7, cz + Math.sin(ang) * d], [0, yaw, 0]);
      }
      if (a === 9) {
        const yaw = Math.atan2(Math.cos(ang), Math.sin(ang));
        const d = 7.2 + 0.62;
        this.geo(R, 'a_lit', this.atlas.plane('temp4', 0.5, 0.25), [cx + Math.cos(ang) * d, 1.6, cz + Math.sin(ang) * d], [0, yaw, 0]);
      }
    }
    // UPS battery cabinets, the ops desks' chairs and mess, a crash cart with a laptop.
    for (let i = 0; i < 4; i++) {
      this.place(R, [[98 + i * 1.15, 13.4, Math.PI], [80 + i * 1.15, 13.4, Math.PI]], 0.48, 0.42, (F) => {
        this.part(R, 'gunmetal', [0.92, 2.0, 0.8], F.P(0, 1.0, 0), F.yaw);
        this.part(R, 'd_black', [0.86, 0.5, 0.01], F.P(0, 1.5, 0.405), F.yaw);
        this.part(R, 'leds', [0.06, 0.06, 0.01], F.P(-0.3, 1.6, 0.41), F.yaw);
        this.part(R, 'screen', [0.2, 0.12, 0.01], F.P(0.15, 1.55, 0.41), F.yaw);
        for (let j = 0; j < 6; j++) this.part(R, 'dark', [0.8, 0.012, 0.01], F.P(0, 0.3 + j * 0.12, 0.405), F.yaw);
        this.solid(F, 0.46, 1.0, 0.4);
      }, 0.02);
    }
    for (const dx of [-1.6, 1.6]) {
      const D = this.F(R, 96 + dx, 4, Math.PI);
      this.deskTop(R, D, 2.4, 0.75, 0);
      if (r() < 0.8) k.prop(R, 'chair', D.P(0, 0, -0.9), D.yaw + (r() - 0.5), { solid: false });
    }
    this.scatter(R, 1, 0.4, 0.3, (F) => {
      this.part(R, 'gunmetal', [0.7, 0.04, 0.5], F.P(0, 0.85, 0), F.yaw);
      this.part(R, 'gunmetal', [0.7, 0.04, 0.5], F.P(0, 0.25, 0), F.yaw);
      for (const sr of [-1, 1]) for (const sf of [-1, 1]) this.part(R, 'gunmetal', [0.03, 0.85, 0.03], F.P(sr * 0.33, 0.45, sf * 0.23), F.yaw);
      this.part(R, 'd_black', [0.36, 0.02, 0.25], F.P(0, 0.88, 0.05), F.yaw);
      this.part(R, 'd_black', [0.36, 0.24, 0.02], F.P(0, 1.0, -0.08), F.yaw, -0.3);
      this.part(R, 'screen', [0.32, 0.2, 0.005], F.P(0, 1.0, -0.068), F.yaw, -0.3);
      this.solid(F, 0.36, 0.45, 0.26);
    }, { margin: 4 });
    this.place(R, [[104, -4, -Math.PI / 2], [76, -12, Math.PI]], 0.6, 0.7, (F) => this.kSeries(R, F));
    this.sign(R, 'authorized', 40, 7.5, 2.0, 0.28);
    this.sign(R, 'voltage', 110, -8, 1.7, 0.5);
    this.sign(R, 'coldAisle', 40, -40, 2.4, 0.35, { high: true });
    const p = this.wall(R, 110, -30);
    if (this.wallFree(R, p, 1.8, true)) {
      this.wallDecal(R, 'graffitiCount', p, 2.4, 3.6, 0.9);
      k.fixtures.push([p.x, p.z, 1.8]);
    }
  }

  private cooling(): void {
    const R = 'cooling';
    const k = this.k;
    const r = this.rnd;
    const [xa] = k.W(R, 44, -80);
    const [xb] = k.W(R, 106, -80);
    const south = this.wall(R, 75, -86);
    const pz = south.z + 2.4;
    // The coolant loop: two long pipes on stands, a stub and valve into every tank.
    for (const [y, rad, mat] of [[1.35, 0.2, 'steel'], [2.55, 0.16, 'd_copper']] as [number, number, string][]) {
      this.cpart(R, mat, rad, xb - xa, [(xa + xb) / 2, y, pz], 0, 0, Math.PI / 2, 12);
      for (let x = xa + 0.4; x < xb; x += 4) this.part(R, 'gunmetal', [0.1, 0.06, rad * 2 + 0.12], [x, y, pz]);
    }
    k.physics.addStaticBox(new THREE.Vector3((xa + xb) / 2, 1.35, pz), new THREE.Vector3((xb - xa) / 2, 0.22, 0.22), undefined, { surface: 'metal', allowDecals: true });
    k.claim(xa, pz - 0.25, xb, pz + 0.25);
    for (let x = xa + 1; x < xb; x += 4) {
      this.part(R, 'gunmetal', [0.12, 1.15, 0.12], [x, 0.58, pz]);
      this.part(R, 'gunmetal', [0.5, 0.05, 0.5], [x, 0.025, pz]);
    }
    for (let xd = 48; xd <= 102; xd += 9) {
      const [tx, tz] = k.W(R, xd, -78);
      const edge = tz - 2.2;
      const l = edge - pz;
      if (l > 0.1) {
        this.cpart(R, 'steel', 0.12, l, [tx, 1.35, (pz + edge) / 2], 0, Math.PI / 2, 0, 10);
        this.geo(R, 'd_red', new THREE.TorusGeometry(0.2, 0.025, 6, 16), [tx + 0.18, 1.35, (pz + edge) / 2], [0, Math.PI / 2, 0]);
        this.cpart(R, 'd_red', 0.02, 0.36, [tx + 0.12, 1.35, (pz + edge) / 2], 0, 0, Math.PI / 2, 6);
      }
      // Frost round the tank's foot, icicles off the pipe.
      for (let i = 0; i < 2; i++) this.floor(R, 'frost', tx + (r() - 0.5) * 3, tz + (r() - 0.5) * 3, 2.5 + r() * 2, 2.5 + r() * 2, r() * 6, 'a_frost');
      for (let i = 0; i < 5; i++) {
        const l2 = 0.08 + r() * 0.25;
        this.geo(R, 'd_ice', new THREE.ConeGeometry(0.02 + r() * 0.015, l2, 5), [tx - 2 + r() * 4, 2.39 - l2 / 2, pz + (r() - 0.5) * 0.1], [Math.PI, 0, 0]);
      }
      // Pressure gauge on the tank.
      this.cpart(R, 'white', 0.1, 0.04, [tx, 1.7, tz + 2.22], 0, Math.PI / 2, 0, 12);
      this.cpart(R, 'gunmetal', 0.115, 0.03, [tx, 1.7, tz + 2.2], 0, Math.PI / 2, 0, 12);
    }
    // Pumps on the north side between the tanks.
    for (const xd of [52.5, 61.5, 88.5, 97.5]) {
      this.place(R, [[xd, -72.5, 0]], 0.5, 0.8, (F) => {
        this.part(R, 'gunmetal', [0.9, 0.2, 1.5], F.P(0, 0.1, 0), F.yaw);
        this.cpart(R, 'd_blue', 0.26, 0.7, F.P(0, 0.5, -0.35), F.yaw, Math.PI / 2, 0, 12);
        this.cpart(R, 'gunmetal', 0.3, 0.3, F.P(0, 0.5, 0.25), F.yaw, Math.PI / 2, 0, 14);
        this.cpart(R, 'steel', 0.1, 1.2, F.P(0, 0.5, 1.0), F.yaw, Math.PI / 2, 0, 8);
        this.cpart(R, 'steel', 0.1, 0.8, F.P(0, 0.95, 0.25), F.yaw, 0, 0, 8);
        for (let i = 0; i < 5; i++) this.part(R, 'dark', [0.54, 0.02, 0.02], F.P(0, 0.62, -0.6 + i * 0.12), F.yaw);
        this.solid(F, 0.45, 0.45, 0.8);
      });
    }
    // A catwalk along the south wall with a ladder down.
    const [cw0] = k.W(R, 44, -86);
    const [cw1] = k.W(R, 104, -86);
    const s0 = (cw0 - south.x) * -south.nz;
    const s1 = (cw1 - south.x) * -south.nz;
    this.catwalk(R, south, Math.min(s0, s1), Math.max(s0, s1), 4.2);
    const lad = this.wall(R, 104.5, -86);
    this.wallLadder(R, south, (lad.x - south.x) * -south.nz, 4.2);
    this.plate(R, 'thermal_control', 40, -71, 1.75, 1.25);
    this.sign(R, 'temp4', 40, -73.4, 1.55, 0.25, { mat: 'a_lit' });
    this.sign(R, 'coolant', 56, -86, 3.3, 0.3, { high: true });
    this.sign(R, 'chilled', 80, -86, 3.3, 0.3, { high: true });
    this.sign(R, 'hardhat', 110, -72, 1.7, 0.55);
    this.sign(R, 'voltage', 70, -86, 3.3, 0.45, { high: true });
  }

  private barracks(): void {
    const R = 'barracks';
    const k = this.k;
    const r = this.rnd;
    for (let zd = 18; zd <= 46; zd += 4) {
      const [bx, bz] = k.W(R, 107, zd);
      for (const y of [0.62, 1.76]) {
        this.part(R, 'white', [0.4, 0.1, 0.6], [bx + 0.8, y + 0.05, bz], (r() - 0.5) * 0.3);
        const tossed = r() < 0.35;
        this.part(R, r() < 0.5 ? 'd_blanket' : 'd_blanket2', tossed ? [1.0, 0.1, 0.95] : [1.5, 0.04, 0.92], [bx - (tossed ? 0.5 : 0.1), y + (tossed ? 0.07 : 0.03), bz], tossed ? r() : 0, 0, tossed ? 0.08 : 0);
      }
      // Footlocker, boots, a photo on the wall.
      this.place(R, [[104.6, zd, Math.PI / 2]], 0.45, 0.28, (F) => {
        this.part(R, 'd_army', [0.85, 0.45, 0.5], F.P(0, 0.23, 0), F.yaw);
        this.part(R, 'gunmetal', [0.87, 0.04, 0.52], F.P(0, 0.44, 0), F.yaw);
        this.part(R, 'd_chrome', [0.08, 0.06, 0.02], F.P(0, 0.36, 0.26), F.yaw);
        if (r() < 0.4) this.part(R, 'd_army', [0.28, 0.18, 0.3], F.P(0.2, 0.55, 0), F.yaw, 0, 0.3);
        this.solid(F, 0.43, 0.23, 0.26);
        if (r() < 0.6) for (const s of [-1, 1]) this.part(R, 'd_rubber', [0.11, 0.14, 0.28], F.P(s * 0.08 - 0.25, 0.07, 0.48), F.yaw + (r() - 0.5) * 0.3);
      }, 0.02);
      if (r() < 0.6) {
        const p = this.wallW(R, k.W(R, 110, 0)[0], bz + 1.0);
        this.signW(R, 'photo', p, 2.35, 0.24, { high: true });
      }
    }
    // Rec corner: a TV, a couch, a low table.
    this.place(R, [[72, 21, Math.PI / 2], [76, 52, -Math.PI / 2], [96, 56, Math.PI]], 1.4, 1.6, (F) => {
      this.part(R, 'woodDark', [1.4, 0.55, 0.45], F.P(0, 0.28, -1.4), F.yaw);
      this.part(R, 'd_black', [1.25, 0.72, 0.06], F.P(0, 0.95, -1.4), F.yaw);
      this.part(R, 'screen', [1.18, 0.66, 0.01], F.P(0, 0.95, -1.367), F.yaw);
      this.part(R, 'fabric', [2.0, 0.45, 0.85], F.P(0, 0.23, 1.25), F.yaw);
      this.part(R, 'fabric', [2.0, 0.5, 0.22], F.P(0, 0.65, 1.6), F.yaw);
      for (const s of [-1, 1]) this.part(R, 'fabric', [0.2, 0.62, 0.85], F.P(s * 1.0, 0.31, 1.25), F.yaw);
      this.part(R, 'woodDark', [1.0, 0.4, 0.55], F.P(0, 0.2, 0.1), F.yaw);
      for (let i = 0; i < 4; i++) this.cpart(R, ['d_red', 'd_army', 'white', 'd_bottle'][i], 0.035, 0.12, F.P(-0.3 + i * 0.18, 0.46, 0.05 + (r() - 0.5) * 0.2), 0, 0, 0, 8);
      this.part(R, 'd_red', [0.3, 0.02, 0.22], F.P(0.25, 0.41, -0.1), F.yaw + 0.3);
      this.solid(F, 0.7, 0.4, 0.25, 0, 0, -1.4);
      this.solid(F, 1.1, 0.45, 0.45, 0, 0, 1.3);
      this.solid(F, 0.5, 0.2, 0.28, 0, 0, 0.1);
    }, 0.3);
    // Gym corner: punching bag, dumbbells, a mat.
    const [gx, gz] = k.W(R, 80, 52);
    if (k.free(R, gx, gz, 0.4, 0.4, 0.2)) {
      this.hang(R, gx, gz, 6, 1.8, 'd_chrome', 0.01);
      this.cpart(R, 'd_red', 0.2, 1.0, [gx, 1.3, gz], 0, 0, 0, 12);
      this.cpart(R, 'd_black', 0.21, 0.08, [gx, 1.82, gz], 0, 0, 0, 12);
      k.physics.addStaticBox(new THREE.Vector3(gx, 1.3, gz), new THREE.Vector3(0.2, 0.5, 0.2));
    }
    const [mx, mz] = k.W(R, 76, 52);
    k.box(R, 'd_rubber', [2.6, 0.02, 1.8], [mx, 0.03, mz], false);
    this.place(R, [[70, 54, Math.PI / 2], [72, 46, Math.PI / 2]], 0.7, 0.25, (F) => {
      this.part(R, 'gunmetal', [1.3, 0.05, 0.45], F.P(0, 0.4, 0), F.yaw);
      this.part(R, 'gunmetal', [1.3, 0.05, 0.45], F.P(0, 0.75, 0), F.yaw, 0.15);
      for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.05, 0.8, 0.45], F.P(s * 0.62, 0.4, 0), F.yaw);
      for (let i = 0; i < 5; i++) for (const s of [-1, 1]) this.cpart(R, 'd_black', 0.05 + i * 0.008, 0.06, F.P(-0.5 + i * 0.25 + s * 0.08, i % 2 ? 0.48 : 0.83, 0), F.yaw, 0, Math.PI / 2, 8);
      this.solid(F, 0.65, 0.42, 0.24);
    });
    // The cage: empty weapon racks, ammo cases on the crates.
    this.place(R, [[82, 85.4, Math.PI], [84, 85.4, Math.PI]], 1.0, 0.2, (F) => {
      this.part(R, 'gunmetal', [1.9, 1.6, 0.06], F.P(0, 1.0, -0.08), F.yaw);
      this.part(R, 'dark', [1.9, 0.08, 0.22], F.P(0, 0.35, 0.02), F.yaw);
      for (let i = 0; i < 6; i++) if (r() < 0.35) this.part(R, 'd_black', [0.06, 1.0, 0.1], F.P(-0.75 + i * 0.3, 0.9, 0.03), F.yaw, -0.06);
      this.solid(F, 0.95, 0.8, 0.14);
    });
    for (const zd of [68, 74, 80]) {
      const [cx, cz] = k.W(R, 72, zd);
      for (let i = 0; i < 2 + Math.floor(r() * 3); i++) k.prop(R, 'ammoBox', [cx + (r() - 0.5) * 0.5, 1.1, cz + (r() - 0.5) * 1.6], r() * 3, { solid: false });
    }
    const [bx2, bz2] = k.W(R, 80, 60);
    this.geo(R, 'a_sign', this.atlas.plane('armory', 1.6, 0.4), [bx2, 2.3, bz2 - 0.06], [0, Math.PI, 0]);
    this.part(R, 'd_black', [1.65, 0.45, 0.02], [bx2, 2.3, bz2 - 0.045], 0);
    // Laundry by the lockers.
    this.place(R, [[68, 31, Math.PI / 2], [68, 36, Math.PI / 2]], 0.35, 0.35, (F) => {
      this.cpart(R, 'd_blue', 0.3, 0.7, F.P(0, 0.35, 0), 0, 0, 0, 12);
      for (let i = 0; i < 4; i++) this.geo(R, ['d_army', 'd_blanket2', 'white', 'fabric'][i], new THREE.IcosahedronGeometry(0.16, 0), F.P((r() - 0.5) * 0.3, 0.72 + r() * 0.1, (r() - 0.5) * 0.3));
      this.solid(F, 0.3, 0.35, 0.3);
    });
    // White Night, with candles under it.
    if (this.plate(R, 'white_night', 66, 56.5, 1.8, 1.2)) {
      const p = this.wall(R, 66, 56.5);
      const F = frame(p.x + p.nx * 0.15, p.z + p.nz * 0.15, p.yaw);
      this.part(R, 'woodDark', [1.1, 0.04, 0.25], F.P(0, 1.0, 0), F.yaw);
      for (const s of [-1, 1]) this.part(R, 'gunmetal', [0.03, 0.15, 0.2], F.P(s * 0.45, 0.92, -0.02), F.yaw, 0, 0);
      for (let i = 0; i < 6; i++) {
        const h = 0.06 + r() * 0.12;
        const pr = -0.45 + i * 0.18 + (r() - 0.5) * 0.05;
        this.cpart(R, 'd_cream', 0.025, h, F.P(pr, 1.02 + h / 2, (r() - 0.5) * 0.1), 0, 0, 0, 8);
        if (r() < 0.6) this.geo(R, 'lampWarm', new THREE.ConeGeometry(0.012, 0.035, 5), F.P(pr, 1.04 + h, 0));
      }
      this.part(R, 'd_black', [0.18, 0.24, 0.02], F.P(0.35, 1.14, -0.08), F.yaw, -0.15);
      this.geo(R, 'a_sign', this.atlas.plane('photo', 0.15, 0.2), F.P(0.35, 1.14, -0.065), [0, F.yaw, 0]);
      for (let i = 0; i < 3; i++) this.geo(R, 'd_flower1', new THREE.IcosahedronGeometry(0.04, 0), F.P(-0.25 + i * 0.06, 1.05, 0.06));
    }
    this.sign(R, 'lightsOut', 110, 30, 2.9, 0.35, { high: true });
    this.sign(R, 'schedule', 66, 50, 1.65, 0.6);
    this.sign(R, 'poster2', 88, 14, 2.9, 1.1, { high: true });
    this.sign(R, 'muster', 90, 86, 1.7, 0.6);
    this.sign(R, 'dartboard', 66, 47.5, 1.7, 0.42, { mat: 'a_decal', frame: false });
  }

  private power(): void {
    const R = 'power';
    const k = this.k;
    const r = this.rnd;
    const [cx, cz] = k.W(R, 0, -76);
    // Hazard ring painted round the reactor base, a railing outside it (gap to the consoles).
    const ring = 4.35;
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      this.part(R, i % 2 ? 'yellow' : 'd_black', [0.86, 0.006, 0.3], [cx + Math.cos(a) * ring, 0.025, cz + Math.sin(a) * ring], -a + Math.PI / 2);
    }
    const rr = 5.0;
    for (let i = 0; i < 16; i++) {
      if (i === 3 || i === 4) continue;
      const a = (i / 16) * Math.PI * 2;
      const b = ((i + 1) / 16) * Math.PI * 2;
      const pa: [number, number] = [cx + Math.cos(a) * rr, cz + Math.sin(a) * rr];
      const pb: [number, number] = [cx + Math.cos(b) * rr, cz + Math.sin(b) * rr];
      // No footprint test: the round base's square footprint covers the ring's diagonals.
      this.rail(R, pa, pb);
    }
    // A catwalk ring around the reactor column at 5.5 m.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const m = 3.0;
      this.part(R, 'steel', [1.25, 0.05, 1.1], [cx + Math.cos(a) * m, 5.5, cz + Math.sin(a) * m], -a + Math.PI / 2, 0, 0, true);
      this.part(R, 'yellow', [0.05, 1.0, 0.05], [cx + Math.cos(a) * 3.55, 6.0, cz + Math.sin(a) * 3.55], 0, 0, 0, true);
      this.part(R, 'yellow', [1.42, 0.05, 0.05], [cx + Math.cos(a + Math.PI / 16) * 3.55, 6.5, cz + Math.sin(a + Math.PI / 16) * 3.55], -a - Math.PI / 16 + Math.PI / 2, 0, 0, true);
      if (i % 4 === 0) this.part(R, 'gunmetal', [0.08, 0.08, 1.3], [cx + Math.cos(a) * 2.9, 5.0, cz + Math.sin(a) * 2.9], -a + Math.PI / 2, 0.6, 0, true);
    }
    // Transformers with insulators and cables to the reactor.
    for (const xd of [-16, 16]) {
      this.place(R, [[xd, -82, 0], [xd, -80, 0]], 1.2, 0.8, (F) => {
        this.part(R, 'gunmetal', [2.0, 2.0, 1.3], F.P(0, 1.0, 0), F.yaw);
        for (let i = 0; i < 9; i++) for (const s of [-1, 1]) this.part(R, 'dark', [0.03, 1.6, 0.25], F.P(-0.9 + i * 0.225, 0.95, s * 0.75), F.yaw);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 4; j++) this.cpart(R, 'white', 0.11 - j * 0.01, 0.09, F.P(-0.6 + i * 0.6, 2.06 + j * 0.11, 0), 0, 0, 0, 10);
          this.cpart(R, 'd_copper', 0.03, 0.2, F.P(-0.6 + i * 0.6, 2.55, 0), 0, 0, 0, 6);
        }
        this.geo(R, 'a_sign', this.atlas.plane('voltage', 0.45, 0.45), F.P(0, 1.2, 0.656), [0, F.yaw, 0]);
        this.solid(F, 1.05, 1.0, 0.95);
        // Two fat cables across the floor to the reactor base.
        const sx = F.x;
        const sz = F.z + 0.7;
        for (const o of [-0.25, 0.25]) {
          const ex = cx + Math.sign(sx - cx) * 4.2;
          const ez = cz + o;
          const dx = ex - sx;
          const dz = ez - (sz + o);
          const l = Math.hypot(dx, dz);
          this.cpart(R, 'd_black', 0.07, l, [(sx + ex) / 2, 0.07, (sz + o + ez) / 2], Math.atan2(dx, dz), Math.PI / 2, 0, 6);
        }
      });
    }
    // Breaker cabinets on the north wall between the consoles.
    for (let i = 0; i < 4; i++) {
      this.place(R, [[-2.4 + i * 1.6 * 1.0, -66.4, Math.PI]], 0.42, 0.27, (F) => {
        this.part(R, 'grey', [0.82, 2.0, 0.5], F.P(0, 1.0, 0), F.yaw);
        this.part(R, 'dark', [0.01, 1.9, 0.01], F.P(0, 1.0, 0.255), F.yaw);
        this.part(R, 'd_chrome', [0.03, 0.2, 0.04], F.P(0.08, 1.1, 0.27), F.yaw);
        this.part(R, r() < 0.5 ? 'lampRed' : 'leds', [0.05, 0.05, 0.01], F.P(-0.25, 1.75, 0.255), F.yaw);
        this.geo(R, 'a_sign', this.atlas.plane('voltage', 0.22, 0.22), F.P(-0.2, 1.4, 0.256), [0, F.yaw, 0]);
        this.solid(F, 0.41, 1.0, 0.25);
      }, 0.02);
    }
    this.sign(R, 'reactor', 0, -66, 3.3, 0.45, { high: true });
    this.sign(R, 'hardhat', -36, -66, 1.7, 0.55);
    this.sign(R, 'flame', 30, -86, 2.8, 0.55, { high: true });
    this.sign(R, 'flame', -22, -86, 2.8, 0.55, { high: true });
    this.sign(R, 'robots', 36, -66, 1.7, 0.6);
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      this.floor(R, 'oil', cx + Math.cos(a) * 6.5, cz + Math.sin(a) * 6.5, 1.4, 1.4, r() * 6);
    }
  }
}
