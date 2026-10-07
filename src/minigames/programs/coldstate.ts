import { hz, type Drone } from '../chip';
import { H, Screen, W, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * COLD STATE (2010). The Well, level -4, the night of Victor's last experiment. KNOT
 * reports Milo's identity in storage room D-4; there is only a coat. Then the level
 * drops below -30, KNOT locks it down and counts people who are not there, and every
 * way out closes a moment before he reaches it. The only warm thing left is the HUSK
 * frame's emergency heater, and the frame's locks have one rule.
 */

const TS = 8;
const MW = 44;
const MH = 30;
/** Height of the status bar over the map. */
const HUD = 10;

const BLUE = '#3a5aa8';
const DATA = '#bfe8ff';

const VIC_PAL = { h: '#8a8a90', f: '#e0b090', w: '#e8e8e4', k: '#2a2a30', g: '#202830', t: '#5a7090', b: '#101010' };
const VIC = [
  sprite(['..hhh..', '.hhhhh.', '.hfffh.', 'wwwwwww', 'wwwwwww', 'fwwwwwf', '.ww.ww.', '.kk.kk.'], VIC_PAL),
  sprite(['..hhh..', '.hhhhh.', '.hfffh.', 'wwwwwww', 'wwwwwww', 'fwwwwwf', '.ww.ww.', 'kk...kk'], VIC_PAL),
];
const VIC_CRAWL = sprite(['.......hh', 'kkwwwwwhhh', 'kk.wwwwfh.'], VIC_PAL);
const VIC_SIDE = [
  sprite(['..hhh..', '.hhhhh.', '.fgfgf.', '.fffff.', '..fff..', '.wwwww.', 'wwwwwww', 'wwtwtww', 'wwwwwww', 'fwwwwwf', '.wwwww.', '.kk.kk.', '.kk.kk.', '.bb.bb.'], VIC_PAL),
  sprite(['..hhh..', '.hhhhh.', '.fgfgf.', '.fffff.', '..fff..', '.wwwww.', 'wwwwwww', 'wwtwtww', 'wwwwwww', 'fwwwwwf', '.wwwww.', '.kk..kk', 'kk...kk', 'bb....b'], VIC_PAL),
];
const K_TOP = sprite(['.gggggg.', 'gGGGGGGg', 'gGGGGGGg', 'gGGGGGGg', '.gddddg.', 'gg....gg'], { g: '#4a4e56', G: '#6a6e76', d: '#2a2e34' });
const K_SIDE = sprite(
  ['..gggg..', '.gGGGGg.', '.gGeeGg.', '.gGGGGg.', '..gddg..', 'gggggggg', 'gGGGGGGg', 'gGGGGGGg', 'g.GGGG.g', '..G..G..', '..G..G..', '.gg..gg.'],
  { g: '#3a3e44', G: '#5a5e66', d: '#2a2e34', e: '#e8f0ff' },
);
const LANTERN = sprite(['.yyyy.', 'yYYYYy', 'yYYYYy', '.yyyy.', '..gg..', '.gggg.', 'gggggg'], { y: '#8a6a10', Y: '#ffd040', g: '#4a4e56' });
const COAT = sprite(['.b...b.', 'bbbbbbb', 'bbbBbbb', '.bbBbb.', '.bbBbb.', '.bbbbb.'], { b: BLUE, B: '#20304a' });

/** The music box (our own tune, A minor). It slows and loses notes as it freezes. */
const SONG: [string, number][] = [
  ['A5', 1], ['E5', 1], ['C5', 1], ['E5', 1], ['B4', 1], ['E5', 1], ['G#4', 2],
  ['A4', 1], ['C5', 1], ['E5', 1], ['A5', 1], ['G5', 1], ['F5', 1], ['E5', 2],
  ['F5', 1], ['D5', 1], ['B4', 1], ['D5', 1], ['C5', 1], ['A4', 1], ['B4', 1], ['G#4', 1],
  ['A4', 3], ['', 1],
];

type DoorId = 'knot' | 'd4' | 'lift' | 'stairs' | 'bay';
interface Door {
  id: DoorId;
  tiles: [number, number][];
  open: boolean;
}

/** Level -4 of The Well, carved out of solid rock (1 wall, 0 floor, 2 KNOT console). */
function buildGrid(): Uint8Array {
  const g = new Uint8Array(MW * MH).fill(1);
  const carve = (x: number, y: number, w: number, h: number, v = 0) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g[(y + j) * MW + x + i] = v;
  };
  carve(1, 1, 8, 5); // KNOT room
  carve(2, 1, 6, 1, 2); // its consoles
  carve(4, 6, 2, 2); // down to D-4
  carve(1, 8, 8, 6); // storage D-4
  carve(9, 10, 3, 2); // out to the hall
  carve(12, 4, 16, 16); // the hall
  for (const [x, y] of [[15, 7], [15, 15], [19, 11], [23, 7], [23, 15]]) carve(x, y, 2, 2, 1); // pillars
  carve(22, 1, 2, 3); // north link
  carve(24, 1, 14, 2); // north corridor
  carve(38, 1, 5, 5); // lift lobby
  carve(28, 10, 8, 2); // east corridor
  carve(36, 8, 6, 6); // stairwell
  carve(18, 20, 2, 4); // south link
  carve(18, 24, 20, 2); // south corridor
  carve(38, 21, 5, 7); // HUSK bay
  return g;
}

const COAT_AT = { x: 3 * TS + 4, y: 12 * TS + 4 };
const HUSK_AT = { x: 41 * TS + 4, y: 24 * TS + 4 };
const LANTERN_AT = { x: 40 * TS + 4, y: 4 * TS };
const LAMPS: [number, number][] = [[13, 4], [26, 4], [13, 19], [26, 19], [30, 1], [31, 10], [25, 24], [33, 24], [2, 8], [7, 13]];
interface Unit {
  x: number;
  y: number;
  tx: number;
  ty: number;
  wake: number;
  awake: boolean;
  stun: number;
  name: string;
}
interface Ghost {
  x: number;
  y: number;
  label: string;
  child: boolean;
  /** Fades in when it is counted. */
  on: number;
}

// Side view (the bay) and the HUSK's visor.
const FLOOR = 112;
const HUSK_X = 146;
const BAY_FROST0 = 18;
const CLACKS = [0, 0.45, 0.7, 1.3, 1.45, 1.55, 2.2];

type Phase = 'intro' | 'coat' | 'chase' | 'bay' | 'inside' | 'locks' | 'after' | 'scare' | 'black';

class ColdState implements Program {
  done = false;
  ending = ['ELEKTRON-30 // COLD STATE', 'THE WELL. -30.0°', 'ASHGRAVE, V.: LOCATED.'];
  private t = 0;
  private phase: Phase = 'intro';
  private pt = 0;
  private grid = buildGrid();
  private doors: Door[] = [
    { id: 'knot', tiles: [[4, 6], [5, 6]], open: false },
    { id: 'd4', tiles: [[9, 10], [9, 11]], open: false },
    { id: 'lift', tiles: [[37, 1], [37, 2]], open: true },
    { id: 'stairs', tiles: [[35, 10], [35, 11]], open: true },
    { id: 'bay', tiles: [[37, 24], [37, 25]], open: false },
  ];
  private doorAt = new Map<number, Door>();
  private sealed = new Set<DoorId>();
  // Victor on the map.
  private x = 4 * TS + 4;
  private y = 3 * TS + 4;
  private face = 1;
  private walk = 0;
  private stepT = 0;
  private body = 36.6;
  private hurt = 0;
  private hasCoat = false;
  private collapsed = false;
  private amb = -29.6;
  private obj: 'coat' | 'lift' | 'stairs' | 'heat' | null = 'coat';
  private persons = 3;
  private units: Unit[];
  private ghosts: Ghost[] = [];
  private milo: Ghost | null = null;
  private vdist: Int16Array = new Int16Array(MW * MH);
  private vdistT = 0;
  private bayDist: Int16Array;
  private crawlDist: Int16Array | null = null;
  private notYet = false;
  private bayCalled = false;
  private pingT = 1;
  private timers: { t: number; fn: () => void }[] = [];
  /** Someone on the radio (seconds left). */
  private radioT = 0;
  // Effects.
  private glitch = 0;
  private flash = 0;
  private red = 0;
  private heartT = 0;
  private wind: Drone | null = null;
  private heater: Drone | null = null;
  // Music box.
  private mbOn = false;
  private mbI = 0;
  private mbClock = 0;
  private mbNext = 0;
  private mbTempo = 1;
  private mbPitch = 1;
  private mbSkip = 0;
  // The bay.
  private bx = 10;
  private bayTemp = -28.6;
  private shutdown = false;
  private front = BAY_FROST0;
  private warned = false;
  // Inside the frame.
  private match = 0;
  private miloP = 0;
  private beats: number[] = [];
  private bpm = 110;
  private deadAt = -1;
  private clacks = 0;
  private cracks: [number, number][][] = [];
  private dark: HTMLCanvasElement;
  private frost = Array.from({ length: 400 }, () => ({ x: Math.random() * W, y: Math.random() * H, k: Math.random() }));

  constructor(private c: Ctx) {
    for (const d of this.doors) for (const [x, y] of d.tiles) this.doorAt.set(y * MW + x, d);
    const unit = (tx: number, ty: number, name: string): Unit => ({ x: tx * TS + 4, y: ty * TS + 4, tx, ty, wake: Infinity, awake: false, stun: 0, name });
    this.units = [unit(2, 4, 'K-1'), unit(7, 4, 'K-2'), unit(12, 4, 'K-3'), unit(27, 19, 'K-4'), unit(13, 19, 'K-5')];
    this.bayDist = this.bfs(41, 24, true);
    this.dark = document.createElement('canvas');
    this.dark.width = W / 2;
    this.dark.height = H / 2;
    this.mbOn = true;
  }

  // ------------------------------------------------------------- timers, radio

  private at(sec: number, fn: () => void): void {
    this.timers.push({ t: this.t + sec, fn });
  }

  /** Cain on the radio: static and muffled square-wave babble, no words. */
  private radio(dur: number): void {
    const { chip } = this.c;
    this.radioT = dur;
    chip.noise(0.1, 0.15, 2600, 1.5);
    for (let i = 0; i < dur * 5; i++) chip.beep(260 + Math.random() * 420, 0.07, 0.03, 'square', undefined, 0.15 + i * 0.2 + Math.random() * 0.06);
    chip.noise(0.08, 0.12, 2600, 1.5, dur);
  }

  private tickTimers(dt: number): void {
    this.radioT = Math.max(0, this.radioT - dt);
    const due = this.timers.filter((x) => x.t <= this.t);
    this.timers = this.timers.filter((x) => x.t > this.t);
    for (const x of due) x.fn();
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.pt = 0;
  }

  // ------------------------------------------------------------- map

  private passable(tx: number, ty: number, ignoreDoors = false): boolean {
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return false;
    if (this.grid[ty * MW + tx] !== 0) return false;
    if (ignoreDoors) return true;
    const d = this.doorAt.get(ty * MW + tx);
    return !d || d.open;
  }

  private solid(px: number, py: number): boolean {
    return !this.passable(Math.floor(px / TS), Math.floor(py / TS));
  }

  private free(x: number, y: number): boolean {
    const r = 2.9;
    return !this.solid(x - r, y - r) && !this.solid(x + r, y - r) && !this.solid(x - r, y + r) && !this.solid(x + r, y + r);
  }

  /** Move with collision, sliding round corners a little so the 2-wide corridors are easy. */
  private move(dx: number, dy: number): void {
    if (dx) {
      if (this.free(this.x + dx, this.y)) this.x += dx;
      else this.nudge(dx, true);
    }
    if (dy) {
      if (this.free(this.x, this.y + dy)) this.y += dy;
      else this.nudge(dy, false);
    }
  }

  private nudge(d: number, horizontal: boolean): void {
    for (const o of [1, -1, 2, -2, 3, -3, 4, -4]) {
      const ok = horizontal ? this.free(this.x + d, this.y + o) : this.free(this.x + o, this.y + d);
      if (!ok) continue;
      const step = Math.sign(o) * Math.min(Math.abs(d), Math.abs(o));
      const nx = horizontal ? this.x : this.x + step;
      const ny = horizontal ? this.y + step : this.y;
      if (this.free(nx, ny)) {
        this.x = nx;
        this.y = ny;
      }
      return;
    }
  }

  private bfs(sx: number, sy: number, ignoreDoors = false): Int16Array {
    const dist = new Int16Array(MW * MH).fill(-1);
    if (!this.passable(sx, sy, true)) return dist;
    const q = [sy * MW + sx];
    dist[q[0]] = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      const cx = c % MW;
      const cy = (c / MW) | 0;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (!this.passable(nx, ny, ignoreDoors)) continue;
        const n = ny * MW + nx;
        if (dist[n] >= 0) continue;
        dist[n] = dist[c] + 1;
        q.push(n);
      }
    }
    return dist;
  }

  /** The neighbouring tile one step down a distance field (or null). */
  private downhill(field: Int16Array, tx: number, ty: number, ignoreDoors = false): [number, number] | null {
    const here = field[ty * MW + tx];
    let best: [number, number] | null = null;
    let bd = here < 0 ? 32767 : here;
    for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]) {
      if (!this.passable(nx, ny, ignoreDoors)) continue;
      const d = field[ny * MW + nx];
      if (d >= 0 && d < bd) {
        bd = d;
        best = [nx, ny];
      }
    }
    return best;
  }

  private doorCenter(d: Door): [number, number] {
    const [a, b] = [d.tiles[0], d.tiles[d.tiles.length - 1]];
    return [((a[0] + b[0]) / 2) * TS + 4, ((a[1] + b[1]) / 2) * TS + 4];
  }

  private door(id: DoorId): Door {
    return this.doors.find((d) => d.id === id)!;
  }

  private openDoor(id: DoorId): void {
    const d = this.door(id);
    if (d.open) return;
    d.open = true;
    this.c.chip.noise(0.5, 0.18, 900, 0.8);
    this.c.chip.beep(140, 0.4, 0.06, 'sawtooth', 220);
    this.vdistT = 0;
  }

  private seal(d: Door): void {
    d.open = false;
    this.sealed.add(d.id);
    const { chip } = this.c;
    chip.noise(0.25, 0.7, 260, 1);
    chip.beep(70, 0.3, 0.3, 'square', 38);
    this.flash = 0.08;
    this.c.chip.noise(0.05, 0.3, 4000, 2, 0.32);
    this.vdistT = 0;
    // Cain points somewhere else; when there is nowhere else, KNOT opens the bay.
    this.obj = null;
    if (this.sealed.has('lift') && this.sealed.has('stairs')) {
      this.at(1, () => this.radio(2.6));
      this.at(4.2, () => this.openBay());
    } else {
      const next = d.id === 'lift' ? 'stairs' : 'lift';
      this.at(0.8, () => {
        this.radio(1.8);
        this.obj = next;
      });
    }
  }

  private openBay(): void {
    if (this.door('bay').open) return;
    this.openDoor('bay');
    this.obj = 'heat';
  }

  // ------------------------------------------------------------- update

  update(dt: number): void {
    this.t += dt;
    this.pt += dt;
    this.glitch = Math.max(0, this.glitch - dt);
    this.flash = Math.max(0, this.flash - dt);
    this.tickTimers(dt);
    this.tickMusic(dt);
    switch (this.phase) {
      case 'intro':
        this.amb = Math.max(-29.9, -29.6 - this.t * 0.01);
        this.walkVictor(dt, 30);
        // The door opens before he asks. The signal pings from D-4.
        if (!this.door('knot').open && Math.hypot(this.x - 4.5 * TS - 4, this.y - 6 * TS - 4) < 24) this.openDoor('knot');
        this.pingT -= dt;
        if (this.pingT <= 0) {
          this.pingT = 2.2;
          this.c.chip.beep(1320, 0.14, 0.04, 'sine', 1290);
        }
        if (Math.hypot(this.x - COAT_AT.x, this.y - COAT_AT.y) < 7) this.takeCoat();
        break;
      case 'coat':
        this.amb = Math.max(-29.99, this.amb - dt * 0.01);
        break;
      case 'chase':
        this.chase(dt);
        break;
      case 'bay':
        this.bay(dt);
        break;
      case 'inside':
        this.inside(dt);
        break;
      case 'locks':
        this.locks(dt);
        break;
      case 'after':
        if (this.pt > 9.6) this.scare();
        break;
      case 'scare':
        if (this.pt > 0.75) {
          this.toPhase('black');
          this.c.chip.hush();
        }
        break;
      case 'black':
        if (this.pt > 1.4) this.done = true;
        break;
    }
  }

  private walkVictor(dt: number, speed: number): void {
    const { pad } = this.c;
    let mx = pad.axis('left', 'right');
    let my = pad.axis('up', 'down');
    if (mx && my) {
      mx *= 0.71;
      my *= 0.71;
    }
    if (mx) this.face = mx;
    if (mx || my) {
      this.move(mx * speed * dt, my * speed * dt);
      this.walk += dt;
      this.stepT -= dt;
      if (this.stepT <= 0) {
        this.stepT = this.collapsed ? 0.6 : 0.3;
        this.c.chip.noise(0.025, 0.05, 1400, 2);
      }
    }
  }

  private takeCoat(): void {
    this.toPhase('coat');
    this.hasCoat = true;
    this.obj = null;
    // The music box stops while he holds it. Cain says something. Then -30.
    this.mbOn = false;
    this.c.chip.noise(0.3, 0.08, 700, 0.6);
    this.at(1.8, () => this.radio(2.6));
    this.at(5.4, () => this.lockdown());
  }

  /** Below -30: the lights go red, KNOT locks the level and starts counting. */
  private lockdown(): void {
    const { chip } = this.c;
    this.toPhase('chase');
    this.amb = -30;
    this.red = 1;
    this.mbOn = true;
    this.mbSkip = 0.1;
    chip.beep(55, 1.4, 0.3, 'sawtooth', 40);
    chip.noise(0.6, 0.3, 300, 0.7);
    this.wind = chip.drone(0, 0.03, 'sawtooth', 420);
    for (let i = 0; i < 7; i++) {
      chip.beep(392, 0.42, 0.05, 'sawtooth', 330, 0.6 + i * 0.95);
    }
    this.openDoor('d4');
    this.units[0].wake = this.t + 3;
    this.units[1].wake = this.t + 4;
    for (const u of this.units.slice(2)) u.wake = this.t + 14;
    const spawn = (label: string, child: boolean, near: boolean) => () => {
      this.persons++;
      chip.noise(0.15, 0.25, 3000, 1);
      chip.beep(1200, 0.05, 0.05, 'square');
      this.glitch = 0.15;
      const a = Math.random() * Math.PI * 2;
      const g: Ghost = near
        ? { x: COAT_AT.x, y: COAT_AT.y - 4, label, child, on: 0 }
        : { x: this.x + Math.cos(a) * 90, y: this.y + Math.sin(a) * 70, label, child, on: 0 };
      if (child) this.milo = g;
      else this.ghosts.push(g);
    };
    // KNOT counts four more people on the level.
    this.at(2.2, spawn('M.A.', true, true));
    this.at(3.4, spawn('E.A.', false, false));
    this.at(4.4, spawn('?', false, false));
    this.at(5.2, spawn('?', false, false));
    this.at(6.4, () => {
      this.radio(2);
      this.obj = 'lift';
    });
  }

  private chase(dt: number): void {
    const { chip } = this.c;
    const coldness = Math.min(1, this.pt / 70);
    this.amb = -30 - coldness * 1.4;
    this.mbTempo = 0.75 - coldness * 0.3;
    this.mbPitch = 0.97 - coldness * 0.05;
    this.mbSkip = 0.12 + coldness * 0.25;
    this.red = Math.max(0.35, this.red - dt * 0.2);
    this.hurt = Math.max(0, this.hurt - dt);
    // The cold.
    const nearHeat = this.door('bay').open && Math.hypot(this.x - HUSK_AT.x, this.y - HUSK_AT.y) < 70;
    this.body += dt * (nearHeat ? 0.04 : -(0.035 + this.sealed.size * 0.008));
    if (!this.collapsed && this.body <= 30.5) {
      this.collapsed = true;
      this.obj = 'heat';
    }
    if (!this.door('bay').open && !this.bayCalled && (this.body <= 32.5 || this.collapsed)) {
      this.bayCalled = true;
      this.at(1.2, () => this.openBay());
    }
    // Victor.
    if (this.collapsed) this.crawlToBay(dt);
    else if (this.hurt < 1.5) this.walkVictor(dt, this.body <= 32 ? 18 : 34);
    // Every way out closes just before he gets there.
    for (const d of this.doors) {
      if (!d.open || (d.id !== 'lift' && d.id !== 'stairs')) continue;
      const [cx, cy] = this.doorCenter(d);
      const dist = Math.hypot(this.x - cx, this.y - cy);
      if (dist < 30 && dist > 9) this.seal(d);
    }
    if (!this.door('bay').open && !this.notYet && Math.hypot(this.x - 37 * TS - 4, this.y - 25 * TS) < 22) {
      this.notYet = true;
      chip.beep(160, 0.3, 0.12, 'square', 120);
    }
    // The K-units follow a fresh map of how far everything is from him.
    this.vdistT -= dt;
    if (this.vdistT <= 0) {
      this.vdistT = 0.25;
      this.vdist = this.bfs(Math.floor(this.x / TS), Math.floor(this.y / TS));
    }
    const kSpeed = 17 + this.sealed.size * 4 + coldness * 4;
    for (const u of this.units) {
      if (!u.awake) {
        if (this.t >= u.wake || (u.wake < Infinity && this.x > 12 * TS && this.phase === 'chase' && this.pt > 4)) {
          u.awake = true;
          chip.beep(180, 0.25, 0.08, 'square', 360);
        }
        continue;
      }
      u.stun -= dt;
      if (u.stun > 0) continue;
      const gx = u.tx * TS + 4;
      const gy = u.ty * TS + 4;
      const d = Math.hypot(gx - u.x, gy - u.y);
      if (d < 0.6) {
        const next = this.downhill(this.vdist, u.tx, u.ty);
        if (next) [u.tx, u.ty] = next;
      } else {
        const step = Math.min(d, kSpeed * dt);
        u.x += ((gx - u.x) / d) * step;
        u.y += ((gy - u.y) / d) * step;
        if (Math.random() < dt * 3 && Math.hypot(u.x - this.x, u.y - this.y) < 90) chip.noise(0.03, 0.06, 500, 2);
      }
      // Caught: shoved and colder. The rest of the pack waits a moment.
      if (!this.collapsed && this.hurt <= 0 && Math.hypot(u.x - this.x, u.y - this.y) < 7) {
        const a = Math.atan2(this.y - u.y, this.x - u.x);
        for (let i = 0; i < 6; i++) this.move(Math.cos(a) * 2, Math.sin(a) * 2);
        this.body = Math.max(29.6, this.body - 0.6);
        this.hurt = 2;
        for (const o of this.units) if (Math.hypot(o.x - this.x, o.y - this.y) < 26) o.stun = 2;
        this.flash = 0.1;
        chip.noise(0.2, 0.6, 400, 1);
        chip.beep(90, 0.2, 0.25, 'square', 50);
      }
    }
    // The people who are not there: they drift through walls towards him.
    for (const g of this.ghosts) {
      g.on = Math.min(1, g.on + dt);
      const d = Math.hypot(this.x - g.x, this.y - g.y);
      const sp = 7 + this.sealed.size * 2 + coldness * 3;
      if (d > 0.1) {
        g.x += ((this.x - g.x) / d) * sp * dt;
        g.y += ((this.y - g.y) / d) * sp * dt;
      }
      if (d < 6 && !this.collapsed) {
        this.glitch = 0.45;
        this.body = Math.max(29.6, this.body - 0.3);
        chip.noise(0.4, 0.4, 3200, 0.6);
        const a = Math.random() * Math.PI * 2;
        g.x = this.x + Math.cos(a) * 100;
        g.y = this.y + Math.sin(a) * 80;
        g.on = 0;
      }
    }
    // Milo's box does not chase. It goes ahead, towards the bay.
    if (this.milo) {
      const m = this.milo;
      m.on = Math.min(1, m.on + dt);
      let tx = Math.floor(this.x / TS);
      let ty = Math.floor(this.y / TS);
      for (let i = 0; i < 6; i++) {
        const n = this.downhill(this.bayDist, tx, ty, true);
        if (!n) break;
        [tx, ty] = n;
      }
      const gx = tx * TS + 4;
      const gy = ty * TS + 2;
      const d = Math.hypot(gx - m.x, gy - m.y);
      if (d > 0.5) {
        const step = Math.min(d, 26 * dt);
        m.x += ((gx - m.x) / d) * step;
        m.y += ((gy - m.y) / d) * step;
      }
    }
    // Heartbeat.
    const near = Math.min(...this.units.filter((u) => u.awake).map((u) => Math.hypot(u.x - this.x, u.y - this.y)), 999);
    this.heart(dt, 96 + (36.6 - this.body) * 14 + (near < 40 ? 30 : 0), 0.22);
    // Into the bay.
    if (Math.floor(this.x / TS) >= 38 && this.y > 21 * TS) this.enterBay();
  }

  private crawlToBay(dt: number): void {
    if (!this.door('bay').open) return;
    if (!this.crawlDist) this.crawlDist = this.bfs(41, 24);
    const n = this.downhill(this.crawlDist, Math.floor(this.x / TS), Math.floor(this.y / TS));
    if (!n) return;
    const gx = n[0] * TS + 4;
    const gy = n[1] * TS + 4;
    const d = Math.hypot(gx - this.x, gy - this.y);
    if (d > 0.1) {
      this.x += ((gx - this.x) / d) * 12 * dt;
      this.y += ((gy - this.y) / d) * 12 * dt;
      this.face = gx >= this.x ? 1 : -1;
    }
  }

  private heart(dt: number, bpm: number, vol: number): void {
    this.heartT -= dt;
    if (this.heartT > 0) return;
    this.heartT = 60 / Math.max(40, bpm);
    this.c.chip.beep(62, 0.1, vol, 'sine', 40);
    this.c.chip.beep(55, 0.1, vol * 0.6, 'sine', 38, 0.16);
  }

  private enterBay(): void {
    const { chip } = this.c;
    this.toPhase('bay');
    this.timers = [];
    this.mbOn = false;
    this.red = 0;
    this.bx = 6;
    this.wind?.set(420, 0.015);
    this.heater = chip.drone(80, 0.045, 'triangle', 300);
    // Warmer in here: they stop at the door. Then Cain pulls the plug on The Well.
    this.at(4.4, () => this.radio(1.4));
    this.at(6.4, () => {
      this.shutdown = true;
      this.heater?.stop();
      this.heater = null;
      chip.beep(120, 1.6, 0.12, 'sawtooth', 30);
      chip.noise(0.8, 0.2, 200, 0.5);
    });
  }

  private bay(dt: number): void {
    const { pad, chip } = this.c;
    if (this.pt < 1) this.bx = Math.min(54, this.bx + dt * 48);
    else {
      const mx = pad.axis('left', 'right');
      if (mx) this.face = mx;
      this.bx = Math.max(24, Math.min(HUSK_X - 6, this.bx + mx * 30 * dt));
      if (mx) {
        this.walk += dt;
        this.stepT -= dt;
        if (this.stepT <= 0) {
          this.stepT = 0.3;
          chip.noise(0.025, 0.05, 1400, 2);
        }
      }
    }
    if (this.shutdown) this.bayTemp = Math.max(-29.55, this.bayTemp - dt * 0.085);
    // The cold comes in from the door, and they come with it.
    const k = Math.min(1, (-28.6 - this.bayTemp) / 0.9);
    this.front = BAY_FROST0 + k * (HUSK_X - 30 - BAY_FROST0);
    if (k > 0.05 && !this.warned) {
      this.warned = true;
      // The frame chimes: heater ready.
      chip.beep(523, 0.18, 0.07, 'triangle');
      chip.beep(784, 0.3, 0.07, 'triangle', undefined, 0.2);
    }
    if (this.bx < this.front + 14) {
      this.bx = this.front + 14;
      if (this.shutdown) this.glitch = Math.max(this.glitch, 0.15);
    }
    this.heart(dt, 110 + k * 50, 0.2);
    const atFrame = this.bx > HUSK_X - 20;
    if ((atFrame && pad.hit('up')) || k >= 1) this.climbIn();
  }

  private climbIn(): void {
    const { chip } = this.c;
    this.toPhase('inside');
    chip.noise(0.3, 0.4, 600, 1);
    chip.beep(523, 0.3, 0.08, 'triangle', 784);
    this.heater = chip.drone(90, 0.05, 'triangle', 320);
    this.mbOn = true;
    this.mbI = 0;
    this.mbClock = 0;
    this.mbNext = 1.2;
    this.mbTempo = 0.62;
    this.mbPitch = 1;
    this.mbSkip = 0;
    this.bpm = 120;
  }

  private inside(dt: number): void {
    const { chip } = this.c;
    // 14 seconds from wherever the bay was down to -30.
    const start = this.bayTemp;
    this.amb = start + (-30 - start) * Math.min(1, this.pt / 15);
    this.miloP = Math.max(0, Math.min(1, (this.pt - 6) / 7));
    this.match = Math.round(12 + Math.min(1, Math.max(0, (this.pt - 7) / 6.5)) * 59);
    this.bpm = Math.max(78, 120 - this.pt * 4);
    this.pulse(dt);
    if (this.pt >= 15) {
      this.toPhase('locks');
      this.mbOn = false;
      this.heater?.stop();
      this.heater = null;
      chip.beep(1400, 0.06, 0.06, 'square');
      chip.beep(1400, 0.06, 0.06, 'square', undefined, 0.15);
    }
  }

  /** The visor's heart monitor: a tick per beat. */
  private pulse(dt: number): void {
    this.heartT -= dt;
    if (this.heartT > 0) return;
    this.heartT = 60 / this.bpm;
    this.beats.push(this.t);
    if (this.beats.length > 40) this.beats.shift();
    this.c.chip.beep(1000, 0.05, 0.03, 'sine');
  }

  private locks(dt: number): void {
    const { chip } = this.c;
    const lt = this.pt - 3.4;
    if (this.deadAt < 0) {
      this.bpm = 150;
      this.pulse(dt);
    }
    while (this.clacks < CLACKS.length && lt >= CLACKS[this.clacks]) {
      this.clacks++;
      chip.noise(0.12, 0.8, 700, 1.2);
      chip.beep(90, 0.1, 0.35, 'square', 45);
      chip.noise(0.05, 0.5, 3500, 2);
      this.flash = 0.14;
      this.beats.push(this.t, this.t + 0.07);
      this.addCrack();
    }
    if (this.clacks >= CLACKS.length && this.deadAt < 0 && lt > CLACKS[CLACKS.length - 1] + 0.7) {
      this.deadAt = this.t;
      chip.beep(1000, 3, 0.05, 'sine');
    }
    if (this.deadAt >= 0 && this.t - this.deadAt > 3.6) this.toAfter();
  }

  private addCrack(): void {
    let x = 20 + Math.random() * 150;
    let y = 16 + Math.random() * 86;
    const pts: [number, number][] = [[x, y]];
    let a = Math.random() * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      a += (Math.random() - 0.5) * 1.4;
      x += Math.cos(a) * (6 + Math.random() * 12);
      y += Math.sin(a) * (6 + Math.random() * 12);
      pts.push([x, y]);
    }
    this.cracks.push(pts);
  }

  private toAfter(): void {
    this.toPhase('after');
    this.wind?.set(420, 0.02);
    // Two left on the level. Cain calls, twice.
    this.at(1.2, () => {
      this.persons = 2;
      this.c.chip.beep(1200, 0.05, 0.05, 'square');
    });
    this.at(3, () => this.radio(2.2));
    this.at(6.4, () => this.radio(1));
  }

  private scare(): void {
    const { chip } = this.c;
    this.toPhase('scare');
    chip.noise(0.9, 0.9, 900, 0.4);
    chip.beep(55, 0.9, 0.35, 'sawtooth', 30);
    chip.beep(233, 0.7, 0.2, 'square', 90);
  }

  private tickMusic(dt: number): void {
    if (!this.mbOn) return;
    this.mbClock += dt;
    while (this.mbClock >= this.mbNext) {
      const [n, beats] = SONG[this.mbI++ % SONG.length];
      if (n && Math.random() >= this.mbSkip) {
        const f = hz(n) * this.mbPitch;
        this.c.chip.beep(f, 0.9, 0.045, 'triangle');
        this.c.chip.beep(f * 2, 0.3, 0.012, 'sine');
      }
      this.mbNext += (beats * 0.3) / this.mbTempo;
    }
  }

  // ------------------------------------------------------------- draw

  draw(s: Screen): void {
    switch (this.phase) {
      case 'intro':
      case 'coat':
      case 'chase':
        this.drawMap(s);
        break;
      case 'bay':
        this.drawBay(s);
        break;
      case 'inside':
      case 'locks':
        this.drawVisor(s);
        break;
      case 'after':
        this.drawAfter(s);
        break;
      case 'scare':
        this.drawScare(s);
        break;
      case 'black':
        s.clear('#000');
        return;
    }
    if (this.flash > 0) s.tint(this.phase === 'locks' ? '#ff0000' : '#ffffff', 0.5);
    if (this.glitch > 0) this.drawGlitch(s);
  }

  private drawMap(s: Screen): void {
    const camX = Math.max(0, Math.min(MW * TS - W, Math.round(this.x - W / 2)));
    const camY = Math.max(-HUD, Math.min(MH * TS - H, Math.round(this.y - (H + HUD) / 2)));
    s.clear('#050608');
    const tx0 = Math.floor(camX / TS);
    const ty0 = Math.max(0, Math.floor(camY / TS));
    for (let ty = ty0; ty <= Math.min(MH - 1, ty0 + H / TS + 1); ty++) {
      for (let tx = tx0; tx <= Math.min(MW - 1, tx0 + W / TS + 1); tx++) {
        const px = tx * TS - camX;
        const py = ty * TS - camY;
        const v = this.grid[ty * MW + tx];
        const d = this.doorAt.get(ty * MW + tx);
        if (v === 1) {
          const face = ty + 1 < MH && this.grid[(ty + 1) * MW + tx] !== 1;
          s.rect(px, py, TS, TS, face ? '#2a2f37' : '#0b0d10');
          if (face) {
            s.rect(px, py, TS, 1, '#3a404a');
            s.rect(px, py + TS - 1, TS, 1, '#1a1d22');
          }
        } else if (v === 2) {
          s.rect(px, py, TS, TS, '#0c1a12');
          for (let r = 1; r < 6; r += 2) s.rect(px + 1, py + r, Math.floor(2 + ((tx * 7 + r + this.t * 6) % 5)), 1, this.phase === 'intro' ? '#4aff80' : '#ff5050');
        } else {
          s.rect(px, py, TS, TS, (tx + ty) % 2 ? '#16191e' : '#181b20');
          if (tx % 4 === 0 && ty % 4 === 0) s.rect(px, py, 1, 1, '#22262c');
        }
        if (d) {
          if (d.open) {
            s.rect(px, py, 1, TS, '#3a404a');
            s.rect(px + TS - 1, py, 1, TS, '#3a404a');
          } else {
            s.rect(px, py, TS, TS, '#4a4e56');
            for (let i = 0; i < TS; i += 4) s.rect(px + i, py + ((i / 4) % 2) * 2, 2, TS - 2, '#c8a020');
            s.frame(px, py, TS, TS, '#1a1a1a');
          }
        }
      }
    }
    // The lift doors and the stairs.
    s.rect(39 * TS - camX, 0 - camY + 3, 3 * TS, TS - 3, '#5a5e66');
    s.rect(40 * TS + 3 - camX, 0 - camY + 3, 1, TS - 3, '#1a1a1a');
    for (let i = 0; i < 6; i++) s.rect(37 * TS - camX, (8 + i) * TS + 2 - camY, 5 * TS, 2, '#262a30');
    // The coat, the LANTERN, the HUSK.
    if (!this.hasCoat) s.draw(COAT, COAT_AT.x - 3 - camX, COAT_AT.y - 3 - camY);
    s.draw(LANTERN, LANTERN_AT.x - 3 - camX, LANTERN_AT.y - camY);
    this.drawHuskTop(s, HUSK_AT.x - camX, HUSK_AT.y - camY);
    for (const u of this.units) s.draw(K_TOP, u.x - 4 - camX, u.y - 4 - camY);
    this.drawVictorTop(s, this.x - camX, this.y - camY);
    // Darkness with holes for every light.
    this.drawDark(s, camX, camY);
    if (this.red > 0) s.tint('#ff1010', this.red * (0.1 + 0.07 * Math.sin(this.t * 4)));
    // Over the dark: eyes, signs, and the data overlay.
    for (const u of this.units) {
      const ex = u.x - 4 - camX;
      const ey = u.y - 4 - camY;
      const eye = !u.awake ? '#202020' : u.stun > 0 ? '#ff4040' : '#e8f0ff';
      s.rect(ex + 2, ey + 2, 1, 1, eye);
      s.rect(ex + 5, ey + 2, 1, 1, eye);
    }
    if (this.phase === 'chase') {
      this.dataBox(s, HUSK_AT.x - camX, HUSK_AT.y + 4 - camY, 9, 15, 'V.A.', '', 1);
      for (const g of this.ghosts) this.dataBox(s, g.x - camX, g.y + 3 - camY, 7, 13, g.label, '', g.on);
      if (this.milo) this.dataBox(s, this.milo.x - camX, this.milo.y + 3 - camY, 5, 9, this.milo.label, '', this.milo.on);
    }
    this.drawArrow(s, camX, camY);
    this.drawHud(s);
  }

  /** Status without words: temperature, a figure per person KNOT counts, body heat, the radio. */
  private drawHud(s: Screen): void {
    const cold = this.amb <= -30;
    s.rect(0, 0, W, HUD, '#000');
    s.rect(0, HUD - 1, W, 1, '#1e2a22');
    s.rect(3, 1, 1, 5, '#5a6a7a');
    s.rect(2, 5, 3, 3, cold ? '#ff5050' : '#9fd3ff');
    s.text(`${this.amb.toFixed(1)}°`, 8, 2, cold ? '#ff5050' : '#9fd3ff');
    const n = this.persons;
    const x0 = Math.round(W / 2 - n * 3);
    for (let i = 0; i < n; i++) {
      // The ones KNOT added flicker.
      if (i >= 3 && Math.random() < 0.08) continue;
      const c = i >= 3 ? DATA : '#7dffa0';
      const px = x0 + i * 6;
      s.rect(px + 1, 1, 2, 2, c);
      s.rect(px, 3, 4, 3, c);
      s.rect(px, 6, 1, 2, c);
      s.rect(px + 3, 6, 1, 2, c);
    }
    const k = Math.max(0, Math.min(1, (this.body - 29.6) / 7));
    s.frame(W - 34, 2, 31, 5, '#3a3a3a');
    s.rect(W - 33, 3, Math.round(29 * k), 3, k > 0.45 ? '#e8e8e8' : '#6a9aff');
    if (this.radioT > 0) this.drawRadio(s, W - 48, 2);
  }

  /** A little radio set with its waves going. */
  private drawRadio(s: Screen, x: number, y: number): void {
    s.rect(x, y + 2, 6, 4, '#ffc860');
    s.rect(x + 1, y + 3, 2, 2, '#000');
    s.rect(x + 4, y, 1, 2, '#ffc860');
    const w = Math.floor(this.t * 8) % 3;
    for (let i = 0; i <= w; i++) s.rect(x + 8 + i * 2, y + 3 - i, 1, 2 + i * 2, '#ffc860');
  }

  private drawVictorTop(s: Screen, sx: number, sy: number): void {
    if (this.collapsed) {
      s.draw(VIC_CRAWL, sx - 5, sy - 2, this.face < 0);
      return;
    }
    const f = this.walk > 0 && Math.floor(this.walk * 6) % 2 ? 1 : 0;
    const shake = this.hurt > 1.5 ? Math.round((Math.random() - 0.5) * 2) : 0;
    s.draw(VIC[f], sx - 3 + shake, sy - 6, this.face < 0);
    if (this.hasCoat) s.rect(sx + (this.face < 0 ? -4 : 3), sy - 1, 2, 3, BLUE);
  }

  private drawHuskTop(s: Screen, sx: number, sy: number): void {
    s.rect(sx - 5, sy - 6, 10, 12, '#5a5e66');
    s.frame(sx - 5, sy - 6, 10, 12, '#3a3e44');
    s.rect(sx - 7, sy - 4, 2, 9, '#4a4e56');
    s.rect(sx + 5, sy - 4, 2, 9, '#4a4e56');
    s.rect(sx - 3, sy - 3, 6, 6, this.door('bay').open ? '#ff8a30' : '#3a1a0a');
  }

  /** A dashed person-sized box with KNOT's label over it (drawn over the dark). */
  private dataBox(s: Screen, cx: number, footY: number, w: number, h: number, label: string, sub: string, on: number): void {
    if (on <= 0) return;
    if (on < 1 && Math.random() > on) return;
    const x = Math.round(cx - w / 2);
    const y = Math.round(footY - h);
    const c = Math.random() < 0.06 ? '#ffffff' : DATA;
    const ph = Math.floor(this.t * 8) % 2;
    for (let i = ph; i < w; i += 2) {
      s.rect(x + i, y, 1, 1, c);
      s.rect(x + i, y + h - 1, 1, 1, c);
    }
    for (let j = ph; j < h; j += 2) {
      s.rect(x, y + j, 1, 1, c);
      s.rect(x + w - 1, y + j, 1, 1, c);
    }
    s.text(label, cx, y - (sub ? 13 : 7), c, 1, 'center');
    if (sub) s.text(sub, cx, y - 7, c, 1, 'center');
  }

  private drawDark(s: Screen, camX: number, camY: number): void {
    const g = this.dark.getContext('2d')!;
    const dw = this.dark.width;
    const dh = this.dark.height;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, dw, dh);
    g.fillStyle = `rgba(2,3,5,${this.phase === 'intro' || this.phase === 'coat' ? 0.82 : 0.93})`;
    g.fillRect(0, 0, dw, dh);
    g.globalCompositeOperation = 'destination-out';
    const hole = (x: number, y: number, r: number, a = 1) => {
      const px = (x - camX) / 2;
      const py = (y - camY) / 2;
      if (px < -r || py < -r || px > dw + r || py > dh + r) return;
      const grd = g.createRadialGradient(px, py, 0, px, py, r / 2);
      grd.addColorStop(0, `rgba(0,0,0,${a})`);
      grd.addColorStop(0.6, `rgba(0,0,0,${a * 0.6})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(px - r / 2, py - r / 2, r, r);
    };
    const flick = 1 - (Math.random() < 0.04 ? 0.4 : 0);
    hole(this.x, this.y - 2, (this.phase === 'chase' ? 40 : 50) * flick);
    if (this.phase === 'intro' || this.phase === 'coat') hole(5 * TS, 2 * TS, 60, 0.7);
    for (const u of this.units) if (u.awake) hole(u.x, u.y, 18, 0.6);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    if (this.phase === 'chase') for (const [lx, ly] of LAMPS) hole(lx * TS + 4, ly * TS + 4, 28 + pulse * 10, 0.5);
    // LANTERN watches the lift door.
    hole(37 * TS + 4, 2 * TS, 34, 0.9);
    hole(LANTERN_AT.x, LANTERN_AT.y + 2, 16, 0.8);
    if (this.door('bay').open) hole(HUSK_AT.x, HUSK_AT.y, 70, 0.9);
    g.globalCompositeOperation = 'source-over';
    // Pixelated darkness: the half-size canvas, scaled up without smoothing.
    s.g.imageSmoothingEnabled = false;
    s.g.drawImage(this.dark, 0, 0, W, H);
    // The LANTERN's beam is yellow.
    s.g.globalAlpha = 0.12;
    s.g.fillStyle = '#ffd040';
    s.g.beginPath();
    s.g.moveTo(LANTERN_AT.x - camX, LANTERN_AT.y + 2 - camY);
    s.g.lineTo(37 * TS - camX, 1 * TS - camY);
    s.g.lineTo(37 * TS - camX, 3 * TS - camY);
    s.g.fill();
    s.g.globalAlpha = 1;
  }

  /** Three dots from Victor towards whatever he is meant to be going to. */
  private drawArrow(s: Screen, camX: number, camY: number): void {
    let target: [number, number] | null = null;
    if (this.obj === 'coat') target = [COAT_AT.x, COAT_AT.y];
    else if (this.obj === 'lift') target = this.doorCenter(this.door('lift'));
    else if (this.obj === 'stairs') target = this.doorCenter(this.door('stairs'));
    else if (this.obj === 'heat') target = [HUSK_AT.x, HUSK_AT.y];
    if (!target || Math.floor(this.t * 3) % 3 === 0) return;
    const a = Math.atan2(target[1] - this.y, target[0] - this.x);
    if (Math.hypot(target[0] - this.x, target[1] - this.y) < 24) return;
    for (const r of [12, 16, 20]) s.rect(this.x + Math.cos(a) * r - camX, this.y - 2 + Math.sin(a) * r - camY, 1, 1, '#ffd040');
  }

  private drawGlitch(s: Screen): void {
    const g = s.g;
    for (let i = 0; i < 6; i++) {
      const y = Math.floor(Math.random() * H);
      const h = 1 + Math.floor(Math.random() * 5);
      g.drawImage(s.canvas, 0, y, W, h, Math.round((Math.random() - 0.5) * 16), y, W, h);
    }
    s.noise(this.glitch * 1.5, DATA);
  }

  /** The bay from the side: door on the left, the frame on the right. */
  private drawBayRoom(s: Screen, lit: number): void {
    s.clear('#12161c');
    for (let x = 0; x < W; x += 24) s.rect(x, 0, 1, FLOOR, '#0e1116');
    s.rect(0, 14, W, 1, '#1a1f26');
    s.rect(0, FLOOR, W, H - FLOOR, '#1c2026');
    s.rect(0, FLOOR, W, 1, '#3a404a');
    // The doorway: red light beyond.
    s.rect(0, 30, 22, FLOOR - 30, '#200808');
    s.rect(0, 30, 22, 2, '#4a1010');
    s.rect(22, 26, 3, FLOOR - 26, '#3a3e44');
    // Ceiling light.
    s.rect(70, 0, 30, 3, lit > 0.5 ? '#c8d0d8' : '#2a2e34');
    if (lit > 0.5) s.tint('#c8d0ff', 0.04);
  }

  private drawHuskSide(s: Screen, open: boolean, heater: number, eye: string): void {
    const x = HUSK_X;
    const y = 30;
    const grey = '#6a6e74';
    const dark = '#3a3e44';
    const light = '#8a8e94';
    s.rect(x + 15, 0, 4, y - 6, dark);
    s.rect(x + 4, y - 7, 26, 5, dark);
    if (heater > 0) {
      const g = s.g;
      const grd = g.createRadialGradient(x + 17, y + 32, 2, x + 17, y + 32, 46);
      grd.addColorStop(0, `rgba(255,130,40,${0.35 * heater})`);
      grd.addColorStop(1, 'rgba(255,130,40,0)');
      g.fillStyle = grd;
      g.fillRect(x - 30, y - 14, 94, 92);
    }
    s.rect(x + 8, y, 18, 14, grey);
    s.rect(x + 8, y, 18, 2, light);
    s.rect(x + 10, y + 6, 14, 3, '#101010');
    s.rect(x + 12, y + 6, 3, 3, eye);
    s.rect(x + 19, y + 6, 3, 3, eye);
    s.rect(x + 14, y + 14, 6, 3, dark);
    s.rect(x + 2, y + 17, 30, 30, grey);
    s.frame(x + 2, y + 17, 30, 30, dark);
    if (open) {
      s.rect(x + 7, y + 21, 20, 22, '#140a06');
      for (let i = 0; i < 4; i++) s.rect(x + 9, y + 24 + i * 5, 16, 1, heater > 0 ? '#ff8a30' : '#4a2a10');
    } else {
      s.rect(x + 6, y + 21, 22, 22, light);
      s.frame(x + 6, y + 21, 22, 22, dark);
      s.rect(x + 9, y + 25, 16, 8, '#081008');
      s.text('1', x + 17, y + 27, '#60ff80', 1, 'center');
      for (let i = 0; i < this.clacks; i++) s.rect(x + 1, y + 35 + i * 2, 32, 1, '#c8c8c8');
    }
    s.rect(x - 5, y + 18, 7, 34, grey);
    s.rect(x + 32, y + 18, 7, 34, grey);
    s.rect(x - 5, y + 34, 7, 2, dark);
    s.rect(x + 32, y + 34, 7, 2, dark);
    s.rect(x + 6, y + 48, 9, FLOOR - y - 48, grey);
    s.rect(x + 19, y + 48, 9, FLOOR - y - 48, grey);
    for (const ly of [y + 58, y + 70]) {
      s.rect(x + 5, ly, 11, 2, dark);
      s.rect(x + 18, ly, 11, 2, dark);
    }
  }

  private drawBay(s: Screen): void {
    const lit = this.shutdown ? 0 : 1;
    this.drawBayRoom(s, lit);
    // Frost from the door to the front.
    for (const f of this.frost) if (f.x < this.front + 8 * f.k && f.y < FLOOR + 30) s.rect(f.x, f.y, 1, 1, f.k > 0.5 ? '#d8ecff' : '#7a90a8');
    s.g.globalAlpha = 0.18;
    s.g.fillStyle = '#9fd3ff';
    s.g.fillRect(0, 0, this.front, H);
    s.g.globalAlpha = 1;
    this.drawHuskSide(s, true, lit ? 0.6 : 0.9, '#1a1a1a');
    // What came after him: K-units and KNOT's boxes, held at the cold line.
    const cast: [string, number, number][] = [['K', 4, 0], ['M.A.', 0, 36], ['K', 16, 0], ['E.A.', 22, 46], ['K', 30, 0], ['?', 38, 56]];
    for (const [who, off, ly] of cast) {
      const x = this.front - off;
      if (x < -16) continue;
      if (who === 'K') {
        s.draw(K_SIDE, x - 8, FLOOR - 24, false, 2);
      } else {
        const child = who === 'M.A.';
        const w = child ? 9 : 12;
        const h = child ? 20 : 30;
        this.dataBox(s, x, FLOOR, w, h, '', '', 1);
        s.text(who, Math.max(25, x), ly, DATA, 1, 'center');
        s.rect(x, ly + 6, 1, FLOOR - h - ly - 6, '#3a5a6a');
      }
    }
    // Victor.
    const f = this.walk > 0 && Math.floor(this.walk * 6) % 2 ? 1 : 0;
    s.draw(VIC_SIDE[f], this.bx - 7, FLOOR - 28, this.face < 0, 2);
    s.rect(this.bx + (this.face < 0 ? -9 : 5), FLOOR - 10, 4, 6, BLUE);
    if (this.shutdown) s.tint('#000010', 0.35);
    // A chevron over the open chest.
    if (this.bx > HUSK_X - 20 && Math.floor(this.t * 3) % 2) for (let i = 0; i < 3; i++) s.rect(HUSK_X + 17 - i, 20 + i, 1 + i * 2, 1, '#ffb040');
    this.amb = this.bayTemp;
    this.drawHud(s);
  }

  /** From inside the frame: the visor, the room, the monitor. */
  private drawVisor(s: Screen): void {
    s.clear('#000');
    const x0 = 12;
    const y0 = 12;
    const vw = 168;
    const vh = 92;
    s.g.save();
    s.g.beginPath();
    s.g.rect(x0, y0, vw, vh);
    s.g.clip();
    // The bay, looking back at the door.
    s.rect(x0, y0, vw, 52, '#10141a');
    s.rect(x0, y0 + 52, vw, vh - 52, '#191c22');
    for (let i = -4; i <= 4; i++) s.line(96, y0 + 52, 96 + i * 40, y0 + vh, '#14171c');
    s.rect(82, 30, 28, 34, '#2a0808');
    s.frame(81, 29, 30, 35, '#3a3e44');
    // They wait at the door.
    for (const kx of [64, 118, 132]) s.draw(K_SIDE, kx, 52, false, 1);
    this.dataBox(s, 74, 64, 6, 15, 'E.A.', '', 1);
    this.dataBox(s, 104, 64, 6, 15, '?', '', 1);
    // Milo's box comes in from the door, all the way up to the visor.
    if (this.phase === 'inside' || this.clacks < 3) {
      const p = this.miloP;
      const w = Math.round(5 + p * 22);
      const h = Math.round(9 + p * 44);
      const foot = 64 + p * 38;
      this.dataBox(s, 96, foot, w, h, 'M.A.', `${this.match}%`, 1);
    }
    // Frost at the edges as it nears -30.
    const cold = Math.min(1, Math.max(0, (this.amb + 29) / -1));
    for (const f of this.frost) {
      const edge = Math.min(f.x - x0, x0 + vw - f.x, f.y - y0, y0 + vh - f.y);
      if (edge < 18 * cold * f.k + 1) s.rect(f.x, f.y, 1, 1, '#d8ecff');
    }
    if (this.heater) s.tint('#ff8020', 0.1);
    // Cracks.
    for (const c of this.cracks) for (let i = 1; i < c.length; i++) s.line(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1], '#e8f4ff');
    s.g.restore();
    // The visor rim and HUD.
    s.frame(x0 - 1, y0 - 1, vw + 2, vh + 2, '#3a3e44');
    s.frame(x0 - 2, y0 - 2, vw + 4, vh + 4, '#202328');
    s.text(`${this.amb.toFixed(2)}°`, x0 + 3, y0 + 3, this.amb <= -30 ? '#ff4040' : '#9fd3ff');
    // Heater: three warm bars, cold when it is off.
    for (let i = 0; i < 3; i++) s.rect(x0 + vw - 12 + i * 3, y0 + 3 + ((Math.floor(this.t * 4) + i) % 2), 1, 5, this.heater ? '#ffb040' : '#3a2a1a');
    // The lock: shackle up and green above -30, shut and red below.
    const safe = this.phase === 'inside';
    if (safe || Math.floor(this.t * 4) % 2) {
      const lc = safe ? '#60ff80' : '#ff4040';
      const lx = 92;
      const ly = y0 + vh - 9;
      const up = safe ? 2 : 0;
      s.rect(lx, ly + 3, 8, 5, lc);
      s.rect(lx + 1, ly - up, 1, 3 + up, lc);
      s.rect(lx + 6, ly, 1, 3, lc);
      s.rect(lx + 1, ly - up, 6, 1, lc);
    }
    // Heart monitor along the bottom.
    const my = 124;
    s.rect(8, 110, W - 16, 30, '#020804');
    s.frame(8, 110, W - 16, 30, '#1e3a24');
    let prev = my;
    for (let i = 0; i < W - 20; i++) {
      const tau = this.t - (W - 20 - i) / 60;
      let v = 0;
      if (this.deadAt < 0 || tau < this.deadAt)
        for (const b of this.beats) {
          const d = tau - b;
          if (d >= 0 && d < 0.04) v = -9 * (d / 0.04);
          else if (d >= 0.04 && d < 0.08) v = -9 + 13 * ((d - 0.04) / 0.04);
          else if (d >= 0.08 && d < 0.12) v = 4 - 4 * ((d - 0.08) / 0.04);
        }
      const yv = Math.round(my + v);
      s.line(10 + i, prev, 10 + i, yv, '#60ff80');
      prev = yv;
    }
    if (this.phase === 'locks' && this.flash > 0) s.shake = 7;
  }

  private drawAfter(s: Screen): void {
    this.drawBayRoom(s, 0);
    const eyeOn = this.pt > 8.2;
    this.drawHuskSide(s, false, 0, eyeOn ? (Math.random() < 0.9 ? '#ff9a30' : '#5a2a10') : '#1a1a1a');
    s.draw(COAT, HUSK_X - 14, FLOOR - 6, false, 1);
    s.tint('#000000', 0.55);
    if (eyeOn) {
      s.rect(HUSK_X + 12, 36, 3, 3, '#ff9a30');
      s.rect(HUSK_X + 19, 36, 3, 3, '#ff9a30');
    }
    if (this.pt > 1) this.dataBox(s, HUSK_X + 17, FLOOR + 1, 46, 86, 'V.A.', '', Math.min(1, this.pt - 1));
    this.amb = -30.6;
    this.drawHud(s);
  }

  private drawScare(s: Screen): void {
    s.clear('#000');
    s.shake = 8;
    const grey = '#5a5e64';
    s.rect(30, 4, 132, 136, grey);
    s.rect(30, 4, 132, 6, '#8a8e94');
    s.rect(30, 4, 6, 136, '#3a3e44');
    s.rect(156, 4, 6, 136, '#3a3e44');
    for (const sx of [60, 96, 132]) s.rect(sx, 10, 2, 40, '#3a3e44');
    s.rect(42, 56, 108, 22, '#080808');
    s.rect(58, 60, 24, 14, '#ff9a30');
    s.rect(62, 63, 16, 8, '#fff0c0');
    s.rect(110, 62, 22, 10, '#1a0a04');
    for (let i = 0; i < 6; i++) s.rect(52, 92 + i * 7, 88, 3, '#2a2c30');
    for (const c of this.cracks) for (let i = 1; i < c.length; i++) s.line(c[i - 1][0], c[i - 1][1] + 20, c[i][0], c[i][1] + 20, '#c8d0d8');
    s.noise(0.9, '#ffffff');
    s.text('CAIN.', W / 2, 116, '#ff3020', 3, 'center');
  }
}

export const COLDSTATE_PROGRAM: ProgramInfo = {
  id: 'coldstate',
  title: 'COLD STATE',
  blurb: 'FOLLOW THE SIGNAL. STAY WARM.',
  year: '2010',
  make: (c) => new ColdState(c),
};
