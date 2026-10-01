/**
 * Toggleable debug readout (H key / DBG button). Updates at 10 Hz so the
 * text itself never costs frame time.
 */
export interface DebugStats {
  fps: number;
  frameMs: number;
  weapon: string;
  state: string;
  ammo: string;
  rpm: number;
  spread: number;
  recoilHeat: number;
  speed: number;
  grounded: boolean;
  ads: number;
  hitDistance: number;
  lastDamage: string;
  targetHealth: string;
  drawCalls: number;
  triangles: number;
  particles: number;
}

export class DebugHUD {
  private el: HTMLPreElement;
  private acc = 0;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.className = 'debug-hud';
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  update(dt: number, s: DebugStats): void {
    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    this.el.textContent =
      `FPS        ${s.fps.toFixed(0)}  (${s.frameMs.toFixed(1)} ms)\n` +
      `Weapon     ${s.weapon}\n` +
      `State      ${s.state}\n` +
      `Ammo       ${s.ammo}\n` +
      `Fire rate  ${s.rpm} rpm\n` +
      `Spread     ${s.spread.toFixed(2)}°\n` +
      `Recoil     heat ${s.recoilHeat.toFixed(2)}\n` +
      `ADS        ${(s.ads * 100).toFixed(0)}%\n` +
      `Speed      ${s.speed.toFixed(2)} m/s ${s.grounded ? '' : '(air)'}\n` +
      `Hit dist   ${s.hitDistance >= 0 ? s.hitDistance.toFixed(1) + ' m' : '-'}\n` +
      `Last dmg   ${s.lastDamage}\n` +
      `Target HP  ${s.targetHealth}\n` +
      `Draws      ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\n` +
      `Particles  ${s.particles}`;
  }
}
