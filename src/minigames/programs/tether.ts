import { Screen, W, H, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * TETHER (2004). You are LANTERN in a blizzard, forty metres of cable behind you.
 * Somewhere past the end of it a child is walking toward the fence. Move, flash
 * your light and call (A). She is always a few metres further than the cable.
 */

const PX = 2.6; // pixels per metre
const DOOR = { x: W / 2, y: H - 10 };
const CABLE = 40;
const KEEP_OUT = 43.5; // she never comes closer to the door than this
const FENCE = 50;

const LANTERN = sprite(['.ddd.', 'dmmmd', 'dmymd', 'dmmmd', '.ddd.'], { d: '#2a2a30', m: '#5a5a66', y: '#ffd040' });
const LUCY = [
  sprite(['.hh.', 'hffh', '.cc.', 'cccc', '.ll.'], { h: '#6a3a1a', f: '#ffd0b0', c: '#e05a2a', l: '#202020' }),
  sprite(['.hh.', 'hffh', '.cc.', 'cccc', 'l..l'], { h: '#6a3a1a', f: '#ffd0b0', c: '#e05a2a', l: '#202020' }),
];
const LUCY_DOWN = sprite(['hffcccl', 'hffcccl'], { h: '#6a3a1a', f: '#c8d8e8', c: '#8098c0', l: '#202020' });

class Tether implements Program {
  done = false;
  ending = ['ELEKTRON-30 // TETHER', 'CABLE 40.0 M.  FOUND AT 43.5 M.', 'LNT_0412.WAV: "DAD, I MADE IT TO THE DOOR."'];
  private t = 0;
  /** LANTERN, metres from the door (x right, y away from it). */
  private lx = 0;
  private ly = 14;
  private dir = -Math.PI / 2;
  private girl = { x: 6, y: 44, temp: 36.6, stop: 0, face: 0, down: false };
  private flash = 0;
  private strain = 0;
  /** Has LANTERN called out yet (the A hint blinks until it has). */
  private called = false;
  private snow = Array.from({ length: 160 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 30 + Math.random() * 60 }));
  /** 0 search, 1 she's down, 2 last blinks. */
  private phase = 0;
  private phaseT = 0;
  private wind: { set(f: number, v?: number): void; stop(): void };
  private dark = document.createElement('canvas');

  constructor(private c: Ctx) {
    this.wind = c.chip.drone(0, 0.08, 'sine', 500);
    this.dark.width = W;
    this.dark.height = H;
    this.call(1);
  }

  /** LANTERN's voice: a rising chirp, `n` times over. */
  private call(n: number): void {
    for (let i = 0; i < n; i++) this.c.chip.beep(990, 0.05, 0.06, 'square', 1320, i * 0.22);
  }

  update(dt: number): void {
    const { pad, chip } = this.c;
    this.t += dt;
    this.phaseT += dt;
    this.flash -= dt;
    this.strain = Math.max(0, this.strain - dt);
    this.wind.set(400 + Math.sin(this.t * 0.7) * 250, 0.07 + Math.sin(this.t * 1.3) * 0.03);
    for (const f of this.snow) {
      f.y += f.v * dt;
      f.x -= f.v * 0.6 * dt;
      if (f.y > H || f.x < 0) {
        f.y = Math.random() * -20;
        f.x = Math.random() * W * 1.4;
      }
    }
    // LANTERN: move, but never past the cable.
    const mx = pad.axis('left', 'right');
    const my = pad.axis('down', 'up');
    if (mx || my) {
      this.dir = Math.atan2(-my, mx);
      const nx = this.lx + mx * 7 * dt;
      const ny = Math.max(0, this.ly + my * 7 * dt);
      if (Math.hypot(nx, ny) <= CABLE) {
        this.lx = nx;
        this.ly = ny;
      } else {
        if (this.strain <= 0) {
          chip.noise(0.25, 0.25, 180, 3);
          chip.beep(220, 0.2, 0.1, 'square', 180);
        }
        this.strain = 0.6;
        const k = CABLE / Math.hypot(nx, ny);
        this.lx = nx * k * 0.995;
        this.ly = ny * k * 0.995;
      }
    }
    const g = this.girl;
    if (this.phase === 0) {
      if (pad.hit('a')) {
        this.flash = 0.35;
        chip.beep(1500, 0.08, 0.12, 'square');
        this.called = true;
        // Once she is cold it only says one thing, over and over.
        this.call(g.temp < 31 ? 4 : 1);
        // She hears it: stops, turns, a step toward the light. Never into reach.
        g.stop = 1.6;
        g.face = Math.atan2(this.ly - g.y, this.lx - g.x);
        const step = 1.2;
        const nx = g.x + Math.cos(g.face) * step;
        const ny = g.y + Math.sin(g.face) * step;
        if (Math.hypot(nx, ny) >= KEEP_OUT) {
          g.x = nx;
          g.y = ny;
        }
      }
      g.stop -= dt;
      if (g.stop <= 0 && g.y < FENCE) {
        g.y += 0.45 * dt;
        g.x += Math.sin(this.t * 0.4) * 0.5 * dt;
      }
      g.temp = Math.max(27.5, g.temp - dt * 0.18);
      if (g.temp <= 28) {
        g.down = true;
        this.phase = 1;
        this.phaseT = 0;
        chip.beep(440, 1.5, 0.08, 'sine');
      }
    } else if (this.phase === 1) {
      if (pad.hit('a')) {
        this.flash = 0.35;
        chip.beep(1500, 0.08, 0.12, 'square');
      }
      if (this.phaseT > 5) {
        this.phase = 2;
        this.phaseT = 0;
      }
    } else {
      // It blinks three times on its own, as it did that morning.
      for (const at of [0.4, 1.4, 2.4]) if (this.phaseT > at && this.phaseT - dt <= at) {
        this.flash = 0.35;
        chip.beep(1500, 0.08, 0.1, 'square');
      }
      if (this.phaseT > 4) {
        this.wind.stop();
        this.done = true;
      }
    }
  }

  private screen(x: number, y: number): [number, number] {
    return [DOOR.x + x * PX, DOOR.y - y * PX];
  }

  draw(s: Screen): void {
    s.clear('#c8ccd4');
    // Snowfield: drifts, the fence, the building's wall along the bottom.
    for (let i = 0; i < 40; i++) s.rect((i * 37) % W, (i * 53) % (H - 20), 8, 1, '#b4b8c2');
    const [, fy] = this.screen(0, FENCE);
    for (let x = 0; x < W; x += 6) s.rect(x, fy - 4, 1, 7, '#6a6e78');
    s.rect(0, fy - 3, W, 1, '#6a6e78');
    s.rect(0, fy, W, 1, '#6a6e78');
    s.rect(0, H - 8, W, 8, '#3a3e48');
    s.rect(DOOR.x - 6, H - 10, 12, 10, '#ffd88a');
    // Cable: a sagging line from the door.
    const [lx, ly] = this.screen(this.lx, this.ly);
    const mx = (DOOR.x + lx) / 2 + (this.strain > 0 ? 0 : 6);
    const my = (DOOR.y + ly) / 2 + (this.strain > 0 ? 0 : 4);
    let px = DOOR.x;
    let py = DOOR.y;
    for (let i = 1; i <= 16; i++) {
      const k = i / 16;
      const x = (1 - k) * (1 - k) * DOOR.x + 2 * (1 - k) * k * mx + k * k * lx;
      const y = (1 - k) * (1 - k) * DOOR.y + 2 * (1 - k) * k * my + k * k * ly;
      s.line(px, py, x, y, '#202024');
      px = x;
      py = y;
    }
    // Lucy.
    const g = this.girl;
    const [gx, gy] = this.screen(g.x, g.y);
    if (g.down) s.draw(LUCY_DOWN, gx - 7, gy - 2, false, 2);
    else s.draw(LUCY[g.stop > 0 ? 0 : Math.floor(this.t * 3) % 2], gx - 4, gy - 5, false, 2);
    s.draw(LANTERN, lx - 5, ly - 5, false, 2);
    if (this.strain > 0) s.shake = Math.max(s.shake, 1.5);
    // Darkness with the beam cut out of it.
    const d = this.dark.getContext('2d')!;
    d.globalCompositeOperation = 'source-over';
    d.clearRect(0, 0, W, H);
    d.fillStyle = 'rgba(4,6,14,0.86)';
    d.fillRect(0, 0, W, H);
    d.globalCompositeOperation = 'destination-out';
    const reach = this.flash > 0 ? 120 : 70;
    const spread = this.flash > 0 ? 0.75 : 0.42;
    const grad = d.createRadialGradient(lx, ly, 2, lx, ly, reach);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    d.fillStyle = grad;
    d.beginPath();
    d.moveTo(lx, ly);
    d.arc(lx, ly, reach, this.dir - spread, this.dir + spread);
    d.closePath();
    d.fill();
    d.beginPath();
    d.arc(DOOR.x, DOOR.y, 14, 0, Math.PI * 2);
    d.fill();
    s.g.drawImage(this.dark, 0, 0);
    if (this.flash > 0) s.tint('#fff3c0', this.flash * 0.5);
    // Thermal blip: she always shows on LANTERN's camera. It stops blinking when she stops.
    const warm = Math.max(0, Math.min(1, (g.temp - 28) / 8.6));
    const blip = `rgb(${Math.round(80 + 175 * warm)},${Math.round(120 + 40 * warm)},${Math.round(255 - 200 * warm)})`;
    if (g.down || Math.floor(this.t * 4) % 2) s.frame(gx - 7, gy - 8, 15, 15, blip);
    for (const f of this.snow) s.rect(f.x, f.y, 1, 1, '#ffffff');
    // HUD.
    const len = Math.hypot(this.lx, this.ly);
    s.rect(0, 0, W, 9, '#000');
    s.text(`${len.toFixed(1)}/${CABLE}.0 M`, 3, 2, len > CABLE - 1 ? '#ff6040' : '#ffd040');
    s.text(`${g.temp.toFixed(1)}°`, W - 3, 2, blip, 1, 'right');
    s.draw(LUCY[0], W - 30, 2);
    // Until the first call: the button, by the light.
    if (!this.called && Math.floor(this.t * 2) % 2) {
      s.frame(lx + 8, ly - 14, 9, 9, '#ffd040');
      s.text('A', lx + 11, ly - 12, '#ffd040');
    }
  }
}

export const TETHER_PROGRAM: ProgramInfo = {
  id: 'tether',
  title: 'TETHER',
  blurb: 'YOU ARE LANTERN. FIND HER.',
  year: '2004',
  make: (c) => new Tether(c),
};
