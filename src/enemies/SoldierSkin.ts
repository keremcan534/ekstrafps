import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { MeshBuilder } from '../world/MeshBuilder';
import type { HumanoidSkin, PartDef } from '../targets/Humanoid';

type V3 = [number, number, number];

/**
 * Black Division operator: all-black fabric and gear, plate carrier (armor class
 * ~4), high-cut helmet (class ~3) with a flipped-down quad night-vision unit whose
 * tubes glow a faint green, ear protection, radio, and a blinking IR strobe.
 * Faceless on purpose.
 */
export interface SoldierMaterials {
  fabric: THREE.MeshStandardMaterial;
  gear: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  boots: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
  tubes: THREE.MeshStandardMaterial;
  strobe: THREE.MeshStandardMaterial;
  patch: THREE.MeshStandardMaterial;
}

let shared: SoldierMaterials | null = null;

export function soldierMaterials(): SoldierMaterials {
  if (shared) return shared;
  shared = {
    fabric: new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.96, metalness: 0 }),
    gear: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.86, metalness: 0.05 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.78, metalness: 0.08 }),
    boots: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.5, metalness: 0.1 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0x1c1e20, roughness: 0.62, metalness: 0.18 }),
    tubes: new THREE.MeshStandardMaterial({ color: 0x050605, emissive: 0x2bff7a, emissiveIntensity: 0.9, roughness: 0.1, metalness: 0.6 }),
    strobe: new THREE.MeshStandardMaterial({ color: 0x100000, emissive: 0xff1a10, emissiveIntensity: 0, roughness: 0.4 }),
    patch: new THREE.MeshStandardMaterial({ map: insigniaTexture(), roughness: 0.9 }),
  };
  return shared;
}

/** Unit insignia: a black shield with a single red vertical slash. */
function insigniaTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1c1e';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#060606';
  g.beginPath();
  g.moveTo(10, 8);
  g.lineTo(54, 8);
  g.lineTo(54, 36);
  g.lineTo(32, 58);
  g.lineTo(10, 36);
  g.closePath();
  g.fill();
  g.strokeStyle = '#3a3c40';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#8a1410';
  g.fillRect(29, 14, 6, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const rb = (w: number, h: number, d: number) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.28);
/** Rounded box with the MeshBuilder's (material, size, position, rotation) signature. */
const rbox = (b: MeshBuilder, m: THREE.Material, size: V3, pos: V3, rot: V3 = [0, 0, 0]) => b.add(m, rb(...size), pos, rot);

const THIGH = 0.44;
const SHIN = 0.46;
const UPPER = 0.29;

export function soldierSkin(health: number): HumanoidSkin {
  const m = soldierMaterials();
  const legs = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'thighR' : 'thighL', parent: 'pelvis', pos: [0.1 * side, -0.05, 0], side,
      build: (b) => {
        rbox(b, m.fabric, [0.155, THIGH, 0.17], [0, -THIGH / 2, 0]);
        rbox(b, m.gear, [0.035, 0.13, 0.11], [0.085 * side, -0.22, 0.005]); // cargo pocket
        if (side === 1) {
          rbox(b, m.gear, [0.05, 0.17, 0.09], [0.1, -0.13, -0.01]); // drop-leg holster
          rbox(b, m.boots, [0.03, 0.08, 0.05], [0.12, -0.06, -0.01]);
        }
      },
      colliders: [{ half: [0.08, THIGH / 2, 0.09], center: [0, -THIGH / 2, 0], mass: 9, zone: 'leg', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'shinR' : 'shinL', parent: side === 1 ? 'thighR' : 'thighL', pos: [0, -THIGH, 0], side,
      build: (b) => {
        rbox(b, m.gear, [0.13, 0.11, 0.06], [0, -0.03, 0.075]); // knee pad
        rbox(b, m.fabric, [0.13, 0.3, 0.14], [0, -0.18, 0]);
        rbox(b, m.boots, [0.135, 0.15, 0.16], [0, -0.385, -0.005]);
        rbox(b, m.boots, [0.125, 0.075, 0.12], [0, -0.42, 0.1]);
      },
      colliders: [{ half: [0.075, SHIN / 2, 0.09], center: [0, -SHIN / 2, 0.02], mass: 5, zone: 'leg', surface: 'flesh' }],
    },
  ]);

  const arms = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'upperArmR' : 'upperArmL', parent: 'torso', pos: [0.2 * side, 0.42, 0], side,
      build: (b) => {
        rbox(b, m.fabric, [0.1, UPPER, 0.11], [0, -UPPER / 2, 0]);
        rbox(b, m.gear, [0.12, 0.08, 0.13], [0, -0.01, 0]);
        if (side === -1) b.add(m.patch, new THREE.PlaneGeometry(0.065, 0.065), [-0.0515, -0.09, 0], [0, -Math.PI / 2, 0]);
      },
      colliders: [{ half: [0.055, UPPER / 2, 0.06], center: [0, -UPPER / 2, 0], mass: 3, zone: 'arm', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'foreArmR' : 'foreArmL', parent: side === 1 ? 'upperArmR' : 'upperArmL', pos: [0, -UPPER, 0], side,
      build: (b) => {
        rbox(b, m.fabric, [0.09, 0.24, 0.1], [0, -0.12, 0]);
        rbox(b, m.gear, [0.075, 0.1, 0.09], [0, -0.29, 0.005]); // glove
        rbox(b, m.boots, [0.08, 0.03, 0.095], [0, -0.245, 0.005]); // cuff
      },
      colliders: [{ half: [0.05, 0.16, 0.055], center: [0, -0.15, 0], mass: 2, zone: 'arm', surface: 'flesh' }],
    },
  ]);

  return {
    health,
    shinLength: SHIN,
    handGrip: [0, -0.29, 0],
    headMultiplier: 3,
    bluntFactor: 0.3,
    idleKnee: 0.12,
    zoneDamage: { head: 3, thorax: 1, stomach: 1, arm: 0.6, leg: 0.7 },
    parts: [
      {
        name: 'pelvis', parent: null, pos: [0, 0.97, 0], side: 0,
        build: (b) => {
          rbox(b, m.fabric, [0.34, 0.2, 0.22], [0, -0.04, 0]);
          rbox(b, m.gear, [0.37, 0.06, 0.25], [0, 0.05, 0]); // belt
          rbox(b, m.gear, [0.08, 0.1, 0.06], [0.15, 0.02, 0.11]);
          rbox(b, m.gear, [0.08, 0.1, 0.06], [-0.15, 0.02, 0.11]);
          rbox(b, m.gear, [0.2, 0.13, 0.07], [0, 0, -0.13]); // dump pouch
        },
        colliders: [{ half: [0.18, 0.11, 0.12], center: [0, -0.02, 0], mass: 14, zone: 'stomach', surface: 'flesh' }],
      },
      ...legs,
      {
        name: 'torso', parent: 'pelvis', pos: [0, 0.03, 0], side: 0,
        build: (b) => {
          rbox(b, m.fabric, [0.34, 0.46, 0.2], [0, 0.23, 0]);
          // Plate carrier: front/back plates, cummerbund, shoulder straps.
          rbox(b, m.plate, [0.31, 0.32, 0.065], [0, 0.27, 0.125]);
          rbox(b, m.plate, [0.31, 0.34, 0.065], [0, 0.27, -0.125]);
          rbox(b, m.gear, [0.37, 0.15, 0.23], [0, 0.13, 0]);
          rbox(b, m.gear, [0.07, 0.045, 0.27], [0.11, 0.445, 0]);
          rbox(b, m.gear, [0.07, 0.045, 0.27], [-0.11, 0.445, 0]);
          // Triple mag pouch + admin pouch.
          for (const x of [-0.09, 0, 0.09]) rbox(b, m.gear, [0.08, 0.13, 0.055], [x, 0.17, 0.18]);
          rbox(b, m.gear, [0.2, 0.08, 0.04], [0, 0.33, 0.175]);
          b.add(m.patch, new THREE.PlaneGeometry(0.055, 0.055), [0.085, 0.37, 0.196]);
          // Radio + antenna, hydration carrier.
          rbox(b, m.gear, [0.065, 0.13, 0.05], [-0.13, 0.3, -0.18]);
          b.cylinder(m.boots, 0.005, 0.32, [-0.13, 0.5, -0.19], [0.12, 0, 0], 5);
          rbox(b, m.gear, [0.22, 0.27, 0.07], [0, 0.27, -0.185]);
          rbox(b, m.fabric, [0.14, 0.08, 0.14], [0, 0.47, 0]); // collar
        },
        colliders: [
          { half: [0.17, 0.09, 0.12], center: [0, 0.08, 0], mass: 8, zone: 'stomach', surface: 'flesh' },
          { half: [0.19, 0.16, 0.16], center: [0, 0.31, 0], mass: 22, zone: 'thorax', surface: 'armor', armor: 40 },
        ],
      },
      ...arms,
      {
        name: 'head', parent: 'torso', pos: [0, 0.48, 0], side: 0,
        build: (b) => {
          b.cylinder(m.fabric, 0.055, 0.09, [0, 0.03, 0], [0, 0, 0], 10);
          rbox(b, m.fabric, [0.19, 0.23, 0.21], [0, 0.15, 0.01]); // balaclava
          // High-cut helmet, rails, ear pro.
          rbox(b, m.helmet, [0.235, 0.13, 0.255], [0, 0.275, -0.005]);
          rbox(b, m.helmet, [0.245, 0.035, 0.265], [0, 0.22, -0.005]);
          for (const s of [-1, 1]) {
            rbox(b, m.gear, [0.02, 0.04, 0.12], [0.123 * s, 0.24, -0.01]);
            b.cylinder(m.gear, 0.047, 0.045, [0.115 * s, 0.15, 0], [0, 0, Math.PI / 2], 14);
          }
          // Quad NVG on a flip-down mount: four faintly glowing tubes.
          rbox(b, m.gear, [0.05, 0.05, 0.035], [0, 0.275, 0.135]);
          rbox(b, m.gear, [0.15, 0.055, 0.045], [0, 0.205, 0.135]);
          for (const x of [-0.055, -0.019, 0.019, 0.055]) b.cylinder(m.helmet, 0.018, 0.05, [x, 0.19, 0.17], [Math.PI / 2, 0, 0], 10);
          for (const x of [-0.055, -0.019, 0.019, 0.055]) b.cylinder(m.tubes, 0.014, 0.005, [x, 0.19, 0.196], [Math.PI / 2, 0, 0], 10);
          rbox(b, m.gear, [0.07, 0.04, 0.05], [0, 0.29, -0.13]); // counterweight
          rbox(b, m.strobe, [0.022, 0.022, 0.022], [0.0, 0.322, -0.12]);
        },
        colliders: [
          { half: [0.1, 0.09, 0.11], center: [0, 0.12, 0.01], mass: 3, zone: 'head', surface: 'flesh' },
          { half: [0.125, 0.065, 0.135], center: [0, 0.265, 0], mass: 2, zone: 'head', surface: 'helmet', armor: 30 },
        ],
      },
    ],
  };
}
