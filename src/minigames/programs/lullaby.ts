import { hz } from '../chip';
import { H, Screen, W, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * MOTHER'S LULLABY (2004). Ivy follows the song down the shaft to The Well: steer
 * left / right, catch the notes, mind the cables. MOTHER watches the whole way down:
 * a red lens that opens and hums at her.
 */

const IVY = sprite(
  ['h.hhhh.h', 'hhhhhhhh', '.hffffh.', '.fefeff.', '.ffffff.', '..fmmf..', '.pppppp.', 'pppppppp', 'fppppppf', '.pppppp.', '.ff..ff.', '.kk..kk.'],
  { h: '#5a2a14', f: '#e8b898', e: '#101010', m: '#b04040', p: '#8a4ac0', k: '#202020' },
);
const IVY_HURT = sprite(
  ['h.hhhh.h', 'hhhhhhhh', '.hffffh.', '.fxfxff.', '.ffffff.', '..fOOf..', '.pppppp.', 'pppppppp', 'fppppppf', '.pppppp.', '.ff..ff.', '.kk..kk.'],
  { h: '#5a2a14', f: '#e8b898', x: '#101010', O: '#401010', p: '#8a4ac0', k: '#202020' },
);
const NOTE = sprite(['..##', '..#.', '..#.', '###.', '###.'], { '#': '#ffe080' });
const BAD_NOTE = sprite(['..##', '..#.', '..#.', '###.', '###.'], { '#': '#ff3030' });

/** The lullaby (our own tune): notes and beats. */
const SONG: [string, number][] = [
  ['E5', 1], ['G5', 1], ['E5', 1], ['D5', 2], ['C5', 1], ['D5', 1], ['E5', 1], ['G4', 3],
  ['C5', 1], ['E5', 1], ['D5', 1], ['C5', 2], ['A4', 1], ['G4', 3], ['', 1],
  ['E5', 1], ['G5', 1], ['A5', 1], ['G5', 2], ['E5', 1], ['D5', 1], ['C5', 1], ['D5', 3],
  ['E5', 1], ['D5', 1], ['C5', 1], ['A4', 2], ['B4', 1], ['C5', 3], ['', 2],
];

const LEFT = 34;
const RIGHT = W - 34;
const DEPTH_M = 300;
const SCROLL_PER_M = 3.4;
/** Depths (m) where MOTHER's lens opens on the way down. */
const WATCH_AT = [0, 25, 65, 110, 155, 200, 250];

interface Cable {
  y: number;
  left: boolean;
  len: number;
}
interface Note {
  x: number;
  y: number;
  bad: boolean;
  got: boolean;
}

class Lullaby implements Program {
  done = false;
  ending: string[] = [];
  private t = 0;
  private x = W / 2;
  private scroll = 0;
  private cables: Cable[] = [];
  private notes: Note[] = [];
  private got = 0;
  private hurt = 0;
  /** MOTHER's lens over the shaft (seconds open), and how many times it has opened. */
  private eye = 0;
  private watched = 0;
  /** A red flash for a note that was not a note. */
  private sour = 0;
  private beat = 0;
  private songI = 0;
  /** 0 descending, 1 MOTHER's room, 2 the arm, 3 black. */
  private phase = 0;
  private phaseT = 0;
  private roomTemp = -27;

  constructor(private c: Ctx) {
    for (let y = 120; y < DEPTH_M * SCROLL_PER_M; y += 46 + Math.random() * 30) {
      this.cables.push({ y, left: Math.random() < 0.5, len: 30 + Math.random() * 44 });
    }
    for (let y = 60; y < DEPTH_M * SCROLL_PER_M - 40; y += 22 + Math.random() * 18) {
      this.notes.push({ x: LEFT + 10 + Math.random() * (RIGHT - LEFT - 20), y, bad: y / SCROLL_PER_M > 150 && Math.random() < 0.35, got: false });
    }
  }

  private get depth(): number {
    return this.scroll / SCROLL_PER_M;
  }

  /** MOTHER looks: the lens opens and hums three notes at her. */
  private watch(): void {
    this.eye = 3.2;
    [660, 520, 740].forEach((f, i) => this.c.chip.beep(f, 0.18, 0.05, 'sine', f * 0.97, i * 0.2));
  }

  /** The song plays itself, more out of tune the deeper she goes. */
  private sing(dt: number): void {
    this.beat -= dt;
    if (this.beat > 0) return;
    const [n, len] = SONG[this.songI];
    this.songI = (this.songI + 1) % SONG.length;
    const spb = 0.36 + this.depth / 2000;
    this.beat = len * spb;
    if (!n) return;
    const wobble = 1 + (Math.random() - 0.5) * (this.depth / 9000) + (this.phase >= 1 ? -0.03 : 0);
    this.c.chip.beep(hz(n) * wobble, len * spb * 0.95, 0.07, 'triangle');
  }

  update(dt: number): void {
    const { pad, chip } = this.c;
    this.t += dt;
    this.phaseT += dt;
    this.hurt -= dt;
    this.eye -= dt;
    this.sour -= dt;
    if (this.phase < 3) this.sing(dt);
    if (this.phase === 0) {
      while (this.watched < WATCH_AT.length && this.depth >= WATCH_AT[this.watched]) {
        this.watched++;
        this.watch();
      }
      const speed = 20 + (pad.held('down') ? 16 : 0) - (pad.held('up') ? 10 : 0);
      this.scroll += speed * dt;
      this.x += pad.axis('left', 'right') * (this.hurt > 0 ? 24 : 58) * dt;
      this.x = Math.max(LEFT + 8, Math.min(RIGHT - 8, this.x));
      this.roomTemp = -27 - (this.depth / DEPTH_M) * 2;
      // Ivy (2×: 16×24) stands 34 px down the screen; her middle in world space.
      const ivyMid = this.scroll + 34 + 12;
      for (const cb of this.cables) {
        if (Math.abs(cb.y - ivyMid) > 11 || this.hurt > 0) continue;
        const hit = cb.left ? this.x - 6 < LEFT + cb.len : this.x + 6 > RIGHT - cb.len;
        if (hit) {
          this.hurt = 0.9;
          this.x += cb.left ? 18 : -18;
          chip.noise(0.2, 0.3, 3000, 2);
          chip.beep(200, 0.2, 0.15, 'sawtooth', 120);
          this.watch();
        }
      }
      for (const n of this.notes) {
        if (n.got || Math.abs(n.y + 5 - ivyMid) > 13 || Math.abs(n.x - this.x) > 10) continue;
        n.got = true;
        if (n.bad) {
          chip.beep(hz('C5') * 0.94, 0.4, 0.14, 'sawtooth', hz('C4'));
          this.sour = 0.5;
          this.watch();
        } else {
          this.got++;
          chip.beep(hz(SONG[(this.songI + 1) % SONG.length][0] || 'C5') * 2, 0.15, 0.08, 'square');
        }
      }
      if (this.depth >= DEPTH_M) {
        this.phase = 1;
        this.phaseT = 0;
        this.x = 30;
        chip.beep(hz('C5'), 0.3, 0.08, 'sine');
        chip.beep(hz('G5'), 0.5, 0.08, 'sine', undefined, 0.3);
      }
    } else if (this.phase === 1) {
      // MOTHER has the controls now: whatever you press, she walks to the bed.
      this.x = Math.min(126, this.x + (14 + pad.axis('left', 'right') * 4) * dt);
      this.roomTemp = Math.max(-30, -29 - this.phaseT / 8);
      if (this.phaseT > 4.5 && this.phaseT - dt <= 4.5) chip.beep(hz('E5'), 0.4, 0.07, 'sine', hz('C5'));
      if (this.phaseT > 9 && this.phaseT - dt <= 9) {
        chip.hush();
        chip.beep(70, 1.2, 0.2, 'sawtooth', 50);
      }
      if (this.phaseT > 11) {
        this.phase = 2;
        this.phaseT = 0;
      }
    } else if (this.phase === 2) {
      if (this.phaseT > 0.45 && this.phaseT - dt <= 0.45) {
        chip.noise(0.5, 0.6, 400, 0.8);
        chip.beep(60, 0.6, 0.3, 'square', 30);
      }
      if (this.phaseT > 0.6) {
        this.phase = 3;
        this.phaseT = 0;
      }
    } else if (this.phase === 3 && this.phaseT > 2) {
      const total = this.notes.filter((n) => !n.bad).length;
      this.ending = ["ELEKTRON-30 // MOTHER'S LULLABY", `♪ ${this.got}/${total}.  300 M.`, 'INCIDENT 04-117: INDUSTRIAL ACCIDENT.'];
      this.done = true;
    }
  }

  draw(s: Screen): void {
    if (this.phase === 3) {
      s.clear('#000');
      return;
    }
    if (this.phase === 0) this.drawShaft(s);
    else this.drawRoom(s);
    // HUD.
    s.rect(0, H - 9, W, 9, '#000');
    s.text(`${Math.min(DEPTH_M, Math.floor(this.depth))} M`, 4, H - 7, '#9ad');
    s.text(`♪ ${this.got}`, W / 2, H - 7, '#ffe080', 1, 'center');
    s.text(`${this.roomTemp.toFixed(1)}°`, W - 4, H - 7, this.roomTemp <= -30 ? '#ff5050' : '#9fd3ff', 1, 'right');
  }

  /** A pixel arrowhead (5 wide, 3 deep) pointing `dir`. */
  private arrow(s: Screen, x: number, y: number, dir: 'left' | 'right' | 'down', c: string): void {
    for (let i = 0; i < 3; i++) {
      if (dir === 'down') s.rect(x - 2 + i, y + i, 5 - i * 2, 1, c);
      else s.rect(dir === 'left' ? x + 2 - i : x + i, y - 2 + i, 1, 5 - i * 2, c);
    }
  }

  private drawShaft(s: Screen): void {
    s.clear('#07060c');
    const off = this.scroll % 16;
    // Walls: bolted panels, pipes running down.
    for (const [x0, x1] of [[0, LEFT], [RIGHT, W]]) {
      s.rect(x0, 0, x1 - x0, H, '#16141e');
      for (let y = -off; y < H; y += 16) s.rect(x0, y, x1 - x0, 1, '#0c0b12');
    }
    s.rect(LEFT - 2, 0, 2, H, '#2a2638');
    s.rect(RIGHT, 0, 2, H, '#2a2638');
    s.rect(LEFT - 10, 0, 3, H, '#3a3448');
    s.rect(RIGHT + 8, 0, 3, H, '#3a3448');
    // Lamps every few metres, dimmer the deeper.
    for (let y = -(this.scroll % 60); y < H; y += 60) {
      s.rect(LEFT - 6, y, 4, 3, `rgba(255,210,140,${Math.max(0.15, 1 - this.depth / 260)})`);
      s.rect(RIGHT + 2, y + 30, 4, 3, `rgba(255,210,140,${Math.max(0.15, 1 - this.depth / 260)})`);
    }
    const top = this.scroll;
    for (const cb of this.cables) {
      const y = cb.y - top;
      if (y < -6 || y > H) continue;
      const x0 = cb.left ? LEFT : RIGHT - cb.len;
      s.rect(x0, y, cb.len, 3, '#1c1c1c');
      for (let i = 0; i < 6; i++) s.rect(cb.left ? x0 + cb.len - 6 + i : x0 + i, y - 1, 1, 5, i % 2 ? '#e8c020' : '#101010');
      if (Math.floor(this.t * 8 + cb.y) % 5 === 0) s.rect(cb.left ? x0 + cb.len : x0 - 1, y + 1, 1, 1, '#9fd3ff');
    }
    for (const n of this.notes) {
      const y = n.y - top;
      if (n.got || y < -6 || y > H) continue;
      s.draw(n.bad ? BAD_NOTE : NOTE, n.x - 4, y + Math.sin(this.t * 3 + n.y) * 1.5, false, 2);
    }
    const blink = this.hurt > 0 && Math.floor(this.t * 16) % 2 === 0;
    if (!blink) s.draw(this.hurt > 0 ? IVY_HURT : IVY, this.x - 8, 34, false, 2);
    // At the top: which way she can go.
    if (this.depth < 8 && Math.floor(this.t * 2) % 2) {
      this.arrow(s, this.x - 16, 46, 'left', '#ffd8f0');
      this.arrow(s, this.x + 14, 46, 'right', '#ffd8f0');
      this.arrow(s, this.x, 62, 'down', '#ffd8f0');
    }
    // MOTHER's lens, opening over the shaft.
    if (this.eye > 0) {
      const open = Math.min(1, this.eye / 0.3, (3.2 - this.eye) / 0.3);
      const h = Math.max(1, Math.round(open * 7));
      s.rect(W / 2 - 9, 10 - h / 2, 19, h, '#100008');
      s.frame(W / 2 - 10, 9 - h / 2, 21, h + 2, '#6a3a5a');
      const look = Math.max(-5, Math.min(5, Math.round((this.x - W / 2) / 10)));
      if (h >= 3) s.rect(W / 2 - 1 + look, 9, 3, 3, '#ff2030');
    }
    if (this.sour > 0) s.tint('#ff0000', this.sour * 0.5);
    // The bottom glows red as it comes up.
    const left = DEPTH_M - this.depth;
    if (left < 40) s.tint('#400010', (1 - left / 40) * 0.35);
  }

  private drawRoom(s: Screen): void {
    const flick = this.phaseT > 8.6 && Math.random() < 0.3;
    s.clear(flick ? '#000' : '#0d0a0e');
    // MOTHER: a wall of lenses and a speaker grille under the message line, two arms below it.
    const top = 32;
    s.rect(0, 0, W, top, '#08070a');
    for (let x = 6; x < W; x += 12) s.rect(x, 0, 2, top, '#141018'); // conduits up to the shaft
    s.rect(56, top, 136, 40, '#1a161c');
    s.frame(56, top, 136, 40, '#3a3040');
    for (let i = 0; i < 9; i++) {
      const lx = 64 + (i % 3) * 14 + (i > 5 ? 8 : 0);
      const ly = top + 4 + Math.floor(i / 3) * 12;
      s.rect(lx, ly, 9, 9, '#050405');
      s.frame(lx, ly, 9, 9, '#2a2430');
      // They blink, until the song stops: then every one of them stays on her.
      const on = this.phaseT > 9 || (Math.floor(this.t * 3) + i) % 7 !== 0;
      // Every lens turns to look at her.
      const look = Math.max(-2, Math.min(2, Math.round((this.x - lx) / 30)));
      s.rect(lx + 3 + look, ly + 3, 3, 3, on ? '#ff2030' : '#401010');
    }
    for (let y = top + 6; y < top + 36; y += 3) s.rect(122, y, 62, 1, '#2a242e');
    // The moving bed.
    s.rect(110, 104, 80, 8, '#2a2a30');
    for (let x = 110 + ((this.t * 10) % 8); x < 190; x += 8) s.rect(x, 104, 2, 8, '#3a3a44');
    s.rect(110, 100, 80, 4, '#d8d0e0');
    // Arms.
    for (const ax of [128, 168]) {
      const near = ax === 128 && this.phase === 2;
      const drop = near ? Math.min(1, this.phaseT / 0.4) * 22 : Math.sin(this.t * 1.3 + ax) * 2;
      const y = top + 40;
      s.rect(ax, y, 4, 6 + drop, '#5a5460');
      s.rect(ax - 4, y + 6 + drop, 12, 4, '#7a7480');
      s.rect(ax - 4, y + 10 + drop, 3, 7, '#7a7480');
      s.rect(ax + 5, y + 10 + drop, 3, 7, '#7a7480');
    }
    s.rect(0, 112, W, H - 112, '#141018');
    if (this.phase === 1) s.draw(IVY, this.x - 8, 88, false, 2);
    // The bed, pointed out.
    if (this.phase === 1 && this.phaseT > 4.5 && this.phaseT < 9 && Math.floor(this.t * 2) % 2) this.arrow(s, 150, 92, 'down', '#ffd8f0');
    if (this.phase === 2) s.tint('#ff0000', 0.5);
  }
}

export const LULLABY_PROGRAM: ProgramInfo = {
  id: 'lullaby',
  title: "MOTHER'S LULLABY",
  blurb: 'FOLLOW THE SONG DOWN.',
  year: '2004',
  make: (c) => new Lullaby(c),
};
