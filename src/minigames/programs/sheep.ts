import { hz } from '../chip';
import { H, Screen, W, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * SLEEPY COUNT (2003). A cheerful sleep helper for Milo: press A as each sheep clears
 * the fence. Every sheep counted takes a degree and a bit off the thermometer, and
 * the sheep stop being sheep. At thirty it stops. No words: the radio crackles, the
 * door locks, the thermometer says the rest.
 */

const WOOL = { w: '#e8e8e0', s: '#b0b0a8', k: '#161616', e: '#ffffff' };
const STEEL = { w: '#9aa0a8', s: '#5a6068', k: '#26292e', e: '#ff2a2a' };
const BODY = ['...wwww......', '.wwwwwwwww...', 'wwwwwwwwwwkk.', 'wwwwwwwwwkkek', 'swwwwwwwwkkkk', '.sswwwwwss...'];
const LEGS_A = ['..k..k.k..k..', '..k..k.k..k..'];
const LEGS_B = ['.k..k...k..k.', '.k..k...k..k.'];
const UNIT = ['.............', '..ssssssss...', '.swwwwwwwwss.', 'swwwwwwwwweks', 'swwwwwwwwssss', '.ssssssssss..'];
const UNIT_LEGS_A = ['..s..s.s..s..', '..k..k.k..k..'];
const UNIT_LEGS_B = ['.s..s...s..s.', '.k..k...k..k.'];

const SHEEP = [sprite([...BODY, ...LEGS_A], WOOL), sprite([...BODY, ...LEGS_B], WOOL)];
const SERVO = [sprite([...BODY, ...LEGS_A], { ...WOOL, k: '#8a9098', e: '#ff2a2a' }), sprite([...BODY, ...LEGS_B], { ...WOOL, k: '#8a9098', e: '#ff2a2a' })];
const UNITS = [sprite([...UNIT, ...UNIT_LEGS_A], STEEL), sprite([...UNIT, ...UNIT_LEGS_B], STEEL)];
const SPARKY_OFF = sprite(['..k..', '.ggg.', 'gwgwg', '.ggg.', '.g.g.'], { k: '#4a3a10', g: '#7a8a9a', w: '#ffffff' });
const STARE = sprite(['.sssss.', 'swwwwws', 'we.w.ew', 'wee.eew', 'swwwwws', '.sssss.'], STEEL);

const MILO = sprite(
  ['....kkkk....', '...kkkkkk...', '..kkffffkk..', '..kfefefk...', '..kffffff...', '...ffmff....', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'bBbbbbbbbbbbbbbbbbbbbbbB', 'bbbbbbbbbbbbbbbbbbbbbbbb'],
  { k: '#2a1a10', f: '#e8b898', e: '#ffffff', m: '#a04040', b: '#2a4a8a', B: '#1a2a5a' },
);
const SPARKY = sprite(['..y..', '.ggg.', 'gwgwg', '.ggg.', '.g.g.'], { y: '#ffd040', g: '#7a8a9a', w: '#ffffff' });
const GOLDIE = sprite(
  ['..yyyyyyyy..', '.yYYYYYYYYy.', 'yYddYYYYddYy', 'yYdlYYYYdlYy', 'yYddYYYYddYy', 'yYYYYYYYYYYy', '.yYdddddddY.', '..yyyyyyyy..'],
  { y: '#8a6a10', Y: '#d8b030', d: '#2a2410', l: '#fff6c0' },
);
const ARM = sprite(
  [
    'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy......',
    'YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYyy....',
    'YYYYYYYdddYYYYYYYYYYYYYdddYYYYYYy...',
    'YYYYYYYdddYYYYYYYYYYYYYdddYYYYYYYy..',
    'YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYy.',
    'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyYYYYYy',
    '..............................yYYYYy',
    '...............................yYYy.',
    '...............................yYYy.',
    '................................yy..',
  ],
  { y: '#8a6a10', Y: '#d8b030', d: '#2a2410' },
);

const FLOOR = 104;
const FENCE_X = 104;
/** Sheep are drawn at 2×: 26 px wide, centre 13 px in. */
const MID = 13;
const JUMP_W = 24;
/** Cain on the radio at this count; the door locks at this one. */
const RADIO_AT = 12;
const LOCK_AT = 26;

interface Sheep {
  x: number;
  kind: 0 | 1 | 2;
  counted: boolean;
  stare: number;
  stared: boolean;
  speed: number;
}

class SleepyCount implements Program {
  done = false;
  ending = ['ELEKTRON-30 // SLEEPY COUNT', '30 SHEEP.  ROOM -30°.', 'WARD 2, 14 JAN 2003.  MILO (8): 27.1°.'];
  private count = 0;
  private sheep: Sheep[] = [];
  private spawnIn = 1.5;
  private stareUsed = false;
  /** Cain's voice on the radio by the bed (seconds left). */
  private radio = 0;
  private t = 0;
  /** After the thirtieth: 0 counting, 1 silence, 2 window, 3 arms, 4 black. */
  private phase = 0;
  private phaseT = 0;
  private flakes = Array.from({ length: 24 }, () => ({ x: Math.random() * 30, y: Math.random() * 28, v: 4 + Math.random() * 6 }));
  private frost = Array.from({ length: 900 }, () => {
    const edge = Math.random() * 4 | 0;
    const d = Math.pow(Math.random(), 2) * 40;
    const along = Math.random();
    return { x: edge === 0 ? d : edge === 1 ? W - d : along * W, y: edge === 2 ? d : edge === 3 ? H - d : along * H, k: d / 40 };
  });
  private wrongT = 0;

  constructor(private c: Ctx) {}

  private get temp(): number {
    return Math.round(10 - (this.count * 40) / 30);
  }

  update(dt: number): void {
    this.t += dt;
    this.phaseT += dt;
    this.wrongT -= dt;
    this.radio -= dt;
    const chip = this.c.chip;
    // A voice through the static: garbled syllables, no words.
    if (this.radio > 0 && Math.random() < dt * 7) chip.beep(260 + Math.random() * 380, 0.05, 0.04, 'square', 200 + Math.random() * 200);
    for (const f of this.flakes) {
      f.y += f.v * dt;
      f.x += Math.sin(this.t + f.y) * dt * 3;
      if (f.y > 28) {
        f.y = 0;
        f.x = Math.random() * 30;
      }
    }
    if (this.phase === 0) {
      // Sheep: slower and further apart as the room cools.
      this.spawnIn -= dt;
      if (this.spawnIn <= 0 && this.count < 30) {
        const kind: 0 | 1 | 2 = this.count < 8 ? 0 : this.count < 16 ? 1 : 2;
        // One of them, once, stops on the fence and looks at you.
        const stare = !this.stareUsed && this.count >= 20 && kind === 2;
        if (stare) this.stareUsed = true;
        this.sheep.push({ x: -30, kind, counted: false, stare: stare ? 3.2 : 0, stared: false, speed: 34 - Math.max(0, this.count - 22) * 2.2 });
        this.spawnIn = 1.5 + Math.max(0, this.count - 22) * 0.18 + Math.random() * 0.4;
      }
      for (const s of this.sheep) {
        const over = Math.abs(s.x + MID - FENCE_X) < 3;
        if (s.stare > 0 && over) {
          s.stare -= dt;
          if (!s.stared) {
            s.stared = true;
            chip.beep(90, 0.6, 0.12, 'sawtooth', 60);
          }
          continue;
        }
        s.x += s.speed * dt;
        if (s.kind > 0 && Math.abs(s.x + MID - FENCE_X) < 16 && Math.random() < dt * 6) chip.noise(0.05, 0.05, 3000 + Math.random() * 2000, 4);
      }
      if (this.c.pad.hit('a')) {
        const s = this.sheep.find((q) => !q.counted && Math.abs(q.x + MID - FENCE_X) < 12);
        if (s && s.stare > 0) {
          this.wrongT = 0.6;
          chip.beep(110, 0.3, 0.2, 'sawtooth', 50);
          chip.beep(90, 0.5, 0.12, 'sawtooth', 60, 0.25);
        } else if (s) {
          s.counted = true;
          this.count++;
          const note = ['C5', 'E5', 'G5', 'C6'][this.count % 4];
          chip.beep(hz(note) * (this.count > 22 ? 0.5 : 1), 0.12, 0.12, s.kind === 0 ? 'triangle' : 'square');
          if (s.kind === 0) chip.beep(320, 0.25, 0.08, 'triangle', 260, 0.06);
          if (this.count === RADIO_AT) {
            this.radio = 4.5;
            chip.noise(1.2, 0.12, 1800, 0.4);
          }
          if (this.count === LOCK_AT) {
            chip.noise(0.09, 0.4, 700, 1.2, 0.2);
            chip.beep(90, 0.08, 0.2, 'square', 50, 0.2);
          }
          if (this.count >= 30) {
            this.phase = 1;
            this.phaseT = 0;
            // Good night: three soft notes down, and Sparky's light goes out.
            ['G5', 'E5', 'C5'].forEach((n, i) => chip.beep(hz(n), 0.4, 0.07, 'triangle', undefined, 0.3 + i * 0.35));
          }
        } else {
          this.wrongT = 0.3;
          chip.beep(140, 0.12, 0.12, 'square', 100);
        }
      }
      this.sheep = this.sheep.filter((s) => s.x < W + 30);
    } else {
      for (const s of this.sheep) s.x += s.speed * dt;
      if (this.phase === 1 && this.phaseT > 4) {
        this.phase = 2;
        this.phaseT = 0;
        chip.beep(55, 2.4, 0.18, 'sawtooth', 52);
      } else if (this.phase === 2 && this.phaseT > 2.6) {
        this.phase = 3;
        this.phaseT = 0;
      } else if (this.phase === 3) {
        if (Math.random() < dt * 4) chip.noise(0.08, 0.2, 600, 2);
        if (this.phaseT > 2.2) {
          this.phase = 4;
          this.phaseT = 0;
          for (let i = 0; i < 4; i++) chip.noise(0.09, 0.45, 900, 1.5, i * 0.16);
        }
      } else if (this.phase === 4 && this.phaseT > 2.4) this.done = true;
    }
  }

  draw(s: Screen): void {
    if (this.phase === 4) {
      s.clear('#000');
      return;
    }
    const cold = Math.min(1, this.count / 30);
    // Room.
    s.clear('#0b1030');
    s.rect(0, FLOOR, W, H - FLOOR, '#1a1420');
    for (let x = 4; x < W; x += 22) s.rect(x, FLOOR + 1, 1, H - FLOOR, '#120e18');
    s.rect(0, FLOOR, W, 1, '#2a2440');
    // Window.
    s.rect(150, 16, 32, 30, '#050a1a');
    for (const f of this.flakes) s.rect(151 + f.x, 17 + f.y, 1, 1, '#c8d8ff');
    if (this.phase === 2) s.draw(GOLDIE, 160, 24 + Math.min(0, this.phaseT * 6 - 8));
    s.frame(149, 15, 34, 32, '#3a3050');
    s.rect(165, 15, 1, 32, '#3a3050');
    s.rect(149, 30, 34, 1, '#3a3050');
    // Thermometer.
    const tFill = Math.max(0, Math.min(1, (this.temp + 30) / 40));
    s.rect(12, 18, 5, 44, '#2a2a3a');
    s.rect(13, 19 + 42 * (1 - tFill), 3, 42 * tFill, this.temp > 0 ? '#e04040' : '#60b0ff');
    s.rect(11, 62, 7, 6, this.temp > 0 ? '#e04040' : '#60b0ff');
    s.text(`${this.temp}°`, 21, 38, this.temp > -20 ? '#a0a8c0' : '#9fd3ff');
    // The bedroom door. It locks itself later.
    s.rect(34, 46, 26, FLOOR - 46, '#241a2a');
    s.frame(33, 45, 28, FLOOR - 45, '#3a3050');
    s.rect(54, 76, 3, 3, '#8a7a50');
    if (this.count >= LOCK_AT) {
      // A padlock on the door and a red light that will not stop.
      const red = Math.floor(this.t * 3) % 2 ? '#ff2020' : '#401010';
      s.frame(42, 56, 5, 5, red);
      s.rect(40, 60, 9, 7, red);
      s.rect(44, 62, 1, 2, '#000');
      s.rect(54, 70, 3, 3, red);
    }
    // Fence.
    for (const x of [FENCE_X - 12, FENCE_X - 1, FENCE_X + 10]) s.rect(x, FLOOR - 20, 3, 20, '#6a4a2a');
    s.rect(FENCE_X - 14, FLOOR - 17, 28, 3, '#8a6a3a');
    s.rect(FENCE_X - 14, FLOOR - 9, 28, 3, '#8a6a3a');
    // Sheep.
    for (const q of this.sheep) {
      const dx = q.x + MID - FENCE_X;
      const jump = Math.abs(dx) < JUMP_W ? Math.cos((dx / JUMP_W) * (Math.PI / 2)) * 26 : 0;
      const frames = q.kind === 0 ? SHEEP : q.kind === 1 ? SERVO : UNITS;
      const f = frames[Math.floor(q.x / 6) % 2 === 0 ? 0 : 1];
      s.draw(f, q.x, FLOOR - 16 - jump, false, 2);
      if (q.stare > 0 && q.stared) {
        s.draw(STARE, q.x + 14, FLOOR - 24 - jump, false, 2);
        // Not this one.
        if (Math.floor(this.t * 4) % 2) s.text('X', q.x + 10, FLOOR - 50 - jump, '#ff3030', 2);
      }
      if (q.counted && dx > 0 && dx < 34) s.text('+1', q.x + 8, FLOOR - 40 - jump, '#ffe080');
    }
    // Milo in bed, Sparky blinking on the blanket.
    s.draw(MILO, 4, H - 20, false, 2);
    s.rect(4, H - 2, 48, 2, '#3a2418');
    s.draw(this.phase === 0 && Math.floor(this.t * 1.5) % 2 ? SPARKY : SPARKY_OFF, 36, H - 30, false, 2);
    this.drawRadio(s);
    // Before the first sheep: the button, over the fence.
    if (this.count === 0 && Math.floor(this.t * 2) % 2) {
      s.frame(FENCE_X - 5, 36, 11, 11, '#ffe080');
      s.text('A', FENCE_X - 1, 39, '#ffe080');
    }
    // Arms close in.
    if (this.phase === 3) {
      const k = Math.min(1, this.phaseT / 1.6);
      s.draw(ARM, -ARM.w * 2 + k * (W / 2 + 6), 56, false, 2);
      s.draw(ARM, W + ARM.w * 2 - k * (W / 2 + 6) - ARM.w * 2, 56, true, 2);
      s.shake = 3;
    }
    // Frost from the edges.
    const n = Math.floor(this.frost.length * cold * (this.phase ? 1 : 0.85));
    for (let i = 0; i < n; i++) {
      const f = this.frost[i];
      if (f.k < cold) s.rect(f.x, f.y, 1, 1, i % 3 ? '#cfe4ff' : '#ffffff');
    }
    // HUD.
    s.draw(SHEEP[0], W - 41, 51);
    s.text(`${String(this.count).padStart(2, '0')}/30`, W - 6, 52, '#ffe080', 1, 'right');
    if (this.wrongT > 0) s.tint('#ff0000', this.wrongT * 0.4);
    if (this.count > 24) s.noise((this.count - 24) / 30, '#9fd3ff');
  }

  /** Cain's old radio by the bed: dark, until a voice comes through it. */
  private drawRadio(s: Screen): void {
    const x = 60;
    const y = 118;
    const on = this.radio > 0;
    s.rect(x + 7, y - 6, 1, 6, '#5a5a66'); // aerial
    s.rect(x, y, 10, 7, '#2a2a34');
    s.frame(x, y, 10, 7, '#4a4a58');
    for (let i = 0; i < 3; i++) s.rect(x + 2, y + 2 + i * 2 - 1, 4, 1, '#16161c'); // grille
    s.rect(x + 7, y + 2, 2, 2, on && Math.floor(this.t * 8) % 2 ? '#a0ffa0' : '#1a3a1a');
    if (!on) return;
    // Sound waves off the aerial.
    for (let i = 1; i <= 3; i++) {
      if (Math.floor(this.t * 6) % 4 < i) continue;
      s.rect(x + 9 + i * 3, y - 8 - i, 1, 2 + i * 2, '#a0ffa0');
    }
    s.noise(0.15, '#a0ffa0');
  }
}

export const SHEEP_PROGRAM: ProgramInfo = {
  id: 'sleepy',
  title: 'SLEEPY COUNT',
  blurb: 'COUNT THE SHEEP. MILO SLEEPS.',
  year: '2003',
  make: (c) => new SleepyCount(c),
};
