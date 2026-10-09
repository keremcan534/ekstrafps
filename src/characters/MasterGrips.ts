import * as THREE from 'three';
import type { WeaponRig } from '../weapons/WeaponModels';
import type { ModelKey } from '../weapons/WeaponData';
import { worldFit } from '../weapons/WeaponMeshes';
import { gunGrips } from '../enemies/GunGrips';
import type { WeaponHoldDef } from './master/RifleHold';
import data from './master/masterRig.json';

/**
 * Where the master humanoid's hands go on a third-person gun (the game's baked rigs: barrel −Z,
 * up +Y, the gun's right side +X, metres, the rig root's space). Two frames, as in the lab:
 *
 *   right  the pistol grip's frame: RightHandWeaponSocket lands on it (origin on the grip's
 *          centre line at the middle finger, +Y up the grip, +Z forward toward the trigger).
 *   left   Hand_L's frame on the support: the left arm's IK target.
 *   butt   the point the stance puts in the shoulder.
 *
 * One source per gun (masterRig.json `game.grip`; no per-weapon hand code):
 *   1. weapon data: masterRig.json `weapons.<model>` (model space), carried onto the drawn gun by
 *      its model fit (WeaponMeshes.worldFit): the AK-47.
 *   2. fitted frames: masterRig.json `game.grip.fit.<model>` (the rig root's space), fitted on the
 *      drawn gun in the soldier lab (dev/masterGripFit.ts: fingertips, thumb and palm on its
 *      surface, nothing deep inside, the wrist and the reach in bounds).
 *   3. handguns: the grip frame from the rig's firing-hand point; two-handed, the support hand
 *      closes round the firing hand the mirror way (its LeftHandWeaponSocket a finger's width on).
 *   4. long guns with a pistol grip (GunGrips finds it on the drawn model): the rule fitted on the
 *      AK, the grip frame raked up the grip from its lowest point, the support wrist from the
 *      handguard's underside (the nearest real handguard: not the bare barrel, not a bipod).
 *   5. long guns without one (bolt actions, pump guns): the grip frame up the stock wrist at the
 *      rig's firing-hand point; the support at the rig's support-hand point, as for rifles.
 *
 * The frames are nodes under the rig's root, so they ride every recoil, carry and drop the gun
 * does. Measured once per gun model, the nodes made once per rig (cached on it).
 */
export type GripSource = 'data' | 'fit' | 'rule' | 'stock' | 'pistol';

export interface MasterGrip {
  pistol: boolean;
  source: GripSource;
  right: THREE.Object3D;
  left: THREE.Object3D;
  /** The left hand's palm on the support (rig root space): where a body without fingers would reach. */
  leftPalm: THREE.Vector3;
  butt: THREE.Vector3;
  /** Whether the support hand is on the gun in a carry ('aim', 'ready', 'low', 'high'). */
  twoHanded(carry: string): boolean;
}

interface Frames {
  pistol: boolean;
  source: GripSource;
  right: THREE.Matrix4;
  left: THREE.Matrix4;
  butt: THREE.Vector3;
}

const G = data.game.grip;
const WEAPONS = data.weapons as Record<string, WeaponHoldDef | undefined>;
/** Fitted frames per gun model: [x, y, z, qx, qy, qz, qw] in the rig root's space. */
const FITS = (G as { fit?: Record<string, { right: number[]; left: number[] } | undefined> }).fit ?? {};
const SOCKET = data.sockets.RightHandWeaponSocket;
const frames = new Map<string, Frames>();
const v = () => new THREE.Vector3();

/** The frames on `rig` (measured once per model; nodes made once per rig, under its root). */
export function masterGrip(rig: WeaponRig, model: ModelKey, low: boolean, pistol: boolean): MasterGrip {
  const cached = rig.root.userData.masterGrip as MasterGrip | undefined;
  if (cached && cached.pistol === pistol) return cached;
  const key = `${model}|${low}|${pistol}`;
  let f = frames.get(key);
  if (!f) frames.set(key, (f = measure(rig, model, low, pistol)));
  const node = (name: string, m: THREE.Matrix4) => {
    const o = (rig.root.getObjectByName(name) as THREE.Object3D | undefined) ?? new THREE.Object3D();
    o.name = name;
    m.decompose(o.position, o.quaternion, o.scale);
    rig.root.add(o);
    return o;
  };
  const right = node('MasterRightGrip', f.right);
  const left = node('MasterLeftGrip', f.left);
  // The palm: the closed hand's grip channel, where the mirrored weapon socket sits in the hand.
  const leftPalm = v().set(-SOCKET.position[0], SOCKET.position[1], SOCKET.position[2]).applyMatrix4(f.left);
  const twoHanded = (carry: string) => !f.pistol || G.pistol.twoHanded.includes(carry);
  const out: MasterGrip = { pistol: f.pistol, source: f.source, right, left, leftPalm, butt: f.butt.clone(), twoHanded };
  rig.root.userData.masterGrip = out;
  return out;
}

/** The grip frame raked `rakeDeg` toward the muzzle (+Y up the grip, +X the gun's left), at `origin`. */
function raked(origin: THREE.Vector3, rakeDeg: number): THREE.Matrix4 {
  const r = THREE.MathUtils.degToRad(rakeDeg);
  const x = v().set(-1, 0, 0);
  const y = v().set(0, Math.cos(r), -Math.sin(r));
  const z = v().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
}

/** Up a raked grip frame's axis by `along` from `low`. */
function rakedFrom(low: THREE.Vector3, rakeDeg: number, along: number): THREE.Matrix4 {
  const m = raked(v(), rakeDeg);
  return m.setPosition(low.clone().addScaledVector(v().setFromMatrixColumn(m, 1), along));
}

const frame = (p: THREE.Vector3, q: number[]) => new THREE.Matrix4().compose(p, new THREE.Quaternion().fromArray(q).normalize(), v().set(1, 1, 1));

/** A rig hand point (rest) in the root's space. */
function restPoint(rig: WeaponRig, hand: THREE.Object3D, rest: THREE.Vector3): THREE.Vector3 {
  rig.root.updateMatrixWorld(true);
  const parent = hand.parent ?? rig.root;
  return rest.clone().applyMatrix4(parent.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(rig.root.matrixWorld).invert());
}

/** The drawn gun's vertices near its centre plane (y, z pairs, root space), as GunGrips reads them. */
function profile(rig: WeaponRig): Float32Array {
  const root = rig.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const skip = new Set<THREE.Object3D>([rig.leftHand, rig.rightHand]);
  const m = new THREE.Matrix4();
  const p = v();
  const out: number[] = [];
  root.traverse((o) => {
    for (let q: THREE.Object3D | null = o; q && q !== root; q = q.parent) if (skip.has(q) || !q.visible) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material;
    if (!mat || mat.transparent || (mat as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos || pos.count < 24) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (Math.abs(p.x) < 0.05) out.push(p.y, p.z);
    }
  });
  return new Float32Array(out);
}

/** The lowest point within `half` of `z` from `top` down to `bottom` (Infinity: nothing there). */
function lowest(prof: Float32Array, z: number, top: number, bottom: number, half = 0.005): number {
  let low = Infinity;
  for (let i = 0; i < prof.length; i += 2) {
    const y = prof[i];
    if (Math.abs(prof[i + 1] - z) <= half && y < top && y > bottom && y < low) low = y;
  }
  return low;
}

/**
 * The support point: 12 mm under the handguard's underside, at `z` or the nearest slice within
 * `search` that is a handguard (its underside at least minDrop under the bore; anything hanging
 * more than maxDrop under the bore - a magazine, a bipod, a foregrip - is not it). Null: none.
 */
function supportAt(prof: Float32Array, bore: number, z: number): THREE.Vector3 | null {
  const h = G.rifle.handguard;
  for (let k = 0; k <= Math.round(h.search / 0.01); k++) {
    for (const dz of k ? [k * 0.01, -k * 0.01] : [0]) {
      // GunGrips' reading: the lowest underside within 3 cm either way.
      const under = lowest(prof, z + dz, bore, bore - h.maxDrop, 0.03);
      if (under < bore - h.minDrop) return v().set(0, under - 0.012, z + dz);
    }
  }
  return null;
}

function measure(rig: WeaponRig, model: ModelKey, low: boolean, pistol: boolean): Frames {
  const def = WEAPONS[model];
  const fit = def ? worldFit(model) : null;
  if (def && fit && !pistol) {
    // Model space → the rig: positions through the whole fit, frames turned by its rotation.
    const fq = new THREE.Quaternion();
    fit.decompose(v(), fq, v());
    const onRig = (f: { position: number[]; quaternion: number[] }) =>
      frame(v().fromArray(f.position).applyMatrix4(fit), fq.clone().multiply(new THREE.Quaternion().fromArray(f.quaternion).normalize()).toArray());
    return { pistol, source: 'data', right: onRig(def.rightGrip), left: onRig(def.leftGrip), butt: v().fromArray(def.butt).applyMatrix4(fit) };
  }
  const fitted = FITS[model];
  if (fitted) {
    const at = (a: number[]) => new THREE.Matrix4().compose(v().fromArray(a), new THREE.Quaternion().fromArray(a, 3).normalize(), v().set(1, 1, 1));
    return { pistol, source: 'fit', right: at(fitted.right), left: at(fitted.left), butt: rig.butt.clone() };
  }
  const rh = restPoint(rig, rig.rightHand, rig.rightHandRest);
  const lh = restPoint(rig, rig.leftHand, rig.leftHandRest);
  if (pistol) {
    const right = raked(rh.add(v().fromArray(G.pistol.rightOffset)), G.pistol.rakeDeg);
    // The support hand's socket a finger's width on from the grip frame, its wrist from there.
    const socket = new THREE.Matrix4().compose(
      v().set(-SOCKET.position[0], SOCKET.position[1], SOCKET.position[2]),
      new THREE.Quaternion(SOCKET.quaternion[0], -SOCKET.quaternion[1], -SOCKET.quaternion[2], SOCKET.quaternion[3]).normalize(),
      v().set(1, 1, 1),
    );
    const left = right.clone().multiply(frame(v().fromArray(G.pistol.supportOffset), G.pistol.supportQuaternion)).multiply(socket.invert());
    return { pistol, source: 'pistol', right, left, butt: rig.butt.clone() };
  }
  const prof = profile(rig);
  const bore = rig.muzzle.position.y;
  const g = gunGrips(`${model}|${low}|master`, rig);
  const support = supportAt(prof, bore, g ? g.support.z : lh.z) ?? (g ? g.support.clone() : lh.clone());
  const left = frame(support.add(v().fromArray(G.rifle.leftOffset)), G.rifle.leftQuaternion);
  if (g) return { pistol, source: 'rule', right: rakedFrom(g.gripLow, G.rifle.rakeDeg, G.rifle.along), left, butt: rig.butt.clone() };
  // No pistol grip: the hand round the stock's wrist, from its underside at the firing-hand point.
  const under = lowest(prof, rh.z, bore, bore - 0.2);
  const wrist = v().set(0, Number.isFinite(under) ? under : rh.y, rh.z);
  return { pistol, source: 'stock', right: rakedFrom(wrist, G.stock.rakeDeg, G.stock.along), left, butt: rig.butt.clone() };
}
