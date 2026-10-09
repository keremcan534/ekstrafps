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
/** The first step settles longer: a raid's first seconds are heavier than the rest (squads planning, first path searches, code warming up). */
const WARMUP = 2.5;

/**
 * On-device benchmark (Settings → Graphics → RUN BENCHMARK). Measures the frame
 * rate as you play, then switches one thing off at a time (HUD, half resolution,
 * the 3D world, all drawing, the AI/simulation, physics, transparent effects,
 * characters, audio), then measures as you play again. A thing's cost is what its
 * step saves against the baseline at that moment: the line between the first and
 * the last measurement, so a phone speeding up or heating during the run doesn't
 * read as savings. Also times the main CPU systems during the first baseline.
 * Shows a bar chart and a COPY button (plain text to paste into a message).
 */
export class PerfBench {
  private el: HTMLDivElement;
  private steps: Step[];
  private i = -1;
  private t = 0;
  /** Seconds since the benchmark started (each measurement is placed on the baseline line by it). */
  private clock = 0;
  private frames: number[] = [];
  /** CPU time per frame (ms): a 120 Hz screen shows frames in 8.3 ms steps, so frame times alone flip between 60 and 120 fps. */
  private works: number[] = [];
  /** Shortest frame seen (s): the screen's refresh. */
  private minFrame = Infinity;
  private results: { name: string; label: string; fps: number; ms: number; cpu: number; at: number; step: number }[] = [];
  private cpu = new Map<string, number>();
  private cpuFrames = 0;
  private restore: (() => void)[] = [];
  private hidden: THREE.Object3D[] = [];
  private details: string[] = [];
  /**
   * GPU time of each frame's drawing (a timer query), where the browser offers one
   * (EXT_disjoint_timer_query_webgl2). Results come in a few frames late: each query keeps
   * the step it measured.
   */
  private timer: { gl: WebGL2RenderingContext; ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } } | null = null;
  private inFlight: { q: WebGLQuery; step: number }[] = [];
  private spare: WebGLQuery[] = [];
  private open = false;
  private gpuMs: number[][] = [];
  done = false;

  constructor(private host: BenchHost) {
    this.el = document.createElement('div');
    this.el.className = 'bench';
    host.container.appendChild(this.el);
    const gl = host.renderer.getContext();
    const ext = gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    if (ext) this.timer = { gl: gl as WebGL2RenderingContext, ext };
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
      { name: 'end', label: 'As you play (again)', on: () => {}, off: () => {} },
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

  /** Around the frame's drawing (Game.frame): times it on the GPU while a step is measuring. */
  gpuBegin(): void {
    const tm = this.timer;
    if (!tm || this.done || this.i < 0 || this.open || this.inFlight.length >= 8) return;
    if (this.t <= (this.i === 0 ? WARMUP : SETTLE)) return;
    const q = this.spare.pop() ?? tm.gl.createQuery();
    if (!q) return;
    tm.gl.beginQuery(tm.ext.TIME_ELAPSED_EXT, q);
    this.inFlight.push({ q, step: this.i });
    this.open = true;
  }

  gpuEnd(): void {
    if (!this.open || !this.timer) return;
    this.timer.gl.endQuery(this.timer.ext.TIME_ELAPSED_EXT);
    this.open = false;
  }

  /** Finished timer queries, oldest first; none counted across a GPU disjoint (clock change, reset). */
  private pollGpu(): void {
    const tm = this.timer;
    if (!tm || !this.inFlight.length) return;
    const gl = tm.gl;
    const disjoint = !!gl.getParameter(tm.ext.GPU_DISJOINT_EXT);
    while (this.inFlight.length && (this.inFlight.length > 1 || !this.open)) {
      const e = this.inFlight[0];
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(e.q, gl.QUERY_RESULT) as number;
      this.inFlight.shift();
      this.spare.push(e.q);
      if (!disjoint) (this.gpuMs[e.step] ??= []).push(ns / 1e6);
    }
  }

  /** Median GPU ms of a step, or null (no timer, or no results came back). */
  private gpuOf(step: number): number | null {
    const a = this.gpuMs[step];
    if (!a?.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1];
  }

  /** Call once per real frame with its duration (seconds) and the CPU time of the frame before (ms). */
  frame(rawDt: number, workMs: number): void {
    if (this.done) return;
    if (this.i < 0) {
      this.next();
      return;
    }
    this.pollGpu();
    this.t += rawDt;
    this.clock += rawDt;
    const settle = this.i === 0 ? WARMUP : SETTLE;
    if (this.t > settle) {
      this.frames.push(rawDt);
      this.works.push(workMs);
      if (rawDt > 0.002) this.minFrame = Math.min(this.minFrame, rawDt);
      if (this.i === 0) {
        // The systems' times count from here: the settle's frames aren't in cpuFrames either.
        if (this.cpuFrames === 0) this.cpu.clear();
        this.cpuFrames++;
      }
    }
    const step = this.steps[this.i];
    const last = this.i === this.steps.length - 1;
    this.el.innerHTML = `<b>BENCHMARK</b><span>${this.i + 1}/${this.steps.length} · ${this.i === 0 || last ? '' : 'without: '}${step.label}</span><i style="--p:${(((this.i + Math.min(1, this.t / (settle + MEASURE))) / this.steps.length) * 100).toFixed(0)}%"></i>`;
    if (this.t >= settle + MEASURE) {
      const sorted = [...this.frames].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1] ?? 0.1;
      const work = [...this.works].sort((a, b) => a - b);
      this.results.push({ name: step.name, label: step.label, fps: 1 / median, ms: median * 1000, cpu: work[work.length >> 1] ?? 0, at: this.clock - MEASURE / 2, step: this.i });
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
    const first = this.results[0];
    const end = this.results[this.results.length - 1];
    // The baseline at a moment: the line from the first to the last measurement as you play.
    const baseAt = (at: number) => (end.at > first.at ? first.cpu + ((end.cpu - first.cpu) * (at - first.at)) / (end.at - first.at) : first.cpu);
    const base = { cpu: (first.cpu + end.cpu) / 2, fps: (first.fps + end.fps) / 2 };
    // Costs in CPU time (what each thing adds to the frame's work); the fps shown move in the screen's steps.
    const rows = this.results.slice(1, -1).map((r) => ({ ...r, gainMs: baseAt(r.at) - r.cpu }));
    const hz = Math.round(1 / this.minFrame / 10) * 10;
    const budget = hz > 0 && Number.isFinite(hz) ? 1000 / hz : 0;
    const drift = `As you play: ${first.cpu.toFixed(1)} ms at the start, ${end.cpu.toFixed(1)} ms at the end (costs are measured against the line between)`;
    // A step light enough for the screen's rate, still shown slower: the browser held the page
    // there (phones often run the screen slower while nobody touches it).
    const light = rows.filter((r) => budget && r.cpu < budget * 0.85).sort((a, b) => a.cpu - b.cpu);
    const top = Math.max(0, ...light.map((r) => r.fps));
    const held = light.length > 0 && top < hz * 0.8 ? `Held at ~${Math.round(top)} Hz: with "${light[0].label}" off a frame took ${light[0].cpu.toFixed(1)} ms and still showed ${light[0].fps.toFixed(0)} fps (the browser ran the page slower than the ${hz} Hz screen)` : '';
    // The drawing's own GPU time (the HUD and the page's compositing aren't in it).
    const ms1 = (v: number | null) => (v === null ? '?' : v.toFixed(1));
    const g0 = this.gpuOf(first.step);
    const g1 = this.gpuOf(end.step);
    const gpuLine = !this.timer
      ? 'GPU time: this browser has no GPU timer'
      : g0 === null && g1 === null
        ? 'GPU time: the GPU timer gave no results'
        : `GPU per frame (3D drawing): ${ms1(g0)} ms at the start, ${ms1(g1)} ms at the end${budget ? ` (${hz} Hz budget ${budget.toFixed(1)} ms)` : ''}`;
    const gpuOf = (r: { step: number }) => {
      const v = this.gpuOf(r.step);
      return v === null ? '' : `, GPU ${v.toFixed(1)} ms`;
    };
    if (this.timer) {
      for (const e of this.inFlight) this.timer.gl.deleteQuery(e.q);
      for (const q of this.spare) this.timer.gl.deleteQuery(q);
      this.inFlight = [];
      this.spare = [];
    }
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
      ...(held ? [held] : []),
      drift,
      gpuLine,
      device,
      ...this.details,
      navigator.userAgent,
      'What each thing costs (CPU time saved when it is off; fps shown without it):',
      ...rows.map((r) => `  ${r.label}: ${r.gainMs.toFixed(2)} ms (${r.fps.toFixed(0)} fps${gpuOf(r)})`),
      'CPU per frame (baseline):',
      ...cpu.map(([k, v]) => `  ${k}: ${v.toFixed(2)} ms`),
    ];
    this.el.classList.add('done');
    this.el.innerHTML = `<b>BENCHMARK · ${base.cpu.toFixed(1)} MS CPU · ${base.fps.toFixed(0)} FPS SHOWN</b><span>${verdict}</span>${held ? `<span>${held}</span>` : ''}<span>${drift}</span><span>${gpuLine}</span><span>${device}</span>${this.details.map((d) => `<span>${d.replace(/</g, '&lt;')}</span>`).join('')}
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
