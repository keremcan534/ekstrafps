import * as THREE from 'three';

interface Indicator {
  el: HTMLDivElement;
  from: THREE.Vector3;
  life: number;
}

const div = (cls: string, parent: HTMLElement) => {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
};

/**
 * Player-condition HUD: health bar, red damage vignette, directional hit
 * indicators (point at the shooter, track as you turn), dark suppression
 * vignette from near misses, enemy radio subtitles and the death screen.
 */
export class StatusHUD {
  private hpFill: HTMLDivElement;
  private hpText: HTMLDivElement;
  private hpBox: HTMLDivElement;
  private armorFill: HTMLDivElement;
  private lastArmor = -1;
  private dmg: HTMLDivElement;
  private supp: HTMLDivElement;
  private comms: HTMLDivElement;
  private squad: HTMLDivElement;
  private death: HTMLDivElement;
  private downed: HTMLDivElement;
  private downedSub: HTMLDivElement;
  private downedBar: HTMLElement;
  private downedKey = '';
  private downedBarKey = '';
  private indicators: Indicator[] = [];
  private dmgLevel = 0;
  private suppLevel = 0;
  /** Last written vignette opacities (quantised), so idle frames write nothing. */
  private dmgShown = -1;
  private suppShown = -1;
  private commsTime = 0;
  private lastHp = -1;
  private tmp = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.dmg = div('dmg-vignette', parent);
    this.supp = div('supp-vignette', parent);
    this.hpBox = div('hp', parent);
    const bar = div('hp-bar', this.hpBox);
    this.hpFill = div('hp-fill', bar);
    this.hpText = div('hp-text', this.hpBox);
    const ab = div('armor-bar', this.hpBox);
    this.armorFill = div('armor-fill', ab);
    this.comms = div('comms', parent);
    this.squad = div('squad-line', parent);
    for (let i = 0; i < 6; i++) this.indicators.push({ el: div('hit-ind', parent), from: new THREE.Vector3(), life: 0 });
    this.downed = div('downed', parent);
    div('downed-title', this.downed).textContent = 'DOWNED';
    this.downedSub = div('downed-sub', this.downed);
    this.downedBar = document.createElement('i');
    div('downed-bar', this.downed).appendChild(this.downedBar);
    this.death = div('death-screen', parent);
    this.death.innerHTML = '<div class="death-title">K.I.A.</div><div class="death-sub">SABLE</div><div class="death-hint">respawning…</div>';
  }

  damaged(amount: number, from: THREE.Vector3 | null): void {
    this.dmgLevel = Math.min(1, this.dmgLevel + 0.35 + amount / 60);
    if (!from) return;
    const slot = this.indicators.reduce((a, b) => (a.life <= b.life ? a : b));
    slot.from.copy(from);
    slot.life = 2.2;
  }

  suppress(amount: number): void {
    this.suppLevel = Math.min(1, this.suppLevel + amount);
  }

  /** Enemy radio line as a subtitle. */
  radio(text: string, tag = 'SABLE', friendly = false): void {
    this.comms.innerHTML = `<span class="comms-tag${friendly ? ' friendly' : ''}">${tag}</span> ${text}`;
    this.comms.classList.add('show');
    this.commsTime = 2.8;
  }

  setSquadLine(text: string): void {
    if (this.squad.textContent !== text) this.squad.textContent = text;
  }

  /** Last stand: bleed-out seconds and revive progress (0..1); seconds < 0 hides it. */
  setDowned(seconds: number, revive = 0): void {
    if (seconds < 0) {
      this.downed.classList.remove('show');
      return;
    }
    this.downed.classList.add('show');
    // Nodes are built once; only the text (per whole second) and the bar change.
    const sub = `${revive > 0 ? 'Being revived…' : 'Hold on, help is coming'} · ${Math.ceil(seconds)}s`;
    if (sub !== this.downedKey) {
      this.downedKey = sub;
      this.downedSub.textContent = sub;
    }
    const bar = revive.toFixed(3);
    if (bar !== this.downedBarKey) {
      this.downedBarKey = bar;
      this.downedBar.style.transform = `scaleX(${bar})`;
    }
  }

  /** Vignette opacity in 1/64 steps, written only on change; hidden (display:none) at 0. */
  private setVignette(el: HTMLDivElement, v: number, shown: number): number {
    const q = Math.round(Math.min(1, v) * 64) / 64;
    if (q === shown) return shown;
    if (q === 0) el.style.display = 'none';
    else if (shown <= 0) el.style.display = '';
    el.style.opacity = String(q);
    return q;
  }

  /** Armor plates left, 0..1 (hidden at 0). */
  setArmor(k: number): void {
    const v = Math.round(k * 100);
    if (v === this.lastArmor) return;
    this.lastArmor = v;
    this.armorFill.parentElement!.style.display = v > 0 ? '' : 'none';
    this.armorFill.style.transform = `scaleX(${k})`;
  }

  setDead(dead: boolean): void {
    this.death.classList.toggle('show', dead);
  }

  update(dt: number, health: number, max: number, camera: THREE.Camera): void {
    if (health !== this.lastHp) {
      this.lastHp = health;
      const k = health / max;
      this.hpFill.style.transform = `scaleX(${k})`;
      this.hpText.textContent = `${Math.ceil(health)}`;
      this.hpBox.classList.toggle('low', k < 0.35);
    }
    this.dmgLevel = Math.max(0, this.dmgLevel - dt * 0.9);
    this.suppLevel = Math.max(0, this.suppLevel - dt * 0.45);
    // Persistent red edge while badly hurt.
    const hurt = Math.max(0, 0.4 - health / max) * 1.2;
    this.dmgShown = this.setVignette(this.dmg, this.dmgLevel + hurt, this.dmgShown);
    this.suppShown = this.setVignette(this.supp, this.suppLevel, this.suppShown);
    this.commsTime -= dt;
    if (this.commsTime <= 0) this.comms.classList.remove('show');

    // Indicators: angle of the shooter relative to where we look, on screen.
    const yaw = Math.atan2(camera.matrixWorld.elements[8], camera.matrixWorld.elements[10]);
    for (const ind of this.indicators) {
      if (ind.life <= 0) {
        if (ind.el.style.opacity !== '0') ind.el.style.opacity = '0';
        continue;
      }
      ind.life -= dt;
      const d = this.tmp.subVectors(ind.from, camera.position);
      const a = Math.atan2(-d.x, -d.z) - yaw;
      ind.el.style.transform = `translate(-50%, -50%) rotate(${(-a * 180) / Math.PI}deg) translateY(-150px)`;
      ind.el.style.opacity = Math.min(1, ind.life).toFixed(3);
    }
  }
}
