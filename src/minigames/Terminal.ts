import { Chip } from './chip';
import { H, Screen, W } from './pixel';
import { Pad, type Button, type Program, type ProgramInfo } from './Program';
import { PROGRAMS } from './programs';
import './terminal.css';

/**
 * ELEKTRON-30: the old Ironhall training terminal. A full-screen CRT over whatever is
 * underneath (the menu, or the game when you die) that boots, lists its tapes and runs
 * them. Keyboard: arrows / WASD, Space / Enter, Esc. Touch: an on-screen pad.
 */

const KEYS: Record<string, Button> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'a', Enter: 'a', KeyE: 'a', KeyZ: 'a',
};

const GREEN = '#9cf0b0';
const DIM = '#3d6b4a';

type State = 'boot' | 'list' | 'title' | 'run' | 'end';

export class Terminal {
  readonly root: HTMLDivElement;
  private screen = new Screen();
  private chip = new Chip();
  private pad = new Pad();
  private state: State = 'boot';
  private open_ = false;
  private raf = 0;
  private last = 0;
  private t = 0;
  private cursor = 0;
  private program: Program | null = null;
  /** Run one program and close (from a death, or a ?minigame= link). */
  private single: string | null = null;
  private lines: string[] = [];
  private typed = 0;
  private hum: { stop(): void } | null = null;
  /** The tape about to run (its name is shown first, nothing else). */
  private pending: ProgramInfo | null = null;
  /** We asked the browser for full screen (so we give it back on close). */
  private wentFull = false;

  constructor(parent: HTMLElement, private onClose: () => void = () => {}) {
    this.root = document.createElement('div');
    this.root.className = 'term';
    this.root.innerHTML = `<div class="term-tube"><div class="term-glow"></div><div class="term-scan"></div><div class="term-vig"></div></div><div class="term-pad"></div>`;
    this.root.querySelector('.term-tube')!.prepend(this.screen.canvas);
    parent.appendChild(this.root);
    this.buildPad();
    // Desktop has no pad: a plain way out besides Esc (a step back, as Esc: tape → list → menu).
    const exit = document.createElement('button');
    exit.className = 'term-exit';
    exit.innerHTML = '<kbd>Esc</kbd> EXIT';
    exit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.back();
    });
    this.root.appendChild(exit);
    // Dev builds: reachable from the console for poking at a running tape.
    if (import.meta.env.DEV) (window as unknown as { terminal: Terminal }).terminal = this;
    window.addEventListener('resize', () => this.fit());
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Open on the program list, or straight into one program (`id`) and close after it. */
  open(id?: string): void {
    if (this.open_) return;
    this.open_ = true;
    this.single = id && PROGRAMS.some((p) => p.id === id) ? id : null;
    (document.activeElement as HTMLElement | null)?.blur();
    this.root.classList.add('in');
    document.body.classList.add('term-open');
    this.goFull();
    this.fit();
    this.chip.wake();
    this.hum = this.chip.drone(50, 0.025, 'sine', 200);
    this.pad.clear();
    this.state = 'boot';
    this.t = 0;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.program = null;
    this.chip.hush();
    this.hum?.stop();
    this.root.classList.remove('in');
    document.body.classList.remove('term-open');
    if (this.wentFull && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.wentFull = false;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    cancelAnimationFrame(this.raf);
    this.onClose();
  }

  // ------------------------------------------------------------- input

  private onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.code === 'Escape' || e.code === 'Backspace') {
      e.preventDefault();
      this.back();
      return;
    }
    const b = KEYS[e.code];
    if (!b) return;
    e.preventDefault();
    if (!e.repeat) this.pad.press(b);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    e.stopPropagation();
    const b = KEYS[e.code];
    if (!b) return;
    e.preventDefault(); // a focused menu button would take Space / Enter as a click
    this.pad.release(b);
  };

  private back(): void {
    if (this.state === 'run' || this.state === 'end') {
      this.chip.hush();
      if (this.single) return this.close();
      this.toList();
    } else this.close();
  }

  private buildPad(): void {
    const pad = this.root.querySelector('.term-pad')!;
    const make = (label: string, b: Button | 'esc', cls: string) => {
      const el = document.createElement('button');
      el.className = `term-btn ${cls}`;
      el.textContent = label;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.chip.wake();
        if (b === 'esc') this.back();
        else this.pad.press(b);
      });
      const up = () => b !== 'esc' && this.pad.release(b);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('pointercancel', up);
      pad.appendChild(el);
    };
    make('◀', 'left', 'l');
    make('▲', 'up', 'u');
    make('▼', 'down', 'd');
    make('▶', 'right', 'r');
    make('A', 'a', 'a');
    make('ESC', 'esc', 'x');
  }

  /** Browser full screen when opened from a tap or click (it needs one); harmless if refused. */
  private goFull(): void {
    const el = document.documentElement;
    const gesture = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;
    if (document.fullscreenElement || !el.requestFullscreen || !gesture) return;
    this.wentFull = true;
    void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => (this.wentFull = false));
  }

  /**
   * The tube fills the screen (4:3 kept). Integer scale only when it costs under 10%.
   * Touch screens keep a strip for the pad: beside the tube in landscape, under it in portrait.
   */
  private fit(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const touch = document.body.classList.contains('is-touch');
    const portrait = touch && vh > vw;
    const side = touch && !portrait ? Math.min(170, vw * 0.19) : 0;
    const below = portrait ? Math.min(240, vh * 0.34) : 0;
    const k = Math.min((vw - 2 * side) / W, (vh - below) / H);
    const s = k >= 2 && Math.floor(k) / k > 0.9 ? Math.floor(k) : k;
    this.root.classList.toggle('portrait', portrait);
    this.root.style.setProperty('--tw', `${Math.floor(W * s)}px`);
    this.root.style.setProperty('--th', `${Math.floor(H * s)}px`);
    this.root.style.setProperty('--below', `${below}px`);
    this.root.style.setProperty('--b', `${Math.round(portrait ? Math.min(62, vw / 6.5) : side ? Math.min(56, (side - 14) / 3) : 58)}px`);
  }

  // ------------------------------------------------------------- flow

  private setLines(lines: string[]): void {
    this.lines = lines;
    this.typed = 0;
    this.t = 0;
  }

  private toList(): void {
    this.program = null;
    this.state = 'list';
    this.t = 0;
  }

  /** A tape starts on its name alone. */
  private run(info: ProgramInfo): void {
    this.pending = info;
    this.state = 'title';
    this.t = 0;
    this.chip.beep(880, 0.05, 0.12);
  }

  private start(info: ProgramInfo): void {
    this.pending = null;
    this.chip.hush();
    this.hum = this.chip.drone(50, 0.025, 'sine', 200);
    this.program = info.make({ chip: this.chip, pad: this.pad });
    this.state = 'run';
    this.t = 0;
  }

  private frame = (now: number): void => {
    if (!this.open_) return;
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.t += dt;
    this.screen.begin(dt);
    switch (this.state) {
      case 'boot':
        // A blank warm-up, no text.
        this.screen.clear('#020403');
        if (this.t > 0.35) {
          if (this.single) this.run(PROGRAMS.find((p) => p.id === this.single)!);
          else this.toList();
        }
        break;
      case 'title': {
        const info = this.pending!;
        this.screen.clear('#000');
        if (this.t > 0.15 && this.t < 1.5) this.screen.text(info.title, W / 2, H / 2 - 5, GREEN, 2, 'center');
        if (this.t > 1.7 || (this.t > 0.3 && this.pad.hit('a'))) this.start(info);
        break;
      }
      case 'list':
        this.list();
        break;
      case 'run':
        this.program!.update(dt);
        this.program!.draw(this.screen);
        if (this.program!.done) {
          this.chip.hush();
          this.setLines(this.program!.ending);
          this.state = 'end';
        }
        break;
      case 'end':
        this.typeOut(dt, 26);
        this.screen.clear('#000');
        this.drawLines(GREEN, 18);
        if (this.typed >= this.chars() && Math.floor(this.t * 2) % 2) this.screen.text('A', W / 2, H - 12, DIM, 1, 'center');
        if (this.pad.hit('a')) {
          if (this.typed < this.chars()) this.typed = this.chars();
          else if (this.single) this.close();
          else this.toList();
        }
        break;
    }
    this.pad.endFrame();
    this.raf = requestAnimationFrame(this.frame);
  };

  private chars(): number {
    return this.lines.reduce((n, l) => n + l.length + 4, 0);
  }

  private typeOut(dt: number, cps: number): void {
    const before = Math.floor(this.typed);
    this.typed = Math.min(this.chars(), this.typed + dt * cps);
    if (Math.floor(this.typed) !== before && Math.floor(this.typed) % 3 === 0) this.chip.beep(1800 + Math.random() * 300, 0.012, 0.03);
  }

  private drawLines(c = GREEN, y0 = 8): void {
    let left = Math.floor(this.typed);
    let y = y0;
    for (const l of this.lines) {
      if (left <= 0) break;
      const shown = l.slice(0, left);
      const h = this.screen.para(shown, 8, y, W - 16, c);
      y += Math.max(7, h) + 2;
      left -= l.length + 4;
    }
  }

  private list(): void {
    const s = this.screen;
    const n = PROGRAMS.length;
    if (this.pad.hit('down')) {
      this.cursor = (this.cursor + 1) % n;
      this.chip.beep(660, 0.03, 0.1);
    }
    if (this.pad.hit('up')) {
      this.cursor = (this.cursor - 1 + n) % n;
      this.chip.beep(660, 0.03, 0.1);
    }
    s.clear('#020403');
    // Names and years only.
    const y0 = Math.round((H - n * 13) / 2);
    PROGRAMS.forEach((p, i) => {
      const y = y0 + i * 13;
      const on = i === this.cursor;
      if (on) s.rect(6, y - 2, W - 12, 11, '#0f2a18');
      s.text(`${on ? '>' : ' '} ${p.title}`, 8, y, on ? GREEN : DIM);
      s.text(p.year, W - 10, y, on ? GREEN : DIM, 1, 'right');
    });
    if (this.pad.hit('a')) this.run(PROGRAMS[this.cursor]);
  }
}
