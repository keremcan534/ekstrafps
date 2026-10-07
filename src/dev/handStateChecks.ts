import * as THREE from 'three';
import { DEG, hfovToVfov } from '../core/math';
import { Weapon, type WeaponListener } from '../weapons/Weapon';
import { computeHandling } from '../weapons/Handling';
import { getAmmo } from '../weapons/AmmoData';
import type { Viewmodel, ViewmodelPlayer } from '../weapons/Viewmodel';
import type { WeaponData } from '../weapons/WeaponData';
import { playerConfig } from '../player/PlayerConfig';
import { SIDES } from '../weapons/hands/ArmRig';
import { WeaponSurface, fingerGaps, gloveInside } from './handChecks';

/**
 * The first-person hands through the brief's states, on the real Weapon state machine and
 * Viewmodel (calibration page: "Elleri 15 durumda test et"). Every frame:
 *
 *   connected   while a hand holds its target (IK ≥ 0.999) the drawn wrist is on the weapon's
 *               target (mm / deg): weapon motion never separates them, nothing overwrote the IK
 *   wrists      most bend between forearm and hand (an inverted wrist bends past the limit)
 *   elbows      the biggest one-frame turn of an elbow's direction (a flip is a big one)
 *   fingers     the biggest one-frame turn of any finger bone (a reset / snap)
 *   support     the left wrist's biggest one-frame move and turn against the weapon (a hand
 *               teleporting onto it), its IK weight's lowest (a reload must let go) and last
 *               value (it must come back)
 *   clipping    sampled while holding: the deepest finger into the weapon, glove inside it
 *               (settled poses; while the trigger finger moves between SAFE and READY its
 *               brush past the trigger guard is reported apart, `transitGapMm`, not judged)
 *
 * Wrist bend and clipping are the weapon under test's (not the other one a switch brings out);
 * connection, elbows, fingers and the support hand are checked on every frame.
 */
export interface HandCheckRow {
  state: string;
  ok: boolean;
  notes: string[];
  targetMm: number;
  targetDeg: number;
  wristDeg: number;
  poleStepDeg: number;
  fingerStepDeg: number;
  leftStepMm: number;
  leftStepDeg: number;
  leftIkMin: number;
  leftIkEnd: number;
  fingerGapMm: number;
  /** Which finger joint that was (side finger joint), and when (frame, the hand's state). */
  fingerWorst: string;
  gloveInMm: number;
  /** The trigger finger's deepest point while moving between SAFE and READY (mm, negative in). */
  transitGapMm: number;
}

export const HAND_LIMITS = {
  /** Holding: the wrist on its target. */
  targetMm: 0.5,
  targetDeg: 0.5,
  /** Forearm against hand (deg). */
  wristDeg: 80,
  /** In one frame (1/60 s): an elbow's direction, any finger bone, the support wrist. */
  poleStepDeg: 20,
  fingerStepDeg: 25,
  leftStepMm: 45,
  leftStepDeg: 25,
  /** A reload's support hand lets go (IK below this) and holds again at the end (above). */
  reloadLetGo: 0.05,
  holdAgain: 0.99,
  /** Clipping: a finger into the weapon, glove inside it (mm). */
  fingerInMm: 4,
  gloveInMm: 8,
};

interface Harness {
  vm: Viewmodel;
  data: WeaponData;
  /** Another weapon to switch to and back. */
  other: WeaponData;
  camera: THREE.PerspectiveCamera;
}

const angleDeg = (a: THREE.Quaternion, b: THREE.Quaternion) => THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))));

export function runHandChecks(h: Harness): HandCheckRow[] {
  const { vm, camera } = h;
  const handling = computeHandling(h.data, getAmmo(h.data.ammo));
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

  const frame = (o: { ads?: boolean; fire?: boolean; tap?: boolean; reload?: boolean; look?: number; speed?: [number, number] } = {}) => {
    const d = held.data;
    held.update(dt, { fireHeld: !!o.fire || !!o.tap, firePressed: !!o.fire || !!o.tap, reloadPressed: !!o.reload, blocked: false });
    const want = new THREE.Vector3(o.speed?.[0] ?? 0, 0, o.speed?.[1] ?? 0);
    const dv = want.sub(player.velocity);
    const rate = dv.lengthSq() > 0 && (o.speed?.[0] || o.speed?.[1]) ? playerConfig.groundAcceleration : playerConfig.groundDeceleration;
    if (dv.length() <= rate * dt) player.velocity.add(dv);
    else player.velocity.addScaledVector(dv.normalize(), rate * dt);
    player.bobPhase += Math.hypot(player.velocity.x, player.velocity.z) * dt * (Math.PI / 1.9) * playerConfig.cameraBobFrequency;
    const canAds = held.aimable && vm.wallCompression < 0.5 && !vm.switchingShoulder;
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
    player.grounded = true;
    held = gun;
    gun.refill();
    gun.fireModeIndex = 0;
    vm.setWeapon(gun, handling);
    gun.equip();
    for (let i = 0; i < 120; i++) frame();
  };

  // Per-frame history.
  const prevFinger: Record<string, THREE.Quaternion[]> = { right: [], left: [] };
  const prevLeft = { p: new THREE.Vector3(), q: new THREE.Quaternion(), rig: null as unknown };
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const sc = new THREE.Vector3();

  const rows: HandCheckRow[] = [];
  const run = (state: string, body: (track: () => void) => void, expect: { reload?: boolean } = {}) => {
    reset();
    const row: HandCheckRow = { state, ok: true, notes: [], targetMm: 0, targetDeg: 0, wristDeg: 0, poleStepDeg: 0, fingerStepDeg: 0, leftStepMm: 0, leftStepDeg: 0, leftIkMin: 1, leftIkEnd: 1, fingerGapMm: Infinity, fingerWorst: '', gloveInMm: 0, transitGapMm: Infinity };
    let n = 0;
    prevLeft.rig = null;
    prevFinger.right.length = prevFinger.left.length = 0;
    const track = () => {
      if (!vm.arms.group.visible) return;
      const rig = vm.activeRig!;
      const tested = held === gun;
      for (const side of SIDES) {
        const s = vm.arms.stats[side];
        if (s.targetErrMm >= 0) {
          row.targetMm = Math.max(row.targetMm, s.targetErrMm);
          row.targetDeg = Math.max(row.targetDeg, s.targetErrDeg);
          if (tested) row.wristDeg = Math.max(row.wristDeg, s.wristBendDeg);
        }
        if (prevLeft.rig === rig) row.poleStepDeg = Math.max(row.poleStepDeg, s.poleTurnDeg);
        const b = vm.arms.bonesOf(side)!;
        const bones = Object.values(b.fingers).flat();
        const prev = prevFinger[side];
        bones.forEach((bone, i) => {
          if (prev[i] && prevLeft.rig === rig) row.fingerStepDeg = Math.max(row.fingerStepDeg, angleDeg(prev[i], bone.quaternion));
          (prev[i] ??= new THREE.Quaternion()).copy(bone.quaternion);
        });
      }
      // The support wrist against the weapon.
      const lh = vm.arms.bonesOf('left')!.hand;
      inv.copy(rig.root.matrixWorld).invert();
      m.multiplyMatrices(inv, lh.matrixWorld).decompose(p, q, sc);
      if (prevLeft.rig === rig) {
        row.leftStepMm = Math.max(row.leftStepMm, p.distanceTo(prevLeft.p) * 1000);
        row.leftStepDeg = Math.max(row.leftStepDeg, angleDeg(q, prevLeft.q));
      }
      prevLeft.p.copy(p);
      prevLeft.q.copy(q);
      prevLeft.rig = rig;
      const ik = vm.arms.stats.left.ik;
      row.leftIkMin = Math.min(row.leftIkMin, ik);
      row.leftIkEnd = ik;
      // Clipping, sampled while both hands hold.
      const tb = vm.arms.stats.right.triggerBlend;
      const transit = tb > 0.03 && tb < 0.97;
      if (transit && tested && n % 3 === 0) {
        // The trigger finger on its way: reported, not judged.
        const g = fingerGaps(vm, 'right', new WeaponSurface(vm)).index;
        row.transitGapMm = Math.min(row.transitGapMm, ...g.map((x) => x * 1000));
      }
      if (n++ % 15 === 0 && !transit && tested && vm.arms.stats.right.ik >= 0.999 && ik >= 0.999) {
        const surf = new WeaponSurface(vm);
        for (const side of SIDES) {
          const g = fingerGaps(vm, side, surf);
          // The thumb's base is the ball of the thumb (palm): the glove measure has it.
          for (const [name, f] of Object.entries(g))
            f.forEach((x, j) => {
              if ((name === 'thumb' && j === 0) || x * 1000 >= row.fingerGapMm) return;
              row.fingerGapMm = x * 1000;
              row.fingerWorst = `${side} ${name} ${j + 1} (frame ${n}, ${vm.arms.stats[side].action}${side === 'right' ? ` ${vm.arms.stats.right.trigger}` : ''})`;
            });
          row.gloveInMm = Math.max(row.gloveInMm, gloveInside(vm, side, surf, 8).maxMm);
        }
      }
    };
    body(track);
    const L = HAND_LIMITS;
    const fail = (why: string) => {
      row.ok = false;
      row.notes.push(why);
    };
    if (row.targetMm > L.targetMm || row.targetDeg > L.targetDeg) fail(`a hand ${row.targetMm.toFixed(2)} mm / ${row.targetDeg.toFixed(2)}° off its target`);
    if (row.wristDeg > L.wristDeg) fail(`wrist bent ${row.wristDeg.toFixed(0)}°`);
    if (row.poleStepDeg > L.poleStepDeg) fail(`an elbow turned ${row.poleStepDeg.toFixed(0)}° in one frame`);
    if (row.fingerStepDeg > L.fingerStepDeg) fail(`a finger snapped ${row.fingerStepDeg.toFixed(0)}° in one frame`);
    if (row.leftStepMm > L.leftStepMm || row.leftStepDeg > L.leftStepDeg) fail(`the support hand jumped ${row.leftStepMm.toFixed(0)} mm / ${row.leftStepDeg.toFixed(0)}° in one frame`);
    if (expect.reload && row.leftIkMin > L.reloadLetGo) fail(`the reload never took the support hand (IK ≥ ${row.leftIkMin.toFixed(2)})`);
    if (row.leftIkEnd < L.holdAgain) fail(`the support hand isn't back on the weapon (IK ${row.leftIkEnd.toFixed(2)})`);
    if (row.fingerGapMm < -L.fingerInMm) fail(`a finger ${(-row.fingerGapMm).toFixed(1)} mm into the weapon: ${row.fingerWorst}`);
    if (row.gloveInMm > L.gloveInMm) fail(`glove ${row.gloveInMm.toFixed(1)} mm inside the weapon`);
    rows.push(row);
  };

  const walk = 6.2;
  const loop = (frames: number, o: Parameters<typeof frame>[0], track: () => void) => {
    for (let i = 0; i < frames; i++) {
      frame(o);
      track();
    }
  };
  const reload = (o: Parameters<typeof frame>[0], t: () => void, empty: boolean) => {
    gun.ammo = empty ? 0 : Math.max(1, Math.min(5, h.data.magazineSize - 2));
    if (empty) gun.chambered = false;
    loop(1, { ...o, reload: true }, t);
    for (let i = 0; i < 900 && gun.state === 'reloading'; i++) loop(1, o, t);
    loop(60, o, t);
  };

  run('idle', (t) => loop(120, {}, t));
  run('walk', (t) => loop(150, { speed: [0, -walk] }, t));
  run('strafe', (t) => {
    loop(60, { speed: [-walk, 0] }, t);
    loop(60, { speed: [walk, 0] }, t);
    loop(40, {}, t);
  });
  run('fast-turn', (t) => {
    loop(40, { look: 360 }, t);
    loop(40, { look: -360 }, t);
    loop(40, {}, t);
  });
  run('ads', (t) => loop(150, { ads: true }, t));
  run('shoot-single', (t) => {
    loop(40, { ads: true }, t);
    for (let k = 0; k < 6; k++) {
      loop(1, { ads: true, tap: true }, t);
      loop(14, { ads: true }, t);
    }
  });
  run('auto-fire', (t) => {
    loop(40, { ads: true }, t);
    loop(72, { ads: true, fire: true }, t);
    loop(40, { ads: true }, t);
  });
  run('sprint', (t) => {
    player.sprinting = true;
    loop(150, { speed: [0, -playerConfig.sprintSpeed] }, t);
    player.sprinting = false;
    loop(40, {}, t);
  });
  run('sprint-to-ads', (t) => {
    player.sprinting = true;
    loop(60, { speed: [0, -playerConfig.sprintSpeed] }, t);
    player.sprinting = false;
    loop(90, { ads: true }, t);
  });
  run('reload', (t) => reload({}, t, false), { reload: true });
  run('reload-empty', (t) => reload({}, t, true), { reload: true });
  run('reload-to-ads', (t) => {
    reload({}, t, false);
    loop(60, { ads: true }, t);
  }, { reload: true });
  run('switch', (t) => {
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
  run('crouch', (t) => {
    player.crouching = true;
    loop(60, { speed: [0, -walk * 0.5] }, t);
    loop(90, { ads: true }, t);
  });
  run('jump-land', (t) => {
    vm.onJump();
    player.grounded = false;
    loop(36, { speed: [0, -walk] }, t);
    player.grounded = true;
    vm.onLand(6);
    loop(60, { speed: [0, -walk] }, t);
    loop(40, {}, t);
  });
  return rows;
}
