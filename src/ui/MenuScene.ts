/**
 * The main menu's stage: a photograph instead of a live 3D render (the GPU idles in the
 * menu). The Warden in a misty night forest, three aligned plates of the same frame
 * (standing, aiming, and the field without him), and what keeps it alive for almost
 * nothing: snow in two depths on 2D canvases, and ground mist drifting. Every so often
 * he is simply not there any more, and later he is back.
 */

import type { MenuWardenVoice } from '../audio/MenuWardenVoice';

interface Flake {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  a: number;
}

class Snow {
  private flakes: Flake[] = [];
  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private sprite: HTMLCanvasElement;

  constructor(
    private canvas: HTMLCanvasElement,
    count: number,
    private size: [number, number],
    private speed: [number, number],
    private alpha: [number, number],
    private dpr: number,
  ) {
    this.g = canvas.getContext('2d')!;
    // One soft flake, drawn once; every flake is this sprite scaled.
    this.sprite = document.createElement('canvas');
    this.sprite.width = this.sprite.height = 32;
    const s = this.sprite.getContext('2d')!;
    const gr = s.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(235,240,250,1)');
    gr.addColorStop(0.35, 'rgba(225,232,245,0.75)');
    gr.addColorStop(1, 'rgba(220,228,242,0)');
    s.fillStyle = gr;
    s.fillRect(0, 0, 32, 32);
    this.resize();
    for (let i = 0; i < count; i++) this.flakes.push(this.spawn(true));
  }

  private spawn(anywhere: boolean): Flake {
    const k = Math.random();
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -20,
      r: (this.size[0] + (this.size[1] - this.size[0]) * k * k) * this.dpr,
      vy: (this.speed[0] + (this.speed[1] - this.speed[0]) * k) * this.dpr,
      sway: (6 + Math.random() * 18) * this.dpr,
      phase: Math.random() * Math.PI * 2,
      a: this.alpha[0] + (this.alpha[1] - this.alpha[0]) * Math.random(),
    };
  }

  resize(): void {
    // Screen pixels, not CSS: phones zoom the menu, so clientWidth would overshoot the screen.
    const w = Math.round(window.innerWidth * this.dpr);
    const h = Math.round(window.innerHeight * this.dpr);
    if (w === this.w && h === this.h) return;
    for (const f of this.flakes) {
      f.x *= w / (this.w || w);
      f.y *= h / (this.h || h);
    }
    this.canvas.width = this.w = w;
    this.canvas.height = this.h = h;
  }

  step(dt: number, t: number, wind: number): void {
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);
    for (let i = 0; i < this.flakes.length; i++) {
      const f = this.flakes[i];
      f.y += f.vy * dt;
      f.x += wind * f.vy * 0.35 * dt;
      if (f.y > this.h + 20 || f.x < -40 || f.x > this.w + 40) {
        this.flakes[i] = this.spawn(false);
        if (f.x < -40) this.flakes[i].x = this.w + 20;
        continue;
      }
      const x = f.x + Math.sin(t * 0.7 + f.phase) * f.sway;
      g.globalAlpha = f.a;
      g.drawImage(this.sprite, x - f.r, f.y - f.r, f.r * 2, f.r * 2);
    }
    g.globalAlpha = 1;
  }
}

type Plate = 'stand' | 'aim' | 'gone';
/** Same frame, same forest (public/menu): only the Warden changes. */
const PLATES: Record<Plate, string> = { stand: 'warden_stand', aim: 'warden_aim', gone: 'forest' };
/** Seconds of menu time a plate holds: him, then the empty field. */
const HOLD: Record<'here' | 'gone', [number, number]> = { here: [7, 12], gone: [4, 9] };
/** Chance a beat takes him away rather than changing his pose. */
const VANISH = 0.42;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class MenuScene {
  readonly root: HTMLDivElement;
  private back: Snow;
  private front: Snow;
  private raf = 0;
  private last = 0;
  private next = 0;
  private t0 = performance.now();
  private stage: HTMLDivElement;
  private plates = {} as Record<Plate, HTMLImageElement>;
  private state: Plate = 'stand';
  /** Menu seconds until the next beat (only counts while the menu is up). */
  private wait = rand(...HOLD.here);
  private beats = 0;
  private staged = false;
  /** Bumped by every transition; pending timers of an older one drop out. */
  private seq = 0;
  /** When the player looked away (window blurred, tab hidden, a match), or 0. */
  private away = 0;
  /** The stage has been up before (so coming back to it is a return from a match). */
  private seen = false;

  constructor(
    parent: HTMLElement,
    mobile: boolean,
    private active: () => boolean,
    /** His breathing, his lines and the subtitles (optional: the stage works silent). */
    private voice?: MenuWardenVoice,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu-scene';
    const imgs = (Object.keys(PLATES) as Plate[])
      .map((k) => `<img class="ms-plate" data-p="${k}" alt="" draggable="false" />`)
      .join('');
    this.root.innerHTML = `
      <div class="ms-plates">${imgs}<div class="ms-tear"></div></div>
      <div class="ms-mist far"></div>
      <canvas class="ms-snow back"></canvas>
      <div class="ms-mist near"></div>
      <canvas class="ms-snow front"></canvas>`;
    parent.prepend(this.root);
    this.stage = this.root.querySelector<HTMLDivElement>('.ms-plates')!;
    for (const img of this.stage.querySelectorAll<HTMLImageElement>('.ms-plate')) {
      const k = img.dataset.p as Plate;
      this.plates[k] = img;
      // Relative to the page (the desktop and Android builds load from a file / app origin).
      img.src = `menu/${PLATES[k]}.webp`;
      // Decoded up front so every cut, and every flicker, lands on the frame it's asked for.
      img.decode?.().catch(() => {});
    }
    this.show('stand');
    const dpr = Math.min(mobile ? 1 : 1.5, window.devicePixelRatio || 1);
    const [b, f] = [...this.root.querySelectorAll<HTMLCanvasElement>('.ms-snow')];
    this.back = new Snow(b, mobile ? 90 : 220, [1, 2.6], [14, 46], [0.35, 0.85], dpr);
    this.front = new Snow(f, mobile ? 10 : 22, [3, 7], [60, 120], [0.18, 0.45], dpr);
    window.addEventListener('resize', () => {
      this.back.resize();
      this.front.resize();
    });
    // Look away and, when you look back, he may have moved, or gone.
    window.addEventListener('blur', () => this.lookAway());
    window.addEventListener('focus', () => this.lookBack());
    document.addEventListener('visibilitychange', () =>
      document.visibilityState === 'hidden' ? this.lookAway() : this.lookBack(),
    );
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    // While the stage is up the 3D canvas under it is covered: stop compositing it.
    const on = this.active();
    if (on !== this.staged) {
      this.staged = on;
      document.body.classList.toggle('menu-stage', on);
      this.voice?.setActive(on);
      if (on) {
        if (this.seen) this.voice?.backFromMatch();
        else this.voice?.welcome();
        this.seen = true;
      }
      // A match or the pause screen in between counts as having looked away.
      if (on) this.lookBack();
      else this.lookAway();
    }
    // Nothing to draw while a match runs or the pause screen is up.
    if (!on || document.visibilityState === 'hidden') {
      this.last = now;
      return;
    }
    // 30 fps is plenty for snow (and keeps phones cool in the menu).
    if (now < this.next) return;
    this.next = now + 1000 / 30 - 2;
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    // A steady wind from the right with slow gusts.
    const wind = -0.35 - 0.25 * Math.sin(t * 0.13) - 0.12 * Math.sin(t * 0.37);
    this.back.step(dt, t, wind);
    this.front.step(dt, t, wind * 1.3);
    this.wait -= dt;
    if (this.wait <= 0) this.beat();
  };

  /** He changes pose, or he's gone; from the empty field he comes back. */
  private beat(): void {
    const was = this.state;
    this.step();
    this.voice?.presence(this.state);
    if (was === 'gone' && this.state !== 'gone') this.voice?.returned();
    this.voice?.beat();
  }

  private step(): void {
    this.beats++;
    if (this.state === 'gone') {
      const to: Plate = Math.random() < 0.5 ? 'stand' : 'aim';
      // Back without warning: a hard cut through a dark dip, or the signal glitch.
      if (Math.random() < 0.6) this.dipTo(to);
      else this.cutTo(to);
      this.wait = rand(...HOLD.here);
      return;
    }
    // The first beat only moves him: the player should have seen him before he can be missed.
    if (this.beats > 1 && Math.random() < VANISH) {
      const r = Math.random();
      if (r < 0.4) this.flickerTo('gone');
      else if (r < 0.7) this.show('gone'); // no effect at all: noticed only afterwards
      else this.cutTo('gone');
      this.wait = rand(...HOLD.gone);
      // Sometimes the empty field shows him again for a blink, mid-hold.
      if (Math.random() < 0.35) this.glimpse(rand(1.2, this.wait - 1.2));
      return;
    }
    this.cutTo(this.state === 'stand' ? 'aim' : 'stand');
    this.wait = rand(...HOLD.here);
  }

  /** Instant swap, cancelling anything in flight. Returns the new transition's id. */
  private show(p: Plate): number {
    const s = ++this.seq;
    this.state = p;
    this.stage.classList.remove('cut', 'dip');
    for (const k of Object.keys(this.plates) as Plate[]) {
      this.plates[k].classList.toggle('on', k === p);
      this.plates[k].classList.remove('in');
    }
    return s;
  }

  /** The signal glitch: torn slices of the next plate over this one, then it settles. */
  private cutTo(p: Plate): void {
    const s = this.show(this.state);
    this.state = p;
    void this.stage.offsetWidth;
    this.plates[p].classList.add('on', 'in');
    this.stage.classList.add('cut');
    window.setTimeout(() => s === this.seq && this.show(p), 560);
  }

  /** A hard cut, the picture dropping nearly black for a moment. */
  private dipTo(p: Plate): void {
    this.show(p);
    void this.stage.offsetWidth;
    this.stage.classList.add('dip');
  }

  /** Like a failing light: gone, back, gone, back… gone. */
  private flickerTo(p: Plate): void {
    const from = this.state;
    const steps: [Plate, number][] = [
      [p, 0],
      [from, 70],
      [p, 170],
      [from, 220],
      [p, 380],
    ];
    const s = this.show(from);
    this.state = p;
    for (const [q, ms] of steps)
      window.setTimeout(() => {
        if (s !== this.seq) return;
        for (const k of Object.keys(this.plates) as Plate[]) this.plates[k].classList.toggle('on', k === q);
      }, ms);
  }

  /** While he's gone: him, aiming, for ~90 ms, then the empty field again. */
  private glimpse(after: number): void {
    const s = this.seq;
    window.setTimeout(() => {
      if (s !== this.seq || !this.active()) return;
      this.plates.aim.classList.add('on', 'in');
      window.setTimeout(() => s === this.seq && this.plates.aim.classList.remove('on', 'in'), 90);
    }, after * 1000);
  }

  private lookAway(): void {
    if (!this.away) this.away = performance.now();
  }

  private lookBack(): void {
    const away = this.away ? performance.now() - this.away : 0;
    this.away = 0;
    if (away < 1500 || !this.active() || Math.random() < 0.4) return;
    // No transition: things were simply like this when you looked back.
    if (this.state === 'gone') this.show(Math.random() < 0.5 ? 'stand' : 'aim');
    else this.show(Math.random() < 0.65 ? 'gone' : this.state === 'stand' ? 'aim' : 'stand');
    this.wait = rand(...(this.state === 'gone' ? HOLD.gone : HOLD.here));
    this.voice?.presence(this.state, true);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }
}
