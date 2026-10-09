import * as THREE from 'three';
import type { AimMode, PlayerTarget, Soldier } from '../enemies/Soldier';
import type { Physics } from '../core/Physics';
import { humanoidView } from '../targets/Humanoid';
import { MasterCharacter } from '../characters/MasterCharacter';
import { masterAssets } from '../characters/MasterAssets';
import { SIDES } from '../characters/master/MasterRig';
import { measureMaster, Rows, yawSweep, type CheckRow } from './masterGameChecks';
import { fitGrip } from './masterGripFit';

/**
 * The master humanoid's game holds driven through the Soldier (soldier-lab.html: window.__slm).
 * Every soldier stands on its mark; `drive` moves them as the game would (walking in place on a
 * treadmill, crouching, turning toward a moving target, reloading, dying) and `checks` measures
 * the master bodies along the way (dev/masterGameChecks.ts), plus the frame-to-frame jumps.
 *
 *   __slm.checks({ mode, gun, walk, crouch, turn, reload }) → report rows
 *   __slm.drive(frames, { walk, crouch, turn, reload }) → step everything that many frames
 *   __slm.kill(i) → shoot soldier i down (its ragdoll)
 *   __slm.perf(n, frames) → ms per frame for the bodies' update (n soldiers)
 *   __slm.fit(i) → fit soldier i's hold frames on its gun (dev/masterGripFit.ts): masterRig.json game.grip.fit
 */
export interface DriveOptions {
  mode?: AimMode;
  /** Walking speed (m/s, in place). */
  walk?: number;
  /** Crouch target 0 … 1. */
  crouch?: number;
  /** Turn rate of the target round the soldier (deg/s): the soldier turns to keep facing it. */
  turn?: number;
  /** Reload once at the start. */
  reload?: boolean;
}

interface Lab {
  soldiers: (Soldier & { home?: THREE.Vector3 })[];
  cam: THREE.PerspectiveCamera;
  /** Stepped with the soldiers (a floor is laid for the ragdolls). */
  physics?: Physics;
}

export function masterGameLab(lab: Lab) {
  const target: PlayerTarget = {
    feet: new THREE.Vector3(0, 0, 30), head: new THREE.Vector3(0, 1.7, 30), chest: new THREE.Vector3(0, 1.35, 30),
    velocity: new THREE.Vector3(), sprinting: false, crouching: false, alive: false,
  };
  const face = new THREE.Vector3();
  const goal = new THREE.Vector3();
  let time = 0;
  const masters = () => lab.soldiers.filter((s) => s.body.visual instanceof MasterCharacter);
  // The ragdolls need a floor (the lab's is only drawn).
  lab.physics?.addStaticBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(40, 0.5, 40));

  /** One frame of every soldier, as the game drives them (the camera is the LOD's viewer). */
  function step(dt: number, o: DriveOptions): void {
    time += dt;
    humanoidView.copy(lab.cam.position);
    lab.physics?.step();
    lab.physics?.syncObjects();
    for (const s of lab.soldiers) {
      const home = s.home ?? s.pos;
      s.pos.copy(home);
      const a = THREE.MathUtils.degToRad((o.turn ?? 0) * time);
      face.set(home.x + Math.sin(a) * 30, 1.4, home.z + Math.cos(a) * 30);
      if (o.walk) {
        // Walk toward a point far ahead (and keep the soldier on its mark: a treadmill).
        goal.set(home.x + Math.sin(a) * 100, 0, home.z + Math.cos(a) * 100);
        s.steerTo(goal, o.walk);
      } else {
        s.stop();
        s.vel.set(0, 0, 0);
      }
      s.crouchTarget = o.crouch ?? 0;
      s.update(dt, target, lab.soldiers, face, o.mode ?? 'aim', false);
    }
  }

  function drive(frames: number, o: DriveOptions = {}, each?: (k: number) => void): void {
    if (o.reload) for (const s of lab.soldiers) if (s.alive) (s.ammo = 0), s.startReload();
    for (let k = 0; k < frames; k++) {
      step(1 / 60, o);
      each?.(k);
    }
  }

  /** Measure the master bodies over `frames` frames of a drive; jumps frame to frame too. */
  function checks(o: DriveOptions & { frames?: number; settle?: number; every?: number; surface?: boolean } = {}): { rows: CheckRow[]; samples: number; ms: number; jumps: { handDeg: number; elbowCm: number; where: string }; yaw?: ReturnType<typeof yawSweep> } {
    const t0 = performance.now();
    drive(o.settle ?? 60, o);
    const rows = new Rows();
    let samples = 0;
    const prev = new Map<Soldier, { q: Record<string, THREE.Quaternion>; e: Record<string, THREE.Vector3> }>();
    const jumps = { handDeg: 0, elbowCm: 0, where: '' };
    const inv = new THREE.Matrix4();
    drive(o.frames ?? 60, o, (k) => {
      for (const [i, s] of masters().entries()) {
        const m = s.body.visual as MasterCharacter;
        if (k % (o.every ?? 10) === 0) {
          const x = measureMaster(s, o.surface ?? true);
          if (x) rows.fold(x, `#${i} f${k}`);
          samples++;
        }
        // Frame to frame, in character space: a hand turning or an elbow moving at once is a pop.
        inv.copy(s.body.root.matrixWorld).invert();
        const cur = { q: {} as Record<string, THREE.Quaternion>, e: {} as Record<string, THREE.Vector3> };
        const rootQ = s.body.root.getWorldQuaternion(new THREE.Quaternion()).invert();
        for (const sd of SIDES) {
          const arm = m.rig.arms[sd];
          cur.q[sd] = arm.hand.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootQ);
          cur.e[sd] = new THREE.Vector3().setFromMatrixPosition(arm.fore.matrixWorld).applyMatrix4(inv);
          const p = prev.get(s);
          if (p) {
            const d = THREE.MathUtils.radToDeg(cur.q[sd].angleTo(p.q[sd]));
            const e = cur.e[sd].distanceTo(p.e[sd]) * 100;
            if (d > jumps.handDeg) [jumps.handDeg, jumps.where] = [d, `#${i} ${sd} f${k}`];
            jumps.elbowCm = Math.max(jumps.elbowCm, e);
          }
        }
        prev.set(s, cur);
      }
    });
    const first = masters()[0];
    const yaw = first ? yawSweep(first) : undefined;
    return { rows: rows.list(), samples, ms: Math.round(performance.now() - t0), jumps, yaw };
  }

  /** Shoot soldier `i` down (a heavy blow from the front): its ragdoll. */
  function kill(i: number): void {
    const s = lab.soldiers[i];
    s.body.meleeHit(10000, s.body.root.position.clone().add(new THREE.Vector3(0, 1.2, 2)), 2.5);
  }

  /** Mean ms per frame spent updating the soldiers (their bodies, holds and AI), over `frames`. */
  function perf(frames = 300, o: DriveOptions = {}): { msPerFrame: number; soldiers: number; masters: number } {
    drive(30, o);
    const t0 = performance.now();
    drive(frames, o);
    return { msPerFrame: +((performance.now() - t0) / frames).toFixed(3), soldiers: lab.soldiers.length, masters: masters().length };
  }

  /** Fit soldier i's two hold frames on the gun it holds now (stand it in 'aim' first). */
  function fit(i: number, maxEvals?: number) {
    const s = lab.soldiers[i];
    return fitGrip(s, (s as unknown as { modelKey: string }).modelKey, maxEvals);
  }

  return { step, drive, checks, kill, perf, masters, fit, assets: masterAssets };
}
