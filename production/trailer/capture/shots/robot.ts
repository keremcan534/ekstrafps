import * as THREE from 'three';
import type { Shot } from '../Director';
import { RogueRobot, type MeleeTarget } from '../../../../src/enemies/RogueRobot';
import { blackStage, dust, handheld } from '../stage';
import { metalTexture } from '../../../../src/fx/Textures';

/**
 * Robot close-ups on a dark steel deck (real Site-9 rogue robot, real dormant →
 * wake animation, real stomping walk). One robot, one hard red rim from behind,
 * a cold sliver of fill, haze. Covers C02 C03 C04 B09 E03 H05 I01 I02 M05 M06 M12.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
let R: { robot: RogueRobot; motes: ReturnType<typeof dust>; target: MeleeTarget } | null = null;
const WAKE = 1.6;
const WALK = 3.0;

/** World position of a body part's bone (follows the slump, the wake and the walk). */
const bone = (r: RogueRobot, name: string, out = new THREE.Vector3()) => r.body.parts.find((p) => p.name === name)!.group.getWorldPosition(out);
/** Offset in the robot's facing frame (x right, z forward). */
const around = (r: RogueRobot, at: THREE.Vector3, l: THREE.Vector3) => {
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  return v(at.x + l.x * c + l.z * s, at.y + l.y, at.z - l.x * s + l.z * c);
};


export const RB: Shot = {
  map: 'lab',
  duration: 9,
  preroll: 0.5,
  handles: 0,
  setup(ctx) {
    const game = ctx.game;
    const set = blackStage(game);
    const deck = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.7, roughness: 0.55, map: metalTexture() }),
    );
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, 0.002, -20);
    deck.receiveShadow = true;
    set.add(deck);
    game.scene.fog = new THREE.FogExp2(0x050608, 0.06);
    // Hard red rim from behind-left, cold sliver of fill from camera-right, a high cold top.
    const red = new THREE.SpotLight(0xff3018, 110, 18, 0.45, 0.6, 1.6);
    red.position.set(-2.4, 3.0, -24.5);
    red.target.position.set(0, 1.5, -20);
    red.castShadow = true;
    set.add(red, red.target);
    const cold = new THREE.SpotLight(0x9fbce0, 34, 14, 0.32, 0.8, 1.6);
    cold.position.set(2.6, 2.3, -16.2);
    cold.target.position.set(0, 1.5, -20);
    set.add(cold, cold.target);
    const top = new THREE.SpotLight(0xd8e4ff, 14, 10, 0.25, 0.7, 1.5);
    top.position.set(0, 7, -20);
    top.target.position.set(0, 0, -20);
    set.add(top, top.target);
    const motes = dust(1500, v(8, 4, 8), v(0, 2, -20), 0.25);
    (motes.material as THREE.PointsMaterial).size = 0.012;
    set.add(motes);

    const robot = new RogueRobot(game.physics, game.scene, game.nav, {
      onDamage: () => {},
      onDeath: () => {},
      onAttack: () => {},
      onThud: (at, s) => game.audio.play('robot.fall', { position: at, volume: 0.3 + 0.5 * s }),
      onWake: (r) => game.audio.play('robot.wake', { position: r.pos }),
    });
    robot.spawn(v(0, 0, -20), 300, 1.35, 0, 'idle', 0);
    // It walks toward the lens side (+z); the target never gets reached.
    const target: MeleeTarget = { pos: v(0, 0, -5), alive: true, hit: () => {} };
    R = { robot, motes, target };
  },
  update(ctx) {
    const { robot, motes, target } = R!;
    if (ctx.t >= WAKE && robot.dormant) robot.wake();
    robot.update(ctx.dt, ctx.t >= WALK ? [target] : [], [robot]);
    motes.tick(ctx.t);
  },
  cams: {
    // 100 mm ECU on the visor (sensor waking), framed on the real head bone.
    visor: (ctx) => {
      const r = R!.robot;
      const h = bone(r, 'head').add(v(0, 0.1, 0));
      return { pos: around(r, h, v(0.38, 0.05, 1.6)).add(handheld(ctx.t, 0.0015, 1)), target: around(r, h, v(0, 0, 0.08)), lens: 100 };
    },
    // 50 mm on the deck: the foot below the knee.
    foot: (ctx) => {
      const r = R!.robot;
      const k = bone(r, 'shinL');
      const f = v(k.x, 0.12, k.z);
      return { pos: around(r, f, v(1.0, 0.0, 1.15)).add(handheld(ctx.t, 0.002, 2)), target: f, lens: 50 };
    },
    // 85 mm silhouette of head and shoulders against the red.
    servo: (ctx) => {
      const r = R!.robot;
      const h = bone(r, 'head');
      return { pos: around(r, h, v(-1.7, 0.2, 2.1)).add(handheld(ctx.t, 0.003, 3)), target: around(r, h, v(0, -0.05, 0)), lens: 85 };
    },
    // Macro on the chest sensor (circle match for the holo ring).
    chest: (ctx) => {
      const r = R!.robot;
      const c = bone(r, 'torso').add(v(0, 0.42, 0));
      return { pos: around(r, c, v(0.1, 0.02, 1.15)).add(handheld(ctx.t, 0.0015, 4)), target: around(r, c, v(0, 0, 0.1)), lens: 100 };
    },
    // Knee joint.
    knee: (ctx) => {
      const r = R!.robot;
      const k = bone(r, 'shinR');
      return { pos: around(r, k, v(-0.8, 0.1, 1.0)).add(handheld(ctx.t, 0.002, 5)), target: k, lens: 85 };
    },
    // Wide, low, from the front: full silhouette, then it stomps at the lens.
    wide: (ctx) => ({ pos: v(0.5, 0.32, -15.2).add(handheld(ctx.t, 0.006, 6)), target: v(0, 1.25, -20), lens: 28 }),
    // Long lens across the deck: tiny red slit in the dark (B09 / I02 far shot).
    far: (ctx) => ({ pos: v(4, 1.6, -4).add(handheld(ctx.t, 0.004, 7)), target: bone(R!.robot, 'head'), lens: 135 }),
  },
  post: (_ctx, cam) => ({
    exposure: 1.0,
    contrast: 1.2,
    bloom: { strength: 0.9, radius: 0.6, threshold: 0.75 },
    dof: cam === 'visor' ? { focus: 1.62, aperture: 0.05, maxblur: 0.014 } : cam === 'chest' ? { focus: 1.12, aperture: 0.05, maxblur: 0.014 } : cam === 'knee' ? { focus: 1.28, aperture: 0.03, maxblur: 0.012 } : cam === 'foot' ? { focus: 1.52, aperture: 0.03, maxblur: 0.012 } : null,
  }),
};
