import * as THREE from 'three';
import type { CameraState, Shot } from '../Director';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../../../src/enemies/Soldier';
import { handheld } from '../stage';
import { AISLE_Z, NIGHT_POST, pulse, stage } from './site9';

/**
 * SABLE (Black Division) takes with the current operator models: weapon lights in
 * the dark, the Warden up close, and the trailer's last scene (you are down, the
 * Warden stands over you and fires).
 */

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };

function operator(deps: SoldierDeps, i: number, warden: boolean, weapon: THREE.Object3D | null, data: unknown, at: THREE.Vector3, yaw: number): Soldier {
  const s = new Soldier(deps, 80 + i, hooks, 'bd', warden ? 'bdboss' : 'bd');
  if (data) s.setWeapon(data as Parameters<Soldier['setWeapon']>[0]);
  s.spawn(at, yaw);
  void weapon;
  return s;
}

function target(at: THREE.Vector3): PlayerTarget {
  return { feet: at.clone().setY(0), head: at.clone().setY(1.7), chest: at.clone().setY(1.35), velocity: v(), sprinting: false, crouching: false, alive: true };
}

// ------------------------------------------------------------------ SB: the squad stalks down the dark aisle

let SBX: { squad: Soldier[]; goals: THREE.Vector3[]; t: PlayerTarget } | null = null;

export const SB: Shot = {
  map: 'site9',
  duration: 10,
  preroll: 3.5,
  handles: 0,
  smooth: 0.5,
  setup(ctx) {
    const game = ctx.game;
    stage(ctx, v(-30, 0.1, AISLE_Z + 9), Math.PI / 2, 'm4a1');
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const wd = (id: string) => game.weapons.weapons.find((w) => w.data.id === id)?.data;
    const z = AISLE_Z;
    // Wedge: the Warden leads, two flank, one trails.
    const starts = [v(-80, 0, z), v(-82.2, 0, z + 2.2), v(-82.2, 0, z - 2.2), v(-84.5, 0, z + 0.6)];
    const goals = [v(-58, 0, z), v(-60.2, 0, z + 2.4), v(-60.2, 0, z - 2.4), v(-62.6, 0, z + 0.6)];
    const squad = starts.map((p, i) => operator(deps, i, i === 0, null, wd(i === 0 ? 'asval' : i === 3 ? 'pump_shotgun' : 'm4a1'), p, -Math.PI / 2));
    squad.forEach((s, i) => s.steerTo(goals[i], 1.35));
    SBX = { squad, goals, t: target(v(-30, 0, z)) };
  },
  update(ctx) {
    const x = SBX!;
    pulse(ctx.t);
    const t = ctx.t;
    x.squad.forEach((s, i) => {
      // Scanning ahead: each covers a sector, the lights sweep the aisle.
      const sweep = Math.sin(t * 0.6 + i * 1.7) * (i === 0 ? 1.2 : 3.2);
      const look = s.pos.clone().add(v(14, 1.3 + Math.sin(t * 0.4 + i) * 0.25, sweep + (i === 1 ? 4 : i === 2 ? -4 : 0)));
      s.update(ctx.dt, x.t, x.squad, look, 'aim', false);
    });
  },
  cams: {
    // Low in the aisle ahead: the beams come at the lens through the haze.
    front: (ctx): CameraState => ({ pos: v(-50, 0.55, AISLE_Z + 0.8).add(handheld(ctx.t, 0.006, 1)), target: v(-66, 1.5, AISLE_Z), lens: 35 }),
    // 85 mm on the Warden as he walks.
    warden: (ctx): CameraState => {
      const w = SBX!.squad[0];
      return { pos: w.pos.clone().add(v(3.2, 1.62, 1.4)).add(handheld(ctx.t, 0.004, 2)), target: w.pos.clone().setY(1.55), lens: 85 };
    },
    // Side dolly at their pace.
    side: (ctx): CameraState => {
      const w = SBX!.squad[0];
      return { pos: v(w.pos.x + 1.5, 1.4, AISLE_Z + 6.5).add(handheld(ctx.t, 0.01, 3)), target: v(w.pos.x - 1, 1.3, AISLE_Z), lens: 28 };
    },
    // Over the Warden's shoulder down the aisle (what they see).
    ots: (ctx): CameraState => {
      const w = SBX!.squad[0];
      return { pos: w.pos.clone().add(v(-1.3, 1.85, 0.55)).add(handheld(ctx.t, 0.008, 4)), target: w.pos.clone().add(v(10, 1.2, 0)), lens: 35 };
    },
  },
  post: () => ({ ...NIGHT_POST, exposure: 1.0, bloom: { strength: 0.9, radius: 0.6, threshold: 0.8 } }),
};

// ------------------------------------------------------------------ WD: the last scene

/** Seconds into the take when the Warden fires (the edit cuts to black on this flash). */
export const WD_FIRE = 7.2;
const CAM = v(-50, 0.42, AISLE_Z + 0.4);
let WDX: { warden: Soldier; escort: Soldier[]; t: PlayerTarget } | null = null;

export const WD: Shot = {
  map: 'site9',
  duration: 9,
  preroll: 3.5,
  handles: 0,
  smooth: 0.6,
  setup(ctx) {
    const game = ctx.game;
    stage(ctx, v(-30, 0.1, AISLE_Z + 9), Math.PI / 2, 'm4a1');
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const wd = (id: string) => game.weapons.weapons.find((w) => w.data.id === id)?.data;
    const z = AISLE_Z;
    const warden = operator(deps, 0, true, null, wd('heavy_pistol'), v(-60, 0, z + 0.3), -Math.PI / 2);
    warden.steerTo(v(-52.6, 0, z + 0.35), 1.25);
    const escort = [operator(deps, 1, false, null, wd('m4a1'), v(-63.5, 0, z + 2.0), -Math.PI / 2), operator(deps, 2, false, null, wd('m4a1'), v(-63.8, 0, z - 1.6), -Math.PI / 2)];
    escort[0].steerTo(v(-54.6, 0, z + 2.1), 1.2);
    escort[1].steerTo(v(-54.9, 0, z - 1.5), 1.2);
    WDX = { warden, escort, t: target(CAM) };
  },
  update(ctx) {
    const x = WDX!;
    pulse(ctx.t);
    const t = ctx.t;
    const down = CAM.clone();
    // The Warden: walks up, looks down at you, raises the pistol, one shot.
    const aiming = t > WD_FIRE - 0.9;
    x.warden.update(ctx.dt, x.t, [x.warden, ...x.escort], x.warden.pathDone ? down : null, aiming ? 'aim' : 'low', t > WD_FIRE && t < WD_FIRE + 0.25);
    // Escort keep their lights on the floor at your feet (lighting the scene, not the lens).
    const floor = v(CAM.x - 1.3, 0, CAM.z);
    for (const e of x.escort) e.update(ctx.dt, x.t, [x.warden, ...x.escort], floor, 'aim', false);
  },
  cams: {
    // Your eyes, on the floor: tilted, breathing, looking up as he arrives.
    down: (ctx): CameraState => {
      const w = WDX!.warden;
      const t = ctx.t;
      const look = w.pos.clone().setY(THREE.MathUtils.lerp(1.1, 1.7, Math.min(1, Math.max(0, (t - 1.5) / 2.5))));
      const breathe = v(Math.sin(t * 1.1) * 0.02, Math.sin(t * 2.2) * 0.015, Math.sin(t * 0.7) * 0.02);
      return { pos: CAM.clone().add(breathe), target: look, lens: 30, roll: 0.32 + Math.sin(t * 0.5) * 0.03 };
    },
  },
  post: () => ({ ...NIGHT_POST, exposure: 0.95, saturation: 0.55, contrast: 1.28, vignette: 0.62, bloom: { strength: 1.0, radius: 0.7, threshold: 0.75 } }),
};
