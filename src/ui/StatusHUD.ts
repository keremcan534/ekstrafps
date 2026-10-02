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
  private dmg: HTMLDivElement;
  private supp: HTMLDivElement;
  private comms: HTMLDivElement;
  private squad: HTMLDivElement;
  private death: HTMLDivElement;
  private downed: HTMLDivElement;
  private indicators: Indicator[] = [];
  private dmgLevel = 0;
  private suppLevel = 0;
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
    this.comms = div('comms', parent);
    this.squad = div('squad-line', parent);
    for (let i = 0; i < 6; i++) this.indicators.push({ el: div('hit-ind', parent), from: new THREE.Vector3(), life: 0 });
    this.downed = div('downed', parent);
    this.death = div('death-screen', parent);
    this.death.innerHTML = '<div class="death-title">K.I.A.</div><div class="death-sub">BLACK DIVISION</div><div class="death-hint">respawning…</div>';
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
  radio(text: string, tag = 'BLACK DIVISION', friendly = false): void {
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
    this.downed.innerHTML = `<div class="downed-title">DOWNED</div><div class="downed-sub">${revive > 0 ? 'Being revived…' : 'Hold on, help is coming'} · ${Math.ceil(seconds)}s</div><div class="downed-bar"><i style="transform:scaleX(${revive.toFixed(3)})"></i></div>`;
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
    this.dmg.style.opacity = Math.min(1, this.dmgLevel + hurt).toFixed(3);
    this.supp.style.opacity = this.suppLevel.toFixed(3);
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
