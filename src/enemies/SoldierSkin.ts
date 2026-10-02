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
  /** Field kit (hooded): hood, face mask, skin round the eyes, fur trim, gloves, trousers. */
  hood: THREE.MeshStandardMaterial;
  mask: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  fur: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  pants: THREE.MeshStandardMaterial;
}

/** Black Division (all black, green NVG) or Vanta Security (navy, white helmet, cyan NVG). */
export type SoldierPalette = 'bd' | 'vanta' | 'bravo' | 'charlie' | 'delta';

const shared = new Map<SoldierPalette, SoldierMaterials>();

export function soldierMaterials(palette: SoldierPalette = 'bd'): SoldierMaterials {
  let m = shared.get(palette);
  if (m) return m;
  // fabric, gear, plate, helmet, NVG glow, strobe colour per faction.
  const P: Record<SoldierPalette, number[]> = {
    bd: [0x121315, 0x1a1c1e, 0x17191b, 0x1c1e20, 0x2bff7a, 0xff1a10],
    // Vanta field kit: light grey jacket, dark carrier and webbing (the hood/mask/fur come from K below).
    vanta: [0x868c93, 0x2b2e32, 0x222528, 0x8f949b, 0x40d0ff, 0x3aa0ff],
    bravo: [0x8a7458, 0x6e5c44, 0x5d4e3a, 0xa38a68, 0xffa040, 0xffa040],
    charlie: [0x4a5536, 0x3a4429, 0x313a23, 0x55613c, 0x9dff4a, 0x9dff4a],
    delta: [0x5a5f6a, 0x444852, 0x3a3e46, 0x7a7f8a, 0xd06aff, 0xd06aff],
  };
  const [cFab, cGear, cPlate, cHelm, cGlow, cStrobe] = P[palette];
  m = {
    fabric: new THREE.MeshStandardMaterial({ color: cFab, roughness: 0.96, metalness: 0 }),
    gear: new THREE.MeshStandardMaterial({ color: cGear, roughness: 0.86, metalness: 0.05 }),
    plate: new THREE.MeshStandardMaterial({ color: cPlate, roughness: 0.78, metalness: 0.08 }),
    boots: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.5, metalness: 0.1 }),
    helmet: new THREE.MeshStandardMaterial({ color: cHelm, roughness: 0.55, metalness: 0.18 }),
    tubes: new THREE.MeshStandardMaterial({ color: 0x050605, emissive: cGlow, emissiveIntensity: 0.9, roughness: 0.1, metalness: 0.6 }),
    strobe: new THREE.MeshStandardMaterial({ color: 0x100000, emissive: cStrobe, emissiveIntensity: 0.01, roughness: 0.4 }),
    patch: new THREE.MeshStandardMaterial({ map: insigniaTexture(), roughness: 0.9 }),
    hood: new THREE.MeshStandardMaterial({ color: palette === 'vanta' ? 0x7e838a : cFab, roughness: 0.98, metalness: 0 }),
    mask: new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.95, metalness: 0 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xa47e66, roughness: 0.7, metalness: 0 }),
    fur: new THREE.MeshStandardMaterial({ color: 0x6a5843, roughness: 1, metalness: 0 }),
    glove: new THREE.MeshStandardMaterial({ color: palette === 'vanta' ? 0x857560 : cGear, roughness: 0.85, metalness: 0 }),
    pants: new THREE.MeshStandardMaterial({ color: palette === 'vanta' ? 0x33373c : cFab, roughness: 0.95, metalness: 0 }),
  };
  shared.set(palette, m);
  return m;
}

const merged = new Map<SoldierPalette, THREE.MeshStandardMaterial>();
function mergedMaterial(palette: SoldierPalette): THREE.MeshStandardMaterial {
  let m = merged.get(palette);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.1 });
    merged.set(palette, m);
  }
  return m;
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

/** Unit hood shell: a sphere with the face side cut open (+Z). */
const HOOD = new THREE.SphereGeometry(1, 14, 10, Math.PI / 2 + 0.8, Math.PI * 2 - 1.6, 0, Math.PI * 0.82);
/** Rolled rim round the face opening. */
const HOOD_RIM = new THREE.TorusGeometry(1, 0.17, 6, 14);

const THIGH = 0.44;
const SHIN = 0.46;
const UPPER = 0.29;

export function soldierSkin(health: number, palette: SoldierPalette = 'bd'): HumanoidSkin {
  const m = soldierMaterials(palette);
  // Your team wears a hooded field kit instead of helmet + NVG.
  const hooded = palette === 'vanta';
  const legs = ([-1, 1] as const).flatMap((side): PartDef[] => [
    {
      name: side === 1 ? 'thighR' : 'thighL', parent: 'pelvis', pos: [0.1 * side, -0.05, 0], side,
      build: (b) => {
        rbox(b, m.pants, [0.155, THIGH, 0.17], [0, -THIGH / 2, 0]);
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
        rbox(b, m.pants, [0.13, 0.3, 0.14], [0, -0.18, 0]);
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
        // Friendly IFF band: a thin glowing strip round the arm, readable at range.
        if (hooded) rbox(b, m.tubes, [0.106, 0.022, 0.116], [0, -0.17, 0]);
      },
      colliders: [{ half: [0.055, UPPER / 2, 0.06], center: [0, -UPPER / 2, 0], mass: 3, zone: 'arm', surface: 'flesh' }],
    },
    {
      name: side === 1 ? 'foreArmR' : 'foreArmL', parent: side === 1 ? 'upperArmR' : 'upperArmL', pos: [0, -UPPER, 0], side,
      build: (b) => {
        rbox(b, m.fabric, [0.09, 0.24, 0.1], [0, -0.12, 0]);
        rbox(b, m.glove, [0.075, 0.1, 0.09], [0, -0.29, 0.005]); // glove
        rbox(b, m.boots, [0.08, 0.03, 0.095], [0, -0.245, 0.005]); // cuff
      },
      colliders: [{ half: [0.05, 0.16, 0.055], center: [0, -0.15, 0], mass: 2, zone: 'arm', surface: 'flesh' }],
    },
  ]);

  return {
    health,
    merge: mergedMaterial(palette),
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
          if (hooded) {
            // Open jacket over the carrier, the hood folded down the back, fur trim round the collar.
            for (const s of [-1, 1]) rbox(b, m.fabric, [0.07, 0.4, 0.05], [0.15 * s, 0.24, 0.12]);
            rbox(b, m.hood, [0.25, 0.13, 0.08], [0, 0.42, -0.17]);
            for (const [x, y, z, w] of [[0, 0.5, -0.11, 0.28], [0.13, 0.49, -0.04, 0.1], [-0.13, 0.49, -0.04, 0.1], [0.06, 0.52, -0.12, 0.12]] as const) {
              rbox(b, m.fur, [w, 0.07, 0.09], [x, y, z]);
            }
          }
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
          if (hooded) {
            b.cylinder(m.mask, 0.055, 0.09, [0, 0.03, 0], [0, 0, 0], 10);
            rbox(b, m.mask, [0.185, 0.225, 0.205], [0, 0.15, 0.01]); // balaclava
            rbox(b, m.skin, [0.135, 0.04, 0.02], [0, 0.175, 0.112]); // eye slit
            for (const x of [-0.035, 0.035]) rbox(b, m.mask, [0.026, 0.014, 0.01], [x, 0.176, 0.123]); // eyes
            // Hood: a soft rounded shell, open at the face, with a rolled rim and a drape to the shoulders.
            b.add(m.hood, HOOD.clone(), [0, 0.165, -0.012], [0, 0, 0], [0.128, 0.152, 0.138]);
            b.add(m.hood, HOOD_RIM.clone(), [0, 0.168, 0.088], [0, 0, 0], [0.108, 0.13, 0.1]);
            rbox(b, m.hood, [0.25, 0.09, 0.23], [0, 0.03, -0.025]);
            return;
          }
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
        colliders: hooded
          ? [{ half: [0.115, 0.14, 0.125], center: [0, 0.16, 0], mass: 4, zone: 'head', surface: 'flesh' }]
          : [
              { half: [0.1, 0.09, 0.11], center: [0, 0.12, 0.01], mass: 3, zone: 'head', surface: 'flesh' },
              { half: [0.125, 0.065, 0.135], center: [0, 0.265, 0], mass: 2, zone: 'head', surface: 'helmet', armor: 30 },
            ],
      },
    ],
  };
}
