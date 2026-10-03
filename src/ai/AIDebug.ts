import * as THREE from 'three';
import { DebugDraw } from '../fx/DebugDraw';
import type { Bot } from './Bot';
import { coverRegistry } from './Cover';
import { AI_TUNING } from './Tuning';
import { aiWorld } from './World';

type Cat = 'debugLabels' | 'debugPaths' | 'debugCover' | 'debugLos' | 'debugMemory' | 'debugFlank' | 'debugSound';
const CATS: [Cat, string][] = [
  ['debugLabels', 'Labels'],
  ['debugPaths', 'Paths'],
  ['debugCover', 'Cover'],
  ['debugLos', 'Line of sight'],
  ['debugMemory', 'Last known'],
  ['debugFlank', 'Flank / search'],
  ['debugSound', 'Sounds'],
];

const COL = {
  path: 0x35c8ff,
  coverOk: 0x3dff7a,
  coverBad: 0xff4a3a,
  coverSel: 0x7dffb0,
  peek: 0xffe04a,
  los: 0xff3030,
  belief: 0xffa020,
  lastSeen: 0xff40ff,
  sound: 0x40ffff,
  flank: 0xd060ff,
  search: 0xffffff,
  reserved: 0x2a8f50,
};

/**
 * AI debug view (F4 with ?dev, or ?aidebug): a label over every bot (decision,
 * action, target + confidence, cover, suppression, personality, squad role and
 * plan, time since movement / progress, the watchdog) and toggleable world
 * overlays — paths, cover candidates / choice / reservations, lines of sight,
 * last known positions with their uncertainty, investigated sounds, flank
 * routes and search points.
 */
export class AIDebug {
  readonly draw = new DebugDraw();
  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private stats: HTMLSpanElement;
  private labels = new Map<Bot, HTMLDivElement>();
  private labelTimer = 0;
  private v = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  constructor(parent: HTMLElement, private camera: THREE.PerspectiveCamera, private bots: () => Iterable<Bot>) {
    this.draw.enabled = true;
    this.root = document.createElement('div');
    this.root.className = 'ai-debug';
    parent.appendChild(this.root);
    this.panel = document.createElement('div');
    this.panel.className = 'ai-debug-panel';
    this.panel.innerHTML = '<b>AI DEBUG</b> ';
    for (const [k, name] of CATS) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = AI_TUNING[k];
      cb.addEventListener('change', () => (AI_TUNING[k] = cb.checked));
      l.append(cb, name);
      this.panel.appendChild(l);
    }
    this.stats = document.createElement('span');
    this.panel.appendChild(this.stats);
    this.root.appendChild(this.panel);
    this.root.style.display = AI_TUNING.debug ? '' : 'none';
  }

  toggle(): boolean {
    AI_TUNING.debug = !AI_TUNING.debug;
    this.root.style.display = AI_TUNING.debug ? '' : 'none';
    return AI_TUNING.debug;
  }

  get enabled(): boolean {
    return AI_TUNING.debug;
  }

  update(dt: number): void {
    if (!AI_TUNING.debug) {
      if (this.root.style.display !== 'none') this.root.style.display = 'none';
      return;
    }
    if (this.root.style.display === 'none') this.root.style.display = '';
    const T = AI_TUNING;
    const d = this.draw;
    const now = aiWorld.time;
    const seen = new Set<Bot>();
    this.labelTimer -= dt;
    const refreshText = this.labelTimer <= 0;
    if (refreshText) this.labelTimer = 0.12;
    for (const bot of this.bots()) {
      seen.add(bot);
      const s = bot.soldier;
      const alive = bot.alive;
      const chest = bot.chest(this.a);
      if (alive) {
        if (T.debugPaths) {
          const path = s.path;
          if (path && path.length) {
            let prev = this.b.set(s.pos.x, 0.15, s.pos.z);
            for (const p of path) {
              this.v.set(p.x, 0.15, p.z);
              d.line(prev, this.v, COL.path, 0.8);
              prev = this.b.copy(this.v);
            }
          }
          if (bot.navigator.hasDest) d.cross(this.v.set(bot.navigator.dest.x, 0.2, bot.navigator.dest.z), 0.25, COL.path);
        }
        if (T.debugCover) {
          for (const c of bot.debug.covers) d.cross(this.v.set(c.pos.x, 0.3, c.pos.z), 0.15, c.ok ? COL.coverOk : COL.coverBad);
          const cv = bot.cover;
          if (cv) {
            d.cross(this.v.set(cv.pos.x, 0.5, cv.pos.z), 0.4, COL.coverSel);
            d.line(this.b.set(s.pos.x, 0.5, s.pos.z), this.v, COL.coverSel, 0.6);
            if (cv.peek) d.cross(this.v.set(cv.peek.x, 0.5, cv.peek.z), 0.25, COL.peek);
          }
        }
        const t = bot.target;
        if (t) {
          if (T.debugLos && t.visible) d.line(chest, t.target.aim, COL.los, 1);
          if (T.debugMemory && !t.visible) {
            this.v.set(t.pos.x, 0.2, t.pos.z);
            d.line(this.b.set(s.pos.x, 1.4, s.pos.z), this.v, COL.belief, 0.35 + 0.65 * t.confidence);
            d.cross(this.v, 0.35, COL.belief);
            // Uncertainty ring.
            const r = Math.max(0.5, t.uncertainty);
            for (let k = 0; k < 10; k++) {
              const a0 = (k / 10) * Math.PI * 2;
              const a1 = ((k + 1) / 10) * Math.PI * 2;
              d.line(this.a.set(t.pos.x + Math.sin(a0) * r, 0.1, t.pos.z + Math.cos(a0) * r), this.b.set(t.pos.x + Math.sin(a1) * r, 0.1, t.pos.z + Math.cos(a1) * r), COL.belief, 0.5);
            }
            if (t.lastSeenTime > 0) d.cross(this.v.set(t.lastSeenPos.x, 0.3, t.lastSeenPos.z), 0.3, COL.lastSeen);
          }
        }
        if (T.debugSound && bot.debug.investigate && bot.decision === 'INVESTIGATE') {
          d.cross(this.v.set(bot.debug.investigate.x, 0.4, bot.debug.investigate.z), 0.5, COL.sound);
        }
        if (T.debugFlank) {
          const f = bot.flank;
          if (f && bot.decision === 'FLANK') {
            let prev = this.b.set(s.pos.x, 0.25, s.pos.z);
            for (const p of f.route) {
              this.v.set(p.x, 0.25, p.z);
              d.line(prev, this.v, COL.flank, 1);
              prev = this.a.copy(this.v);
            }
            d.cross(this.v.set(f.dest.x, 0.6, f.dest.z), 0.6, COL.flank);
          }
          if (bot.decision === 'SEARCH') for (const p of bot.debug.searchPts) d.cross(this.v.set(p.x, 0.3, p.z), 0.3, COL.search);
        }
      }
      if (T.debugLabels) this.placeLabel(bot, alive, refreshText);
    }
    if (T.debugSound) for (const n of aiWorld.noise.all) d.cross(this.v.set(n.pos.x, n.pos.y + 0.2, n.pos.z), 0.12, COL.sound);
    if (T.debugCover) for (const p of coverRegistry.all(now)) d.cross(this.v.set(p.x, 0.05, p.z), 0.5, COL.reserved);
    for (const [bot, el] of this.labels) {
      if (!seen.has(bot) || !T.debugLabels) {
        el.remove();
        this.labels.delete(bot);
      }
    }
    if (refreshText) this.stats.textContent = ` rays/frame ${aiWorld.stats.rays} · denied ${aiWorld.stats.raysDenied} · cover queries ${aiWorld.stats.coverQueries}`;
    d.flush(dt);
  }

  private placeLabel(bot: Bot, alive: boolean, refresh: boolean): void {
    let el = this.labels.get(bot);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ai-label';
      this.root.appendChild(el);
      this.labels.set(bot, el);
    }
    const s = bot.soldier;
    this.v.copy(s.pos).y += 2.25;
    const dist = this.v.distanceTo(this.camera.position);
    this.v.project(this.camera);
    if (!alive || this.v.z > 1 || dist > 60 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate(${((this.v.x + 1) / 2) * 100}vw, ${((1 - this.v.y) / 2) * 100}vh) translate(-50%, -100%)`;
    if (refresh) {
      el.textContent = bot.label();
      el.classList.toggle('watchdog', bot.watchdogFlash > 0);
      el.dataset.team = bot.team;
    }
  }
}
