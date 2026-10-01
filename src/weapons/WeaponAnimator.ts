import * as THREE from 'three';
import { smoothstep } from '../core/math';
import type { Weapon } from './Weapon';
import type { WeaponRig } from './WeaponModels';

/**
 * Procedural weapon animation: fire cycling (slide, pump), reloads (magazine,
 * bolt, shells, left hand). Driven entirely by Weapon state + normalized time,
 * so it can never desync from the gameplay state machine.
 *
 * Output: moves rig parts directly and writes a whole-weapon pose offset.
 */

type Key1 = [number, number];
type Key3 = [number, number, number, number];

function kf(t: number, keys: Key1[]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * smoothstep((t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

function kf3(t: number, keys: Key3[], out: THREE.Vector3): THREE.Vector3 {
  if (t <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < keys.length; i++) {
    const k1 = keys[i];
    if (t <= k1[0]) {
      const k0 = keys[i - 1];
      const s = smoothstep((t - k0[0]) / (k1[0] - k0[0]));
      return out.set(k0[1] + (k1[1] - k0[1]) * s, k0[2] + (k1[2] - k0[2]) * s, k0[3] + (k1[3] - k0[3]) * s);
    }
  }
  const k = keys[keys.length - 1];
  return out.set(k[1], k[2], k[3]);
}

interface MagReloadAnim {
  blend: Key1[];
  mag: Key3[];
  magRot: Key1[];
  hand: Key3[];
  bolt?: Key1[];
}

// Timings line up with RELOAD_TIMELINES in Weapon.ts.
const RIFLE_TACTICAL: MagReloadAnim = {
  blend: [[0, 0], [0.14, 1], [0.8, 1], [1, 0]],
  mag: [[0, 0, 0, 0], [0.2, 0, 0, 0], [0.24, 0, -0.04, 0.01], [0.34, -0.05, -0.35, 0.1], [0.44, -0.05, -0.35, 0.1], [0.55, 0, -0.05, 0.01], [0.6, 0, 0, 0]],
  magRot: [[0, 0], [0.22, 0], [0.34, 0.5], [0.44, 0.5], [0.55, 0.05], [0.6, 0]],
  hand: [[0, 0, 0, 0], [0.14, 0.005, -0.08, 0.26], [0.22, 0.005, -0.07, 0.26], [0.34, -0.05, -0.4, 0.36], [0.44, -0.05, -0.4, 0.36], [0.55, 0.005, -0.12, 0.26], [0.6, 0.005, -0.09, 0.26], [0.66, 0.005, -0.11, 0.26], [0.82, 0, 0, 0]],
};

const RIFLE_EMPTY: MagReloadAnim = {
  blend: [[0, 0], [0.12, 1], [0.56, 1], [0.64, 0.55], [0.84, 0.55], [1, 0]],
  mag: [[0, 0, 0, 0], [0.15, 0, 0, 0], [0.19, 0, -0.04, 0.01], [0.28, -0.05, -0.35, 0.1], [0.36, -0.05, -0.35, 0.1], [0.44, 0, -0.05, 0.01], [0.48, 0, 0, 0]],
  magRot: [[0, 0], [0.17, 0], [0.28, 0.5], [0.36, 0.5], [0.44, 0.05], [0.48, 0]],
  hand: [[0, 0, 0, 0], [0.11, 0.005, -0.08, 0.26], [0.17, 0.005, -0.07, 0.26], [0.28, -0.05, -0.4, 0.36], [0.36, -0.05, -0.4, 0.36], [0.44, 0.005, -0.12, 0.26], [0.48, 0.005, -0.09, 0.26], [0.6, 0.045, 0.07, 0.39], [0.66, 0.045, 0.07, 0.39], [0.7, 0.045, 0.07, 0.46], [0.75, 0.045, 0.07, 0.46], [0.78, 0.045, 0.09, 0.42], [0.92, 0, 0, 0]],
  bolt: [[0, 0], [0.66, 0], [0.7, 0.07], [0.76, 0.07], [0.785, 0]],
};

const PISTOL_TACTICAL: MagReloadAnim = {
  blend: [[0, 0], [0.14, 1], [0.78, 1], [1, 0]],
  mag: [[0, 0, 0, 0], [0.18, 0, 0, 0], [0.26, 0, -0.12, 0.02], [0.3, 0, -0.4, 0.05], [0.42, -0.03, -0.35, 0.06], [0.54, 0, -0.05, 0.01], [0.6, 0, 0, 0]],
  magRot: [[0, 0], [0.26, 0], [0.32, 0.2], [0.42, 0.3], [0.54, 0.02], [0.6, 0]],
  hand: [[0, 0, 0, 0], [0.16, -0.06, -0.08, 0.05], [0.3, -0.08, -0.3, 0.08], [0.42, -0.03, -0.3, 0.06], [0.54, 0.025, -0.09, 0.0], [0.6, 0.025, -0.07, 0.0], [0.66, 0.025, -0.09, 0.0], [0.82, 0, 0, 0]],
};

const PISTOL_EMPTY: MagReloadAnim = {
  blend: [[0, 0], [0.12, 1], [0.8, 1], [1, 0]],
  mag: [[0, 0, 0, 0], [0.14, 0, 0, 0], [0.21, 0, -0.12, 0.02], [0.25, 0, -0.4, 0.05], [0.36, -0.03, -0.35, 0.06], [0.46, 0, -0.05, 0.01], [0.5, 0, 0, 0]],
  magRot: [[0, 0], [0.21, 0], [0.27, 0.2], [0.36, 0.3], [0.46, 0.02], [0.5, 0]],
  hand: [[0, 0, 0, 0], [0.13, -0.06, -0.08, 0.05], [0.25, -0.08, -0.3, 0.08], [0.36, -0.03, -0.3, 0.06], [0.46, 0.025, -0.09, 0], [0.5, 0.025, -0.07, 0], [0.6, 0.025, 0.12, 0.0], [0.68, 0.025, 0.12, 0.02], [0.73, 0.025, 0.12, 0.065], [0.76, 0.025, 0.14, 0.05], [0.9, 0, 0, 0]],
  bolt: [[0, 0.045], [0.68, 0.045], [0.73, 0.055], [0.745, 0]],
};

/** Whole-weapon reload poses (rotation x/y/z rad, position x/y/z m). */
const RELOAD_POSE = {
  rifle: { rot: [0.14, 0.12, 0.48], pos: [-0.035, 0.03, 0.03] },
  pistol: { rot: [0.3, 0.1, 0.32], pos: [-0.03, 0.035, 0.04] },
  shotgun: { rot: [0.12, 0.1, -0.55], pos: [-0.03, 0.03, 0.03] },
} as const;

// Shotgun loading-port path, in pump-local coordinates (the left hand is parented to the pump).
const PORT: [number, number, number] = [0.0, -0.05, 0.31];
const SHELL_AWAY: [number, number, number] = [-0.1, -0.24, 0.42];
const SHELL_INSERT_KEYS: Key3[] = [
  [0, ...PORT],
  [0.28, ...SHELL_AWAY],
  [0.42, ...SHELL_AWAY],
  [0.78, PORT[0], PORT[1] - 0.025, PORT[2] + 0.04],
  [0.94, PORT[0], PORT[1] - 0.01, PORT[2] - 0.02],
  [1, ...PORT],
];

export interface PoseOffset {
  pos: THREE.Vector3;
  rot: THREE.Vector3;
}

export class WeaponAnimator {
  private tmp = new THREE.Vector3();
  private magRest = new THREE.Vector3();
  private boltRest = new THREE.Vector3();
  private pumpRest = new THREE.Vector3();
  private rig: WeaponRig | null = null;

  setRig(rig: WeaponRig): void {
    this.rig = rig;
    if (rig.mag) this.magRest.copy(rig.mag.position);
    if (rig.bolt) this.boltRest.copy(rig.bolt.position);
    if (rig.pump) this.pumpRest.copy(rig.pump.position);
  }

  /** Writes reload/cycle pose into `out` and moves rig parts. */
  update(weapon: Weapon, out: PoseOffset): void {
    const rig = this.rig;
    if (!rig) return;
    out.pos.set(0, 0, 0);
    out.rot.set(0, 0, 0);
    rig.leftHand.position.copy(rig.leftHandRest);
    if (rig.mag) {
      rig.mag.position.copy(this.magRest);
      rig.mag.rotation.x = 0;
    }
    if (rig.heldShell) rig.heldShell.visible = false;

    const model = weapon.data.model;
    const reloading = weapon.state === 'reloading';

    // --- Fire cycling ---
    if (rig.bolt && model === 'pistol') {
      const s = weapon.timeSinceShot;
      const cycle = s < 0.016 ? s / 0.016 : Math.max(0, 1 - (s - 0.016) / 0.06);
      let z = 0.045 * smoothstep(cycle);
      if (weapon.actionLockedBack) z = 0.045;
      rig.bolt.position.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + z);
    } else if (rig.bolt) {
      rig.bolt.position.copy(this.boltRest);
    }

    if (rig.pump) {
      let pumpZ = 0;
      const p = weapon.pumpTime;
      if (p < 0.62) {
        pumpZ = 0.09 * kf(p, [[0, 0], [0.2, 0], [0.36, 1], [0.42, 1], [0.58, 0]]);
        const tilt = kf(p, [[0, 0], [0.18, 0], [0.34, 1], [0.6, 0]]);
        out.rot.x += 0.05 * tilt;
        out.rot.z += 0.1 * tilt;
        out.pos.y -= 0.012 * tilt;
      }
      rig.pump.position.set(this.pumpRest.x, this.pumpRest.y, this.pumpRest.z + pumpZ);
    }

    if (!reloading) return;

    // --- Reloads ---
    const pose = RELOAD_POSE[model];
    if (weapon.data.reload.kind === 'magazine') {
      const t = weapon.stateProgress;
      const anim =
        model === 'rifle' ? (weapon.reloadEmpty ? RIFLE_EMPTY : RIFLE_TACTICAL) : weapon.reloadEmpty ? PISTOL_EMPTY : PISTOL_TACTICAL;
      const b = kf(t, anim.blend);
      out.rot.set(pose.rot[0] * b, pose.rot[1] * b, pose.rot[2] * b);
      out.pos.set(pose.pos[0] * b, pose.pos[1] * b, pose.pos[2] * b);
      if (rig.mag) {
        rig.mag.position.add(kf3(t, anim.mag, this.tmp));
        rig.mag.rotation.x = kf(t, anim.magRot);
      }
      rig.leftHand.position.add(kf3(t, anim.hand, this.tmp));
      if (rig.bolt && anim.bolt) {
        rig.bolt.position.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + kf(t, anim.bolt));
      }
      return;
    }

    // Shotgun: shell-by-shell.
    const phaseT = weapon.shellPhaseTime / Math.max(0.01, weapon.shellPhaseDuration);
    let blend = 1;
    const hand = rig.leftHand.position;
    if (weapon.shellPhase === 'start') {
      blend = smoothstep(phaseT);
      hand.lerpVectors(rig.leftHandRest, this.tmp.set(...PORT), smoothstep(phaseT));
    } else if (weapon.shellPhase === 'insert') {
      kf3(phaseT, SHELL_INSERT_KEYS, hand);
      if (rig.heldShell) rig.heldShell.visible = phaseT > 0.3 && phaseT < 0.95;
    } else {
      const endT = phaseT;
      blend = 1 - smoothstep(endT * 1.3);
      hand.lerpVectors(this.tmp.set(...PORT), rig.leftHandRest, smoothstep(endT * 2));
      if (weapon.reloadEmpty && rig.pump) {
        const s = weapon.shellPhaseTime;
        const pumpZ = 0.09 * kf(s, [[0, 0], [0.12, 0], [0.26, 1], [0.32, 1], [0.46, 0]]);
        rig.pump.position.z = this.pumpRest.z + pumpZ;
      }
    }
    out.rot.set(pose.rot[0] * blend, pose.rot[1] * blend, pose.rot[2] * blend);
    out.pos.set(pose.pos[0] * blend, pose.pos[1] * blend, pose.pos[2] * blend);
  }
}
