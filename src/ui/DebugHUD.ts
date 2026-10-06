/**
 * Toggleable debug readout (H key / DBG button). Updates at 10 Hz so the
 * text itself never costs frame time.
 */
import type * as THREE from 'three';
import type { Viewmodel } from '../weapons/Viewmodel';

export interface DebugStats {
  fps: number;
  frameMs: number;
  weapon: string;
  state: string;
  ammo: string;
  fireMode: string;
  ammoType: string;
  rpm: number;
  weight: number;
  length: number;
  ergonomics: number;
  moment: number;
  stamina: number;
  adsTime: number;
  ads: number;
  cameraDir: THREE.Vector3;
  muzzleDir: THREE.Vector3;
  aimError: number;
  /** Aimed alignment of a profiled weapon (ADSPoint against its solved place). */
  adsAlign: Viewmodel['adsCheck'];
  recoil: THREE.Vector2;
  inertia: THREE.Vector2;
  sway: THREE.Vector2;
  speed: number;
  grounded: boolean;
  stance: string;
  moa: number;
  muzzleVelocity: number;
  impactSpeed: number;
  zero: number;
  wall: string;
  hitDistance: number;
  lastDamage: string;
  targetHealth: string;
  drawCalls: number;
  particles: number;
  projectiles: number;
  timeScale: number;
}

const fmt = (v: THREE.Vector3): string => `${v.x.toFixed(3)} ${v.y.toFixed(3)} ${v.z.toFixed(3)}`;
const align = (a: DebugStats['adsAlign']): string =>
  !a.profiled
    ? 'old placement'
    : !a.aimed
      ? '-'
      : `solve ${a.solveDeg.toFixed(3)}° ${a.solveMm.toFixed(2)} mm | now ${a.liveDeg.toFixed(2)}° roll ${a.liveRollDeg.toFixed(2)}° | rest ${a.restDeg.toFixed(3)}°`;
const bar = (v: number): string => '█'.repeat(Math.round(v * 10)).padEnd(10, '░');

export class DebugHUD {
  private el: HTMLPreElement;
  private acc = 0;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.className = 'debug-hud';
    parent.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? '' : 'none';
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  update(dt: number, s: DebugStats): void {
    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    this.el.textContent =
      `FPS        ${s.fps.toFixed(0)} (${s.frameMs.toFixed(1)} ms)${s.timeScale !== 1 ? `  SLOW-MO x${s.timeScale}` : ''}\n` +
      `Weapon     ${s.weapon}  [${s.fireMode}]  ${s.rpm} rpm\n` +
      `State      ${s.state}   ammo ${s.ammo}\n` +
      `Ammo       ${s.ammoType}\n` +
      `── handling ─────────────\n` +
      `Weight     ${s.weight.toFixed(2)} kg   Length ${s.length.toFixed(2)} m\n` +
      `Ergonomics ${s.ergonomics.toFixed(0)}   Inertia ${s.moment.toFixed(2)} kg·m\n` +
      `Arm stam.  ${bar(s.stamina)} ${(s.stamina * 100).toFixed(0)}%\n` +
      `ADS        ${(s.ads * 100).toFixed(0)}%   ADS time ${s.adsTime.toFixed(2)} s\n` +
      `── aim ──────────────────\n` +
      `Camera dir ${fmt(s.cameraDir)}\n` +
      `Weapon dir ${fmt(s.muzzleDir)}\n` +
      `Aim error  ${s.aimError.toFixed(2)}° (camera vs bore)\n` +
      `ADS align  ${align(s.adsAlign)}\n` +
      `Recoil     v ${s.recoil.x.toFixed(2)}°  h ${s.recoil.y.toFixed(2)}°\n` +
      `Inertia    p ${s.inertia.x.toFixed(2)}°  y ${s.inertia.y.toFixed(2)}°\n` +
      `Sway       p ${s.sway.x.toFixed(3)}°  y ${s.sway.y.toFixed(3)}°\n` +
      `Wall       ${s.wall}\n` +
      `── ballistics ───────────\n` +
      `MOA        ${s.moa.toFixed(2)}   Zero ${s.zero} m\n` +
      `Muzzle vel ${s.muzzleVelocity.toFixed(0)} m/s   impact ${s.impactSpeed.toFixed(0)} m/s\n` +
      `Hit dist   ${s.hitDistance >= 0 ? s.hitDistance.toFixed(1) + ' m' : '-'}   dmg ${s.lastDamage}\n` +
      `Target HP  ${s.targetHealth}\n` +
      `── player ───────────────\n` +
      `Velocity   ${s.speed.toFixed(2)} m/s ${s.grounded ? '' : '(air)'}  ${s.stance}\n` +
      `Draws ${s.drawCalls}  particles ${s.particles}  bullets ${s.projectiles}`;
  }
}
