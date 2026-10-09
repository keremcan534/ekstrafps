import { matchClock } from '../game/TeamMatch';
import type { Game } from '../core/Game';
import { feel } from '../config/Feel';
import { MenuMusic } from '../audio/MenuMusic';
import { MenuWardenVoice } from '../audio/MenuWardenVoice';
import { playerConfig } from '../player/PlayerConfig';
import { MenuScene } from './MenuScene';
import { Dossier } from './Dossier';
import { Terminal } from '../minigames/Terminal';
import { makeGrime, wearMask } from './DossierGrime';
import { PERKS, SIDEARMS, levelOf, loadProfile, perkSlots, saveProfile, type PerkId } from '../game/Progress';
import { skillsPanelHtml } from './SkillsUI';
import { FPS_CAPS, loadGraphics, maxResolution, presetSettings, type GraphicsSettings } from '../config/Graphics';
import { isTouchDevice } from '../core/math';
import { HUD_PRESETS, applyHudLayout, editHudLayout, loadHudLayout, saveHudLayout, type HudPreset } from './HudLayout';

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
  /** Touch aim assist strength (× the tuned default; 0 = off). */
  aimAssist: number;
  /** Room tone and distant building noises under everything. */
  ambience: boolean;
  /** Menu soundtrack level (× master). */
  music: number;
  /** The corner minimap (the full map on M stays either way). */
  minimap: boolean;
}

const PREFS_KEY = 'site9.prefs';

export function loadPrefs(mobile: boolean): Prefs {
  const d: Prefs = { volume: feel.masterVolume, sensitivity: 1, fov: playerConfig.baseFov, gfx: loadGraphics(mobile), matchMinutes: 15, aimAssist: 1, ambience: false, music: 0.6, minimap: true };
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

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

/** Reload with new URL flags, replacing this history entry (Back doesn't walk through menu reloads). */
function reload(q: URLSearchParams): void {
  location.replace(`?${q.toString()}`);
}

/**
 * Two steps for anything that throws work away or spends: the first click arms it (its label
 * asks), a second within 3 s does it. `label` is where the question is written.
 */
function confirmTwice(b: HTMLElement, ask: string, act: () => void, label: HTMLElement = b.querySelector<HTMLElement>('.gbtn-label') ?? b): void {
  if (b.classList.contains('armed')) {
    b.classList.remove('armed');
    label.innerHTML = b.dataset.was ?? label.innerHTML;
    act();
    return;
  }
  b.dataset.was = label.innerHTML;
  b.classList.add('armed');
  label.textContent = ask;
  window.setTimeout(() => {
    if (!b.classList.contains('armed')) return;
    b.classList.remove('armed');
    label.innerHTML = b.dataset.was!;
  }, 3000);
}

/** A short word on a control that can't do what was asked ("NEED 500 MORE VC"), then its label back. */
function refuse(label: HTMLElement, text: string): void {
  if (label.dataset.was === undefined) label.dataset.was = label.innerHTML;
  label.textContent = text;
  window.setTimeout(() => {
    label.innerHTML = label.dataset.was!;
    delete label.dataset.was;
  }, 1400);
}

/** Panel heads: the way back. */
const PANEL_X = '<button class="panel-x" aria-label="Back" title="Back (Esc)">✕</button>';

const BASE_SENS = playerConfig.mouseSensitivity;
const BASE_TOUCH_SENS = playerConfig.touchSensitivity;
const BASE_ASSIST = playerConfig.touchAimAssist;

/** Apply saved preferences to the running game. */
export function applyPrefs(game: Game, p: Prefs): void {
  feel.masterVolume = p.volume;
  game.audio?.setVolume(p.volume);
  matchClock.minutes = p.matchMinutes;
  playerConfig.mouseSensitivity = BASE_SENS * p.sensitivity;
  playerConfig.touchSensitivity = BASE_TOUCH_SENS * p.sensitivity;
  playerConfig.touchAimAssist = Math.min(1, BASE_ASSIST * p.aimAssist);
  playerConfig.baseFov = p.fov;
  game.applyGraphics(p.gfx);
  game.ambienceOn = p.ambience;
  game.mapOverlay?.setMinimap(p.minimap);
}

const MAPS = {
  lab: { name: 'WEAPON LAB', tag: 'TRAINING RANGE', text: 'Graybox firing range, robot targets and the SABLE container yard. Learn every gun.' },
  site9: { name: 'SITE-9', tag: 'VANTA DYNAMICS CAMPUS', text: 'Sixteen rooms of a robotics facility gone dark, 40 km from Blackpine. Four squads, rogue machines, raids.' },
};
const MODES = {
  teams: { name: '4 TEAMS', tag: 'PvPvE', text: 'Your squad of four against three AI squads and the robots. No score cap: build your lead, then extract when the clock runs out.' },
  solo: { name: 'SURVIVAL', tag: 'SOLO', text: 'Classic survival. Open the facility zone by zone; death ends the run.' },
};

/** Spectator scenarios: sit back and watch the AI squads fight (free camera). */
const WATCH = {
  J: { q: 'aitest=J', name: '3v3 FIREFIGHT', tag: 'AI vs AI', text: 'Two squads, even start, long fight. Cover, flanks, suppression, callouts.' },
  E: { q: 'aitest=E', name: 'SQUAD BATTLE', tag: 'AI vs AI', text: 'Three on three across the yard. Fly around while they fight it out.' },
  match: { q: 'map=site9&mode=teams&watch', name: 'AI TEAM MATCH', tag: 'SITE-9 · NO PLAYER', text: 'Three AI squads race for supply drops. Live stats on screen (F6).' },
};

const KEYS: [string, string][] = [
  ['W A S D', 'Move'], ['Mouse', 'Look'], ['Shift', 'Sprint'], ['Space', 'Jump'], ['C', 'Crouch'],
  ['Q / E', 'Lean'], ['V', 'Swap shoulder'], ['LMB', 'Fire'], ['RMB', 'Aim down sights'], ['R', 'Reload'],
  ['B', 'Fire mode'], ['1 – 0', 'Weapons'], ['F', 'Use / buy'], ['M', 'Map'], ['L', 'Flashlight / laser'], ['G', 'Observer (lab)'], ['Esc', 'Pause'],
  ['P', 'Tuning panel (Weapon Lab)'],
];

/** Phones: what each control does. */
const TOUCH_HELP: [string, string][] = [
  ['Left side', 'Move (the stick appears under your thumb). Push up past the ring to lock sprint.'],
  ['Right side', 'Look'],
  ['Fire', 'Shoot; hold to keep firing, drag while holding to aim'],
  ['Aim', 'Aim down sights (tap); drag on it to aim'], ['Reload', 'Reload'], ['Jump / crouch', 'Bottom right'], ['Lean', 'Small arrows near Aim'],
  ['Weapon strip', 'Tap to swap weapon; tap AUTO / SEMI to change fire mode'], ['USE', 'Appears next to things you can buy or use'], ['❚❚', 'Pause / settings'],
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
  private prefs: Prefs;
  private game: Game | null = null;
  private music = new MenuMusic();
  private warden: MenuWardenVoice;

  constructor(parent: HTMLElement, private opts: MenuOptions) {
    this.prefs = loadPrefs(opts.mobile);
    this.music.volume = this.prefs.music;
    this.music.play();
    this.root = el('div', 'menu', parent);
    document.body.classList.add('in-menu');
    // The stage: a photograph with snow and mist (no 3D render in the menu).
    // He breathes and, now and then, speaks; not over the dossier or the terminal.
    this.warden = new MenuWardenVoice(this.root, opts.mobile, () => !this.root.classList.contains('dossier-open') && !this.terminal?.isOpen);
    new MenuScene(this.root, opts.mobile, () => this.ready && this.visible && !this.paused, this.warden);
    el('div', 'menu-shade', this.root);
    el('div', 'menu-grain', this.root);
    const left = el('div', 'menu-left', this.root);
    el(
      'div',
      'menu-brand',
      left,
      `<h1 class="menu-title">SITE<span>-</span>9</h1>`,
    );
    this.nav = el('div', 'menu-nav', left);
    this.playBtn = this.button('PLAY', 'primary', () => this.play());
    this.playBtn.disabled = true;
    this.button('OPERATIONS', '', () => this.show('operations'), 'operations');
    this.button('ARMORY', '', () => this.show('armory'), 'armory');
    this.button('SKILLS', '', () => this.show('skills'), 'skills');
    this.button('DOSSIER', '', () => this.openDossier(), 'dossier');
    this.button('TERMINAL', '', () => this.openTerminal(), 'terminal');
    this.button('SETTINGS', '', () => this.show('settings'), 'settings');
    this.button('CONTROLS', '', () => this.show('controls'), 'controls');
    // Leaving a raid throws it away: ask first.
    const toMenu = this.button('MAIN MENU', 'tomenu', () =>
      confirmTwice(toMenu, 'ABANDON RAID? CLICK AGAIN', () => {
        const q = new URLSearchParams(location.search);
        q.set('menu', '1');
        reload(q);
      }),
    );
    // Desktop build (Electron): a real quit.
    if (navigator.userAgent.includes('Electron')) {
      const quit = this.button('QUIT', 'quit', () => confirmTwice(quit, this.paused ? 'QUIT MID-RAID? CLICK AGAIN' : 'QUIT? CLICK AGAIN', () => window.close()));
    }
    this.status = el('div', 'menu-status', left, 'Loading…');
    this.profileEl = el('div', 'menu-profile', left);
    this.paintProfile();
    this.panel = el('div', 'menu-panel glass', this.root);
    this.panel.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.panel-x')) return;
      e.stopPropagation();
      this.closePanel();
    });
    el('div', 'menu-foot', this.root, '<span></span><span>BUILD 0.3</span>');
    // Dust, scratches and a vignette over everything, as on the dossier's desk.
    const grime = makeGrime();
    this.root.style.setProperty('--grime-screen', `url(${grime.screen})`);
    this.root.style.setProperty('--menu-wear', `url(${wearMask()})`);
    el('div', 'menu-dirt', this.root);
    // The panel opens from the nav; until then the unit showcase has the stage.
    this.panel.classList.add('closed');
    // 3D buttons tilt toward the pointer (desktop; on touch it only costs layout reads).
    if (!opts.mobile) {
      this.root.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
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
    }
    window.addEventListener('keydown', (e) => {
      if (this.dossier?.open || this.terminal?.isOpen || !this.visible) return;
      const t = e.target as HTMLElement | null;
      // Esc / Backspace: back out of the open panel.
      if ((e.code === 'Escape' || (e.code === 'Backspace' && !t?.closest?.('input, textarea'))) && this.section) {
        e.preventDefault();
        this.closePanel();
        return;
      }
      // A focused control takes its own Enter / Space (a card, a slider): no deploying on top of it.
      if (t?.closest?.('button, input, select, textarea') && t !== this.playBtn) return;
      if (this.ready && (e.code === 'Enter' || (e.code === 'Space' && this.paused))) this.play();
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

  /** Game finished loading: enable PLAY. */
  setReady(game: Game): void {
    this.game = game;
    this.ready = true;
    this.playBtn.disabled = false;
    this.setStatus(this.opts.mobile ? 'Tap PLAY' : 'Press PLAY or Enter');
    applyPrefs(game, this.prefs);
  }

  setPaused(p: boolean): void {
    const was = this.paused;
    this.paused = p;
    this.root.classList.toggle('paused', p);
    if (p) document.body.classList.remove('menu-stage');
    // The full map (M) closes with the pause, so it isn't still over the view on resume.
    if (p && this.game?.mapOverlay?.visible) this.game.mapOverlay.toggle();
    this.playBtn.querySelector('.gbtn-label')!.textContent = p ? 'RESUME' : 'PLAY';
    // The soundtrack is for the front door only, not the pause screen mid-raid.
    if (p) this.music.stop();
    if (p) {
      this.setStatus('Paused · Enter or RESUME');
      if (!was) this.show('settings');
    }
  }

  open(): void {
    if (!this.paused) this.music.play();
    this.root.classList.remove('hidden');
    document.body.classList.add('in-menu');
  }

  close(): void {
    this.music.stop();
    document.body.classList.remove('menu-stage');
    this.root.classList.add('hidden');
    document.body.classList.remove('in-menu');
  }

  /** PLAY / RESUME: the game requests the mouse; the menu closes once the lock is real. */
  private play(): void {
    if (!this.ready) return;
    this.setStatus(this.paused ? 'Resuming…' : 'Deploying…');
    this.music.stop();
    if (!this.paused) this.warden.proceed();
    this.opts.onPlay();
  }

  private section: string | null = null;
  private dossier: Dossier | null = null;

  private terminal: Terminal | null = null;

  /** ELEKTRON-30, the death tapes: full screen over the menu (Esc returns). `id` runs one tape and closes. */
  openTerminal(id?: string): void {
    this.terminal ??= new Terminal(document.body);
    this.terminal.open(id);
  }

  /** The character dossier: full screen over the menu (Esc / Back returns). */
  private openDossier(): void {
    this.dossier ??= new Dossier(this.root, () => this.root.classList.remove('dossier-open'), (name, volume) => this.game?.audio.play(name, { volume }));
    this.root.classList.add('dossier-open');
    this.dossier.show();
  }
  private profileEl: HTMLDivElement;

  /** Level / XP / credits chip under the nav. */
  private paintProfile(): void {
    const p = loadProfile();
    const l = levelOf(p.xp);
    this.profileEl.innerHTML = `<b>LV ${l.level}</b><i style="--p:${((l.into / l.need) * 100).toFixed(1)}%"></i><span>${p.credits} VC</span>`;
  }

  /** Back to the stage: the side panel closes (✕, Esc, or its nav button again). */
  /** Phones' back gesture inside the menu: close what's on top (terminal, dossier, panel). True if something closed. */
  back(): boolean {
    if (this.terminal?.isOpen) this.terminal.close();
    else if (this.dossier?.open) this.dossier.close();
    else if (this.section) this.closePanel();
    else return false;
    return true;
  }

  private closePanel(): void {
    this.panel.classList.add('closed');
    this.section = null;
    this.nav.querySelectorAll<HTMLElement>('.gbtn').forEach((b) => b.classList.remove('active'));
  }

  private show(section: 'operations' | 'settings' | 'controls' | 'armory' | 'skills'): void {
    // The same button again closes the panel (back to the showcase).
    if (this.section === section && !this.panel.classList.contains('closed')) return this.closePanel();
    this.section = section;
    this.panel.classList.remove('closed');
    this.nav.querySelectorAll<HTMLElement>('.gbtn').forEach((b) => b.classList.toggle('active', b.dataset.key === section));
    this.panel.classList.remove('enter');
    void this.panel.offsetWidth;
    this.panel.classList.add('enter');
    if (section === 'operations') this.renderOperations();
    else if (section === 'settings') this.renderSettings();
    else if (section === 'armory') this.renderArmory();
    else if (section === 'skills') this.renderSkills();
    else this.renderControls();
  }

  private renderOperations(): void {
    const o = this.opts;
    this.panel.innerHTML = `<div class="panel-head">OPERATIONS<i></i>${PANEL_X}</div><div class="panel-label">AREA</div>`;
    const maps = el('div', 'gcards', this.panel);
    // In an AI watch scenario the map / mode cards lead back to the normal game.
    const here = new URLSearchParams(location.search);
    const watching = here.has('aitest') || here.has('watch');
    for (const [id, m] of Object.entries(MAPS)) {
      const c = el('button', `gcard ${id === o.map && !watching ? 'active' : ''}`, maps, `<b>${m.name}</b><em>${m.tag}</em><p>${m.text}</p><span class="gbtn-shine"></span>`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id === o.map && !watching) return;
        store('weaponlab.map', id);
        const p = new URLSearchParams(location.search);
        p.delete('aitest');
        p.delete('watch');
        if (id === 'site9') p.set('map', 'site9');
        else p.delete('map');
        p.set('menu', '1');
        reload(p);
      });
    }
    // Watch the AI: spectator scenarios (WASD fly, Shift fast, Space / C up and down).
    el('div', 'panel-label', this.panel, 'AI WATCH');
    const watch = el('div', 'gcards', this.panel);
    for (const [id, w] of Object.entries(WATCH)) {
      const on = id === 'match' ? here.has('watch') : here.get('aitest') === id;
      const c = el('button', `gcard small ${on ? 'active' : ''}`, watch, `<b>${w.name}</b><em>${w.tag}</em><p>${w.text}</p><span class="gbtn-shine"></span>`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (on) return;
        reload(new URLSearchParams(w.q));
      });
    }
    if (o.map === 'site9') {
      el('div', 'panel-label', this.panel, 'MODE');
      const modes = el('div', 'gcards', this.panel);
      for (const [id, m] of Object.entries(MODES)) {
        const c = el('button', `gcard small ${id === o.mode && !watching ? 'active' : ''}`, modes, `<b>${m.name}</b><em>${m.tag}</em><p>${m.text}</p><span class="gbtn-shine"></span>`);
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          if (id === o.mode && !watching) return;
          store('weaponlab.mode', id);
          const p = new URLSearchParams(location.search);
          p.delete('aitest');
          p.delete('watch');
          if (id === 'solo') p.set('mode', 'solo');
          else p.delete('mode');
          p.set('menu', '1');
          reload(p);
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
    this.panel.innerHTML = `<div class="panel-head">SETTINGS<i></i>${PANEL_X}</div>`;
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
    slider('MUSIC VOLUME', 0, 1, 0.01, p.music, (v) => `${Math.round(v * 100)}`, (v) => (p.music = this.music.volume = v));
    slider(this.opts.mobile ? 'LOOK SENSITIVITY' : 'MOUSE SENSITIVITY', 0.3, 2.5, 0.05, p.sensitivity, (v) => v.toFixed(2), (v) => (p.sensitivity = v));
    slider('FIELD OF VIEW', 70, 110, 1, p.fov, (v) => `${v}°`, (v) => (p.fov = v));
    const toggles = el('div', 'gtoggles', this.panel);
    const pref = (label: string, key: 'ambience' | 'minimap') => {
      const t = el('button', `gtoggle ${p[key] ? 'on' : ''}`, toggles, `<span>${label}</span><i></i>`);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        p[key] = !p[key];
        t.classList.toggle('on', p[key]);
        savePrefs(p);
        if (this.game) applyPrefs(this.game, p);
      });
    };
    pref('BACKGROUND AMBIENCE', 'ambience');
    pref('MINIMAP', 'minimap');
    this.renderGraphics(el('div', 'gfx', this.panel));
    el('div', 'panel-label', this.panel, 'CONTROL SCHEME');
    const seg = el('div', 'gseg', this.panel);
    // AUTO shows what it found on this device.
    const found = isTouchDevice() ? 'PHONE' : 'PC';
    for (const [id, label] of [['auto', `AUTO · ${found}`], ['pc', 'KEYBOARD + MOUSE'], ['mobile', 'TOUCH']]) {
      const b = el('button', `gseg-btn ${this.opts.controls === id ? 'active' : ''}`, seg, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id === this.opts.controls) return;
        const go = () => {
          store('weaponlab.controls', id);
          const q = new URLSearchParams(location.search);
          q.delete('touch');
          q.delete('mouse');
          q.set('menu', '1');
          reload(q);
        };
        // It reloads the game: mid-raid, that ends the raid.
        if (this.paused) confirmTwice(b, 'ENDS THE RAID · AGAIN', go);
        else go();
      });
    }
    el('div', 'panel-note', this.panel, this.paused ? 'Changing the control scheme restarts the game: the raid is lost.' : 'Changing the control scheme reloads the game.');
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
    const presets = [['auto', 'AUTO'], ['performance', 'LOW'], ['balanced', 'MEDIUM'], ['quality', 'HIGH'], ['custom', 'CUSTOM']] as const;
    for (const [id, text] of presets.filter(([id]) => id !== 'auto' || this.opts.mobile)) {
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
    if (g.preset === 'auto') el('div', 'panel-note', box, 'AUTO raises the quality while your phone holds the frame rate limit (60 by default) and lowers it when it can’t. Pick 120 below for a 120 Hz screen: AUTO then keeps 120 fps first. It remembers what your phone handles.');

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
    // On-device benchmark: ~40 s in game, then a chart of what costs how much (with COPY).
    const bench = el('button', 'gbtn bench-btn', box, '<span class="gbtn-label">RUN BENCHMARK</span><span class="gbtn-shine"></span>');
    el('div', 'panel-note', box, 'Starts the game and measures for ~40 s: what each part (HUD, resolution, 3D, AI, effects, characters, audio) costs in FPS. Don’t touch the screen while it runs.');
    // It plays the game for ~40 s: not from the pause menu (it would run over the raid), and asked first.
    if (this.paused) {
      bench.nextElementSibling?.remove();
      bench.remove();
      return;
    }
    bench.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.game) return;
      confirmTwice(bench, 'START ~40 s BENCHMARK? CLICK AGAIN', () => {
        this.game!.runBenchmark();
        this.play();
      });
    });
  }

  /** Spend Vanta Credits: starting sidearm and perks (they apply from the next raid). */
  private renderArmory(): void {
    const p = loadProfile();
    const lv = levelOf(p.xp);
    this.panel.innerHTML = `<div class="panel-head">ARMORY<i></i>${PANEL_X}</div>
      <div class="arm-top"><b>LEVEL ${lv.level}</b><i style="--p:${((lv.into / lv.need) * 100).toFixed(1)}%"></i><em>${lv.into} / ${lv.need} XP</em><span>${p.credits} VC</span></div>
      <div class="panel-note">Earn XP and Vanta Credits (VC) from every raid: kills, time alive, placement. Extract for ×1.5 and to carry 10 % of your cash out. Changes apply from your next raid.</div>`;
    const card = (parent: HTMLElement, u: { id: string; name: string; text: string; level: number; cost: number }, state: 'equipped' | 'owned' | 'buy' | 'locked', onClick: (c: HTMLButtonElement, tag: HTMLElement) => void) => {
      const tag = state === 'equipped' ? 'EQUIPPED' : state === 'owned' ? 'EQUIP' : state === 'buy' ? `${u.cost} VC` : `LEVEL ${u.level}`;
      const c = el('button', `gcard small arm ${state}`, parent, `<b>${u.name}</b><p>${u.text}</p><span class="arm-tag">${tag}</span><span class="gbtn-shine"></span>`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(c, c.querySelector<HTMLElement>('.arm-tag')!);
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
      card(side, w, state, (c, tag) => {
        if (state === 'equipped') return;
        if (state === 'locked') return refuse(tag, `UNLOCKS AT LEVEL ${w.level}`);
        if (state === 'buy') {
          if (p.credits < w.cost) return refuse(tag, `NEED ${w.cost - p.credits} MORE VC`);
          // Spending is asked once more, on the card itself.
          return confirmTwice(c, `BUY · ${w.cost} VC?`, () => {
            p.credits -= w.cost;
            p.owned.push(w.id);
            p.sidearm = w.id;
            redraw();
          }, tag);
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
      card(perks, k, state, (c, tag) => {
        if (state === 'locked') return refuse(tag, `UNLOCKS AT LEVEL ${k.level}`);
        const equip = () => {
          if (on) p.perks = p.perks.filter((x) => x !== k.id);
          else {
            p.perks = [...p.perks, k.id as PerkId];
            while (p.perks.length > slots) p.perks.shift();
          }
          redraw();
        };
        if (state === 'buy') {
          if (p.credits < k.cost) return refuse(tag, `NEED ${k.cost - p.credits} MORE VC`);
          return confirmTwice(c, `BUY · ${k.cost} VC?`, () => {
            p.credits -= k.cost;
            p.owned.push(k.id);
            equip();
          }, tag);
        }
        // Slots full: equipping this one takes off the oldest; say which first.
        if (!on && p.perks.length >= slots) {
          const out = PERKS.find((x) => x.id === p.perks[0]);
          return confirmTwice(c, `REPLACES ${out?.name.toUpperCase() ?? 'A PERK'}?`, equip, tag);
        }
        equip();
      });
    }
  }

  /** Skills: grown in raids (Skills.ts), shown with what each gives now and at the next level. */
  private renderSkills(): void {
    this.panel.innerHTML = `<div class="panel-head">SKILLS<i></i>${PANEL_X}</div>${skillsPanelHtml()}`;
  }

  private renderControls(): void {
    this.panel.innerHTML = `<div class="panel-head">CONTROLS<i></i>${PANEL_X}</div>`;
    if (this.opts.mobile) return this.renderTouchControls();
    const grid = el('div', 'keys', this.panel);
    for (const [k, what] of KEYS) {
      const caps = k.split(' / ').map((c) => `<kbd>${c}</kbd>`).join('<em>/</em>');
      el('div', 'key-row', grid, `<span class="caps">${caps}</span><span>${what}</span>`);
    }
  }

  /** Phones: what the buttons do, their size / opacity / layout, aim assist. */
  private renderTouchControls(): void {
    const p = this.prefs;
    const hud = loadHudLayout();
    const edit = el('button', 'gbtn hud-edit-btn', this.panel, '<span class="gbtn-label">CUSTOMIZE HUD LAYOUT</span><span class="gbtn-shine"></span>');
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.root.classList.add('hidden');
      editHudLayout(() => {
        this.root.classList.remove('hidden');
        this.renderControls();
      });
    });
    // Presets: two thumbs, three fingers, four-finger claw (each resets your own changes).
    el('div', 'panel-label', this.panel, 'LAYOUT PRESET');
    const presets = el('div', 'gseg', this.panel);
    const note = el('div', 'panel-note', this.panel, HUD_PRESETS[hud.preset].text);
    for (const id of Object.keys(HUD_PRESETS) as HudPreset[]) {
      const b = el('button', `gseg-btn ${hud.preset === id ? 'active' : ''}`, presets, HUD_PRESETS[id].name);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        hud.preset = id;
        hud.items = {};
        saveHudLayout(hud);
        applyHudLayout(hud);
        presets.querySelectorAll('.gseg-btn').forEach((x) => x.classList.toggle('active', x === b));
        note.textContent = HUD_PRESETS[id].text;
      });
    }
    const slider = (label: string, min: number, max: number, value: number, set: (v: number) => void) => {
      const row = el('label', 'gslider', this.panel, `<span>${label}</span><output>${Math.round(value * 100)}%</output>`);
      const input = el('input', '', row) as HTMLInputElement;
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = '0.05';
      input.value = String(value);
      const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
      paint();
      input.addEventListener('input', () => {
        const v = Number(input.value);
        row.querySelector('output')!.textContent = `${Math.round(v * 100)}%`;
        paint();
        set(v);
      });
    };
    slider('BUTTON SIZE', 0.6, 1.4, hud.size, (v) => {
      hud.size = v;
      saveHudLayout(hud);
      applyHudLayout(hud);
    });
    slider('BUTTON OPACITY', 0.3, 1, hud.opacity, (v) => {
      hud.opacity = v;
      saveHudLayout(hud);
      applyHudLayout(hud);
    });
    const ff = el('button', `gtoggle ${hud.floatFire ? 'on' : ''}`, el('div', 'gtoggles', this.panel), '<span>FLOATING FIRE BUTTON</span><i></i>');
    ff.addEventListener('click', (e) => {
      e.stopPropagation();
      hud.floatFire = !hud.floatFire;
      ff.classList.toggle('on', hud.floatFire);
      saveHudLayout(hud);
      applyHudLayout(hud);
    });
    el('div', 'panel-label', this.panel, 'AIM ASSIST');
    const seg = el('div', 'gseg', this.panel);
    for (const [v, label] of [[0, 'OFF'], [0.6, 'LOW'], [1, 'NORMAL'], [1.5, 'STRONG']] as const) {
      const b = el('button', `gseg-btn ${Math.abs(p.aimAssist - v) < 0.01 ? 'active' : ''}`, seg, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        p.aimAssist = v;
        seg.querySelectorAll('.gseg-btn').forEach((x) => x.classList.toggle('active', x === b));
        savePrefs(p);
        if (this.game) applyPrefs(this.game, p);
      });
    }
    const grid = el('div', 'keys', this.panel);
    for (const [k, what] of TOUCH_HELP) el('div', 'key-row', grid, `<span class="caps"><kbd>${k}</kbd></span><span>${what}</span>`);
  }

}
