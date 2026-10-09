import * as THREE from 'three';
import { SIDES, type MasterRig, type Side } from './MasterRig';
import { ThirdPersonArmIK } from './ThirdPersonArmIK';
import { TwistSolver } from './TwistSolver';
import { MasterFingers, libraryPose, masterCorrection } from './MasterFingers';
import data from './masterRig.json';

/**
 * A master humanoid holding a two-handed rifle. The right hand OWNS the weapon:
 *
 *   0. The stance's torso blade (an aim offset over Spine1..3, the head turned back and tilted
 *      onto the stock), the same for every clip.
 *   1. The stance (masterRig.json `stances`) says where the weapon belongs, in chest space: its
 *      butt point at `butt` in Spine3's frame, turned by `rotation` in the anchor's frame
 *      ('chest': Spine3's, the weapon rides the torso; 'aim': the character's facing tilted by
 *      the aim pitch, the barrel along the aim line however the torso moves).
 *   2. Right arm: two-bone IK puts Hand_R where Hand_R × RightHandWeaponSocket lands on the
 *      weapon's pistol-grip frame (weapon data `rightGrip`), elbow toward the stance's right pole.
 *   3. The weapon is a child of RightHandWeaponSocket (local transform: the grip frame's inverse),
 *      so it is wherever the hand is: out of reach the arm clamps and the weapon stays in the hand.
 *   4. Left arm: two-bone IK to LeftHandGripTarget, a node on the weapon (weapon data `leftGrip`:
 *      Hand_L's frame on the handguard), elbow toward the stance's left pole.
 *   5. Fingers: the weapon's library grip poses (trigger finger: its trigger pose), plus the
 *      master's canonical corrections (masterRig.json `gripCorrections`).
 *   6. TwistSolver: ForearmTwist / UpperArmTwist from the solved arms.
 *
 * Every offset is canonical data (sockets, grip frames, poles in chest space); nothing here is
 * per character. Each frame: restore() → the animation poses the body → update().
 */
export type StanceName = keyof typeof data.stances;
export type WeaponHoldDef = (typeof data.weapons)[keyof typeof data.weapons];
interface StanceDef {
  anchor: string;
  butt: number[];
  rotation: number[];
  poles: { right: number[]; left: number[] };
  torso?: { yaw: number; headTilt?: number[] };
}
const SPINE = ['Spine1', 'Spine2', 'Spine3'] as const;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** The weapon model's axes (muzzle +X, up +Y, its right +Z) in a character's (faces +Z, right −X). */
const MODEL_TO_CHARACTER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const D2R = THREE.MathUtils.DEG2RAD;

export class RifleHold {
  /** The weapon's model frame in metres (rigid): child of RightHandWeaponSocket. */
  readonly weapon = new THREE.Group();
  /** The gun's own model (its units) goes in here: scaled to metres. */
  readonly model = new THREE.Group();
  /** The pistol grip's frame on the weapon (lands on the socket). */
  readonly rightGrip = new THREE.Object3D();
  /** LeftHandGripTarget: Hand_L's frame on the handguard. */
  readonly leftGrip = new THREE.Object3D();
  readonly ik: Record<Side, ThirdPersonArmIK>;
  readonly twist: TwistSolver;
  readonly fingers: Record<Side, MasterFingers>;
  /** Where the stance wanted the weapon this frame (world, the metric model frame). */
  readonly desired = new THREE.Matrix4();
  /** The stance's pole points this frame (world). */
  readonly poles: Record<Side, THREE.Vector3> = { R: new THREE.Vector3(), L: new THREE.Vector3() };
  /** Hand_R's IK target and Hand_L's (world). */
  readonly targets: Record<Side, THREE.Matrix4> = { R: new THREE.Matrix4(), L: new THREE.Matrix4() };
  stance: StanceName = 'low';
  /** Aim pitch (deg, + up) for the 'aim' anchor. */
  aimPitch = 0;
  /** Every bone update() turns, and its local rotation as the animation left it (restore()). */
  private touched: THREE.Bone[];
  private saved: THREE.Quaternion[];
  private gripInv = new THREE.Matrix4();
  private socketInv = new THREE.Matrix4();
  private t = {
    m: new THREE.Matrix4(),
    p: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    q2: new THREE.Quaternion(),
    q3: new THREE.Quaternion(),
    s: new THREE.Vector3(),
    e: new THREE.Euler(0, 0, 0, 'YXZ'),
    butt: new THREE.Vector3(),
  };

  constructor(
    readonly rig: MasterRig,
    gun: THREE.Object3D,
    readonly def: WeaponHoldDef,
  ) {
    this.model.scale.setScalar(def.scale);
    this.model.add(gun);
    this.weapon.add(this.model, this.rightGrip, this.leftGrip);
    this.weapon.name = 'Weapon';
    this.leftGrip.name = 'LeftHandGripTarget';
    this.rightGrip.name = 'RightHandGrip';
    rig.arms.R.socket.add(this.weapon);
    this.refresh();
    this.ik = {
      R: new ThirdPersonArmIK(rig.arms.R, rig.rest.get('Hand_R')!.quaternion),
      L: new ThirdPersonArmIK(rig.arms.L, rig.rest.get('Hand_L')!.quaternion),
    };
    this.twist = new TwistSolver(rig);
    this.fingers = { R: new MasterFingers(rig.arms.R), L: new MasterFingers(rig.arms.L) };
    this.touched = [
      ...[...SPINE, 'Neck', 'Head'].map((n) => rig.bone(n)),
      ...SIDES.flatMap((s) => {
        const a = rig.arms[s];
        return [a.clavicle, a.upper, a.upperTwist, a.fore, a.foreTwist, a.hand, ...a.fingers];
      }),
    ];
    this.saved = this.touched.map((b) => b.quaternion.clone());
    rig.model.updateMatrixWorld(true);
  }

  /**
   * Put back the local rotations the animation gave the bones before the last update(). Call it
   * before the animation poses the next frame: THREE.AnimationMixer writes a bone only when its
   * sampled value changed since it last wrote it, so a held or constant key would otherwise leave
   * last frame's IK in place (and the next solve would build on it).
   */
  restore(): void {
    for (let i = 0; i < this.touched.length; i++) this.touched[i].quaternion.copy(this.saved[i]);
  }

  /**
   * Re-read the weapon's grip frames (def.rightGrip / def.leftGrip) and the socket bone's
   * transform: the weapon hangs on the socket by the inverse of its grip frame.
   */
  refresh(): void {
    const def = this.def;
    const frame = (o: THREE.Object3D, f: { position: number[]; quaternion: number[] }) => {
      o.position.fromArray(f.position).multiplyScalar(def.scale);
      o.quaternion.fromArray(f.quaternion).normalize();
      o.updateMatrix();
    };
    frame(this.rightGrip, def.rightGrip);
    frame(this.leftGrip, def.leftGrip);
    this.gripInv.copy(this.rightGrip.matrix).invert();
    this.gripInv.decompose(this.weapon.position, this.weapon.quaternion, this.t.s);
    const sock = this.rig.arms.R.socket;
    this.socketInv.compose(sock.position, sock.quaternion, this.t.s.set(1, 1, 1)).invert();
    this.rig.model.updateMatrixWorld(true);
  }

  /** The stance's weapon frame (world, metric model frame) into `out`. */
  placement(out: THREE.Matrix4): THREE.Matrix4 {
    const t = this.t;
    const st = data.stances[this.stance] as StanceDef;
    const chest = this.rig.bone('Spine3');
    chest.updateWorldMatrix(true, false);
    // Butt point: Spine3 space → world.
    const butt = t.butt.fromArray(st.butt).applyMatrix4(chest.matrixWorld);
    // Orientation: the anchor's, then the stance's turn, then the model's axes.
    if (st.anchor === 'aim') {
      this.rig.bone('Root').matrixWorld.decompose(t.p, t.q, t.s);
      t.q.multiply(t.q2.setFromAxisAngle(t.p.set(1, 0, 0), -this.aimPitch * D2R));
    } else chest.matrixWorld.decompose(t.p, t.q, t.s);
    const [yaw, pitch, roll] = st.rotation;
    t.q.multiply(t.q2.setFromEuler(t.e.set(-pitch * D2R, yaw * D2R, roll * D2R, 'YXZ'))).multiply(MODEL_TO_CHARACTER);
    // The model's butt point (metres) goes on `butt`.
    t.p.fromArray(this.def.butt).multiplyScalar(this.def.scale).applyQuaternion(t.q);
    return out.compose(butt.sub(t.p), t.q, t.s.set(1, 1, 1));
  }

  /**
   * The stance's torso blade (masterRig.json `stances.<s>.torso.yaw`, deg, − = chest to the
   * right): the chest's facing relative to the character's, whatever the clip's spine does (an
   * aim offset: the legs walk, the upper body holds the rifle's stance). The difference from the
   * clip's chest yaw is spread over Spine1..3 (`torso.spread`) as turns about world up; the neck and
   * head turn back by `torso.head` of it so the face stays where the clip had it, then tilt by the
   * stance's `torso.headTilt` (a cheek on the stock).
   */
  private turnTorso(st: StanceDef): void {
    if (!st.torso) return;
    const t = this.t;
    const rig = this.rig;
    rig.model.updateMatrixWorld(true);
    // The clip's chest yaw in the character's frame.
    const root = rig.bone('Root').matrixWorld;
    const chest = rig.bone('Spine3').matrixWorld;
    t.p.setFromMatrixColumn(chest, 2).transformDirection(t.m.copy(root).invert());
    const delta = st.torso.yaw * D2R - Math.atan2(t.p.x, t.p.z);
    const turn = (name: string, a: number) => {
      const b = rig.bone(name);
      // A turn `a` about world up, around the bone's head: local = parent⁻¹ · R · parent · local.
      b.parent!.matrixWorld.decompose(t.butt, t.q, t.s);
      t.q2.copy(t.q).invert().multiply(t.q3.setFromAxisAngle(Y_AXIS, a)).multiply(t.q);
      b.quaternion.premultiply(t.q2);
      b.updateMatrixWorld(true);
    };
    SPINE.forEach((n, i) => turn(n, delta * data.torso.spread[i]));
    turn('Neck', -delta * data.torso.head * 0.5);
    turn('Head', -delta * data.torso.head * 0.5);
    // The head onto the stock (`torso.headTilt`: [pitch + = chin down, roll + = toward the right
    // shoulder] deg), split over Neck and Head about their own axes.
    const h = st.torso.headTilt;
    if (h) {
      t.e.set(h[0] * 0.5 * D2R, 0, h[1] * 0.5 * D2R, 'YXZ');
      t.q2.setFromEuler(t.e);
      rig.bone('Neck').quaternion.multiply(t.q2);
      rig.bone('Head').quaternion.multiply(t.q2);
    }
  }

  /** Solve the hold for this frame (the body already posed by the animation). */
  update(): void {
    const st = data.stances[this.stance] as StanceDef;
    const rig = this.rig;
    for (let i = 0; i < this.touched.length; i++) this.saved[i].copy(this.touched[i].quaternion);
    this.turnTorso(st);
    rig.model.updateMatrixWorld(true);
    const chest = rig.bone('Spine3').matrixWorld;
    this.poles.R.fromArray(st.poles.right).applyMatrix4(chest);
    this.poles.L.fromArray(st.poles.left).applyMatrix4(chest);

    // Right hand: on the grip frame of the weapon where the stance wants it.
    this.placement(this.desired);
    this.rightGrip.updateMatrix();
    this.targets.R.multiplyMatrices(this.desired, this.rightGrip.matrix).multiply(this.socketInv);
    this.ik.R.solve(this.targets.R, this.poles.R);

    // Left hand: on the weapon as the right hand holds it.
    this.leftGrip.updateWorldMatrix(true, false);
    this.targets.L.copy(this.leftGrip.matrixWorld);
    this.ik.L.solve(this.targets.L, this.poles.L);

    // Fingers, then the twist bones.
    const f = this.def.fingers;
    const trigger = libraryPose(f.trigger);
    this.fingers.R.apply(libraryPose(f.right), trigger, undefined, masterCorrection(f.right));
    this.fingers.L.apply(libraryPose(f.left), undefined, undefined, masterCorrection(f.left));
    this.twist.update();
    for (const s of SIDES) rig.arms[s].upper.updateMatrixWorld(true);
  }
}
