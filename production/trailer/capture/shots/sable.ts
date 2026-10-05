import * as THREE from 'three';
import type { CameraState, Shot, ShotCtx } from '../Director';
import type { Game } from '../../../../src/core/Game';
import type { WeaponData } from '../../../../src/weapons/WeaponData';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../../../src/enemies/Soldier';
import { feel } from '../../../../src/config/Feel';
import { handheld } from '../stage';
import { AISLE_Z, NIGHT_POST, aimAt, pulse, stage, survival, trigger } from './site9';
import { aisleDead, brass, type Aftermath } from '../blood';

/**
 * SABLE (Black Division) takes on real soldier rigs:
 *   SB  Server hall, lights out: the Warden walks his squad down a rack aisle in a
 *       column, quad NVGs glowing; on contact they fan out, crouch, lean out and open
 *       fire on the squad holding the far end. The player answers.
 *   WD  The ending: you are on the floor of the assembly aisle. The Warden walks up,
 *       stands over you, draws down and fires once.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function weapon(game: Game, id: string): WeaponData {
  const list = game.weapons.weapons;
  return (list.find((w) => w.data.id === id) ?? list.find((w) => w.data.id === 'ak47') ?? list[0]).data;
}

function squadTarget(at: THREE.Vector3): PlayerTarget {
  return { feet: at.clone(), head: at.clone().setY(1.7), chest: at.clone().setY(1.35), velocity: v(0, 0, 0), sprinting: false, crouching: false, alive: true };
}

function soldier(game: Game, i: number, boss: boolean, wpn: string, at: THREE.Vector3, yaw: number): Soldier {
  const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
  const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud: (p: THREE.Vector3, st: number) => game.audio.play('robot.fall', { position: p, volume: 0.25 + 0.5 * st }) };
  const s = new Soldier(deps, 60 + i, hooks, 'bd', boss ? 'bdboss' : 'bd');
  s.setWeapon(weapon(game, wpn));
  s.spawn(at, yaw);
  if (boss) s.skill = 1.3;
  return s;
}

/** Pull a desired camera position toward the subject until nothing blocks the view. */
function safe(game: Game, subject: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const out = desired.clone();
  for (let i = 0; i < 10; i++) {
    if (game.physics.lineOfSight(subject, out)) return out;
    out.lerp(subject, 0.22);
  }
  return out;
}

/** Rifle beams: dimmer than in play (in haze, pointed down the lens, they flood the frame); off = hidden. */
export function beam(s: Soldier, k: number): void {
  const b = (s as unknown as { beam?: (THREE.Object3D & { setStrength(v: number): void }) | null }).beam;
  if (!b) return;
  if (k <= 0) {
    b.visible = false;
    (s as unknown as { beamOn: boolean }).beamOn = false;
  } else if (b.visible) b.setStrength(0.2 * k);
}

/** Camera from an offset in a subject's facing frame (x right, z forward) at a point on it. */
function framed(pos: THREE.Vector3, yaw: number, local: THREE.Vector3, aimLocal: THREE.Vector3, lens: number, t: number, hand: number, seed: number): CameraState {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const w = (l: THREE.Vector3) => v(pos.x + l.x * c + l.z * s, l.y, pos.z - l.x * s + l.z * c);
  return { pos: w(local).add(handheld(t, hand, seed)), target: w(aimLocal), lens };
}

// ------------------------------------------------------------------ SB: SABLE in the server hall

const CONTACT = 5.2;
const OPEN_FIRE = 6.0;

interface Sb {
  game: Game;
  route: THREE.Vector3[];
  cum: number[];
  length: number;
  squad: Soldier[];
  target: PlayerTarget;
  pulses: { light: THREE.PointLight; phase: number; base: number }[];
  /** Fan-out positions after contact: [route distance, lateral offset, crouch, lean]. */
  spots: [number, number, number, number][];
  start: number;
  fill: THREE.PointLight;
}
let B: Sb | null = null;

/** Point at route distance d (m), offset `lat` metres to the right of travel. */
function along(b: Sb, d: number, lat = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const dd = Math.max(0, Math.min(b.length, d));
  let i = 1;
  while (i < b.route.length - 1 && b.cum[i] < dd) i++;
  const p = b.route[i - 1];
  const q = b.route[i];
  const seg = b.cum[i] - b.cum[i - 1] || 1;
  out.lerpVectors(p, q, Math.max(0, Math.min(1, (dd - b.cum[i - 1]) / seg)));
  const dir = q.clone().sub(p).setY(0).normalize();
  out.x += -dir.z * lat;
  out.z += dir.x * lat;
  return out;
}

function heading(b: Sb, d: number): number {
  const p = along(b, d - 0.5);
  const q = along(b, d + 0.5);
  return Math.atan2(q.x - p.x, q.z - p.z);
}

export const SB: Shot = {
  map: 'site9',
  duration: 12,
  preroll: 3.5,
  handles: 0,
  smooth: 0.4,
  setup(ctx: ShotCtx) {
    const game = ctx.game;
    const sv = survival(game);
    sv.over = true;
    for (const d of sv.doors) if (!d.open) sv.openDoor(d, false);
    feel.godMode = true;
    game.lighting?.setRaid(true);
    const room = (game.arena as unknown as { rooms: { id: string; rect: [number, number, number, number] }[] }).rooms.find((x) => x.id === 'servers')!;
    const [x0, z0, x1, z1] = room.rect;
    const P = (fx: number, fz: number) => game.nav.nearestWalkable(x0 + (x1 - x0) * fx, z0 + (z1 - z0) * fz, new THREE.Vector3(), 8) ?? v(x0 + (x1 - x0) * fx, 0, z0 + (z1 - z0) * fz);
    const a = P(0.8, 0.2);
    const bEnd = P(0.12, 0.85);
    const route = game.nav.findPath(a, bEnd) ?? [a, bEnd];
    if (route[0].distanceTo(a) > 0.1) route.unshift(a);
    const cum = [0];
    for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + route[i].distanceTo(route[i - 1]));
    const fill = new THREE.PointLight(0xa8bcd8, 0, 14, 1.4);
    game.scene.add(fill);
    const b: Sb = (B = { game, route, cum, length: cum[cum.length - 1] || 1, squad: [], target: squadTarget(v(0, 0, 0)), pulses: [], spots: [], start: 0, fill });
    // Our squad holds the far end (player only: the SABLE are the subject here): the farthest
    // point down the route that still sees where the Warden will stop.
    const stopD = 6 + 1.45 * CONTACT;
    const eye = (p: THREE.Vector3) => p.clone().setY(1.5);
    let holdD = stopD + 7;
    for (let d = Math.min(b.length - 0.5, stopD + 17); d > stopD + 7; d -= 0.5) {
      if (game.physics.lineOfSight(eye(along(b, stopD)), eye(along(b, d))) && game.physics.lineOfSight(eye(along(b, stopD - 4)), eye(along(b, d)))) {
        holdD = d;
        break;
      }
    }
    const hold = along(b, holdD);
    const look = along(b, stopD - 2);
    game.player.teleport(hold.clone().setY(0.1), Math.atan2(-(look.x - hold.x), -(look.z - hold.z)));
    game.weapons.giveWeapon('m4a1');
    for (const w of game.weapons.weapons) w.refill();
    game.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && m && (m as THREE.Material).type === 'MeshBasicMaterial' && m.map instanceof THREE.CanvasTexture) o.visible = false;
    });
    b.target = squadTarget(game.player.feet);
    // The column: the Warden leads (AS VAL), three operators on his trail.
    b.start = 6;
    const kit = ['asval', 'ak47', 'm4a1', 'mk47'];
    for (let i = 0; i < 4; i++) {
      const d = b.start - 2.3 * i;
      b.squad.push(soldier(game, i, i === 0, kit[i], along(b, d, i % 2 ? 0.45 : -0.2), heading(b, d)));
    }
    // Contact: the Warden stops in the aisle, the others break left and right; one drops to a knee, one leans out.
    b.spots = [
      [b.start + 1.45 * CONTACT, 0, 0, 0],
      [b.start + 1.45 * CONTACT - 0.6, 1.9, 0, 0.9],
      [b.start + 1.45 * CONTACT - 1.6, -1.8, 1, 0],
      [b.start + 1.45 * CONTACT - 3.4, 1.2, 0, -0.8],
    ];
    // Practicals: red emergency lamps along the aisle, one cold pool where they stop.
    for (const [f, lat, ph] of [[0.2, 3.5, 0], [0.42, -3.5, 1.7], [0.64, 3.5, 3.1], [0.86, -3, 4.4]] as const) {
      const p = along(b, b.length * f, lat);
      const l = new THREE.PointLight(0xff2a14, 26, 15, 1.6);
      l.position.set(p.x, 4, p.z);
      game.scene.add(l);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3018).multiplyScalar(4) }));
      lamp.position.copy(l.position);
      game.scene.add(lamp);
      b.pulses.push({ light: l, phase: ph, base: 26 });
    }
    const stop = along(b, b.spots[0][0] + 0.5);
    const pool = new THREE.SpotLight(0xcfdcf0, 95, 18, 0.48, 0.7, 1.3);
    pool.position.set(stop.x, 6.6, stop.z);
    pool.target.position.copy(stop);
    game.scene.add(pool, pool.target);
    game.scene.fog = new THREE.FogExp2(0x07080b, 0.024);
  },
  update(ctx) {
    const b = B!;
    const t = ctx.t;
    for (const p of b.pulses) p.light.intensity = p.base * (0.35 + 0.65 * Math.max(0, Math.sin(t * 2.2 + p.phase)) ** 2);
    const feet = ctx.game.player.feet;
    b.target.feet.copy(feet);
    b.target.chest.set(feet.x, 1.35, feet.z);
    b.target.head.set(feet.x, 1.7, feet.z);
    const walk = Math.max(0, t);
    b.squad.forEach((s, i) => {
      if (t < CONTACT + i * 0.18) {
        // Column on the leader's trail, carried low, eyes on the racks.
        const d = b.start + 1.45 * walk - 2.3 * i;
        s.steerTo(along(b, d + 0.6, i % 2 ? 0.45 : -0.2), 1.45);
        s.update(ctx.dt, b.target, b.squad, null, t < CONTACT - 1.2 ? 'low' : 'ready', false);
        beam(s, 0.3);
        return;
      }
      const [d, lat, crouch, lean] = b.spots[i];
      s.steerTo(along(b, d, lat), 2.6);
      s.crouchTarget = crouch;
      s.leanTarget = t > OPEN_FIRE - 0.3 ? lean : 0;
      const face = b.target.chest.clone().add(v(0, 0, (i - 1.5) * 0.6));
      const firing = t > OPEN_FIRE + i * 0.35 && (t + i * 0.3) % 1.3 < 0.85;
      s.update(ctx.dt, b.target, b.squad, face, t > CONTACT + 0.4 ? 'aim' : 'ready', firing);
      beam(s, 0.3);
    });
  },
  input(ctx, input) {
    const b = B!;
    const t = ctx.t;
    if (t < 0) return;
    const g = ctx.game;
    // Hold the aisle (breath held), then answer the nearest of them.
    // (Never the Warden: he walks out of this one.)
    const alive = b.squad.filter((s, i) => s.alive && i > 0);
    const tgt = alive.sort((p, q) => p.pos.distanceTo(g.player.feet) - q.pos.distanceTo(g.player.feet))[0];
    const look = t < OPEN_FIRE + 0.5 || !tgt ? along(b, b.start + 1.45 * Math.min(t, CONTACT)).setY(1.45) : tgt.chestPos;
    const err = aimAt(g, input, ctx.dt, look, t < OPEN_FIRE + 0.5 ? 2.2 : 5);
    input.adsHeld = t > 1.2;
    trigger(input, t, t > OPEN_FIRE + 0.6 && err < 2 && t % 0.9 < 0.5, 0);
  },
  cams: {
    pov: 'pov',
    // Low in the aisle where they will stop, looking back up it: NVG tubes and rifle beams out of the dark.
    column: (ctx): CameraState => {
      const b = B!;
      const w = b.squad[0];
      const p = safe(ctx.game, v(w.pos.x, 1.2, w.pos.z), along(b, b.spots[0][0] + 5.2, 0.6).setY(0.42)).add(handheld(ctx.t, 0.006, 1));
      return { pos: p, target: v(w.pos.x, 1.45, w.pos.z), lens: 32 };
    },
    // 85 mm on the Warden: the fur hood, the respirator, the NVG flipped up.
    warden: (ctx): CameraState => {
      const w = B!.squad[0];
      const c = framed(w.pos, w.yaw, v(-0.45, 1.62, 2.1), v(0, 1.6, 0), 85, ctx.t, 0.004, 2);
      c.pos = safe(ctx.game, v(w.pos.x, 1.6, w.pos.z), c.pos);
      return c;
    },
    // Side dolly along the rack aisle, the whole column in profile.
    side: (ctx): CameraState => {
      const b = B!;
      const mid = b.squad[1].pos.clone().lerp(b.squad[2].pos, 0.5);
      const hd = heading(b, b.start + 1.45 * Math.min(Math.max(0, ctx.t), CONTACT) - 3);
      const c = framed(mid, hd, v(2.6, 1.3, 1.4), v(0, 1.25, 0.6), 35, ctx.t, 0.01, 3);
      c.pos = safe(ctx.game, mid.clone().setY(1.3), c.pos);
      return c;
    },
    // v4: the Warden's eyes (night vision in post): down the rack aisle, hunting.
    eyes: (ctx): CameraState => {
      const w = B!.squad[0];
      const f = v(Math.sin(w.yaw), 0, Math.cos(w.yaw));
      const head = v(w.pos.x, 1.66, w.pos.z).addScaledVector(f, 0.3);
      const look = head.clone().addScaledVector(f, 8).setY(1.35).lerp(B!.target.chest, ctx.t > CONTACT ? 0.7 : 0.25);
      return { pos: head.add(handheld(ctx.t, 0.01, 6)), target: look, lens: 30 };
    },
    // Over the shoulder of the operator who leans out to fire.
    peek: (ctx): CameraState => {
      const s = B!.squad[1];
      const f = B!.target.chest;
      const yaw = Math.atan2(f.x - s.pos.x, f.z - s.pos.z);
      const c = framed(s.pos, yaw, v(0.55, 1.68, -1.25), v(-0.1, 1.35, 6), 35, ctx.t, 0.01, 4);
      c.pos = safe(ctx.game, v(s.pos.x, 1.6, s.pos.z), c.pos);
      return c;
    },
  },
  beforeRender(ctx, cam) {
    // Your own flashlight off: in the haze it floods the view; the dark is theirs (NVG tubes, rifle beams).
    const fl = (ctx.game.lighting as unknown as { flashlight?: THREE.SpotLight } | null)?.flashlight;
    if (fl) fl.intensity = 0;
    // Cinematographer's fill over the subject of each camera (none in the gameplay view).
    const sq = B!.squad;
    const w = cam === 'side' ? sq[1].pos.clone().lerp(sq[2].pos, 0.5) : cam === 'peek' ? sq[1].pos : sq[0].pos;
    B!.fill.position.set(w.x, 3.6, w.z);
    B!.fill.intensity = cam === 'pov' ? 0 : cam === 'side' ? 22 : 14;
  },
  post: (_ctx, cam) => ({ ...NIGHT_POST, exposure: cam === 'pov' ? 0.85 : 1.1, ...(cam === 'warden' ? { dof: { focus: 2.1, aperture: 0.02, maxblur: 0.012 } } : {}) }),
};

// ------------------------------------------------------------------ WD: the Warden ends it

/** The shot (take seconds). The cut syncs to the logged fire event, this is the cue. */
export const WD_FIRE = 7.22;
const HEAD = v(-48.6, 0.2, AISLE_Z + 0.25);

interface Wd {
  warden: Soldier;
  /** Your squad, dead round you in their blood (the same bodies as CR). */
  dead: Aftermath;
  target: PlayerTarget;
  fired: boolean;
  key: THREE.PointLight;
}
let D: Wd | null = null;

export const WD: Shot = {
  map: 'site9',
  duration: 9,
  preroll: 3.5,
  handles: 0,
  smooth: 0.55,
  setup(ctx) {
    const game = ctx.game;
    // The player is down: no gun up, the body is out of the way of the camera.
    stage(ctx, v(-46.2, 0.1, AISLE_Z + 2.8), Math.PI / 2, 'm4a1');
    // The work-light pool over this stretch of aisle, dimmed: at floor level it reads as a white sheet.
    game.scene.traverse((o) => {
      const l = o as THREE.SpotLight;
      if (l.isSpotLight && Math.abs(l.position.x + 50.5) < 0.1 && l.position.y > 9) l.intensity = 38;
    });
    const warden = soldier(game, 0, true, 'heavy_pistol', v(-55.6, 0, AISLE_Z - 0.8), Math.PI / 2);
    // What he aims at: your head on the floor.
    const target: PlayerTarget = { feet: HEAD.clone().setY(0), head: HEAD.clone(), chest: HEAD.clone(), velocity: v(0, 0, 0), sprinting: false, crouching: true, alive: true };
    // A low warm kicker on his mask from the work light's bounce.
    const key = new THREE.PointLight(0xffc49a, 0, 6, 1.6);
    game.scene.add(key);
    const dead = aisleDead(game, AISLE_Z);
    for (const [x, dz, n] of [[-50.4, -0.6, 26], [-53.2, 0.9, 18], [-56.8, -0.2, 14]] as const) brass(game.scene, v(x, 0, AISLE_Z + dz), n, 1.1, x * 7);
    D = { warden, dead, target, fired: false, key };
  },
  update(ctx) {
    const d = D!;
    const t = ctx.t;
    pulse(t);
    d.dead.update(ctx.dt, t);
    const w = d.warden;
    // Walk up (talking), stop over you, look down, draw down, one shot.
    const stand = v(-49.55, 0, AISLE_Z - 0.05);
    w.steerTo(t < 0 ? w.pos : stand, 1.3);
    const looking = t > 4.2;
    const aim = t > 6.2;
    const fire = t >= WD_FIRE && !d.fired;
    if (fire) d.fired = true;
    w.update(ctx.dt, d.target, [w], looking ? d.target.head : null, aim ? 'aim' : looking ? 'ready' : 'low', fire);
    beam(w, 0);
    d.key.position.set(w.pos.x + 0.6, 1.0, w.pos.z + 0.4);
    d.key.intensity = 6;
  },
  input(_ctx, input) {
    input.adsHeld = false;
    trigger(input, 0, false);
  },
  cams: {
    // On your back on the floor, head rolled to the side: he walks into frame and stands over you.
    floor: (ctx): CameraState => {
      const w = D!.warden;
      const t = ctx.t;
      const up = Math.min(1, Math.max(0, (t - 2.6) / 2.6));
      const k = up * up * (3 - 2 * up);
      const far = v(-62, 0.9, AISLE_Z - 0.4);
      const face = v(w.pos.x, 1.62, w.pos.z);
      return { pos: HEAD.clone().add(handheld(t, 0.004, 9)), target: far.lerp(face, k), lens: 24, roll: -0.42 * (1 - 0.45 * k) };
    },
    // Insert from where you lie: 85 mm up at the respirator as he speaks.
    mask: (ctx): CameraState => {
      const w = D!.warden;
      const face = v(w.pos.x, 1.72, w.pos.z);
      return { pos: HEAD.clone().add(v(0.25, 0.12, -0.35)).add(handheld(ctx.t, 0.003, 10)), target: face, lens: 85, roll: -0.12 };
    },
  },
  post: (_ctx, cam) => ({ ...NIGHT_POST, exposure: 0.82, ...(cam === 'mask' ? { dof: { focus: 1.75, aperture: 0.02, maxblur: 0.01 } } : {}) }),
};
