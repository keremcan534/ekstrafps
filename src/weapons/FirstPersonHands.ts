import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import config from '../config/hands.json';
import type { WeaponRig } from './WeaponModels';
import { smoothstep } from '../core/math';
import { FINGER_NAMES, approachPose, copyPose, flatPose, gripQuaternion, lerpFinger, type FingerName, type FingerPose, type HandAction, type HandPose } from './HandPose';

type V3 = [number, number, number];

/**
 * The player's first-person arms: the glove model (public/hands/arms.glb, skinned to a hand
 * skeleton by scripts/rig-arms.mjs) on the weapon's grips. The glove belongs to the skeleton;
 * the hands hold the weapon, never the other way round.
 *
 * Per hand, every frame:
 *   1. Target: the weapon's RightHandGrip / LeftHandGrip (position + rotation, from the view
 *      profile's `hands`), blended by the hand's IK weight with where the weapon's animation
 *      has the hand (rig.leftHand / rig.rightHand, turned to its reload / interaction
 *      rotation). Normal holding: weight 1. A reload takes the weight to 0 and gives it back;
 *      the weight itself eases, so the hand never jumps.
 *   2. The Hand bone: the glove's `palmGrip` point (hands.json, hand space) on the target.
 *   3. Two-bone IK, shoulder → elbow → wrist (aimed, the firing shoulder moves onto the
 *      stock's butt, where a real one is). The elbow points its `elbow` way, turned (by
 *      `natural`) toward where the forearm would continue the hand (`forearm`, hand space);
 *      the forearm rolls with the hand, so the wrist bends but never twists.
 *   4. Fingers: the action's pose (grip / open / reload / interaction, HandPose.ts), eased in;
 *      on the grip the right index finger blends from `safe` to `ready` (aimed, or just fired)
 *      and presses to `pull` with each shot.
 *
 * Hidden on a weapon without hands (rig.hands: a view profile's, or a procedural gun's from
 * src/config/gunhands.json).
 */
type Side = 'right' | 'left';
const SIDES: Side[] = ['right', 'left'];
const BONE_SIDE = { right: 'Right', left: 'Left' } as const;
const BONE_FINGER: Record<FingerName, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };

interface ArmSettings {
  /** Aim space (m). */
  shoulder: V3;
  /**
   * Aimed, the shoulder is where the stock sits: this offset (aim space, m) from the
   * weapon's butt point (the firing side only; the support shoulder stays put).
   */
  aimShoulder?: V3;
  /** Aim space: the way the elbow points. */
  elbow: V3;
  /**
   * Hand space: the forearm's natural line out of the wrist (toward the elbow), and how much
   * (0…1) it turns the elbow from `elbow` toward where that line would put it.
   */
  forearm: V3;
  natural: number;
  /** The elbow never points higher than this (the pole's aim-space y, −1 straight down … 1 up). */
  elbowUp: number;
}
export interface HandsConfig {
  model: string;
  palmGrip: V3;
  sleeve: { radius: [number, number]; color: string };
  right: ArmSettings;
  left: ArmSettings;
  /** Easing time constants (s); `pull`: how long a shot keeps the trigger pressed. */
  timing: { fingers: number; ik: number; trigger: number; pull: number };
  open: HandPose;
  reload: { rotation: V3; pose: HandPose };
  interaction: { rotation: V3; pose: HandPose };
}
const CONFIG = config as unknown as HandsConfig;

/** The arms' settings (the calibration page edits them live; the game only reads them). */
export const handConfig = (): HandsConfig => CONFIG;

let source: THREE.Object3D | null = null;

/** Load the glove model (missing: no arms). Never rejects. */
export async function loadArms(): Promise<void> {
  try {
    source = (await new GLTFLoader().loadAsync(CONFIG.model)).scene;
  } catch {
    source = null;
  }
}

/** What the arms need from the weapon's state this frame. */
export interface ArmsInput {
  ads: number;
  sprint: number;
  /** Seconds since the last shot. */
  sinceShot: number;
  reloading: boolean;
}

/** Calibration overrides: hold a hand state still to look at it. */
export interface ArmsPreview {
  action?: HandAction;
  /** Trigger finger: 0 safe … 1 ready; `pull` 0…1 on top. */
  trigger?: number;
  pull?: number;
  /** No easing: every pose and weight lands this frame. */
  instant?: boolean;
}

interface Arm {
  upper: THREE.Bone;
  fore: THREE.Bone;
  hand: THREE.Bone;
  fingers: Record<FingerName, THREE.Bone[]>;
  rest: Map<THREE.Bone, THREE.Quaternion>;
  upperLen: number;
  foreLen: number;
  /** The fingers as they are (eased) and this frame's target. */
  pose: HandPose;
  target: HandPose;
  ik: number;
  sleeve: THREE.Mesh;
  gizmo: THREE.Group;
}

/** Measured each frame (the calibration page and the checks read it). */
export interface ArmStats {
  /** Wrist: angle between forearm and hand (deg), and any twist between them (deg). */
  wristBendDeg: number;
  wristTwistDeg: number;
  /** How far out of reach the grip is (m): the upper arm's sleeve stretches by that. */
  reachM: number;
  /** IK weight on the grip. */
  ik: number;
  action: HandAction;
}

const Y = new THREE.Vector3(0, 1, 0);

/**
 * The upper arm's sleeve: the glove model ends at the elbow, so the upper arm is a tube in
 * the forearm sleeve's camo (its tones sampled off the model's texture: dark grey, lighter
 * blotches, a fabric weave). Deterministic, made once.
 */
let sleeveMap: THREE.CanvasTexture | null = null;
function sleeveTexture(): THREE.CanvasTexture {
  if (sleeveMap) return sleeveMap;
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = 'rgb(41,45,48)';
  g.fillRect(0, 0, N, N);
  // Blotches, drawn wrapped so the tile repeats without a seam.
  for (let i = 0; i < 140; i++) {
    const x = rnd() * N, y = rnd() * N, r = 8 + rnd() * 26;
    const v = rnd();
    const [cr, cg, cb] = v < 0.45 ? [24, 26, 28] : v < 0.8 ? [58, 61, 64] : [74, 77, 82];
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.55)`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grad;
      g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  // Weave: fine light and dark threads both ways.
  for (let i = 0; i < N; i += 2) {
    g.fillStyle = `rgba(255,255,255,${0.025 + rnd() * 0.03})`;
    g.fillRect(0, i, N, 1);
    g.fillStyle = `rgba(0,0,0,${0.04 + rnd() * 0.04})`;
    g.fillRect(i, 0, 1, N);
  }
  sleeveMap = new THREE.CanvasTexture(c);
  sleeveMap.colorSpace = THREE.SRGBColorSpace;
  sleeveMap.wrapS = sleeveMap.wrapT = THREE.RepeatWrapping;
  sleeveMap.repeat.set(1.5, 2.5);
  sleeveMap.anisotropy = 4;
  return sleeveMap;
}

export class FirstPersonArms {
  readonly group = new THREE.Group();
  /** Grip gizmos: each grip's forward (blue) and up (green, the back of the hand). */
  showGizmos = false;
  preview: ArmsPreview = {};
  readonly stats: Record<Side, ArmStats> = {
    right: { wristBendDeg: 0, wristTwistDeg: 0, reachM: 0, ik: 1, action: 'grip' },
    left: { wristBendDeg: 0, wristTwistDeg: 0, reachM: 0, ik: 1, action: 'grip' },
  };
  private model: THREE.Object3D | null = null;
  private arms: Partial<Record<Side, Arm>> = {};
  private trigger = 0;
  private butt = new THREE.Vector3();
  private ads = 0;
  private sleeveMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
  private t = {
    inv: new THREE.Matrix4(),
    m: new THREE.Matrix4(),
    m2: new THREE.Matrix4(),
    hand: new THREE.Matrix4(),
    upper: new THREE.Matrix4(),
    fore: new THREE.Matrix4(),
    pg: new THREE.Vector3(),
    pa: new THREE.Vector3(),
    p: new THREE.Vector3(),
    s: new THREE.Vector3(),
    e: new THREE.Vector3(),
    w: new THREE.Vector3(),
    d: new THREE.Vector3(),
    pole: new THREE.Vector3(),
    hint: new THREE.Vector3(),
    x: new THREE.Vector3(),
    y: new THREE.Vector3(),
    z: new THREE.Vector3(),
    sc: new THREE.Vector3(),
    qg: new THREE.Quaternion(),
    qa: new THREE.Quaternion(),
    qw: new THREE.Quaternion(),
    q: new THREE.Quaternion(),
    eu: new THREE.Euler(0, 0, 0, 'ZXY'),
    index: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as FingerPose,
  };

  constructor() {
    this.group.name = 'Arms';
    this.group.visible = false;
    if (!source) return;
    const model = cloneSkinned(source);
    model.traverse((o) => {
      o.frustumCulled = false;
    });
    this.model = model;
    this.group.add(model);
    this.sleeveMat.color.set(CONFIG.sleeve.color);
    this.sleeveMat.map = sleeveTexture();
    const bone = (n: string) => {
      const b = model.getObjectByName(n) as THREE.Bone | undefined;
      if (!b) throw new Error(`arms.glb: no bone ${n}`);
      return b;
    };
    for (const side of SIDES) {
      const S = BONE_SIDE[side];
      const fingers = {} as Record<FingerName, THREE.Bone[]>;
      const rest = new Map<THREE.Bone, THREE.Quaternion>();
      for (const f of FINGER_NAMES) {
        fingers[f] = [1, 2, 3].map((i) => bone(`${S}${BONE_FINGER[f]}0${i}`));
        for (const b of fingers[f]) rest.set(b, b.quaternion.clone());
      }
      const upper = bone(`${S}UpperArm`);
      const fore = bone(`${S}ForeArm`);
      const hand = bone(`${S}Hand`);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(CONFIG.sleeve.radius[1], CONFIG.sleeve.radius[0], 1, 20, 1, true).translate(0, 0.5, 0), this.sleeveMat);
      sleeve.frustumCulled = false;
      this.group.add(sleeve);
      const gizmo = new THREE.Group();
      gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.07, 0x3a7bff, 0.015, 0.008));
      gizmo.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.05, 0x48ff7a, 0.012, 0.007));
      gizmo.add(new THREE.Mesh(new THREE.SphereGeometry(0.004, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe14a })));
      gizmo.traverse((o) => {
        o.renderOrder = 999;
        o.frustumCulled = false;
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.depthTest = false;
      });
      gizmo.visible = false;
      this.group.add(gizmo);
      this.arms[side] = {
        upper,
        fore,
        hand,
        fingers,
        rest,
        upperLen: fore.position.length(),
        foreLen: hand.position.length(),
        pose: copyPose(CONFIG.open, flatPose()),
        target: flatPose(),
        ik: 1,
        sleeve,
        gizmo,
      };
    }
  }

  /** A hand's bones (calibration: fitting fingers, measuring). */
  bonesOf(side: Side): { hand: THREE.Bone; fingers: Record<FingerName, THREE.Bone[]> } | null {
    const a = this.arms[side];
    return a ? { hand: a.hand, fingers: a.fingers } : null;
  }

  /** Calibration: a hand's fingers straight onto `pose` (no easing), matrices updated. */
  poseHand(side: Side, pose: Readonly<HandPose>): void {
    const arm = this.arms[side];
    if (!arm) return;
    copyPose(pose, arm.pose);
    this.poseFingers(arm, side, arm.pose.index);
    arm.hand.updateMatrixWorld(true);
  }

  /** The glove mesh (checks: skinned vertices). */
  get gloves(): THREE.SkinnedMesh | null {
    let m: THREE.SkinnedMesh | null = null;
    this.model?.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) m = o as THREE.SkinnedMesh;
    });
    return m;
  }

  /**
   * Put both arms on `rig` (in `space`, the node holding `group`; world matrices must be
   * current). Hidden without the rig's hands or the model.
   */
  update(dt: number, rig: WeaponRig | null, space: THREE.Object3D, input: ArmsInput): void {
    const hands = rig?.hands?.def;
    const show = !!hands && !!this.model && !!rig;
    this.group.visible = show;
    if (!show || !rig || !hands) return;
    const t = this.t;
    const pv = this.preview;
    const ease = (tau: number) => (pv.instant ? 1 : 1 - Math.exp(-dt / Math.max(1e-3, tau)));
    t.inv.copy(space.matrixWorld).invert();
    // The weapon's turn in arm space (reload / interaction rotations are weapon space).
    t.m.multiplyMatrices(t.inv, rig.root.matrixWorld).decompose(t.p, t.qw, t.sc);
    // The butt in arm space: aimed, the firing shoulder sits behind it.
    this.butt.copy(rig.butt).applyMatrix4(t.m);
    this.ads = input.ads;

    // Trigger finger: ready when aimed or just fired; never sprinting or reloading.
    const ready = !input.reloading && input.sprint < 0.5 && (input.ads > 0.4 || input.sinceShot < 0.6) ? 1 : 0;
    this.trigger += (ready - this.trigger) * ease(CONFIG.timing.trigger);
    const trig = pv.trigger ?? this.trigger;
    const pulse = pv.pull ?? (input.sinceShot < 0.025 ? input.sinceShot / 0.025 : Math.max(0, 1 - (input.sinceShot - 0.025) / CONFIG.timing.pull));

    for (const side of SIDES) {
      const arm = this.arms[side]!;
      const c = CONFIG[side];
      const action: HandAction = pv.action ?? rig.handPose[side];
      // 1. Target: the grip, blended by the IK weight with the animated hand.
      arm.ik += (rig.handIk[side] - arm.ik) * ease(CONFIG.timing.ik);
      const grip = side === 'right' ? rig.hands!.right : rig.hands!.left;
      t.m.multiplyMatrices(t.inv, grip.matrixWorld).decompose(t.pg, t.qg, t.sc);
      (side === 'right' ? rig.rightHand : rig.leftHand).getWorldPosition(t.pa).applyMatrix4(t.inv);
      const turn = action === 'reload' ? (hands.reload?.rotation ?? CONFIG.reload.rotation) : action === 'interaction' ? (hands.interaction?.rotation ?? CONFIG.interaction.rotation) : null;
      if (turn) t.qa.copy(t.qw).multiply(gripQuaternion(turn, t.q));
      else t.qa.copy(t.qg);
      t.qa.slerp(t.qg, arm.ik);
      t.pa.lerp(t.pg, arm.ik);
      // 2. The Hand bone: palmGrip (hand space) on the target.
      t.hand.compose(t.pa, t.qa, t.sc.set(1, 1, 1)).multiply(t.m2.makeTranslation(-CONFIG.palmGrip[0], -CONFIG.palmGrip[1], -CONFIG.palmGrip[2]));
      arm.gizmo.visible = this.showGizmos;
      if (this.showGizmos) {
        arm.gizmo.position.copy(t.pg);
        arm.gizmo.quaternion.copy(t.qg);
      }
      // 3. Arm IK.
      this.solveArm(arm, c, side);
      // 4. Fingers.
      const base: Readonly<HandPose> =
        action === 'grip' ? (side === 'right' ? hands.rightPose : hands.leftPose) : action === 'open' ? CONFIG.open : action === 'reload' ? (hands.reload?.pose ?? CONFIG.reload.pose) : (hands.interaction?.pose ?? CONFIG.interaction.pose);
      copyPose(base, arm.target);
      if (side === 'right' && action === 'grip') lerpFinger(hands.trigger.safe, hands.trigger.ready, trig, arm.target.index);
      approachPose(arm.pose, arm.target, ease(CONFIG.timing.fingers));
      // The shot's press goes on top, uneased (a trigger is quick).
      let index: Readonly<FingerPose> = arm.pose.index;
      if (side === 'right' && action === 'grip' && pulse > 0) index = lerpFinger(arm.pose.index, hands.trigger.pull, pulse * trig, t.index);
      this.poseFingers(arm, side, index);
      this.stats[side].ik = arm.ik;
      this.stats[side].action = action;
    }
    this.group.updateMatrixWorld(true);
  }

  private solveArm(arm: Arm, c: ArmSettings, side: Side): void {
    const t = this.t;
    const a = arm.upperLen;
    const b = arm.foreLen;
    const W = t.w.setFromMatrixPosition(t.hand);
    const S = t.s.set(...c.shoulder);
    if (c.aimShoulder && this.ads > 0) S.lerp(t.p.copy(this.butt).add(t.hint.set(...c.aimShoulder)), smoothstep(this.ads));
    const st = this.stats[side];
    // Out of reach (a viewmodel holds its gun further out than an arm): the arm goes straight
    // and the upper arm (a plain sleeve, nothing skinned to it) takes the extra length; the
    // shoulder stays off the screen and the glove's forearm never stretches.
    let d = S.distanceTo(W);
    const reach = (a + b) * 0.995;
    st.reachM = Math.max(0, d - reach);
    const dir = t.d.subVectors(W, S).normalize();
    d = Math.max(d, Math.abs(a - b) + 1e-3);
    // The elbow's way, turned toward the natural one (the forearm continuing out of the hand).
    t.x.set(...c.forearm).transformDirection(t.hand);
    const pole = t.pole.copy(W).addScaledVector(t.x, b).sub(S);
    pole.addScaledVector(dir, -pole.dot(dir));
    const hint = t.hint.set(...c.elbow);
    hint.addScaledVector(dir, -hint.dot(dir)).normalize();
    // As natural as the elbow can be without rising above `elbowUp`.
    if (pole.lengthSq() < 1e-8) pole.copy(hint);
    else {
      pole.normalize();
      t.z.copy(pole);
      for (let w = c.natural; w >= 0; w -= 0.1) {
        pole.copy(t.z).multiplyScalar(w).addScaledVector(hint, 1 - w).normalize();
        if (pole.y <= c.elbowUp || w < 0.05) break;
      }
    }
    const E = t.e;
    if (d > reach) E.copy(W).addScaledVector(dir, -b);
    else {
      const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
      E.copy(S).addScaledVector(dir, a * cosA).addScaledVector(pole, a * Math.sqrt(1 - cosA * cosA));
    }

    // Hand frame axes (columns of the hand matrix).
    const hx = new THREE.Vector3().setFromMatrixColumn(t.hand, 0);
    const hy = new THREE.Vector3().setFromMatrixColumn(t.hand, 1);
    const hz = new THREE.Vector3().setFromMatrixColumn(t.hand, 2);
    // Forearm: elbow → wrist, rolled with the hand (the wrist bends, never twists).
    const fy = t.y.subVectors(W, E).normalize();
    const fz = t.z.copy(hz).addScaledVector(fy, -hz.dot(fy));
    if (fz.lengthSq() < 0.09) fz.copy(hx).cross(fy);
    fz.normalize();
    const fx = new THREE.Vector3().crossVectors(fy, fz);
    t.fore.makeBasis(fx, fy, fz).setPosition(E);
    // Upper arm: shoulder → elbow, its bend plane facing the elbow's way (stretched when out
    // of reach: the bone is moved to the elbow's end, so its child sits at the elbow).
    const uy = new THREE.Vector3().subVectors(E, S).normalize();
    const uz = pole.clone().addScaledVector(uy, -pole.dot(uy));
    if (uz.lengthSq() < 1e-6) uz.copy(hint).addScaledVector(uy, -hint.dot(uy));
    uz.normalize();
    t.upper.makeBasis(new THREE.Vector3().crossVectors(uy, uz), uy, uz).setPosition(t.x.copy(E).addScaledVector(uy, -a));

    // Bones: the upper arm hangs in arm space (its parents are identity), the rest local.
    arm.upper.position.setFromMatrixPosition(t.upper);
    arm.upper.quaternion.setFromRotationMatrix(t.upper);
    t.m.copy(t.upper).invert().multiply(t.fore).decompose(arm.fore.position, arm.fore.quaternion, t.sc);
    t.m.copy(t.fore).invert().multiply(t.hand).decompose(arm.hand.position, arm.hand.quaternion, t.sc);
    // The sleeve: shoulder → elbow.
    arm.sleeve.position.copy(S);
    arm.sleeve.quaternion.setFromUnitVectors(Y, uy);
    arm.sleeve.scale.set(1, S.distanceTo(E), 1);

    st.wristBendDeg = THREE.MathUtils.radToDeg(fy.angleTo(hy));
    // Twist: the hand's palm against the forearm's, about the forearm.
    const pz = hz.clone().addScaledVector(fy, -hz.dot(fy));
    st.wristTwistDeg = pz.lengthSq() > 1e-6 ? THREE.MathUtils.radToDeg(pz.angleTo(fz)) : 0;
  }

  private poseFingers(arm: Arm, side: Side, index: Readonly<FingerPose>): void {
    const t = this.t;
    const m = side === 'right' ? 1 : -1;
    const D = THREE.MathUtils.DEG2RAD;
    for (const f of FINGER_NAMES) {
      const joints = f === 'index' ? index : arm.pose[f];
      arm.fingers[f].forEach((b, j) => {
        const [curl, spread, twist] = joints[j];
        t.eu.set(curl * D, twist * m * D, spread * m * D, 'ZXY');
        b.quaternion.copy(arm.rest.get(b)!).multiply(t.q.setFromEuler(t.eu));
      });
    }
  }
}
