import * as THREE from 'three';
import type { WeaponRig } from '../weapons/WeaponModels';

/**
 * Where hands go on the gun as it is actually drawn. The rig's hand points belong to the
 * procedural gun; the model dressed over it (Meshy) has its pistol grip and handguard a few
 * centimetres elsewhere, so gloves placed on the rig's points floated beside the grip or sat
 * on the magazine. From the drawn geometry instead, in the rig's own frame (barrel towards
 * −z, up +y): the gun is cut into 1 cm slices along the barrel and each slice's lowest point
 * read. The magazine is the deepest hang (or the rig's magazine part); behind it, the next
 * hang is the pistol grip (the firing glove sits on its top half); in front of it, the
 * handguard's underside (the support glove sits under it, part way to the muzzle).
 * Null when the gun has no such shape (handguns): the rig's points are used.
 */
export interface GunGrips {
  firing: THREE.Vector3;
  support: THREE.Vector3;
  /** The pistol grip's lowest point (its bottom slice, on the centre line). */
  gripLow: THREE.Vector3;
  /** The bore's height (the muzzle's y). */
  bore: number;
}

const cache = new Map<string, GunGrips | null>();
const SLICE = 0.01;

export function gunGrips(key: string, rig: WeaponRig): GunGrips | null {
  if (cache.has(key)) return cache.get(key)!;
  const out = measure(rig);
  cache.set(key, out);
  return out;
}

function measure(rig: WeaponRig): GunGrips | null {
  const root = rig.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const skip = new Set<THREE.Object3D>([rig.leftHand, rig.rightHand]);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let zMin = Infinity;
  let zMax = -Infinity;
  const pts: number[] = [];
  root.traverse((o) => {
    // The gun itself only: not the hands, nothing hidden, no effect cards (flash, laser, beam).
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
      pts.push(p.y, p.z);
      zMin = Math.min(zMin, p.z);
      zMax = Math.max(zMax, p.z);
    }
  });
  if (!pts.length || zMax - zMin < 0.3) return null;
  const n = Math.ceil((zMax - zMin) / SLICE) + 1;
  const low = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < pts.length; i += 2) {
    const s = Math.floor((pts[i + 1] - zMin) / SLICE);
    low[s] = Math.min(low[s], pts[i]);
  }
  const muzzle = rig.muzzle.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const bore = muzzle.y;
  const zOf = (s: number) => zMin + (s + 0.5) * SLICE;
  const sliceOf = (z: number) => Math.max(0, Math.min(n - 1, Math.floor((z - zMin) / SLICE)));
  // The magazine: the rig's part if it has one, else the deepest hang.
  let magFront: number;
  let magBack: number;
  if (rig.mag) {
    const box = new THREE.Box3().setFromObject(rig.mag).applyMatrix4(inv);
    magFront = box.min.z;
    magBack = box.max.z;
  } else {
    let deep = 0;
    for (let s = 1; s < n; s++) if (low[s] < low[deep]) deep = s;
    magFront = magBack = zOf(deep);
  }
  // The pistol grip: the lowest hang behind the magazine, before the stock.
  const muzzleEnd = muzzle.z < (zMin + zMax) / 2;
  if (!muzzleEnd) return null;
  let grip = -1;
  for (let s = sliceOf(magBack + 0.03); s < sliceOf(Math.min(zMax, magBack + 0.22)); s++) {
    if (low[s] === Infinity) continue;
    if (grip < 0 || low[s] < low[grip]) grip = s;
  }
  if (grip < 0 || bore - low[grip] < 0.06) return null;
  // Top of the grip: a little below where it leaves the receiver.
  const firing = new THREE.Vector3(0, low[grip] + (bore - low[grip]) * 0.45, zOf(grip) - 0.005);
  // The handguard's underside, a third of the way from the magazine to the muzzle.
  const z = magFront - Math.min(0.2, (magFront - muzzle.z) * 0.35);
  let under = Infinity;
  for (let s = sliceOf(z - 0.03); s <= sliceOf(z + 0.03); s++) under = Math.min(under, low[s]);
  if (under === Infinity) return null;
  const support = new THREE.Vector3(0, under - 0.012, z);
  return { firing, support, gripLow: new THREE.Vector3(0, low[grip], zOf(grip)), bore };
}
