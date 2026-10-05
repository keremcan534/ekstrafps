import * as THREE from 'three';
import type { CameraState, Shot } from '../Director';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../../../src/enemies/Soldier';
import { handheld } from '../stage';
import { AISLE_Z, NIGHT_POST, aimAt, ally, pulse, stage, trigger, type S9 } from './site9';
import { beam } from './sable';
import { thermalPass } from '../thermal';

/**
 * SABLE breach (real soldier rigs, real weapons and tracers): the alarm
 * spins up, a breaching charge blows the far end of the assembly aisle, four
 * operators with glowing quad NVGs push through the smoke, fan out and open fire
 * on the squad; the player answers. Covers the 1:00-1:10 arrival in the flow cut.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const BREACH = 1.2;
const ENTER = 1.45;
const FIRE = 3.2;
/**
 * &nobeams (trailer v3): no rifle beams on the breach team. In the haze their beams (and the
 * pooled lights they carry) flood every camera that looks back down the barrels; without
 * them the team reads as silhouettes and NVG tubes against the red. Render only.
 */
const BEAMS_OFF = new URLSearchParams(location.search).has('nobeams');

interface Br {
  s: S9;
  bd: Soldier[];
  goals: THREE.Vector3[];
  beacon: THREE.Group;
  flash: THREE.PointLight;
  target: PlayerTarget;
  blown: boolean;
}
let X: Br | null = null;

export const BD: Shot = {
  map: 'site9',
  duration: 10,
  preroll: 3.5,
  handles: 0,
  smooth: 0.35,
  setup(ctx) {
    const game = ctx.game;
    const s = stage(ctx, v(-40, 0.1, AISLE_Z), Math.PI / 2, 'ak47');
    ally(s, v(-39, 0, AISLE_Z + 2.6), 'm4a1');
    ally(s, v(-38.5, 0, AISLE_Z - 2.6), 'ak47');
    // Rotating alarm beacon over the aisle.
    const beacon = new THREE.Group();
    beacon.position.set(-62, 6.2, AISLE_Z);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a10).multiplyScalar(5) }));
    beacon.add(lamp);
    for (const sgn of [1, -1]) {
      const sp = new THREE.SpotLight(0xff2a10, 160, 30, 0.38, 0.5, 1.4);
      sp.target.position.set(sgn * 10, -5, 0);
      beacon.add(sp, sp.target);
    }
    game.scene.add(beacon);
    const flash = new THREE.PointLight(0xffb070, 0, 40, 1.3);
    flash.position.set(-72, 1.8, AISLE_Z);
    game.scene.add(flash);
    // The breach team: real SABLE soldiers, hidden until the charge blows.
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
    const ak = game.weapons.weapons.find((w) => w.data.id === 'ak47')!.data;
    const m4 = game.weapons.weapons.find((w) => w.data.id === 'm4a1')!.data;
    const starts = [v(-75, 0, AISLE_Z), v(-76.5, 0, AISLE_Z + 1.4), v(-76.5, 0, AISLE_Z - 1.4), v(-78, 0, AISLE_Z + 0.2)];
    const goals = [v(-61, 0, AISLE_Z + 0.6), v(-63.5, 0, AISLE_Z + 3.6), v(-64, 0, AISLE_Z - 3.4), v(-66.5, 0, AISLE_Z - 0.8)];
    const bd = starts.map((p, i) => {
      const sol = new Soldier(deps, 50 + i, hooks, 'bd', i === 0 ? 'bdboss' : 'bd');
      sol.setWeapon(i % 2 ? m4 : ak);
      sol.spawn(p, -Math.PI / 2);
      sol.body.root.visible = false;
      return sol;
    });
    const f = game.player.feet;
    const target: PlayerTarget = { feet: f.clone(), head: f.clone().setY(1.7), chest: f.clone().setY(1.35), velocity: v(0, 0, 0), sprinting: false, crouching: false, alive: true };
    X = { s, bd, goals, beacon, flash, target, blown: false };
  },
  update(ctx) {
    const x = X!;
    const t = ctx.t;
    pulse(t);
    x.beacon.rotation.y = t * 3.2;
    if (t >= BREACH && !x.blown) {
      x.blown = true;
      ctx.game.impacts.explosion(v(-72, 1.3, AISLE_Z));
    }
    x.flash.intensity = t >= BREACH ? 900 * Math.exp(-(t - BREACH) * 7) : 0;
    const squad = ctx.game.player.feet;
    x.target.feet.copy(squad);
    x.target.chest.set(squad.x, 1.35, squad.z);
    x.target.head.set(squad.x, 1.7, squad.z);
    x.bd.forEach((sol, i) => {
      if (t < ENTER + i * 0.25) return;
      if (!sol.body.root.visible) {
        sol.body.root.visible = true;
        sol.steerTo(x.goals[i], 2.2);
      }
      const aiming = t > FIRE - 0.6;
      const face = aiming ? x.target.chest.clone().add(v(0, 0, (i - 1.5) * 1.2)) : null;
      sol.update(ctx.dt, x.target, x.bd, face, aiming ? 'aim' : 'ready', t > FIRE + i * 0.3);
      if (BEAMS_OFF) beam(sol, 0);
    });
  },
  input(ctx, input) {
    const x = X!;
    const t = ctx.t;
    if (t < 0) return;
    // Hold on the far end, then answer the breach team.
    const alive = x.bd.filter((b) => b.alive && b.body.root.visible);
    const tgt = alive.sort((a, b) => a.pos.distanceTo(ctx.game.player.feet) - b.pos.distanceTo(ctx.game.player.feet))[0];
    const look = t < FIRE + 0.4 || !tgt ? v(-72, 1.4, AISLE_Z) : tgt.chestPos;
    const err = aimAt(ctx.game, input, ctx.dt, look, t < FIRE + 0.4 ? 2.5 : 5);
    input.adsHeld = t > 2.0;
    trigger(input, t, t > FIRE + 0.9 && err < 2 && t % 0.8 < 0.45, 0);
  },
  cams: {
    pov: 'pov',
    // Behind the squad, down the aisle: the charge, the smoke, the silhouettes.
    breach: (ctx): CameraState => ({ pos: v(-37.6, 1.75, AISLE_Z + 1.5).add(handheld(ctx.t, 0.012, 1)), target: v(-72, 1.5, AISLE_Z), lens: 35 }),
    // 85 mm on the lead's quad NVG as he comes through.
    nvg: (ctx): CameraState => {
      const L = X!.bd[0];
      const c = Math.cos(L.yaw);
      const s = Math.sin(L.yaw);
      const head = v(L.pos.x, 1.62, L.pos.z);
      return { pos: v(head.x + 0.55 * c + 1.9 * s, 1.68, head.z - 0.55 * s + 1.9 * c).add(handheld(ctx.t, 0.004, 2)), target: head, lens: 85 };
    },
    // Over the lead's shoulder at the squad ("I see the enemy").
    ots: (ctx): CameraState => {
      const L = X!.bd[0];
      const c = Math.cos(L.yaw);
      const s = Math.sin(L.yaw);
      return { pos: v(L.pos.x + 0.5 * c - 1.3 * s, 1.78, L.pos.z - 0.5 * c * 0 - 0.5 * s - 1.3 * c).add(handheld(ctx.t, 0.01, 3)), target: v(-40, 1.3, AISLE_Z), lens: 35 };
    },
    // v4: hero orbit round the lead as he comes through the smoke (low, 28 mm, slow arc).
    orbit: (ctx): CameraState => {
      const L = X!.bd[0];
      const a = 1.9 + Math.max(0, ctx.t - ENTER) * 0.42;
      const c = v(L.pos.x, 0, L.pos.z);
      return { pos: c.clone().add(v(Math.sin(a) * 2.7, 0.75, Math.cos(a) * 2.7)), target: c.add(v(0, 1.45, 0)), lens: 28 };
    },
    // v4: the squad's thermal sight down the aisle: white-hot shapes through the smoke.
    thermal: (ctx): CameraState => ({ pos: v(-38.6, 1.62, AISLE_Z + 0.9).add(handheld(ctx.t, 0.006, 6)), target: v(-68, 1.3, AISLE_Z), lens: 55 }),
    // v4: through the lead's eyes (graded to night vision in post): out of the smoke, onto the squad.
    eyes: (ctx): CameraState => {
      const L = X!.bd[0];
      const f = v(Math.sin(L.yaw), 0, Math.cos(L.yaw));
      const head = v(L.pos.x, 1.66, L.pos.z).addScaledVector(f, 0.28);
      const look = head.clone().addScaledVector(f, 6).setY(1.4).lerp(X!.target.chest, 0.55);
      return { pos: head.add(handheld(ctx.t, 0.012, 5)), target: look, lens: 30 };
    },
    // Low on the floor ahead of them: boots and silhouettes against the red smoke as they fan out.
    low: (ctx): CameraState => ({ pos: v(-57.5, 0.28, AISLE_Z + 0.7).add(handheld(ctx.t, 0.006, 4)), target: v(-67, 1.3, AISLE_Z), lens: 24 }),
  },
  beforeRender(ctx, cam) {
    if (cam === 'thermal') thermalPass(ctx.game.scene, [...X!.bd.map((b) => b.body.root), ...X!.s.allies.map((a) => a.soldier.body.root)]);
    // v3: your flashlight at its trailer level in the third-person cameras.
    if (!BEAMS_OFF || cam === 'pov') return;
    const fl = (ctx.game.lighting as unknown as { flashlight?: THREE.SpotLight } | null)?.flashlight;
    if (fl && fl.intensity > 0) fl.intensity = 7;
  },
  post: (_ctx, cam) => ({ ...NIGHT_POST, exposure: cam === 'pov' ? 0.85 : 1.05, ...(cam === 'nvg' ? { dof: { focus: 2.0, aperture: 0.02, maxblur: 0.012 } } : {}) }),
};
