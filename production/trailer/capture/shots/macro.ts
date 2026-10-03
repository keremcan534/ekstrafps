import * as THREE from 'three';
import { lensToVfov, type Shot, type ShotCtx } from '../Director';
import { blackStage, dust, ease, handheld, lerpV } from '../stage';
import { buildWeaponModel, type WeaponRig } from '../../../../src/weapons/WeaponModels';
import { WeaponAnimator, type PoseOffset } from '../../../../src/weapons/WeaponAnimator';
import type { Weapon } from '../../../../src/weapons/Weapon';

/**
 * Act I macro set: the M4A1 rig (real model, real glove hands) held in the dark,
 * driven by the game's own empty-reload keyframes (WeaponAnimator), lit by one hard
 * cool rim, a faint warm bounce and a slowly sweeping red practical.
 */

const EMPTY_TIME = 2.35; // m4a1.json reload.emptyTime

interface Macro {
  rig: WeaponRig;
  anim: WeaponAnimator;
  base: { pos: THREE.Vector3; rot: THREE.Euler };
  /** Seated magazine position (rig-local, before any animation). */
  magRest: THREE.Vector3;
  fake: { state: string; stateProgress: number; reloadEmpty: boolean; data: unknown; timeSinceShot: number; actionLockedBack: boolean; fireMode: string; cycleDuration: number; pumpTime: number };
  pose: PoseOffset;
  red: THREE.SpotLight;
  redPivot: THREE.Object3D;
  rim: THREE.SpotLight;
  motes: ReturnType<typeof dust>;
  /** World-space anchors, refreshed every frame. */
  at: Record<'magwell' | 'bolt' | 'sight' | 'muzzle' | 'port' | 'grip', THREE.Vector3>;
}

let M: Macro | null = null;

function build(ctx: ShotCtx): Macro {
  const set = blackStage(ctx.game);
  const rig = buildWeaponModel('m4a1');
  // Held low and canted, as if loading at low ready.
  const base = { pos: new THREE.Vector3(0, 1.2, 0), rot: new THREE.Euler(-0.12, 0.0, 0.16, 'YXZ') };
  rig.root.position.copy(base.pos);
  rig.root.rotation.copy(base.rot);
  set.add(rig.root);
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });

  // Macro only: the viewmodel sleeves end at the elbow. Make them dark fabric that
  // runs on out of the light, so no cut-off arm reads in frame.
  // Black synthetic gloves read as tactical silhouettes; the rim catches their edges only.
  const fabric = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.95, metalness: 0 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.62, metalness: 0.05 });
  for (const hnd of [rig.leftHand, rig.rightHand]) {
    for (const c of hnd.children) {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) continue;
      if (Math.abs(mesh.scale.x - 0.034) < 1e-4) {
        mesh.material = fabric;
        mesh.scale.set(0.045, mesh.scale.y * 3, 0.045);
        mesh.position.multiplyScalar(3);
      } else mesh.material = glove;
    }
  }
  const magRest = rig.mag!.position.clone();
  const anim = new WeaponAnimator();
  anim.setRig(rig);

  // Hard cool rim from above-behind.
  const rim = new THREE.SpotLight(0xcfdcff, 60, 4, 0.26, 0.6, 2);
  rim.position.set(0.35, 2.4, 0.9);
  rim.target.position.copy(base.pos);
  rim.castShadow = true;
  rim.shadow.mapSize.set(2048, 2048);
  rim.shadow.bias = -0.0002;
  set.add(rim, rim.target);
  // Faint warm bounce from below (a lamp somewhere off-frame).
  const bounce = new THREE.PointLight(0x7a4a2a, 0.25, 3, 2);
  bounce.position.set(-0.4, 0.6, 0.3);
  set.add(bounce);
  // Cool kicker under the magwell so the magazine reads as it rises.
  const kicker = new THREE.PointLight(0x8fa6c0, 0.5, 1.6, 2);
  kicker.position.set(0.35, 0.75, -0.45);
  set.add(kicker);
  // Rotating red practical: a spot on a pivot, sweeping across the gun.
  const redPivot = new THREE.Object3D();
  redPivot.position.set(-0.9, 1.7, -0.6);
  const red = new THREE.SpotLight(0xff2a12, 0, 6, 0.42, 0.7, 2);
  red.position.set(0, 0, 0);
  red.target.position.set(0, -0.3, 1);
  redPivot.add(red, red.target);
  set.add(redPivot);
  // Distant practicals for bokeh depth (tiny emissive points far behind).
  for (const [x, y, z, c] of [[-2.4, 1.6, -5, 0xff5a20], [1.8, 2.2, -6.5, 0xffa060], [3.0, 1.1, -4.2, 0xff2a12]] as const) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(3) }));
    s.position.set(x, y, z);
    set.add(s);
  }
  const motes = dust(900, new THREE.Vector3(1.6, 1.2, 1.6), base.pos, 0.3);
  set.add(motes);

  const fake = {
    state: 'reloading', stateProgress: 0, reloadEmpty: true,
    data: { animSet: 'rifle', reload: { kind: 'magazine' } },
    timeSinceShot: 99, actionLockedBack: false, fireMode: 'auto', cycleDuration: 0.075, pumpTime: 99,
  };
  const v = () => new THREE.Vector3();
  return { rig, anim, base, magRest, fake, pose: { pos: v(), rot: v() }, red, redPivot, rim, motes, at: { magwell: v(), bolt: v(), sight: v(), muzzle: v(), port: v(), grip: v() } };
}

/** Drive the real reload animation at progress p (0..1 of the empty reload). */
function pose(m: Macro, p: number): void {
  m.fake.stateProgress = p;
  m.anim.update(m.fake as unknown as Weapon, m.pose);
  m.rig.root.position.copy(m.base.pos).add(m.pose.pos);
  m.rig.root.rotation.set(m.base.rot.x + m.pose.rot.x, m.base.rot.y + m.pose.rot.y, m.base.rot.z + m.pose.rot.z, 'YXZ');
  m.rig.root.updateMatrixWorld(true);
  // Magwell = where the seated magazine's top sits (rig-local rest position of the mag).
  m.at.magwell.copy(m.magRest).applyMatrix4(m.rig.mag!.parent!.matrixWorld);
  m.rig.bolt?.getWorldPosition(m.at.bolt);
  m.rig.sight.getWorldPosition(m.at.sight);
  m.rig.muzzle.getWorldPosition(m.at.muzzle);
  m.rig.ejectPort.getWorldPosition(m.at.port);
  m.rig.rightHand.getWorldPosition(m.at.grip);
}

async function setup(ctx: ShotCtx): Promise<void> {
  M = build(ctx);
}

const tmp = new THREE.Vector3();
/** Camera distance that frames `field` metres vertically with a given lens (16:9). */
const distFor = (field: number, lens: number) => field / (2 * Math.tan((lensToVfov(lens, 16 / 9) * Math.PI) / 360));
const off = (m: Macro, local: THREE.Vector3) => local.clone().applyQuaternion(m.rig.root.quaternion);

/** A02: receiver + empty magwell, glove rests on the grip; 100 mm, slow dolly-in. */
export const A02: Shot = {
  map: 'lab',
  setup,
  update(ctx) {
    const m = M!;
    pose(m, 0.36); // magazine out (below frame), left hand down with it
    // Right glove slides in to the grip over the first second.
    const s = ease(ctx.t, [[-0.25, 0], [0.2, 0], [1.3, 1]]);
    m.rig.rightHand.position.copy(m.rig.rightHandRest).add(tmp.set(0.05, -0.06, 0.09).multiplyScalar(1 - s));
    m.motes.tick(ctx.t);
  },
  camera(ctx) {
    const m = M!;
    // Field shrinks 0.17 → 0.13 m: a slow dolly into the empty magwell.
    const d = distFor(ease(ctx.t, [[-0.25, 0.17], [2.45, 0.13]]), 100);
    // Low, looking up into the empty magwell and trigger guard as the glove arrives.
    const pos = m.at.magwell.clone().add(off(m, new THREE.Vector3(0.75, -0.75, -0.35).normalize().multiplyScalar(d)));
    pos.add(handheld(ctx.t, 0.0012, 1));
    return { pos, target: m.at.magwell.clone().add(off(m, new THREE.Vector3(0, 0.02, 0.05))), lens: 100 };
  },
  post(ctx) {
    const m = M!;
    return { exposure: 0.72, contrast: 1.18, dof: { focus: ctx.game.camera.camera.position.distanceTo(m.at.magwell), aperture: 0.09, maxblur: 0.014 } };
  },
};

/** A03: magazine rises and seats, CLICK at T 5.750; 85 mm side profile, locked off. */
export const A03: Shot = {
  map: 'lab',
  setup,
  update(ctx) {
    const m = M!;
    // Seated (progress 0.48) exactly on the CLICK marker; real speed of the empty reload.
    const p = 0.48 + (ctx.t - ctx.local(5.75)) / EMPTY_TIME;
    pose(m, Math.max(0.36, p));
    m.motes.tick(ctx.t + 3);
  },
  camera() {
    const m = M!;
    const pos = m.at.magwell.clone().add(off(m, new THREE.Vector3(1, -0.08, -0.65).normalize().multiplyScalar(distFor(0.3, 85))));
    return { pos, target: m.at.magwell.clone().add(off(m, new THREE.Vector3(0, -0.085, 0))), lens: 85 };
  },
  post(ctx) {
    const m = M!;
    return { exposure: 0.8, contrast: 1.15, dof: { focus: ctx.game.camera.camera.position.distanceTo(m.at.magwell), aperture: 0.07, maxblur: 0.012 } };
  },
};

/** A04: charging handle pulled and released (CLACK at T 7.30 → 7.55); 50 mm close, micro handheld. */
export const A04: Shot = {
  map: 'lab',
  setup,
  update(ctx) {
    const m = M!;
    // Handle fully back (0.70) on the boltback marker.
    const p = 0.7 + (ctx.t - ctx.local(7.3)) / EMPTY_TIME;
    pose(m, Math.min(0.9, Math.max(0.5, p)));
    m.red.intensity = 6 * ease(ctx.t, [[0, 0], [1.8, 1]]);
    m.redPivot.rotation.y = 0.25 + ctx.t * 0.2;
    m.motes.tick(ctx.t + 6);
  },
  camera(ctx) {
    const m = M!;
    const pos = m.at.bolt.clone().add(off(m, new THREE.Vector3(0.7, 0.5, 0.55).normalize().multiplyScalar(distFor(0.13, 50))));
    pos.add(handheld(ctx.t, 0.002, 2));
    return { pos, target: m.at.bolt.clone().add(off(m, new THREE.Vector3(0, -0.01, -0.05))), lens: 50 };
  },
  post(ctx) {
    const m = M!;
    return { exposure: 0.75, contrast: 1.18, dof: { focus: ctx.game.camera.camera.position.distanceTo(m.at.bolt), aperture: 0.05, maxblur: 0.012 } };
  },
};

/** A05: low across the rifle; rack focus muzzle → holo ring as the red light sweeps across. */
export const A05: Shot = {
  map: 'lab',
  setup,
  update(ctx) {
    const m = M!;
    pose(m, 0.99);
    // Red sweep: enters from the left, crosses the gun, leaves frame → black (light wipe).
    m.redPivot.rotation.y = ease(ctx.t, [[-0.25, 0.1], [2.8, 1.95]]);
    m.red.intensity = 22 * ease(ctx.t, [[-0.25, 0.4], [0.6, 1], [2.3, 1], [2.75, 0]]);
    m.rim.intensity = 60 * ease(ctx.t, [[0, 0.55], [2.2, 0.55], [2.7, 0]]);
    m.motes.tick(ctx.t + 9);
  },
  camera(ctx) {
    const m = M!;
    // Beside the muzzle, low, looking back along the gun toward the sight.
    const from = lerpV(ctx.t, [[-0.25, m.at.muzzle.clone().add(off(m, new THREE.Vector3(0.11, 0.02, -0.06)))], [3.05, m.at.muzzle.clone().add(off(m, new THREE.Vector3(0.1, 0.03, 0.02)))]]);
    from.add(handheld(ctx.t, 0.0015, 3));
    return { pos: from, target: m.at.sight.clone(), lens: 35 };
  },
  post(ctx) {
    const m = M!;
    const cam = ctx.game.camera.camera.position;
    const near = cam.distanceTo(m.at.muzzle) + 0.04;
    const far = cam.distanceTo(m.at.sight);
    return { exposure: 1.15, dof: { focus: near + (far - near) * ease(ctx.t, [[0.5, 0], [1.6, 1]]), aperture: 0.06, maxblur: 0.016 } };
  },
};

/** Debug: wide view of the macro rig with anchors marked (magwell red, bolt green, sight blue, muzzle yellow, grip white). */
export const XRIG: Shot = {
  map: 'lab',
  duration: 2,
  async setup(ctx) {
    await setup(ctx);
    const m = M!;
    for (const [k, c] of [['magwell', 0xff0000], ['bolt', 0x00ff00], ['sight', 0x0066ff], ['muzzle', 0xffff00], ['grip', 0xffffff]] as const) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshBasicMaterial({ color: c, depthTest: false }));
      s.renderOrder = 10;
      s.userData.k = k;
      ctx.game.scene.add(s);
      (m as unknown as { markers: THREE.Mesh[] }).markers = [...((m as unknown as { markers?: THREE.Mesh[] }).markers ?? []), s];
    }
  },
  update(ctx) {
    const m = M!;
    const p = Number(new URLSearchParams(location.search).get('p') ?? 0.36);
    pose(m, p);
    m.rim.intensity = 60;
    for (const s of (m as unknown as { markers: THREE.Mesh[] }).markers) s.position.copy(m.at[s.userData.k as keyof Macro['at']]);
    void ctx;
  },
  camera() {
    const m = M!;
    const side = new URLSearchParams(location.search).get('side') ?? 'right';
    const dir = side === 'right' ? new THREE.Vector3(1, 0.15, 0) : side === 'left' ? new THREE.Vector3(-1, 0.15, 0) : new THREE.Vector3(0.2, 1, 0.1);
    return { pos: m.base.pos.clone().add(off(m, dir.normalize().multiplyScalar(1.4))), target: m.base.pos.clone(), lens: 35 };
  },
  post: () => ({ exposure: 1.6, vignette: 0, grain: 0 }),
};
