import * as THREE from 'three';

/**
 * Placeholder procedural weapon models with the moving parts the procedural
 * animations need (magazine, bolt/slide, pump, left hand). Swap these builders
 * for real GLTF models later; keep the same WeaponRig fields.
 *
 * Conventions: barrel points -Z, origin sits at the top of the pistol grip
 * (where the right hand is) so recoil rotation pivots around the hand.
 */
export interface WeaponRig {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  ejectPort: THREE.Object3D;
  /** ADS reference point (red dot / rear sight). Must sit on the barrel axis line of sight. */
  sight: THREE.Object3D;
  mag: THREE.Object3D | null;
  /** Rifle charging handle, pistol slide. */
  bolt: THREE.Object3D | null;
  pump: THREE.Object3D | null;
  leftHand: THREE.Object3D;
  /** Rest position of the left hand (local to its parent). */
  leftHandRest: THREE.Vector3;
  /** Shell held in hand during shotgun reloads. */
  heldShell: THREE.Object3D | null;
  shellType: 'rifle' | 'pistol' | 'shotgun';
}

const mat = {
  gunmetal: new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.85, roughness: 0.38 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x6d737b, metalness: 0.9, roughness: 0.28 }),
  polymer: new THREE.MeshStandardMaterial({ color: 0x1a1b1e, metalness: 0.1, roughness: 0.72 }),
  tan: new THREE.MeshStandardMaterial({ color: 0x8a7556, metalness: 0.05, roughness: 0.8 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.2, roughness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x5a3b24, metalness: 0.0, roughness: 0.65 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x2a2f2a, metalness: 0.0, roughness: 0.9 }),
  gloveKnuckle: new THREE.MeshStandardMaterial({ color: 0x3d4440, metalness: 0.1, roughness: 0.7 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.0, roughness: 0.95 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a046, metalness: 0.95, roughness: 0.3 }),
  shellRed: new THREE.MeshStandardMaterial({ color: 0xa11d1d, metalness: 0.1, roughness: 0.6 }),
  dot: new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }),
  dotGlow: new THREE.MeshBasicMaterial({
    color: 0xff2020,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }),
  lens: new THREE.MeshStandardMaterial({
    color: 0x88ccff,
    metalness: 0.1,
    roughness: 0.05,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  }),
  bead: new THREE.MeshBasicMaterial({ color: 0xb8ff6a, toneMapped: false }),
};

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14);

function box(
  parent: THREE.Object3D,
  material: THREE.Material,
  size: [number, number, number],
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo, material);
  m.scale.set(...size);
  m.position.set(...pos);
  m.rotation.set(...rot);
  parent.add(m);
  return m;
}

/** Cylinder aligned with Z (barrels, tubes). */
function tube(parent: THREE.Object3D, material: THREE.Material, radius: number, length: number, pos: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo, material);
  m.scale.set(radius, length, radius);
  m.rotation.x = Math.PI / 2;
  m.position.set(...pos);
  parent.add(m);
  return m;
}

function point(parent: THREE.Object3D, pos: [number, number, number]): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(...pos);
  parent.add(o);
  return o;
}

/** Blocky glove + sleeve. The forearm extends from the hand toward `elbow`. */
function hand(parent: THREE.Object3D, pos: [number, number, number], elbow: [number, number, number], size: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.position.set(...pos);
  parent.add(g);
  box(g, mat.glove, size, [0, 0, 0]);
  box(g, mat.gloveKnuckle, [size[0] * 1.02, size[1] * 0.3, size[2] * 0.5], [0, size[1] * 0.25, -size[2] * 0.2]);
  // Forearm
  const from = new THREE.Vector3(0, 0, 0);
  const to = new THREE.Vector3(...elbow).sub(new THREE.Vector3(...pos));
  const len = to.length();
  const arm = new THREE.Mesh(cylGeo, mat.sleeve);
  arm.scale.set(0.034, len, 0.034);
  arm.position.copy(from).addScaledVector(to, 0.5);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().normalize());
  g.add(arm);
  return g;
}

function buildRifle(): WeaponRig {
  const root = new THREE.Group();
  // Receiver & rail
  box(root, mat.gunmetal, [0.055, 0.075, 0.36], [0, 0.02, -0.08]);
  box(root, mat.polymer, [0.042, 0.012, 0.34], [0, 0.064, -0.1]);
  box(root, mat.accent, [0.057, 0.012, 0.08], [0, 0.0, -0.17]);
  // Handguard + barrel + muzzle brake
  box(root, mat.tan, [0.062, 0.062, 0.27], [0, 0.015, -0.39]);
  box(root, mat.polymer, [0.064, 0.008, 0.25], [0, 0.048, -0.39]);
  tube(root, mat.gunmetal, 0.012, 0.2, [0, 0.022, -0.61]);
  tube(root, mat.steel, 0.019, 0.055, [0, 0.022, -0.72]);
  // Stock & grip
  box(root, mat.tan, [0.046, 0.072, 0.22], [0, 0.0, 0.2]);
  box(root, mat.polymer, [0.05, 0.085, 0.02], [0, -0.004, 0.315]);
  box(root, mat.polymer, [0.036, 0.095, 0.046], [0, -0.065, 0.025], [0.28, 0, 0]);
  box(root, mat.polymer, [0.01, 0.03, 0.04], [0, -0.03, -0.03]); // trigger guard

  // Magazine (pivot at the magwell)
  const mag = new THREE.Group();
  mag.position.set(0, -0.02, -0.15);
  root.add(mag);
  box(mag, mat.polymer, [0.032, 0.15, 0.07], [0, -0.07, -0.005], [0.16, 0, 0]);
  box(mag, mat.accent, [0.034, 0.012, 0.074], [0, -0.14, -0.016], [0.16, 0, 0]);

  // Charging handle (bolt) on the right side
  const bolt = new THREE.Group();
  bolt.position.set(0.032, 0.035, -0.02);
  root.add(bolt);
  box(bolt, mat.steel, [0.016, 0.014, 0.03], [0.006, 0, 0]);

  // Red dot on a tall mount: thin open frame so it never blocks the view.
  const sightZ = -0.07;
  const sightY = 0.112;
  box(root, mat.polymer, [0.03, 0.026, 0.05], [0, 0.082, sightZ]);
  box(root, mat.polymer, [0.004, 0.036, 0.022], [0.019, sightY, sightZ - 0.01]);
  box(root, mat.polymer, [0.004, 0.036, 0.022], [-0.019, sightY, sightZ - 0.01]);
  box(root, mat.polymer, [0.042, 0.004, 0.022], [0, sightY + 0.019, sightZ - 0.01]);
  box(root, mat.polymer, [0.042, 0.004, 0.022], [0, sightY - 0.019, sightZ - 0.01]);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.034), mat.lens);
  lens.position.set(0, sightY, sightZ - 0.02);
  root.add(lens);
  // Reticle: a small emissive disc + soft glow, always facing the eye when aimed.
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0014, 12), mat.dot);
  dot.position.set(0, sightY, sightZ - 0.022);
  root.add(dot);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 16), mat.dotGlow);
  glow.position.set(0, sightY, sightZ - 0.0215);
  root.add(glow);
  const sight = point(root, [0, sightY, sightZ - 0.022]);

  hand(root, [0.0, -0.06, 0.035], [0.1, -0.25, 0.38], [0.05, 0.085, 0.085]);
  const leftHand = hand(root, [-0.005, -0.03, -0.42], [-0.22, -0.26, -0.1], [0.055, 0.05, 0.1]);

  return {
    root,
    muzzle: point(root, [0, 0.022, -0.755]),
    ejectPort: point(root, [0.03, 0.035, -0.06]),
    sight,
    mag,
    bolt,
    pump: null,
    leftHand,
    leftHandRest: leftHand.position.clone(),
    heldShell: null,
    shellType: 'rifle',
  };
}

function buildPistol(): WeaponRig {
  const root = new THREE.Group();
  // Frame
  box(root, mat.polymer, [0.032, 0.028, 0.19], [0, 0.002, -0.075]);
  box(root, mat.polymer, [0.032, 0.11, 0.05], [0, -0.058, 0.01], [0.3, 0, 0]);
  box(root, mat.polymer, [0.008, 0.026, 0.05], [0, -0.022, -0.045]); // trigger guard
  tube(root, mat.steel, 0.009, 0.03, [0, 0.03, -0.185]);
  box(root, mat.accent, [0.034, 0.01, 0.02], [0, -0.005, -0.155]);

  // Slide (moves back on every shot, locks back on empty)
  const slide = new THREE.Group();
  root.add(slide);
  box(slide, mat.gunmetal, [0.036, 0.034, 0.21], [0, 0.032, -0.075]);
  box(slide, mat.steel, [0.037, 0.012, 0.03], [0, 0.03, 0.0]); // serrations
  // Rear notch + front post (both on the sight line y = 0.06), with bright dots
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

  // Magazine
  const mag = new THREE.Group();
  mag.position.set(0, -0.03, 0.0);
  root.add(mag);
  box(mag, mat.gunmetal, [0.026, 0.09, 0.04], [0, -0.035, 0.008], [0.3, 0, 0]);
  box(mag, mat.polymer, [0.03, 0.012, 0.05], [0, -0.084, 0.024], [0.3, 0, 0]);

  hand(root, [0.0, -0.06, 0.025], [0.08, -0.24, 0.36], [0.05, 0.09, 0.08]);
  const leftHand = hand(root, [-0.025, -0.075, 0.015], [-0.18, -0.25, 0.32], [0.05, 0.075, 0.08]);

  return {
    root,
    muzzle: point(root, [0, 0.03, -0.205]),
    ejectPort: point(root, [0.02, 0.045, -0.05]),
    sight: point(root, [0, 0.06, 0.02]),
    mag,
    bolt: slide,
    pump: null,
    leftHand,
    leftHandRest: leftHand.position.clone(),
    heldShell: null,
    shellType: 'pistol',
  };
}

function buildShotgun(): WeaponRig {
  const root = new THREE.Group();
  box(root, mat.gunmetal, [0.05, 0.072, 0.24], [0, 0.022, -0.05]);
  box(root, mat.accent, [0.052, 0.01, 0.05], [0, 0.0, -0.11]);
  tube(root, mat.gunmetal, 0.015, 0.52, [0, 0.042, -0.43]);
  tube(root, mat.gunmetal, 0.012, 0.4, [0, 0.008, -0.38]);
  box(root, mat.wood, [0.046, 0.085, 0.27], [0, -0.012, 0.21], [-0.06, 0, 0]);
  box(root, mat.polymer, [0.05, 0.095, 0.02], [0, -0.02, 0.345]);
  box(root, mat.wood, [0.036, 0.09, 0.046], [0, -0.06, 0.04], [0.3, 0, 0]);
  box(root, mat.polymer, [0.008, 0.026, 0.05], [0, -0.022, -0.02]);
  // Bead front sight + rear groove, both on y = 0.064
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 10, 8), mat.bead);
  bead.position.set(0, 0.064, -0.68);
  root.add(bead);
  box(root, mat.polymer, [0.02, 0.006, 0.03], [0, 0.06, 0.0]);

  // Pump forend, with the left hand riding on it
  const pump = new THREE.Group();
  pump.position.set(0, 0.008, -0.37);
  root.add(pump);
  box(pump, mat.wood, [0.052, 0.046, 0.17], [0, 0, 0]);
  for (let i = 0; i < 5; i++) box(pump, mat.polymer, [0.054, 0.048, 0.006], [0, 0, -0.06 + i * 0.03]);
  const leftHand = hand(pump, [-0.006, -0.028, -0.01], [-0.22, -0.26, 0.24], [0.056, 0.05, 0.1]);

  hand(root, [0.0, -0.058, 0.05], [0.1, -0.25, 0.4], [0.05, 0.09, 0.085]);

  // Shell held during reload (child of the left hand).
  const heldShell = new THREE.Group();
  tube(heldShell, mat.shellRed, 0.0095, 0.055, [0, 0, 0]);
  tube(heldShell, mat.brass, 0.01, 0.014, [0, 0, 0.032]);
  heldShell.position.set(0.0, 0.03, 0.0);
  heldShell.visible = false;
  leftHand.add(heldShell);

  return {
    root,
    muzzle: point(root, [0, 0.042, -0.7]),
    ejectPort: point(root, [0.028, 0.035, -0.05]),
    sight: point(root, [0, 0.064, 0.0]),
    mag: null,
    bolt: null,
    pump,
    leftHand,
    leftHandRest: leftHand.position.clone(),
    heldShell,
    shellType: 'shotgun',
  };
}

export function buildWeaponModel(model: 'rifle' | 'pistol' | 'shotgun'): WeaponRig {
  const rig = model === 'rifle' ? buildRifle() : model === 'pistol' ? buildPistol() : buildShotgun();
  rig.root.traverse((o) => {
    o.frustumCulled = false;
  });
  return rig;
}

/** Shared materials for ejected shells (world space). */
export const shellMaterials = { brass: mat.brass, red: mat.shellRed };
