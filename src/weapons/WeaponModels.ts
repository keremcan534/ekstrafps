import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelKey } from './WeaponData';
import { metalRoughness, metalTexture, polymerTexture, woodTexture } from '../fx/Textures';
import { dressRig } from './WeaponMeshes';

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
  /** Right (trigger) hand: works the bolt on bolt actions. */
  rightHand: THREE.Object3D;
  rightHandRest: THREE.Vector3;
  /** Round/shell held in hand during single-round reloads. */
  heldShell: THREE.Object3D | null;
  /** Test laser emitter; the beam runs parallel to the bore. */
  laser: THREE.Object3D;
  /** Stock/shoulder contact point: recoil rotates the weapon around it. */
  butt: THREE.Vector3;
  shellType: 'rifle' | 'pistol' | 'shotgun';
}

const std = (color: number, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
/** Worn metal: speckle + brushing + scratches, scratches are shinier. */
const metal = (color: number, metalness: number, roughness: number) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, map: metalTexture(), roughnessMap: metalRoughness() });
/** Wood with grain along the stock. */
const wood = (color: number, roughness = 0.55) => new THREE.MeshStandardMaterial({ color, metalness: 0, roughness, map: woodTexture() });
/** Stippled polymer / painted finish. */
const poly = (color: number, roughness: number, metalness = 0.1) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, map: polymerTexture() });

const mat = {
  gunmetal: metal(0x3a3e45, 0.85, 0.42),
  blued: metal(0x262a30, 0.9, 0.36),
  steel: metal(0x8a9099, 0.9, 0.3),
  polymer: poly(0x222327, 0.72),
  black: poly(0x1a1b1e, 0.6, 0.2),
  tan: poly(0x9a8462, 0.8, 0.05),
  accent: std(0xff7a1a, 0.2, 0.5),
  wood: wood(0x9a5a2e),
  woodDark: wood(0x6a3c20, 0.6),
  woodMosin: wood(0xa04f22, 0.45),
  woodKar: wood(0x5c3520, 0.5),
  bakelite: poly(0x6a2a18, 0.45, 0.05),
  glove: poly(0x2e342e, 0.9, 0),
  gloveKnuckle: poly(0x434b46, 0.7, 0.1),
  sleeve: poly(0x3e444d, 0.95, 0),
  brass: std(0xc9a046, 0.95, 0.3),
  shellRed: std(0xa11d1d, 0.1, 0.6),
  dot: new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }),
  dotGlow: new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  lens: new THREE.MeshStandardMaterial({ color: 0x88ccff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.12, depthWrite: false }),
  bead: new THREE.MeshBasicMaterial({ color: 0xb8ff6a, toneMapped: false }),
  akWood: wood(0x8c4b1e, 0.55),
  akGrip: poly(0x5c2216, 0.5, 0.05),
  parkerized: metal(0x2f3236, 0.75, 0.55),
  rubber: poly(0x141516, 0.95, 0),
  reticle: new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false, side: THREE.DoubleSide }),
  holoGlass: new THREE.MeshStandardMaterial({ color: 0xffd9a0, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.06, depthWrite: false }),
  darkHole: std(0x060607, 0.2, 0.9),
  olive: poly(0x4b4f38, 0.92, 0),
};

type V3 = [number, number, number];
const cylHi = new THREE.CylinderGeometry(1, 1, 1, 18);
const cylLo = new THREE.CylinderGeometry(1, 1, 1, 6);
const sphereGeo = new THREE.SphereGeometry(1, 8, 6);
const torusHi = new THREE.TorusGeometry(1, 0.22, 6, 18);
const torusLo = new THREE.TorusGeometry(1, 0.22, 3, 6);

/**
 * Low-detail build (third-person weapons on phones): plain boxes, 6-sided
 * cylinders, no rivets / rail teeth / slots / sling loops. Set only while a
 * builder runs (buildWeaponModel(model, true)).
 */
let LOW = false;
const cyl = () => (LOW ? cylLo : cylHi);
const torus = () => (LOW ? torusLo : torusHi);

/**
 * Rounded boxes (no sharp CG edges) with UVs projected in metres, so textures
 * keep the same scale on every part. Cached per size.
 */
const boxCache = new Map<string, THREE.BufferGeometry>();
function roundedBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `${LOW ? 'L' : ''}${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`;
  let g = boxCache.get(key);
  if (!g) {
    const radius = Math.min(Math.min(w, h, d) * 0.22, 0.008);
    g = LOW ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 2, radius);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const k = 6; // 1 texture repeat ≈ 16 cm
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i));
      const ny = Math.abs(nor.getY(i));
      const nz = Math.abs(nor.getZ(i));
      const x = pos.getX(i) * k;
      const y = pos.getY(i) * k;
      const z = pos.getZ(i) * k;
      if (ny >= nx && ny >= nz) uv.setXY(i, z, x);
      else if (nx >= nz) uv.setXY(i, z, y);
      else uv.setXY(i, x, y);
    }
    uv.needsUpdate = true;
    boxCache.set(key, g);
  }
  return g;
}

function box(parent: THREE.Object3D, material: THREE.Material, size: V3, pos: V3, rot: V3 = [0, 0, 0]): THREE.Mesh {
  const m = new THREE.Mesh(roundedBox(...size), material);
  m.position.set(...pos);
  m.rotation.set(...rot);
  parent.add(m);
  return m;
}

/** Cylinder aligned with Z (barrels, tubes). */
function tube(parent: THREE.Object3D, material: THREE.Material, radius: number, length: number, pos: V3): THREE.Mesh {
  const m = new THREE.Mesh(cyl(), material);
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
  const arm = new THREE.Mesh(cyl(), mat.sleeve);
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
  // Thin walls (they frame the view when aiming): a clean window, not a black box.
  box(root, mat.polymer, [0.0025, 0.038, 0.022], [0.0195, y, z - 0.01]);
  box(root, mat.polymer, [0.0025, 0.038, 0.022], [-0.0195, y, z - 0.01]);
  box(root, mat.polymer, [0.0415, 0.0025, 0.022], [0, y + 0.0195, z - 0.01]);
  box(root, mat.polymer, [0.0415, 0.0025, 0.022], [0, y - 0.0195, z - 0.01]);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.037, 0.037), mat.lens);
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
  box(root, mat.blued, [0.006, 0.013, 0.006], [0.008, line - 0.0045, z]);
  box(root, mat.blued, [0.006, 0.013, 0.006], [-0.008, line - 0.0045, z]);
  return point(root, [0, line, z]);
}

/** Front post (with protective ears) whose tip sits on the sight line. */
function ironFront(root: THREE.Object3D, z: number, line: number, base: number): void {
  const h = line - base;
  box(root, mat.blued, [0.003, h, 0.004], [0, base + h / 2, z]);
  box(root, mat.blued, [0.0022, h + 0.005, 0.008], [0.011, base + (h + 0.005) / 2, z]);
  box(root, mat.blued, [0.0022, h + 0.005, 0.008], [-0.011, base + (h + 0.005) / 2, z]);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0019, 12), mat.bead);
  dot.position.set(0, line - 0.0012, z + 0.0026);
  root.add(dot);
}

/**
 * Front sight hood (rifles) open at the back and front: two side wings and a bridge
 * over the post, so the post and its bead show through when aimed.
 */
function openHood(root: THREE.Object3D, z: number, line: number, width: number, depth: number): void {
  for (const sx of [-1, 1]) box(root, mat.blued, [0.003, 0.026, depth], [sx * (width / 2), line - 0.003, z]);
  box(root, mat.blued, [width + 0.003, 0.003, depth], [0, line + 0.0115, z]);
}

/** A blade across the sight line (rear leaf, range slider) with a U notch the front post sits in. */
function notchedBlade(root: THREE.Object3D, material: THREE.Material, width: number, y0: number, y1: number, z: number, depth: number, line: number, gap = 0.009): void {
  const side = (width - gap) / 2;
  for (const sx of [-1, 1]) box(root, material, [side, y1 - y0, depth], [sx * (gap / 2 + side / 2), (y0 + y1) / 2, z]);
  // Solid below the notch.
  const top = line - 0.004;
  if (top > y0 + 0.001) box(root, material, [width, top - y0, depth], [0, (y0 + top) / 2, z]);
}

// ------------------------------------------------------------------ detail kit

/**
 * Side-profile part (stocks, grips, handguards): a 2D outline in (z, y) — z back,
 * y up — extruded `thick` across X with rounded edges. Real silhouettes instead
 * of stacked boxes.
 */
function profile(parent: THREE.Object3D, material: THREE.Material, pts: [number, number][], thick: number, x = 0): THREE.Mesh {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const bevel = LOW ? 0 : Math.min(0.004, thick * 0.18);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick - bevel * 2, bevelEnabled: !LOW, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: LOW ? 2 : 4 });
  geo.rotateY(-Math.PI / 2);
  geo.translate((thick - bevel * 2) / 2 + x, 0, 0);
  // UVs in metres along the part (grain runs along the stock).
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getZ(i) * 6, pos.getY(i) * 6);
  uv.needsUpdate = true;
  const m = new THREE.Mesh(geo, material);
  parent.add(m);
  return m;
}


/** Rivet / screw heads (tiny spheres). */
function rivets(parent: THREE.Object3D, material: THREE.Material, pts: V3[], r = 0.0028): void {
  if (LOW) return;
  for (const p of pts) {
    const m = new THREE.Mesh(sphereGeo, material);
    m.scale.set(r, r, r);
    m.position.set(...p);
    parent.add(m);
  }
}

/** Ring around the Z axis (barrel bands, castle nuts, suppressor rings). */
function ringZ(parent: THREE.Object3D, material: THREE.Material, radius: number, thick: number, pos: V3): THREE.Mesh {
  const m = new THREE.Mesh(torus(), material);
  m.scale.set(radius, radius, thick / 0.22);
  m.position.set(...pos);
  parent.add(m);
  return m;
}

/** Sling loop (ring standing in the YZ plane). */
function slingLoop(parent: THREE.Object3D, pos: V3, r = 0.009): void {
  if (LOW) return;
  const m = new THREE.Mesh(torusHi, mat.steel);
  m.scale.set(r, r, r);
  m.rotation.y = Math.PI / 2;
  m.position.set(...pos);
  parent.add(m);
}

/** Row of identical small boxes (rail slots, serrations, ribs, vents). */
function row(parent: THREE.Object3D, material: THREE.Material, n: number, size: V3, start: V3, step: V3): void {
  if (LOW) return;
  for (let i = 0; i < n; i++) box(parent, material, size, [start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i]);
}

/** Picatinny top rail teeth along Z on top of a rail at height `top`. */
function railTeeth(parent: THREE.Object3D, z0: number, z1: number, top: number, w = 0.022): void {
  if (LOW) return;
  for (let z = z0; z > z1; z -= 0.01) box(parent, mat.black, [w, 0.004, 0.005], [0, top + 0.002, z]);
}

/** Trigger guard loop under the receiver (front post + bottom bar + rear tie-in). */
function triggerGuard(parent: THREE.Object3D, material: THREE.Material, zFront: number, zRear: number, top: number, depth: number): void {
  const len = zRear - zFront;
  box(parent, material, [0.012, 0.005, len], [0, top - depth, zFront + len / 2]);
  box(parent, material, [0.012, depth, 0.005], [0, top - depth / 2, zFront]);
  box(parent, material, [0.012, depth * 0.6, 0.005], [0, top - depth * 0.3, zRear]);
}

/**
 * Holographic sight (EOTech-pattern box): hood with a square window, base with
 * battery housing and buttons, and a red ring-and-dot reticle that floats in
 * the window. Returns the sight point (the reticle centre).
 */
function holoSight(root: THREE.Object3D, z: number, railTop: number): THREE.Object3D {
  const y = railTop + 0.034;
  const P = mat.black;
  box(root, P, [0.036, 0.012, 0.08], [0, railTop + 0.006, z]); // base / mount
  box(root, mat.gunmetal, [0.04, 0.008, 0.014], [0.0, railTop + 0.004, z + 0.026]); // cross-bolt clamp
  ringZ(root, mat.steel, 0.004, 0.003, [0.022, railTop + 0.004, z + 0.026]).rotation.y = Math.PI / 2;
  box(root, P, [0.032, 0.018, 0.034], [0, railTop + 0.014, z - 0.034]); // battery housing
  box(root, mat.gunmetal, [0.01, 0.01, 0.012], [0.019, railTop + 0.016, z - 0.034]); // battery cap
  // Hood: side wings, curved top, front + rear window frames.
  // Thin hood and window frames: aimed, they're all you see around the reticle.
  for (const sx of [-1, 1]) box(root, P, [0.0032, 0.044, 0.07], [0.0212 * sx, y, z - 0.002]);
  box(root, P, [0.046, 0.0045, 0.074], [0, y + 0.0235, z - 0.002]);
  box(root, P, [0.039, 0.0035, 0.004], [0, y - 0.0178, z - 0.034]);
  box(root, P, [0.039, 0.0035, 0.004], [0, y + 0.0185, z - 0.034]);
  box(root, P, [0.039, 0.0035, 0.004], [0, y - 0.0178, z + 0.03]);
  box(root, P, [0.039, 0.0035, 0.004], [0, y + 0.0185, z + 0.03]);
  // Rear control buttons.
  for (const bx of [-0.01, 0.0, 0.01]) box(root, mat.rubber, [0.007, 0.006, 0.004], [bx, railTop + 0.01, z + 0.04]);
  // Windows + reticle (65 MOA ring, 1 MOA dot).
  for (const wz of [z - 0.034, z + 0.03]) {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.038, 0.034), mat.holoGlass);
    glass.position.set(0, y, wz);
    root.add(glass);
  }
  const ringM = new THREE.Mesh(new THREE.RingGeometry(0.0052, 0.0061, 40), mat.reticle);
  ringM.position.set(0, y, z - 0.035);
  root.add(ringM);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.00075, 12), mat.reticle);
  dot.position.set(0, y, z - 0.035);
  root.add(dot);
  for (const [tx, ty] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(tx ? 0.0016 : 0.0005, ty ? 0.0016 : 0.0005), mat.reticle);
    tick.position.set(tx * 0.0049, y + ty * 0.0049, z - 0.035);
    root.add(tick);
  }
  return point(root, [0, y, z - 0.035]);
}

/** Centre line of a curved magazine, top to bottom, in (z, y): it bends forward as it goes down. */
function magLine(len: number, bend: number, n = 10): { z: number; y: number; a: number }[] {
  const out = [{ z: 0, y: 0, a: 0.08 }];
  let z = 0;
  let y = 0;
  for (let i = 1; i <= n; i++) {
    const a = 0.08 + (bend * i) / n;
    y -= (len / n) * Math.cos(a);
    z -= (len / n) * Math.sin(a);
    out.push({ z, y, a });
  }
  return out;
}

/** Outline along the centre line, `half` to either side (front edge down, rear edge up). */
function magOutline(line: { z: number; y: number; a: number }[], half: number, off = 0): [number, number][] {
  const front = line.map((p) => [p.z - (half - off) * Math.cos(p.a), p.y + (half - off) * Math.sin(p.a)] as [number, number]);
  const rear = line.map((p) => [p.z + (half + off) * Math.cos(p.a), p.y - (half + off) * Math.sin(p.a)] as [number, number]);
  return [...front, ...rear.reverse()];
}

/**
 * Curved magazine as one smooth body (the old signature: `segs` segments of `h`
 * bending by `curve` each). Returns the bottom of the centre line.
 */
function curvedMag(parent: THREE.Object3D, material: THREE.Material, segs: number, width: number, depth: number, curve: number, h = 0.055): { z: number; y: number; a: number } {
  const line = magLine(segs * h * 0.95, (segs - 1) * curve);
  profile(parent, material, magOutline(line, depth / 2), width);
  return line[line.length - 1];
}

/** Steel AK magazine: smooth curved body, stamped ribs down both sides, floorplate. */
function ribbedMag(parent: THREE.Object3D, material: THREE.Material, segs: number, width: number, depth: number, curve: number, h = 0.055): void {
  const end = curvedMag(parent, material, segs, width, depth, curve, h);
  const line = magLine(segs * h * 0.95, (segs - 1) * curve);
  const rib = line.slice(1, line.length - 1);
  for (const sx of [-1, 1]) {
    profile(parent, material, magOutline(rib, 0.004, -depth * 0.2), 0.003, (width / 2 + 0.0005) * sx);
    profile(parent, material, magOutline(rib, 0.004, depth * 0.2), 0.003, (width / 2 + 0.0005) * sx);
  }
  box(parent, mat.blued, [width + 0.006, 0.008, depth + 0.006], [0, end.y - 0.003, end.z], [end.a, 0, 0]); // floorplate
}

function rig(
  root: THREE.Group,
  parts: Omit<WeaponRig, 'root' | 'leftHandRest' | 'rightHandRest' | 'butt'> & { butt: V3 },
): WeaponRig {
  return {
    ...parts,
    root,
    leftHandRest: parts.leftHand.position.clone(),
    rightHandRest: parts.rightHand.position.clone(),
    butt: new THREE.Vector3(...parts.butt),
  };
}

/** A single cartridge for loading by hand (child of the hand). */
function heldRound(hand: THREE.Object3D): THREE.Group {
  const g = group(hand, [0, 0.045, -0.01]);
  tube(g, mat.brass, 0.0065, 0.055, [0, 0, 0]);
  tube(g, mat.blued, 0.0045, 0.022, [0, 0, -0.037]);
  g.visible = false;
  return g;
}

// ------------------------------------------------------------------ bolt actions

/** Mosin-Nagant M91/30: long orange shellac stock, round receiver, straight bolt. 1.23 m. */
function buildMosin(): WeaponRig {
  const R = new THREE.Group();
  const W = mat.woodMosin;
  profile(R, W, [[0.04, 0.03], [0.358, -0.005], [0.366, -0.122], [0.2, -0.085], [0.06, -0.05], [0.04, -0.03]], 0.046);
  box(R, mat.blued, [0.048, 0.118, 0.01], [0, -0.064, 0.366], [-0.07, 0, 0]);
  box(R, W, [0.04, 0.056, 0.14], [0, -0.014, 0.02]);
  box(R, W, [0.052, 0.056, 0.62], [0, 0.0, -0.33]);
  box(R, W, [0.04, 0.022, 0.38], [0, 0.04, -0.43]);
  for (const z of [-0.29, -0.6]) box(R, mat.blued, [0.056, 0.07, 0.014], [0, 0.012, z]);
  tube(R, mat.blued, 0.017, 0.2, [0, 0.03, -0.07]);
  box(R, mat.blued, [0.04, 0.05, 0.1], [0, -0.03, -0.065]);
  box(R, mat.blued, [0.008, 0.03, 0.06], [0, -0.062, 0.0]);
  tube(R, mat.blued, 0.012, 0.26, [0, 0.03, -0.75]);
  box(R, mat.blued, [0.03, 0.014, 0.08], [0, 0.052, -0.19]);
  const sight = ironRear(R, -0.22, 0.068);
  box(R, mat.blued, [0.016, 0.012, 0.02], [0, 0.047, -0.862]);
  ironFront(R, -0.862, 0.068, 0.053);
  // Bolt pivots on the bore axis: handle sticks out right, lifts (rot z) and slides back (+z).
  const bolt = group(R, [0, 0.03, 0.035]);
  tube(bolt, mat.steel, 0.0095, 0.12, [0, 0, -0.05]);
  box(bolt, mat.steel, [0.062, 0.009, 0.009], [0.031, -0.003, 0], [0, 0, -0.12]);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 14, 10), mat.steel);
  knob.position.set(0.063, -0.008, 0);
  bolt.add(knob);
  bolt.userData.knob = knob.position.clone();
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.034, 0.0, -0.46]);
  const rightHand = hand(R, [0, -0.04, 0.03], [0.1, -0.26, 0.38], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.042, -0.38], [-0.22, -0.27, -0.06], [0.056, 0.05, 0.1]);
  // Barrel bands with springs, globe front sight hood, cleaning rod, box magazine + trigger guard.
  for (const z of [-0.29, -0.6]) rivets(R, mat.steel, [[0.03, 0.012, z]], 0.004);
  ringZ(R, mat.blued, 0.012, 0.004, [0, 0.03, -0.86]);
  openHood(R, -0.862, 0.068, 0.024, 0.024);
  tube(R, mat.steel, 0.003, 0.28, [0, 0.016, -0.73]);
  box(R, mat.blued, [0.036, 0.036, 0.11], [0, -0.06, -0.08]); // magazine box
  box(R, mat.blued, [0.03, 0.006, 0.12], [0, -0.08, -0.08]); // floorplate
  triggerGuard(R, mat.blued, -0.02, 0.06, -0.075, 0.03);
  box(R, mat.blued, [0.04, 0.006, 0.12], [0, 0.058, -0.235], [-0.05, 0, 0]); // rear sight ramp leaf (under the line)
  notchedBlade(R, mat.steel, 0.036, 0.064, 0.072, -0.24, 0.012, 0.068); // range slider
  box(R, mat.darkHole, [0.004, 0.02, 0.04], [0.024, -0.02, 0.18]); // sling slot
  box(R, mat.darkHole, [0.004, 0.02, 0.04], [-0.024, -0.02, 0.18]);
  tube(R, mat.steel, 0.014, 0.03, [0, 0.03, 0.085]); // cocking knob
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.88]),
    ejectPort: point(R, [0.02, 0.05, -0.05]),
    laser: point(R, [0.034, 0.0, -0.486]),
    sight, mag: null, bolt, pump: null, leftHand, rightHand, heldShell: heldRound(rightHand), shellType: 'rifle',
    butt: [0, -0.065, 0.37],
  });
}

/** Kar98k: dark walnut, semi pistol grip, turned-down bolt. 1.11 m. */
function buildKar98(): WeaponRig {
  const R = new THREE.Group();
  const W = mat.woodKar;
  profile(R, W, [[0.04, 0.03], [0.336, 0.0], [0.344, -0.118], [0.2, -0.085], [0.09, -0.09], [0.05, -0.05], [0.03, -0.03]], 0.046);
  box(R, mat.blued, [0.048, 0.12, 0.01], [0, -0.059, 0.344], [-0.07, 0, 0]);
  box(R, W, [0.05, 0.055, 0.52], [0, 0.0, -0.28]);
  box(R, W, [0.038, 0.02, 0.3], [0, 0.038, -0.39]);
  for (const z of [-0.3, -0.52]) box(R, mat.blued, [0.054, 0.068, 0.014], [0, 0.01, z]);
  tube(R, mat.blued, 0.017, 0.2, [0, 0.03, -0.07]);
  box(R, mat.blued, [0.04, 0.03, 0.09], [0, -0.035, -0.07]);
  box(R, mat.blued, [0.008, 0.03, 0.06], [0, -0.064, 0.0]);
  tube(R, mat.blued, 0.012, 0.23, [0, 0.03, -0.655]);
  box(R, mat.blued, [0.028, 0.014, 0.06], [0, 0.052, -0.19]);
  const sight = ironRear(R, -0.215, 0.07);
  box(R, mat.blued, [0.02, 0.016, 0.03], [0, 0.046, -0.75]);
  ironFront(R, -0.755, 0.07, 0.054);
  const bolt = group(R, [0, 0.03, 0.035]);
  tube(bolt, mat.steel, 0.0095, 0.12, [0, 0, -0.05]);
  box(bolt, mat.steel, [0.05, 0.009, 0.009], [0.024, -0.014, 0.006], [0, 0, -0.7]);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 14, 10), mat.steel);
  knob.position.set(0.046, -0.032, 0.012);
  bolt.add(knob);
  bolt.userData.knob = knob.position.clone();
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.034, 0.0, -0.42]);
  const rightHand = hand(R, [0, -0.05, 0.035], [0.1, -0.26, 0.38], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.042, -0.34], [-0.22, -0.27, -0.04], [0.056, 0.05, 0.1]);
  ringZ(R, mat.blued, 0.012, 0.004, [0, 0.03, -0.755]);
  openHood(R, -0.755, 0.07, 0.026, 0.022); // front sight hood
  box(R, mat.blued, [0.012, 0.012, 0.03], [0, -0.008, -0.62]); // bayonet lug
  tube(R, mat.steel, 0.003, 0.24, [0, 0.014, -0.63]);
  box(R, mat.blued, [0.03, 0.006, 0.12], [0, -0.052, -0.08]); // floorplate
  triggerGuard(R, mat.blued, -0.02, 0.06, -0.05, 0.03);
  box(R, mat.blued, [0.034, 0.006, 0.1], [0, 0.062, -0.23], [-0.05, 0, 0]); // tangent sight
  notchedBlade(R, mat.steel, 0.03, 0.064, 0.074, -0.24, 0.012, 0.07);
  box(R, mat.darkHole, [0.004, 0.012, 0.03], [0.024, -0.03, 0.12]); // sling slot
  box(R, mat.darkHole, [0.004, 0.012, 0.03], [-0.024, -0.03, 0.12]);
  slingLoop(R, [-0.026, 0.0, -0.52]);
  tube(R, mat.steel, 0.012, 0.026, [0, 0.03, 0.088]); // cocking piece
  box(R, mat.steel, [0.004, 0.012, 0.012], [0, 0.044, 0.095]); // wing safety
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.775]),
    ejectPort: point(R, [0.02, 0.05, -0.05]),
    laser: point(R, [0.034, 0.0, -0.446]),
    sight, mag: null, bolt, pump: null, leftHand, rightHand, heldShell: heldRound(rightHand), shellType: 'rifle',
    butt: [0, -0.062, 0.345],
  });
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
  // Upper handguard over the gas tube; lower handguard with a finger swell and grooves.
  profile(R, mat.akWood, [[-0.215, 0.06], [-0.37, 0.06], [-0.375, 0.074], [-0.36, 0.088], [-0.225, 0.088], [-0.21, 0.076]], 0.042);
  profile(R, mat.akWood, [[-0.205, 0.048], [-0.398, 0.046], [-0.398, 0.0], [-0.37, -0.012], [-0.3, -0.006], [-0.24, -0.012], [-0.205, -0.004]], 0.056);
  tube(R, mat.blued, 0.011, 0.13, [0, 0.03, -0.465]);
  box(R, mat.blued, [0.026, 0.05, 0.03], [0, 0.055, -0.5]);
  ironFront(R, -0.505, 0.096, 0.08);
  tube(R, mat.blued, 0.015, 0.04, [0, 0.03, -0.53]);
  // Stock: slim wrist behind the receiver, deepening toward the butt with the classic drop.
  profile(R, mat.akWood, [[0.075, 0.034], [0.32, 0.006], [0.322, -0.104], [0.2, -0.07], [0.13, -0.036], [0.075, -0.012]], 0.042);
  box(R, mat.blued, [0.046, 0.114, 0.01], [0, -0.049, 0.327], [0.02, 0, 0]);
  // Pistol grip: raked back, slightly swelled.
  profile(R, mat.akGrip, [[-0.005, -0.008], [0.04, -0.008], [0.072, -0.105], [0.05, -0.118], [0.026, -0.112], [0.006, -0.06]], 0.032);
  for (let i = 0; i < 4; i++) box(R, mat.akGrip, [0.034, 0.003, 0.005], [0, -0.03 - i * 0.02, 0.036 + i * 0.006], [0.3, 0, 0]); // grip ribs
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.022, -0.03]);
  box(R, mat.steel, [0.004, 0.02, 0.1], [0.027, 0.04, -0.05]);
  const mag = group(R, [0, -0.012, -0.12]);
  ribbedMag(mag, mat.blued, 7, 0.03, 0.066, 0.068, 0.033);
  const bolt = group(R, [0.032, 0.04, -0.1]);
  box(bolt, mat.steel, [0.022, 0.012, 0.03], [0.008, 0, 0]);
  box(bolt, mat.steel, [0.008, 0.018, 0.02], [0.02, 0.004, 0.0]); // charging handle knob
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.038, 0.012, -0.34]);
  const rightHand = hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.022, -0.31], [-0.22, -0.26, -0.02], [0.055, 0.05, 0.1]);
  // Stamped receiver: trunnion rivets, mag-well dimples, side scope rail.
  for (const sx of [-1, 1]) {
    rivets(R, mat.steel, [[0.026 * sx, 0.04, -0.18], [0.026 * sx, 0.01, -0.18], [0.026 * sx, 0.04, -0.165], [0.026 * sx, 0.01, 0.06], [0.026 * sx, 0.04, 0.06], [0.026 * sx, -0.004, -0.02]]);
    box(R, mat.gunmetal, [0.003, 0.012, 0.018], [0.0255 * sx, 0.02, -0.1]);
  }
  box(R, mat.blued, [0.004, 0.022, 0.1], [-0.027, 0.024, 0.0]);
  // Ribbed dust cover + rear-sight leaf + rear trunnion tang.
  row(R, mat.blued, 4, [0.054, 0.003, 0.006], [0, 0.082, 0.04], [0, 0, -0.035]);
  box(R, mat.blued, [0.03, 0.004, 0.05], [0, 0.088, -0.165], [-0.06, 0, 0]);
  box(R, mat.steel, [0.034, 0.008, 0.01], [0, 0.088, -0.17]);
  box(R, mat.blued, [0.048, 0.05, 0.02], [0, 0.012, 0.085]);
  // Long selector lever on the right side, mag release paddle, trigger guard.
  box(R, mat.blued, [0.004, 0.014, 0.12], [0.027, 0.036, -0.03], [-0.08, 0, 0]);
  box(R, mat.blued, [0.006, 0.012, 0.012], [0.028, 0.044, 0.03]);
  box(R, mat.blued, [0.02, 0.01, 0.012], [0, -0.034, -0.078]);
  triggerGuard(R, mat.blued, -0.07, 0.0, -0.011, 0.034);
  // Gas block + handguard retainer bands, vents in the upper wood, cleaning rod, bayonet lug.
  box(R, mat.blued, [0.03, 0.04, 0.032], [0, 0.05, -0.41]);
  box(R, mat.blued, [0.062, 0.062, 0.008], [0, 0.02, -0.203]);
  box(R, mat.blued, [0.062, 0.062, 0.008], [0, 0.022, -0.398]);
  for (const sx of [-1, 1]) row(R, mat.akWood, 2, [0.002, 0.004, 0.12], [0.028 * sx, 0.012 + 0.012, -0.3], [0, 0.016, 0]); // handguard grooves
  tube(R, mat.blued, 0.0032, 0.14, [0, 0.008, -0.47]);
  box(R, mat.blued, [0.012, 0.012, 0.02], [0, 0.022, -0.492]);
  // Slant muzzle brake.
  box(R, mat.blued, [0.026, 0.026, 0.036], [0, 0.03, -0.548]);
  box(R, mat.blued, [0.026, 0.012, 0.03], [0, 0.044, -0.555], [0.35, 0, 0]);
  // Sling loops (front at the gas block, rear under the stock), butt plate trap door.
  slingLoop(R, [-0.02, 0.044, -0.41]);
  slingLoop(R, [0, -0.06, 0.26]);
  box(R, mat.steel, [0.02, 0.03, 0.004], [0, -0.024, 0.329]);
  rivets(R, mat.steel, [[0, 0.01, 0.329], [0, -0.06, 0.329]], 0.0035);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.55]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.038, 0.012, -0.366]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
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
  const sight = holoSight(R, -0.06, 0.094);
  const mag = group(R, [0, -0.03, -0.11]);
  curvedMag(mag, mat.parkerized, 3, 0.026, 0.064, 0.06);
  box(mag, mat.black, [0.03, 0.01, 0.07], [0, -0.165, -0.012], [0.25, 0, 0]);
  const bolt = group(R, [0, 0.072, 0.05]);
  box(bolt, mat.steel, [0.035, 0.01, 0.02], [0, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.036, 0.05, -0.36]);
  const rightHand = hand(R, [0, -0.058, 0.03], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.005, -0.33], [-0.22, -0.24, -0.04], [0.055, 0.05, 0.1]);
  railTeeth(R, 0.04, -0.42, 0.094);
  // Upper: forward assist, ejection-port cover, brass deflector; lower: bolt catch, selector, mag release.
  tube(R, mat.black, 0.006, 0.034, [0.026, 0.066, 0.005]);
  box(R, mat.black, [0.002, 0.016, 0.05], [0.0255, 0.052, -0.065]);
  box(R, mat.black, [0.008, 0.02, 0.014], [0.027, 0.064, -0.028]);
  box(R, mat.black, [0.003, 0.012, 0.022], [-0.024, 0.0, -0.085]);
  ringZ(R, mat.black, 0.007, 0.003, [-0.024, 0.016, 0.01]).rotation.y = Math.PI / 2;
  box(R, mat.black, [0.003, 0.004, 0.018], [-0.026, 0.02, 0.015]);
  ringZ(R, mat.gunmetal, 0.0045, 0.004, [0.024, -0.02, -0.07]).rotation.y = Math.PI / 2;
  triggerGuard(R, mat.black, -0.068, 0.0, -0.022, 0.03);
  box(R, mat.black, [0.05, 0.03, 0.03], [0, -0.06, -0.08], [0.25, 0, 0]); // flared mag well
  // Handguard rail slots on the sides, A-frame front sight, birdcage flash hider.
  for (const sx of [-1, 1]) row(R, mat.gunmetal, 9, [0.003, 0.006, 0.012], [0.032 * sx, 0.05, -0.21], [0, 0, -0.022]);
  box(R, mat.black, [0.024, 0.006, 0.026], [0, 0.064, -0.445]);
  box(R, mat.black, [0.004, 0.05, 0.014], [0.011, 0.086, -0.445]);
  box(R, mat.black, [0.004, 0.05, 0.014], [-0.011, 0.086, -0.445]);
  box(R, mat.black, [0.003, 0.03, 0.004], [0, 0.098, -0.445]);
  for (const [x, y] of [[0.009, 0.009], [-0.009, 0.009], [0.009, -0.009], [-0.009, -0.009]]) box(R, mat.blued, [0.004, 0.004, 0.024], [x, 0.05 + y, -0.515]);
  // Buffer tube castle nut, stock lever and ribs, QD sling cup, grip ridges.
  ringZ(R, mat.gunmetal, 0.018, 0.006, [0, 0.055, 0.075]);
  box(R, mat.black, [0.008, 0.014, 0.04], [0, -0.006, 0.23]);
  row(R, mat.polymer, 4, [0.046, 0.003, 0.012], [0, 0.072, 0.2], [0, 0, 0.025]);
  ringZ(R, mat.steel, 0.006, 0.004, [0.024, 0.035, 0.28]).rotation.y = Math.PI / 2;
  for (const sx of [-1, 1]) box(R, mat.polymer, [0.002, 0.06, 0.03], [0.0175 * sx, -0.06, 0.028], [0.32, 0, 0]); // grip texture panels
  return rig(R, {
    muzzle: point(R, [0, 0.05, -0.53]),
    ejectPort: point(R, [0.028, 0.055, -0.06]),
    laser: point(R, [0.036, 0.05, -0.386]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
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
  tube(R, mat.gunmetal, 0.015, 0.12, [0, 0.055, 0.1]); // buffer tube
  box(R, mat.tan, [0.046, 0.082, 0.17], [0, 0.03, 0.235]);
  box(R, mat.polymer, [0.048, 0.09, 0.012], [0, 0.028, 0.31]);
  box(R, mat.black, [0.034, 0.085, 0.045], [0, -0.058, 0.025], [0.3, 0, 0]);
  box(R, mat.black, [0.008, 0.026, 0.05], [0, -0.026, -0.03]);
  const sight = holoSight(R, -0.07, 0.096);
  const mag = group(R, [0, -0.03, -0.11]);
  ribbedMag(mag, mat.black, 4, 0.03, 0.068, 0.12);
  const bolt = group(R, [0, 0.073, 0.05]);
  box(bolt, mat.steel, [0.035, 0.01, 0.02], [0, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.038, 0.05, -0.36]);
  const rightHand = hand(R, [0, -0.058, 0.03], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.005, -0.32], [-0.22, -0.24, -0.04], [0.055, 0.05, 0.1]);
  railTeeth(R, 0.04, -0.4, 0.096);
  for (const sx of [-1, 1]) {
    row(R, mat.darkHole, 5, [0.002, 0.012, 0.026], [0.0325 * sx, 0.05, -0.23], [0, 0, -0.035]);
    rivets(R, mat.gunmetal, [[0.025 * sx, 0.075, -0.18], [0.025 * sx, 0.075, 0.03]], 0.0025);
  }
  tube(R, mat.black, 0.006, 0.034, [0.027, 0.068, 0.005]);
  box(R, mat.black, [0.002, 0.016, 0.05], [0.0265, 0.054, -0.065]);
  box(R, mat.black, [0.003, 0.012, 0.022], [-0.025, 0.0, -0.085]);
  box(R, mat.black, [0.003, 0.004, 0.018], [-0.027, 0.02, 0.015]);
  triggerGuard(R, mat.black, -0.068, 0.0, -0.022, 0.03);
  // Big 3-port brake.
  for (let i = 0; i < 3; i++) box(R, mat.darkHole, [0.032, 0.008, 0.006], [0, 0.05, -0.505 - i * 0.013]);
  box(R, mat.gunmetal, [0.034, 0.012, 0.045], [0, 0.06, -0.52]);
  ringZ(R, mat.gunmetal, 0.018, 0.006, [0, 0.056, 0.08]);
  slingLoop(R, [0.024, 0.03, 0.29]);
  return rig(R, {
    muzzle: point(R, [0, 0.05, -0.543]),
    ejectPort: point(R, [0.029, 0.056, -0.06]),
    laser: point(R, [0.038, 0.05, -0.386]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
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
  const rightHand = hand(R, [0, -0.062, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.032, -0.27], [-0.22, -0.26, 0.0], [0.055, 0.05, 0.1]);
  for (const sx of [-1, 1]) rivets(R, mat.steel, [[0.023 * sx, 0.04, -0.14], [0.023 * sx, 0.0, -0.14], [0.023 * sx, 0.04, 0.05], [0.023 * sx, 0.0, 0.05]]);
  for (const z of [-0.18, -0.25, -0.32, -0.39, -0.46, -0.53]) ringZ(R, mat.gunmetal, 0.0236, 0.003, [0, 0.03, z]);
  box(R, mat.blued, [0.004, 0.012, 0.1], [0.024, 0.038, -0.02], [-0.06, 0, 0]); // safety / selector lever
  box(R, mat.blued, [0.004, 0.022, 0.08], [-0.024, 0.026, 0.0]); // side rail
  triggerGuard(R, mat.blued, -0.068, 0.0, -0.011, 0.034);
  box(R, mat.gunmetal, [0.03, 0.02, 0.02], [0, 0.034, 0.075]); // stock hinge
  rivets(R, mat.steel, [[0.016, 0.034, 0.075], [-0.016, 0.034, 0.075]], 0.004);
  box(R, mat.black, [0.03, 0.04, 0.012], [0, 0.07, -0.12]); // rear sight block
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.577]),
    ejectPort: point(R, [0.027, 0.035, -0.05]),
    laser: point(R, [0.034, 0.0, -0.326]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.008, 0.3],
  });
}

/** PPSh-41: full wooden stock, perforated barrel shroud, 71-round drum. 0.843 m. */
function buildPPSh(): WeaponRig {
  const R = new THREE.Group();
  profile(R, mat.woodDark, [[0.05, 0.03], [0.325, -0.002], [0.33, -0.098], [0.19, -0.07], [0.1, -0.048], [0.05, -0.02]], 0.048);
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
  const drum = new THREE.Mesh(cyl(), mat.blued);
  drum.scale.set(0.072, 0.048, 0.072);
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0, -0.085, -0.01);
  mag.add(drum);
  tube(mag, mat.gunmetal, 0.074, 0.006, [0, -0.085, -0.01]).rotation.set(0, 0, Math.PI / 2);
  tube(mag, mat.gunmetal, 0.074, 0.006, [0, -0.085, -0.01]).position.x = 0.022;
  const drumKey = new THREE.Mesh(cyl(), mat.steel);
  drumKey.scale.set(0.012, 0.02, 0.012);
  drumKey.rotation.z = Math.PI / 2;
  drumKey.position.set(0.032, -0.085, -0.01);
  mag.add(drumKey);
  const bolt = group(R, [0.028, 0.048, -0.12]);
  box(bolt, mat.steel, [0.016, 0.01, 0.02], [0.004, 0, 0]);
  box(R, mat.polymer, [0.022, 0.022, 0.05], [0.03, 0.04, -0.3]);
  const rightHand = hand(R, [0, -0.04, 0.03], [0.1, -0.25, 0.36], [0.05, 0.08, 0.085]);
  const leftHand = hand(R, [-0.005, -0.012, -0.24], [-0.22, -0.26, 0.02], [0.055, 0.05, 0.1]);
  // Perforated shroud: dark cooling slots along both sides and the top.
  for (const sx of [-1, 1]) row(R, mat.darkHole, 6, [0.002, 0.008, 0.026], [0.0205 * sx, 0.05, -0.215], [0, 0, -0.045]);
  row(R, mat.darkHole, 6, [0.01, 0.002, 0.026], [0, 0.0705, -0.215], [0, 0, -0.045]);
  box(R, mat.blued, [0.046, 0.05, 0.03], [0, 0.05, -0.5], [-0.5, 0, 0]); // slanted compensator nose
  box(R, mat.darkHole, [0.014, 0.004, 0.01], [0, 0.07, -0.49]); // brake port
  box(R, mat.blued, [0.03, 0.012, 0.03], [0, 0.083, -0.03]); // rear L-flip sight
  notchedBlade(R, mat.blued, 0.014, 0.079, 0.101, -0.025, 0.006, 0.093, 0.007);
  box(R, mat.blued, [0.05, 0.02, 0.04], [0, 0.07, -0.055]); // receiver hinge cap
  rivets(R, mat.steel, [[0.026, 0.06, -0.07], [-0.026, 0.06, -0.07]], 0.0035);
  box(R, mat.steel, [0.006, 0.01, 0.02], [0.028, 0.06, -0.15]); // safety on the bolt handle slot
  triggerGuard(R, mat.blued, -0.06, 0.005, -0.01, 0.034);
  box(R, mat.blued, [0.016, 0.02, 0.01], [0, -0.03, -0.075]); // drum catch
  box(R, mat.blued, [0.052, 0.012, 0.03], [0, 0.0, 0.07]); // receiver tang
  slingLoop(R, [-0.026, 0.0, -0.12]);
  slingLoop(R, [0, -0.07, 0.24]);
  rivets(R, mat.steel, [[0, -0.01, 0.336], [0, -0.07, 0.336]], 0.0035);
  return rig(R, {
    muzzle: point(R, [0, 0.045, -0.51]),
    ejectPort: point(R, [0.02, 0.068, -0.11]),
    laser: point(R, [0.03, 0.04, -0.326]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'pistol',
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
  const rightHand = hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.0, -0.4], [-0.22, -0.24, -0.08], [0.056, 0.052, 0.1]);
  railTeeth(R, 0.04, -0.48, 0.094);
  for (const sx of [-1, 1]) {
    rivets(R, mat.steel, [[0.026 * sx, 0.04, -0.18], [0.026 * sx, 0.01, -0.18], [0.026 * sx, 0.04, 0.06], [0.026 * sx, 0.01, 0.06]]);
    row(R, mat.darkHole, 4, [0.002, 0.01, 0.03], [0.0335 * sx, 0.06, -0.255], [0, 0, -0.055]);
  }
  row(R, mat.gunmetal, 4, [0.054, 0.003, 0.006], [0, 0.083, 0.04], [0, 0, -0.035]);
  box(R, mat.blued, [0.004, 0.014, 0.12], [0.027, 0.036, -0.03], [-0.08, 0, 0]);
  triggerGuard(R, mat.black, -0.07, 0.0, -0.011, 0.034);
  box(R, mat.gunmetal, [0.024, 0.016, 0.02], [0, 0.02, 0.32]); // folding-stock latch
  for (let i = 0; i < 4; i++) box(R, mat.darkHole, [0.036, 0.004, 0.008], [0, 0.035, -0.585 - i * 0.012]);
  slingLoop(R, [0.022, 0.0, 0.28]);
  return rig(R, {
    muzzle: point(R, [0, 0.035, -0.625]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.04, 0.045, -0.446]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
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
  for (const sx of [-1, 1]) {
    row(slide, mat.darkHole, 6, [0.002, 0.022, 0.003], [0.0181 * sx, 0.034, 0.005], [0, 0, 0.0055]);
    row(slide, mat.darkHole, 4, [0.002, 0.018, 0.003], [0.0181 * sx, 0.034, -0.15], [0, 0, -0.006]);
  }
  box(slide, mat.darkHole, [0.003, 0.012, 0.03], [0.0182, 0.04, -0.045]); // ejection port
  box(slide, mat.steel, [0.02, 0.003, 0.02], [0, 0.0495, -0.045]); // chamber top
  box(slide, mat.polymer, [0.009, 0.016, 0.008], [0.0095, 0.054, 0.02]);
  box(slide, mat.polymer, [0.009, 0.016, 0.008], [-0.0095, 0.054, 0.02]);
  box(slide, mat.polymer, [0.0055, 0.016, 0.006], [0, 0.053, -0.17]);
  const frontDot = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 10), mat.bead);
  frontDot.position.set(0, 0.0575, -0.1665);
  slide.add(frontDot);
  for (const x of [0.0095, -0.0095]) {
    const rearDot = new THREE.Mesh(new THREE.CircleGeometry(0.0018, 8), mat.bead);
    rearDot.position.set(x, 0.0575, 0.0242);
    slide.add(rearDot);
  }
  const mag = group(R, [0, -0.03, 0.0]);
  box(mag, mat.gunmetal, [0.026, 0.09, 0.04], [0, -0.035, 0.008], [0.3, 0, 0]);
  box(mag, mat.polymer, [0.03, 0.012, 0.05], [0, -0.084, 0.024], [0.3, 0, 0]);
  const rightHand = hand(R, [0, -0.06, 0.025], [0.08, -0.24, 0.36], [0.05, 0.09, 0.08]);
  const leftHand = hand(R, [-0.025, -0.075, 0.015], [-0.18, -0.25, 0.32], [0.05, 0.075, 0.08]);
  box(R, mat.polymer, [0.026, 0.02, 0.05], [0, -0.022, -0.13]);
  box(R, mat.polymer, [0.026, 0.006, 0.07], [0, -0.012, -0.12]); // accessory rail
  row(R, mat.black, 3, [0.027, 0.003, 0.006], [0, -0.006, -0.1], [0, 0, -0.015]);
  triggerGuard(R, mat.polymer, -0.065, -0.02, -0.012, 0.03);
  box(R, mat.polymer, [0.03, 0.01, 0.022], [0, -0.004, 0.035], [-0.4, 0, 0]); // beavertail
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) box(R, mat.black, [0.002, 0.012, 0.03], [0.0165 * sx, -0.04 - i * 0.017, 0.008 + i * 0.005], [0.3, 0, 0]);
    box(R, mat.steel, [0.003, 0.004, 0.012], [0.0165 * sx, 0.012, -0.05]); // takedown lever
  }
  tube(R, mat.steel, 0.0035, 0.02, [0, 0.016, -0.197]); // recoil spring guide
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.205]),
    ejectPort: point(R, [0.02, 0.045, -0.05]),
    laser: point(R, [0, -0.022, -0.156]),
    sight: point(R, [0, 0.0575, 0.02]), // three dots level: the front dot is the aim
    mag, bolt: slide, pump: null, leftHand, rightHand, heldShell: null, shellType: 'pistol',
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
  profile(R, mat.wood, [[0.075, 0.03], [0.34, 0.016], [0.344, -0.082], [0.2, -0.06], [0.11, -0.04], [0.075, -0.012]], 0.044);
  box(R, mat.polymer, [0.05, 0.095, 0.02], [0, -0.02, 0.345]);
  profile(R, mat.wood, [[0.0, -0.01], [0.075, -0.012], [0.09, -0.1], [0.06, -0.11], [0.03, -0.1], [0.012, -0.05]], 0.036);
  box(R, mat.polymer, [0.008, 0.026, 0.05], [0, -0.022, -0.02]);
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 10, 8), mat.bead);
  bead.position.set(0, 0.064, -0.68);
  R.add(bead);
  box(R, mat.polymer, [0.02, 0.006, 0.03], [0, 0.06, 0.0]);
  const pump = group(R, [0, 0.008, -0.37]);
  box(pump, mat.wood, [0.052, 0.046, 0.17], [0, 0, 0]);
  for (let i = 0; i < 5; i++) box(pump, mat.polymer, [0.054, 0.048, 0.006], [0, 0, -0.06 + i * 0.03]);
  const leftHand = hand(pump, [-0.006, -0.028, -0.01], [-0.22, -0.26, 0.24], [0.056, 0.05, 0.1]);
  const rightHand = hand(R, [0, -0.058, 0.05], [0.1, -0.25, 0.4], [0.05, 0.09, 0.085]);
  const heldShell = group(leftHand, [0, 0.03, 0]);
  tube(heldShell, mat.shellRed, 0.0095, 0.055, [0, 0, 0]);
  tube(heldShell, mat.brass, 0.01, 0.014, [0, 0, 0.032]);
  heldShell.visible = false;
  box(R, mat.polymer, [0.024, 0.022, 0.05], [0, -0.012, -0.6]);
  box(R, mat.darkHole, [0.002, 0.022, 0.06], [0.0255, 0.03, -0.05]); // ejection port
  box(R, mat.darkHole, [0.026, 0.002, 0.07], [0, -0.0135, -0.06]); // loading port
  box(R, mat.steel, [0.014, 0.006, 0.01], [0, 0.06, 0.04]); // tang safety
  box(R, mat.gunmetal, [0.006, 0.004, 0.5], [0, 0.058, -0.43]); // vent rib
  for (let z = -0.22; z > -0.66; z -= 0.04) box(R, mat.gunmetal, [0.004, 0.0035, 0.004], [0, 0.0545, z]);
  ringZ(R, mat.gunmetal, 0.013, 0.006, [0, 0.008, -0.58]); // mag tube cap
  box(R, mat.gunmetal, [0.03, 0.04, 0.02], [0, 0.024, -0.58]); // barrel clamp
  triggerGuard(R, mat.gunmetal, -0.055, 0.0, -0.014, 0.032);
  slingLoop(R, [0, -0.008, -0.6]);
  slingLoop(R, [0, -0.072, 0.27]);
  rivets(R, mat.steel, [[0.026, 0.03, -0.12], [0.026, 0.03, 0.02], [-0.026, 0.03, -0.12], [-0.026, 0.03, 0.02]], 0.003);
  return rig(R, {
    muzzle: point(R, [0, 0.042, -0.7]),
    ejectPort: point(R, [0.028, 0.035, -0.05]),
    laser: point(R, [0, -0.012, -0.626]),
    sight: point(R, [0, 0.064, 0.0]),
    mag: null, bolt: null, pump, leftHand, rightHand, heldShell, shellType: 'shotgun',
    butt: [0, -0.02, 0.345],
  });
}

// ------------------------------------------------------------------ newer guns

/** MP5A3: roller-delayed 9 mm, slim curved mag, drum diopter + hooded post, sliding stock. 0.7 m. */
function buildMP5(): WeaponRig {
  const R = new THREE.Group();
  const B = mat.black;
  // Round-topped stamped receiver + cocking tube running over the barrel.
  box(R, B, [0.044, 0.046, 0.3], [0, 0.023, -0.08]);
  tube(R, B, 0.022, 0.3, [0, 0.048, -0.08]);
  tube(R, B, 0.014, 0.17, [0, 0.058, -0.31]);
  box(R, B, [0.02, 0.022, 0.03], [0, 0.04, -0.235]);
  // Fat tropical handguard with finger ribs.
  profile(R, mat.polymer, [[-0.22, 0.052], [-0.37, 0.05], [-0.38, 0.03], [-0.37, -0.012], [-0.24, -0.016], [-0.22, -0.004]], 0.06);
  row(R, mat.black, 5, [0.062, 0.003, 0.008], [0, -0.01, -0.25], [0, 0, -0.026]);
  // Barrel, three-lug muzzle, hooded front post on the cocking tube.
  tube(R, mat.blued, 0.0105, 0.11, [0, 0.03, -0.43]);
  tube(R, mat.blued, 0.0135, 0.034, [0, 0.03, -0.47]);
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) box(R, mat.blued, [0.006, 0.006, 0.012], [Math.sin(a) * 0.015, 0.03 + Math.cos(a) * 0.015, -0.462]);
  box(R, B, [0.016, 0.03, 0.022], [0, 0.077, -0.38]);
  ringZ(R, B, 0.013, 0.006, [0, 0.1, -0.38]);
  ironFront(R, -0.38, 0.1, 0.088);
  // Rear drum diopter: the aperture ring frames the front post.
  box(R, B, [0.034, 0.018, 0.026], [0, 0.074, 0.03]);
  tube(R, B, 0.011, 0.03, [0, 0.082, 0.03]).rotation.set(0, 0, Math.PI / 2);
  box(R, B, [0.004, 0.016, 0.004], [0, 0.09, 0.018]);
  ringZ(R, B, 0.007, 0.004, [0, 0.1, 0.018]);
  const sight = point(R, [0, 0.1, 0.018]);
  // Lower: trigger housing, raked grip, guard, paddle selector.
  box(R, mat.polymer, [0.04, 0.03, 0.13], [0, -0.012, -0.015]);
  profile(R, mat.polymer, [[-0.005, -0.02], [0.042, -0.02], [0.07, -0.118], [0.048, -0.128], [0.024, -0.12], [0.004, -0.064]], 0.032);
  for (let i = 0; i < 4; i++) box(R, mat.polymer, [0.034, 0.003, 0.005], [0, -0.045 - i * 0.018, 0.034 + i * 0.006], [0.3, 0, 0]);
  box(R, mat.blued, [0.008, 0.024, 0.04], [0, -0.034, -0.04]);
  triggerGuard(R, mat.polymer, -0.07, -0.004, -0.027, 0.03);
  box(R, mat.steel, [0.004, 0.012, 0.03], [-0.022, 0.0, 0.01], [-0.4, 0, 0]);
  // Mag well + slim curved 30-rounder.
  box(R, B, [0.034, 0.03, 0.05], [0, -0.012, -0.13]);
  const mag = group(R, [0, -0.02, -0.13]);
  curvedMag(mag, mat.blued, 4, 0.024, 0.042, 0.06, 0.048);
  // Charging handle: left side, forward on the cocking tube.
  const bolt = group(R, [-0.018, 0.058, -0.29]);
  box(bolt, mat.steel, [0.022, 0.01, 0.012], [-0.012, 0, 0]);
  // A3 sliding stock: two struts and a butt plate.
  box(R, B, [0.046, 0.06, 0.02], [0, 0.025, 0.075]);
  for (const sx of [-1, 1]) {
    tube(R, mat.blued, 0.005, 0.22, [0.019 * sx, 0.048, 0.185]);
    tube(R, mat.blued, 0.005, 0.22, [0.019 * sx, -0.004, 0.185]);
  }
  box(R, mat.blued, [0.05, 0.1, 0.012], [0, 0.015, 0.29]);
  box(R, mat.rubber, [0.046, 0.096, 0.012], [0, 0.015, 0.302]);
  box(R, mat.darkHole, [0.002, 0.016, 0.04], [0.0225, 0.042, -0.06]); // ejection port
  rivets(R, mat.steel, [[0.023, 0.02, -0.2], [-0.023, 0.02, -0.2], [0.023, 0.02, 0.05], [-0.023, 0.02, 0.05]]);
  slingLoop(R, [0.0, 0.07, -0.33]);
  const rightHand = hand(R, [0, -0.064, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.008, -0.31], [-0.22, -0.26, -0.02], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.49]),
    ejectPort: point(R, [0.024, 0.042, -0.06]),
    laser: point(R, [0.034, 0.02, -0.3]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'pistol',
    butt: [0, 0.015, 0.3],
  });
}

/** G18C machine pistol: polymer frame, ported slide, selector, 33-round stick. 0.19 m. */
function buildGlock(): WeaponRig {
  const R = new THREE.Group();
  const P = mat.polymer;
  box(R, P, [0.03, 0.026, 0.17], [0, 0.002, -0.07]);
  box(R, P, [0.03, 0.11, 0.048], [0, -0.058, 0.01], [0.3, 0, 0]);
  box(R, mat.steel, [0.006, 0.024, 0.008], [0, -0.022, -0.042]);
  tube(R, mat.steel, 0.009, 0.03, [0, 0.03, -0.17]);
  const slide = group(R, [0, 0, 0]);
  box(slide, mat.black, [0.034, 0.034, 0.19], [0, 0.032, -0.07]);
  for (const sx of [-1, 1]) row(slide, mat.darkHole, 6, [0.002, 0.02, 0.003], [0.0171 * sx, 0.032, 0.008], [0, 0, 0.0055]);
  box(slide, mat.darkHole, [0.003, 0.012, 0.03], [0.0172, 0.04, -0.045]); // ejection port
  row(slide, mat.darkHole, 3, [0.008, 0.003, 0.007], [0, 0.0495, -0.125], [0, 0, -0.012]); // compensator cuts
  box(slide, mat.steel, [0.004, 0.012, 0.012], [-0.019, 0.034, 0.012]); // selector switch
  box(slide, mat.black, [0.009, 0.016, 0.008], [0.0095, 0.054, 0.02]);
  box(slide, mat.black, [0.009, 0.016, 0.008], [-0.0095, 0.054, 0.02]);
  box(slide, mat.black, [0.0055, 0.016, 0.006], [0, 0.053, -0.15]);
  const frontDot = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 10), mat.bead);
  frontDot.position.set(0, 0.0575, -0.1465);
  slide.add(frontDot);
  for (const x of [0.0095, -0.0095]) {
    const rearDot = new THREE.Mesh(new THREE.CircleGeometry(0.0018, 8), mat.bead);
    rearDot.position.set(x, 0.0575, 0.0242);
    slide.add(rearDot);
  }
  // Extended magazine sticks well out of the grip.
  const mag = group(R, [0, -0.03, 0.0]);
  box(mag, mat.gunmetal, [0.026, 0.16, 0.04], [0, -0.07, 0.019], [0.3, 0, 0]);
  box(mag, P, [0.03, 0.012, 0.05], [0, -0.152, 0.045], [0.3, 0, 0]);
  const rightHand = hand(R, [0, -0.06, 0.025], [0.08, -0.24, 0.36], [0.05, 0.09, 0.08]);
  const leftHand = hand(R, [-0.025, -0.075, 0.015], [-0.18, -0.25, 0.32], [0.05, 0.075, 0.08]);
  box(R, P, [0.026, 0.006, 0.06], [0, -0.012, -0.115]); // accessory rail
  row(R, mat.black, 3, [0.027, 0.003, 0.006], [0, -0.006, -0.1], [0, 0, -0.015]);
  triggerGuard(R, P, -0.065, -0.02, -0.012, 0.03);
  for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) box(R, mat.black, [0.002, 0.012, 0.03], [0.0155 * sx, -0.04 - i * 0.017, 0.008 + i * 0.005], [0.3, 0, 0]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.185]),
    ejectPort: point(R, [0.02, 0.045, -0.05]),
    laser: point(R, [0, -0.02, -0.13]),
    sight: point(R, [0, 0.0575, 0.02]), // three dots level: the front dot is the aim
    mag, bolt: slide, pump: null, leftHand, rightHand, heldShell: null, shellType: 'pistol',
    butt: [0, -0.06, 0.06],
  });
}

/** Saiga-12K: AK-pattern 12 gauge, black polymer furniture, fat box mag, folding stock. 0.91 m. */
function buildSaiga(): WeaponRig {
  const R = new THREE.Group();
  box(R, mat.blued, [0.054, 0.076, 0.28], [0, 0.025, -0.06]);
  box(R, mat.blued, [0.056, 0.022, 0.22], [0, 0.072, -0.04]);
  box(R, mat.blued, [0.04, 0.026, 0.05], [0, 0.074, -0.18]);
  const sight = ironRear(R, -0.2, 0.098);
  row(R, mat.blued, 4, [0.058, 0.003, 0.006], [0, 0.084, 0.04], [0, 0, -0.035]);
  // Polymer handguards around a thick barrel + gas tube.
  tube(R, mat.blued, 0.012, 0.17, [0, 0.07, -0.295]);
  profile(R, mat.polymer, [[-0.215, 0.062], [-0.37, 0.062], [-0.375, 0.076], [-0.36, 0.09], [-0.225, 0.09], [-0.21, 0.078]], 0.044);
  profile(R, mat.polymer, [[-0.205, 0.05], [-0.398, 0.048], [-0.398, -0.002], [-0.37, -0.014], [-0.3, -0.008], [-0.24, -0.014], [-0.205, -0.006]], 0.062);
  for (const sx of [-1, 1]) row(R, mat.darkHole, 4, [0.002, 0.012, 0.024], [0.031 * sx, 0.024, -0.235], [0, 0, -0.04]);
  tube(R, mat.blued, 0.015, 0.2, [0, 0.03, -0.5]);
  box(R, mat.blued, [0.03, 0.05, 0.034], [0, 0.056, -0.42]); // gas block
  box(R, mat.blued, [0.026, 0.05, 0.03], [0, 0.058, -0.56]);
  ironFront(R, -0.565, 0.098, 0.083);
  tube(R, mat.gunmetal, 0.018, 0.035, [0, 0.03, -0.615]); // thread protector
  // Side-folding polymer stock, AK grip, guard.
  profile(R, mat.polymer, [[0.075, 0.036], [0.31, 0.012], [0.316, -0.1], [0.2, -0.07], [0.13, -0.038], [0.075, -0.012]], 0.04);
  box(R, mat.rubber, [0.044, 0.116, 0.014], [0, -0.044, 0.318], [0.02, 0, 0]);
  box(R, mat.blued, [0.05, 0.05, 0.02], [0, 0.012, 0.085]); // hinge block
  profile(R, mat.polymer, [[-0.005, -0.008], [0.04, -0.008], [0.072, -0.105], [0.05, -0.118], [0.026, -0.112], [0.006, -0.06]], 0.032);
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.022, -0.03]);
  triggerGuard(R, mat.blued, -0.07, 0.0, -0.013, 0.034);
  box(R, mat.blued, [0.004, 0.014, 0.12], [0.029, 0.036, -0.03], [-0.08, 0, 0]); // selector lever
  box(R, mat.blued, [0.022, 0.012, 0.014], [0, -0.036, -0.075]); // mag catch
  // Wide box magazine: eight 12 ga shells.
  const mag = group(R, [0, -0.012, -0.125]);
  curvedMag(mag, mat.black, 4, 0.044, 0.088, 0.035, 0.05);
  box(mag, mat.black, [0.05, 0.012, 0.096], [0, -0.19, -0.034], [0.15, 0, 0]);
  const bolt = group(R, [0.034, 0.04, -0.1]);
  box(bolt, mat.steel, [0.022, 0.012, 0.03], [0.008, 0, 0]);
  box(bolt, mat.steel, [0.008, 0.018, 0.02], [0.02, 0.004, 0.0]);
  for (const sx of [-1, 1]) rivets(R, mat.steel, [[0.028 * sx, 0.04, -0.18], [0.028 * sx, 0.01, -0.18], [0.028 * sx, 0.04, 0.06], [0.028 * sx, 0.01, 0.06]]);
  box(R, mat.blued, [0.004, 0.022, 0.1], [-0.029, 0.024, 0.0]);
  slingLoop(R, [-0.02, 0.044, -0.42]);
  const rightHand = hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.026, -0.31], [-0.22, -0.26, -0.02], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.635]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.04, 0.012, -0.36]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'shotgun',
    butt: [0, -0.024, 0.32],
  });
}

/** SVD Dragunov: long DMR, skeleton thumbhole stock, slotted handguard, 10-round mag. 1.22 m. */
function buildSVD(): WeaponRig {
  const R = new THREE.Group();
  const W = mat.akWood;
  box(R, mat.blued, [0.05, 0.07, 0.28], [0, 0.025, -0.06]);
  box(R, mat.blued, [0.052, 0.022, 0.22], [0, 0.07, -0.04]);
  box(R, mat.blued, [0.04, 0.026, 0.05], [0, 0.072, -0.18]);
  const sight = ironRear(R, -0.2, 0.096);
  row(R, mat.blued, 4, [0.054, 0.003, 0.006], [0, 0.082, 0.04], [0, 0, -0.035]);
  box(R, mat.blued, [0.006, 0.03, 0.16], [-0.028, 0.03, -0.05]); // side scope rail
  row(R, mat.darkHole, 4, [0.002, 0.004, 0.02], [-0.0312, 0.03, 0.01], [0, 0, -0.035]);
  // Slotted wooden handguard, long barrel, gas block, front sight, slotted flash hider.
  tube(R, mat.blued, 0.012, 0.3, [0, 0.07, -0.36]);
  box(R, W, [0.058, 0.07, 0.3], [0, 0.042, -0.36]);
  for (const sx of [-1, 1]) row(R, mat.darkHole, 5, [0.002, 0.022, 0.03], [0.0295 * sx, 0.048, -0.25], [0, 0, -0.055]);
  box(R, mat.blued, [0.062, 0.074, 0.012], [0, 0.042, -0.21]);
  box(R, mat.blued, [0.062, 0.074, 0.012], [0, 0.042, -0.512]);
  tube(R, mat.blued, 0.011, 0.36, [0, 0.03, -0.69]);
  box(R, mat.blued, [0.03, 0.05, 0.04], [0, 0.05, -0.54]); // gas block
  box(R, mat.blued, [0.022, 0.04, 0.024], [0, 0.06, -0.8]);
  ironFront(R, -0.805, 0.096, 0.08);
  tube(R, mat.blued, 0.015, 0.09, [0, 0.03, -0.9]);
  for (const sx of [-1, 1]) row(R, mat.darkHole, 1, [0.002, 0.008, 0.06], [0.0152 * sx, 0.03, -0.905], [0, 0, 0]);
  // Skeleton thumbhole stock: comb strut, grip, lower strut, butt, cheek pad.
  profile(R, W, [[0.07, 0.04], [0.31, 0.034], [0.31, 0.004], [0.12, 0.008], [0.07, 0.014]], 0.044);
  profile(R, W, [[0.24, 0.034], [0.33, 0.034], [0.335, -0.125], [0.22, -0.125], [0.25, -0.08]], 0.044);
  profile(R, W, [[0.06, -0.09], [0.24, -0.1], [0.24, -0.125], [0.07, -0.118]], 0.04);
  profile(R, W, [[-0.005, -0.008], [0.04, -0.008], [0.075, -0.1], [0.07, -0.118], [0.026, -0.112], [0.006, -0.06]], 0.034);
  box(R, mat.rubber, [0.046, 0.165, 0.012], [0, -0.045, 0.338]);
  box(R, mat.polymer, [0.048, 0.02, 0.09], [0, 0.046, 0.25]); // cheek pad
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.022, -0.03]);
  triggerGuard(R, mat.blued, -0.07, 0.0, -0.011, 0.034);
  box(R, mat.blued, [0.004, 0.014, 0.12], [0.027, 0.036, -0.03], [-0.08, 0, 0]);
  const mag = group(R, [0, -0.012, -0.12]);
  ribbedMag(mag, mat.blued, 4, 0.03, 0.06, 0.03, 0.033);
  const bolt = group(R, [0.032, 0.04, -0.1]);
  box(bolt, mat.steel, [0.022, 0.012, 0.03], [0.008, 0, 0]);
  box(bolt, mat.steel, [0.008, 0.018, 0.02], [0.02, 0.004, 0.0]);
  for (const sx of [-1, 1]) rivets(R, mat.steel, [[0.026 * sx, 0.04, -0.18], [0.026 * sx, 0.01, -0.18], [0.026 * sx, 0.04, 0.06], [0.026 * sx, 0.01, 0.06]]);
  slingLoop(R, [0.0, 0.0, -0.5]);
  slingLoop(R, [0.0, -0.13, 0.28]);
  const rightHand = hand(R, [0, -0.06, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.012, -0.36], [-0.22, -0.26, -0.04], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.95]),
    ejectPort: point(R, [0.03, 0.04, -0.06]),
    laser: point(R, [0.034, 0.042, -0.4]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
    butt: [0, -0.045, 0.335],
  });
}

/** M249 SAW: box receiver with feed cover, carry handle, folded bipod, 100-round soft pouch. 1.04 m. */
function buildM249(): WeaponRig {
  const R = new THREE.Group();
  const B = mat.black;
  box(R, B, [0.062, 0.09, 0.32], [0, 0.025, -0.1]);
  box(R, mat.parkerized, [0.066, 0.024, 0.2], [0, 0.08, -0.13]); // feed tray cover
  box(R, mat.parkerized, [0.07, 0.01, 0.03], [0, 0.07, -0.03]); // cover latch
  const sight = ironRear(R, -0.03, 0.118);
  box(R, B, [0.03, 0.022, 0.03], [0, 0.098, -0.03]);
  box(R, mat.brass, [0.016, 0.03, 0.08], [-0.036, 0.05, -0.15]); // belt entering the feed tray
  row(R, mat.brass, 4, [0.022, 0.008, 0.008], [-0.04, 0.03, -0.18], [0, 0, 0.02]);
  // Barrel, heat shield, gas tube, handguard, carry handle.
  tube(R, mat.blued, 0.013, 0.46, [0, 0.03, -0.49]);
  box(R, B, [0.034, 0.006, 0.2], [0, 0.05, -0.38]);
  row(R, mat.darkHole, 6, [0.02, 0.002, 0.012], [0, 0.0535, -0.3], [0, 0, -0.03]);
  tube(R, B, 0.01, 0.34, [0, -0.002, -0.43]);
  box(R, mat.polymer, [0.064, 0.05, 0.16], [0, 0.0, -0.34]);
  row(R, B, 5, [0.066, 0.003, 0.006], [0, -0.02, -0.28], [0, 0, -0.03]);
  box(R, B, [0.008, 0.04, 0.012], [0.038, 0.05, -0.33]);
  box(R, B, [0.008, 0.04, 0.012], [0.038, 0.05, -0.45]);
  box(R, B, [0.012, 0.012, 0.14], [0.042, 0.075, -0.39]);
  box(R, B, [0.016, 0.04, 0.03], [0, 0.04, -0.69]);
  ironFront(R, -0.69, 0.118, 0.06);
  box(R, B, [0.012, 0.048, 0.02], [0, 0.082, -0.69]); // post block, top 1 cm under the line
  tube(R, mat.blued, 0.016, 0.06, [0, 0.03, -0.745]);
  row(R, mat.darkHole, 3, [0.034, 0.004, 0.008], [0, 0.03, -0.73], [0, 0, -0.014]);
  // Folded bipod under the barrel.
  box(R, B, [0.04, 0.02, 0.03], [0, 0.008, -0.62]);
  for (const sx of [-1, 1]) box(R, mat.blued, [0.01, 0.012, 0.24], [0.016 * sx, -0.012, -0.5]);
  // Stock, grip, trigger guard.
  profile(R, mat.polymer, [[0.06, 0.066], [0.33, 0.046], [0.336, -0.085], [0.2, -0.052], [0.06, -0.016]], 0.046);
  row(R, mat.black, 4, [0.048, 0.003, 0.012], [0, 0.058, 0.12], [0, 0, 0.05]);
  box(R, mat.rubber, [0.05, 0.14, 0.014], [0, -0.018, 0.338]);
  profile(R, mat.polymer, [[-0.005, -0.018], [0.04, -0.018], [0.072, -0.115], [0.05, -0.128], [0.026, -0.122], [0.006, -0.07]], 0.032);
  box(R, mat.blued, [0.008, 0.026, 0.05], [0, -0.032, -0.03]);
  triggerGuard(R, B, -0.07, 0.0, -0.02, 0.032);
  // 100-round soft ammo pouch (the "magazine").
  const mag = group(R, [0, -0.02, -0.15]);
  box(mag, mat.olive, [0.08, 0.13, 0.14], [-0.012, -0.075, 0]);
  box(mag, mat.olive, [0.084, 0.012, 0.144], [-0.012, -0.004, 0]);
  box(mag, mat.black, [0.02, 0.024, 0.06], [0.03, -0.03, 0]);
  rivets(mag, mat.steel, [[0.029, -0.07, 0.05], [0.029, -0.07, -0.05]], 0.004);
  const bolt = group(R, [0.034, 0.02, -0.19]);
  box(bolt, mat.steel, [0.02, 0.014, 0.022], [0.008, 0, 0]);
  rivets(R, mat.steel, [[0.032, 0.0, -0.24], [0.032, 0.05, -0.24], [-0.032, 0.0, -0.24], [-0.032, 0.05, -0.24], [0.032, 0.0, 0.04], [-0.032, 0.0, 0.04]]);
  slingLoop(R, [0, -0.07, 0.25]);
  const rightHand = hand(R, [0, -0.07, 0.035], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, -0.026, -0.36], [-0.22, -0.26, -0.06], [0.056, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.03, -0.78]),
    ejectPort: point(R, [0.012, -0.02, -0.08]),
    laser: point(R, [0.034, 0.01, -0.4]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
    butt: [0, -0.018, 0.335],
  });
}

/** SCAR-H: FDE monolithic upper with a full-length rail, holo sight, folding stock, 20-round mag. 0.97 m. */
function buildSCARH(): WeaponRig {
  const R = new THREE.Group();
  const T = mat.tan;
  box(R, T, [0.052, 0.05, 0.5], [0, 0.06, -0.17]);
  box(R, mat.black, [0.026, 0.012, 0.52], [0, 0.091, -0.17]);
  railTeeth(R, 0.08, -0.42, 0.097);
  const sight = holoSight(R, -0.04, 0.097);
  for (const sx of [-1, 1]) {
    box(R, mat.black, [0.008, 0.016, 0.16], [0.03 * sx, 0.055, -0.33]); // side rails
    row(R, mat.darkHole, 4, [0.002, 0.01, 0.02], [0.0262 * sx, 0.055, -0.21], [0, 0, -0.045]);
  }
  box(R, mat.black, [0.03, 0.01, 0.16], [0, 0.03, -0.33]); // bottom rail
  // Barrel, gas block, flash hider.
  tube(R, mat.blued, 0.012, 0.16, [0, 0.06, -0.5]);
  box(R, mat.black, [0.03, 0.03, 0.03], [0, 0.068, -0.44]);
  tube(R, mat.black, 0.015, 0.06, [0, 0.06, -0.6]);
  row(R, mat.darkHole, 3, [0.032, 0.004, 0.008], [0, 0.06, -0.585], [0, 0, -0.014]);
  // Black lower, grip, guard, flared mag well.
  box(R, mat.black, [0.046, 0.05, 0.2], [0, 0.01, -0.06]);
  box(R, mat.black, [0.034, 0.085, 0.045], [0, -0.058, 0.025], [0.32, 0, 0]);
  for (const sx of [-1, 1]) box(R, mat.polymer, [0.002, 0.06, 0.03], [0.0175 * sx, -0.06, 0.028], [0.32, 0, 0]);
  box(R, mat.black, [0.008, 0.026, 0.05], [0, -0.026, -0.03]);
  triggerGuard(R, mat.black, -0.068, 0.0, -0.015, 0.03);
  box(R, mat.black, [0.052, 0.03, 0.034], [0, -0.022, -0.11], [0.2, 0, 0]);
  box(R, mat.black, [0.003, 0.004, 0.018], [-0.024, 0.02, 0.015]); // selector
  // Folding stock: hinge, FDE body with a cheek riser, black butt pad.
  box(R, mat.black, [0.046, 0.05, 0.024], [0, 0.06, 0.09]);
  profile(R, T, [[0.1, 0.085], [0.34, 0.077], [0.345, -0.07], [0.3, -0.07], [0.24, -0.006], [0.14, 0.012], [0.1, 0.03]], 0.04);
  box(R, T, [0.042, 0.018, 0.12], [0, 0.092, 0.22]);
  box(R, mat.rubber, [0.044, 0.155, 0.016], [0, 0.005, 0.35]);
  box(R, mat.darkHole, [0.002, 0.014, 0.05], [0.0262, 0.058, -0.05]); // ejection port
  // 20-round 7.62 mag.
  const mag = group(R, [0, -0.015, -0.11]);
  curvedMag(mag, mat.black, 3, 0.03, 0.072, 0.025, 0.055);
  box(mag, mat.black, [0.036, 0.01, 0.08], [0, -0.165, -0.008], [0.05, 0, 0]);
  // Reciprocating charging handle, left side.
  const bolt = group(R, [-0.03, 0.068, -0.24]);
  box(bolt, mat.black, [0.022, 0.012, 0.016], [-0.01, 0, 0]);
  rivets(R, mat.steel, [[0.027, 0.07, 0.02], [-0.027, 0.07, 0.02], [0.027, 0.07, -0.38], [-0.027, 0.07, -0.38]]);
  slingLoop(R, [0.024, 0.06, 0.3]);
  const rightHand = hand(R, [0, -0.058, 0.03], [0.1, -0.25, 0.36], [0.05, 0.085, 0.085]);
  const leftHand = hand(R, [-0.005, 0.0, -0.33], [-0.22, -0.24, -0.04], [0.055, 0.05, 0.1]);
  return rig(R, {
    muzzle: point(R, [0, 0.06, -0.632]),
    ejectPort: point(R, [0.028, 0.058, -0.05]),
    laser: point(R, [0.036, 0.055, -0.33]),
    sight, mag, bolt, pump: null, leftHand, rightHand, heldShell: null, shellType: 'rifle',
    butt: [0, 0.02, 0.35],
  });
}

const BUILDERS: Record<ModelKey, () => WeaponRig> = {
  ak47: buildAK47,
  mk47: buildMK47,
  asval: buildASVAL,
  m4a1: buildM4A1,
  rd704: buildRD704,
  ppsh: buildPPSh,
  mosin: buildMosin,
  kar98: buildKar98,
  pistol: buildPistol,
  shotgun: buildShotgun,
  mp5: buildMP5,
  glock: buildGlock,
  saiga: buildSaiga,
  svd: buildSVD,
  m249: buildM249,
  scarh: buildSCARH,
};

/**
 * `world`: a third-person gun (the light model file). A model from public/guns replaces
 * the procedural looks when there is one (see WeaponMeshes).
 */
export function buildWeaponModel(model: ModelKey, low = false, world = low): WeaponRig {
  LOW = low;
  try {
    const r = BUILDERS[model]();
    dressRig(r, model, world);
    r.root.traverse((o) => {
      o.frustumCulled = false;
    });
    return r;
  } finally {
    LOW = false;
  }
}

/** One material for every baked third-person rig (colours live in the vertices). */
const bakedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });

/**
 * Third-person weapon: every static part merged into ONE mesh (material colours
 * baked into vertex colours), the magazine into another (it hides during
 * reloads). ~100 parts → 2 draw calls per soldier. Glass and reticles are dropped
 * (invisible at that range); hands stay as IK points.
 */
export function bakeRig(rig: WeaponRig): void {
  const root = rig.root;
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const mag = rig.mag ?? null;
  const magInv = mag ? new THREE.Matrix4().copy(mag.matrixWorld).invert() : null;
  const under = (o: THREE.Object3D, anc: THREE.Object3D | null) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === anc) return true;
    return false;
  };
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  const statics: THREE.BufferGeometry[] = [];
  const mags: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  for (const m of meshes) {
    if (under(m, rig.leftHand) || under(m, rig.rightHand)) continue;
    // A real model (textured, one or two meshes already) stays as it is.
    if (m.userData.gunModel) continue;
    const mt = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    const inMag = !!mag && under(m, mag);
    if (m !== mag) m.removeFromParent();
    if (mt.transparent || !m.visible) continue;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.applyMatrix4(m4.multiplyMatrices(inMag ? magInv! : rootInv, m.matrixWorld));
    const glow = mt.emissive && mt.emissiveIntensity > 0.5;
    const c = glow ? mt.emissive : (mt.color ?? new THREE.Color(1, 1, 1));
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (inMag ? mags : statics).push(g);
  }
  if (statics.length) {
    const merged = mergeGeometries(statics, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, bakedMat);
      mesh.frustumCulled = false;
      root.add(mesh);
    }
  }
  if (mag && mags.length) {
    const merged = mergeGeometries(mags, false);
    if (merged) {
      if ((mag as THREE.Mesh).isMesh) {
        (mag as THREE.Mesh).geometry = merged;
        (mag as THREE.Mesh).material = bakedMat;
      } else {
        const mesh = new THREE.Mesh(merged, bakedMat);
        mesh.frustumCulled = false;
        mag.add(mesh);
      }
    }
  }
}

/**
 * Baked third-person rigs, built once per `${model}|${low}` and handed out as
 * clones: every copy is meshes over the same (shared) geometry, so re-arming a
 * soldier or hanging another wall buy allocates no GPU buffers. Never dispose
 * the geometry of a rig that came from here.
 */
const bakedTemplates = new Map<string, WeaponRig>();

function cloneRig(t: WeaponRig): WeaponRig {
  const root = t.root.clone(true);
  // Same hierarchy, same traversal order: pair every template node with its copy.
  const src: THREE.Object3D[] = [];
  t.root.traverse((o) => src.push(o));
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  let i = 0;
  root.traverse((o) => map.set(src[i++], o));
  // A part the bake took out of the tree (a moving part that was a plain mesh): detached copy.
  const m = <T extends THREE.Object3D | null>(o: T): T => (o ? ((map.get(o) ?? o.clone(false)) as T) : o);
  return {
    ...t,
    root,
    muzzle: m(t.muzzle),
    ejectPort: m(t.ejectPort),
    sight: m(t.sight),
    mag: m(t.mag),
    bolt: m(t.bolt),
    pump: m(t.pump),
    leftHand: m(t.leftHand),
    rightHand: m(t.rightHand),
    heldShell: m(t.heldShell),
    laser: m(t.laser),
    leftHandRest: t.leftHandRest.clone(),
    rightHandRest: t.rightHandRest.clone(),
    butt: t.butt.clone(),
  };
}

/** Third-person weapon (baked, hands hidden) over cached geometry. See bakeRig. */
export function bakedRig(model: ModelKey, low = false): WeaponRig {
  const key = `${model}|${low}`;
  let t = bakedTemplates.get(key);
  if (!t) {
    t = buildWeaponModel(model, low, true);
    bakeRig(t);
    t.leftHand.visible = false;
    t.rightHand.visible = false;
    bakedTemplates.set(key, t);
  }
  return cloneRig(t);
}

/**
 * Merge a rig's static parts (direct mesh children of the root) per material.
 * Moving parts (mag, bolt, pump, hands) and attachment points are left alone.
 * The detailed models have ~100 parts: on AI soldiers that would be ~100 draw
 * calls each; merged it's ~10.
 */
export function compactRig(rig: WeaponRig): void {
  const root = rig.root;
  const keep = new Set<THREE.Object3D>([rig.mag, rig.bolt, rig.pump, rig.leftHand, rig.rightHand, rig.muzzle, rig.ejectPort, rig.sight, rig.laser].filter((o): o is THREE.Object3D => !!o));
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const drop: THREE.Object3D[] = [];
  for (const c of root.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || keep.has(m)) continue;
    m.updateMatrix();
    let g = m.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.applyMatrix4(m.matrix);
    const mt = m.material as THREE.Material;
    byMat.set(mt, [...(byMat.get(mt) ?? []), g]);
    drop.push(m);
  }
  for (const m of drop) root.remove(m);
  for (const [mt, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mt);
    mesh.frustumCulled = false;
    root.add(mesh);
  }
}

/**
 * First-person rig: ~60 parts, each its own draw call, on screen every frame.
 * Every visible part is merged per material into the nearest moving node above it
 * (the root, magazine, bolt, pump, hands, held shell): ~60 draw calls → ~15, the
 * same look. A part with a moving node, an attachment point or a hidden part
 * below it stays as is, and so does anything hidden at build time. The merged
 * originals are hidden, not removed, so attachment points keep their place.
 */
export function compactViewRig(rig: WeaponRig): void {
  const anchors = new Set<THREE.Object3D>([rig.root, rig.mag, rig.bolt, rig.pump, rig.leftHand, rig.rightHand, rig.heldShell].filter((o): o is THREE.Object3D => !!o));
  const points = new Set<THREE.Object3D>([rig.muzzle, rig.ejectPort, rig.sight, rig.laser]);
  rig.root.updateMatrixWorld(true);
  const visibleUnder = (o: THREE.Object3D, top: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p && p !== top.parent; p = p.parent) if (!p.visible) return false;
    return true;
  };
  // Each mesh's nearest anchor (itself excluded); meshes holding an anchor or a point below them stay.
  const groups = new Map<THREE.Object3D, Map<THREE.Material, THREE.Mesh[]>>();
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || anchors.has(m) || Array.isArray(m.material)) return;
    let holds = false;
    m.traverse((c) => {
      if (c !== m && (anchors.has(c) || points.has(c) || !c.visible)) holds = true;
    });
    if (holds) return;
    let a: THREE.Object3D | null = m.parent;
    while (a && !anchors.has(a)) a = a.parent;
    if (!a || !visibleUnder(m, rig.root)) return;
    const byMat = groups.get(a) ?? new Map<THREE.Material, THREE.Mesh[]>();
    groups.set(a, byMat);
    byMat.set(m.material, [...(byMat.get(m.material) ?? []), m]);
  });
  const m4 = new THREE.Matrix4();
  for (const [anchor, byMat] of groups) {
    const inv = new THREE.Matrix4().copy(anchor.matrixWorld).invert();
    for (const [mt, meshes] of byMat) {
      const geos: THREE.BufferGeometry[] = [];
      for (const m of meshes) {
        let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        g.applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
        geos.push(g);
      }
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mt);
      mesh.frustumCulled = false;
      mesh.castShadow = meshes[0].castShadow;
      mesh.renderOrder = meshes[0].renderOrder;
      anchor.add(mesh);
      for (const m of meshes) m.visible = false;
    }
  }
}

/** Shared materials for ejected shells (world space). */
export const shellMaterials = { brass: mat.brass, red: mat.shellRed };

/**
 * SABLE carbine for the AI: an all-black MK47-pattern rifle, hands
 * hidden (their positions stay as IK grip points), casting shadows in the world.
 */
export function buildEnemyRifle(low = false): WeaponRig {
  const key = `enemy|${low}`;
  let t = bakedTemplates.get(key);
  if (!t) {
    LOW = low;
    let r: WeaponRig;
    try {
      r = buildMK47();
    } finally {
      LOW = false;
    }
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material === mat.tan) m.material = mat.black;
    });
    if (dressRig(r, 'mk47', true)) {
      // The model's tan furniture blacked out.
      r.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData.gunModel) return;
        const dark = (m.material as THREE.MeshStandardMaterial).clone();
        dark.color.setRGB(0.3, 0.3, 0.3);
        m.material = dark;
      });
    }
    bakeRig(r);
    r.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    r.leftHand.visible = false;
    r.rightHand.visible = false;
    bakedTemplates.set(key, (t = r));
  }
  return cloneRig(t);
}
