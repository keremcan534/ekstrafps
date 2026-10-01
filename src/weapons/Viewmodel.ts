import * as THREE from 'three';
import { Spring, Spring3 } from '../core/Spring';
import { DEG, clamp, damp, randSign, smoothstep } from '../core/math';
import { feel } from '../config/Feel';
import { MuzzleFlash } from '../fx/MuzzleFlash';
import { buildWeaponModel, type WeaponRig } from './WeaponModels';
import { WeaponAnimator, type PoseOffset } from './WeaponAnimator';
import type { Weapon } from './Weapon';
import type { WeaponData } from './WeaponData';
import type { PlayerController } from '../player/PlayerController';

/** Whole-weapon sprint poses (rotation rad, position m). */
const SPRINT_POSE = {
  rifle: { rot: [-0.32, 0.6, 0.4], pos: [-0.04, -0.05, 0.05] },
  pistol: { rot: [0.45, 0.25, 0.2], pos: [-0.03, -0.035, 0.07] },
  shotgun: { rot: [-0.3, 0.55, 0.42], pos: [-0.04, -0.05, 0.05] },
} as const;

export interface ViewmodelInput {
  player: PlayerController;
  /** Look rotation applied this frame (radians); drives weapon inertia. */
  lookYaw: number;
  lookPitch: number;
  adsAmount: number;
  /** Where the weapon should point, in camera space (camera aim ray at convergence distance). */
  aimPoint: THREE.Vector3;
  /** Main camera: the viewmodel renders with the same FOV so its space IS camera space. */
  mainCamera: THREE.PerspectiveCamera;
}

/**
 * The physical weapon, expressed in camera space. Rendered in its own pass with
 * the SAME FOV as the main camera, so camera space maps 1:1 to the world: the
 * muzzle you see is the muzzle bullets leave from.
 *
 * Camera and weapon are separate bodies:
 *   - the camera turns instantly with the mouse
 *   - the weapon is aimed at the camera's aim point (point-fire convergence /
 *     ADS zero) and trails camera rotation through an inertia spring
 * Final pose = alignment + inertia + bob + sprint + equip + reload + recoil + jolts.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly flash = new MuzzleFlash();

  private pivot = new THREE.Group();
  private rigs = new Map<string, WeaponRig>();
  private rig: WeaponRig | null = null;
  private weapon: Weapon | null = null;
  private animator = new WeaponAnimator();
  private pose: PoseOffset = { pos: new THREE.Vector3(), rot: new THREE.Vector3() };

  // Springs
  private recoilPos = new Spring3(300, 24);
  private recoilRot = new Spring3(260, 20);
  /** Weapon inertia: angular offset (x = pitch, y = yaw) from the aim solution. */
  private inertia = new Spring3(100, 12);
  private landSpring = new Spring(160, 13);
  private joltRot = new Spring3(220, 16);

  private sprintBlend = 0;
  private airOffset = 0;
  private time = 0;
  private adsPos = new THREE.Vector3();
  private hipPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  /** Smoothed camera turn rate (rad/s): x = pitch, y = yaw. */
  private lookRate = new THREE.Vector2();
  /** Debug: current inertia offset in degrees (pitch, yaw). */
  readonly inertiaDeg = new THREE.Vector2();

  constructor(aspect: number, weapons: WeaponData[]) {
    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.01, 10);
    this.scene.add(this.pivot);
    for (const w of weapons) {
      const rig = buildWeaponModel(w.model);
      rig.root.visible = false;
      this.pivot.add(rig.root);
      this.rigs.set(w.id, rig);
    }
    // Lighting tuned to roughly match the arena.
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3530, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.set(-0.8, 0.3, -0.6);
    this.scene.add(rim);
  }

  setWeapon(weapon: Weapon): void {
    if (this.rig) this.rig.root.visible = false;
    this.weapon = weapon;
    this.rig = this.rigs.get(weapon.data.id)!;
    this.rig.root.visible = true;
    this.animator.setRig(this.rig);
    this.flash.attachTo(this.rig.muzzle);
    this.recoilPos.reset();
    this.recoilRot.reset();
    this.joltRot.reset();
    this.refreshWeaponTuning();
  }

  /** Re-read spring constants & sight placement (call after tuning edits). */
  refreshWeaponTuning(): void {
    const d = this.weapon?.data;
    if (!d || !this.rig) return;
    this.hipPos.set(...d.viewmodel.hipPosition);
    const s = this.rig.sight.position;
    this.adsPos.set(-s.x, -s.y, -d.ads.sightDistance - s.z);
  }

  onShot(data: WeaponData, adsAmount: number): void {
    const v = data.visualRecoil;
    this.recoilRot.stiffness = v.rotStiffness;
    this.recoilRot.damping = v.rotDamping;
    this.recoilPos.stiffness = v.posStiffness;
    this.recoilPos.damping = v.posDamping;
    const scale = feel.visualRecoilScale * (1 + (v.adsMultiplier - 1) * adsAmount);
    const wr = Math.sqrt(v.rotStiffness) * 1.9 * DEG * scale;
    const wp = Math.sqrt(v.posStiffness) * 1.9 * scale;
    this.recoilRot.impulse(v.kickUp * wr * (0.85 + Math.random() * 0.3), v.kickSide * wr * (Math.random() * 2 - 1), v.kickRoll * wr * randSign());
    this.recoilPos.impulse((Math.random() * 2 - 1) * v.kickBack * 0.15 * wp, v.kickRaise * wp, v.kickBack * wp);
    if (feel.muzzleFlash) this.flash.trigger(data.fx.muzzleFlashScale * (1 - 0.25 * adsAmount));
  }

  /** Small physical jolts on mechanical events (mag seated, bolt release, pump...). */
  onMechanical(kind: 'magIn' | 'boltForward' | 'shellInsert' | 'pump' | 'magOut' | 'equip'): void {
    const j = this.joltRot;
    switch (kind) {
      case 'magIn':
        j.impulse(0.35, 0, 0.2);
        this.recoilPos.impulse(0, 0.25, 0.1);
        break;
      case 'boltForward':
        j.impulse(-0.25, 0.08, -0.3);
        this.recoilPos.impulse(0, 0, -0.25);
        break;
      case 'shellInsert':
        j.impulse(0.18, 0, 0.08);
        break;
      case 'pump':
        j.impulse(-0.12, 0.05, 0.2);
        break;
      case 'magOut':
        j.impulse(-0.1, 0, -0.1);
        break;
      case 'equip':
        j.impulse(0.3, 0, -0.2);
        break;
    }
  }

  onLand(fallSpeed: number): void {
    this.landSpring.impulse(-clamp(fallSpeed * 0.05, 0, 0.7));
  }

  onJump(): void {
    this.landSpring.impulse(-0.25);
  }

  update(dt: number, input: ViewmodelInput): void {
    const weapon = this.weapon;
    const rig = this.rig;
    if (!weapon || !rig) return;
    const d = weapon.data;
    const p = input.player;
    const ads = input.adsAmount;
    this.time += dt;

    // --- ADS position (eased, with a slight dip mid-transition) ---
    const adsEase = smoothstep(ads);
    const pos = this.tmp.lerpVectors(this.hipPos, this.adsPos, adsEase);
    pos.y -= Math.sin(adsEase * Math.PI) * 0.012;

    // --- Aim alignment: point the bore at the camera's aim point ---
    // (hip: point-fire convergence, ADS: zero distance). Computed from where the
    // muzzle would be with no rotation, so the bore line passes through the point.
    const muzzleRest = this.v.copy(pos).add(rig.muzzle.position);
    const toAim = this.v2.copy(input.aimPoint).sub(muzzleRest);
    const alignYaw = Math.atan2(-toAim.x, -toAim.z);
    const alignPitch = Math.atan2(toAim.y, Math.hypot(toAim.x, toAim.z));

    // --- Inertia: the weapon trails the camera by (turn rate x inertia time), then
    // the follow spring settles it with a slight overshoot when the turn stops.
    // Lag size (inertia time) and settle feel (spring) are tuned independently,
    // so a gun can feel heavy without the controls feeling laggy.
    const invDt = 1 / Math.max(dt, 1 / 240);
    const rate = this.lookRate;
    const rk = damp(25, dt); // light low-pass: mouse/touch deltas are noisy
    rate.x += (input.lookPitch * invDt - rate.x) * rk;
    rate.y += (input.lookYaw * invDt - rate.y) * rk;
    const inertiaTime = 0.018 * d.sway.amount * (1 + (d.ads.swayMultiplier - 1) * ads);
    const maxLag = d.sway.max * DEG;
    const lag = this.inertia;
    lag.stiffness = d.sway.stiffness;
    lag.damping = d.sway.damping;
    const lateral = (p.velocity.x * Math.cos(p.yaw) - p.velocity.z * Math.sin(p.yaw)) / 6;
    lag.target.set(
      clamp(-rate.x * inertiaTime, -maxLag, maxLag),
      clamp(-rate.y * inertiaTime, -maxLag, maxLag),
      -lateral * 2.5 * DEG * (1 - ads * 0.8),
    );
    const swayR = lag.update(dt);
    this.inertiaDeg.set(swayR.x / DEG, swayR.y / DEG);
    // Swinging a weapon also cants it and shifts it a few millimetres.
    const swayP = this.v.set(swayR.y * 0.06 - lateral * 0.006 * (1 - ads), swayR.x * 0.05, 0);
    const swayRoll = swayR.y * 0.6 + swayR.z;

    // --- Bob ---
    const sprinting = p.sprinting && weapon.state !== 'reloading';
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * damp(10, dt);
    const speed = clamp(p.speedRatio, 0, 1.6) * (p.grounded ? 1 : 0);
    const bobAmt = (d.bob.amount + (d.bob.sprintAmount - d.bob.amount) * this.sprintBlend) * speed * (1 + (d.ads.bobMultiplier - 1) * ads);
    const ph = p.bobPhase;
    const bobX = Math.sin(ph) * 0.007 * bobAmt;
    const bobY = -Math.abs(Math.cos(ph)) * 0.008 * bobAmt + 0.004 * bobAmt;
    const bobRoll = Math.sin(ph) * 1.3 * DEG * bobAmt;
    const bobYaw = Math.sin(ph) * 0.7 * DEG * bobAmt;
    // Idle breathing
    const breathe = 1 - ads * 0.75;
    const idleY = Math.sin(this.time * 1.7) * 0.0012 * breathe;
    const idlePitch = Math.sin(this.time * 1.25) * 0.25 * DEG * breathe;

    // --- Air / landing ---
    const targetAir = p.grounded ? 0 : clamp(-p.velocity.y * 0.0025, -0.02, 0.03);
    this.airOffset += (targetAir - this.airOffset) * damp(10, dt);
    const land = this.landSpring.update(dt);

    // --- Equip / holster ---
    let equipDown = 0;
    if (weapon.state === 'equipping') equipDown = 1 - (1 - Math.pow(1 - weapon.stateProgress, 3));
    else if (weapon.state === 'holstering') equipDown = weapon.stateProgress * weapon.stateProgress;
    else if (weapon.state === 'holstered') equipDown = 1;

    // --- Procedural reload / cycling ---
    this.animator.update(weapon, this.pose);

    // --- Recoil springs ---
    const rp = this.recoilPos.update(dt);
    const rr = this.recoilRot.update(dt);
    const jr = this.joltRot.update(dt);

    // --- Sprint pose ---
    const sp = SPRINT_POSE[d.model];
    const sb = this.sprintBlend * (1 - ads);

    pos.x += swayP.x + bobX + sp.pos[0] * sb + this.pose.pos.x + rp.x;
    pos.y += swayP.y + bobY + idleY + sp.pos[1] * sb + this.pose.pos.y + rp.y + this.airOffset + land - 0.28 * equipDown;
    pos.z += sp.pos[2] * sb + this.pose.pos.z + rp.z + 0.04 * equipDown;
    this.pivot.position.copy(pos);

    this.euler.set(
      alignPitch + swayR.x + idlePitch + sp.rot[0] * sb + this.pose.rot.x + rr.x + jr.x - 0.9 * equipDown,
      alignYaw + swayR.y + bobYaw + sp.rot[1] * sb + this.pose.rot.y + rr.y + jr.y + 0.15 * equipDown,
      swayRoll + bobRoll + sp.rot[2] * sb + this.pose.rot.z + rr.z + jr.z + 0.35 * equipDown,
    );
    this.pivot.quaternion.setFromEuler(this.euler);

    // Same projection as the world camera: viewmodel space == camera space.
    const mc = input.mainCamera;
    if (this.camera.fov !== mc.fov || this.camera.aspect !== mc.aspect) {
      this.camera.fov = mc.fov;
      this.camera.aspect = mc.aspect;
      this.camera.updateProjectionMatrix();
    }
    this.flash.update(dt);
    this.pivot.updateMatrixWorld(true);
  }

  /** World position of a point on the weapon (muzzle, eject port, laser). */
  toWorld(local: THREE.Object3D, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    local.getWorldPosition(out);
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  /** World-space forward (bore direction, -Z of the weapon) of a weapon part. */
  forwardWorld(local: THREE.Object3D, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    local.getWorldQuaternion(this.q);
    return out.set(0, 0, -1).applyQuaternion(this.q).transformDirection(mainCamera.matrixWorld);
  }

  get activeRig(): WeaponRig | null {
    return this.rig;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
