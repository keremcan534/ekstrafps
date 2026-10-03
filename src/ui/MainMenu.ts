import * as THREE from 'three';
import { matchClock } from '../game/TeamMatch';
import type { Game } from '../core/Game';
import { feel } from '../config/Feel';
import { playerConfig } from '../player/PlayerConfig';
import { Showcase } from './Showcase';
import { PERKS, SIDEARMS, levelOf, loadProfile, perkSlots, saveProfile, type PerkId } from '../game/Progress';
import { FPS_CAPS, loadGraphics, maxResolution, presetSettings, type GraphicsSettings } from '../config/Graphics';

/**
 * Main menu + pause menu (liquid glass). Behind it the loaded map renders live
 * from a slow orbiting camera. Menu choices that need a different map / mode /
 * control scheme reload the page with the right URL flags (as before).
 */

export interface MenuOptions {
  map: 'lab' | 'site9';
  mode: 'teams' | 'solo';
  controls: string;
  mobile: boolean;
  onPlay(): void;
}

interface Prefs {
  volume: number;
  sensitivity: number;
  fov: number;
  /** Settings → Graphics (src/config/Graphics.ts). */
  gfx: GraphicsSettings;
  /** 4 Teams: match length in minutes. */
  matchMinutes: number;
}

const PREFS_KEY = 'site9.prefs';

export function loadPrefs(mobile: boolean): Prefs {
  const d: Prefs = { volume: feel.masterVolume, sensitivity: 1, fov: playerConfig.baseFov, gfx: loadGraphics(mobile), matchMinutes: 15 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { ...d, ...saved, gfx: d.gfx };
  } catch {
    return d;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: settings last for this session */
  }
}

const BASE_SENS = playerConfig.mouseSensitivity;

/** Apply saved preferences to the running game. */
export function applyPrefs(game: Game, p: Prefs): void {
  feel.masterVolume = p.volume;
  game.audio?.setVolume(p.volume);
  matchClock.minutes = p.matchMinutes;
  playerConfig.mouseSensitivity = BASE_SENS * p.sensitivity;
  playerConfig.baseFov = p.fov;
  game.applyGraphics(p.gfx);
}

const MAPS = {
  lab: { name: 'WEAPON LAB', tag: 'TRAINING RANGE', text: 'Graybox firing range, robot targets and the Black Division container yard. Learn every gun.' },
  site9: { name: 'SITE-9', tag: 'VANTA DYNAMICS CAMPUS', text: 'Sixteen rooms of a robotics facility gone dark. Four squads, rogue machines, raids.' },
};
const MODES = {
  teams: { name: '4 TEAMS', tag: 'PvPvE', text: 'Your squad of four against three AI squads and the robots. First to 20 000, or extract when the clock runs out.' },
  solo: { name: 'SURVIVAL', tag: 'SOLO', text: 'Classic survival. Open the facility zone by zone; death ends the run.' },
};

const KEYS: [string, string][] = [
  ['W A S D', 'Move'], ['Mouse', 'Look'], ['Shift', 'Sprint'], ['Space', 'Jump'], ['C', 'Crouch'],
  ['Q / E', 'Lean'], ['V', 'Swap shoulder'], ['LMB', 'Fire'], ['RMB', 'Aim down sights'], ['R', 'Reload'],
  ['B', 'Fire mode'], ['1 – 0', 'Weapons'], ['F', 'Use / buy'], ['M', 'Map'], ['L', 'Flashlight / laser'], ['Esc', 'Pause'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

export class MainMenu {
  readonly root: HTMLDivElement;
  private nav: HTMLDivElement;
  private panel: HTMLDivElement;
  private status: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private paused = false;
  private ready = false;
  private backdrop: { cam: THREE.PerspectiveCamera; center: THREE.Vector3; radius: number; height: number; t0: number } | null = null;
  private prefs: Prefs;
  private game: Game | null = null;

  constructor(parent: HTMLElement, private opts: MenuOptions) {
    this.prefs = loadPrefs(opts.mobile);
    this.root = el('div', 'menu', parent);
    document.body.classList.add('in-menu');
    el('div', 'menu-shade', this.root);
    el('div', 'menu-grain', this.root);
    const left = el('div', 'menu-left', this.root);
    el(
      'div',
      'menu-brand',
      left,
      `<div class="menu-kicker"><i></i>VANTA DYNAMICS · RESTRICTED</div>
       <h1 class="menu-title">SITE<span>-</span>9</h1>
       <div class="menu-sub">TACTICAL SQUAD FPS</div>`,
    );
    this.nav = el('div', 'menu-nav', left);
    this.playBtn = this.button('PLAY', 'primary', () => this.play());
    this.playBtn.disabled = true;
    this.button('OPERATIONS', '', () => this.show('operations'), 'operations');
    this.button('ARMORY', '', () => this.show('armory'), 'armory');
    this.button('SETTINGS', '', () => this.show('settings'), 'settings');
    this.button('CONTROLS', '', () => this.show('controls'), 'controls');
    this.button('MAIN MENU', 'tomenu', () => {
      const q = new URLSearchParams(location.search);
      q.set('menu', '1');
      location.search = q.toString();
    });
    // Desktop build (Electron): a real quit.
    if (navigator.userAgent.includes('Electron')) this.button('QUIT', 'quit', () => window.close());
    this.status = el('div', 'menu-status', left, 'Loading…');
    this.profileEl = el('div', 'menu-profile', left);
    this.paintProfile();
    this.panel = el('div', 'menu-panel glass', this.root);
    el('div', 'menu-foot', this.root, '<span>IN DEVELOPMENT</span><span>BUILD 0.3</span>');
    // The panel opens from the nav; until then the unit showcase has the stage.
    this.panel.classList.add('closed');
    // 3D buttons tilt toward the pointer (desktop).
    this.root.addEventListener('pointermove', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.gbtn, .gcard');
      if (!b) return;
      const r = b.getBoundingClientRect();
      b.style.setProperty('--rx', `${(-(e.clientY - r.top - r.height / 2) / r.height) * 8}deg`);
      b.style.setProperty('--ry', `${((e.clientX - r.left - r.width / 2) / r.width) * 10}deg`);
      b.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      b.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    });
    this.root.addEventListener('pointerout', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.gbtn, .gcard');
      if (b && !b.contains(e.relatedTarget as Node)) {
        b.style.setProperty('--rx', '0deg');
        b.style.setProperty('--ry', '0deg');
      }
    });
    window.addEventListener('keydown', (e) => {
      if (this.visible && this.ready && (e.code === 'Enter' || (e.code === 'Space' && this.paused))) this.play();
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private button(label: string, cls: string, onClick: () => void, key?: string): HTMLButtonElement {
    const b = el('button', `gbtn ${cls}`, this.nav, `<span class="gbtn-label">${label}</span><span class="gbtn-shine"></span>`);
    if (key) b.dataset.key = key;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Game finished loading: enable PLAY, start the live backdrop. */
  setReady(game: Game): void {
    this.game = game;
    this.ready = true;
    this.playBtn.disabled = false;
    this.setStatus(this.opts.mobile ? 'Tap PLAY' : 'Press PLAY or Enter');
    applyPrefs(game, this.prefs);
    this.startBackdrop();
  }

  setPaused(p: boolean): void {
    const was = this.paused;
    this.paused = p;
    this.root.classList.toggle('paused', p);
    this.playBtn.querySelector('.gbtn-label')!.textContent = p ? 'RESUME' : 'PLAY';
    if (p) {
      this.setStatus('Paused · Enter or RESUME');
      if (!was) this.show('settings');
    }
  }

  open(): void {
    this.root.classList.remove('hidden');
    document.body.classList.add('in-menu');
  }

  close(): void {
    this.root.classList.add('hidden');
    document.body.classList.remove('in-menu');
  }

  /** PLAY / RESUME: the game requests the mouse; the menu closes once the lock is real. */
  private play(): void {
    if (!this.ready) return;
    this.setStatus(this.paused ? 'Resuming…' : 'Deploying…');
    this.opts.onPlay();
  }

  private section: string | null = null;
  private profileEl: HTMLDivElement;

  /** Level / XP / credits chip under the nav. */
  private paintProfile(): void {
    const p = loadProfile();
    const l = levelOf(p.xp);
    this.profileEl.innerHTML = `<b>LV ${l.level}</b><i style="--p:${((l.into / l.need) * 100).toFixed(1)}%"></i><span>${p.credits} VC</span>`;
  }

  private show(section: 'operations' | 'settings' | 'controls' | 'armory'): void {
    // The same button again closes the panel (back to the showcase).
    if (this.section === section && !this.panel.classList.contains('closed') && !this.paused) {
      this.panel.classList.add('closed');
      this.section = null;
      this.nav.querySelectorAll<HTMLElement>('.gbtn').forEach((b) => b.classList.remove('active'));
      return;
    }
    this.section = section;
    this.panel.classList.remove('closed');
    this.nav.querySelectorAll<HTMLElement>('.gbtn').forEach((b) => b.classList.toggle('active', b.dataset.key === section));
    this.panel.classList.remove('enter');
    void this.panel.offsetWidth;
    this.panel.classList.add('enter');
    if (section === 'operations') this.renderOperations();
    else if (section === 'settings') this.renderSettings();
    else if (section === 'armory') this.renderArmory();
    else this.renderControls();
  }

  private renderOperations(): void {
    const o = this.opts;
    this.panel.innerHTML = '<div class="panel-head">OPERATIONS<i></i></div><div class="panel-label">AREA</div>';
    const maps = el('div', 'gcards', this.panel);
    for (const [id, m] of Object.entries(MAPS)) {
      const c = el('button', `gcard ${id === o.map ? 'active' : ''}`, maps, `<b>${m.name}</b><em>${m.tag}</em><p>${m.text}</p><span class="gbtn-shine"></span>`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id === o.map) return;
        const p = new URLSearchParams(location.search);
        if (id === 'site9') p.set('map', 'site9');
        else p.delete('map');
        p.set('menu', '1');
        location.search = p.toString();
      });
    }
    if (o.map === 'site9') {
      el('div', 'panel-label', this.panel, 'MODE');
      const modes = el('div', 'gcards', this.panel);
      for (const [id, m] of Object.entries(MODES)) {
        const c = el('button', `gcard small ${id === o.mode ? 'active' : ''}`, modes, `<b>${m.name}</b><em>${m.tag}</em><p>${m.text}</p><span class="gbtn-shine"></span>`);
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          if (id === o.mode) return;
          const p = new URLSearchParams(location.search);
          if (id === 'solo') p.set('mode', 'solo');
          else p.delete('mode');
          p.set('menu', '1');
          location.search = p.toString();
        });
      }
    }
    if (o.map === 'site9' && o.mode !== 'solo' && !this.paused) {
      el('div', 'panel-label', this.panel, 'MATCH LENGTH');
      const seg = el('div', 'gseg', this.panel);
      const p = this.prefs;
      for (const m of [10, 15, 20, 30]) {
        const b = el('button', `gseg-btn ${p.matchMinutes === m ? 'active' : ''}`, seg, `${m} MIN`);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          p.matchMinutes = m;
          seg.querySelectorAll('.gseg-btn').forEach((x) => x.classList.toggle('active', x === b));
          savePrefs(p);
          matchClock.minutes = m;
        });
      }
    }
    if (this.paused) el('div', 'panel-note', this.panel, 'Changing area restarts the operation.');
  }

  private renderSettings(): void {
    const p = this.prefs;
    this.panel.innerHTML = '<div class="panel-head">SETTINGS<i></i></div>';
    const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void) => {
      const row = el('label', 'gslider', this.panel, `<span>${label}</span><output>${fmt(value)}</output>`);
      const input = el('input', '', row) as HTMLInputElement;
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
      paint();
      input.addEventListener('input', () => {
        const v = Number(input.value);
        row.querySelector('output')!.textContent = fmt(v);
        paint();
        set(v);
        savePrefs(p);
        if (this.game) applyPrefs(this.game, p);
      });
    };
    slider('MASTER VOLUME', 0, 1, 0.01, p.volume, (v) => `${Math.round(v * 100)}`, (v) => (p.volume = v));
    slider('MOUSE SENSITIVITY', 0.3, 2.5, 0.05, p.sensitivity, (v) => v.toFixed(2), (v) => (p.sensitivity = v));
    slider('FIELD OF VIEW', 70, 110, 1, p.fov, (v) => `${v}°`, (v) => (p.fov = v));
    this.renderGraphics(el('div', 'gfx', this.panel));
    el('div', 'panel-label', this.panel, 'CONTROL SCHEME');
    const seg = el('div', 'gseg', this.panel);
    for (const [id, label] of [['auto', 'AUTO'], ['pc', 'KEYBOARD + MOUSE'], ['mobile', 'TOUCH']]) {
      const b = el('button', `gseg-btn ${this.opts.controls === id ? 'active' : ''}`, seg, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id === this.opts.controls) return;
        try {
          localStorage.setItem('weaponlab.controls', id);
        } catch {
          /* storage blocked */
        }
        const q = new URLSearchParams(location.search);
        q.delete('touch');
        q.delete('mouse');
        q.set('menu', '1');
        location.search = q.toString();
      });
    }
  }

  /** Graphics block of the settings panel (refilled in place when a preset is picked). */
  private renderGraphics(box: HTMLDivElement): void {
    const p = this.prefs;
    const g = p.gfx;
    box.innerHTML = '';
    const changed = (custom = true) => {
      if (custom) {
        g.preset = 'custom';
        box.querySelectorAll<HTMLElement>('[data-preset]').forEach((x) => x.classList.toggle('active', x.dataset.preset === 'custom'));
      }
      savePrefs(p);
      if (this.game) applyPrefs(this.game, p);
    };
    const seg = <T extends string | number>(label: string, items: [T, string][], value: T, set: (v: T) => void, note?: string) => {
      el('div', 'panel-label', box, note ? `${label} <em>${note}</em>` : label);
      const s = el('div', 'gseg', box);
      for (const [id, text] of items) {
        const b = el('button', `gseg-btn ${value === id ? 'active' : ''}`, s, text);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          s.querySelectorAll('.gseg-btn').forEach((x) => x.classList.toggle('active', x === b));
          set(id);
          changed();
        });
      }
    };

    el('div', 'panel-label', box, 'GRAPHICS PRESET');
    const ps = el('div', 'gseg', box);
    for (const [id, text] of [['performance', 'LOW'], ['balanced', 'MEDIUM'], ['quality', 'HIGH'], ['custom', 'CUSTOM']] as const) {
      const b = el('button', `gseg-btn ${g.preset === id ? 'active' : ''}`, ps, text);
      b.dataset.preset = id;
      if (id === 'custom') {
        b.disabled = true;
        continue;
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const keep = { fpsCap: g.fpsCap, showFps: g.showFps };
        Object.assign(g, presetSettings(id, this.opts.mobile), keep);
        changed(false);
        this.renderGraphics(box);
      });
    }

    // Resolution: shows the real render size.
    const maxR = maxResolution(this.opts.mobile);
    const res = (v: number) => `${Math.round(window.innerWidth * v)}×${Math.round(window.innerHeight * v)}`;
    const row = el('label', 'gslider', box, `<span>RESOLUTION</span><output>${res(g.resolution)}</output>`);
    const input = el('input', '', row) as HTMLInputElement;
    input.type = 'range';
    input.min = '0.5';
    input.max = String(maxR);
    input.step = '0.05';
    input.value = String(Math.min(g.resolution, maxR));
    const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - 0.5) / (maxR - 0.5)) * 100}%`);
    paint();
    input.addEventListener('input', () => {
      row.querySelector('output')!.textContent = res(Number(input.value));
      paint();
    });
    // Resizing the framebuffer per slider tick would stutter: apply on release.
    input.addEventListener('change', () => {
      g.resolution = Number(input.value);
      changed();
    });

    seg('FRAME RATE LIMIT', FPS_CAPS.map((f) => [f, f ? `${f}` : 'MAX'] as [number, string]), g.fpsCap, (v) => (g.fpsCap = v), this.opts.mobile ? '60 keeps phones cool' : '');
    seg('SHADOWS', [['off', 'OFF'], ['low', 'LOW'], ['high', 'HIGH']], g.shadows, (v) => (g.shadows = v));
    seg('LIGHTING', [['fast', 'FAST'], ['full', 'FULL · REFLECTIONS']], g.lighting, (v) => (g.lighting = v));
    seg('VIEW DISTANCE', [['near', 'NEAR'], ['medium', 'MEDIUM'], ['far', 'FAR']], g.viewDistance, (v) => (g.viewDistance = v));

    const toggles = el('div', 'gtoggles', box);
    const toggle = (label: string, on: boolean, set: (v: boolean) => void, custom = true) => {
      const t = el('button', `gtoggle ${on ? 'on' : ''}`, toggles, `<span>${label}</span><i></i>`);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = !t.classList.contains('on');
        t.classList.toggle('on', v);
        set(v);
        changed(custom);
      });
    };
    toggle('DYNAMIC RESOLUTION', g.dynamicResolution, (v) => (g.dynamicResolution = v));
    toggle('POST EFFECTS', g.postFx, (v) => (g.postFx = v));
    toggle('ANTI-ALIASING (RESTART)', g.antialias, (v) => (g.antialias = v));
    toggle('SHOW FPS', g.showFps, (v) => (g.showFps = v), false);
  }

  /** Spend Vanta Credits: starting sidearm and perks (they apply from the next raid). */
  private renderArmory(): void {
    const p = loadProfile();
    const lv = levelOf(p.xp);
    this.panel.innerHTML = `<div class="panel-head">ARMORY<i></i></div>
      <div class="arm-top"><b>LEVEL ${lv.level}</b><i style="--p:${((lv.into / lv.need) * 100).toFixed(1)}%"></i><em>${lv.into} / ${lv.need} XP</em><span>${p.credits} VC</span></div>
      <div class="panel-note">Earn XP and Vanta Credits (VC) from every raid: kills, time alive, placement. Extract for ×1.5 and to carry 10 % of your cash out. Changes apply from your next raid.</div>`;
    const card = (parent: HTMLElement, u: { id: string; name: string; text: string; level: number; cost: number }, state: 'equipped' | 'owned' | 'buy' | 'locked', onClick: () => void) => {
      const tag = state === 'equipped' ? 'EQUIPPED' : state === 'owned' ? 'EQUIP' : state === 'buy' ? `${u.cost} VC` : `LEVEL ${u.level}`;
      const c = el('button', `gcard small arm ${state}`, parent, `<b>${u.name}</b><p>${u.text}</p><span class="arm-tag">${tag}</span><span class="gbtn-shine"></span>`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
    };
    const redraw = () => {
      saveProfile(p);
      this.paintProfile();
      this.renderArmory();
    };
    el('div', 'panel-label', this.panel, 'STARTING SIDEARM');
    const side = el('div', 'gcards', this.panel);
    for (const w of SIDEARMS) {
      const owned = p.owned.includes(w.id);
      const state = p.sidearm === w.id ? 'equipped' : owned ? 'owned' : lv.level < w.level ? 'locked' : 'buy';
      card(side, w, state, () => {
        if (state === 'locked' || state === 'equipped') return;
        if (state === 'buy') {
          if (p.credits < w.cost) return;
          p.credits -= w.cost;
          p.owned.push(w.id);
        }
        p.sidearm = w.id;
        redraw();
      });
    }
    const slots = perkSlots(lv.level);
    el('div', 'panel-label', this.panel, `PERKS · ${p.perks.length} / ${slots} EQUIPPED${slots < 2 ? ' · SECOND SLOT AT LEVEL 8' : ''}`);
    const perks = el('div', 'gcards', this.panel);
    for (const k of PERKS) {
      const owned = p.owned.includes(k.id);
      const on = p.perks.includes(k.id);
      const state = on ? 'equipped' : owned ? 'owned' : lv.level < k.level ? 'locked' : 'buy';
      card(perks, k, state, () => {
        if (state === 'locked') return;
        if (state === 'buy') {
          if (p.credits < k.cost) return;
          p.credits -= k.cost;
          p.owned.push(k.id);
        }
        if (on) p.perks = p.perks.filter((x) => x !== k.id);
        else {
          p.perks = [...p.perks, k.id as PerkId];
          while (p.perks.length > slots) p.perks.shift();
        }
        redraw();
      });
    }
  }

  private renderControls(): void {
    this.panel.innerHTML = '<div class="panel-head">CONTROLS<i></i></div>';
    const grid = el('div', 'keys', this.panel);
    for (const [k, what] of KEYS) {
      const caps = k.split(' / ').map((c) => `<kbd>${c}</kbd>`).join('<em>/</em>');
      el('div', 'key-row', grid, `<span class="caps">${caps}</span><span>${what}</span>`);
    }
    if (this.opts.mobile) el('div', 'panel-note', this.panel, 'Touch: left side moves, right side looks. FIRE also aims while held.');
  }

  // ---------------------------------------------------------------- live backdrop

  private startBackdrop(): void {
    const g = this.game!;
    const arena = g.arena as unknown as { rooms?: { id: string; rect: number[] }[]; spawn: THREE.Vector3 };
    const atrium = arena.rooms?.find((r) => r.id === 'atrium');
    const center = atrium ? new THREE.Vector3((atrium.rect[0] + atrium.rect[2]) / 2, 5, (atrium.rect[1] + atrium.rect[3]) / 2) : arena.spawn.clone().add(new THREE.Vector3(0, 1.6, -18));
    const cam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 400);
    this.backdrop = { cam, center, radius: atrium ? 24 : 15, height: atrium ? 8 : 3.2, t0: performance.now() };
    // Unit showcase on a dark stage (falls back to the map flyover if it can't build).
    let show: Showcase | null = null;
    const cap = el('div', 'showcase-cap', this.root);
    try {
      show = new Showcase(g.showcaseDeps(), (l) => {
        cap.classList.remove('in');
        void cap.offsetWidth;
        cap.innerHTML = `<b>${l.name}</b><i>${l.tag}</i><span>${l.text}</span>`;
        cap.classList.add('in');
      });
    } catch (e) {
      console.warn('showcase unavailable', e);
      cap.remove();
    }
    let last = performance.now();
    const tick = () => {
      const b = this.backdrop;
      if (!b || g.running) {
        this.backdrop = null;
        cap.remove();
        show?.dispose();
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (show) {
        show.update(dt, innerWidth / innerHeight);
        const r = g.renderer;
        r.setSize(innerWidth, innerHeight);
        r.clear();
        r.render(show.scene, show.camera);
        requestAnimationFrame(tick);
        return;
      }
      const t = (now - b.t0) / 1000;
      const a = 0.55 + t * 0.028;
      b.cam.aspect = innerWidth / innerHeight;
      b.cam.position.set(b.center.x + Math.sin(a) * b.radius, b.center.y + b.height + Math.sin(t * 0.21) * 0.6, b.center.z + Math.cos(a) * b.radius);
      b.cam.lookAt(b.center.x, b.center.y + Math.sin(t * 0.17) * 0.4, b.center.z);
      b.cam.updateProjectionMatrix();
      const r = g.renderer;
      r.setSize(innerWidth, innerHeight);
      r.clear();
      r.render(g.scene, b.cam);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
