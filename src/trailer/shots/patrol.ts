import * as THREE from 'three';
import type { CameraState, Shot, ShotCtx } from '../Director';
import type { Game } from '../../core/Game';
import type { RogueRobot } from '../../enemies/RogueRobot';
import type { TeamAgent } from '../../game/TeamAgent';
import { feel } from '../../config/Feel';
import { handheld } from '../stage';
import { NIGHT_POST, aimAt, chest, survival, trigger } from './site9';

/**
 * Moving squad encounters in different Site-9 rooms (real gameplay). The route
 * comes from the game's own nav grid between two points of a room (no walking
 * into walls); the player walks / sprints along it, engages whatever wakes up,
 * backs off when a robot gets close, reloads when low. Squadmates follow with
 * their real AI. Cameras keep line of sight to their subject (never inside geometry).
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface RobotSpec {
  /** Fraction along the route, lateral offset (m, + = right of travel). */
  at: [number, number];
  mode?: 'idle' | 'step' | 'rise';
  /** Spawn time (s); default: placed at setup. */
  time?: number;
  hp?: number;
  speed?: number;
}

export interface PatrolOpts {
  room: string;
  /** Route endpoints as fractions of the room rectangle (0..1 in x and z). */
  from: [number, number];
  to: [number, number];
  weapon: string;
  allies: string[];
  robots: RobotSpec[];
  dark: boolean;
  duration: number;
  /** Seconds window(s) where the player sprints (no target). */
  sprint?: [number, number][];
  /** Semi-auto weapons: seconds between trigger presses. */
  tap?: number;
  /** Engage distance (m). */
  engage?: number;
  /** Stop walking while engaging (otherwise keep pushing slowly). */
  holdToFire?: boolean;
  ads?: boolean;
  lean?: [number, number, number][];
  exposure?: number;
}

interface Run {
  game: Game;
  route: THREE.Vector3[];
  cum: number[];
  length: number;
  wp: number;
  robots: RogueRobot[];
  pending: RobotSpec[];
  allies: TeamAgent[];
  pulses: { light: THREE.PointLight; phase: number; base: number }[];
  /** Cinematographer's fill over the squad (third-person cameras only). */
  fill: THREE.PointLight;
  reloadAt: number;
  /** Robots placed dormant at setup and powered up on cue (no pop-in). */
  wakes: { robot: RogueRobot; time: number }[];
  target: RogueRobot | null;
  switchAt: number;
  move: THREE.Vector3;
  ads: boolean;
}

function routeAt(r: Run, frac: number, lateral = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const d = Math.max(0, Math.min(1, frac)) * r.length;
  let i = 1;
  while (i < r.route.length - 1 && r.cum[i] < d) i++;
  const a = r.route[i - 1];
  const b = r.route[i];
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const k = (d - r.cum[i - 1]) / seg;
  out.lerpVectors(a, b, Math.max(0, Math.min(1, k)));
  const dir = b.clone().sub(a).setY(0).normalize();
  // right of travel = (-dz, dx) rotated: for dir (dx, dz) the right vector is (-dz, dx) * -1
  out.x += -dir.z * -lateral;
  out.z += dir.x * -lateral;
  return out;
}

/** Fraction of the route closest to a point. */
function fracOf(r: Run, p: THREE.Vector3): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i <= 60; i++) {
    const q = routeAt(r, i / 60);
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < bd) {
      bd = d;
      best = i / 60;
    }
  }
  return best;
}

/** Pull a desired camera position toward the subject until nothing blocks the view. */
function safeCam(game: Game, subject: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const out = desired.clone();
  for (let i = 0; i < 10; i++) {
    if (game.physics.lineOfSight(subject, out)) return out;
    out.lerp(subject, 0.22);
  }
  return out;
}

export function patrol(o: PatrolOpts): Shot {
  let R: Run | null = null;

  const nearestAwake = (from: THREE.Vector3, max: number): RogueRobot | null => {
    let best: RogueRobot | null = null;
    let bd = max;
    for (const r of R!.robots) {
      if (!r.alive || r.dormant) continue;
      const d = r.pos.distanceTo(from);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  };

  const spawn = (spec: RobotSpec) => {
    const r = R!;
    const p = routeAt(r, spec.at[0], spec.at[1]);
    const w = r.game.nav.nearestWalkable(p.x, p.z, new THREE.Vector3(), 4) ?? p;
    const robot = survival(r.game).robots.find((x) => !x.active);
    if (!robot) return;
    const f = r.game.player.feet;
    // Always placed powered-down at setup; timed ones are woken on cue instead of appearing.
    robot.spawn(w, spec.hp ?? 140, spec.speed ?? 1.8, 0, 'idle', Math.atan2(f.x - w.x, f.z - w.z));
    robot.wanders = false;
    r.robots.push(robot);
    if (spec.time !== undefined) r.wakes.push({ robot, time: spec.time });
  };

  return {
    map: 'site9',
    duration: o.duration,
    preroll: 3.5,
    handles: 0,
    setup(ctx: ShotCtx) {
      const game = ctx.game;
      const sv = survival(game);
      sv.over = true;
      for (const d of sv.doors) if (!d.open) sv.openDoor(d, false);
      feel.godMode = true;
      if (o.dark) game.lighting?.setRaid(true);
      const room = (game.arena as unknown as { rooms: { id: string; rect: [number, number, number, number] }[] }).rooms.find((x) => x.id === o.room)!;
      const [x0, z0, x1, z1] = room.rect;
      const P = (f: [number, number]) => {
        const x = x0 + (x1 - x0) * f[0];
        const z = z0 + (z1 - z0) * f[1];
        return game.nav.nearestWalkable(x, z, new THREE.Vector3(), 8) ?? v(x, 0, z);
      };
      const a = P(o.from);
      const b = P(o.to);
      const route = game.nav.findPath(a, b) ?? [a, b];
      if (route[0].distanceTo(a) > 0.1) route.unshift(a);
      const cum = [0];
      for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + route[i].distanceTo(route[i - 1]));
      const fill = new THREE.PointLight(0xa8bcd8, 0, 16, 1.4);
      game.scene.add(fill);
      R = { game, route, cum, length: cum[cum.length - 1] || 1, wp: 1, robots: [], pending: [], allies: [], pulses: [], reloadAt: -9, fill, wakes: [], target: null, switchAt: -9, move: new THREE.Vector3(), ads: false };
      const dir = (route[1] ?? b).clone().sub(a);
      game.player.teleport(a.clone().setY(0.1), Math.atan2(-dir.x, -dir.z));
      game.weapons.giveWeapon(o.weapon);
      for (const w of game.weapons.weapons) w.refill();
      game.scene.traverse((obj) => {
        const m = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if ((obj as THREE.Mesh).isMesh && m && (m as THREE.Material).type === 'MeshBasicMaterial' && m.map instanceof THREE.CanvasTexture) obj.visible = false;
      });
      // Squadmates a step behind, either side of the route.
      o.allies.forEach((wpn, i) => {
        const p = routeAt(R!, 0, i % 2 ? -1.6 : 1.6).add(dir.clone().normalize().multiplyScalar(-1.5 - i));
        const w = game.nav.nearestWalkable(p.x, p.z, new THREE.Vector3(), 4) ?? p;
        const ally = (game as unknown as { addAlly(at: THREE.Vector3, hired: boolean): TeamAgent }).addAlly(w, true);
        ally.arm(wpn);
        ally.soldier.skill = 1.6;
        R!.allies.push(ally);
      });
      for (const spec of o.robots) spawn(spec);
      if (o.dark) {
        // Practicals along the route: pulsing red emergency lamps, one cold pool mid-route.
        for (const [f, lat, ph] of [[0.25, 4, 0], [0.5, -4, 1.7], [0.75, 4, 3.1], [0.95, -3, 4.4]] as const) {
          const p = routeAt(R, f, lat);
          const l = new THREE.PointLight(0xff2a14, 28, 15, 1.6);
          l.position.set(p.x, 4, p.z);
          game.scene.add(l);
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3018).multiplyScalar(4) }));
          lamp.position.copy(l.position);
          game.scene.add(lamp);
          R.pulses.push({ light: l, phase: ph, base: 28 });
        }
        const mid = routeAt(R, 0.55);
        const pool = new THREE.SpotLight(0xcfdcf0, 110, 20, 0.45, 0.65, 1.3);
        pool.position.set(mid.x, 9, mid.z);
        pool.target.position.copy(mid);
        game.scene.add(pool, pool.target);
        game.scene.fog = new THREE.FogExp2(0x07080b, 0.02);
      }
    },
    update(ctx) {
      const r = R!;
      for (const p of r.pulses) p.light.intensity = p.base * (0.35 + 0.65 * Math.max(0, Math.sin(ctx.t * 2.2 + p.phase)) ** 2);
      for (const w of r.wakes) if (ctx.t >= w.time && w.robot.dormant) w.robot.wake();
    },
    input(ctx, input) {
      const r = R!;
      const g = ctx.game;
      const t = ctx.t;
      if (t < 0) return;
      const feet = g.player.feet;
      // Next waypoint.
      while (r.wp < r.route.length - 1 && r.route[r.wp].distanceTo(feet) < 1.2) r.wp++;
      const wpPos = r.route[r.wp];
      // Sticky target: keep it until it is down, then ease onto the next one.
      if (!r.target || !r.target.alive || r.target.pos.distanceTo(feet) > (o.engage ?? 26) + 6) {
        const next = nearestAwake(feet, o.engage ?? 26);
        if (next !== r.target) r.switchAt = t;
        r.target = next;
      }
      const tgt = r.target;
      const sprinting = !tgt && (o.sprint ?? []).some(([a, b]) => t >= a && t < b);
      let move = new THREE.Vector3();
      let speed = sprinting ? 1 : 0.5;
      const atEnd = r.wp >= r.route.length - 1 && wpPos.distanceTo(feet) < 1.2;
      if (!atEnd) move = wpPos.clone().sub(feet).setY(0).normalize();
      if (tgt) {
        const d = tgt.pos.distanceTo(feet);
        const settle = Math.min(1, (t - r.switchAt) / 0.6);
        const err = aimAt(g, input, ctx.dt, chest(tgt), 2.5 + 3.5 * settle);
        if (d > 7.5) r.ads = true;
        else if (d < 5) r.ads = false;
        input.adsHeld = (o.ads ?? true) && r.ads;
        const w = g.weapons.current;
        const reloading = w.state === 'reloading';
        if (w.ammo <= 2 && !reloading && t - r.reloadAt > 1) {
          input.reloadPressed = true;
          r.reloadAt = t;
        }
        const burst = (o.tap ?? 0) > 0 || t % 0.8 < 0.5;
        trigger(input, t, err < 2.0 && settle >= 1 && burst && !reloading, o.tap ?? 0);
        if (d < 4.5) {
          // Too close: back off while shooting.
          move = feet.clone().sub(tgt.pos).setY(0).normalize();
          speed = 0.7;
        } else if (o.holdToFire) speed = 0;
        else speed = 0.3;
      } else {
        trigger(input, t, false);
        input.adsHeld = false;
        // Look where you're going, with a slow scan.
        const ahead = routeAt(r, fracOf(r, feet) + 8 / r.length);
        ahead.y = 1.45;
        const side = new THREE.Vector3(-move.z, 0, move.x).multiplyScalar(Math.sin(t * 0.45) * 1.6);
        aimAt(g, input, ctx.dt, ahead.add(side), 2.2);
      }
      input.sprintHeld = sprinting;
      // World move direction → controller axes (relative to the view).
      const yaw = g.player.yaw;
      const fwd = v(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = v(Math.cos(yaw), 0, -Math.sin(yaw));
      // Ease between walking, stopping and backing off (no snapping on the sticks).
      r.move.lerp(move.multiplyScalar(speed), 1 - Math.exp(-Math.max(ctx.dt, 1 / 120) / 0.3));
      input.moveY = r.move.dot(fwd);
      input.moveX = r.move.dot(right);
      input.leanAxis = 0;
    },
    cams: {
      pov: 'pov',
      // Over the shoulder of the first squadmate.
      mate: (ctx): CameraState => {
        const r = R!;
        const a = r.allies[0]?.soldier;
        if (!a) return { pos: v(0, 2, 0), target: v(0, 1, 5), lens: 35 };
        const c = Math.cos(a.yaw);
        const s = Math.sin(a.yaw);
        const head = v(a.pos.x, 1.45, a.pos.z);
        const want = v(a.pos.x + 0.75 * c - 1.7 * s, 1.6, a.pos.z - 0.75 * s - 1.7 * c);
        const look = v(a.pos.x + 4 * s, 1.3, a.pos.z + 4 * c);
        return { pos: safeCam(ctx.game, head, want).add(handheld(ctx.t, 0.012, 1)), target: look, lens: 35 };
      },
      // Low, ahead of the squad on the route, looking back at them as they come.
      front: (ctx): CameraState => {
        const r = R!;
        const f = fracOf(r, ctx.game.player.feet);
        const squad = ctx.game.player.feet.clone().setY(1.2);
        const want = routeAt(r, f + 7 / r.length, 0.8).setY(0.55);
        return { pos: safeCam(ctx.game, squad, want).add(handheld(ctx.t, 0.015, 2)), target: squad.clone().add(v(0, 0.1, 0)), lens: 28 };
      },
      // Side dolly alongside the route.
      side: (ctx): CameraState => {
        const r = R!;
        const f = fracOf(r, ctx.game.player.feet);
        const squad = routeAt(r, f - 1.5 / r.length).setY(1.3);
        const want = routeAt(r, f + 1 / r.length, 4.5).setY(1.5);
        return { pos: safeCam(ctx.game, squad, want).add(handheld(ctx.t, 0.01, 3)), target: squad, lens: 35 };
      },
      // Behind the nearest awake robot, looking at the squad.
      robo: (ctx): CameraState => {
        const r = R!;
        const g = ctx.game;
        const bot = nearestAwake(g.player.feet, 60) ?? r.robots.find((x) => x.alive) ?? null;
        const squad = g.player.feet.clone().setY(1.2);
        if (!bot) return { pos: routeAt(r, 0.9).setY(1), target: squad, lens: 28 };
        const back = bot.pos.clone().sub(g.player.feet).setY(0).normalize();
        const want = bot.pos.clone().addScaledVector(back, 1.6).add(v(0.6, 0.5, 0));
        return { pos: safeCam(g, v(bot.pos.x, 1.2, bot.pos.z), want).add(handheld(ctx.t, 0.01, 4)), target: squad, lens: 24 };
      },
    },
    beforeRender(ctx, cam) {
      // The game's flashlight is tuned for play; at trailer exposure it blows out close walls.
      const fl = (ctx.game.lighting as unknown as { flashlight?: THREE.SpotLight } | null)?.flashlight;
      if (fl && fl.intensity > 0) fl.intensity = 7;
      const f = ctx.game.player.feet;
      R!.fill.position.set(f.x, 4.2, f.z);
      R!.fill.intensity = o.dark && cam !== 'pov' ? 22 : 0;
    },
    post: (_ctx, cam) =>
      o.dark
        ? { ...NIGHT_POST, exposure: o.exposure ?? (cam === 'pov' ? 0.85 : 1.15), ...(cam === 'pov' ? { bloom: { strength: 0.45, radius: 0.45, threshold: 1.6 } } : {}) }
        : { ...NIGHT_POST, exposure: o.exposure ?? 0.6, contrast: 1.15, saturation: 0.72, bloom: { strength: 0.35, radius: 0.5, threshold: 1.1 } },
  };
}

// ------------------------------------------------------------------ the locations

/** Server hall, lights out: down the rack rows; dormant robots between the racks. */
export const SV = patrol({
  room: 'servers', from: [0.12, 0.85], to: [0.8, 0.2], weapon: 'm4a1', allies: ['ak47', 'm4a1'], dark: true, duration: 14,
  robots: [{ at: [0.42, 2] }, { at: [0.5, -2.5] }, { at: [0.58, 1] }, { at: [0.9, 0], mode: 'step', time: 7, speed: 2.6 }, { at: [0.95, 2], mode: 'step', time: 7.4, speed: 2.4 }],
});

/** Power plant (reactor column), lights out: push across, sprinters cut in. */
export const PW = patrol({
  room: 'power', from: [0.08, 0.5], to: [0.85, 0.45], weapon: 'ak47', allies: ['mosin', 'm4a1'], dark: true, duration: 13,
  sprint: [[0.3, 2.6]],
  robots: [{ at: [0.6, 3], mode: 'step', time: 2.8, speed: 3.2 }, { at: [0.7, -3], mode: 'step', time: 3.2, speed: 3.4 }, { at: [0.8, 0], mode: 'step', time: 4.5, speed: 3.0 }, { at: [0.9, 2], mode: 'step', time: 7, speed: 3.4 }],
});

/** Hangar, lights on: sprint across the floor, robots climb out of the hatches. */
export const HG = patrol({
  room: 'hangar', from: [0.86, 0.9], to: [0.84, 0.18], weapon: 'm4a1', allies: ['ak47', 'mosin', 'm4a1'], dark: false, duration: 14,
  sprint: [[0.2, 3.2]],
  robots: [{ at: [0.55, 4], mode: 'rise', time: 3.4 }, { at: [0.6, -3], mode: 'rise', time: 3.8 }, { at: [0.7, 1], mode: 'rise', time: 4.4 }, { at: [0.85, -2], mode: 'step', time: 7, speed: 2.8 }, { at: [0.9, 3], mode: 'step', time: 7.5, speed: 2.8 }],
});

/** Warehouse between the crate racks, lights out: close quarters with the shotgun. */
export const WH = patrol({
  room: 'warehouse', from: [0.1, 0.5], to: [0.75, 0.5], weapon: 'pump_shotgun', allies: ['m4a1'], dark: true, duration: 12, tap: 0.95, engage: 9, ads: false,
  robots: [{ at: [0.35, 1.5] }, { at: [0.5, -1.5], speed: 3 }, { at: [0.65, 1] , speed: 3.2}, { at: [0.85, 0], mode: 'step', time: 6, speed: 3.4 }],
});

/** Atrium (glass roof, ATLAS statue), lights on: long-range Mosin work, then the rush. */
export const AT = patrol({
  room: 'atrium', from: [0.5, 0.92], to: [0.5, 0.45], weapon: 'mosin', allies: ['ak47', 'm4a1'], dark: false, duration: 13, tap: 1.3, engage: 40, holdToFire: true,
  robots: [{ at: [1.0, 3], mode: 'step', time: 1.0, speed: 1.6 }, { at: [1.0, -4], mode: 'step', time: 1.5, speed: 1.8 }, { at: [0.95, 0], mode: 'step', time: 4, speed: 2.6 }, { at: [1.0, 6], mode: 'step', time: 6, speed: 3 }],
});

/** R&D labs, lights out: corridor sweep with the heavy pistol. */
export const LB = patrol({
  room: 'labs', from: [0.9, 0.5], to: [0.2, 0.5], weapon: 'heavy_pistol', allies: ['ak47'], dark: true, duration: 11, tap: 0.3, engage: 16,
  robots: [{ at: [0.45, 1] }, { at: [0.55, -1.5] }, { at: [0.8, 0], mode: 'step', time: 5, speed: 2.6 }],
});
