import * as THREE from 'three';
import { smoothstep } from '../core/math';
import type { Weapon } from './Weapon';
import type { WeaponRig } from './WeaponModels';
import type { HandAction } from './HandPose';
import { handConfig } from './hands/HandsConfig';

/**
 * Procedural weapon animation: fire cycling (slide, pump), reloads (magazine,
 * bolt, shells, left hand). Driven entirely by Weapon state + normalized time,
 * so it can never desync from the gameplay state machine.
 *
 * Rifle reload keyframes are built from each rig's anchors (where its magazine
 * and charging handle are), so every long gun shares one animation.
 * Output: moves rig parts directly and writes a whole-weapon pose offset.
 *
 * Keys are joined by a monotone cubic (C1, never past a key): a hand moves through a key
 * instead of stopping at every one, and only stops where the keys hold it. A magazine
 * reload is a sequence of named stages (ReloadEvent), reported as they pass; while the
 * support hand holds the magazine, the hand IS the magazine (it rides on it), so the old
 * one leaves with the hand and the fresh one comes in with it.
 *
 * The hands: besides moving the hand points, every frame says what each hand is doing
 * (rig.handPose: holding the grip, open, on the magazine, working the bolt) and its IK weight
 * on the weapon's hand target (rig.handIk: 1 holding it, 0 where the animation has the hand),
 * so the arms let go of the grip and take it back without a jump. A weapon whose profile puts
 * hand targets on its magazine and charging handle (schema 2) gets a rifle reload authored as
 * who holds the support hand (`holders`): the hand crossfades from the handguard onto the
 * magazine, rides on it (turning with it), onto the charging handle, back; the IK weight is
 * that timeline's, not a guess from distance. Others keep the hand path below (distance-based).
 */

type Key1 = [number, number];
type Key3 = [number, number, number, number];

/** Named reload stages, in order (not every reload has every one). */
export type ReloadEvent =
  | 'handLeavesGrip'
  | 'magazineGrab'
  | 'magazineDetach'
  | 'freshMagazine'
  | 'magazineInsert'
  | 'boltManipulation'
  | 'shellInsert'
  | 'handReturn';

/** Slope at key i of a monotone cubic through the keys (Fritsch–Butland: flat at the ends and at turns). */
function slope(t: (i: number) => number, v: (i: number) => number, n: number, i: number): number {
  if (i <= 0 || i >= n - 1) return 0;
  const h0 = t(i) - t(i - 1);
  const h1 = t(i + 1) - t(i);
  if (h0 <= 0 || h1 <= 0) return 0;
  const d0 = (v(i) - v(i - 1)) / h0;
  const d1 = (v(i + 1) - v(i)) / h1;
  if (d0 * d1 <= 0) return 0;
  return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
}

function hermite(t: number, t0: number, t1: number, v0: number, v1: number, m0: number, m1: number): number {
  const h = t1 - t0;
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * m1;
}

function kf(t: number, keys: Key1[]): number {
  const n = keys.length;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < n; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      if (t1 <= t0) return v1;
      const kt = (j: number) => keys[j][0];
      const kv = (j: number) => keys[j][1];
      return hermite(t, t0, t1, v0, v1, slope(kt, kv, n, i - 1), slope(kt, kv, n, i));
    }
  }
  return keys[n - 1][1];
}

function kf3(t: number, keys: Key3[], out: THREE.Vector3): THREE.Vector3 {
  const n = keys.length;
  if (t <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < n; i++) {
    const k1 = keys[i];
    if (t <= k1[0]) {
      const k0 = keys[i - 1];
      if (k1[0] <= k0[0]) return out.set(k1[1], k1[2], k1[3]);
      const kt = (j: number) => keys[j][0];
      const c = (a: 1 | 2 | 3) => {
        const kv = (j: number) => keys[j][a];
        return hermite(t, k0[0], k1[0], k0[a], k1[a], slope(kt, kv, n, i - 1), slope(kt, kv, n, i));
      };
      return out.set(c(1), c(2), c(3));
    }
  }
  const k = keys[n - 1];
  return out.set(k[1], k[2], k[3]);
}

/** Who holds the support hand: the weapon's grip target, or the target riding on a part. */
type Holder = 'grip' | 'mag' | 'bolt';

interface MagReloadAnim {
  blend: Key1[];
  mag: Key3[];
  magRot: Key1[];
  hand: Key3[];
  bolt?: Key1[];
  /** The support hand rides on the magazine over (from, to): hand = grip + magazine offset. */
  hold?: { from: number; to: number; grip: V };
  /**
   * Schema-2 weapons (hand targets on the magazine / charging handle): [time, holder] keys;
   * between two keys the hand crossfades (smoothstep) from one holder to the next. Letting go
   * of a part, the hand leaves from where the part was when it let go (it doesn't follow a
   * charging handle home). Used instead of `hand` / `hold`.
   */
  holders?: [number, Holder][];
  /** With `holders`: added to the hand while the animation has it (weapon space, m). */
  offset?: Key3[];
  /** The support hand's fingers from each time on (it starts on the grip). */
  poses: [number, HandAction][];
  events: [number, ReloadEvent][];
}

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const at = (t: number, v: V): Key3 => [t, v[0], v[1], v[2]];

/**
 * Rifle reloads from rig anchors (offsets from the left hand's rest position):
 *   M = hand on the magazine, B = charging handle.
 * Timings line up with RELOAD_TIMELINES in Weapon.ts. Stages: the support hand leaves the
 * handguard, takes the magazine, the release lets it drop out of the magwell, the hand
 * takes it down out of view (the old one away), brings a fresh one up from the pouch
 * tilted nose first, lines it up under the magwell, rocks it in (seated: the impact) and
 * goes back to the handguard (empty: by way of the charging handle).
 */
function rifleAnims(M: V, B: V, boltTravel: number): { tactical: MagReloadAnim; empty: MagReloadAnim } {
  const Z: V = [0, 0, 0];
  const magDown: V = [-0.05, -0.33, 0.1];
  const magFresh: V = [-0.02, -0.34, 0.06];
  return {
    tactical: {
      blend: [[0, 0], [0.14, 1], [0.8, 1], [1, 0]],
      mag: [[0, 0, 0, 0], [0.2, 0, 0, 0], [0.24, 0, -0.04, 0.01], at(0.34, magDown), at(0.44, magFresh), [0.53, 0, -0.06, 0.015], [0.57, 0, -0.015, 0.004], [0.6, 0, 0, 0]],
      magRot: [[0, 0], [0.22, 0], [0.34, 0.5], [0.44, 0.45], [0.53, 0.12], [0.57, 0.04], [0.6, 0]],
      hand: [at(0, Z), at(0.14, M), at(0.6, M), at(0.66, add(M, [0, -0.02, 0])), at(0.82, Z)],
      hold: { from: 0.14, to: 0.6, grip: M },
      holders: [[0.02, 'grip'], [0.14, 'mag'], [0.6, 'mag'], [0.82, 'grip']],
      offset: [[0.6, 0, 0, 0], [0.66, 0, -0.02, 0], [0.82, 0, 0, 0]],
      poses: [[0.02, 'open'], [0.11, 'reload'], [0.62, 'open'], [0.78, 'grip']],
      events: [[0.02, 'handLeavesGrip'], [0.14, 'magazineGrab'], [0.2, 'magazineDetach'], [0.39, 'freshMagazine'], [0.6, 'magazineInsert'], [0.82, 'handReturn']],
    },
    empty: {
      blend: [[0, 0], [0.12, 1], [0.56, 1], [0.64, 0.55], [0.84, 0.55], [1, 0]],
      mag: [[0, 0, 0, 0], [0.15, 0, 0, 0], [0.19, 0, -0.04, 0.01], at(0.28, magDown), at(0.36, magFresh), [0.43, 0, -0.06, 0.015], [0.46, 0, -0.015, 0.004], [0.48, 0, 0, 0]],
      magRot: [[0, 0], [0.17, 0], [0.28, 0.5], [0.36, 0.45], [0.43, 0.12], [0.46, 0.04], [0.48, 0]],
      hand: [
        at(0, Z), at(0.11, M), at(0.48, M),
        at(0.6, B), at(0.66, B), at(0.7, add(B, [0, 0, boltTravel])), at(0.75, add(B, [0, 0, boltTravel])), at(0.78, add(B, [0, 0.02, 0.03])), at(0.92, Z),
      ],
      bolt: [[0, 0], [0.66, 0], [0.7, boltTravel], [0.76, boltTravel], [0.785, 0]],
      hold: { from: 0.11, to: 0.48, grip: M },
      holders: [[0.02, 'grip'], [0.11, 'mag'], [0.48, 'mag'], [0.6, 'bolt'], [0.75, 'bolt'], [0.92, 'grip']],
      offset: [[0.75, 0, 0, 0], [0.79, 0, 0.02, 0.01], [0.92, 0, 0, 0]],
      poses: [[0.02, 'open'], [0.09, 'reload'], [0.5, 'open'], [0.57, 'interaction'], [0.77, 'open'], [0.88, 'grip']],
      events: [[0.02, 'handLeavesGrip'], [0.11, 'magazineGrab'], [0.15, 'magazineDetach'], [0.32, 'freshMagazine'], [0.48, 'magazineInsert'], [0.6, 'boltManipulation'], [0.92, 'handReturn']],
    },
  };
}

const PISTOL_TACTICAL: MagReloadAnim = {
  blend: [[0, 0], [0.14, 1], [0.78, 1], [1, 0]],
  mag: [[0, 0, 0, 0], [0.18, 0, 0, 0], [0.26, 0, -0.12, 0.02], [0.3, 0, -0.4, 0.05], [0.42, -0.03, -0.35, 0.06], [0.54, 0, -0.05, 0.01], [0.6, 0, 0, 0]],
  magRot: [[0, 0], [0.26, 0], [0.32, 0.2], [0.42, 0.3], [0.54, 0.02], [0.6, 0]],
  hand: [[0, 0, 0, 0], [0.16, -0.06, -0.08, 0.05], [0.3, -0.08, -0.3, 0.08], [0.42, -0.03, -0.3, 0.06], [0.54, 0.025, -0.09, 0.0], [0.6, 0.025, -0.07, 0.0], [0.66, 0.025, -0.09, 0.0], [0.82, 0, 0, 0]],
  poses: [[0.02, 'open'], [0.26, 'reload'], [0.62, 'open'], [0.78, 'grip']],
  events: [[0.02, 'handLeavesGrip'], [0.2, 'magazineDetach'], [0.42, 'freshMagazine'], [0.6, 'magazineInsert'], [0.82, 'handReturn']],
};

const PISTOL_EMPTY: MagReloadAnim = {
  blend: [[0, 0], [0.12, 1], [0.8, 1], [1, 0]],
  mag: [[0, 0, 0, 0], [0.14, 0, 0, 0], [0.21, 0, -0.12, 0.02], [0.25, 0, -0.4, 0.05], [0.36, -0.03, -0.35, 0.06], [0.46, 0, -0.05, 0.01], [0.5, 0, 0, 0]],
  magRot: [[0, 0], [0.21, 0], [0.27, 0.2], [0.36, 0.3], [0.46, 0.02], [0.5, 0]],
  hand: [[0, 0, 0, 0], [0.13, -0.06, -0.08, 0.05], [0.25, -0.08, -0.3, 0.08], [0.36, -0.03, -0.3, 0.06], [0.46, 0.025, -0.09, 0], [0.5, 0.025, -0.07, 0], [0.6, 0.025, 0.12, 0.0], [0.68, 0.025, 0.12, 0.02], [0.73, 0.025, 0.12, 0.065], [0.76, 0.025, 0.14, 0.05], [0.9, 0, 0, 0]],
  bolt: [[0, 0.045], [0.68, 0.045], [0.73, 0.055], [0.745, 0]],
  poses: [[0.02, 'open'], [0.22, 'reload'], [0.5, 'open'], [0.58, 'interaction'], [0.78, 'open'], [0.88, 'grip']],
  events: [[0.02, 'handLeavesGrip'], [0.16, 'magazineDetach'], [0.36, 'freshMagazine'], [0.5, 'magazineInsert'], [0.68, 'boltManipulation'], [0.9, 'handReturn']],
};

/** Whole-weapon reload poses (rotation x/y/z rad, position x/y/z m). */
const RELOAD_POSE = {
  rifle: { rot: [0.14, 0.12, 0.48], pos: [-0.035, 0.03, 0.03] },
  bolt: { rot: [0.12, 0.1, 0.38], pos: [-0.025, 0.03, 0.02] },
  pistol: { rot: [0.3, 0.1, 0.32], pos: [-0.03, 0.035, 0.04] },
  shotgun: { rot: [0.12, 0.1, -0.55], pos: [-0.03, 0.03, 0.03] },
} as const;

/**
 * Without first-person arms (hands.json `enabled: false`) a magazine reload has to read on the
 * weapon alone: it rolls its magwell toward the eye, the old magazine drops out and falls away
 * (accelerating, tumbling), a fresh one rises from below and snaps in. Times follow each
 * reload's own magazineDetach / magazineInsert events, so sounds and gameplay stay in step.
 */
export const HANDLESS_RELOAD = {
  /** Whole-weapon pose at the reload's height (rotation rad, position m), per animation set. */
  pose: {
    rifle: { rot: [0.1, 0.25, 1.2], pos: [-0.04, 0.06, 0.03] },
    bolt: { rot: [0.12, 0.1, 0.38], pos: [-0.025, 0.03, 0.02] },
    pistol: { rot: [0.35, 0.3, 0.6], pos: [-0.05, 0.05, 0.04] },
    shotgun: { rot: [0.12, 0.1, -0.55], pos: [-0.03, 0.03, 0.03] },
  } as Record<string, { rot: number[]; pos: number[] }>,
  /** How long the old magazine falls before it is gone, and the fresh one's rise (reload fractions). */
  fall: 0.12,
  rise: 0.13,
  /**
   * Where a magazine is out of sight (weapon space, m) and its tumble there (rad). Weapon space
   * rolled by the rifle pose (its magwell turned toward the eye): this way falls DOWN the
   * screen (straight −Y would fly sideways). Flip x with the roll's sign.
   */
  away: [-0.35, -0.25, 0.06] as V,
  tumble: 0.9,
};

const handlessKeys = new WeakMap<MagReloadAnim, { mag: Key3[]; magRot: Key1[]; from: number[] }>();

/** The handless magazine path for `anim` (from its detach / insert times; redone when the tuning changes). */
function handlessMag(anim: MagReloadAnim): { mag: Key3[]; magRot: Key1[] } {
  const H = HANDLESS_RELOAD;
  const hit = handlessKeys.get(anim);
  const f = hit?.from;
  if (f && f[0] === H.fall && f[1] === H.rise && f[2] === H.tumble && f[3] === H.away[0] && f[4] === H.away[1] && f[5] === H.away[2]) return hit;
  const td = anim.events.find(([, e]) => e === 'magazineDetach')?.[0] ?? 0.2;
  const ti = anim.events.find(([, e]) => e === 'magazineInsert')?.[0] ?? 0.6;
  const [ax, ay, az] = H.away;
  const out = {
    mag: [
      [0, 0, 0, 0],
      [td, 0, 0, 0],
      [td + H.fall * 0.25, 0, -0.015, 0.004],
      [td + H.fall * 0.6, ax * 0.3, ay * 0.2, az * 0.3],
      [td + H.fall, ax, ay, az],
      [ti - H.rise, ax * 0.7, ay, az],
      [ti - H.rise * 0.5, 0, -0.09, 0.025],
      [ti - H.rise * 0.18, 0, -0.012, 0.004],
      [ti, 0, 0, 0],
    ] as Key3[],
    magRot: [
      [0, 0],
      [td, 0],
      [td + H.fall, H.tumble],
      [ti - H.rise, H.tumble * 0.5],
      [ti - H.rise * 0.5, 0.15],
      [ti - H.rise * 0.18, 0.03],
      [ti, 0],
    ] as Key1[],
    from: [H.fall, H.rise, H.tumble, ...H.away],
  };
  handlessKeys.set(anim, out);
  return out;
}

// Shotgun loading-port path, in pump-local coordinates (the left hand is parented to the pump).
const PORT: V = [0.0, -0.05, 0.31];
const SHELL_AWAY: V = [-0.1, -0.24, 0.42];
const SHELL_INSERT_KEYS: Key3[] = [
  at(0, PORT),
  at(0.28, SHELL_AWAY),
  at(0.42, SHELL_AWAY),
  [0.78, PORT[0], PORT[1] - 0.025, PORT[2] + 0.04],
  [0.94, PORT[0], PORT[1] - 0.01, PORT[2] - 0.02],
  at(1, PORT),
];

export interface PoseOffset {
  pos: THREE.Vector3;
  rot: THREE.Vector3;
}

/** How far from its grip (m) a hand has fully let go of it. */
const HAND_AWAY = 0.04;
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Bolt-action loading path for the right hand (offsets from its rest position, root space).
const ROUND_POUCH: V = [0.09, -0.2, 0.06];
const ROUND_PORT: V = [-0.005, 0.085, -0.14];

export class WeaponAnimator {
  /** Reload stages as they pass (magazine reloads by time, shell reloads by phase). */
  onEvent: ((e: ReloadEvent) => void) | null = null;
  private tmp = new THREE.Vector3();
  private held = new THREE.Vector3();
  private evT = -1;
  private evPhase = '';
  private magRest = new THREE.Vector3();
  private boltRest = new THREE.Vector3();
  private pumpRest = new THREE.Vector3();
  private rig: WeaponRig | null = null;
  private rifle: { tactical: MagReloadAnim; empty: MagReloadAnim } | null = null;
  private knob = new THREE.Vector3();
  private grip = new THREE.Vector3();
  /** The rig has hand targets on its magazine / charging handle: reloads use `holders`. */
  private anchored = false;
  /** The support hand's IK weight as a reload's `holders` set it this frame (-1: none). */
  private leftIk = -1;
  private hp = new THREE.Vector3();
  private hq = new THREE.Quaternion();
  private ap = new THREE.Vector3();
  private aq = new THREE.Quaternion();
  private partP = new THREE.Vector3();
  private partQ = new THREE.Quaternion();
  private kv = new THREE.Vector3();

  setRig(rig: WeaponRig): void {
    this.rig = rig;
    this.anchored = !!(rig.hands?.magazine && rig.mag && rig.bolt && rig.hands.magazine.parent === rig.mag && rig.mag.parent === rig.leftHand.parent);
    if (rig.mag) this.magRest.copy(rig.mag.position);
    if (rig.bolt) this.boltRest.copy(rig.bolt.position);
    if (rig.pump) this.pumpRest.copy(rig.pump.position);
    if (rig.mag && rig.bolt) {
      const h = rig.leftHandRest;
      const m = rig.mag.position;
      const b = rig.bolt.position;
      const M: V = [m.x - h.x, m.y - 0.07 - h.y, m.z - 0.01 - h.z];
      const B: V = [b.x + 0.01 - h.x, b.y + 0.03 - h.y, b.z - h.z];
      this.rifle = rifleAnims(M, B, 0.07);
    }
  }

  /** lift 0..1 rotates the handle up, slide 0..1 pulls the bolt back. */
  private setBolt(rig: WeaponRig, lift: number, slide: number): void {
    rig.bolt!.rotation.z = 1.25 * lift;
    rig.bolt!.position.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + 0.085 * slide);
  }

  /** Blend the right hand from the grip onto the bolt knob. */
  private handOnKnob(rig: WeaponRig, grab: number): void {
    const k = rig.bolt!.userData.knob as THREE.Vector3 | undefined;
    if (!k || grab <= 0) return;
    if (rig.hands) rig.hands.oriented.right = false;
    this.knob.copy(k).applyEuler(rig.bolt!.rotation).add(rig.bolt!.position);
    this.knob.y -= 0.035;
    this.knob.z += 0.02;
    rig.rightHand.position.lerpVectors(rig.rightHandRest, this.knob, grab);
  }

  /** Bolt open, rounds pushed in one by one, bolt closed. */
  private boltReload(weapon: Weapon, rig: WeaponRig, out: PoseOffset): void {
    const phaseT = weapon.shellPhaseTime / Math.max(0.01, weapon.shellPhaseDuration);
    let open = 1;
    let blend = 1;
    let grab = 0;
    if (weapon.shellPhase === 'start') {
      open = smoothstep(phaseT * 1.6);
      blend = smoothstep(phaseT);
      grab = kf(phaseT, [[0, 0], [0.25, 1], [0.75, 1], [1, 0]]);
    } else if (weapon.shellPhase === 'insert') {
      const h = this.grip.copy(rig.rightHandRest);
      const keys: Key3[] = [
        at(0, [0, 0, 0]),
        at(0.3, ROUND_POUCH),
        at(0.45, ROUND_POUCH),
        at(0.75, ROUND_PORT),
        at(0.9, [ROUND_PORT[0], ROUND_PORT[1] - 0.03, ROUND_PORT[2]]),
        at(1, [0, 0, 0]),
      ];
      rig.rightHand.position.copy(h).add(kf3(phaseT, keys, this.tmp));
      if (rig.hands) rig.hands.oriented.right = false;
      // Fingers on a round from the pouch to the port.
      if (phaseT > 0.12 && phaseT < 0.94) rig.handPose.right = 'interaction';
      if (rig.heldShell) rig.heldShell.visible = phaseT > 0.35 && phaseT < 0.9;
    } else {
      const s = weapon.shellPhaseTime;
      open = 1 - smoothstep(s / 0.22);
      blend = 1 - smoothstep(phaseT * 1.2);
      grab = kf(phaseT, [[0, 1], [0.5, 1], [0.85, 0]]);
    }
    const lift = Math.min(1, open * 1.6);
    const slide = Math.max(0, open * 1.6 - 0.6);
    this.setBolt(rig, lift, slide);
    if (weapon.shellPhase !== 'insert') {
      this.handOnKnob(rig, grab);
      if (grab > 0.05) rig.handPose.right = 'interaction';
    }
    const pose = RELOAD_POSE.bolt;
    out.rot.set(pose.rot[0] * blend, pose.rot[1] * blend, pose.rot[2] * blend);
    out.pos.set(pose.pos[0] * blend, pose.pos[1] * blend, pose.pos[2] * blend);
  }

  /**
   * The support hand by a reload's `holders` (schema-2 rigs): its IK weight on the grip target,
   * and the animation's hand (place and turn) from the targets riding on the magazine and the
   * charging handle.
   */
  private holdLeft(rig: WeaponRig, anim: MagReloadAnim, t: number): void {
    const keys = anim.holders!;
    let from = keys[0][1];
    let to = from;
    let s = 0;
    let t0 = 0;
    if (t > keys[0][0]) {
      let i = 1;
      while (i < keys.length && t > keys[i][0]) i++;
      if (i >= keys.length) from = to = keys[keys.length - 1][1];
      else {
        from = keys[i - 1][1];
        to = keys[i][1];
        t0 = keys[i - 1][0];
        if (from !== to) s = smoothstep((t - t0) / Math.max(1e-6, keys[i][0] - t0));
      }
    }
    this.leftIk = from === to ? (from === 'grip' ? 1 : 0) : from === 'grip' ? 1 - s : to === 'grip' ? s : 0;
    if (from === 'grip' && to === 'grip') return;
    // The animation's own hand crossfades too (the grip's place is the rest it was reset to),
    // so it meets the grip exactly where the arms' eased IK weight hands over: no jump.
    const p = this.hp;
    const q = this.hq;
    if (from === to) this.anchorAt(rig, anim, to, t, p, q);
    else {
      // From where the hand let go of the first holder (the grip: its rest), onto the second as it is.
      if (from === 'grip') {
        p.copy(rig.leftHand.position);
        q.copy(rig.leftHand.quaternion);
      } else this.anchorAt(rig, anim, from, t0, p, q);
      if (to === 'grip') {
        this.ap.copy(rig.leftHand.position);
        this.aq.copy(rig.leftHand.quaternion);
      } else this.anchorAt(rig, anim, to, t, this.ap, this.aq);
      p.lerp(this.ap, s);
      q.slerp(this.aq, s);
    }
    if (anim.offset) p.add(kf3(t, anim.offset, this.kv));
    rig.leftHand.position.copy(p);
    rig.leftHand.quaternion.copy(q);
  }

  /** Where the hand target on a part is at reload time `tau` (the part as the reload puts it then; root space). */
  private anchorAt(rig: WeaponRig, anim: MagReloadAnim, holder: Holder, tau: number, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    const node = holder === 'mag' ? rig.hands!.magazine : rig.hands!.chargingHandle;
    if (!node) {
      outP.copy(rig.leftHandRest);
      outQ.copy(rig.hands!.restQ.left);
      return;
    }
    if (holder === 'mag') {
      this.partP.copy(this.magRest).add(kf3(tau, anim.mag, this.kv));
      this.partQ.setFromAxisAngle(X_AXIS, kf(tau, anim.magRot));
    } else {
      this.partP.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + (anim.bolt ? kf(tau, anim.bolt) : 0));
      this.partQ.identity();
    }
    outQ.copy(this.partQ).multiply(node.quaternion);
    outP.copy(node.position).applyQuaternion(this.partQ).add(this.partP);
  }

  /** Writes reload/cycle pose into `out`, moves rig parts and says what the hands do. */
  update(weapon: Weapon, out: PoseOffset): void {
    const rig = this.rig;
    if (!rig) return;
    this.leftIk = -1;
    this.animate(weapon, rig, out);
    // As a reload's holders say; else on the grip until the hand is 4 cm away from it.
    rig.handIk.left = this.leftIk >= 0 ? this.leftIk : 1 - smoothstep(rig.leftHand.position.distanceTo(rig.leftHandRest) / HAND_AWAY);
    rig.handIk.right = 1 - smoothstep(rig.rightHand.position.distanceTo(rig.rightHandRest) / HAND_AWAY);
  }

  private animate(weapon: Weapon, rig: WeaponRig, out: PoseOffset): void {
    out.pos.set(0, 0, 0);
    out.rot.set(0, 0, 0);
    rig.leftHand.position.copy(rig.leftHandRest);
    rig.rightHand.position.copy(rig.rightHandRest);
    rig.handPose.left = 'grip';
    rig.handPose.right = 'grip';
    // Schema-2 hand points carry the hand's turn: at rest, their target's. A path below that
    // moves a point without turning it says so (oriented false): the arms turn the hand.
    const h = rig.hands;
    if (h) {
      const v2 = h.resolved.schema === 2;
      h.oriented.left = h.oriented.right = v2;
      if (v2) {
        rig.leftHand.quaternion.copy(h.restQ.left);
        rig.rightHand.quaternion.copy(h.restQ.right);
      }
    }
    if (rig.mag) {
      rig.mag.position.copy(this.magRest);
      rig.mag.rotation.x = 0;
    }
    if (rig.heldShell) rig.heldShell.visible = false;

    const set = weapon.data.animSet;
    const reloading = weapon.state === 'reloading';
    if (!reloading) {
      this.evT = -1;
      this.evPhase = '';
    }

    // --- Fire cycling ---
    if (rig.bolt && set === 'pistol') {
      const s = weapon.timeSinceShot;
      const cycle = s < 0.016 ? s / 0.016 : Math.max(0, 1 - (s - 0.016) / 0.06);
      let z = 0.045 * smoothstep(cycle);
      if (weapon.actionLockedBack) z = 0.045;
      rig.bolt.position.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + z);
    } else if (rig.bolt) {
      rig.bolt.position.copy(this.boltRest);
      rig.bolt.rotation.z = 0;
    }

    // --- Bolt action: right hand leaves the grip, lifts, pulls, pushes, locks ---
    if (set === 'bolt' && rig.bolt && !reloading) {
      const t = weapon.pumpTime / Math.max(0.01, weapon.cycleDuration);
      if (t < 1) {
        const lift = kf(t, [[0, 0], [0.14, 0], [0.26, 1], [0.62, 1], [0.74, 0], [1, 0]]);
        const slide = kf(t, [[0, 0], [0.26, 0], [0.42, 1], [0.5, 1], [0.64, 0], [1, 0]]);
        const grab = kf(t, [[0, 0], [0.13, 1], [0.8, 1], [0.95, 0]]);
        this.setBolt(rig, lift, slide);
        this.handOnKnob(rig, grab);
        if (grab > 0.05) rig.handPose.right = 'interaction';
        const cant = kf(t, [[0, 0], [0.15, 1], [0.75, 1], [1, 0]]);
        out.rot.z += 0.16 * cant;
        out.rot.x += 0.03 * cant;
        out.pos.y -= 0.012 * cant;
      }
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
    const handless = !handConfig().enabled;
    const pose = handless ? HANDLESS_RELOAD.pose[set] ?? RELOAD_POSE[set] : RELOAD_POSE[set];
    if (weapon.data.reload.kind === 'magazine') {
      const t = weapon.stateProgress;
      const anim = set === 'rifle' ? (weapon.reloadEmpty ? this.rifle!.empty : this.rifle!.tactical) : weapon.reloadEmpty ? PISTOL_EMPTY : PISTOL_TACTICAL;
      const b = kf(t, anim.blend);
      out.rot.set(pose.rot[0] * b, pose.rot[1] * b, pose.rot[2] * b);
      out.pos.set(pose.pos[0] * b, pose.pos[1] * b, pose.pos[2] * b);
      const path = handless ? handlessMag(anim) : anim;
      const magOff = kf3(t, path.mag, this.held);
      if (rig.mag) {
        rig.mag.position.add(magOff);
        rig.mag.rotation.x = kf(t, path.magRot);
      }
      if (this.anchored && anim.holders) this.holdLeft(rig, anim, t);
      else {
        const hand = kf3(t, anim.hand, this.tmp);
        const hold = anim.hold;
        if (hold && t > hold.from && t < hold.to) hand.set(hold.grip[0] + magOff.x, hold.grip[1] + magOff.y, hold.grip[2] + magOff.z);
        rig.leftHand.position.add(hand);
        if (rig.hands) rig.hands.oriented.left = false;
      }
      for (const [pt, pose] of anim.poses) if (t >= pt) rig.handPose.left = pose;
      for (const [et, e] of anim.events) if (et > this.evT && et <= t) this.onEvent?.(e);
      this.evT = t;
      if (rig.bolt && anim.bolt) {
        rig.bolt.position.set(this.boltRest.x, this.boltRest.y, this.boltRest.z + kf(t, anim.bolt));
      }
      return;
    }

    if (weapon.shellPhase !== this.evPhase) {
      this.evPhase = weapon.shellPhase;
      this.onEvent?.(weapon.shellPhase === 'start' ? 'handLeavesGrip' : weapon.shellPhase === 'insert' ? 'shellInsert' : 'handReturn');
    }
    if (set === 'bolt') {
      this.boltReload(weapon, rig, out);
      return;
    }

    // Shotgun: shell-by-shell.
    const phaseT = weapon.shellPhaseTime / Math.max(0.01, weapon.shellPhaseDuration);
    let blend = 1;
    const hand = rig.leftHand.position;
    if (rig.hands) rig.hands.oriented.left = false;
    if (weapon.shellPhase === 'start') {
      blend = smoothstep(phaseT);
      hand.lerpVectors(rig.leftHandRest, this.tmp.set(...PORT), smoothstep(phaseT));
    } else if (weapon.shellPhase === 'insert') {
      kf3(phaseT, SHELL_INSERT_KEYS, hand);
      if (rig.heldShell) rig.heldShell.visible = phaseT > 0.3 && phaseT < 0.95;
    } else {
      blend = 1 - smoothstep(phaseT * 1.3);
      hand.lerpVectors(this.tmp.set(...PORT), rig.leftHandRest, smoothstep(phaseT * 2));
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
