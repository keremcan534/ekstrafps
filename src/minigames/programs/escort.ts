import { hz, type Drone } from '../chip';
import { H, Screen, W, sprite } from '../pixel';
import type { Ctx, Program, ProgramInfo } from '../Program';

/**
 * ESCORT (2041). A tape that should not exist: Site-9, the night the Warden walks in at
 * the head of SABLE. You walk it down the corridor to gate 4 (RIGHT; it walks on its
 * own if you stop). Every guard it passes dies of an equipment failure KNOT's boxes
 * counted down to. No words: crushed voices, numbers and the boxes.
 */

const FLOOR = 118;
const TOP = 12;
const HUD = 10;
const WORLD = 1230;
const GATE = 1170;
const SPEED = 20;
const DATA = '#bfe8ff';

// Sprites follow the game's character models (public/chars): Vanta security in navy with
// a helmet and dark carrier; SABLE in snow-white parkas, dark carriers and NVG helmets;
// the Warden in a long black greatcoat, peaked cap and gas mask, rifle with wood furniture.
const GUARD_PAL = { H: '#1c2434', f: '#c89878', n: '#26304a', v: '#12161c', b: '#3a70d0', k: '#0c0d10' };
const FROZEN_PAL = { H: '#9fc8e8', f: '#d8ecff', n: '#c8e4ff', v: '#7aa0c8', b: '#e8f4ff', k: '#5a7a9a' };
const GUARD_ROWS = ['..HHH..', '.HHHHH.', '.HfffH.', '..fvf..', '.nnnnn.', 'nnvvvnn', 'nnvbvnn', 'f.vvv.f', '..vvv..', '..n.n..', '..n.n..', '..n.n..', '..k.k..', '.kk.kk.'];
const PALM_ROWS = ['..HHH..f', '.HHHHH.f', '.HfffH.n', '..fvf.nn', '.nnnnnn.', 'nnvvvn..', 'nnvbvn..', 'f.vvv...', '..vvv...', '..n.n...', '..n.n...', '..n.n...', '..k.k...', '.kk.kk..'];
const FALLEN_ROWS = ['...........HH.', 'kknnnnvvbvnffH', 'kknnnnvvvvnffH'];
const GUARD = sprite(GUARD_ROWS, GUARD_PAL);
const GUARD_PALM = sprite(PALM_ROWS, GUARD_PAL);
const GUARD_FALLEN = sprite(FALLEN_ROWS, GUARD_PAL);
const GUARD_ICE = sprite(GUARD_ROWS, FROZEN_PAL);
const GUARD_ICE_FALLEN = sprite(FALLEN_ROWS, FROZEN_PAL);

// The greatcoat is frosted like the menu art; f = rime, O = lamplit edge.
const WARDEN_PAL = { c: '#22252a', b: '#0a0b0d', y: '#8a7a4a', m: '#0e1012', l: '#5a6a72', F: '#2a2c30', o: '#23262b', O: '#3c4048', f: '#7a838e', h: '#0c0c0c', w: '#6a4426', g: '#30333a', k: '#08090a' };
const WARDEN_TOP = ['...cfccc...', '..cccyccf..', '.bbbbbbbbb.', '...mmmmm...', '...lmmml...', '....mFm....', '.fOoooooOf.', '.ofOoyoOooO', '.oooofyoofO', 'ooooowwwwgg', 'h.oofyoo.Oh', '..ooooofoO.', '..ofoooooO.'];
const WARDEN_SPR = [
  sprite([...WARDEN_TOP, '..ofo.oooO.', '...kk.kk...', '...kk.kk...'], WARDEN_PAL),
  sprite([...WARDEN_TOP, '..oofo.oO..', '..kk...kk..', '..kk...kk..'], WARDEN_PAL),
];
const OP_PAL = { n: '#0c0c0e', h: '#a8aeb4', w: '#c4c9ce', s: '#868e96', k: '#141518', p: '#2a2e34', g: '#1a1c1e', b: '#2a2420' };
const OP_TOP = ['...nn......', '..hhhh.....', '.wskkww....', '.wwkksw....', 'wswwwwsw...', 'wwppppwgggg', 'swppppws...', 'wsppppww...', '.wwswws....'];
const OP = [
  sprite([...OP_TOP, '.ws..ww....', '.ww..sw....', '.sw..ww....', '.bb..bb....'], OP_PAL),
  sprite([...OP_TOP, '..ws.ww....', '.ww...sw...', '.sw...ww...', '.bb...bb...'], OP_PAL),
];
const HAULER = sprite(['.yyyyyy...', '.yddddy...', '.yddddy...', 'yyyyyyyy..', 'yYYYYYYy..', 'yYYYYYYyff', 'yYYYYYYy.f', 'yyyyyyyy.f', '.oo..oo..f', '.oo..oo.ff'], { y: '#8a6a10', Y: '#d8b030', d: '#202020', o: '#101010', f: '#6a6e74' });

/** A march for the escort, one note per step: it only plays while the Warden walks. */
const MARCH = ['E4', 'B4', 'G4', 'B4', 'E4', 'B4', 'F#4', 'B4', 'E4', 'C5', 'B4', 'A4', 'G4', 'F#4', 'E4', 'D#4'];

const V = (id: string) => `audio/voice/${id}.mp3`;
/** The Warden's voice, crushed to 4 bits. */
const WARDEN = { rate: 5200, bits: 4, vol: 0.7, pitch: 0.9 };
const GUARD_VOICE = { rate: 7000, bits: 5, vol: 0.45 };
const RADIO = { rate: 4200, bits: 3, vol: 0.4 };

type Death = 'door' | 'turret' | 'dark' | 'hauler' | 'cryo' | 'lift' | 'last';
/** How far ahead of the Warden each one starts, so it is over before the Warden reaches the body. */
const REACH: Record<Death, number> = { door: 34, turret: 50, dark: 44, hauler: 36, cryo: 64, lift: 56, last: -999 };
interface Guard {
  x: number;
  kind: Death;
  /** 0 on post, 1 alarmed (palm up), 2 dying, 3 dead. */
  state: number;
  t: number;
  plead: string;
}

class Escort implements Program {
  done = false;
  ending = ['ELEKTRON-30 // ESCORT', 'SITE-9, GATE 4. ON SHIFT: 7. AT 06:00: 0.', 'CAUSE: EQUIPMENT FAILURE (7).'];
  private t = 0;
  private x = 30;
  private walking = false;
  private walkT = 0;
  private idle = 0;
  private stepT = 0;
  private stepN = 0;
  private moved = false;
  private temp = -4;
  private guards: Guard[] = [
    { x: 210, kind: 'door', state: 0, t: 0, plead: 'civ_plead_00' },
    { x: 360, kind: 'turret', state: 0, t: 0, plead: 'civ_plead_10' },
    { x: 510, kind: 'dark', state: 0, t: 0, plead: 'civ_plead_20' },
    { x: 660, kind: 'hauler', state: 0, t: 0, plead: 'civ_plead_30' },
    { x: 810, kind: 'cryo', state: 0, t: 0, plead: 'civ_plead_40' },
    { x: 960, kind: 'lift', state: 0, t: 0, plead: '' },
    { x: 1120, kind: 'last', state: 0, t: 0, plead: 'civ_plead_50' },
  ];
  private frost: [number, number][] = [];
  private vapor: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  private flash = 0;
  private lightsOff = 0;
  private radioT = 0;
  /** The last stretch: the control room, then the gate. */
  private final = -1;
  private gate = 0;
  private drone: Drone | null = null;
  /** Where the rime forms on the control-room glass. */
  private rime = Array.from({ length: 300 }, () => [Math.random() * 40, Math.random() * 34]);

  constructor(private c: Ctx) {
    const { chip } = c;
    for (const id of ['warden_menu_early', 'warden_menu_door', 'warden_menu_standing', 'warden_menu_warm', 'warden_menu_proceed', 'warden_menu_ends', 'commander_kill_09'])
      void chip.loadVoice(V(id), WARDEN.rate, WARDEN.bits);
    for (const g of this.guards) if (g.plead) void chip.loadVoice(V(g.plead), GUARD_VOICE.rate, GUARD_VOICE.bits);
    void chip.loadVoice(V('bd_target_down'), RADIO.rate, RADIO.bits);
    void chip.loadVoice(V('civ_panic_11'), GUARD_VOICE.rate, GUARD_VOICE.bits);
    this.drone = chip.drone(55, 0.03, 'sawtooth', 180);
    chip.voice(V('warden_menu_early'), { ...WARDEN, delay: 1.2 });
  }

  private warden(id: string, delay = 0): void {
    this.c.chip.voice(V(id), { ...WARDEN, delay });
  }

  update(dt: number): void {
    const { pad, chip } = this.c;
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.lightsOff = Math.max(0, this.lightsOff - dt);
    this.radioT = Math.max(0, this.radioT - dt);
    // You walk it, or it walks itself.
    const want = pad.held('right');
    if (want) this.moved = true;
    this.idle = want ? 0 : this.idle + dt;
    this.walking = this.final < 0 ? want || this.idle > 3.5 : this.final > 10;
    if (this.walking) {
      this.x = Math.min(this.final < 0 ? WORLD : WORLD + 40, this.x + SPEED * dt);
      this.walkT += dt;
      this.stepT -= dt;
      if (this.stepT <= 0) this.step();
    }
    for (const g of this.guards) this.guardTick(g, dt);
    for (const v of this.vapor) {
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.life -= dt;
    }
    this.vapor = this.vapor.filter((v) => v.life > 0);
    if (this.final >= 0) this.finale(dt);
    else if (this.x >= this.guards[6].x - 46) {
      this.final = 0;
      this.drone?.set(40, 0.05);
      chip.voice(V('civ_plead_50'), { ...RADIO, vol: 0.5, delay: 0.3 });
      this.radioT = 2.4;
    }
  }

  private step(): void {
    const { chip } = this.c;
    this.stepT = 0.55;
    chip.noise(0.12, 0.35, 180, 1);
    chip.beep(48, 0.15, 0.25, 'sine', 35);
    chip.noise(0.04, 0.08, 900, 2, 0.12);
    const f = hz(MARCH[this.stepN++ % MARCH.length]);
    chip.beep(f, 0.5, 0.035, 'triangle');
    chip.beep(f * 2, 0.2, 0.01, 'sine');
    this.frost.push([this.x + (this.stepN % 2 ? -3 : 4), FLOOR + 1]);
    if (this.frost.length > 160) this.frost.shift();
  }

  private guardTick(g: Guard, dt: number): void {
    const { chip } = this.c;
    g.t += dt;
    const near = g.x - this.x;
    if (g.state === 0 && near < 84 && g.kind !== 'lift') {
      g.state = 1;
      g.t = 0;
      if (g.plead && g.kind !== 'last') chip.voice(V(g.plead), GUARD_VOICE);
      chip.beep(880, 0.08, 0.04, 'square');
    }
    if (g.state <= 1 && near < REACH[g.kind]) {
      g.state = 2;
      g.t = 0;
      this.die(g);
    }
    if (g.state >= 2 && g.t < 3) this.dying(g, dt);
  }

  /** The moment it starts: each one is a different machine. */
  private die(g: Guard): void {
    const { chip } = this.c;
    switch (g.kind) {
      case 'door':
        chip.beep(660, 0.1, 0.06, 'square');
        chip.beep(660, 0.1, 0.06, 'square', undefined, 0.15);
        break;
      case 'turret':
        chip.beep(1200, 0.4, 0.04, 'sawtooth', 1800);
        break;
      case 'dark':
        this.lightsOff = 1.3;
        chip.beep(110, 0.3, 0.2, 'square', 40);
        break;
      case 'hauler':
        chip.beep(440, 0.12, 0.08, 'square');
        chip.beep(440, 0.12, 0.08, 'square', undefined, 0.2);
        break;
      case 'cryo':
        chip.noise(1.4, 0.3, 5000, 0.4);
        break;
      case 'lift':
        chip.beep(1046, 0.4, 0.07, 'triangle');
        chip.beep(784, 0.6, 0.07, 'triangle', undefined, 0.3);
        break;
    }
  }

  private dying(g: Guard, dt: number): void {
    const { chip } = this.c;
    const t = g.t;
    const once = (at: number, fn: () => void) => {
      if (t >= at && t - dt < at) fn();
    };
    switch (g.kind) {
      case 'door':
        once(0.35, () => {
          chip.noise(0.3, 0.8, 200, 1);
          chip.beep(60, 0.3, 0.3, 'square', 35);
          this.flash = 0.08;
        });
        once(1.1, () => this.warden('warden_menu_door'));
        if (t > 1.2) this.dead(g);
        break;
      case 'turret':
        for (const at of [0.6, 0.72, 0.84]) once(at, () => {
          chip.noise(0.06, 0.6, 2500, 1);
          this.flash = 0.04;
        });
        once(1.5, () => this.warden('warden_menu_standing'));
        if (t > 1) this.dead(g);
        break;
      case 'dark':
        for (const at of [0.5, 0.66]) once(at, () => chip.noise(0.08, 0.7, 1800, 1));
        once(1.5, () => chip.voice(V('bd_target_down'), RADIO));
        if (t > 1.3) this.dead(g);
        break;
      case 'hauler':
        once(0.45, () => {
          chip.noise(0.2, 0.7, 300, 1);
          this.flash = 0.06;
        });
        once(1.3, () => this.warden('commander_kill_09'));
        if (t > 0.5) this.dead(g);
        break;
      case 'cryo':
        if (t < 1.2)
          for (let i = 0; i < 3; i++)
            this.vapor.push({ x: g.x - 14, y: 62 + Math.random() * 4, vx: 30 + Math.random() * 40, vy: -6 + Math.random() * 30, life: 0.8 + Math.random() * 0.6 });
        once(1.7, () => {
          chip.noise(0.15, 0.6, 1500, 0.8);
          chip.beep(70, 0.2, 0.2, 'square', 40);
        });
        once(2.2, () => this.warden('warden_menu_warm'));
        if (t > 1.7) this.dead(g);
        break;
      case 'lift':
        once(0.9, () => chip.voice(V('civ_panic_11'), { ...GUARD_VOICE, vol: 0.35 }));
        once(2.4, () => this.warden('warden_menu_proceed'));
        if (t > 1.6) this.dead(g);
        break;
    }
  }

  private dead(g: Guard): void {
    if (g.state === 3) return;
    g.state = 3;
    this.temp -= 4.5;
    this.c.chip.beep(1200, 0.05, 0.04, 'square');
  }

  /** The control room: the Warden stops, the glass frosts over, the gate opens. */
  private finale(dt: number): void {
    const { chip } = this.c;
    const before = this.final;
    this.final += dt;
    const at = (s: number) => before < s && this.final >= s;
    const g = this.guards[6];
    if (at(1.2)) chip.beep(46, 2.5, 0.2, 'sawtooth', 36);
    if (at(3.6)) {
      chip.noise(0.3, 0.2, 400, 0.6);
      g.state = 2;
      g.t = 0;
    }
    if (at(4.4)) this.dead(g);
    if (at(5.2)) this.warden('warden_menu_ends');
    if (at(8)) chip.noise(2.2, 0.25, 120, 0.4);
    if (this.final > 8) this.gate = Math.min(1, this.gate + dt / 2);
    if (this.final > 14.5) this.done = true;
  }

  // ------------------------------------------------------------- draw

  draw(s: Screen): void {
    const camX = Math.max(0, Math.min(WORLD - W, Math.round(this.x - 64)));
    s.clear('#0a0c10');
    this.drawCorridor(s, camX);
    for (const g of this.guards) this.drawProp(s, g, camX, false);
    for (const g of this.guards) this.drawGuard(s, g, camX);
    for (const g of this.guards) this.drawProp(s, g, camX, true);
    // Frost where it stepped.
    for (const [fx, fy] of this.frost) s.rect(fx - camX, fy, 2, 1, '#9fc8e8');
    // SABLE behind it, rifle lights on.
    const f = this.walking ? Math.floor(this.walkT * 4) % 2 : 0;
    for (let i = 0; i < 4; i++) {
      const ox = this.x - 26 - i * 16 - camX;
      s.draw(OP[(f + i) % 2], ox - 10, FLOOR - 26, false, 2);
      s.rect(ox + 12, FLOOR - 15, 1, 1, '#ffffff');
    }
    s.draw(WARDEN_SPR[f], this.x - 11 - camX, FLOOR - 32, false, 2);
    for (const v of this.vapor) s.rect(v.x - camX, v.y, 2, 2, v.life > 0.4 ? '#e8f4ff' : '#8aa8c8');
    // Lights out: only the mask's lenses and the rifle lights.
    if (this.lightsOff > 0) {
      s.clear('#000');
      s.rect(this.x - 11 - camX + 6, FLOOR - 32 + 8, 2, 2, '#6a7a80');
      s.rect(this.x - 11 - camX + 14, FLOOR - 32 + 8, 2, 2, '#6a7a80');
      for (let i = 0; i < 4; i++) s.rect(this.x - 26 - i * 16 - camX + 12, FLOOR - 15, 1, 1, '#ffffff');
      const g = this.guards[2];
      if (g.t > 0.5 && g.t < 0.58) s.line(this.x - 26 - camX + 13, FLOOR - 15, g.x - camX, FLOOR - 18, '#fff4c0');
      if (g.t > 0.66 && g.t < 0.74) s.line(this.x - 26 - camX + 13, FLOOR - 15, g.x - camX, FLOOR - 20, '#fff4c0');
    }
    // KNOT's boxes: how long each one has left.
    for (const g of this.guards) {
      if (g.state >= 2 || g.kind === 'last') continue;
      const eta = Math.max(0, (g.x - REACH[g.kind] - this.x) / SPEED);
      if (eta > 6 || g.x - this.x > 150) continue;
      this.box(s, g.x - camX, FLOOR, 18, 32, eta.toFixed(1));
    }
    if (this.final >= 0 && this.guards[6].state < 3) this.box(s, this.guards[6].x - camX + 12, 84, 18, 30, '0.0');
    if (this.flash > 0) s.tint('#ffffff', 0.4);
    if (this.final > 11) s.tint('#000000', Math.min(1, (this.final - 11) / 2.5));
    this.drawHud(s);
    if (!this.moved && this.t > 1.5 && Math.floor(this.t * 3) % 2) {
      const ax = this.x - camX + 18;
      for (let i = 0; i < 3; i++) s.rect(ax + i, FLOOR - 24 - (2 - i), 1, 1 + (2 - i) * 2, '#ffd040');
    }
  }

  private drawCorridor(s: Screen, camX: number): void {
    s.rect(0, TOP, W, FLOOR - TOP, '#1a2028');
    for (let x = -(camX % 32); x < W; x += 32) s.rect(x, TOP, 1, FLOOR - TOP, '#141920');
    s.rect(0, 92, W, 3, '#8a7a20');
    s.rect(0, 95, W, 1, '#3a3410');
    s.rect(0, FLOOR, W, H - FLOOR, '#12151a');
    s.rect(0, FLOOR, W, 1, '#3a4250');
    for (let x = -(camX % 24); x < W; x += 24) s.rect(x, FLOOR + 6, 12, 1, '#1a1e24');
    // Ceiling lamps; they stutter as it passes under them.
    for (let lx = 20; lx < WORLD; lx += 48) {
      const sx = lx - camX;
      if (sx < -20 || sx > W + 20) continue;
      const by = Math.abs(lx - this.x) < 26 && Math.random() < 0.5;
      s.rect(sx - 8, TOP, 16, 2, by ? '#2a2e34' : '#d8e0e8');
      if (!by) {
        s.g.globalAlpha = 0.05;
        s.g.fillStyle = '#d8e8ff';
        s.g.beginPath();
        s.g.moveTo(sx - 8, TOP + 2);
        s.g.lineTo(sx + 8, TOP + 2);
        s.g.lineTo(sx + 22, FLOOR);
        s.g.lineTo(sx - 22, FLOOR);
        s.g.fill();
        s.g.globalAlpha = 1;
      }
    }
    // Gate 4.
    const gx = GATE - camX;
    if (gx < W + 10) {
      s.rect(gx - 4, TOP, 52, FLOOR - TOP, '#0e1014');
      s.rect(gx, TOP + 4, 44, FLOOR - TOP - 4, '#400808');
      const lift = Math.round((FLOOR - TOP - 4) * this.gate);
      s.rect(gx, TOP + 4, 44, FLOOR - TOP - 4 - lift, '#4a4e56');
      for (let y = TOP + 8; y < FLOOR - lift; y += 8) s.rect(gx, y, 44, 1, '#3a3e44');
      s.rect(gx + 18, TOP + 30, 8, 8, this.gate > 0 ? '#ff3020' : '#20ff60');
    }
  }

  /** The machine beside each post; `front` draws the parts that cover the guard. */
  private drawProp(s: Screen, g: Guard, camX: number, front: boolean): void {
    const x = g.x - camX;
    if (x < -90 || x > W + 90) return;
    const t = g.state >= 2 ? g.t : 0;
    switch (g.kind) {
      case 'door': {
        if (!front) {
          s.rect(x - 10, 48, 24, FLOOR - 48, '#0c0f14');
          s.rect(x - 12, 46, 28, 2, '#3a3e44');
          if (g.state >= 1 && g.state < 3 && Math.floor(this.t * 6) % 2) s.rect(x + 1, 40, 3, 3, '#ffb020');
          return;
        }
        const drop = g.state >= 2 ? Math.min(1, Math.max(0, (t - 0.2) / 0.15)) : 0;
        const h = Math.round((FLOOR - 48) * drop);
        if (h > 0) {
          s.rect(x - 10, 48, 24, h, '#5a5e66');
          for (let i = 0; i < 24; i += 6) s.rect(x - 10 + i, 48 + h - 4, 3, 4, '#c8a020');
        }
        return;
      }
      case 'turret': {
        if (front) return;
        s.rect(x - 3, TOP, 6, 6, '#2a2e34');
        s.rect(x - 5, TOP + 6, 10, 6, '#3a3e44');
        const aim = g.state >= 2 ? Math.min(1, t / 0.5) : 0;
        const ex = x + 4 + aim * -2;
        const ey = TOP + 9 + aim * 6;
        s.line(x, TOP + 9, ex, ey, '#6a6e74');
        if (g.state === 2 && t > 0.2) s.line(ex, ey, x, FLOOR - 22, 'rgba(255,40,40,0.8)');
        if (g.state >= 2 && [0.6, 0.72, 0.84].some((a) => t > a && t < a + 0.05)) s.rect(ex - 1, ey - 1, 3, 3, '#fff4c0');
        return;
      }
      case 'hauler': {
        if (!front) {
          s.rect(x + 50, 56, 30, FLOOR - 56, '#080a0e');
          s.rect(x + 48, 54, 34, 2, '#8a7a20');
          return;
        }
        const hx = g.state >= 2 ? Math.max(x + 6, x + 54 - t * 110) : x + 54;
        const sh = g.state >= 2 && t > 0.45 && t < 0.7 ? Math.round((Math.random() - 0.5) * 2) : 0;
        s.draw(HAULER, hx + sh, FLOOR - 20, true, 2);
        if (g.state >= 2 && Math.floor(this.t * 8) % 2) s.rect(hx + 8, FLOOR - 24, 3, 3, '#ffb020');
        return;
      }
      case 'cryo': {
        if (front) return;
        s.rect(x - 60, 60, 120, 4, '#5a6e7a');
        s.rect(x - 16, 57, 6, 10, '#7a8e9a');
        if (g.state >= 2 && t < 1.4) s.rect(x - 14, 58, 2, 8, '#ffffff');
        return;
      }
      case 'lift': {
        if (front) return;
        const lx = x + 8;
        s.rect(lx - 2, 44, 26, FLOOR - 44, '#2a2e34');
        const open = g.state >= 2 ? Math.min(1, t / 0.5) * (t > 2.2 ? Math.max(0, 1 - (t - 2.2) / 0.5) : 1) : 0;
        s.rect(lx, 46, 22, FLOOR - 46, '#000');
        const half = Math.round(11 * (1 - open));
        s.rect(lx, 46, half, FLOOR - 46, '#6a6e74');
        s.rect(lx + 22 - half, 46, half, FLOOR - 46, '#6a6e74');
        s.rect(lx + 9, 38, 4, 4, g.state >= 2 ? '#20ff60' : '#402010');
        return;
      }
      case 'last': {
        if (front) {
          // The glass frosts over from the edges.
          const k = this.final < 0 ? 0 : Math.min(1, Math.max(0, (this.final - 1) / 3));
          if (k > 0) {
            s.g.save();
            s.g.beginPath();
            s.g.rect(x - 6, 52, 40, 34);
            s.g.clip();
            for (const [rx, ry] of this.rime) {
              const fx = x - 6 + rx;
              const fy = 52 + ry;
              const edge = Math.min(fx - (x - 6), x + 34 - fx, fy - 52, 86 - fy) / 17;
              if (edge < k * 1.3) s.rect(fx, fy, 2, 2, '#d8ecff');
            }
            s.tint('#c8e4ff', k * 0.35);
            s.g.restore();
          }
          s.frame(x - 7, 51, 42, 36, '#5a6e7a');
          if (this.radioT > 0) this.drawRadio(s, x + 26, 42);
          return;
        }
        s.rect(x - 6, 52, 40, 34, '#0c1a22');
        s.rect(x - 6, 80, 40, 6, '#2a3038');
        return;
      }
    }
  }

  private drawGuard(s: Screen, g: Guard, camX: number): void {
    const x = g.x - camX;
    if (x < -40 || x > W + 40) return;
    const dying = g.state === 2 ? g.t : g.state === 3 ? 99 : -1;
    const shake = g.state === 1 ? Math.round((Math.random() - 0.5) * 1.4) : 0;
    switch (g.kind) {
      case 'door':
        if (dying < 0.35) s.draw(g.state === 1 ? GUARD_PALM : GUARD, x - 6 + shake, FLOOR - 28, true, 2);
        return;
      case 'lift': {
        // Waits facing the lift; when it opens, he steps in.
        const into = dying < 0 ? 0 : Math.min(1, dying / 0.8);
        const fall = dying < 0.8 ? 0 : (dying - 0.8) * (dying - 0.8) * 220;
        if (fall > 60) return;
        s.g.save();
        if (fall > 0) {
          s.g.beginPath();
          s.g.rect(x + 8, 46, 22, H - 46);
          s.g.clip();
        }
        s.draw(GUARD, x - 6 + into * 20, FLOOR - 28 + fall, false, 2);
        s.g.restore();
        return;
      }
      case 'last': {
        const down = this.final > 3.6 ? Math.min(1, (this.final - 3.6) / 0.6) : 0;
        s.g.save();
        s.g.beginPath();
        s.g.rect(x - 6, 52, 40, 28);
        s.g.clip();
        s.draw(this.final > 0 && this.final < 3.6 ? GUARD_PALM : GUARD, x + 6 + shake, 56 + down * 26, false, 2);
        s.g.restore();
        return;
      }
    }
    const frozen = g.kind === 'cryo' && dying > 0.8;
    if (dying < 0 || (g.kind === 'cryo' && dying < 1.7) || (g.kind === 'turret' && dying < 1) || (g.kind === 'dark' && dying < 1.3) || (g.kind === 'hauler' && dying < 0.45)) {
      const spr = frozen ? GUARD_ICE : g.state === 1 || (g.state === 2 && g.kind !== 'cryo') ? GUARD_PALM : GUARD;
      s.draw(spr, x - 6 + (frozen ? 0 : shake), FLOOR - 28, true, 2);
      return;
    }
    const pushed = g.kind === 'hauler' ? -26 : 0;
    if (g.kind !== 'cryo') s.rect(x - 10 + pushed, FLOOR - 1, 16, 2, '#3a0a0a');
    s.draw(frozen ? GUARD_ICE_FALLEN : GUARD_FALLEN, x - 14 + pushed, FLOOR - 6, true, 2);
  }

  /** KNOT's dashed box, with a number over it. */
  private box(s: Screen, cx: number, foot: number, w: number, h: number, label: string): void {
    const x = Math.round(cx - w / 2);
    const y = foot - h;
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
    s.text(label, cx, y - 7, c, 1, 'center');
  }

  private drawRadio(s: Screen, x: number, y: number): void {
    s.rect(x, y + 2, 6, 4, '#ffc860');
    s.rect(x + 1, y + 3, 2, 2, '#000');
    s.rect(x + 4, y, 1, 2, '#ffc860');
    const w = Math.floor(this.t * 8) % 3;
    for (let i = 0; i <= w; i++) s.rect(x + 8 + i * 2, y + 3 - i, 1, 2 + i * 2, '#ffc860');
  }

  /** Temperature, and a figure for every guard on shift. */
  private drawHud(s: Screen): void {
    s.rect(0, 0, W, HUD, '#000');
    s.rect(0, HUD - 1, W, 1, '#1e2228');
    const cold = this.temp <= -30;
    s.rect(3, 1, 1, 5, '#5a6a7a');
    s.rect(2, 5, 3, 3, cold ? '#ff5050' : '#9fd3ff');
    s.text(`${this.temp.toFixed(1)}°`, 8, 2, cold ? '#ff5050' : '#9fd3ff');
    const x0 = Math.round(W / 2 - this.guards.length * 3);
    this.guards.forEach((g, i) => {
      const c = g.state === 3 ? '#3a1414' : '#b8bec8';
      const px = x0 + i * 6;
      s.rect(px + 1, 1, 2, 2, c);
      s.rect(px, 3, 4, 3, c);
      s.rect(px, 6, 1, 2, c);
      s.rect(px + 3, 6, 1, 2, c);
    });
  }
}

export const ESCORT_PROGRAM: ProgramInfo = {
  id: 'escort',
  title: 'ESCORT',
  blurb: 'ESCORT THE UNIT TO GATE 4.',
  year: '2041',
  make: (c) => new Escort(c),
};
