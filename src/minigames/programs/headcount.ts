import { Screen, W, H, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * HEADCOUNT (2006). Sunhouse, night six. Count the units that cross camera 1 with
 * the clicker (A). Four are expected: four little figures on the desk, and any extra
 * one lights red. The clicker has opinions; on camera 2 it presses itself.
 */

const UNIT = [
  sprite(['.wwww.', 'wwwwww', 'wbwwbw', 'wwwwww', '.wssw.', 'wwwwww', 'wwwwww', 'w.ww.w', '.w..w.', '.w..w.', 'ww..ww'], { w: '#e8eef0', b: '#101418', s: '#ff9a9a' }),
  sprite(['.wwww.', 'wwwwww', 'wbwwbw', 'wwwwww', '.wssw.', 'wwwwww', 'wwwwww', 'w.ww.w', '..ww..', '.w..w.', 'w....w'], { w: '#e8eef0', b: '#101418', s: '#ff9a9a' }),
];
const GOLDIE = sprite(
  ['..yyyy..', '.yYYYYy.', 'yYlYYlYy', 'yYYYYYYy', '.yYddYy.', 'yyYYYYyy', 'yYYYYYYy', 'yYYYYYYy', 'y.YYYY.y', '..YY.Y..', '..YY.Y..', '.yyy.yyy'],
  { y: '#8a6a10', Y: '#d8b030', l: '#fff6c0', d: '#2a2410' },
);
const ROY = sprite(['..hhhh..', '.hhhhhh.', '.hhhhhh.', '..ssss..', '.cccccc.', 'cccccccc', 'cccccccc', 'cccccccc'], { h: '#3a2a1a', s: '#d8a888', c: '#3a4a6a' });

interface Walker {
  x: number;
  v: number;
  kind: 'unit' | 'back' | 'goldie';
  life: number;
}

/** What happens in each round, by time (seconds). */
interface Round {
  spawns: [number, Walker['kind']][];
  ghostClicks: number[];
  length: number;
}
const EXPECTED = 4;
const ROUNDS: Round[] = [
  { spawns: [[1, 'unit'], [3.5, 'unit'], [6, 'unit'], [8, 'unit']], ghostClicks: [], length: 12 },
  { spawns: [[1, 'unit'], [2.6, 'unit'], [5.5, 'unit'], [7, 'unit']], ghostClicks: [9.6], length: 12 },
  { spawns: [[0.8, 'unit'], [2.2, 'back'], [4.5, 'goldie'], [5.2, 'unit'], [7.3, 'unit']], ghostClicks: [4.6, 10.2], length: 12.5 },
];

class Headcount implements Program {
  done = false;
  ending = ['ELEKTRON-30 // HEADCOUNT', 'NIGHT 6.  COUNTED 6.  EXPECTED 4.', 'STAFF 22:00: 1.  06:00: 0.'];
  private t = 0;
  private round = 0;
  private rt = 0;
  private count = 0;
  private walkers: Walker[] = [];
  private spawned = 0;
  private ghosted = 0;
  private flick = 0;
  /** The clicker's button, down for a moment on every click (yours or not). */
  private press = 0;
  /** Has Roy clicked yet (the A hint blinks until he has). */
  private clicked = false;
  /** Gus on the radio before audit 3: "not five" (seconds left). */
  private gus = 0;
  /** Between rounds: the result card, and the count it shows. */
  private card = 0;
  private cardCount = 0;
  /** Camera 2: the booth, and the unit behind Roy (0 door .. 1 at his shoulder). */
  private cam2 = false;
  private behind = 0;
  private idle = 0;
  private endT = -1;

  constructor(private c: Ctx) {}

  private click(own = true): void {
    this.count++;
    this.press = 0.12;
    if (own) this.clicked = true;
    this.c.chip.noise(0.03, own ? 0.35 : 0.5, 4200, 3);
    this.c.chip.beep(own ? 2400 : 1900, 0.02, 0.08, 'square');
  }

  update(dt: number): void {
    const { pad, chip } = this.c;
    this.t += dt;
    this.flick -= dt;
    this.press -= dt;
    this.gus -= dt;
    if (this.endT >= 0) {
      this.endT += dt;
      if (this.endT > 2.2) this.done = true;
      return;
    }
    if (this.cam2) return this.booth(dt);
    if (this.card > 0) {
      this.card -= dt;
      if (this.card <= 0) {
        this.round++;
        this.rt = 0;
        this.count = 0;
        this.spawned = 0;
        this.ghosted = 0;
        this.walkers = [];
        if (this.round >= ROUNDS.length) {
          this.cam2 = true;
          this.count = 1; // Roy is on camera 2 too
          this.flick = 0.5;
          chip.noise(0.4, 0.3, 2500, 0.5);
        } else if (this.round === 2) {
          this.gus = 4.2;
          chip.beep(1760, 0.5, 0.08, 'sine');
          chip.noise(0.6, 0.08, 1800, 0.5, 0.3);
        }
      }
      return;
    }
    const r = ROUNDS[this.round];
    this.rt += dt;
    while (this.spawned < r.spawns.length && this.rt >= r.spawns[this.spawned][0]) {
      const kind = r.spawns[this.spawned++][1];
      this.walkers.push(kind === 'back' ? { x: W, v: -26, kind, life: 99 } : kind === 'goldie' ? { x: 86, v: 0, kind, life: 0.35 } : { x: -14, v: 30, kind, life: 99 });
      if (kind === 'goldie') {
        this.flick = 0.4;
        chip.beep(50, 0.5, 0.2, 'sawtooth', 45);
      }
    }
    while (this.ghosted < r.ghostClicks.length && this.rt >= r.ghostClicks[this.ghosted]) {
      this.ghosted++;
      this.click(false);
    }
    for (const w of this.walkers) {
      w.x += w.v * dt;
      w.life -= dt;
      if (w.kind !== 'goldie' && Math.floor(w.x) % 9 === 0) chip.noise(0.02, 0.04, 800, 2);
    }
    this.walkers = this.walkers.filter((w) => w.life > 0 && w.x > -20 && w.x < W + 20);
    if (pad.hit('a')) this.click();
    if (this.rt >= r.length) {
      const ok = this.count === EXPECTED;
      this.cardCount = this.count;
      this.card = 3.6;
      chip.beep(ok ? 880 : 220, 0.3, 0.1, 'square', ok ? 1320 : 160);
    }
  }

  /** Camera 2: every click (yours or not) brings it a step closer. */
  private booth(dt: number): void {
    const { pad, chip } = this.c;
    this.idle += dt;
    const step = () => {
      this.behind = Math.min(1, this.behind + 0.2);
      chip.beep(70, 0.15, 0.15, 'square', 50);
      if (this.behind >= 1) {
        this.endT = 0;
        this.flick = 2;
        chip.noise(0.7, 0.6, 500, 0.6);
        chip.beep(40, 1.2, 0.3, 'sawtooth', 30);
      }
    };
    if (pad.hit('a')) {
      this.click();
      this.idle = 0;
      step();
    } else if (this.idle > 2.2) {
      this.click(false);
      this.idle = 0;
      step();
    }
  }

  draw(s: Screen): void {
    if (this.endT > 0.3) {
      s.clear('#000');
      return;
    }
    s.clear('#000');
    // The monitor.
    s.rect(6, 6, W - 12, 90, '#0a1a10');
    s.g.save();
    s.g.beginPath();
    s.g.rect(6, 6, W - 12, 90);
    s.g.clip();
    if (this.cam2) this.drawBooth(s);
    else this.drawCorridor(s);
    s.noise(0.35, '#3a6a4a');
    for (let y = 6; y < 96; y += 2) s.rect(6, y, W - 12, 1, 'rgba(0,0,0,0.25)');
    if (this.flick > 0 && Math.random() < 0.6) s.rect(6, 6, W - 12, 90, '#c8ffd8');
    s.g.restore();
    s.frame(5, 5, W - 10, 92, '#2a3a30');
    s.text(this.cam2 ? 'CAM 2' : 'CAM 1', 10, 9, '#8fe0a0');
    // One pip per audit: done, now, still to come.
    if (!this.cam2) ROUNDS.forEach((_, i) => s.rect(34 + i * 6, 10, 4, 3, i < this.round ? '#8fe0a0' : i === this.round ? (Math.floor(this.t * 2) % 2 ? '#8fe0a0' : '#2a5a3a') : '#1a3a24'));
    if (Math.floor(this.t * 2) % 2) s.rect(W - 16, 10, 3, 3, '#ff3030');
    // Desk and clicker.
    s.rect(0, 100, W, H - 100, '#20180f');
    s.rect(0, 100, W, 2, '#3a2a18');
    s.rect(W / 2 - 6, this.press > 0 ? 104 : 102, 12, 4, '#8a2a20');
    s.rect(W / 2 - 34, 106, 68, 22, '#5a5e66');
    s.rect(W / 2 - 30, 110, 60, 14, '#050505');
    s.text(String(this.count).padStart(4, '0'), W / 2, 112, '#ff6a3a', 2, 'center');
    // Expected: four figures. Counted ones light up; any past four light red.
    for (let i = 0; i < Math.min(8, Math.max(EXPECTED, this.count)); i++) {
      const lit = i < this.count;
      this.figure(s, 8 + i * 6, 110, i >= EXPECTED ? '#ff4030' : lit ? '#ffd040' : '#4a3e2c');
    }
    this.sun(s, W - 18, 116);
    if (!this.clicked && !this.cam2 && this.card <= 0 && Math.floor(this.t * 2) % 2) {
      s.frame(W / 2 + 40, 108, 11, 11, '#ffd040');
      s.text('A', W / 2 + 44, 111, '#ffd040');
    }
    if (this.card > 0) this.drawCard(s);
    else if (this.gus > 0) this.drawGus(s);
  }

  /** A little person, 4x10. */
  private figure(s: Screen, x: number, y: number, c: string): void {
    s.rect(x + 1, y, 2, 2, c);
    s.rect(x, y + 3, 4, 4, c);
    s.rect(x, y + 7, 1, 3, c);
    s.rect(x + 3, y + 7, 1, 3, c);
  }

  /** Sunhouse's sun. */
  private sun(s: Screen, x: number, y: number): void {
    const c = '#ffd040';
    s.rect(x - 3, y - 2, 7, 5, c);
    s.rect(x - 2, y - 3, 5, 7, c);
    for (const [dx, dy] of [[0, -6], [0, 5], [-6, 0], [5, 0], [-5, -5], [4, -5], [-5, 4], [4, 4]]) s.rect(x + dx, y + dy, 2, 2, c);
  }

  /** Between audits: the count against four, and the accuracy. */
  private drawCard(s: Screen): void {
    const ok = this.cardCount === EXPECTED;
    s.rect(30, 30, W - 60, 34, '#000');
    s.frame(30, 30, W - 60, 34, '#ffd040');
    s.text(`${this.cardCount}/${EXPECTED}`, W / 2 - 30, 40, '#ffd040', 3, 'center');
    s.text(`${Math.round((this.cardCount / EXPECTED) * 100)}%`, W / 2 + 30, 40, ok ? '#60ff80' : '#ff4030', 3, 'center');
  }

  /** Gus on the radio: a five, struck out. */
  private drawGus(s: Screen): void {
    s.rect(60, 26, 72, 34, '#000');
    s.frame(60, 26, 72, 34, '#a0ffa0');
    // The radio, its light talking.
    s.rect(70, 36, 14, 16, '#2a2e2a');
    s.rect(80, 30, 1, 6, '#5a5e5a');
    s.rect(73, 40, 8, 1, '#141614');
    s.rect(73, 43, 8, 1, '#141614');
    s.rect(76, 47, 3, 3, Math.floor(this.t * 6) % 2 ? '#a0ffa0' : '#1a3a1a');
    s.text('5', 108, 33, '#a0ffa0', 4, 'center');
    s.line(98, 54, 118, 32, '#ff4030');
    s.line(99, 54, 119, 32, '#ff4030');
  }

  private drawCorridor(s: Screen): void {
    s.rect(6, 64, W - 12, 32, '#0f2a18');
    for (let x = 6; x < W - 6; x += 22) s.rect(x, 64, 1, 32, '#0a1a10');
    s.rect(6, 63, W - 12, 1, '#2a5a3a');
    for (const x of [30, 90, 150]) s.rect(x, 24, 18, 30, '#123020');
    for (const w of this.walkers) {
      if (w.kind === 'goldie') s.draw(GOLDIE, w.x, 56, false, 2);
      else s.draw(UNIT[Math.floor(Math.abs(w.x) / 6) % 2], w.x, 58, w.kind === 'back', 2);
    }
  }

  private drawBooth(s: Screen): void {
    // From behind Roy: his back, the monitor wall, the doorway behind him.
    s.rect(6, 6, W - 12, 90, '#0c1e14');
    s.rect(140, 20, 30, 64, '#050c08');
    const k = this.behind;
    const ux = 150 - k * 60;
    const scale = 1 + Math.round(k * 2);
    // Standing in the doorway, then on the floor behind him, bigger as it comes.
    if (k > 0) s.draw(UNIT[0], ux - 3 * scale, 84 + k * 8 - 11 * scale, false, scale);
    s.draw(ROY, 70, 70, false, 2);
    // Face recognition box drifts onto Roy: he is one of the figures now.
    if (k >= 0.4) {
      s.frame(68, 66, 20, 10, '#ff4040');
      this.figure(s, 66, 53, '#ff4040');
      s.text(`${String(this.count).padStart(2, '0')}?`, 72, 56, '#ff4040');
    }
  }
}

export const HEADCOUNT_PROGRAM: ProgramInfo = {
  id: 'headcount',
  title: 'HEADCOUNT',
  blurb: 'COUNT THE UNITS. FOUR EXPECTED.',
  year: '2006',
  make: (c) => new Headcount(c),
};
