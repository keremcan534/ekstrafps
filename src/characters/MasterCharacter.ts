import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Humanoid, HumanoidVisual, Part } from '../targets/Humanoid';
import { humanoidView } from '../targets/Humanoid';
import { FINGER_KEYS, SIDES, sided, type MasterArm, type MasterRig, type Side } from './master/MasterRig';
import { ThirdPersonArmIK } from './master/ThirdPersonArmIK';
import { TwistSolver } from './master/TwistSolver';
import { INDEX_KEYS, MasterFingers, libraryPose, masterCorrection } from './master/MasterFingers';
import type { MasterAssets, MasterPerson } from './MasterAssets';
import data from './master/masterRig.json';

/**
 * One character on the master humanoid in the game: the canonical skinned body (its own copy of
 * the 69-bone skeleton), its look and gear, driven every frame FROM the Humanoid's parts, which
 * stay the one animation, hit test and ragdoll (targets/Humanoid; HumanoidSkin.visual).
 *
 *   1. Retarget. The Humanoid's rest (every part unturned) is the master standing with arms and
 *      legs hanging straight down (MasterAssets hang). Each bone's world turn is its part's world
 *      turn times that pose's (a constant per bone), so nothing is twisted:
 *        Hips ← pelvis (and its place), Spine1..3 ← torso, Neck / Head ← head,
 *        UpperArm / Forearm ← upperArm / foreArm, Thigh / Calf ← thigh / shin, Foot ← the ankle bone.
 *      The torso's and head's turns are split swing / twist: the swing at Spine1 (Neck), the twist
 *      about the spine spread over Spine1..3 (torso.spread) and Neck / Head (game.neckTwist). The
 *      spine is one straight line, so the chest and the head end exactly where the parts are: the
 *      hitboxes stay on what is drawn.
 *   2. Holding a weapon (near bodies): the right hand's RightHandWeaponSocket onto the gun's pistol
 *      grip frame, the left hand onto the support frame (MasterGrips), two-bone IK
 *      (ThirdPersonArmIK) with the stance's poles in chest space (masterRig.json stances), then the
 *      library finger poses (MasterFingers) and the twist bones (TwistSolver). The solved arms are
 *      written back onto the Humanoid's arm parts: the arm hitboxes and the ragdoll's start are the
 *      arms you see. A hand off the gun follows its arm part (reload, downed, dead, far bodies).
 *   3. Far bodies (the Humanoid's far geometry up): retarget only, no IK, fingers or twist.
 *
 * The body is drawn at the game's height: one uniform scale for every master character (the
 * hands scale about their weapon sockets, so the grip stays on the gun). No per-character
 * numbers: masterRig.json holds them all. No allocations per frame.
 */
export interface MasterHold {
  /** The pistol grip's frame (the right hand holds it), or null: the arm follows its part. */
  right: THREE.Object3D | null;
  /** Hand_L's frame on the support, or null: the arm follows its part. */
  left: THREE.Object3D | null;
  /** Which stance's poles bend the elbows (masterRig.json stances). */
  stance: keyof typeof data.stances;
  /** Library finger poses: the right hand, its index finger, the left hand. */
  rightPose: string;
  trigger: string;
  leftPose: string;
}

type Q = THREE.Quaternion;
const Y = new THREE.Vector3(0, 1, 0);
const SPREAD = data.torso.spread;
const STANCES = data.stances as Record<string, { poles: { right: number[]; left: number[] } }>;
/** An arm changing hands (IK ↔ its part: the far switch, a hand to the magazine, a death) eases over this long (s). */
const ARM_BLEND = 0.2;
/** The mid band (desktop: LOD2 body, light gear) from MID_IN m, back to near under MID_OUT m. */
const MID_IN_SQ = 8.5 * 8.5;
const MID_OUT_SQ = 7.5 * 7.5;

/**
 * The body's node: matrix passes from outside (the Humanoid's, the renderer's, the game's
 * visible-only pass, which calls a class's own updateMatrixWorld) skip it and everything under
 * it, since MasterCharacter.posed keeps its 69 bones current itself.
 */
class MasterBodyNode extends THREE.Group {
  override updateMatrixWorld(): void {}
}

/** A MasterRig over a clone of the template's bones (the template's rest data, shared). */
function cloneRig(template: MasterRig, model: THREE.Object3D): MasterRig {
  const bones = new Map<string, THREE.Bone>();
  let mesh: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  const bone = (name: string): THREE.Bone => {
    const b = bones.get(name);
    if (!b) throw new Error(`MASTER_HUMANOID_RIG: no bone ${name}`);
    return b;
  };
  const arm = (s: Side): MasterArm => ({
    ...template.arms[s],
    clavicle: bone(sided('Clavicle', s)),
    upper: bone(sided('UpperArm', s)),
    upperTwist: bone(sided('UpperArmTwist', s)),
    fore: bone(sided('Forearm', s)),
    foreTwist: bone(sided('ForearmTwist', s)),
    foreTwist2: bone(sided('ForearmTwist2', s)),
    hand: bone(sided('Hand', s)),
    fingers: FINGER_KEYS.map((k) => bone(sided(k, s))),
    socket: bone(s === 'R' ? 'RightHandWeaponSocket' : 'LeftHandWeaponSocket'),
  });
  return { model, mesh: mesh!, bones, rest: template.rest, arms: { R: arm('R'), L: arm('L') }, report: template.report, bone };
}

/** A Humanoid part's world turn (its matrices carry no scale). */
const partQ = (part: Part, out: Q): Q => out.setFromRotationMatrix(part.group.matrixWorld);

/** `q`'s twist about +Y (rad) into `twist`; `swing` = q × twist⁻¹. */
function swingTwist(q: Q, swing: Q, twist: Q): number {
  const len = Math.hypot(q.y, q.w);
  if (len < 1e-9) twist.identity();
  else twist.set(0, q.y / len, 0, q.w / len);
  swing.copy(twist).invert().premultiply(q);
  return 2 * Math.atan2(twist.y, twist.w);
}

interface Limb {
  bone: THREE.Bone;
  /** The bone's world turn when its part is unturned (the hanging pose). */
  c: Q;
  cInv: Q;
}

export class MasterCharacter implements HumanoidVisual {
  readonly mesh: THREE.SkinnedMesh;
  readonly near: THREE.BufferGeometry;
  readonly mid: THREE.BufferGeometry | null;
  readonly far: THREE.BufferGeometry | null;
  readonly model: THREE.Object3D;
  readonly rig: MasterRig;
  readonly hold: MasterHold = { right: null, left: null, stance: 'low', rightPose: '', trigger: '', leftPose: '' };
  readonly ik: Record<Side, ThirdPersonArmIK>;
  readonly twist: TwistSolver;
  readonly fingers: Record<Side, MasterFingers>;
  /** The IK targets and poles this frame (world): for the dev checks. */
  readonly targets: Record<Side, THREE.Matrix4> = { R: new THREE.Matrix4(), L: new THREE.Matrix4() };
  readonly poles: Record<Side, THREE.Vector3> = { R: new THREE.Vector3(), L: new THREE.Vector3() };
  /** Which arms the IK solved this frame (the rest followed their parts). */
  readonly solved: Record<Side, boolean> = { R: false, L: false };
  /** Whether an arm is still easing from its last pose after changing hands (drawn short of its target on purpose). */
  easing(s: Side): boolean {
    return this.armBlend[s].t < 1;
  }
  /** Back in play (a respawn): the arms take their new pose at once, nothing eases out of the corpse's. */
  reset(): void {
    this.wasHidden = true;
    for (const s of SIDES) this.armBlend[s].t = 1;
  }
  /** Ease arm `s` from the pose it is drawn in now (its target is about to jump: a hand let go of the gun). */
  ease(s: Side): void {
    const bl = this.armBlend[s];
    for (let i = 0; i < bl.bones.length; i++) bl.from[i].copy(bl.bones[i].quaternion);
    bl.t = 0;
  }
  private readonly gear: THREE.Mesh[] = [];
  /** Gear with lighter versions: swapped with the body's band (near, mid, far). */
  private readonly gearLods: { mesh: THREE.Mesh; geo: [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry] }[] = [];
  private readonly scale: number;
  private readonly rootBone: THREE.Bone;
  private readonly rootLocal = new THREE.Matrix4();
  private readonly hips: Limb;
  private readonly spine: Limb[];
  private readonly neck: Limb;
  private readonly head: Limb;
  private readonly limbs: Record<Side, { clavicle: THREE.Bone; upper: Limb; fore: Limb; thigh: Limb; calf: Limb; foot: Limb; rest: THREE.Bone[] }>;
  private readonly parts: Record<'pelvis' | 'torso' | 'head' | 'upperArmL' | 'upperArmR' | 'foreArmL' | 'foreArmR' | 'thighL' | 'thighR' | 'shinL' | 'shinR', Part>;
  /** Hand_R × RightHandWeaponSocket⁻¹ with the socket at the body's scale; the left hand's shift to scale it about its socket. */
  private readonly socketInv = new THREE.Matrix4();
  private readonly leftShift = new THREE.Matrix4();
  private readonly fingerKey: Record<Side, { pose: string; trigger: string }> = { R: { pose: '', trigger: '' }, L: { pose: '', trigger: '' } };
  private wasFar = false;
  /** Per arm: its chain's local turns when it last changed hands, and how far the ease is (1: done). */
  private readonly armBlend: Record<Side, { t: number; bones: THREE.Bone[]; from: THREE.Quaternion[] }>;
  /** Not posed last frame (just made, respawned, or out of sight): nothing to ease from. */
  private wasHidden = true;
  /** The gear's band (0 near, 1 mid, 2 far) and shadow as last set (they follow the body's: syncGear). */
  private gearBand = 0;
  private gearCast: boolean | null = null;
  /** Spine3 in the torso part's frame at rest (the torso part carries the chest rigidly). */
  private readonly chest: { p: THREE.Vector3; q: THREE.Quaternion };
  private t = {
    m: new THREE.Matrix4(),
    p: new THREE.Vector3(),
    s: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    q2: new THREE.Quaternion(),
    swing: new THREE.Quaternion(),
    twist: new THREE.Quaternion(),
    root: new THREE.Quaternion(),
    pelvis: new THREE.Quaternion(),
    torso: new THREE.Quaternion(),
    headQ: new THREE.Quaternion(),
    wHips: new THREE.Quaternion(),
    wSpine: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
    wNeck: new THREE.Quaternion(),
    wHead: new THREE.Quaternion(),
    wClav: new THREE.Quaternion(),
    wUpper: new THREE.Quaternion(),
    wFore: new THREE.Quaternion(),
    wThigh: new THREE.Quaternion(),
    wCalf: new THREE.Quaternion(),
    wFoot: new THREE.Quaternion(),
  };

  constructor(
    assets: MasterAssets,
    readonly person: MasterPerson,
    readonly body: Humanoid,
  ) {
    this.scale = assets.scale;
    this.model = new MasterBodyNode().add(cloneSkinned(assets.rig.model));
    this.model.name = `Master:${person.id}`;
    this.model.scale.setScalar(this.scale);
    this.rig = cloneRig(assets.rig, this.model);
    this.mesh = this.rig.mesh;
    this.near = assets.near;
    this.mid = assets.mid;
    this.far = assets.far;
    this.mesh.geometry = this.near;
    this.mesh.material = person.look.material;
    // Fixed generous bounds (mesh space): the ragdoll can spread a few metres from the root, and
    // a skinned mesh's own bounds would be worked out from every vertex.
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1 / this.scale, 0), 3.5 / this.scale);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // A settled corpse isn't posed, but the Humanoid still swaps its LOD and shadow by distance:
    // the mid band and the gear follow whenever the body is drawn.
    this.mesh.onBeforeRender = () => this.syncGear();
    body.root.add(this.model);

    const hang = assets.hang.q;
    const limb = (name: string): Limb => {
      const c = hang.get(name)!.clone();
      return { bone: this.rig.bone(name), c, cInv: c.clone().invert() };
    };
    this.rootBone = this.rig.bone('Root');
    // The fixed nodes between the model and its Root bone (the glTF scene's own), composed once.
    this.rootLocal.copy(this.rootBone.matrix);
    for (let o = this.rootBone.parent; o && o !== this.model; o = o.parent) this.rootLocal.premultiply(o.matrix);
    this.hips = limb('Hips');
    this.spine = ['Spine1', 'Spine2', 'Spine3'].map(limb);
    this.neck = limb('Neck');
    this.head = limb('Head');
    const side = (s: Side) => {
      const a = this.rig.arms[s];
      return {
        clavicle: a.clavicle,
        upper: limb(sided('UpperArm', s)),
        fore: limb(sided('Forearm', s)),
        thigh: limb(sided('Thigh', s)),
        calf: limb(sided('Calf', s)),
        foot: limb(sided('Foot', s)),
        rest: [a.clavicle, a.hand, a.upperTwist, a.foreTwist, a.foreTwist2],
      };
    };
    this.limbs = { R: side('R'), L: side('L') };
    const chain = (s: Side) => {
      const a = this.rig.arms[s];
      const bones = [a.clavicle, a.upper, a.upperTwist, a.fore, a.foreTwist, a.foreTwist2, a.hand];
      return { t: 1, bones, from: bones.map(() => new THREE.Quaternion()) };
    };
    this.armBlend = { R: chain('R'), L: chain('L') };
    const p = (n: Parameters<Humanoid['part']>[0]) => body.part(n);
    this.parts = {
      pelvis: p('pelvis'), torso: p('torso'), head: p('head'), upperArmL: p('upperArmL'), upperArmR: p('upperArmR'),
      foreArmL: p('foreArmL'), foreArmR: p('foreArmR'), thighL: p('thighL'), thighR: p('thighR'), shinL: p('shinL'), shinR: p('shinR'),
    };

    this.ik = {
      R: new ThirdPersonArmIK(this.rig.arms.R, this.rig.rest.get('Hand_R')!.quaternion),
      L: new ThirdPersonArmIK(this.rig.arms.L, this.rig.rest.get('Hand_L')!.quaternion),
    };
    this.twist = new TwistSolver(this.rig);
    this.fingers = { R: new MasterFingers(this.rig.arms.R), L: new MasterFingers(this.rig.arms.L) };
    const sock = this.rig.arms.R.socket;
    this.socketInv.compose(this.t.p.copy(sock.position).multiplyScalar(this.scale), sock.quaternion, this.t.s.set(1, 1, 1)).invert();
    this.leftShift.makeTranslation(this.t.p.copy(this.rig.arms.L.socket.position).multiplyScalar(1 - this.scale));

    const hp = assets.hang.p;
    this.chest = { p: hp.get('Spine3')!.clone().sub(hp.get('Spine1')!).multiplyScalar(this.scale), q: hang.get('Spine3')!.clone() };

    for (const g of person.gear) this.wear(g);
    this.setFingers('R', data.game.fingers.free, '');
    this.setFingers('L', data.game.fingers.free, '');
  }

  /**
   * A point in chest space (Spine3's frame, metres at the master's own size, as masterRig.json
   * stances give them) in the Humanoid torso part's frame: the part carries the chest rigidly.
   */
  chestPoint(local: readonly number[], out: THREE.Vector3): THREE.Vector3 {
    return out.set(local[0], local[1], local[2]).multiplyScalar(this.scale).applyQuaternion(this.chest.q).add(this.chest.p);
  }

  /** A gear mesh worn: the look's variant material if the item has one, shadows like the body's. */
  private dress(m: THREE.Mesh, g: MasterPerson['gear'][number]): void {
    if (g.material) m.material = g.material;
    m.receiveShadow = true;
    this.gear.push(m);
    if (g.lod || g.far) this.gearLods.push({ mesh: m, geo: [m.geometry, g.lod ?? m.geometry, g.far ?? g.lod ?? m.geometry] });
  }

  /** Put on a gear item: rigid under its socket, or skinned onto this body's bones by name. */
  private wear(g: MasterPerson['gear'][number]): void {
    if (g.attach === 'socket') {
      const socket = this.rig.bones.get(g.socket);
      if (!socket) {
        console.warn(`[master] gear ${g.id}: no socket ${g.socket}`);
        return;
      }
      const o = g.scene.clone(true);
      o.position.copy(g.position);
      o.quaternion.copy(g.quaternion);
      o.scale.setScalar(g.scale);
      socket.add(o);
      o.traverse((m) => (m as THREE.Mesh).isMesh && this.dress(m as THREE.Mesh, g));
      return;
    }
    const o = cloneSkinned(g.scene);
    const own: THREE.Object3D[] = [];
    o.traverse((m) => {
      if ((m as THREE.Bone).isBone) own.push(m);
      const sm = m as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      const bones = sm.skeleton.bones.map((b) => this.rig.bones.get(b.name));
      const lost = sm.skeleton.bones.filter((_, i) => !bones[i]).map((b) => b.name);
      if (lost.length) {
        console.warn(`[master] gear ${g.id}: bones not on the body (${lost.join(', ')})`);
        sm.visible = false;
        return;
      }
      sm.bind(new THREE.Skeleton(bones as THREE.Bone[], sm.skeleton.boneInverses), sm.bindMatrix);
      sm.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1 / this.scale, 0), 3.5 / this.scale);
      this.dress(sm, g);
    });
    // The gear's own copy of the skeleton drives nothing now.
    for (const b of own) if (b.parent && !(b.parent as THREE.Bone).isBone) b.removeFromParent();
    this.model.add(o);
  }

  /** Finger poses for a side (only when they change: they hold until told otherwise). */
  private setFingers(s: Side, pose: string, trigger: string): void {
    const k = this.fingerKey[s];
    if (k.pose === pose && k.trigger === trigger) return;
    k.pose = pose;
    k.trigger = trigger;
    this.fingers[s].apply(libraryPose(pose), trigger ? libraryPose(trigger) : undefined, INDEX_KEYS, masterCorrection(pose));
  }

  posed(dt: number, far: boolean): void {
    const b = this.body;
    const alive = b.alive;
    // Not drawn (a room out of sight): nothing to pose. The game sets visibility before the
    // update, so a body coming into view is posed before it is drawn. (A ragdoll is posed
    // anyway: once it settles nothing would pose it again.)
    if (alive && !b.root.visible) {
      this.wasHidden = true;
      return;
    }
    const t = this.t;
    const P = this.parts;
    // An arm about to change hands eases from the pose it was last drawn in.
    const hd = this.hold;
    const hands = alive && !far;
    for (const s of SIDES) {
      const bl = this.armBlend[s];
      const solve = hands && !!(s === 'R' ? hd.right : hd.left);
      if (solve !== this.solved[s] && !this.wasHidden) {
        for (let i = 0; i < bl.bones.length; i++) bl.from[i].copy(bl.bones[i].quaternion);
        bl.t = 0;
      }
    }
    this.wasHidden = false;
    // The parts' world transforms: the pose just set their local turns (the ragdoll sets the
    // world matrices directly). The body's own node after them (its bones come below).
    if (alive) b.root.updateMatrixWorld(true);
    this.model.updateWorldMatrix(true, false);
    partQ(P.pelvis, t.pelvis);
    partQ(P.torso, t.torso);
    partQ(P.head, t.headQ);

    // Root: the model's frame (scaled: decomposed) and the fixed nodes down to the Root bone.
    t.m.multiplyMatrices(this.model.matrixWorld, this.rootLocal);
    t.m.decompose(t.p, t.root, t.s);
    // Hips: the pelvis's place and turn.
    t.m.invert();
    this.hips.bone.position.setFromMatrixPosition(P.pelvis.group.matrixWorld).applyMatrix4(t.m);
    t.wHips.copy(t.pelvis).multiply(this.hips.c);
    this.hips.bone.quaternion.copy(t.root).invert().multiply(t.wHips);

    // Spine: the torso's turn on the pelvis, swing at Spine1, twist spread up the spine.
    t.q.copy(t.pelvis).invert().multiply(t.torso);
    let tw = swingTwist(t.q, t.swing, t.twist);
    let acc = 0;
    let parent = t.wHips;
    for (let i = 0; i < 3; i++) {
      acc += SPREAD[i];
      const w = t.wSpine[i].copy(t.pelvis).multiply(t.swing).multiply(t.q2.setFromAxisAngle(Y, tw * (i === 2 ? 1 : acc))).multiply(this.spine[i].c);
      this.spine[i].bone.quaternion.copy(parent).invert().multiply(w);
      parent = w;
    }
    // Neck and head: the head's turn on the torso, swing at the neck, twist split.
    t.q.copy(t.torso).invert().multiply(t.headQ);
    tw = swingTwist(t.q, t.swing, t.twist);
    t.wNeck.copy(t.torso).multiply(t.swing).multiply(t.q2.setFromAxisAngle(Y, tw * data.game.neckTwist)).multiply(this.neck.c);
    this.neck.bone.quaternion.copy(t.wSpine[2]).invert().multiply(t.wNeck);
    t.wHead.copy(t.headQ).multiply(this.head.c);
    this.head.bone.quaternion.copy(t.wNeck).invert().multiply(t.wHead);

    // Limbs from their parts; clavicles, hands and twist bones back to rest (the hold turns them).
    const rest = this.rig.rest;
    for (const s of SIDES) {
      const L = this.limbs[s];
      for (const r of L.rest) r.quaternion.copy(rest.get(r.name)!.quaternion);
      t.wClav.copy(t.wSpine[2]).multiply(L.clavicle.quaternion);
      partQ(s === 'R' ? P.upperArmR : P.upperArmL, t.q).multiply(L.upper.c);
      L.upper.bone.quaternion.copy(t.wClav).invert().multiply(t.q);
      t.wUpper.copy(t.q);
      partQ(s === 'R' ? P.foreArmR : P.foreArmL, t.q).multiply(L.fore.c);
      L.fore.bone.quaternion.copy(t.wUpper).invert().multiply(t.q);
      partQ(s === 'R' ? P.thighR : P.thighL, t.wThigh).multiply(L.thigh.c);
      L.thigh.bone.quaternion.copy(t.wHips).invert().multiply(t.wThigh);
      partQ(s === 'R' ? P.shinR : P.shinL, t.wCalf).multiply(L.calf.c);
      L.calf.bone.quaternion.copy(t.wThigh).invert().multiply(t.wCalf);
      t.wFoot.setFromRotationMatrix(b.footBones[s === 'R' ? 1 : 0].matrixWorld).multiply(L.foot.c);
      L.foot.bone.quaternion.copy(t.wCalf).invert().multiply(t.wFoot);
    }
    // Every bone (and the gear) under the body's node, once: the passes outside skip it.
    for (const c of this.model.children) c.updateMatrixWorld(true);

    // The hold: near and alive only.
    this.solved.R = hands && !!hd.right;
    this.solved.L = hands && !!hd.left;
    if (this.solved.R || this.solved.L) {
      const chest = this.spine[2].bone.matrixWorld;
      const st = STANCES[hd.stance] ?? STANCES.low;
      if (this.solved.R) {
        this.targets.R.multiplyMatrices(hd.right!.matrixWorld, this.socketInv);
        this.poles.R.fromArray(st.poles.right).applyMatrix4(chest);
        this.ik.R.solve(this.targets.R, this.poles.R);
      }
      if (this.solved.L) {
        this.targets.L.multiplyMatrices(hd.left!.matrixWorld, this.leftShift);
        this.poles.L.fromArray(st.poles.left).applyMatrix4(chest);
        this.ik.L.solve(this.targets.L, this.poles.L);
      }
    }
    if (alive) {
      // Only when they change (far bodies too: a fist on the gun reads at any distance, and costs nothing per frame).
      this.setFingers('R', hd.right ? hd.rightPose : data.game.fingers.free, hd.right ? hd.trigger : '');
      this.setFingers('L', hd.leftPose || data.game.fingers.free, '');
    } else {
      this.setFingers('R', data.game.fingers.free, '');
      this.setFingers('L', data.game.fingers.free, '');
    }
    if (!far || !this.wasFar) {
      this.twist.update();
      for (const s of SIDES) this.rig.arms[s].upper.updateMatrixWorld(true);
    }
    this.wasFar = far;
    this.syncGear();
    for (const s of SIDES) {
      const bl = this.armBlend[s];
      if (bl.t >= 1) continue;
      bl.t = Math.min(1, bl.t + dt / ARM_BLEND);
      const k = bl.t * bl.t * (3 - 2 * bl.t);
      for (let i = 0; i < bl.bones.length; i++) {
        const q = bl.bones[i].quaternion;
        t.q.copy(q);
        q.copy(bl.from[i]).slerp(t.q, k);
      }
      bl.bones[0].updateMatrixWorld(true);
    }

    // The arm parts take the solved arms: the hitboxes (and a ragdoll starting now) are the arms drawn.
    for (const s of SIDES) {
      if (!this.solved[s]) continue;
      const L = this.limbs[s];
      const upper = s === 'R' ? P.upperArmR : P.upperArmL;
      const fore = s === 'R' ? P.foreArmR : P.foreArmL;
      L.upper.bone.matrixWorld.decompose(t.p, t.wUpper, t.s);
      t.wUpper.multiply(L.upper.cInv);
      upper.group.quaternion.copy(t.torso).invert().multiply(t.wUpper);
      L.fore.bone.matrixWorld.decompose(t.p, t.wFore, t.s);
      t.wFore.multiply(L.fore.cInv);
      fore.group.quaternion.copy(t.wUpper).invert().multiply(t.wFore);
    }
  }

  /**
   * The body's band and the gear's with it: far when the Humanoid has put the far body up, else
   * (desktop) mid by distance from the viewer; the gear's shadow as the body's.
   */
  private syncGear(): void {
    let band = this.far !== null && this.mesh.geometry === this.far ? 2 : 0;
    if (band === 0 && this.mid) {
      const d2 = this.body.root.position.distanceToSquared(humanoidView);
      band = d2 > (this.mesh.geometry === this.mid ? MID_OUT_SQ : MID_IN_SQ) ? 1 : 0;
      const geo = band ? this.mid : this.near;
      if (this.mesh.geometry !== geo) this.mesh.geometry = geo;
    }
    if (band !== this.gearBand) {
      this.gearBand = band;
      for (const l of this.gearLods) l.mesh.geometry = l.geo[band];
    }
    const cast = this.mesh.castShadow;
    if (cast !== this.gearCast) {
      this.gearCast = cast;
      for (const g of this.gear) g.castShadow = cast;
    }
  }
}
