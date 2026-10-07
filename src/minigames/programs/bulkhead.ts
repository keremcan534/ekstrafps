import { Screen, W, H, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * BULKHEAD (2010). Compartment 7, heating off. Keep Victor warm: rub your hands (A),
 * pace, or walk up to the frame on the wall (UP) that has a heater and a smile.
 * The K-units knock; Victor scratches a mark by the door for each one that names
 * itself, and there are four of them. The thermometer goes one way.
 */

const VICTOR = [
  sprite(['..hhh..', '.hhhhh.', '.fgfgf.', '.fffff.', '..fff..', '.wwwww.', 'wwwwwww', 'wwtwtww', 'wwwwwww', 'fwwwwwf', '.wwwww.', '.kk.kk.', '.kk.kk.', '.bb.bb.'], { h: '#8a8a90', f: '#e0b090', g: '#202830', w: '#e8e8e4', t: '#5a7090', k: '#2a2a30', b: '#101010' }),
  sprite(['..hhh..', '.hhhhh.', '.fgfgf.', '.fffff.', '..fff..', '.wwwww.', 'wwwwwww', 'wwtwtww', 'wwwwwww', 'fwwwwwf', '.wwwww.', '.kk..kk', 'kk...kk', 'bb....b'], { h: '#8a8a90', f: '#e0b090', g: '#202830', w: '#e8e8e4', t: '#5a7090', k: '#2a2a30', b: '#101010' }),
];
const VICTOR_DOWN = sprite(['...........hhh', 'kkbwwwwwwwwfff', 'kkbwwwwwwwwhhh'], { h: '#8a8a90', f: '#e0b090', w: '#e8e8e4', k: '#2a2a30', b: '#101010' });

const HUSK_X = 140;
const HUSK_Y = 34;
const FLOOR = 112;

/** The knocks, by time: 0 is "knock knock" (two), n is K-n (one knock, one mark by the door). */
const KNOCKS: [number, number][] = [[5, 0], [9, 1], [11, 2], [13, 3], [15, 4], [23, 0], [26, 5]];
/** Victor's answers, over his head. */
const VICTOR_SAYS: [number, string][] = [[7, '?'], [19, '...'], [29, '!']];
const K_UNITS = 4;

class Bulkhead implements Program {
  done = false;
  ending = ['ELEKTRON-30 // BULKHEAD', 'COMPARTMENT 7.  LOWEST -30.0°.', '06:10 DOOR WELDED.  MISSING: DR. V. ASHGRAVE.'];
  private t = 0;
  private x = 60;
  private face = 1;
  private room = -18;
  private body = 36.6;
  private rubs = 0;
  private rubFlash = 0;
  /** HUSK's chest display brightening, heat shimmering off it (seconds left). */
  private beckon = 0;
  private beckonIn = 3;
  private warned = false;
  /** Victor's bubble, and how long it stays up. */
  private bubble = '';
  private bubbleT = 0;
  /** Marks scratched by the door, one per K-unit that named itself. */
  private marks = 0;
  private dent = 0;
  /** 0 outside, 1 crawling, 2 inside (cosy), 3 the locks, 4 still. */
  private phase = 0;
  private phaseT = 0;
  private clacks = 0;
  private heater: { set(f: number, v?: number): void; stop(): void } | null = null;
  private frost = Array.from({ length: 500 }, () => ({ x: Math.random() * W, y: Math.random() * H, k: Math.random() }));

  constructor(private c: Ctx) {}

  /** HUSK calls: the smile lights up, a bright two-note chime. */
  private call(): void {
    this.beckon = 2.4;
    this.c.chip.beep(1046, 0.1, 0.06, 'triangle');
    this.c.chip.beep(1318, 0.16, 0.06, 'triangle', undefined, 0.12);
  }

  update(dt: number): void {
    const { pad, chip } = this.c;
    this.t += dt;
    this.phaseT += dt;
    this.rubFlash -= dt;
    this.beckon -= dt;
    this.bubbleT -= dt;
    this.dent = Math.max(0, this.dent - dt * 3);
    // The room only goes one way.
    this.room = Math.max(-30, this.room - dt * (this.phase >= 2 ? 0.55 : 0.3));
    if (this.phase < 3) {
      for (const [at, k] of KNOCKS) if (this.t >= at && this.t - dt < at) {
        this.dent = 1;
        for (let i = 0; i < (k === 0 ? 2 : 1); i++) chip.noise(0.12, 0.5, 220, 1.5, i * 0.25);
        if (k > 0) {
          this.marks = k;
          // The one that should not be there.
          if (k > K_UNITS) chip.beep(70, 0.9, 0.14, 'sawtooth', 55, 0.15);
        }
      }
      for (const [at, text] of VICTOR_SAYS) if (this.t >= at && this.t - dt < at) {
        this.bubble = text;
        this.bubbleT = 2.4;
      }
    }
    if (this.phase === 0) {
      const mx = pad.axis('left', 'right');
      const slow = this.body < 33 ? 0.4 : 1;
      if (mx) this.face = mx;
      this.x = Math.max(32, Math.min(HUSK_X - 8, this.x + mx * 30 * slow * dt));
      if (pad.hit('a')) {
        this.rubs++;
        this.rubFlash = 0.1;
        this.body = Math.min(36.6, this.body + 0.08);
        chip.noise(0.06, 0.12, 1200, 1);
      }
      // At -30 no amount of rubbing keeps up.
      this.body -= dt * (0.06 + (-18 - this.room) * 0.012) * (this.room <= -30 ? 5 : 1);
      this.beckonIn -= dt;
      if (this.beckonIn <= 0) {
        this.call();
        this.beckonIn = 5 + Math.random() * 2;
      }
      const atFrame = this.x > HUSK_X - 14;
      if (atFrame && pad.hit('up')) this.enter();
      if (this.body <= 31) {
        this.phase = 1;
        this.phaseT = 0;
        this.call();
      }
    } else if (this.phase === 1) {
      this.x += 10 * dt;
      if (this.x >= HUSK_X - 6) this.enter();
    } else if (this.phase === 2) {
      this.body = Math.min(36.6, this.body + dt * 0.8);
      if (this.room <= -29.4 && this.phaseT > 2 && !this.warned) {
        this.warned = true;
        this.call();
      }
      if (this.room <= -30) {
        this.phase = 3;
        this.phaseT = 0;
        this.heater?.stop();
        chip.hush();
      }
    } else if (this.phase === 3) {
      // One second of nothing, then the locks, one after another.
      const want = Math.max(0, Math.floor((this.phaseT - 1.6) / 0.42));
      while (this.clacks < Math.min(6, want)) {
        this.clacks++;
        chip.noise(0.09, 0.7, 700, 1.2);
        chip.beep(90, 0.08, 0.3, 'square', 50);
      }
      if (this.phaseT > 5) {
        this.phase = 4;
        this.phaseT = 0;
      }
    } else if (this.phaseT > 3.2) this.done = true;
  }

  private enter(): void {
    this.phase = 2;
    this.phaseT = 0;
    this.c.chip.beep(523, 0.3, 0.1, 'triangle', 784);
    this.heater = this.c.chip.drone(80, 0.05, 'triangle', 300);
    this.call();
  }

  draw(s: Screen): void {
    const cold = Math.min(1, (-18 - this.room) / 12);
    s.clear('#14181e');
    // Walls, floor, a frost line creeping up.
    for (let x = 0; x < W; x += 24) s.rect(x, 0, 1, FLOOR, '#0e1116');
    s.rect(0, FLOOR, W, H - FLOOR, '#1c2026');
    s.rect(0, FLOOR, W, 1, '#3a404a');
    // The door: wheel, rivets, a dent when they knock.
    const dx = Math.round(this.dent * 2);
    s.rect(0, 28, 22 + dx, FLOOR - 28, '#3a3e44');
    s.frame(0, 28, 22 + dx, FLOOR - 28, '#5a5e66');
    s.rect(6 + dx, 60, 10, 10, '#20242a');
    s.frame(5 + dx, 59, 12, 12, '#7a7e86');
    for (let y = 34; y < FLOOR; y += 10) s.rect(18 + dx, y, 2, 2, '#5a5e66');
    // Tally by the door: four strokes, and the fifth across them in red.
    for (let i = 0; i < Math.min(K_UNITS, this.marks); i++) s.rect(28 + i * 3, 40, 1, 9, '#b8bcc4');
    if (this.marks > K_UNITS) s.line(26, 47, 39, 41, '#ff4040');
    // HUSK on its mount.
    this.drawHusk(s);
    // Victor.
    if (this.phase === 0) s.draw(VICTOR[this.rubFlash > 0 ? 1 : Math.floor(this.t * 2) % 2 && this.body < 33 ? 1 : 0], this.x - 7, FLOOR - 28, this.face < 0, 2);
    if (this.phase === 1) s.draw(VICTOR_DOWN, this.x - 14, FLOOR - 6, false, 2);
    if (this.bubbleT > 0 && this.phase < 2) {
      const by = this.phase === 0 ? FLOOR - 40 : FLOOR - 18;
      const bw = s.textWidth(this.bubble) + 6;
      s.rect(this.x - bw / 2, by, bw, 9, '#000');
      s.frame(this.x - bw / 2, by, bw, 9, '#8a8a90');
      s.text(this.bubble, this.x, by + 2, '#ffffff', 1, 'center');
    }
    // Thermometer on the wall.
    s.rect(40, 16, 46, 14, '#000');
    s.frame(40, 16, 46, 14, '#3a404a');
    s.text(`${this.room.toFixed(1)}°`, 63, 21, this.room <= -30 ? '#ff4040' : '#9fd3ff', 1, 'center');
    // Frost.
    const n = Math.floor(this.frost.length * cold);
    for (let i = 0; i < n; i++) {
      const f = this.frost[i];
      const edge = Math.min(f.x, W - f.x, f.y, H - f.y);
      if (edge < 30 * cold * f.k + 2) s.rect(f.x, f.y, 1, 1, '#d8ecff');
    }
    if (this.phase === 2) s.tint('#ff8020', 0.12);
    if (this.phase === 3 && this.clacks > 0 && this.phaseT % 0.42 < 0.12) {
      s.tint('#ff0000', 0.45);
      s.shake = 4;
    }
    if (this.phase === 4) s.tint('#000000', Math.min(0.85, this.phaseT / 2));
    // HUD.
    s.rect(0, 0, W, 9, '#000');
    const bodyC = this.body < 33 ? '#ff6040' : '#e8e8e8';
    this.heart(s, 3, 2, bodyC);
    s.text(`${this.body.toFixed(1)}°`, 11, 2, bodyC);
    s.text(String(this.rubs), W - 3, 2, '#ffd040', 1, 'right');
    this.hands(s, W - 6 - s.textWidth(String(this.rubs)) - 9, 1);
    const blink = Math.floor(this.t * 3) % 2 ? '#ffd040' : '#806820';
    // At first: the button (rub). At the frame: an arrow up into it.
    if (this.phase === 0 && this.rubs === 0 && this.t < 6) {
      s.frame(this.x - 5, FLOOR - 44, 11, 11, blink);
      s.text('A', this.x - 1, FLOOR - 41, blink);
    }
    if (this.phase === 0 && this.x > HUSK_X - 14) for (let i = 0; i < 4; i++) s.rect(this.x - i, FLOOR - 38 + i, 1 + i * 2, 1, blink);
  }

  /** A 7x6 heart. */
  private heart(s: Screen, x: number, y: number, c: string): void {
    s.rect(x, y + 1, 7, 2, c);
    s.rect(x + 1, y, 2, 1, c);
    s.rect(x + 4, y, 2, 1, c);
    s.rect(x + 1, y + 3, 5, 1, c);
    s.rect(x + 2, y + 4, 3, 1, c);
    s.rect(x + 3, y + 5, 1, 1, c);
  }

  /** Two palms together, rubbing (they shift on every rub). */
  private hands(s: Screen, x: number, y: number): void {
    const o = this.rubFlash > 0 ? 1 : 0;
    s.rect(x + o, y, 3, 7, '#e0b090');
    s.rect(x + 4 - o, y, 3, 7, '#e0b090');
  }

  private drawHusk(s: Screen): void {
    const x = HUSK_X;
    const y = HUSK_Y;
    const grey = '#6a6e74';
    const dark = '#3a3e44';
    s.rect(x + 6, y - 6, 18, 6, dark); // wall mount
    s.rect(x + 8, y, 14, 12, grey); // head
    const eye = this.phase >= 2 && this.phase < 4 ? '#ff9a30' : '#1a1a1a';
    s.rect(x + 10, y + 4, 3, 2, eye);
    s.rect(x + 17, y + 4, 3, 2, eye);
    s.rect(x + 2, y + 13, 26, 26, grey); // chest
    s.frame(x + 2, y + 13, 26, 26, dark);
    s.rect(x - 4, y + 14, 6, 30, grey); // arms
    s.rect(x + 28, y + 14, 6, 30, grey);
    s.rect(x + 6, y + 40, 7, 38, grey); // legs
    s.rect(x + 17, y + 40, 7, 38, grey);
    for (const ly of [y + 50, y + 64]) {
      s.rect(x + 5, ly, 9, 2, dark);
      s.rect(x + 16, ly, 9, 2, dark);
    }
    if (this.phase >= 2) s.rect(x + 8, y + 26, 14, 12, '#1a0e08'); // someone inside
    // The chest display.
    const lit = this.beckon > 0 && Math.floor(this.t * 6) % 2 === 0;
    s.rect(x + 7, y + 16, 16, 9, lit ? '#1a4a1a' : '#081008');
    const mood = this.phase < 3 ? ':)' : this.phaseT < 0.8 ? ':|' : ':(';
    s.text(mood, x + 15, y + 18, this.phase === 3 ? '#ff4040' : lit ? '#c8ffd0' : '#60ff80', 1, 'center');
    // Heat shimmering off the frame while it calls.
    if (this.beckon > 0) for (let i = 0; i < 3; i++) {
      const hx = x + 6 + i * 8;
      for (let j = 0; j < 4; j++) s.rect(hx + Math.round(Math.sin(this.t * 6 + j + i) * 1.5), y - 10 - j * 3, 1, 2, '#ff9a30');
    }
    // Lock bars, one per clack.
    for (let i = 0; i < this.clacks; i++) s.rect(x + 1, y + 27 + i * 2, 28, 1, '#c8c8c8');
  }
}

export const BULKHEAD_PROGRAM: ProgramInfo = {
  id: 'bulkhead',
  title: 'BULKHEAD',
  blurb: 'KEEP DR. ASHGRAVE WARM.',
  year: '2010',
  make: (c) => new Bulkhead(c),
};
