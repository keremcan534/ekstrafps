/**
 * The main menu's stage: a photograph instead of a live 3D render (the GPU idles in the
 * menu). A night steppe, a SABLE operator graded into it, and what keeps it alive for
 * almost nothing: snow in two depths (one behind him, one in front) on 2D canvases,
 * and ground mist drifting.
 */

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

/** The Warden's poses (public/menu), each with its height on the stage (close-ups smaller). */
/** The Warden himself (greatcoat, respirator): opens the menu and returns every third cut. */
const WARDEN: [string, number] = ['warden_mask', 0.97];
const POSES: [string, number][] = [
  ['operator', 1],
  ['warden2', 0.93],
  ['warden4', 0.95],
  ['warden6', 0.93],
  ['warden7', 0.8],
  ['warden1', 0.93],
  ['warden5', 0.9],
  ['warden8', 0.93],
  ['warden3', 0.93],
];
/** Seconds each pose holds before the next cuts in (the Warden stays longer). */
const POSE_HOLD = 8;
const WARDEN_HOLD = 12;

export class MenuScene {
  readonly root: HTMLDivElement;
  private back: Snow;
  private front: Snow;
  private raf = 0;
  private last = 0;
  private next = 0;
  private t0 = performance.now();
  private op: HTMLDivElement;
  private img: HTMLImageElement;
  private pose = -1;
  /** Seconds of menu time on the current pose (only counts while the menu is up). */
  private held = 0;
  private staged = false;
  private cuts = 0;
  private onWarden = true;

  constructor(parent: HTMLElement, mobile: boolean, private active: () => boolean) {
    this.root = document.createElement('div');
    this.root.className = 'menu-scene';
    this.root.innerHTML = `
      <div class="ms-bg"></div>
      <div class="ms-mist far"></div>
      <canvas class="ms-snow back"></canvas>
      <div class="ms-op">
        <img src="menu/${WARDEN[0]}.webp" alt="" draggable="false" /><div class="ms-tear"></div>
      </div>
      <div class="ms-mist near"></div>
      <canvas class="ms-snow front"></canvas>`;
    parent.prepend(this.root);
    // Relative to the page (the desktop and Android builds load from a file / app origin).
    this.root.querySelector<HTMLElement>('.ms-bg')!.style.backgroundImage = 'url(menu/steppe.webp)';
    this.op = this.root.querySelector<HTMLDivElement>('.ms-op')!;
    this.img = this.op.querySelector('img')!;
    // Warm the cache so each cut swaps instantly (~30 KB each).
    for (const [id] of POSES) new Image().src = `menu/${id}.webp`;
    this.op.style.height = `${95 * WARDEN[1]}%`;
    const dpr = Math.min(mobile ? 1 : 1.5, window.devicePixelRatio || 1);
    const [b, f] = [...this.root.querySelectorAll<HTMLCanvasElement>('.ms-snow')];
    this.back = new Snow(b, mobile ? 90 : 220, [1, 2.6], [14, 46], [0.35, 0.85], dpr);
    this.front = new Snow(f, mobile ? 10 : 22, [3, 7], [60, 120], [0.18, 0.45], dpr);
    window.addEventListener('resize', () => {
      this.back.resize();
      this.front.resize();
    });
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    // While the stage is up the 3D canvas under it is covered: stop compositing it.
    const on = this.active();
    if (on !== this.staged) {
      this.staged = on;
      document.body.classList.toggle('menu-stage', on);
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
    this.held += dt;
    if (this.held > (this.onWarden ? WARDEN_HOLD : POSE_HOLD)) {
      this.held = 0;
      this.cut();
    }
  };

  /** Next pose, through a short dark signal glitch (no flash). */
  private cut(): void {
    // Warden, two SABLE poses, Warden, two more…
    this.cuts++;
    this.onWarden = this.cuts % 3 === 0;
    if (!this.onWarden) this.pose = (this.pose + 1) % POSES.length;
    const [id, h] = this.onWarden ? WARDEN : POSES[this.pose];
    this.op.classList.remove('cut');
    void this.op.offsetWidth;
    this.op.classList.add('cut');
    window.setTimeout(() => {
      this.img.src = `menu/${id}.webp`;
      this.op.style.height = `${95 * h}%`;
    }, 180);
    window.setTimeout(() => this.op.classList.remove('cut'), 600);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }
}
