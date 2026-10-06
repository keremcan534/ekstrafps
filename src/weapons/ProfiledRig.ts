import * as THREE from 'three';
import { gunSource } from './WeaponMeshes';
import { adsFrame, orientationMatrix, type ViewProfile } from './ViewProfile';
import type { WeaponData } from './WeaponData';
import type { WeaponRig } from './WeaponModels';

/**
 * A first-person weapon built from its view profile (ViewProfile.ts):
 *
 *   WeaponInstance (rig.root, weapon space)
 *   ├─ OrientationRoot (model → weapon) ─ the model file's meshes, untouched
 *   ├─ mag, bolt     moving pieces at their pivots, cut from the model by bone / node name
 *   └─ ADSPoint (rig.sight), MuzzlePoint (rig.muzzle), eject port, laser, hand IK points
 *
 * Nothing is read off the mesh's shape: every point comes from the profile, so changing
 * another weapon or the motion layers can't move this one.
 */
export interface ProfiledView {
  profile: Readonly<ViewProfile>;
  /** OrientationRoot. */
  orientation: THREE.Group;
  /** ADSPoint frame in weapon space: origin on the rear sight, -Z along the sight line. */
  frame: THREE.Matrix4;
  /** Moving pieces: their node (weapon space, at the pivot) and model-space pivot. */
  pieces: { node: THREE.Object3D; pivot: THREE.Vector3; orient: THREE.Group }[];
}

const FORWARD = new THREE.Vector3(0, 0, -1);

type Piece = 'body' | 'mag' | 'bolt';

/** The weapon for `profile`, or null when its model file didn't load. */
export function buildProfiledRig(profile: Readonly<ViewProfile>, data: WeaponData): WeaponRig | null {
  const src = gunSource(profile.model.key);
  if (!src) return null;
  const root = new THREE.Group();
  root.name = `WeaponInstance:${profile.id}`;
  const orientation = new THREE.Group();
  orientation.name = 'OrientationRoot';
  orientation.matrixAutoUpdate = false;
  root.add(orientation);

  // Each named part's piece: its own name or the nearest named one above it.
  const names = profile.model.parts;
  const pieceOf: Piece[] = src.parts.map((_, i) => {
    for (let j = i; j >= 0; j = src.parts[j].parent) {
      if (names.mag?.includes(src.parts[j].name)) return 'mag';
      if (names.bolt?.includes(src.parts[j].name)) return 'bolt';
    }
    return 'body';
  });
  const geo = src.geometry;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const mat = geo.getAttribute('mat');
  const part = geo.getAttribute('part');
  const buckets = new Map<Piece, Map<number, number[]>>();
  for (let t = 0; t < pos.count; t += 3) {
    const piece = part ? pieceOf[part.getX(t)] : 'body';
    const byMat = buckets.get(piece) ?? new Map<number, number[]>();
    buckets.set(piece, byMat);
    const mi = mat ? mat.getX(t) : 0;
    const starts = byMat.get(mi) ?? [];
    byMat.set(mi, starts);
    starts.push(t);
  }
  const meshesOf = (piece: Piece): THREE.Mesh[] =>
    [...(buckets.get(piece) ?? [])].map(([mi, starts]) => {
      const n = starts.length * 3;
      const P = new Float32Array(n * 3);
      const N = new Float32Array(n * 3);
      const U = new Float32Array(n * 2);
      let i = 0;
      for (const t of starts) {
        for (let v = 0; v < 3; v++, i++) {
          P.set([pos.getX(t + v), pos.getY(t + v), pos.getZ(t + v)], i * 3);
          if (nor) N.set([nor.getX(t + v), nor.getY(t + v), nor.getZ(t + v)], i * 3);
          if (uv) U.set([uv.getX(t + v), uv.getY(t + v)], i * 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      if (nor) g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      if (uv) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, src.materials[mi]);
      mesh.userData.gunModel = true;
      mesh.frustumCulled = false;
      return mesh;
    });
  orientation.add(...meshesOf('body'));

  const eject = new THREE.Vector3(...profile.points.eject);
  const pieces: ProfiledView['pieces'] = [];
  const makePiece = (piece: Piece, partNames: string[] | undefined): THREE.Object3D => {
    const node = new THREE.Group();
    node.name = piece;
    const orient = new THREE.Group();
    orient.matrixAutoUpdate = false;
    node.add(orient);
    const meshes = meshesOf(piece);
    if (meshes.length) orient.add(...meshes);
    // It turns about its bone's head (where a magazine latches); no named part: the eject port.
    const named = src.parts.find((p) => partNames?.includes(p.name));
    pieces.push({ node, pivot: named ? named.head.clone() : eject.clone(), orient });
    root.add(node);
    return node;
  };
  const mag = names.mag?.length ? makePiece('mag', names.mag) : null;
  // Long-gun reloads also work a bolt node (the charging handle), even a model without one.
  const bolt = makePiece('bolt', names.bolt);

  const point = (name: string) => {
    const o = new THREE.Object3D();
    o.name = name;
    root.add(o);
    return o;
  };
  const rig: WeaponRig = {
    root,
    muzzle: point('MuzzlePoint'),
    ejectPort: point('EjectPoint'),
    sight: point('ADSPoint'),
    mag,
    bolt,
    pump: null,
    leftHand: point('LeftHandIK'),
    leftHandRest: new THREE.Vector3(),
    rightHand: point('RightHandIK'),
    rightHandRest: new THREE.Vector3(),
    heldShell: null,
    laser: point('Laser'),
    butt: new THREE.Vector3(),
    shellType: data.category === 'pistol' ? 'pistol' : data.category === 'shotgun' ? 'shotgun' : 'rifle',
    view: { profile, orientation, frame: new THREE.Matrix4(), pieces },
  };
  layoutProfiledRig(rig);
  return rig;
}

/** Place the OrientationRoot, moving pieces and reference points from the rig's profile. */
export function layoutProfiledRig(rig: WeaponRig): void {
  const v = rig.view!;
  const p = v.profile;
  const O = orientationMatrix(p, new THREE.Matrix4());
  v.orientation.matrix.copy(O);
  v.orientation.matrixWorldNeedsUpdate = true;
  const W = (pt: readonly number[]) => new THREE.Vector3(pt[0], pt[1], pt[2]).applyMatrix4(O);
  for (const piece of v.pieces) {
    const at = piece.pivot.clone().applyMatrix4(O);
    piece.node.position.copy(at);
    piece.orient.matrix.makeTranslation(-at.x, -at.y, -at.z).multiply(O);
    piece.orient.matrixWorldNeedsUpdate = true;
  }
  adsFrame(p, v.frame);
  rig.sight.position.setFromMatrixPosition(v.frame);
  rig.sight.quaternion.setFromRotationMatrix(v.frame);
  const muzzle = W(p.points.muzzle);
  const bore = muzzle.clone().sub(W(p.points.boreRear)).normalize();
  rig.muzzle.position.copy(muzzle);
  rig.muzzle.quaternion.setFromUnitVectors(FORWARD, bore);
  // Test laser: under the barrel, 15 cm back, parallel to the bore.
  rig.laser.position.copy(muzzle).addScaledVector(bore, -0.15);
  rig.laser.position.y -= 0.03;
  rig.laser.quaternion.copy(rig.muzzle.quaternion);
  rig.ejectPort.position.copy(W(p.points.eject));
  rig.leftHandRest.copy(W(p.points.gripLeft));
  rig.leftHand.position.copy(rig.leftHandRest);
  rig.rightHandRest.copy(W(p.points.gripRight));
  rig.rightHand.position.copy(rig.rightHandRest);
  rig.butt.copy(W(p.points.butt));
}
