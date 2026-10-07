import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { WeaponRig } from './WeaponModels';
import { smoothstep } from '../core/math';
import { FINGERS, SIDES, bindArmRig, fingerBoneIndex, type ArmBones, type ArmRig, type ArmRigReport, type FingerName, type Side } from './hands/ArmRig';
import { TwoBoneArmIK } from './hands/ArmIK';
import { FingerPoser, type TriggerState } from './hands/FingerPoser';
import { HandDebug, type HandDebugArm } from './hands/HandDebug';
import { handConfig, type HandsConfig } from './hands/HandsConfig';
import { poseQuats } from './hands/HandProfile';
import type { HandAction, HandPose } from './HandPose';

export { handConfig, type HandsConfig };

/**
 * The player's first-person arms: ONE canonical arm skeleton (hands/ArmRig.ts) wearing the glove
 * model (public/hands/arms.glb, skinned by scripts/rig-arms.mjs), holding the weapon in hand.
 *
 *   WEAPON          defines where the hands belong: RightHandTarget / LeftHandTarget, nodes of
 *                   the weapon (HandGrips.ts), so its procedural motion carries them.
 *   ANIMATION       WeaponAnimator (procedural keyframes; nothing here uses an AnimationMixer)
 *                   moves the hand points for reloads and bolt work and says, per hand, its IK
 *                   weight on the weapon's target (rig.handIk: 1 holding, 0 the animation has
 *                   it) and what its fingers do (rig.handPose).
 *   ARM IK          gets each wrist to its target (hands/ArmIK.ts: analytic two-bone).
 *   GRIP POSES      make the fingers right (hands/FingerPoser.ts: library poses, slerped).
 *
 * Per hand, every frame, in this order (after all weapon motion, Viewmodel.update):
 *   1. IK weight: the animation's, eased (a hand never teleports onto the weapon).
 *   2. Target: the weapon's hand target and the animation's hand point, both read in arm space,
 *      blended by the weight (position lerp, orientation slerp). A point that carries no turn
 *      of its own (schema-1 weapons, path animations) turns by what the hand does, eased.
 *   3. The Hand bone on it (schema 1: the target is the palm, the wrist is palmGrip behind).
 *   4. Arm IK, the firing shoulder moving onto the stock's butt while aimed.
 *   5. Fingers: the grip pose (+ corrections, trigger finger SAFE / READY / PRESS) or the
 *      animation's pose, slerped.
 *   6. Matrices. Nothing writes these bones after this.
 *
 * Hidden on a weapon without hands (rig.hands).
 */

let source: THREE.Object3D | null = null;
let reported = false;

/** Load the glove model (missing: no arms). Never rejects. */
export async function loadArms(): Promise<void> {
  if (!handConfig().enabled) return;
  try {
    source = (await new GLTFLoader().loadAsync(handConfig().model)).scene;
  } catch (e) {
    console.warn(`[hands] ${handConfig().model} did not load: no first-person arms`, e);
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
  /** Trigger finger: 0 SAFE … 1 READY; `pull` 0…1 the press on top. */
  trigger?: number;
  pull?: number;
  /** IK weight on the weapon's target, per hand (instead of the animation's). */
  ik?: Partial<Record<Side, number>>;
  /** No easing: every pose and weight lands this frame. */
  instant?: boolean;
}

/** Measured each frame (the calibration page and the checks read it). */
export interface ArmStats {
  /** Wrist: angle between forearm and hand (deg), and any twist between them (deg). */
  wristBendDeg: number;
  wristTwistDeg: number;
  /** How far out of the arm's comfortable reach the target is (m): the upper arm's sleeve takes it. */
  reachM: number;
  /** IK weight on the weapon's target. */
  ik: number;
  action: HandAction;
  /** The wrist against the weapon's target while holding it (IK ≥ 0.999; else -1): mm and deg. */
  targetErrMm: number;
  targetErrDeg: number;
  /** How far the elbow's direction turned this frame (deg). */
  poleTurnDeg: number;
  /** The trigger finger (right hand), and its blend SAFE (0) … TRIGGER_READY (1). */
  trigger: TriggerState;
  triggerBlend: number;
}

interface Arm {
  bones: ArmBones;
  solver: TwoBoneArmIK;
  fingers: FingerPoser;
  /** The upper arm's parent frame in arm space, inverted (constant). */
  upperParentInv: THREE.Matrix4;
  weight: number;
  /** The hand's turn (weapon space) when its point carries none: eased toward the action's. */
  turn: THREE.Quaternion;
  turnSet: boolean;
  /** This frame's hand frame (arm space, the Hand bone) and the weapon's wish for it. */
  want: THREE.Matrix4;
  onTarget: THREE.Matrix4;
  sleeve: THREE.Mesh;
  /** Cached for the dev tools. */
  byFinger: Record<FingerName, THREE.Bone[]>;
}

const Y = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * The upper arm's sleeve: the glove model ends at the elbow, so the upper arm is a tube in the
 * forearm sleeve's camo (tones sampled off the model's texture: dark grey, lighter blotches, a
 * fabric weave). Deterministic, made once.
 */
let sleeveMap: THREE.CanvasTexture | null = null;
function sleeveTexture(): THREE.CanvasTexture {
  if (sleeveMap) return sleeveMap;
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  g.fillStyle = 'rgb(41,45,48)';
  g.fillRect(0, 0, N, N);
  // Blotches, drawn wrapped so the tile repeats without a seam.
  for (let i = 0; i < 140; i++) {
    const x = rnd() * N,
      y = rnd() * N,
      r = 8 + rnd() * 26;
    const v = rnd();
    const [cr, cg, cb] = v < 0.45 ? [24, 26, 28] : v < 0.8 ? [58, 61, 64] : [74, 77, 82];
    for (const dx of [-N, 0, N])
      for (const dy of [-N, 0, N]) {
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
  preview: ArmsPreview = {};
  readonly stats: Record<Side, ArmStats> = {
    right: { wristBendDeg: 0, wristTwistDeg: 0, reachM: 0, ik: 1, action: 'grip', targetErrMm: 0, targetErrDeg: 0, poleTurnDeg: 0, trigger: 'SAFE', triggerBlend: 0 },
    left: { wristBendDeg: 0, wristTwistDeg: 0, reachM: 0, ik: 1, action: 'grip', targetErrMm: 0, targetErrDeg: 0, poleTurnDeg: 0, trigger: 'SAFE', triggerBlend: 0 },
  };
  /** What binding the canonical skeleton found (errors: no arms; warnings: asset problems). */
  readonly rigReport: ArmRigReport = { errors: [], warnings: [] };
  readonly debug: HandDebug;
  private rig: ArmRig | null = null;
  private arms: Partial<Record<Side, Arm>> = {};
  private trigger = 0;
  private butt = new THREE.Vector3();
  private sleeveMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
  private t = {
    inv: new THREE.Matrix4(),
    m: new THREE.Matrix4(),
    m2: new THREE.Matrix4(),
    pw: new THREE.Vector3(),
    qw: new THREE.Quaternion(),
    pg: new THREE.Vector3(),
    qg: new THREE.Quaternion(),
    pa: new THREE.Vector3(),
    qa: new THREE.Quaternion(),
    q: new THREE.Quaternion(),
    s: new THREE.Vector3(),
    v: new THREE.Vector3(),
    sc: new THREE.Vector3(),
  };
  private debugArms: Record<Side, HandDebugArm> | null = null;
  /** The weapon the arms held last frame: a new one is taken already gripped (it comes in off-screen). */
  private lastRig: WeaponRig | null = null;

  constructor() {
    this.group.name = 'Arms';
    this.group.visible = false;
    this.debug = new HandDebug(this.group, null);
    if (!source) return;
    const model = cloneSkinned(source);
    model.traverse((o) => {
      o.frustumCulled = false;
    });
    const rig = bindArmRig(model, this.rigReport);
    if (!reported) {
      reported = true;
      for (const e of this.rigReport.errors) console.error(`[hands] ${handConfig().model}: ${e}`);
      for (const w of this.rigReport.warnings) console.warn(`[hands] ${handConfig().model}: ${w}`);
    }
    if (!rig) return;
    this.rig = rig;
    this.group.add(model);
    this.group.updateMatrixWorld(true);
    this.debug = new HandDebug(this.group, model);
    // In the game: `?handdebug` draws the targets, elbow directions and hand axes.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('handdebug')) this.debug.enabled = true;
    const C = handConfig();
    this.sleeveMat.color.set(C.sleeve.color);
    this.sleeveMat.map = sleeveTexture();
    for (const side of SIDES) {
      const bones = rig.bones[side];
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(C.sleeve.radius[1], C.sleeve.radius[0], 1, 20, 1, true).translate(0, 0.5, 0), this.sleeveMat);
      sleeve.frustumCulled = false;
      this.group.add(sleeve);
      const byFinger = {} as Record<FingerName, THREE.Bone[]>;
      for (const f of FINGERS) byFinger[f] = [0, 1, 2].map((j) => bones.fingers[fingerBoneIndex(f, j)]);
      this.arms[side] = {
        bones,
        solver: new TwoBoneArmIK(bones.upperLen, bones.foreLen),
        fingers: new FingerPoser(side, bones),
        // The arms model hangs straight in arm space; the upper arm's parents are fixed.
        upperParentInv: bones.upper.parent!.matrixWorld.clone().invert(),
        weight: 1,
        turn: new THREE.Quaternion(),
        turnSet: false,
        want: new THREE.Matrix4(),
        onTarget: new THREE.Matrix4(),
        sleeve,
        byFinger,
      };
    }
  }

  /** The grip-target gizmos (the calibration page's old switch): the debug helpers' axes. */
  get showGizmos(): boolean {
    return this.debug.enabled;
  }
  set showGizmos(v: boolean) {
    this.debug.enabled = v;
  }

  /** A hand's bones (dev tools: measuring, fitting). */
  bonesOf(side: Side): { hand: THREE.Bone; fingers: Record<FingerName, THREE.Bone[]> } | null {
    const a = this.arms[side];
    return a ? { hand: a.bones.hand, fingers: a.byFinger } : null;
  }

  /** Calibration (schema-1 tools): a hand's fingers straight onto a degree pose, matrices updated. */
  poseHand(side: Side, pose: Readonly<HandPose>): void {
    const arm = this.arms[side];
    if (!arm) return;
    arm.fingers.snap(poseQuats(pose));
    arm.bones.hand.updateMatrixWorld(true);
  }

  /** The glove mesh (checks: skinned vertices). */
  get gloves(): THREE.SkinnedMesh | null {
    return this.rig?.mesh ?? null;
  }

  /** The arm's IK solver (debug readouts: shoulder, elbow, pole). */
  solverOf(side: Side): TwoBoneArmIK | null {
    return this.arms[side]?.solver ?? null;
  }

  /**
   * Put both arms on `rig` (in `space`, the node holding `group`; world matrices must be
   * current). Hidden without the rig's hands or the model.
   */
  update(dt: number, rig: WeaponRig | null, space: THREE.Object3D, input: ArmsInput): void {
    const h = rig?.hands;
    const show = !!h && !!this.rig && !!rig;
    this.group.visible = show;
    if (!show || !rig || !h) {
      this.debug.hide();
      return;
    }
    const C = handConfig();
    const R = h.resolved;
    const t = this.t;
    const pv = this.preview;
    // A weapon switch: the new weapon's grip, fingers and elbows land at once (no easing from
    // the old weapon's, no elbow history), while it is still being drawn up out of view.
    const switched = rig !== this.lastRig;
    this.lastRig = rig;
    if (switched) for (const side of SIDES) this.arms[side]!.solver.reset();
    const instant = !!pv.instant || switched;
    const ease = (tau: number) => (instant ? 1 : 1 - Math.exp(-dt / Math.max(1e-3, tau)));
    t.inv.copy(space.matrixWorld).invert();
    // The weapon in arm space: its turn (weapon-space orientations) and its butt.
    t.m.multiplyMatrices(t.inv, rig.root.matrixWorld).decompose(t.pw, t.qw, t.sc);
    this.butt.copy(rig.butt).applyMatrix4(t.m);
    const shouldered = rig.shellType !== 'pistol';

    // Trigger finger: READY when aimed or just fired; never sprinting or reloading. The press
    // is the shot's own, on top.
    const ready = !input.reloading && input.sprint < 0.5 && (input.ads > 0.4 || input.sinceShot < 0.6) ? 1 : 0;
    this.trigger += (ready - this.trigger) * ease(C.timing.trigger);
    const trig = pv.trigger ?? this.trigger;
    const press = pv.pull ?? (input.sinceShot < 0.025 ? input.sinceShot / 0.025 : Math.max(0, 1 - (input.sinceShot - 0.025) / C.timing.pull));

    for (const side of SIDES) {
      const arm = this.arms[side]!;
      const c = C[side];
      const action: HandAction = pv.action ?? rig.handPose[side];
      // 1. Who has the hand: the weapon's target (1) or the animation (0), eased.
      arm.weight += ((pv.ik?.[side] ?? rig.handIk[side]) - arm.weight) * ease(C.timing.ik);
      // 2. The weapon's target and the animation's hand point, in arm space.
      const target = side === 'right' ? h.right : h.left;
      t.m.multiplyMatrices(t.inv, target.matrixWorld).decompose(t.pg, t.qg, t.sc);
      const point = side === 'right' ? rig.rightHand : rig.leftHand;
      t.m.multiplyMatrices(t.inv, point.matrixWorld).decompose(t.pa, t.qa, t.sc);
      if (h.oriented[side]) {
        // The point's own turn; kept (weapon space) for when a point without one takes over.
        arm.turn.copy(t.qw).invert().multiply(t.qa);
        arm.turnSet = true;
      } else {
        // No turn of its own: what the hand does says it (on the magazine, on the bolt; else
        // the grip's), eased so a change of action never snaps the wrist.
        const turn = action === 'reload' ? R.turn.reload : action === 'interaction' ? R.turn.interaction : t.q.copy(t.qw).invert().multiply(t.qg);
        if (!arm.turnSet || instant) arm.turn.copy(turn);
        else arm.turn.slerp(turn, ease(C.timing.turn));
        arm.turnSet = true;
        t.qa.copy(t.qw).multiply(arm.turn);
      }
      t.pa.lerp(t.pg, arm.weight);
      t.qa.slerp(t.qg, arm.weight);
      // 3. The Hand bone: the target stands for R.palm (hand space) — the wrist itself (schema 2).
      t.m2.makeTranslation(-R.palm.x, -R.palm.y, -R.palm.z);
      arm.want.compose(t.pa, t.qa, ONE).multiply(t.m2);
      arm.onTarget.compose(t.pg, t.qg, ONE).multiply(t.m2);
      // 4. Arm IK. Aimed, the firing shoulder goes behind the butt (shouldered weapons).
      const S = t.s.set(c.shoulder[0], c.shoulder[1], c.shoulder[2]);
      if (c.aimShoulder && input.ads > 0 && shouldered) S.lerp(t.v.copy(this.butt).add(t.sc.set(c.aimShoulder[0], c.aimShoulder[1], c.aimShoulder[2])), smoothstep(input.ads));
      const sv = arm.solver;
      sv.solve(S, arm.want, c, C.ik.softReach, instant ? 1 : ease(C.ik.poleSmoothing));
      sv.apply(arm.bones.upper, arm.bones.fore, arm.bones.hand, arm.want, arm.upperParentInv);
      // The sleeve: shoulder → elbow.
      arm.sleeve.position.copy(sv.shoulder);
      arm.sleeve.quaternion.setFromUnitVectors(Y, t.v.subVectors(sv.elbow, sv.shoulder).normalize());
      arm.sleeve.scale.set(1, sv.shoulder.distanceTo(sv.elbow), 1);
      // 5. Fingers.
      arm.fingers.update(ease(C.timing.fingers), action, R, side === 'right' ? trig : 0, side === 'right' ? press : 0);
      const st = this.stats[side];
      st.wristBendDeg = sv.stats.wristBendDeg;
      st.wristTwistDeg = sv.stats.wristTwistDeg;
      st.reachM = sv.stats.reachM;
      st.poleTurnDeg = sv.stats.poleTurnDeg;
      st.ik = arm.weight;
      st.action = action;
      st.trigger = arm.fingers.trigger;
      st.triggerBlend = side === 'right' ? trig : 0;
    }
    // 6. Matrices: the bones as solved (nothing writes them after this).
    this.group.updateMatrixWorld(true);
    for (const side of SIDES) this.measure(side);
    if (this.debug.enabled) {
      const arms = (this.debugArms ??= {
        right: { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), hint: new THREE.Vector3(), pole: new THREE.Vector3(), hand: new THREE.Matrix4() },
        left: { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), hint: new THREE.Vector3(), pole: new THREE.Vector3(), hand: new THREE.Matrix4() },
      });
      for (const side of SIDES) {
        const a = this.arms[side]!;
        const d = arms[side];
        d.shoulder.copy(a.solver.shoulder);
        d.elbow.copy(a.solver.elbow);
        d.hint.copy(a.solver.hint);
        d.pole.copy(a.solver.pole);
        d.hand.copy(a.want);
      }
      this.debug.update({ right: h.right, left: h.left }, arms);
    } else this.debug.hide();
  }

  /** The wrist as drawn against the weapon's target (holding it): the hands stay connected. */
  private measure(side: Side): void {
    const arm = this.arms[side]!;
    const st = this.stats[side];
    if (arm.weight < 0.999) {
      st.targetErrMm = st.targetErrDeg = -1;
      return;
    }
    const t = this.t;
    t.m.multiplyMatrices(t.inv, arm.bones.hand.matrixWorld).decompose(t.pa, t.qa, t.sc);
    arm.onTarget.decompose(t.pg, t.qg, t.sc);
    st.targetErrMm = t.pa.distanceTo(t.pg) * 1000;
    st.targetErrDeg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(t.qa.dot(t.qg)))));
  }
}
