import * as THREE from 'three';
import { SIDES, type Side } from './ArmRig';

/**
 * Developer helpers for the hands. Off by default and built on first use, so a normal game never
 * creates them (the calibration page and `?dev` switch them on).
 *
 *   targets     an AxesHelper on each RightHandTarget / LeftHandTarget, riding with the weapon
 *               (X red, Y green: wrist → knuckles, Z blue: out of the palm)
 *   elbows      each shoulder (white), its preferred elbow direction (orange) and the solved
 *               one at the elbow (magenta)
 *   directions  the solved hands: forward (cyan, the knuckles) and up (yellow, the back of the hand)
 *   skeleton    a SkeletonHelper over the glove's bones
 */
export interface HandDebugArm {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  hint: THREE.Vector3;
  pole: THREE.Vector3;
  /** The hand bone's frame (arm space). */
  hand: THREE.Matrix4;
}

export class HandDebug {
  enabled = false;
  targets = true;
  elbows = true;
  directions = true;
  skeleton = false;
  private built = false;
  private parts: Record<Side, { axes: THREE.AxesHelper; shoulder: THREE.Mesh; hint: THREE.ArrowHelper; pole: THREE.ArrowHelper; fwd: THREE.ArrowHelper; up: THREE.ArrowHelper }> | null = null;
  private skel: THREE.SkeletonHelper | null = null;
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();

  constructor(
    /** Arm space: where the arrows go. */
    private group: THREE.Group,
    /** The glove model (its skeleton). */
    private model: THREE.Object3D | null,
  ) {}

  private build(): void {
    this.built = true;
    const overlay = (o: THREE.Object3D) => {
      o.traverse((c) => {
        c.renderOrder = 999;
        c.frustumCulled = false;
        c.userData.gizmo = true;
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (m) {
          m.depthTest = false;
          m.transparent = true;
        }
      });
      return o;
    };
    const arrow = (color: number, len: number) => overlay(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), len, color, len * 0.22, len * 0.12)) as THREE.ArrowHelper;
    const make = () => {
      const p = {
        axes: overlay(new THREE.AxesHelper(0.05)) as THREE.AxesHelper,
        shoulder: overlay(new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))) as THREE.Mesh,
        hint: arrow(0xff9a2a, 0.12),
        pole: arrow(0xff3df0, 0.09),
        fwd: arrow(0x2ae4ff, 0.08),
        up: arrow(0xffe14a, 0.06),
      };
      this.group.add(p.shoulder, p.hint, p.pole, p.fwd, p.up);
      return p;
    };
    this.parts = { right: make(), left: make() };
    if (this.model) this.skel = overlay(new THREE.SkeletonHelper(this.model)) as THREE.SkeletonHelper;
  }

  /** Everything off (no hands drawn, or debug switched off). */
  hide(): void {
    if (!this.parts) return;
    for (const s of SIDES) {
      const p = this.parts[s];
      p.axes.removeFromParent();
      p.shoulder.visible = p.hint.visible = p.pole.visible = p.fwd.visible = p.up.visible = false;
    }
    this.skel?.removeFromParent();
  }

  /** Place the helpers for this frame: `targets` the weapon's hand target nodes, `arms` the solves. */
  update(targets: Record<Side, THREE.Object3D>, arms: Record<Side, HandDebugArm>): void {
    if (!this.enabled) return this.hide();
    if (!this.built) this.build();
    const P = this.parts!;
    for (const s of SIDES) {
      const p = P[s];
      const a = arms[s];
      // The axes ride on the target itself (a child of the weapon): exactly where it is.
      if (this.targets) {
        if (p.axes.parent !== targets[s]) targets[s].add(p.axes);
      } else p.axes.removeFromParent();
      p.shoulder.visible = p.hint.visible = p.pole.visible = this.elbows;
      if (this.elbows) {
        p.shoulder.position.copy(a.shoulder);
        p.hint.position.copy(a.shoulder);
        p.hint.setDirection(a.hint);
        p.pole.position.copy(a.elbow);
        p.pole.setDirection(a.pole);
      }
      p.fwd.visible = p.up.visible = this.directions;
      if (this.directions) {
        const w = this.v.setFromMatrixPosition(a.hand);
        p.fwd.position.copy(w);
        p.fwd.setDirection(this.d.setFromMatrixColumn(a.hand, 1).normalize());
        p.up.position.copy(w);
        p.up.setDirection(this.d.setFromMatrixColumn(a.hand, 2).normalize().negate());
      }
    }
    // The skeleton helper's matrix is its root's world matrix: it hangs off the scene itself.
    if (this.skel) {
      if (this.skeleton) {
        let root: THREE.Object3D = this.group;
        while (root.parent) root = root.parent;
        if (this.skel.parent !== root) root.add(this.skel);
      } else this.skel.removeFromParent();
    }
  }
}
