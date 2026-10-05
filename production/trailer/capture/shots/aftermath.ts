import * as THREE from 'three';
import type { CameraState, Shot } from '../Director';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../../../src/enemies/Soldier';
import { handheld } from '../stage';
import { Aftermath, aisleDead, brass } from '../blood';
import { AISLE_Z, NIGHT_POST, pulse, stage } from './site9';
import { beam } from './sable';

/**
 * CR: the assembly aisle after the breach. Your squad is down in their blood among the
 * spent brass; red emergency light, haze. One SABLE operator walks the aisle checking the
 * bodies, stops over one, looks down, moves on. The same dead lie round you in WD.
 *
 *   dolly  lens on the floor gliding over the bodies and the blood (the transition shot)
 *   hand   50 mm on a dead operator's hand and rifle in the pool
 *   boots  low on the floor: SABLE boots walk in and stop beside a body
 *   face   from below: his NVG and respirator as he looks down
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const Z = AISLE_Z;
const CHECK = 4.6; // he stops over the second body

interface Cr {
  fill: THREE.PointLight;
  dead: Aftermath;
  walker: Soldier;
  target: PlayerTarget;
}
let C: Cr | null = null;

export const CR: Shot = {
  map: 'site9',
  duration: 10,
  preroll: 3.5,
  handles: 0,
  smooth: 0.5,
  setup(ctx) {
    const game = ctx.game;
    // The player is far behind the set (no gameplay view in this take).
    stage(ctx, v(-36, 0.1, Z + 4), Math.PI / 2, 'm4a1');
    const dead = aisleDead(game, Z, 2.8);
    for (const [x, dz, n] of [[-50.4, -0.6, 26], [-53.2, 0.9, 18], [-56.8, -0.2, 14]] as const) brass(game.scene, v(x, 0, Z + dz), n, 1.1, x * 7);
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
    const walker = new Soldier(deps, 90, hooks, 'bd', 'bd');
    const ak = game.weapons.weapons.find((w) => w.data.id === 'ak47')!.data;
    walker.setWeapon(ak);
    walker.spawn(v(-60.2, 0, Z + 0.4), Math.PI / 2);
    const target: PlayerTarget = { feet: v(0, -50, 0), head: v(0, -48, 0), chest: v(0, -49, 0), velocity: v(0, 0, 0), sprinting: false, crouching: false, alive: false };
    game.scene.fog = new THREE.FogExp2(0x07080b, 0.03);
    const fill = new THREE.PointLight(0xa8bcd8, 0, 6, 1.5);
    game.scene.add(fill);
    C = { fill, dead, walker, target };
  },
  update(ctx) {
    const c = C!;
    const t = ctx.t;
    pulse(t);
    c.dead.update(ctx.dt, t);
    // Walk up the aisle, stop over the second body, look down at him, move on.
    const w = c.walker;
    const stopAt = v(-53.9, 0, Z + 1.35); // beside the second body
    const goal = t < CHECK + 2.2 ? stopAt : v(-46.5, 0, Z - 0.4);
    w.steerTo(t < 0 ? w.pos : goal, 1.45);
    const body = c.dead.bodies[1].soldier.body.part('torso').group.getWorldPosition(new THREE.Vector3());
    const looking = t > CHECK - 0.4 && t < CHECK + 2.2;
    w.update(ctx.dt, c.target, [w], looking ? body : null, looking ? 'ready' : 'low', false);
    beam(w, 0.25);
    ((window as unknown as { __probeInfo?: Record<string, unknown> }).__probeInfo ??= {}).walker = [+w.pos.x.toFixed(2), +w.pos.z.toFixed(2), w.alive];
  },
  input(_ctx, input) {
    input.pressFire(false);
  },
  cams: {
    // Low over the floor, gliding up the aisle across the dead and their blood toward him
    // (24 mm, 45 cm up, tilted down onto the floor just ahead).
    dolly: (ctx): CameraState => {
      const t = Math.max(0, ctx.t);
      // Past the first body, swinging to the second by the conveyor, back across to the third.
      const x = -47.0 - t * 1.05;
      const xs = [-47, -50.2, -54.2, -57.1, -60];
      const zs = [-13.6, -14.0, -11.7, -12.3, -12.6];
      let i = 0;
      while (i < xs.length - 2 && x < xs[i + 1]) i++;
      const k = Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));
      const z = zs[i] + (zs[i + 1] - zs[i]) * (k * k * (3 - 2 * k));
      return { pos: v(x, 0.5, z).add(handheld(t, 0.003, 21)), target: v(x - 3, 0.05, z + 0.1), lens: 24 };
    },
    // 50 mm on the first body's hand and rifle in the blood, slow push.
    hand: (ctx): CameraState => {
      const h = C!.dead.bodies[0].soldier.body.part('torso').group.getWorldPosition(new THREE.Vector3());
      const k = Math.min(1, Math.max(0, ctx.t) / 8);
      return { pos: v(h.x + 1.0 - 0.25 * k, 0.32, h.z + 0.75 - 0.15 * k).add(handheld(ctx.t, 0.002, 22)), target: v(h.x - 0.1, 0.06, h.z), lens: 50 };
    },
    // Low by the second body: his boots walk into frame and stop beside it.
    boots: (ctx): CameraState => ({ pos: v(-51.9, 0.18, Z - 0.2).add(handheld(ctx.t, 0.002, 23)), target: v(-54.2, 0.3, Z + 1.9), lens: 28 }),
    // From below: the NVG tubes and the dark respirator as he looks down.
    face: (ctx): CameraState => {
      const w = C!.walker;
      const head = v(w.pos.x, 1.6, w.pos.z);
      return { pos: v(w.pos.x + 1.6, 0.6, w.pos.z - 1.4).add(handheld(ctx.t, 0.003, 24)), target: head, lens: 50 };
    },
  },
  beforeRender(_ctx, cam) {
    // A low cold kicker on his front for the up-shot (otherwise a black shape on a black ceiling).
    const w = C!.walker;
    C!.fill.position.set(w.pos.x + 1.4, 0.9, w.pos.z - 1.2);
    C!.fill.intensity = cam === 'face' ? 40 : 0;
  },
  post: (_ctx, cam) => ({
    ...NIGHT_POST,
    exposure: 0.95,
    ...(cam === 'hand' ? { dof: { focus: 1.05, aperture: 0.03, maxblur: 0.014 } } : cam === 'face' ? { dof: { focus: 2.3, aperture: 0.015, maxblur: 0.01 } } : {}),
  }),
};
