import * as THREE from 'three';

/**
 * What the benchmark can switch off for a moment (Game checks these each frame).
 * The URL bisect flags start with some of them on: ?noai, ?nodraw, ?nophys.
 */
export interface BenchFlags {
  /** Skip the world render (the 3D scene; the weapon still draws). */
  noWorld: boolean;
  /** Skip AI teams, robots, inhabitants and the survival director (?noai). */
  noSim: boolean;
  /** Skip every render() call; the canvas is only cleared to a changing colour (?nodraw). */
  noDraw: boolean;
  /** Skip the physics world step (?nophys). */
  noPhys: boolean;
}

/** Bisect flags from the URL. */
export function benchFlagsFromUrl(p: URLSearchParams): BenchFlags {
  return { noWorld: false, noSim: p.has('noai'), noDraw: p.has('nodraw'), noPhys: p.has('nophys') };
}

let glCache: { gpu: string; webgl2: boolean; aa: boolean } | null = null;

/** The real GPU (unmasked renderer string), WebGL 2 or not, and whether the framebuffer really has MSAA. */
export function glInfo(renderer: THREE.WebGLRenderer): { gpu: string; webgl2: boolean; aa: boolean } {
  if (glCache) return glCache;
  const gl = renderer.getContext();
  let gpu = '?';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch {
    /* blocked by the browser */
  }
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  glCache = { gpu, webgl2, aa: !!gl.getContextAttributes()?.antialias };
  return glCache;
}

/** The parts of the game the benchmark drives. */
export interface BenchHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly container: HTMLElement;
  readonly flags: BenchFlags;
  /** Render pixel ratio now (and setting it, temporarily). */
  pixelRatio: number;
  audio: AudioContext | null;
  /** Methods to time during the baseline (label → [object, method name]). */
  timed: [string, object, string][];
  /** Readout lines (mode, resolution, draw calls, body classes), taken at the end of the baseline. */
  details(): string[];
}

interface Step {
  name: string;
  label: string;
  on(): void;
  off(): void;
}

const SETTLE = 0.6;
const MEASURE = 2.6;

/**
 * On-device benchmark (Settings → Graphics → RUN BENCHMARK). Measures the frame
 * rate as you play, then switches one thing off at a time (HUD, half resolution,
 * the 3D world, all drawing, the AI/simulation, physics, transparent effects,
 * characters, audio) and
 * measures again; the gain is what that thing costs. Also times the main CPU
 * systems during the baseline. Shows a bar chart and a COPY button (plain text
 * to paste into a message).
 */
export class PerfBench {
  private el: HTMLDivElement;
  private steps: Step[];
  private i = -1;
  private t = 0;
  private frames: number[] = [];
  /** CPU time per frame (ms): a 120 Hz screen shows frames in 8.3 ms steps, so frame times alone flip between 60 and 120 fps. */
  private works: number[] = [];
  /** Shortest frame seen (s): the screen's refresh. */
  private minFrame = Infinity;
  private results: { name: string; label: string; fps: number; ms: number; cpu: number }[] = [];
  private cpu = new Map<string, number>();
  private cpuFrames = 0;
  private restore: (() => void)[] = [];
  private hidden: THREE.Object3D[] = [];
  private details: string[] = [];
  done = false;

  constructor(private host: BenchHost) {
    this.el = document.createElement('div');
    this.el.className = 'bench';
    host.container.appendChild(this.el);
    const pr = host.pixelRatio;
    const ui = () => host.container.querySelector<HTMLElement>('.ui-layer');
    // A flag step puts back what it found (a ?noai / ?nodraw / ?nophys bisect stays on).
    const flag = (name: string, label: string, key: keyof BenchFlags): Step => {
      let was = false;
      return {
        name,
        label,
        on: () => {
          was = host.flags[key];
          host.flags[key] = true;
        },
        off: () => (host.flags[key] = was),
      };
    };
    this.steps = [
      { name: 'base', label: 'As you play', on: () => this.timeCpu(), off: () => this.untime() },
      { name: 'ui', label: 'HUD / interface', on: () => ui()?.style.setProperty('visibility', 'hidden'), off: () => ui()?.style.removeProperty('visibility') },
      { name: 'res', label: 'Half resolution', on: () => (host.pixelRatio = pr * 0.5), off: () => (host.pixelRatio = pr) },
      flag('world', '3D world render', 'noWorld'),
      // Nothing drawn at all, only a clear: what's left is the page itself (compositor, HUD, canvas copy).
      flag('draw', 'All 3D drawing', 'noDraw'),
      flag('sim', 'AI + simulation', 'noSim'),
      flag('phys', 'Physics step', 'noPhys'),
      { name: 'fx', label: 'Transparent effects', on: () => this.hide((m) => !!(m as THREE.Mesh).material && ((m as THREE.Mesh).material as THREE.Material).transparent), off: () => this.unhide() },
      { name: 'chars', label: 'Characters', on: () => this.hide((m) => (m as THREE.SkinnedMesh).isSkinnedMesh === true), off: () => this.unhide() },
      { name: 'audio', label: 'Audio', on: () => void host.audio?.suspend(), off: () => void host.audio?.resume() },
    ];
  }

  private hide(pick: (o: THREE.Object3D) => boolean): void {
    this.host.scene.traverse((o) => {
      if (o.visible && ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) && pick(o)) {
        o.visible = false;
        this.hidden.push(o);
      }
    });
  }

  private unhide(): void {
    for (const o of this.hidden) o.visible = true;
    this.hidden = [];
  }

  private timeCpu(): void {
    for (const [label, obj, fn] of this.host.timed) {
      const o = obj as Record<string, (...a: unknown[]) => unknown>;
      const orig = o[fn];
      if (typeof orig !== 'function') continue;
      o[fn] = (...a: unknown[]) => {
        const s = performance.now();
        try {
          return orig.apply(obj, a);
        } finally {
          this.cpu.set(label, (this.cpu.get(label) ?? 0) + performance.now() - s);
        }
      };
      this.restore.push(() => (o[fn] = orig));
    }
  }

  private untime(): void {
    for (const r of this.restore) r();
    this.restore = [];
  }

  /** Call once per real frame with its duration (seconds) and the CPU time of the frame before (ms). */
  frame(rawDt: number, workMs: number): void {
    if (this.done) return;
    if (this.i < 0) {
      this.next();
      return;
    }
    this.t += rawDt;
    if (this.t > SETTLE) {
      this.frames.push(rawDt);
      this.works.push(workMs);
      if (rawDt > 0.002) this.minFrame = Math.min(this.minFrame, rawDt);
      if (this.i === 0) this.cpuFrames++;
    }
    const step = this.steps[this.i];
    this.el.innerHTML = `<b>BENCHMARK</b><span>${this.i + 1}/${this.steps.length} · ${this.i === 0 ? '' : 'without: '}${step.label}</span><i style="--p:${(((this.i + Math.min(1, this.t / (SETTLE + MEASURE))) / this.steps.length) * 100).toFixed(0)}%"></i>`;
    if (this.t >= SETTLE + MEASURE) {
      const sorted = [...this.frames].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1] ?? 0.1;
      const work = [...this.works].sort((a, b) => a - b);
      this.results.push({ name: step.name, label: step.label, fps: 1 / median, ms: median * 1000, cpu: work[work.length >> 1] ?? 0 });
      if (this.i === 0) this.details = this.host.details();
      step.off();
      this.next();
    }
  }

  private next(): void {
    this.i++;
    this.t = 0;
    this.frames = [];
    this.works = [];
    if (this.i >= this.steps.length) {
      this.done = true;
      this.report();
      return;
    }
    this.steps[this.i].on();
  }

  private report(): void {
    const base = this.results[0];
    // Costs in CPU time (what each thing adds to the frame's work); the fps shown move in the screen's steps.
    const rows = this.results.slice(1).map((r) => ({ ...r, gainMs: base.cpu - r.cpu, gainFps: r.fps - base.fps }));
    const hz = Math.round(1 / this.minFrame / 10) * 10;
    const budget = hz > 0 && Number.isFinite(hz) ? 1000 / hz : 0;
    const cpu = [...this.cpu.entries()].map(([k, v]) => [k, v / Math.max(1, this.cpuFrames)] as [string, number]).sort((a, b) => b[1] - a[1]);
    const { gpu } = glInfo(this.host.renderer);
    const canvas = this.host.renderer.domElement;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const device = `${gpu} · ${canvas.width}×${canvas.height} px (dpr ${devicePixelRatio.toFixed(2)}, render ${this.host.pixelRatio.toFixed(2)}) · ${nav.hardwareConcurrency ?? '?'} cores${nav.deviceMemory ? ` · ${nav.deviceMemory} GB` : ''}`;
    const maxMs = Math.max(1, ...rows.map((r) => Math.abs(r.gainMs)), ...cpu.map((c) => c[1]));
    const bar = (ms: number, cls: string) => `<i class="${cls}" style="width:${Math.max(1, (Math.abs(ms) / maxMs) * 100).toFixed(1)}%"></i>`;
    const verdict = budget ? `${hz} Hz screen: ${base.cpu < budget ? `fits ${hz} fps` : `${(base.cpu - budget).toFixed(1)} ms over the ${hz} fps budget (${budget.toFixed(1)} ms)`}` : '';
    const lines = [
      `SITE-9 benchmark: ${base.cpu.toFixed(1)} ms CPU per frame (room for ~${Math.round(1000 / Math.max(0.1, base.cpu))} fps) · shown ${base.fps.toFixed(1)} fps`,
      verdict,
      device,
      ...this.details,
      navigator.userAgent,
      'What each thing costs (CPU time saved when it is off; fps shown without it):',
      ...rows.map((r) => `  ${r.label}: ${r.gainMs.toFixed(2)} ms (${r.fps.toFixed(0)} fps)`),
      'CPU per frame (baseline):',
      ...cpu.map(([k, v]) => `  ${k}: ${v.toFixed(2)} ms`),
    ];
    this.el.classList.add('done');
    this.el.innerHTML = `<b>BENCHMARK · ${base.cpu.toFixed(1)} MS CPU · ${base.fps.toFixed(0)} FPS SHOWN</b><span>${verdict}</span><span>${device}</span>${this.details.map((d) => `<span>${d.replace(/</g, '&lt;')}</span>`).join('')}
      <h4>What each thing costs <em>(CPU time saved when it's off)</em></h4>
      ${rows.map((r) => `<div class="bench-row"><span>${r.label}</span>${bar(r.gainMs, r.gainMs > 0 ? 'cost' : 'free')}<b>${r.gainMs.toFixed(2)} ms</b><em>${r.fps.toFixed(0)} fps</em></div>`).join('')}
      <h4>CPU per frame <em>(as you play)</em></h4>
      ${cpu.map(([k, v]) => `<div class="bench-row"><span>${k}</span>${bar(v, 'cpu')}<b>${v.toFixed(2)} ms</b><em></em></div>`).join('')}
      <div class="bench-btns"><button class="bench-copy">COPY</button><button class="bench-close">CLOSE</button></div>`;
    const copy = this.el.querySelector<HTMLButtonElement>('.bench-copy')!;
    const text = lines.join('\n');
    const stop = (e: Event) => e.stopPropagation();
    for (const b of this.el.querySelectorAll('button')) {
      b.addEventListener('pointerdown', stop);
      b.addEventListener('touchstart', stop);
    }
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(text).then(() => (copy.textContent = 'COPIED'), () => window.prompt('Copy:', text));
    });
    this.el.querySelector('.bench-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.el.remove();
    });
    console.info(text);
  }
}
