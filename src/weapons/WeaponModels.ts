import * as THREE from 'three';
import type { ModelKey } from './WeaponData';

/**
 * Placeholder procedural weapon models with the moving parts the procedural
 * animations need (magazine, bolt/slide, pump, left hand). Proportions follow
 * the real overall lengths (handling.length), because length now matters for
 * handling and wall collision. Swap for GLTF models later; keep the WeaponRig fields.
 *
 * Conventions: barrel points -Z, origin sits at the top of the pistol grip
 * (where the right hand is). `butt` is where the stock meets the shoulder.
 */
export interface WeaponRig {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  ejectPort: THREE.Object3D;
  /** ADS reference point (red dot / rear sight). Must sit on the line of sight. */
  sight: THREE.Object3D;
  mag: THREE.Object3D | null;
  /** Charging handle / slide. */
  bolt: THREE.Object3D | null;
  pump: THREE.Object3D | null;
  leftHand: THREE.Object3D;
  /** Rest position of the left hand (local to its parent). */
  leftHandRest: THREE.Vector3;
  /** Shell held in hand during shotgun reloads. */
  heldShell: THREE.Object3D | null;
  /** Test laser emitter; the beam runs parallel to the bore. */
  laser: THREE.Object3D;
  /** Stock/shoulder contact point: recoil rotates the weapon around it. */
  butt: THREE.Vector3;
  shellType: 'rifle' | 'pistol' | 'shotgun';
}

const std = (color: number, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color, metalness, roughness });

const mat = {
  gunmetal: std(0x2b2e33, 0.85, 0.38),
  blued: std(0x1f2226, 0.9, 0.32),
  steel: std(0x6d737b, 0.9, 0.28),
  polymer: std(0x1a1b1e, 0.1, 0.72),
  black: std(0x141517, 0.2, 0.6),
  tan: std(0x8a7556, 0.05, 0.8),
  accent: std(0xff7a1a, 0.2, 0.5),
  wood: std(0x6a3f22, 0.0, 0.6),
  woodDark: std(0x4a2b17, 0.0, 0.65),
  bakelite: std(0x5a2416, 0.05, 0.55),
  glove: std(0x2a2f2a, 0.0, 0.9),
  gloveKnuckle: std(0x3d4440, 0.1, 0.7),
  sleeve: std(0x3a3f47, 0.0, 0.95),
  brass: std(0xc9a046, 0.95, 0.3),
  shellRed: std(0xa11d1d, 0.1, 0.6),
  dot: new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }),
  dotGlow: new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  lens: new THREE.MeshStandardMaterial({ color: 0x88ccff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.12, depthWrite: false }),
  bead: new THREE.MeshBasicMaterial({ color: 0xb8ff6a, toneMapped: false }),
};

type V3 = [number, number, number];
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14);

function box(parent: THREE.Object3D, material: THREE.Material, size: V3, pos: V3, rot: V3 = [0, 0, 0]): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo, material);
  m.scale.set(...size);
  m.position.set(...pos);
  m.rotation.set(...rot);
  parent.add(m);
  return m;
}

/** Cylinder aligned with Z (barrels, tubes). */
function tube(parent: THREE.Object3D, material: THREE.Material, radius: number, length: number, pos: V3): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo, material);
  m.scale.set(radius, length, radius);
  m.rotation.x = Math.PI / 2;
  m.position.set(...pos);
  parent.add(m);
  return m;
}

function point(parent: THREE.Object3D, pos: V3): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(...pos);
  parent.add(o);
  return o;
}

function group(parent: THREE.Object3D, pos: V3): THREE.Group {
  const g = new THREE.Group();
  g.position.set(...pos);
  parent.add(g);
  return g;
}

/** Blocky glove + sleeve. The forearm extends from the hand toward `elbow`. */
function hand(parent: THREE.Object3D, pos: V3, elbow: V3, size: V3): THREE.Group {
  const g = group(parent, pos);
  box(g, mat.glove, size, [0, 0, 0]);
  box(g, mat.gloveKnuckle, [size[0] * 1.02, size[1] * 0.3, size[2] * 0.5], [0, size[1] * 0.25, -size[2] * 0.2]);
  const to = new THREE.Vector3(...elbow).sub(new THREE.Vector3(...pos));
  const len = to.length();
  const arm = new THREE.Mesh(cylGeo, mat.sleeve);
  arm.scale.set(0.034, len, 0.034);
  arm.position.copy(to).multiplyScalar(0.5);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().normalize());
  g.add(arm);
  return g;
}

/** Tube-style red dot on a rail. Returns the sight point (the dot). */
function redDot(root: THREE.Object3D, z: number, railTop: number): THREE.Object3D {
  const y = railTop + 0.04;
  box(root, mat.polymer, [0.03, 0.026, 0.05], [0, railTop + 0.013, z]);
  box(root, mat.polymer, [0.004, 0.036, 0.022], [0.019, y, z - 0.01]);
  box(root, mat.polymer, [0.004, 0.036, 0.022], [-0.019, y, z - 0.01]);
  box(root, mat.polymer, [0.042, 0.004, 0.022], [0, y + 0.019, z - 0.01]);
  box(root, mat.polymer, [0.042, 0.004, 0.022], [0, y - 0.019, z - 0.01]);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.034), mat.lens);
  lens.position.set(0, y, z - 0.02);
  root.add(lens);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0014, 12), mat.dot);
  dot.position.set(0, y, z - 0.022);
  root.add(dot);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 16), mat.dotGlow);
  glow.position.set(0, y, z - 0.0215);
  root.add(glow);
  return point(root, [0, y, z - 0.022]);
}

/** Rear notch (two posts). `line` = height of the sight line. Returns the sight point. */
function ironRear(root: THREE.Object3D, z: number, line: number): THREE.Object3D {
  box(root, mat.blued, [0.03, 0.006, 0.014], [0, line - 0.009, z]);
  box(root, mat.blued, [0.009, 0.014, 0.008], [0.0085, line - 0.004, z]);
  box(root, mat.blued, [0.009, 0.014, 0.008], [-0.0085, line - 0.004, z]);
  return point(root, [0, line, z]);
}

/** Front post (with protective ears) whose tip sits on the sight line. */
function ironFront(root: THREE.Object3D, z: number, line: number, base: number): void {
  const h = line - base;
  box(root, mat.blued, [0.004, h, 0.005], [0, base + h / 2, z]);
  box(root, mat.blued, [0.003, h + 0.006, 0.01], [0.011, base + (h + 0.006) / 2, z]);
  box(root, mat.blued, [0.003, h + 0.006, 0.01], [-0.011, base + (h + 0.006) / 2, z]);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0016, 8), mat.bead);
  dot.position.set(0, line - 0.0012, z + 0.0026);
  root.add(dot);
}

/** Curved magazine made of rotated segments (AK-style). */
function curvedMag(parent: THREE.Object3D, material: THREE.Material, segs: number, width: number, depth: number, curve: number): void {
  let y = 0;
  let z = 0;
  for (let i = 0; i < segs; i++) {
    const a = 0.08 + i * curve;
    const h = 0.055;
    box(parent, material, [width, h, depth], [0, y - h / 2, z], [a, 0, 0]);
    y -= h * Math.cos(a) * 0.95;
    z -= h * Math.sin(a) * 0.95;
  }
}

function rig(
  root: THREE.Group,
  parts: Omit<WeaponRig, 'root' | 'leftHandRest' | 'butt'> & { butt: V3 },
): WeaponRig {
  return { ...parts, root, leftHandRest: parts.leftHand.position.clone(), butt: new THREE.Vector3(...parts.butt) };
}

// ------------------------------------------------------------------ rifles

/** AK-47: wood furniture, curved bakelite mag, irons on the receiver. 0.88 m. */
function buildAK47(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.blued, [0.05, 0.072, 0.28], [0, 0.025, -0.06]);
  box(R, mat.blued, [0.052, 0.022, 0.22], [0, 0.07, -0.04]);
  box(R, mat.blued, [0.04, 0.026, 0.05], [0, 0.072, -0.18]);
  const sight = ironRear(R, -0.2, 0.096);
  tube(R, mat.blued, 0.012, 0.17, [0, 0.068, -0.295]);
  box(R, mat.wood, [0.044, 0.03, 0.15], [0, 0.072, -0.29]);
  box(R, mat.wood, [0.058, 0.056, 0.2], [0, 0.02, -0.3]);
  tube(R, mat.blued, 0.011, 0.13, [0, 0.03, -0.465]);
  box(R, mat.blued, [0.026, 0.05, 0.03], [0, 0.055, -0.5]);
  ironFront(R, -0.505, 0.096, 0.08);
  tube(R, mat.blued, 0.015, 0.04, [0, 0.03, -0.53]);
  box(R, mat.wood, [0.044, 0.072, 0.24], [0, -0.012, 0.2], [-0.09, 0, 0]);
  box(R, mat.blued, [0.048, 0.088, 0.012], [0, -0.024, 0.322]);
  box(R, mat.bakelite, [0.034, 0.09, 0.045], [0, -0.065, 0.03], [0.3, 0, 0]);
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.022, -0.03]);
  box(R, mat.steel, [0.004, 0.02, 0.1], [0.027, 0.04, -0.05]);
  const mag = group(R, [0, -0.012, -0.12]);
  curvedMag(mag, mat.bakelite, 4, 0.03, 0.068, 0.12);
  const bolt = group(R, [0.032, 0.04, -0.1]);
  box(bolt, mat.steel, [0.022, 0.012, 0.03], [0.008, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.038, 0.012, -0.34]);
  hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.022, -0.31], [-0.22, -0.26, -0.02], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.55]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.038, 0.012, -0.366]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'rifle',
    butt: [0, -0.024, 0.32],
  });
}

/** M4A1: flat-top AR, quad rail, red dot, collapsible stock. 0.84 m. */
function buildM4A1(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.black, [0.046, 0.06, 0.22], [0, 0.0, -0.05]);
  box(R, mat.black, [0.04, 0.04, 0.075], [0, -0.035, -0.11]);
  box(R, mat.gunmetal, [0.05, 0.055, 0.26], [0, 0.055, -0.07]);
  box(R, mat.black, [0.04, 0.012, 0.48], [0, 0.088, -0.19]);
  box(R, mat.black, [0.062, 0.062, 0.23], [0, 0.05, -0.315]);
  for (let i = 0; i < 6; i++) box(R, mat.gunmetal, [0.064, 0.004, 0.012], [0, 0.05, -0.215 - i * 0.04]);
  tube(R, mat.blued, 0.0105, 0.07, [0, 0.05, -0.465]);
  box(R, mat.blued, [0.026, 0.026, 0.02], [0, 0.058, -0.445]);
  tube(R, mat.steel, 0.012, 0.035, [0, 0.05, -0.513]);
  tube(R, mat.gunmetal, 0.015, 0.18, [0, 0.055, 0.15]);
  box(R, mat.black, [0.044, 0.07, 0.12], [0, 0.035, 0.245]);
  box(R, mat.polymer, [0.046, 0.085, 0.015], [0, 0.03, 0.31]);
  box(R, mat.black, [0.034, 0.085, 0.045], [0, -0.058, 0.025], [0.32, 0, 0]);
  box(R, mat.black, [0.008, 0.026, 0.05], [0, -0.026, -0.03]);
  const sight = redDot(R, -0.07, 0.094);
  const mag = group(R, [0, -0.03, -0.11]);
  curvedMag(mag, mat.black, 3, 0.026, 0.064, 0.06);
  const bolt = group(R, [0, 0.072, 0.05]);
  box(bolt, mat.steel, [0.035, 0.01, 0.02], [0, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.036, 0.05, -0.36]);
  hand(R, [0, -0.058, 0.03], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.005, -0.33], [-0.22, -0.24, -0.04], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.05, -0.53]),
    ejectPort: point(R, [0.028, 0.055, -0.06]),
    laser: point(R, [0.036, 0.05, -0.386]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.03, 0.31],
  });
}

/** MK47 Mutant: AR-style upper/lower that takes AK magazines, red dot, big brake. 0.85 m. */
function buildMK47(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.black, [0.048, 0.062, 0.22], [0, 0.0, -0.05]);
  box(R, mat.gunmetal, [0.052, 0.056, 0.25], [0, 0.056, -0.07]);
  box(R, mat.black, [0.04, 0.012, 0.46], [0, 0.09, -0.18]);
  box(R, mat.tan, [0.064, 0.06, 0.22], [0, 0.05, -0.31]);
  tube(R, mat.blued, 0.012, 0.08, [0, 0.05, -0.46]);
  box(R, mat.gunmetal, [0.03, 0.03, 0.045], [0, 0.05, -0.52]);
  box(R, mat.tan, [0.046, 0.082, 0.17], [0, 0.03, 0.235]);
  box(R, mat.polymer, [0.048, 0.09, 0.012], [0, 0.028, 0.31]);
  box(R, mat.black, [0.034, 0.085, 0.045], [0, -0.058, 0.025], [0.3, 0, 0]);
  box(R, mat.black, [0.008, 0.026, 0.05], [0, -0.026, -0.03]);
  const sight = redDot(R, -0.08, 0.096);
  const mag = group(R, [0, -0.03, -0.11]);
  curvedMag(mag, mat.black, 4, 0.03, 0.068, 0.12);
  const bolt = group(R, [0, 0.073, 0.05]);
  box(bolt, mat.steel, [0.035, 0.01, 0.02], [0, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.038, 0.05, -0.36]);
  hand(R, [0, -0.058, 0.03], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.005, -0.32], [-0.22, -0.24, -0.04], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.05, -0.543]),
    ejectPort: point(R, [0.029, 0.056, -0.06]),
    laser: point(R, [0.038, 0.05, -0.386]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.028, 0.31],
  });
}

/** AS VAL: integral suppressor, skeleton stock, 20-round mag, irons. 0.875 m. */
function buildASVAL(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.blued, [0.044, 0.068, 0.24], [0, 0.02, -0.05]);
  box(R, mat.blued, [0.046, 0.02, 0.2], [0, 0.062, -0.04]);
  box(R, mat.blued, [0.032, 0.02, 0.04], [0, 0.078, -0.12]);
  const sight = ironRear(R, -0.13, 0.1);
  tube(R, mat.black, 0.023, 0.425, [0, 0.03, -0.3625]);
  for (let i = 0; i < 3; i++) tube(R, mat.gunmetal, 0.0235, 0.008, [0, 0.03, -0.2 - i * 0.14]);
  box(R, mat.polymer, [0.054, 0.05, 0.17], [0, -0.004, -0.255]);
  box(R, mat.black, [0.016, 0.03, 0.02], [0, 0.062, -0.545]);
  ironFront(R, -0.55, 0.1, 0.075);
  tube(R, mat.gunmetal, 0.007, 0.24, [0, 0.042, 0.17]);
  tube(R, mat.gunmetal, 0.007, 0.24, [0, -0.025, 0.17]);
  box(R, mat.polymer, [0.042, 0.095, 0.014], [0, 0.008, 0.295]);
  box(R, mat.polymer, [0.033, 0.088, 0.044], [0, -0.062, 0.03], [0.3, 0, 0]);
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.024, -0.03]);
  const mag = group(R, [0, -0.015, -0.11]);
  curvedMag(mag, mat.blued, 3, 0.028, 0.06, 0.12);
  const bolt = group(R, [0.03, 0.032, -0.04]);
  box(bolt, mat.steel, [0.02, 0.012, 0.025], [0.006, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.034, 0.0, -0.3]);
  hand(R, [0, -0.062, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.032, -0.27], [-0.22, -0.26, 0.0], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.577]),
    ejectPort: point(R, [0.027, 0.035, -0.05]),
    laser: point(R, [0.034, 0.0, -0.326]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.008, 0.3],
  });
}

/** PPSh-41: full wooden stock, perforated barrel shroud, 71-round drum. 0.843 m. */
function buildPPSh(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.woodDark, [0.05, 0.068, 0.27], [0, -0.03, 0.195], [-0.12, 0, 0]);
  box(R, mat.woodDark, [0.042, 0.05, 0.1], [0, -0.022, 0.01]);
  box(R, mat.woodDark, [0.05, 0.048, 0.16], [0, 0.002, -0.12]);
  box(R, mat.blued, [0.054, 0.085, 0.01], [0, -0.05, 0.33]);
  box(R, mat.blued, [0.048, 0.052, 0.18], [0, 0.042, -0.09]);
  tube(R, mat.blued, 0.02, 0.3, [0, 0.05, -0.33]);
  for (let i = 0; i < 6; i++) box(R, mat.polymer, [0.043, 0.012, 0.022], [0, 0.05, -0.21 - i * 0.045]);
  box(R, mat.blued, [0.044, 0.04, 0.02], [0, 0.05, -0.49], [-0.4, 0, 0]);
  box(R, mat.blued, [0.022, 0.02, 0.03], [0, 0.072, -0.02]);
  const sight = ironRear(R, -0.025, 0.093);
  ironFront(R, -0.47, 0.093, 0.068);
  box(R, mat.blued, [0.008, 0.024, 0.05], [0, -0.03, -0.03]);
  const mag = group(R, [0, -0.005, -0.12]);
  box(mag, mat.blued, [0.03, 0.03, 0.04], [0, -0.012, 0]);
  const drum = new THREE.Mesh(cylGeo, mat.blued);
  drum.scale.set(0.072, 0.048, 0.072);
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0, -0.085, -0.01);
  mag.add(drum);
  tube(mag, mat.gunmetal, 0.074, 0.006, [0, -0.085, -0.01]).rotation.set(0, 0, Math.PI / 2);
  const bolt = group(R, [0.028, 0.048, -0.12]);
  box(bolt, mat.steel, [0.016, 0.01, 0.02], [0.004, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.03, 0.04, -0.3]);
  hand(R, [0, -0.04, 0.03], [0.1, -0.25, 0.36], [0.05, 0.08, 0.085]);
  const leftHand = hand(R, [-0.005, -0.012, -0.24], [-0.22, -0.26, 0.02], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.045, -0.51]),
    ejectPort: point(R, [0.02, 0.068, -0.11]),
    laser: point(R, [0.03, 0.04, -0.326]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'pistol',
    butt: [0, -0.05, 0.33],
  });
}

/** RD-704: heavy AK-pattern rifle, long rail, folding stock, red dot. 0.95 m. */
function buildRD704(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.black, [0.05, 0.074, 0.28], [0, 0.025, -0.06]);
  box(R, mat.gunmetal, [0.052, 0.022, 0.22], [0, 0.071, -0.04]);
  box(R, mat.black, [0.036, 0.012, 0.55], [0, 0.088, -0.22]);
  box(R, mat.black, [0.066, 0.066, 0.3], [0, 0.045, -0.35]);
  for (let i = 0; i < 5; i++) box(R, mat.gunmetal, [0.068, 0.012, 0.03], [0, 0.04, -0.24 - i * 0.055]);
  tube(R, mat.blued, 0.012, 0.08, [0, 0.035, -0.54]);
  box(R, mat.gunmetal, [0.034, 0.034, 0.05], [0, 0.035, -0.6]);
  box(R, mat.black, [0.038, 0.085, 0.2], [0, 0.02, 0.22]);
  box(R, mat.polymer, [0.046, 0.1, 0.016], [0, 0.015, 0.33]);
  box(R, mat.black, [0.034, 0.09, 0.045], [0, -0.065, 0.03], [0.3, 0, 0]);
  box(R, mat.black, [0.008, 0.026, 0.05], [0, -0.022, -0.03]);
  box(R, mat.steel, [0.004, 0.02, 0.1], [0.027, 0.04, -0.05]);
  const sight = redDot(R, -0.06, 0.094);
  const mag = group(R, [0, -0.012, -0.12]);
  curvedMag(mag, mat.black, 4, 0.03, 0.068, 0.12);
  const bolt = group(R, [0.032, 0.04, -0.1]);
  box(bolt, mat.steel, [0.022, 0.012, 0.03], [0.008, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.04, 0.045, -0.42]);
  hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.0, -0.4], [-0.22, -0.24, -0.08], [0.056, 0.052, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.035, -0.625]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.04, 0.045, -0.446]),
    sight, mag, bolt, pump: null, leftHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.015, 0.33],
  });
}

// ------------------------------------------------------------------ pistol / shotgun

function buildPistol(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.polymer, [0.032, 0.028, 0.19], [0, 0.002, -0.075]);
  box(R, mat.polymer, [0.032, 0.11, 0.05], [0, -0.058, 0.01], [0.3, 0, 0]);
  box(R, mat.polymer, [0.008, 0.026, 0.05], [0, -0.022, -0.045]);
  tube(R, mat.steel, 0.009, 0.03, [0, 0.03, -0.185]);
  box(R, mat.accent, [0.034, 0.01, 0.02], [0, -0.005, -0.155]);
  // Slide (moves back on every shot, locks back on empty) with bright 3-dot sights.
  const slide = group(R, [0, 0, 0]);
  box(slide, mat.gunmetal, [0.036, 0.034, 0.21], [0, 0.032, -0.075]);
  box(slide, mat.steel, [0.037, 0.012, 0.03], [0, 0.03, 0.0]);
  box(slide, mat.polymer, [0.009, 0.016, 0.008], [0.0095, 0.054, 0.02]);
  box(slide, mat.polymer, [0.009, 0.016, 0.008], [-0.0095, 0.054, 0.02]);
  box(slide, mat.polymer, [0.0055, 0.016, 0.006], [0, 0.053, -0.17]);
  const frontDot = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 10), mat.bead);
  frontDot.position.set(0, 0.0575, -0.1665);
  slide.add(frontDot);
  for (const x of [0.0095, -0.0095]) {
    const rearDot = new THREE.Mesh(new THREE.CircleGeometry(0.0018, 8), mat.bead);
    rearDot.position.set(x, 0.0565, 0.0242);
    slide.add(rearDot);
  }
  const mag = group(R, [0, -0.03, 0.0]);
  box(mag, mat.gunmetal, [0.026, 0.09, 0.04], [0, -0.035, 0.008], [0.3, 0, 0]);
  box(mag, mat.polymer, [0.03, 0.012, 0.05], [0, -0.084, 0.024], [0.3, 0, 0]);
  hand(R, [0, -0.06, 0.025], [0.08, -0.24, 0.36], [0.05, 0.09, 0.08]);
  const leftHand = hand(R, [-0.025, -0.075, 0.015], [-0.18, -0.25, 0.32], [0.05, 0.075, 0.08]);
  box(R, mat.polymer, [0.026, 0.02, 0.05], [0, -0.022, -0.13]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.205]),
    ejectPort: point(R, [0.02, 0.045, -0.05]),
    laser: point(R, [0, -0.022, -0.156]),
    sight: point(R, [0, 0.06, 0.02]),
    mag, bolt: slide, pump: null, leftHand, heldShell: null, shellType: 'pistol',
    // Pistols have no stock: recoil pivots around the wrists.
    butt: [0, -0.06, 0.06],
  });
}

function buildShotgun(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.gunmetal, [0.05, 0.072, 0.24], [0, 0.022, -0.05]);
  box(R, mat.accent, [0.052, 0.01, 0.05], [0, 0.0, -0.11]);
  tube(R, mat.gunmetal, 0.015, 0.52, [0, 0.042, -0.43]);
  tube(R, mat.gunmetal, 0.012, 0.4, [0, 0.008, -0.38]);
  box(R, mat.wood, [0.046, 0.085, 0.27], [0, -0.012, 0.21], [-0.06, 0, 0]);
  box(R, mat.polymer, [0.05, 0.095, 0.02], [0, -0.02, 0.345]);
  box(R, mat.wood, [0.036, 0.09, 0.046], [0, -0.06, 0.04], [0.3, 0, 0]);
  box(R, mat.polymer, [0.008, 0.026, 0.05], [0, -0.022, -0.02]);
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 10, 8), mat.bead);
  bead.position.set(0, 0.064, -0.68);
  R.add(bead);
  box(R, mat.polymer, [0.02, 0.006, 0.03], [0, 0.06, 0.0]);
  const pump = group(R, [0, 0.008, -0.37]);
  box(pump, mat.wood, [0.052, 0.046, 0.17], [0, 0, 0]);
  for (let i = 0; i < 5; i++) box(pump, mat.polymer, [0.054, 0.048, 0.006], [0, 0, -0.06 + i * 0.03]);
  const leftHand = hand(pump, [-0.006, -0.028, -0.01], [-0.22, -0.26, 0.24], [0.056, 0.05, 0.1]);
  hand(R, [0, -0.058, 0.05], [0.1, -0.25, 0.4], [0.05, 0.09, 0.085]);
  const heldShell = group(leftHand, [0, 0.03, 0]);
  tube(heldShell, mat.shellRed, 0.0095, 0.055, [0, 0, 0]);
  tube(heldShell, mat.brass, 0.01, 0.014, [0, 0, 0.032]);
  heldShell.visible = false;
  box(R, mat.polymer, [0.024, 0.022, 0.05], [0, -0.012, -0.6]);
  return rig(R, {
    muzzle: point(R, [0, 0.042, -0.7]),
    ejectPort: point(R, [0.028, 0.035, -0.05]),
    laser: point(R, [0, -0.012, -0.626]),
    sight: point(R, [0, 0.064, 0.0]),
    mag: null, bolt: null, pump, leftHand, heldShell, shellType: 'shotgun',
    butt: [0, -0.02, 0.345],
  });
}

const BUILDERS: Record<ModelKey, () => WeaponRig> = {
  ak47: buildAK47,
  mk47: buildMK47,
  asval: buildASVAL,
  m4a1: buildM4A1,
  rd704: buildRD704,
  ppsh: buildPPSh,
  pistol: buildPistol,
  shotgun: buildShotgun,
};

export function buildWeaponModel(model: ModelKey): WeaponRig {
  const r = BUILDERS[model]();
  r.root.traverse((o) => {
    o.frustumCulled = false;
  });
  return r;
}

/** Shared materials for ejected shells (world space). */
export const shellMaterials = { brass: mat.brass, red: mat.shellRed };
