import * as THREE from 'three';
import { DEG } from '../core/math';
import { feel } from '../config/Feel';

export type HitKind = 'hit' | 'crit' | 'kill';

interface DamageNumber {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
  life: number;
  active: boolean;
}

/**
 * Gameplay HUD: dynamic crosshair, hit markers (hit / crit / kill read
 * instantly by shape + colour, no text), ammo, reload bar, optional damage numbers.
 * All DOM is created once; per-frame updates only touch transforms/opacity.
 */
export class HUD {
  readonly root: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private lines: HTMLDivElement[] = [];
  private hitmarker: HTMLDivElement;
  private killRing: HTMLDivElement;
  private ammoEl: HTMLDivElement;
  private magEl: HTMLSpanElement;
  private weaponEl: HTMLDivElement;
  private reloadBar: HTMLDivElement;
  private reloadFill: HTMLDivElement;
  private killsEl: HTMLDivElement;
  private modeEl: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private toastTime = 0;
  private lastMode = '';
  private numbers: DamageNumber[] = [];
  private tmp = new THREE.Vector3();
  private kills = 0;
  private lastAmmo = -1;
  private lastMag = -1;
  private lastWeapon = '';

  constructor(parent: HTMLElement) {
    this.root = div('hud', parent);
    this.crosshair = div('crosshair', this.root);
    for (let i = 0; i < 4; i++) this.lines.push(div(`ch-line ch-${i}`, this.crosshair));
    div('ch-dot', this.crosshair);
    this.hitmarker = div('hitmarker', this.root);
    for (let i = 0; i < 4; i++) div(`hm-line hm-${i}`, this.hitmarker);
    this.killRing = div('kill-ring', this.root);

    const ammo = div('ammo', this.root);
    this.weaponEl = div('ammo-weapon', ammo);
    this.modeEl = div('ammo-mode', ammo);
    const row = div('ammo-row', ammo);
    this.ammoEl = div('ammo-count', row);
    this.magEl = document.createElement('span');
    this.magEl.className = 'ammo-mag';
    row.appendChild(this.magEl);
    this.reloadBar = div('reload-bar', ammo);
    this.reloadFill = div('reload-fill', this.reloadBar);
    this.killsEl = div('kills', this.root);
    this.killsEl.textContent = '';
    this.toastEl = div('toast', this.root);

    for (let i = 0; i < 24; i++) {
      const el = div('dmg-num', this.root);
      this.numbers.push({ el, pos: new THREE.Vector3(), age: 0, life: 0.8, active: false });
    }
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  /** Short message (fire mode, zero, inspect, lab actions). */
  toast(text: string, seconds = 1.4): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTime = seconds;
  }

  /**
   * Debug-only camera crosshair (point fire needs none: shots go where the gun points).
   * The gap shows mechanical dispersion.
   */
  updateCrosshair(spreadDeg: number, fovDeg: number, adsAmount: number, blocked: boolean): void {
    if (!feel.debugCrosshair) {
      this.crosshair.style.display = 'none';
      return;
    }
    this.crosshair.style.display = '';
    const h = window.innerHeight;
    const px = (Math.tan(spreadDeg * DEG) / Math.tan((fovDeg * DEG) / 2)) * (h / 2);
    const gap = Math.max(4, px);
    this.lines[0].style.transform = `translate(-50%, ${-gap - 10}px)`;
    this.lines[1].style.transform = `translate(-50%, ${gap}px)`;
    this.lines[2].style.transform = `translate(${-gap - 10}px, -50%)`;
    this.lines[3].style.transform = `translate(${gap}px, -50%)`;
    this.crosshair.style.opacity = String((1 - adsAmount * 1.4) * (blocked ? 0.35 : 1));
  }

  showHit(kind: HitKind): void {
    const el = this.hitmarker;
    el.className = 'hitmarker';
    void el.offsetWidth; // restart CSS animation
    el.className = `hitmarker ${kind}`;
    el.style.setProperty('--hm-scale', String(feel.hitmarkerScale));
    if (kind === 'kill') {
      this.kills++;
      this.killsEl.textContent = `${this.kills}`;
      this.killsEl.className = 'kills';
      void this.killsEl.offsetWidth;
      this.killsEl.className = 'kills pop';
      const r = this.killRing;
      r.className = 'kill-ring';
      void r.offsetWidth;
      r.className = 'kill-ring show';
    }
  }

  damageNumber(pos: THREE.Vector3, amount: number, kind: HitKind): void {
    if (!feel.damageNumbers) return;
    const n = this.numbers.find((x) => !x.active) ?? this.numbers[0];
    n.active = true;
    n.age = 0;
    n.life = kind === 'kill' ? 1.1 : 0.8;
    n.pos.copy(pos);
    n.pos.x += (Math.random() - 0.5) * 0.25;
    n.pos.y += 0.1;
    n.el.textContent = String(Math.round(amount));
    n.el.className = `dmg-num ${kind}`;
    n.el.style.display = 'block';
  }

  /** @param mag shown after the slash (magazine size, or spare rounds in Survival); @param magSize for the low-ammo warning */
  updateAmmo(weaponName: string, ammo: number, chambered: boolean, mag: number, mode: string, reloadProgress: number, magSize = mag): void {
    if (weaponName !== this.lastWeapon) {
      this.weaponEl.textContent = weaponName;
      this.lastWeapon = weaponName;
    }
    if (mode !== this.lastMode) {
      this.modeEl.textContent = mode;
      this.lastMode = mode;
    }
    const shown = ammo * 2 + (chambered ? 1 : 0);
    if (shown !== this.lastAmmo || mag !== this.lastMag) {
      this.ammoEl.textContent = String(ammo);
      this.magEl.textContent = `${chambered ? '+1' : ''} / ${mag}`;
      this.lastAmmo = shown;
      this.ammoEl.classList.toggle('low', ammo <= Math.ceil(magSize * 0.25));
      this.lastMag = mag;
    }
    if (reloadProgress >= 0) {
      this.reloadBar.style.opacity = '1';
      this.reloadFill.style.transform = `scaleX(${reloadProgress})`;
    } else {
      this.reloadBar.style.opacity = '0';
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    if (this.toastTime > 0) {
      this.toastTime -= dt;
      if (this.toastTime <= 0) this.toastEl.classList.remove('show');
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const n of this.numbers) {
      if (!n.active) continue;
      n.age += dt;
      if (n.age >= n.life) {
        n.active = false;
        n.el.style.display = 'none';
        continue;
      }
      this.tmp.copy(n.pos);
      this.tmp.y += n.age * 0.6;
      this.tmp.project(camera);
      if (this.tmp.z > 1) {
        n.el.style.opacity = '0';
        continue;
      }
      const x = (this.tmp.x * 0.5 + 0.5) * w;
      const y = (-this.tmp.y * 0.5 + 0.5) * h;
      const t = n.age / n.life;
      n.el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 + Math.max(0, 0.3 - n.age) * 1.5})`;
    }
  }
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}
