import * as THREE from 'three';
import type { CameraState, Shot, ShotCtx } from '../Director';
import type { Game } from '../../core/Game';
import type { Input } from '../../core/Input';
import type { RogueRobot } from '../../enemies/RogueRobot';
import type { TeamAgent } from '../../game/TeamAgent';
import { feel } from '../../config/Feel';
import { playerConfig } from '../../player/PlayerConfig';
import { DEG, hfovToVfov } from '../../core/math';
import { ease, handheld } from '../stage';

/**
 * Site-9 combat takes (real gameplay): the player is driven by scripted input
 * through the real controller (aim, recoil, reloads, ballistics); robots and
 * squadmates run their real AI. Every take is filmed by several cameras at once.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface S9 {
  game: Game;
  robots: RogueRobot[];
  allies: TeamAgent[];
  /** Cached hit/target bookkeeping for the pilot. */
  target: RogueRobot | null;
  semi: boolean;
}
let S: S9 | null = null;

export function survival(game: Game) {
  return game.survival as unknown as {
    robots: RogueRobot[];
    doors: { open: boolean }[];
    openDoor(d: unknown, populate: boolean): void;
    over: boolean;
  };
}

/** Facility in a power cut, director off, every shutter open, no signage, god mode. */
export function stage(ctx: ShotCtx, at: THREE.Vector3, yaw: number, weapon: string): S9 {
  const game = ctx.game;
  const sv = survival(game);
  sv.over = true; // no Left 4 Dead director: the take places every robot itself
  for (const d of sv.doors) if (!d.open) sv.openDoor(d, false);
  feel.godMode = true;
  feel.infiniteAmmo = false;
  game.lighting?.setRaid(true);
  game.player.teleport(at, yaw);
  game.weapons.giveWeapon(weapon);
  for (const w of game.weapons.weapons) w.refill();
  // Floating price / label signs are UI, not world: never in frame.
  game.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if ((o as THREE.Mesh).isMesh && m && (m as THREE.Material).type === 'MeshBasicMaterial' && m.map instanceof THREE.CanvasTexture) o.visible = false;
  });
  dressHall(game);
  return { game, robots: [], allies: [], target: null, semi: false };
}

/**
 * Practical set lights for the assembly-hall aisle (trailer staging): pulsing red
 * emergency lamps, one cold work-light pool, low haze. The aisle runs along x
 * between the conveyor lines at z = -21 and z = -5 (centre z = -13).
 */
export const AISLE_Z = -13;
let pulses: { light: THREE.PointLight; base: number; phase: number }[] = [];
function dressHall(game: Game): void {
  pulses = [];
  for (const [x, z, ph] of [[-44, AISLE_Z + 5.8, 0], [-58, AISLE_Z - 5.8, 1.7], [-72, AISLE_Z + 5.8, 3.1], [-84, AISLE_Z - 4, 4.4]] as const) {
    const l = new THREE.PointLight(0xff2a14, 30, 16, 1.6);
    l.position.set(x, 4.2, z);
    game.scene.add(l);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3018).multiplyScalar(4) }));
    lamp.position.copy(l.position);
    game.scene.add(lamp);
    pulses.push({ light: l, base: 30, phase: ph });
  }
  const pool = new THREE.SpotLight(0xcfdcf0, 120, 22, 0.42, 0.65, 1.3);
  pool.position.set(-50.5, 10, AISLE_Z);
  pool.target.position.set(-50.5, 0, AISLE_Z);
  pool.castShadow = true;
  pool.shadow.mapSize.set(1024, 1024);
  game.scene.add(pool, pool.target);
  const far = new THREE.SpotLight(0xffa860, 60, 26, 0.5, 0.7, 1.3);
  far.position.set(-74, 10, AISLE_Z + 2);
  far.target.position.set(-74, 0, AISLE_Z);
  game.scene.add(far, far.target);
  game.scene.fog = new THREE.FogExp2(0x07080b, 0.022);
}

export function pulse(t: number): void {
  for (const p of pulses) p.light.intensity = p.base * (0.35 + 0.65 * Math.max(0, Math.sin(t * 2.2 + p.phase)) ** 2);
}

function robot(s: S9, at: THREE.Vector3, opts: { hp?: number; speed?: number; mode?: 'idle' | 'step' | 'rise'; yaw?: number } = {}): RogueRobot {
  const r = survival(s.game).robots.find((o) => !o.active)!;
  const yaw = opts.yaw ?? Math.atan2(s.game.player.feet.x - at.x, s.game.player.feet.z - at.z);
  r.spawn(at, opts.hp ?? 150, opts.speed ?? 1.7, 0, opts.mode ?? 'idle', yaw);
  s.robots.push(r);
  return r;
}

export function ally(s: S9, at: THREE.Vector3, weapon: string): TeamAgent {
  const a = (s.game as unknown as { addAlly(at: THREE.Vector3, hired: boolean): TeamAgent }).addAlly(at, true);
  a.arm(weapon);
  s.allies.push(a);
  return a;
}

export const chest = (r: RogueRobot, out = new THREE.Vector3()) => out.set(r.pos.x, 1.28, r.pos.z);
const head = (r: RogueRobot, out = new THREE.Vector3()) => out.set(r.pos.x, 1.68, r.pos.z);

/** Turn the real view toward a point like a player would (smoothed), through the input path. */
export function aimAt(game: Game, input: Input, dt: number, p: THREE.Vector3, rate = 9): number {
  const eye = game.camera.eye;
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  const dz = p.z - eye.z;
  const ey = wrap(Math.atan2(-dx, -dz) - game.player.yaw);
  const ep = Math.atan2(dy, Math.hypot(dx, dz)) - game.player.pitch;
  const k = 1 - Math.exp(-rate * Math.max(dt, 1 / 120));
  const fovScale = Math.tan((game.camera.currentFov * DEG) / 2) / Math.tan((hfovToVfov(playerConfig.baseFov) * DEG) / 2);
  input.lookYaw = (ey * k) / fovScale;
  input.lookPitch = (ep * k) / fovScale;
  return Math.hypot(ey, ep) / DEG;
}

function nearestAlive(s: S9, from: THREE.Vector3, maxDist = 45): RogueRobot | null {
  let best: RogueRobot | null = null;
  let bd = maxDist;
  for (const r of s.robots) {
    if (!r.alive) continue;
    const d = r.pos.distanceTo(from);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

/** Trigger discipline: hold for auto bursts, tap for semi weapons (one press every `tap` s). */
let lastTap = -9;
export function trigger(input: Input, t: number, want: boolean, tap = 0): void {
  if (!want) {
    input.pressFire(false);
    return;
  }
  if (tap <= 0) {
    input.pressFire(true);
    return;
  }
  const down = t - lastTap >= tap;
  if (down) lastTap = t;
  input.pressFire(down);
}

/** Camera that looks from an offset (in a subject's facing frame) at a point on it. */
export function follow(subject: { pos: THREE.Vector3; yaw: number }, local: THREE.Vector3, aimLocal: THREE.Vector3, lens: number, t: number, hand = 0.01, seed = 0): CameraState {
  const c = Math.cos(subject.yaw);
  const s = Math.sin(subject.yaw);
  // facing frame: forward (s, 0, c), right (c, 0, -s)
  const toWorld = (l: THREE.Vector3) => v(subject.pos.x + l.x * c + l.z * s, l.y, subject.pos.z - l.x * s + l.z * c);
  const pos = toWorld(local).add(handheld(t, hand, seed));
  return { pos, target: toWorld(aimLocal), lens };
}

export const NIGHT_POST = { exposure: 0.78, contrast: 1.22, bloom: { strength: 0.8, radius: 0.6, threshold: 0.8 }, saturation: 0.8 };

// ------------------------------------------------------------------ FIRST CONTACT

/**
 * Assembly hall, lights out. The operator walks in (flashlight), robots stand
 * powered-down along the aisle. Stop, aim, first shot; the rest wake and come.
 * Covers C01 C05 C06 C07 D01-D08 E04-E06 I03.
 */
export const FC: Shot = {
  map: 'site9',
  duration: 17,
  preroll: 3.5,
  handles: 0,
  setup(ctx) {
    // Down the aisle (facing -x): A stands in the work-light pool ~11 m ahead.
    const s = (S = stage(ctx, v(-34.5, 0.1, AISLE_Z), Math.PI / 2, 'm4a1'));
    robot(s, v(-50.5, 0, AISLE_Z - 0.4), { hp: 150, speed: 1.25 }); // A: the first target, survives two hits
    robot(s, v(-54.5, 0, AISLE_Z + 2.6), { hp: 140, speed: 1.7 });
    robot(s, v(-56.5, 0, AISLE_Z - 3), { hp: 140, speed: 1.5 });
    robot(s, v(-64, 0, AISLE_Z + 1), { hp: 140, speed: 2.2 });
    robot(s, v(-69, 0, AISLE_Z - 2.5), { hp: 140, speed: 2.0 });
  },
  update(ctx) {
    pulse(ctx.t);
  },
  input(ctx, input) {
    const s = S!;
    const g = ctx.game;
    const t = ctx.t;
    if (t < 0) return;
    // Walk in slowly, then stop.
    input.moveY = t < 2.2 ? 0.32 : 0;
    const A = s.robots[0];
    const tgt = t < 6 ? (A.alive ? A : nearestAlive(s, g.player.feet)) : nearestAlive(s, g.player.feet);
    if (!tgt) {
      trigger(input, t, false);
      return;
    }
    // Before contact: look around the dark hall, then settle on the shape at the far end.
    const look = t < 2.2 ? chest(A).add(v(0, -0.6, Math.sin(t * 0.9) * 3.5)) : t < 4.6 ? head(tgt) : chest(tgt);
    const err = aimAt(g, input, ctx.dt, look, t < 3 ? 2.2 : 6);
    input.adsHeld = t > 3.3 && !(t > 8.6 && t < 10.6);
    // First shot at 4.6 s (sync point), then measured pairs; reload ~9 s; lean right after.
    const firing = t > 4.6 && err < 1.6 && !(t > 8.7 && t < 10.7);
    trigger(input, t, firing, 0.17);
    input.reloadPressed = t > 8.75 && t < 8.8;
    input.leanAxis = 0;
  },
  cams: {
    pov: 'pov',
    // Low on the first robot, looking back toward the light.
    low: (ctx) => {
      const A = S!.robots[0];
      return follow({ pos: A.pos, yaw: A.yaw }, v(-0.9, 0.35, 1.6), v(0.1, 1.45, 0), 24, ctx.t, 0.006, 1);
    },
    // Over the operator's shoulder (the player has no 3rd-person body: framed past it).
    ots: (ctx) => {
      const g = ctx.game;
      const f = g.player.feet;
      const yaw = g.player.yaw;
      const back = v(Math.sin(yaw), 0, Math.cos(yaw));
      const right = v(Math.cos(yaw), 0, -Math.sin(yaw));
      const pos = f.clone().addScaledVector(back, 1.3).addScaledVector(right, 0.55).setY(1.75).add(handheld(ctx.t, 0.01, 3));
      const A = S!.robots[0];
      return { pos, target: chest(A).lerp(f.clone().setY(1.3), 0.15), lens: 35 };
    },
  },
  post: () => NIGHT_POST,
};

// ------------------------------------------------------------------ SQUAD

/**
 * Same hall: you and three Vanta squadmates hold the near end while robots pour
 * out of the charging bays. Covers F01-F12, H01-H23, E02 E03, G-reset cutaways.
 */
export const SQ: Shot = {
  map: 'site9',
  duration: 22,
  preroll: 3.5,
  handles: 0,
  setup(ctx) {
    const s = (S = stage(ctx, v(-40, 0.1, AISLE_Z), Math.PI / 2, 'ak47'));
    ally(s, v(-40.5, 0, AISLE_Z + 2.6), 'm4a1');
    ally(s, v(-38.5, 0, AISLE_Z - 2.8), 'ak47');
    ally(s, v(-36.5, 0, AISLE_Z + 1.2), 'mosin');
    for (const a of s.allies) a.soldier.skill = 1.6;
  },
  update(ctx) {
    const s = S!;
    // Wave schedule: bays along the back wall and the left wall, then a sprinter rush.
    pulse(ctx.t);
    const z = AISLE_Z;
    const waves: [number, THREE.Vector3, number][] = [
      [0.0, v(-58, 0, z + 1), 1.7], [0.2, v(-62, 0, z - 3), 1.8], [0.5, v(-60, 0, z + 4), 1.6],
      [3.0, v(-72, 0, z), 2.2], [3.4, v(-75, 0, z + 4), 2.0], [3.8, v(-70, 0, z - 4), 2.4],
      [7.0, v(-80, 0, z - 2), 2.6], [7.3, v(-82, 0, z + 3), 2.6], [7.6, v(-78, 0, z + 5), 3.0],
      [11.0, v(-84, 0, z), 3.2], [11.2, v(-80, 0, z - 4), 3.0], [11.5, v(-86, 0, z + 2), 3.4], [11.8, v(-76, 0, z + 5), 2.8],
      [15.0, v(-82, 0, z - 3), 3.4], [15.3, v(-85, 0, z + 4), 3.4], [15.6, v(-80, 0, z + 1), 3.0],
    ];
    const placed = s as unknown as { wave?: RogueRobot[] };
    if (!placed.wave) placed.wave = waves.map(([, at, sp]) => robot(s, at, { hp: 130, speed: sp, mode: 'idle' }));
    waves.forEach(([time], i) => {
      const r = placed.wave![i];
      if (ctx.t >= time && r.dormant) r.wake();
    });
  },
  input(ctx, input) {
    const s = S!;
    const g = ctx.game;
    const t = ctx.t;
    if (t < 0) return;
    const tgt = nearestAlive(s, g.player.feet, 40);
    if (!tgt) return trigger(input, t, false);
    const err = aimAt(g, input, ctx.dt, chest(tgt), 5);
    input.adsHeld = t > 1.5 && !(t > 9 && t < 11.4);
    // Bursts: 0.5 s on, 0.35 s off; empty-ish reload at 9 s.
    const burst = (t % 0.85) < 0.5;
    trigger(input, t, err < 2.2 && burst && !(t > 9 && t < 11.4) && t > 2.4, 0);
    input.reloadPressed = t > 9.05 && t < 9.1;
    input.leanAxis = 0;
  },
  cams: {
    pov: 'pov',
    // Frontal low wide: the squad firing toward the lens (from the robots' side).
    front: (ctx) => {
      const g = ctx.game;
      const c = g.player.feet.clone().add(v(-9, 0, 1.2));
      return { pos: c.add(handheld(ctx.t, 0.02, 4)).setY(0.7), target: g.player.feet.clone().add(v(0, 1.3, 1.2)), lens: 28 };
    },
    // Profile on squadmate 1 (35 mm, shoulder height).
    mate: (ctx) => {
      const a = S!.allies[0].soldier;
      return follow({ pos: a.pos, yaw: a.yaw ?? 0 }, v(1.6, 1.5, 0.9), v(0, 1.4, 0.4), 35, ctx.t, 0.012, 5);
    },
    // Robot's-eye charge: low behind the lead robot looking at the squad.
    robo: (ctx) => {
      const s = S!;
      const r = nearestAlive(s, ctx.game.player.feet, 60) ?? s.robots[0];
      if (!r) return { pos: v(-60, 0.4, AISLE_Z), target: v(-40, 1.2, AISLE_Z), lens: 24 };
      return follow({ pos: r.pos, yaw: r.yaw }, v(0.7, 0.45, -1.8), v(0, 1.1, 8), 24, ctx.t, 0.01, 6);
    },
    // High wide over the hall.
    top: (ctx) => ({ pos: v(-36, 8.5, AISLE_Z + 6).add(handheld(ctx.t, 0.03, 7)), target: v(-62, 0.5, AISLE_Z), lens: 24 }),
  },
  post: () => NIGHT_POST,
};

// ------------------------------------------------------------------ SHOTGUN

/** Sprinters out of the dark into point-blank buckshot; pump between. Covers F08 F09 H22. */
export const SG: Shot = {
  map: 'site9',
  duration: 9,
  preroll: 3.5,
  handles: 0,
  setup(ctx) {
    const s = (S = stage(ctx, v(-42, 0.1, AISLE_Z), Math.PI / 2, 'pump_shotgun'));
    robot(s, v(-58, 0, AISLE_Z - 0.5), { hp: 120, speed: 3.6, mode: 'step' });
    robot(s, v(-68, 0, AISLE_Z + 1.5), { hp: 120, speed: 3.4, mode: 'step' });
  },
  update(ctx) {
    // Hold the second one until the first is down.
    const s = S!;
    pulse(ctx.t);
    if (ctx.t < 0) for (const r of s.robots) r.pos.x = Math.min(r.pos.x, r === s.robots[0] ? -58 : -68);
  },
  input(ctx, input) {
    const s = S!;
    const g = ctx.game;
    const t = ctx.t;
    if (t < 0) return;
    const tgt = nearestAlive(s, g.player.feet, 40);
    if (!tgt) return trigger(input, t, false);
    const err = aimAt(g, input, ctx.dt, chest(tgt), 8);
    const d = tgt.pos.distanceTo(g.player.feet);
    input.adsHeld = false;
    trigger(input, t, err < 3 && d < 4.2, 0.95);
  },
  cams: {
    pov: 'pov',
    side: (ctx) => {
      const g = ctx.game;
      return { pos: g.player.feet.clone().add(v(-2.4, 0.6, 3.2)).add(handheld(ctx.t, 0.008, 8)), target: g.player.feet.clone().add(v(-3, 1.2, 0)), lens: 28 };
    },
  },
  post: () => NIGHT_POST,
};

export { ease };
