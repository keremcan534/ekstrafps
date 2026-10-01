import * as THREE from 'three';
import { Spring, Spring3 } from '../core/Spring';
import { Noise1D } from '../core/Noise';
import { DEG, clamp, damp, randSign, smoothstep } from '../core/math';
import { feel } from '../config/Feel';
import { MuzzleFlash } from '../fx/MuzzleFlash';
import { buildWeaponModel, type WeaponRig } from './WeaponModels';
import { WeaponAnimator, type PoseOffset } from './WeaponAnimator';
import type { Weapon } from './Weapon';
import type { WeaponData } from './WeaponData';
import type { AmmoData } from './AmmoData';
import type { Handling } from './Handling';
import type { PlayerController } from '../player/PlayerController';

/** Whole-weapon sprint poses (rotation rad, position m), right shoulder. */
const SPRINT_POSE = {
  rifle: { rot: [-0.32, 0.6, 0.4], pos: [-0.04, -0.05, 0.05] },
  pistol: { rot: [0.45, 0.25, 0.2], pos: [-0.03, -0.035, 0.07] },
  shotgun: { rot: [-0.3, 0.55, 0.42], pos: [-0.04, -0.05, 0.05] },
  bolt: { rot: [-0.3, 0.55, 0.42], pos: [-0.04, -0.05, 0.05] },
} as const;

export interface ViewmodelInput {
  player: PlayerController;
  /** Look rotation applied this frame (radians); drives weapon inertia. */
  lookYaw: number;
  lookPitch: number;
  /** 1 while the player wants to aim and is allowed to. */
  adsTarget: number;
  /** Where the weapon should point, in camera space (camera aim ray at convergence distance). */
  aimPoint: THREE.Vector3;
  /** Extra bore elevation that compensates bullet drop at the current zero (rad). */
  dropAngle: number;
  /** Main camera: the viewmodel renders with the same FOV so its space IS camera space. */
  mainCamera: THREE.PerspectiveCamera;
  /** Arm stamina 0..1. */
  stamina: number;
  /** Wall compression target 0..1 from the obstacle probes. */
  wallTarget: number;
  /** +1 right shoulder, -1 left shoulder. */
  shoulder: number;
}

export interface RecoilKick {
  /** Effective vertical / horizontal kick this shot (deg), for camera transfer. */
  vertical: number;
  horizontal: number;
}

/**
 * The physical weapon, expressed in camera space. Rendered in its own pass with
 * the SAME FOV as the main camera, so camera space maps 1:1 to the world: the
 * muzzle you see is the muzzle bullets leave from.
 *
 * Camera and weapon are separate bodies. The weapon is aimed at the camera's aim
 * point, then physically displaced by independent layers:
 *   inertia (turn lag) · linear inertia (accelerating/stopping) · procedural sway
 *   (breathing, tremor, drift; worse when tired) · bob · sprint/equip/reload poses ·
 *   recoil (rotates around the shoulder) · wall compression · shoulder side.
 * Weight, length and ergonomics drive all of it through Handling.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly flash = new MuzzleFlash();

  // Hierarchy: pivot (pose) > recoilPivot (at the butt) > buttOffset > mirror (shoulder side) > rig
  private pivot = new THREE.Group();
  private recoilPivot = new THREE.Group();
  private buttOffset = new THREE.Group();
  private mirror = new THREE.Group();
  private rigs = new Map<string, WeaponRig>();
  private rig: WeaponRig | null = null;
  private weapon: Weapon | null = null;
  private handling: Handling | null = null;
  private animator = new WeaponAnimator();
  private pose: PoseOffset = { pos: new THREE.Vector3(), rot: new THREE.Vector3() };

  // Springs
  private ads = new Spring(120, 18);
  private inertia = new Spring3(100, 12);
  private linear = new Spring3(120, 14);
  private recoilRot = new Spring3(170, 16);
  private recoilPos = new Spring3(270, 22);
  private jolt = new Spring3(220, 16);
  private land = new Spring(160, 13);
  private landRot = new Spring(140, 12);
  private wall = new Spring(90, 16);
  private side = new Spring(70, 15);

  // Sway noise
  private nTremorX = new Noise1D(11);
  private nTremorY = new Noise1D(23);
  private nDriftX = new Noise1D(37);
  private nDriftY = new Noise1D(51);
  private breathPhase = 0;

  private sprintBlend = 0;
  private crouchBlend = 0;
  private airOffset = 0;
  private time = 0;
  private adsPos = new THREE.Vector3();
  private hipPos = new THREE.Vector3();
  private lookRate = new THREE.Vector2();
  private prevVel = new THREE.Vector3();
  private accel = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private q = new THREE.Quaternion();

  // --- Debug / gameplay readouts ---
  /** Clamped ADS amount 0..1 (what the rest of the game uses). */
  adsAmount = 0;
  /** Current ADS time after stamina/movement modifiers (s). */
  adsTimeNow = 0;
  readonly inertiaDeg = new THREE.Vector2();
  /** Weapon recoil displacement (deg): x = muzzle climb, y = horizontal. */
  readonly recoilDeg = new THREE.Vector2();
  /** Combined sway (deg). */
  readonly swayDeg = new THREE.Vector2();
  wallCompression = 0;
  /** Shoulder transition in progress (no firing). */
  switchingShoulder = false;

  constructor(aspect: number, weapons: WeaponData[]) {
    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.01, 10);
    this.scene.add(this.pivot);
    this.pivot.add(this.recoilPivot);
    this.recoilPivot.add(this.buttOffset);
    this.buttOffset.add(this.mirror);
    this.recoilPivot.rotation.order = 'YXZ';
    for (const w of weapons) {
      const r = buildWeaponModel(w.model);
      r.root.visible = false;
      this.mirror.add(r.root);
      this.rigs.set(w.id, r);
    }
    this.side.reset(1);
    // Lighting tuned to roughly match the arena.
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3530, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.set(-0.8, 0.3, -0.6);
    this.scene.add(rim);
  }

  setWeapon(weapon: Weapon, handling: Handling): void {
    if (this.rig) this.rig.root.visible = false;
    this.weapon = weapon;
    this.rig = this.rigs.get(weapon.data.id)!;
    this.rig.root.visible = true;
    this.animator.setRig(this.rig);
    this.flash.attachTo(this.rig.muzzle);
    this.recoilPos.reset();
    this.recoilRot.reset();
    this.jolt.reset();
    this.ads.reset(0);
    this.refresh(handling);
  }

  /** Re-read handling + sight placement (after switching or tuning edits). */
  refresh(handling: Handling): void {
    const d = this.weapon?.data;
    if (!d || !this.rig) return;
    this.handling = handling;
    this.hipPos.set(...d.viewmodel.hipPosition);
    const s = this.rig.sight.position;
    this.adsPos.set(-s.x, -s.y, -d.sight.sightDistance - s.z);
    const b = this.rig.butt;
    this.recoilPivot.position.copy(b);
    this.buttOffset.position.set(-b.x, -b.y, -b.z);
  }

  get activeRig(): WeaponRig | null {
    return this.rig;
  }

  /** Muzzle-end distance in front of the eye at rest (m), used by the wall probes. */
  restReach(ads: number): number {
    if (!this.rig) return 0;
    const z = this.hipPos.z + (this.adsPos.z - this.hipPos.z) * ads;
    return -(z + this.rig.muzzle.position.z);
  }

  /**
   * One shot = one impulse into the recoil springs. Leftover motion from earlier
   * shots stays in the springs, so tap fire, bursts and full auto feel different
   * without any shot-index tables.
   */
  kick(data: WeaponData, ammo: AmmoData, crouching: boolean): RecoilKick {
    const r = data.recoil;
    const h = this.handling!;
    const ads = this.adsAmount;
    const scale = feel.recoilScale * ammo.recoilModifier * h.recoilMass * (crouching ? 0.9 : 1) * (1 - 0.1 * ads);
    const k = r.shoulder;
    this.recoilRot.stiffness = k;
    this.recoilRot.damping = 2 * r.damping * Math.sqrt(k);
    this.recoilPos.stiffness = k * 1.6;
    this.recoilPos.damping = 2 * 0.7 * Math.sqrt(k * 1.6);
    const w = Math.sqrt(k) * 1.9 * DEG;
    const vertical = r.vertical * scale * (0.9 + Math.random() * 0.2);
    const horizontal = (r.horizontalBias + (Math.random() * 2 - 1) * r.horizontal) * scale;
    const side = this.side.value >= 0 ? 1 : -1;
    this.recoilRot.impulse(vertical * w, -horizontal * w * side, randSign() * r.roll * scale * w);
    const wp = Math.sqrt(k * 1.6) * 1.9;
    this.recoilPos.impulse((Math.random() * 2 - 1) * r.back * 0.1 * wp, r.back * 0.15 * wp, r.back * scale * wp);
    if (feel.muzzleFlash) this.flash.trigger(data.fx.muzzleFlashScale * (1 - 0.25 * ads));
    return { vertical, horizontal };
  }

  /** Small physical jolts on mechanical events (mag seated, bolt release, pump...). */
  onMechanical(kind: 'magIn' | 'boltForward' | 'shellInsert' | 'pump' | 'magOut' | 'equip'): void {
    const j = this.jolt;
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
    this.land.impulse(-clamp(fallSpeed * 0.05, 0, 0.7));
    this.landRot.impulse(-clamp(fallSpeed * 0.06, 0, 0.9));
  }

  onJump(): void {
    this.land.impulse(-0.25);
  }

  update(dt: number, input: ViewmodelInput): void {
    const weapon = this.weapon;
    const rig = this.rig;
    const h = this.handling;
    if (!weapon || !rig || !h) return;
    const d = weapon.data;
    const p = input.player;
    this.time += dt;
    const invDt = 1 / Math.max(dt, 1 / 240);

    // --- Local-frame player motion (forward / lateral) and acceleration ---
    const cy = Math.cos(p.yaw);
    const sy = Math.sin(p.yaw);
    const fwdVel = -p.velocity.x * sy - p.velocity.z * cy;
    const latVel = p.velocity.x * cy - p.velocity.z * sy;
    const ax = (p.velocity.x - this.prevVel.x) * invDt;
    const az = (p.velocity.z - this.prevVel.z) * invDt;
    this.prevVel.copy(p.velocity);
    const ak = damp(12, dt);
    this.accel.x += (clamp(-ax * sy - az * cy, -60, 60) - this.accel.x) * ak; // forward accel
    this.accel.y += (clamp(ax * cy - az * sy, -60, 60) - this.accel.y) * ak; // lateral accel
    const moving = clamp(Math.hypot(fwdVel, latVel) / 6, 0, 1.6);

    // --- ADS: a spring whose speed comes from handling, stamina and movement ---
    const fatigue = 1 - input.stamina;
    this.adsTimeNow = h.adsTime * (1 + 0.5 * fatigue) * (1 + 0.12 * Math.min(1, moving)) * (p.crouching ? 0.95 : 1);
    const wn = 4.2 / Math.max(0.05, this.adsTimeNow);
    this.ads.stiffness = wn * wn;
    this.ads.damping = 2 * h.adsZeta * wn;
    this.ads.target = input.adsTarget;
    this.ads.update(dt);
    this.ads.value = clamp(this.ads.value, -0.05, 1.04);
    const ads = clamp(this.ads.value, 0, 1);
    this.adsAmount = ads;
    const adsEase = smoothstep(clamp(this.ads.value, 0, 1.04));

    // --- Shoulder side (mirror flips while the gun is low and centred) ---
    this.side.target = input.shoulder;
    this.side.update(dt);
    const sideV = clamp(this.side.value, -1, 1);
    const sideSign = sideV >= 0 ? 1 : -1;
    this.mirror.scale.x = sideSign;
    const sideTransit = 1 - Math.abs(sideV);
    this.switchingShoulder = Math.abs(sideV) < 0.75;

    // --- Base position: shouldered (point fire) ↔ sights on the eye ---
    const pos = this.tmp.set(this.hipPos.x * sideV, this.hipPos.y, this.hipPos.z).lerp(this.adsPos, adsEase);
    pos.y -= Math.sin(adsEase * Math.PI) * 0.012 + sideTransit * 0.09;

    // --- Aim alignment: point the bore at the aim point (+ zero drop compensation) ---
    const muzzleRest = this.v.copy(pos).add(rig.muzzle.position);
    const toAim = this.v2.copy(input.aimPoint).sub(muzzleRest);
    const alignYaw = Math.atan2(-toAim.x, -toAim.z);
    const alignPitch = Math.atan2(toAim.y, Math.hypot(toAim.x, toAim.z)) + input.dropAngle;

    // --- Inertia: lag ≈ turn rate × inertia time; the follow spring settles it ---
    const rate = this.lookRate;
    const rk = damp(25, dt);
    rate.x += (input.lookPitch * invDt - rate.x) * rk;
    rate.y += (input.lookYaw * invDt - rate.y) * rk;
    const inertiaTime = h.inertiaTime * (1 - 0.35 * ads);
    const maxLag = 6 * DEG;
    const lag = this.inertia;
    lag.stiffness = h.followFreq * h.followFreq;
    lag.damping = 2 * h.followZeta * h.followFreq;
    lag.target.set(
      clamp(-rate.x * inertiaTime, -maxLag, maxLag),
      clamp(-rate.y * inertiaTime, -maxLag, maxLag),
      -(latVel / 6) * 2.5 * DEG * (1 - ads * 0.8),
    );
    const iner = lag.update(dt);
    this.inertiaDeg.set(iner.x / DEG, iner.y / DEG);

    // --- Linear inertia: the gun lags behind body acceleration (stops, direction changes) ---
    const lin = this.linear;
    lin.stiffness = (h.followFreq * 0.8) ** 2;
    lin.damping = 2 * 0.55 * h.followFreq * 0.8;
    const linScale = h.moment / 4.5;
    lin.target.set(
      clamp(-this.accel.y * 0.0009 * linScale, -0.025, 0.025),
      clamp(-Math.abs(this.accel.x) * 0.0002 * linScale, -0.01, 0),
      clamp(this.accel.x * 0.0011 * linScale, -0.03, 0.03),
    );
    const linP = lin.update(dt);

    // --- Procedural sway: breathing + hand tremor + slow drift, worse when tired ---
    const stance = p.crouching ? 0.7 : 1;
    const swayAmp = h.swayScale * stance * (1 - 0.55 * ads);
    const breathRate = 0.22 + 0.25 * fatigue;
    this.breathPhase += Math.PI * 2 * breathRate * dt;
    const settle = 1 + Math.min(3, Math.abs(this.ads.velocity) * 0.6);
    const t = this.time;
    const breathX = Math.sin(this.breathPhase) * 0.1 * (1 + 1.6 * fatigue);
    const breathY = Math.sin(this.breathPhase * 0.5 + 1.3) * 0.04 * (1 + 1.6 * fatigue);
    const tremor = 0.035 * (1 + 3 * fatigue * fatigue) * settle;
    const drift = 0.18 * (1 + 0.6 * (1 - ads));
    const swayX = swayAmp * (breathX + this.nTremorX.sample(t * 2.6) * tremor + this.nDriftX.sample(t * 0.18) * drift) * DEG;
    const swayY = swayAmp * (breathY + this.nTremorY.sample(t * 2.9 + 40) * tremor + this.nDriftY.sample(t * 0.16 + 80) * drift) * DEG;
    this.swayDeg.set(swayX / DEG, swayY / DEG);

    // --- Walk bob (direction-aware) ---
    const sprinting = p.sprinting && weapon.state !== 'reloading';
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * damp(10, dt);
    this.crouchBlend += ((p.crouching ? 1 : 0) - this.crouchBlend) * damp(10, dt);
    const back = fwdVel < -0.5 ? 0.7 : 1;
    const bobAmt = (1 + 0.6 * this.sprintBlend) * moving * (p.grounded ? 1 : 0) * (1 - 0.8 * ads) * back * (1 - 0.35 * this.crouchBlend);
    const ph = p.bobPhase;
    const bobX = Math.sin(ph) * 0.007 * bobAmt;
    const bobY = -Math.abs(Math.cos(ph)) * 0.008 * bobAmt + 0.004 * bobAmt;
    const bobRoll = Math.sin(ph) * (1.3 + Math.abs(latVel) * 0.15) * DEG * bobAmt;
    const bobYaw = Math.sin(ph) * 0.7 * DEG * bobAmt;
    const bobPitch = Math.cos(ph * 2) * 0.35 * DEG * bobAmt;

    // --- Air / landing ---
    const targetAir = p.grounded ? 0 : clamp(-p.velocity.y * 0.0025, -0.02, 0.03);
    this.airOffset += (targetAir - this.airOffset) * damp(10, dt);
    const landY = this.land.update(dt);
    const landPitch = this.landRot.update(dt) * DEG * 3;

    // --- Equip / holster ---
    let equipDown = 0;
    if (weapon.state === 'equipping') equipDown = 1 - (1 - Math.pow(1 - weapon.stateProgress, 3));
    else if (weapon.state === 'holstering') equipDown = weapon.stateProgress * weapon.stateProgress;
    else if (weapon.state === 'holstered') equipDown = 1;

    // --- Procedural reload / cycling ---
    this.animator.update(weapon, this.pose);

    // --- Wall compression: slide back, then tilt up into a high-ready ---
    this.wall.stiffness = (h.followFreq * 0.9) ** 2;
    this.wall.damping = 2 * 0.85 * h.followFreq * 0.9;
    this.wall.target = input.wallTarget;
    this.wall.update(dt);
    const wc = clamp(this.wall.value, 0, 1);
    this.wallCompression = wc;
    const pull = Math.min(wc, 0.5) * 2 * Math.min(0.3 * d.handling.length, 0.26);
    const raise = smoothstep((wc - 0.35) / 0.65);

    // --- Recoil + jolts ---
    const rp = this.recoilPos.update(dt);
    const rr = this.recoilRot.update(dt);
    rr.x = clamp(rr.x, -6 * DEG, 14 * DEG);
    rr.y = clamp(rr.y, -6 * DEG, 6 * DEG);
    const jr = this.jolt.update(dt);
    this.recoilDeg.set(rr.x / DEG, -rr.y / DEG);

    // --- Sprint pose ---
    const sp = SPRINT_POSE[d.animSet];
    const sb = this.sprintBlend * (1 - ads);
    const crouchY = -0.012 * this.crouchBlend * (1 - ads);

    pos.x += iner.y * 0.06 - latVel * 0.001 * (1 - ads) + linP.x + bobX + sp.pos[0] * sb * sideV + this.pose.pos.x * sideSign - raise * 0.03 * sideV;
    pos.y += iner.x * 0.05 + linP.y + bobY + sp.pos[1] * sb + this.pose.pos.y + this.airOffset + landY + crouchY - 0.28 * equipDown + raise * 0.05;
    pos.z += linP.z + sp.pos[2] * sb + this.pose.pos.z + 0.04 * equipDown + pull;
    this.pivot.position.copy(pos);

    this.euler.set(
      alignPitch + iner.x + swayX + bobPitch + landPitch + sp.rot[0] * sb + this.pose.rot.x + jr.x - 0.9 * equipDown + raise * 0.95,
      alignYaw + iner.y + swayY + bobYaw + (sp.rot[1] * sb + this.pose.rot.y) * sideSign + jr.y + 0.15 * equipDown * sideSign - linP.x * 0.4,
      iner.y * 0.6 + iner.z + bobRoll + (sp.rot[2] * sb + this.pose.rot.z) * sideSign + jr.z + 0.35 * equipDown * sideSign + raise * 0.25 * sideV,
    );
    this.pivot.quaternion.setFromEuler(this.euler);
    // The shoulder stops the gun: rearward travel is capped (less when aimed, where the
    // sights are already at the eye), so recoil can never shove the weapon into the camera.
    const maxBack = 0.03 - 0.018 * ads;
    const backZ = rp.z > 0 ? maxBack * Math.tanh(rp.z / maxBack) : Math.max(rp.z, -0.02);
    this.recoilPivot.position.set(rig.butt.x + clamp(rp.x, -0.01, 0.01), rig.butt.y + clamp(rp.y, -0.015, 0.015), rig.butt.z + backZ);
    this.recoilPivot.rotation.set(rr.x, rr.y, rr.z);

    // Same projection as the world camera: viewmodel space == camera space.
    // When aimed, the cheek sits on the stock: clip the stock section right at the eye
    // instead of letting its top face fill the lower screen.
    const mc = input.mainCamera;
    const near = 0.01 + 0.045 * ads;
    if (this.camera.fov !== mc.fov || this.camera.aspect !== mc.aspect || Math.abs(this.camera.near - near) > 1e-4) {
      this.camera.fov = mc.fov;
      this.camera.aspect = mc.aspect;
      this.camera.near = near;
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

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
