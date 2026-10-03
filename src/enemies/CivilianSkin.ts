import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { MeshBuilder } from '../world/MeshBuilder';
import type { HumanoidSkin, PartDef } from '../targets/Humanoid';
import { skinDetail } from './SoldierSkin';

type V3 = [number, number, number];

const rb = (w: number, h: number, d: number) => (skinDetail.low ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.28));
const rbox = (b: MeshBuilder, m: THREE.Material, size: V3, pos: V3, rot: V3 = [0, 0, 0]) => b.add(m, rb(...size), pos, rot);
const std = (color: number, roughness = 0.85, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

const THIGH = 0.44;
const SHIN = 0.46;
const UPPER = 0.29;

/** Deep cowl: a sphere with the face side cut open (+Z). */
const COWL = new THREE.SphereGeometry(1, 14, 10, Math.PI / 2 + 0.75, Math.PI * 2 - 1.5, 0, Math.PI * 0.86);

const merged = new Map<string, THREE.MeshStandardMaterial>();
const mergedMat = (key: string) => {
  let m = merged.get(key);
  if (!m) merged.set(key, (m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 })));
  return m;
};

const SKIN_TONES = [0xe0b394, 0xc68e6a, 0x9c6a4c, 0x6e4a35, 0xf0cdb0];
const HAIR = [0x1d1612, 0x3b2a1e, 0x7a5532, 0xc9a96a, 0x5c5854];
const SHIRTS = [0x9fb7d0, 0xb7c9b0, 0xd6c7b0, 0x8e9aab, 0xc9a7a7];

const tones = new Map<string, THREE.MeshStandardMaterial>();
const tone = (c: number) => {
  const k = c.toString(16);
  let m = tones.get(k);
  if (!m) tones.set(k, (m = std(c, 0.75)));
  return m;
};

/**
 * Site-9 lab staff: white lab coat over a coloured shirt, dark trousers, an ID
 * badge and pens. `variant` picks skin tone, hair, shirt, glasses and hair
 * length so a room full of them isn't one man copied.
 */
export function labSkin(variant: number): HumanoidSkin {
  const coat = tone(0xe9eceb);
  const coatShade = tone(0xcfd4d3);
  const pants = tone(variant % 3 === 0 ? 0x2c3440 : variant % 3 === 1 ? 0x3a3530 : 0x23272c);
  const shoe = tone(variant % 2 ? 0x1b1b1d : 0xd9dadc);
  const skin = tone(SKIN_TONES[variant % SKIN_TONES.length]);
  const hair = tone(HAIR[(variant * 3 + 1) % HAIR.length]);
  const shirt = tone(SHIRTS[(variant * 7 + 2) % SHIRTS.length]);
  const dark = tone(0x111214);
  const badge = tone(0x3a7fd0);
  const glasses = variant % 3 === 1;
  const longHair = variant % 2 === 1;

  const legs = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'thighR' : 'thighL', parent: 'pelvis', pos: [0.1 * side, -0.05, 0], side,
      build: (b) => {
        rbox(b, pants, [0.15, THIGH, 0.16], [0, -THIGH / 2, 0]);
        // Coat tail over the thigh (moves with the leg: reads as cloth).
        rbox(b, coat, [0.17, 0.3, 0.18], [0.01 * side, -0.14, -0.005]);
      },
      colliders: [{ half: [0.08, THIGH / 2, 0.085], center: [0, -THIGH / 2, 0], mass: 9, zone: 'leg', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'shinR' : 'shinL', parent: side === 1 ? 'thighR' : 'thighL', pos: [0, -THIGH, 0], side,
      build: (b) => {
        rbox(b, pants, [0.125, 0.36, 0.13], [0, -0.2, 0]);
        rbox(b, shoe, [0.12, 0.08, 0.25], [0, -0.42, 0.04]);
      },
      colliders: [{ half: [0.07, SHIN / 2, 0.085], center: [0, -SHIN / 2, 0.02], mass: 5, zone: 'leg', surface: 'flesh' }],
    },
  ]);
  const arms = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'upperArmR' : 'upperArmL', parent: 'torso', pos: [0.19 * side, 0.42, 0], side,
      build: (b) => rbox(b, coat, [0.1, UPPER, 0.105], [0, -UPPER / 2, 0]),
      colliders: [{ half: [0.05, UPPER / 2, 0.055], center: [0, -UPPER / 2, 0], mass: 3, zone: 'arm', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'foreArmR' : 'foreArmL', parent: side === 1 ? 'upperArmR' : 'upperArmL', pos: [0, -UPPER, 0], side,
      build: (b) => {
        rbox(b, coat, [0.092, 0.22, 0.095], [0, -0.11, 0]);
        rbox(b, coatShade, [0.096, 0.03, 0.1], [0, -0.215, 0]); // cuff
        rbox(b, skin, [0.07, 0.1, 0.085], [0, -0.28, 0.005]); // hand
      },
      colliders: [{ half: [0.047, 0.15, 0.05], center: [0, -0.15, 0], mass: 2, zone: 'arm', surface: 'flesh' }],
    },
  ]);
  return {
    health: 55,
    merge: mergedMat(`lab${variant}`),
    shinLength: SHIN,
    handGrip: [0, -0.28, 0],
    headMultiplier: 3,
    bluntFactor: 0.5,
    idleKnee: 0.08,
    zoneDamage: { head: 3, thorax: 1.1, stomach: 1.1, arm: 0.7, leg: 0.8 },
    parts: [
      {
        name: 'pelvis', parent: null, pos: [0, 0.97, 0], side: 0,
        build: (b) => {
          rbox(b, pants, [0.32, 0.2, 0.2], [0, -0.04, 0]);
          rbox(b, dark, [0.33, 0.035, 0.21], [0, 0.05, 0]); // belt
          rbox(b, coat, [0.35, 0.22, 0.22], [0, -0.03, -0.01]); // coat skirt round the hips
          rbox(b, coatShade, [0.012, 0.22, 0.012], [0, -0.03, 0.115]); // front opening
        },
        colliders: [{ half: [0.17, 0.11, 0.11], center: [0, -0.02, 0], mass: 14, zone: 'stomach', surface: 'flesh' }],
      },
      ...legs,
      {
        name: 'torso', parent: 'pelvis', pos: [0, 0.03, 0], side: 0,
        build: (b) => {
          rbox(b, shirt, [0.3, 0.44, 0.18], [0, 0.23, 0]);
          // Open coat: back, sides and the two front panels, lapels, pockets.
          rbox(b, coat, [0.34, 0.46, 0.06], [0, 0.23, -0.08]);
          for (const s of [-1, 1]) {
            rbox(b, coat, [0.05, 0.46, 0.2], [0.155 * s, 0.23, 0]);
            rbox(b, coat, [0.09, 0.44, 0.03], [0.11 * s, 0.22, 0.095]);
            rbox(b, coatShade, [0.05, 0.14, 0.035], [0.085 * s, 0.4, 0.1], [0, 0, 0.35 * s]); // lapel
            rbox(b, coatShade, [0.08, 0.07, 0.01], [0.11 * s, 0.07, 0.111]); // hip pocket
          }
          rbox(b, coatShade, [0.08, 0.06, 0.01], [-0.11, 0.33, 0.111]); // chest pocket
          for (const x of [-0.13, -0.115]) b.cylinder(variant % 2 ? badge : dark, 0.006, 0.08, [x, 0.36, 0.115], [0, 0, 0], 6); // pens
          rbox(b, tone(0xf2f2f2), [0.055, 0.075, 0.006], [0.1, 0.3, 0.115]); // ID badge
          rbox(b, badge, [0.055, 0.02, 0.007], [0.1, 0.325, 0.116]);
          rbox(b, coatShade, [0.14, 0.06, 0.13], [0, 0.46, -0.01]); // collar
        },
        colliders: [
          { half: [0.16, 0.09, 0.11], center: [0, 0.08, 0], mass: 8, zone: 'stomach', surface: 'flesh' },
          { half: [0.17, 0.15, 0.12], center: [0, 0.31, 0], mass: 18, zone: 'thorax', surface: 'flesh' },
        ],
      },
      ...arms,
      {
        name: 'head', parent: 'torso', pos: [0, 0.48, 0], side: 0,
        build: (b) => {
          b.cylinder(skin, 0.05, 0.08, [0, 0.03, 0], [0, 0, 0], 10);
          rbox(b, skin, [0.165, 0.21, 0.185], [0, 0.15, 0.01]);
          rbox(b, skin, [0.03, 0.04, 0.03], [0, 0.135, 0.11]); // nose
          for (const x of [-0.038, 0.038]) rbox(b, dark, [0.024, 0.012, 0.01], [x, 0.172, 0.104]);
          rbox(b, hair, [0.175, 0.07, 0.195], [0, 0.255, 0.0]);
          rbox(b, hair, [0.175, 0.16, 0.05], [0, 0.18, -0.085]);
          if (longHair) rbox(b, hair, [0.12, 0.2, 0.05], [0, 0.09, -0.105]); // ponytail / long hair
          if (glasses) {
            for (const x of [-0.038, 0.038]) rbox(b, dark, [0.045, 0.03, 0.008], [x, 0.172, 0.11]);
            rbox(b, dark, [0.02, 0.006, 0.008], [0, 0.178, 0.11]);
          }
        },
        colliders: [{ half: [0.09, 0.12, 0.1], center: [0, 0.15, 0.01], mass: 4, zone: 'head', surface: 'flesh' }],
      },
    ],
  };
}

/** The Choir's materials (shared): the eye glow is animated by the cult (Cultist.ts). */
export const choirEyes = std(0x200000, 0.4, 0, { emissive: 0xff2a14, emissiveIntensity: 1.2 });

/**
 * The Choir: robot-worshipping squatters in long hooded robes and pale
 * featureless masks with two dim red eyes, a rusted gear on a cord round the
 * neck, rag-wrapped hands, a long blade held point-down in the right.
 */
export function choirSkin(variant: number): HumanoidSkin {
  const robe = tone(variant % 2 ? 0x17120f : 0x1c1714);
  const robeShade = tone(0x0e0b09);
  const rope = tone(0x6b5a3e);
  const rags = tone(0x6f6553);
  const mask = tone(variant % 3 === 2 ? 0xbdb3a2 : 0xd6cfc2);
  const hole = tone(0x050404);
  const rust = tone(0x5a3524);
  const steel = std(0x8d9399, 0.3, 0.85);
  const legs = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'thighR' : 'thighL', parent: 'pelvis', pos: [0.1 * side, -0.05, 0], side,
      build: (b) => rbox(b, robe, [0.19, THIGH + 0.04, 0.21], [0, -THIGH / 2, 0]),
      colliders: [{ half: [0.08, THIGH / 2, 0.09], center: [0, -THIGH / 2, 0], mass: 9, zone: 'leg', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'shinR' : 'shinL', parent: side === 1 ? 'thighR' : 'thighL', pos: [0, -THIGH, 0], side,
      build: (b) => {
        rbox(b, robe, [0.18, 0.3, 0.2], [0, -0.13, 0]); // robe hem
        rbox(b, rags, [0.11, 0.16, 0.12], [0, -0.35, 0]); // wrapped shins
        rbox(b, robeShade, [0.11, 0.07, 0.22], [0, -0.43, 0.04]);
      },
      colliders: [{ half: [0.07, SHIN / 2, 0.085], center: [0, -SHIN / 2, 0.02], mass: 5, zone: 'leg', surface: 'flesh' }],
    },
  ]);
  const arms = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'upperArmR' : 'upperArmL', parent: 'torso', pos: [0.2 * side, 0.42, 0], side,
      build: (b) => rbox(b, robe, [0.13, UPPER + 0.02, 0.135], [0, -UPPER / 2, 0]),
      colliders: [{ half: [0.055, UPPER / 2, 0.06], center: [0, -UPPER / 2, 0], mass: 3, zone: 'arm', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'foreArmR' : 'foreArmL', parent: side === 1 ? 'upperArmR' : 'upperArmL', pos: [0, -UPPER, 0], side,
      build: (b) => {
        rbox(b, robe, [0.15, 0.2, 0.15], [0, -0.09, 0]); // wide sleeve
        rbox(b, rags, [0.07, 0.12, 0.08], [0, -0.25, 0.005]);
        rbox(b, rags, [0.068, 0.09, 0.08], [0, -0.3, 0.01]); // wrapped hand
        if (side === 1) {
          // Long blade, point down (reverse grip): handle in the fist, blade below it.
          rbox(b, robeShade, [0.03, 0.11, 0.03], [0, -0.3, 0.06]);
          rbox(b, steel, [0.008, 0.26, 0.035], [0, -0.48, 0.06]);
          rbox(b, rust, [0.05, 0.012, 0.045], [0, -0.355, 0.06]); // guard
        }
      },
      colliders: [{ half: [0.05, 0.16, 0.055], center: [0, -0.15, 0], mass: 2, zone: 'arm', surface: 'flesh' }],
    },
  ]);
  return {
    health: 120,
    merge: mergedMat(`choir${variant % 3}`),
    shinLength: SHIN,
    handGrip: [0, -0.29, 0],
    headMultiplier: 3,
    bluntFactor: 0.4,
    idleKnee: 0.22,
    zoneDamage: { head: 3, thorax: 1, stomach: 1, arm: 0.6, leg: 0.7 },
    parts: [
      {
        name: 'pelvis', parent: null, pos: [0, 0.97, 0], side: 0,
        build: (b) => {
          rbox(b, robe, [0.38, 0.26, 0.26], [0, -0.06, 0]);
          rbox(b, rope, [0.39, 0.03, 0.27], [0, 0.06, 0]); // rope belt
          b.cylinder(rope, 0.01, 0.3, [0.12, -0.1, 0.13], [0.1, 0, 0.05], 5); // hanging cord
        },
        colliders: [{ half: [0.18, 0.11, 0.12], center: [0, -0.02, 0], mass: 14, zone: 'stomach', surface: 'flesh' }],
      },
      ...legs,
      {
        name: 'torso', parent: 'pelvis', pos: [0, 0.03, 0], side: 0,
        build: (b) => {
          rbox(b, robe, [0.38, 0.5, 0.24], [0, 0.24, -0.005]);
          rbox(b, robeShade, [0.02, 0.44, 0.02], [0, 0.22, 0.12]); // fold down the front
          // The gear on a cord: a rusted cog with teeth.
          b.cylinder(rust, 0.045, 0.012, [0, 0.33, 0.13], [Math.PI / 2, 0, 0], 12);
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            rbox(b, rust, [0.018, 0.018, 0.012], [Math.cos(a) * 0.052, 0.33 + Math.sin(a) * 0.052, 0.13], [0, 0, a]);
          }
          b.cylinder(hole, 0.015, 0.014, [0, 0.33, 0.131], [Math.PI / 2, 0, 0], 8);
          for (const s of [-1, 1]) b.cylinder(rope, 0.005, 0.2, [0.05 * s, 0.43, 0.11], [0.2, 0, 0.45 * s], 4);
        },
        colliders: [
          { half: [0.17, 0.09, 0.12], center: [0, 0.08, 0], mass: 8, zone: 'stomach', surface: 'flesh' },
          { half: [0.18, 0.16, 0.13], center: [0, 0.31, 0], mass: 20, zone: 'thorax', surface: 'flesh' },
        ],
      },
      ...arms,
      {
        name: 'head', parent: 'torso', pos: [0, 0.48, 0], side: 0,
        build: (b) => {
          // Pale smooth mask, two black eye holes with a dim red glow inside, a cowl round it.
          rbox(b, hole, [0.16, 0.2, 0.17], [0, 0.15, -0.005]);
          rbox(b, mask, [0.15, 0.21, 0.04], [0, 0.155, 0.085]);
          rbox(b, mask, [0.13, 0.05, 0.03], [0, 0.07, 0.08]); // chin
          for (const x of [-0.036, 0.036]) {
            rbox(b, hole, [0.03, 0.018, 0.01], [x, 0.175, 0.106]);
            rbox(b, choirEyes, [0.012, 0.008, 0.004], [x, 0.175, 0.111]);
          }
          rbox(b, hole, [0.006, 0.06, 0.006], [0, 0.11, 0.106]); // a single crack
          b.add(robe, COWL.clone(), [0, 0.17, -0.02], [0, 0, 0], [0.15, 0.175, 0.16]);
          rbox(b, robe, [0.3, 0.1, 0.26], [0, 0.02, -0.03]); // cowl drape on the shoulders
        },
        colliders: [{ half: [0.1, 0.12, 0.11], center: [0, 0.15, 0], mass: 4, zone: 'head', surface: 'flesh' }],
      },
    ],
  };
}
