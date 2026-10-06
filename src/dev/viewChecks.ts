import * as THREE from 'three';
import { feel } from '../config/Feel';
import { DEG, hfovToVfov } from '../core/math';
import { Weapon, type WeaponListener } from '../weapons/Weapon';
import { computeHandling } from '../weapons/Handling';
import { getAmmo } from '../weapons/AmmoData';
import type { Viewmodel, ViewmodelPlayer } from '../weapons/Viewmodel';
import type { WeaponData } from '../weapons/WeaponData';
import { playerConfig } from '../player/PlayerConfig';

/**
 * Measurements of the first-person weapon, taken on the real Viewmodel (no copied maths):
 * the calibration page shows them live and runs every state through them.
 *
 * Conventions for a profiled weapon (LIMITS): aimed, the sight picture stays whole (rear
 * and front sight together) and near the centre; the hip presentation leaves the centre
 * of the screen open; nothing comes inside the near plane; every motion settles back to
 * exactly the calibrated pose.
 */
export const LIMITS = {
  /** Aimed, standing still: breathing only (deg off the centre). */
  stillDeg: 0.15,
  /** Aimed, walking / strafing / turning: how far the sight picture may drift (deg). */
  moveDeg: 0.6,
  /** Aimed, shooting: recoil moves it (deg). */
  shootDeg: 2.5,
  /** Rear and front sight apart as seen from the eye (deg): a broken sight picture. */
  splitDeg: 0.08,
  splitShootDeg: 0.35,
  /** Optic cant (deg). */
  rollDeg: 0.35,
  /** Once the motion settles (sway off): back on the calibration. */
  settleDeg: 0.01,
  settleMm: 0.1,
  /** Nearest drawn geometry beyond the near plane (m). */
  nearMargin: 0.01,
  /** Hip presentation: share of the screen, share of the centre zone (middle 30% × 30%). */
  hipScreenPct: 15,
  hipCentrePct: 5,
};

/** The solid meshes of the weapon in hand that draw (not glass, glow or the muzzle flash). */
export function drawnMeshes(vm: Viewmodel): THREE.Mesh[] {
  const rig = vm.activeRig;
  const out: THREE.Mesh[] = [];
  if (!rig) return out;
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.gizmo || ([] as THREE.Material[]).concat(m.material).some((mt) => mt.transparent)) return;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
    out.push(m);
  });
  return out;
}

/** Rear and front sight as seen from the eye: `split` apart, `off` the front sight from the centre (deg). */
export function sightLine(vm: Viewmodel): { split: number; off: number; roll: number } | null {
  const rig = vm.activeRig;
  const view = rig?.view;
  if (!rig || !view) return null;
  vm.scene.updateMatrixWorld(true);
  const r = rig.sight.getWorldPosition(new THREE.Vector3());
  const f = new THREE.Vector3(...view.profile.points.sightFront).applyMatrix4(view.orientation.matrixWorld);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.sight.getWorldQuaternion(new THREE.Quaternion()));
  return {
    split: r.angleTo(f) / DEG,
    off: f.angleTo(new THREE.Vector3(0, 0, -1)) / DEG,
    roll: Math.abs(Math.atan2(-up.x, up.y)) / DEG,
  };
}

/**
 * What the centre column of the screen looks through, aimed: rays from the eye from -3° to
 * +3°, each first hit near (rear half of the gun), far (front half) or clear. The post's
 * tip is the top of the front sight just under the centre.
 */
export function sightPicture(vm: Viewmodel): { runs: string; postTopDeg: number | null; clearAboveDeg: number | null } {
  const rig = vm.activeRig;
  if (!rig) return { runs: '', postTopDeg: null, clearAboveDeg: null };
  vm.scene.updateMatrixWorld(true);
  const meshes = drawnMeshes(vm);
  // Rays may start inside a part (a stock under the cheek): every face counts.
  const sides = new Map<THREE.Material, THREE.Side>();
  for (const m of meshes) {
    for (const mt of ([] as THREE.Material[]).concat(m.material)) {
      if (sides.has(mt)) continue;
      sides.set(mt, mt.side);
      mt.side = THREE.DoubleSide;
    }
  }
  const reach = -rig.muzzle.getWorldPosition(new THREE.Vector3()).z;
  const ray = new THREE.Raycaster();
  const kind = (deg: number): string => {
    const dir = new THREE.Vector3(0, Math.tan(deg * DEG), -1).normalize();
    ray.set(new THREE.Vector3(), dir);
    ray.far = reach + 0.2;
    let best = Infinity;
    for (const m of meshes) {
      const h = ray.intersectObject(m, false)[0];
      if (h) best = Math.min(best, h.distance * -dir.z);
    }
    return best === Infinity ? '.' : best < 0.5 * reach ? 'N' : 'F';
  };
  const steps: [number, string][] = [];
  for (let a = -3; a <= 3.0001; a += 0.02) steps.push([+a.toFixed(2), kind(a)]);
  for (const [mt, side] of sides) mt.side = side;
  const runs: { c: string; from: number; to: number }[] = [];
  for (const [a, c] of steps) {
    const last = runs[runs.length - 1];
    if (last && last.c === c) last.to = a;
    else runs.push({ c, from: a, to: a });
  }
  // The post: the far run whose top is closest to the centre from below, with clear sky above it.
  let post: (typeof runs)[number] | null = null;
  for (let i = 0; i < runs.length - 1; i++) {
    const r = runs[i];
    if (r.c === 'F' && runs[i + 1].c === '.' && r.to <= 0.75 && (!post || Math.abs(r.to) < Math.abs(post.to))) post = r;
  }
  const above = post ? runs[runs.indexOf(post) + 1] : null;
  return {
    runs: runs.map((r) => `${r.c}[${r.from}..${r.to}]`).join(' '),
    postTopDeg: post ? post.to : null,
    clearAboveDeg: above ? +(above.to - above.from).toFixed(2) : null,
  };
}

/**
 * Screen coverage of the weapon (its triangles rasterised at 192 × 108): the whole screen and
 * the centre zone, in %, and the nearest drawn point's depth (m).
 */
export function coverage(vm: Viewmodel, camera: THREE.PerspectiveCamera): { screenPct: number; centrePct: number; nearestM: number } {
  vm.scene.updateMatrixWorld(true);
  const W = 192;
  const H = 108;
  const cells = new Uint8Array(W * H);
  const ty = Math.tan((camera.fov * DEG) / 2);
  const tx = ty * camera.aspect;
  const near = camera.near;
  let nearest = Infinity;
  const v = new THREE.Vector3();
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  for (const m of drawnMeshes(vm)) {
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      let ok = true;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(m.matrixWorld);
        const d = -v.z;
        if (d > 0 && Math.abs(v.x / d) < tx && Math.abs(v.y / d) < ty) nearest = Math.min(nearest, d);
        if (d < near) ok = false;
        sx[k] = ((v.x / d / tx) * 0.5 + 0.5) * W;
        sy[k] = ((v.y / d / ty) * 0.5 + 0.5) * H;
      }
      if (!ok) continue;
      const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sy[1] - sy[0]) * (sx[2] - sx[0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...sx)));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(...sx)));
      const y0 = Math.max(0, Math.floor(Math.min(...sy)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(...sy)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((sx[1] - px) * (sy[2] - py) - (sy[1] - py) * (sx[2] - px)) / area;
          const w1 = ((sx[2] - px) * (sy[0] - py) - (sy[2] - py) * (sx[0] - px)) / area;
          if (w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0) cells[y * W + x] = 1;
        }
      }
    }
  }
  let all = 0;
  let mid = 0;
  let midN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = cells[y * W + x];
      all += c;
      if (x >= W * 0.35 && x < W * 0.65 && y >= H * 0.35 && y < H * 0.65) {
        mid += c;
        midN++;
      }
    }
  }
  return { screenPct: (100 * all) / (W * H), centrePct: (100 * mid) / midN, nearestM: nearest };
}

/** Offset of the ProceduralRoot from rest (the motion layers): mm and degrees. */
export function motionOffset(vm: Viewmodel): { mm: number; deg: number } {
  const p = vm.scene.getObjectByName('ProceduralRoot');
  if (!p) return { mm: 0, deg: 0 };
  const w = Math.min(1, Math.abs(p.quaternion.w));
  return { mm: p.position.length() * 1000, deg: (2 * Math.acos(w)) / DEG };
}

export interface StateRow {
  state: string;
  ok: boolean;
  notes: string[];
  /** Max over the state (aimed frames only for the aimed measures). */
  offDeg: number;
  splitDeg: number;
  rollDeg: number;
  nearestM: number;
  screenPct: number;
  centrePct: number;
  /** After the state, 2.5 s still with sway off. */
  settleDeg: number;
  settleMm: number;
  settleMotionMm: number;
  settleMotionDeg: number;
}

interface Harness {
  vm: Viewmodel;
  data: WeaponData;
  /** Another weapon to switch to and back. */
  other: WeaponData;
  camera: THREE.PerspectiveCamera;
}

/**
 * Every state from the brief, driven through the real Weapon state machine and Viewmodel:
 * idle / walking / running hip, sprint, aimed still / walking / strafing / turning /
 * shooting / after recoil, reload, reload → aim, sprint → aim, switch → aim, crouched aim.
 */
export function runStateChecks(h: Harness): StateRow[] {
  const { vm, camera } = h;
  const ammo = getAmmo(h.data.ammo);
  const handling = computeHandling(h.data, ammo);
  const listener: WeaponListener = {
    onShot: (w) => vm.kick(w.data, getAmmo(w.data.ammo), player.crouching),
    onDryFire: () => vm.onMechanical('magOut'),
    onSound: (_w, key) => {
      if (key === 'magIn' || key === 'boltForward' || key === 'shellInsert' || key === 'pump' || key === 'magOut') vm.onMechanical(key);
    },
  };
  const gun = new Weapon(h.data, listener);
  const other = new Weapon(h.other, listener);
  const player: ViewmodelPlayer = { yaw: 0, velocity: new THREE.Vector3(), crouching: false, sprinting: false, grounded: true, bobPhase: 0 };
  let held = gun;
  const dt = 1 / 60;
  const aimPoint = new THREE.Vector3();

  const frame = (o: { ads?: boolean; fire?: boolean; reload?: boolean; look?: number; speed?: [number, number] } = {}) => {
    const d = held.data;
    held.update(dt, { fireHeld: !!o.fire, firePressed: !!o.fire, reloadPressed: !!o.reload, blocked: false });
    // Ground acceleration toward the wanted velocity, like PlayerController.
    const want = new THREE.Vector3(o.speed?.[0] ?? 0, 0, o.speed?.[1] ?? 0);
    const dv = want.sub(player.velocity);
    const rate = dv.lengthSq() > 0 && (o.speed?.[0] || o.speed?.[1]) ? playerConfig.groundAcceleration : playerConfig.groundDeceleration;
    if (dv.length() <= rate * dt) player.velocity.add(dv);
    else player.velocity.addScaledVector(dv.normalize(), rate * dt);
    player.bobPhase += Math.hypot(player.velocity.x, player.velocity.z) * dt * (Math.PI / 1.9) * playerConfig.cameraBobFrequency;
    const canAds = (held.state === 'ready' || (held.state === 'equipping' && held.stateProgress > 0.6) || (held.state === 'reloading' && d.reload.kind === 'shell')) && vm.wallCompression < 0.5 && !vm.switchingShoulder;
    const ads = vm.adsAmount;
    aimPoint.set(0, 0, -(d.aim.hipConvergence + (d.aim.zeroDistance - d.aim.hipConvergence) * ads));
    camera.fov = hfovToVfov(playerConfig.baseFov + (vm.adsFov - playerConfig.baseFov) * ads);
    camera.updateProjectionMatrix();
    vm.update(dt, { player, lookYaw: (o.look ?? 0) * DEG * dt, lookPitch: 0, adsTarget: o.ads && canAds ? 1 : 0, aimPoint, dropAngle: 0, mainCamera: camera, stamina: 1, wallTarget: 0, shoulder: 1 });
  };

  const reset = () => {
    player.velocity.set(0, 0, 0);
    player.crouching = false;
    player.sprinting = false;
    held = gun;
    gun.refill();
    vm.setWeapon(gun, handling);
    gun.equip();
    for (let i = 0; i < 120; i++) frame();
  };

  const rows: StateRow[] = [];
  const run = (state: string, aimedState: boolean, body: (track: () => void) => void) => {
    reset();
    const row: StateRow = { state, ok: true, notes: [], offDeg: 0, splitDeg: 0, rollDeg: 0, nearestM: Infinity, screenPct: 0, centrePct: 0, settleDeg: 0, settleMm: 0, settleMotionMm: 0, settleMotionDeg: 0 };
    let n = 0;
    const track = () => {
      if (n++ % 3 === 0) {
        const c = coverage(vm, camera);
        row.nearestM = Math.min(row.nearestM, c.nearestM);
        row.screenPct = Math.max(row.screenPct, c.screenPct);
        row.centrePct = Math.max(row.centrePct, vm.adsAmount < 0.05 ? c.centrePct : 0);
      }
      if (vm.adsAmount >= 0.999) {
        const s = sightLine(vm);
        if (s) {
          row.offDeg = Math.max(row.offDeg, s.off);
          row.splitDeg = Math.max(row.splitDeg, s.split);
          row.rollDeg = Math.max(row.rollDeg, s.roll);
        }
      }
    };
    body(track);
    // Settle: still, sway off, holding the state's aim.
    const sway = feel.swayScale;
    feel.swayScale = 0;
    vm.refresh(computeHandling(held.data, getAmmo(held.data.ammo)));
    player.sprinting = false;
    for (let i = 0; i < 150; i++) frame({ ads: aimedState });
    const s = sightLine(vm);
    const a = vm.adsCheck;
    if (aimedState && s) {
      row.settleDeg = Math.max(a.liveDeg, s.off);
      row.settleMm = a.liveMm;
    }
    const mo = motionOffset(vm);
    row.settleMotionMm = mo.mm;
    row.settleMotionDeg = mo.deg;
    feel.swayScale = sway;
    vm.refresh(computeHandling(held.data, getAmmo(held.data.ammo)));
    // Verdicts.
    const fail = (why: string) => {
      row.ok = false;
      row.notes.push(why);
    };
    if (row.nearestM < camera.near + LIMITS.nearMargin) fail(`geometry ${(row.nearestM * 100).toFixed(1)} cm from the eye`);
    if (aimedState) {
      const offLimit = state.includes('shoot') ? LIMITS.shootDeg : state === 'ads-still' || state.includes('crouch') ? LIMITS.stillDeg : LIMITS.moveDeg;
      const splitLimit = state.includes('shoot') ? LIMITS.splitShootDeg : LIMITS.splitDeg;
      if (row.offDeg > offLimit) fail(`sight ${row.offDeg.toFixed(2)}° off centre (> ${offLimit})`);
      if (row.splitDeg > splitLimit) fail(`rear/front split ${row.splitDeg.toFixed(3)}° (> ${splitLimit})`);
      if (row.rollDeg > LIMITS.rollDeg) fail(`cant ${row.rollDeg.toFixed(2)}° (> ${LIMITS.rollDeg})`);
      if (row.settleDeg > LIMITS.settleDeg || row.settleMm > LIMITS.settleMm) fail(`not back on calibration: ${row.settleDeg.toFixed(3)}° ${row.settleMm.toFixed(2)} mm`);
    } else {
      if (row.centrePct > LIMITS.hipCentrePct) fail(`covers ${row.centrePct.toFixed(1)}% of the centre`);
      if (row.screenPct > LIMITS.hipScreenPct) fail(`covers ${row.screenPct.toFixed(1)}% of the screen`);
    }
    if (row.settleMotionMm > 0.1 || row.settleMotionDeg > 0.01) fail(`motion left over: ${row.settleMotionMm.toFixed(2)} mm ${row.settleMotionDeg.toFixed(3)}°`);
    rows.push(row);
  };

  const walk = 6.2;
  const aimWalk = walk * playerConfig.adsSpeedMultiplier;
  const loop = (frames: number, o: Parameters<typeof frame>[0], track: () => void) => {
    for (let i = 0; i < frames; i++) {
      frame(o);
      track();
    }
  };

  run('idle-hip', false, (t) => loop(120, {}, t));
  run('walk-hip', false, (t) => loop(150, { speed: [0, -walk] }, t));
  run('run-hip', false, (t) => loop(150, { speed: [0, -walk], look: 60 }, t));
  run('sprint', false, (t) => {
    player.sprinting = true;
    loop(150, { speed: [0, -playerConfig.sprintSpeed] }, t);
  });
  run('ads-still', true, (t) => loop(180, { ads: true }, t));
  run('ads-walk', true, (t) => loop(180, { ads: true, speed: [0, -aimWalk] }, t));
  run('ads-strafe-left', true, (t) => {
    loop(60, { ads: true }, t);
    loop(45, { ads: true, speed: [-aimWalk, 0] }, t);
    loop(45, { ads: true }, t);
  });
  run('ads-strafe-right', true, (t) => {
    loop(60, { ads: true }, t);
    loop(45, { ads: true, speed: [aimWalk, 0] }, t);
    loop(45, { ads: true }, t);
  });
  run('ads-turn', true, (t) => {
    loop(60, { ads: true }, t);
    loop(30, { ads: true, look: 90 }, t);
    loop(45, { ads: true }, t);
  });
  run('ads-shoot', true, (t) => {
    loop(60, { ads: true }, t);
    loop(72, { ads: true, fire: true }, t);
  });
  run('ads-after-recoil', true, (t) => {
    loop(60, { ads: true }, t);
    loop(36, { ads: true, fire: true }, t);
    loop(90, { ads: true }, t);
  });
  run('reload', false, (t) => {
    gun.ammo = 5;
    loop(1, { reload: true }, t);
    loop(Math.ceil(h.data.reload.time * 60) + 30, {}, t);
  });
  run('reload-ads', true, (t) => {
    gun.ammo = 5;
    loop(1, { reload: true }, t);
    loop(Math.ceil(h.data.reload.time * 60) + 60, { ads: true }, t);
  });
  run('sprint-ads', true, (t) => {
    player.sprinting = true;
    loop(60, { speed: [0, -playerConfig.sprintSpeed] }, t);
    player.sprinting = false;
    loop(90, { ads: true }, t);
  });
  run('switch-ads', true, (t) => {
    gun.holster();
    for (let i = 0; i < 60 && gun.state !== 'holstered'; i++) loop(1, {}, t);
    held = other;
    vm.setWeapon(other, computeHandling(other.data, getAmmo(other.data.ammo)));
    other.equip();
    loop(40, {}, t);
    other.holster();
    for (let i = 0; i < 60 && other.state !== 'holstered'; i++) loop(1, {}, t);
    held = gun;
    vm.setWeapon(gun, handling);
    gun.equip();
    loop(90, { ads: true }, t);
  });
  run('crouch-ads', true, (t) => {
    player.crouching = true;
    loop(150, { ads: true }, t);
  });
  return rows;
}
