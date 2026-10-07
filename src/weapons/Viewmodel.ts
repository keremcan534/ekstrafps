import * as THREE from 'three';
import { Spring, Spring3 } from '../core/Spring';
import { Noise1D } from '../core/Noise';
import { DEG, clamp, damp, hfovToVfov, randSign, smoothstep } from '../core/math';
import { playerConfig } from '../player/PlayerConfig';
import { feel } from '../config/Feel';
import { MuzzleFlash } from '../fx/MuzzleFlash';
import { buildWeaponModel, compactViewRig, type WeaponRig } from './WeaponModels';
import { buildProfiledRig, type ProfiledView } from './ProfiledRig';
import { FirstPersonArms } from './FirstPersonHands';
import { attachHands, layoutHands } from './HandGrips';
import type { WeaponHands } from './HandPose';
import { FOCUS_DEFAULTS, adsTarget, aimMode, poseQuaternion, solveAdsPose, viewProfile, type AimSettings, type ViewProfile } from './ViewProfile';
import { updateVisibleMatrices } from '../core/VisibleMatrices';
import { WeaponAnimator, type PoseOffset } from './WeaponAnimator';
import type { Weapon } from './Weapon';
import type { WeaponData } from './WeaponData';
import type { AmmoData } from './AmmoData';
import type { Handling } from './Handling';
import type { PlayerController } from '../player/PlayerController';

/**
 * Whole-weapon sprint poses (rotation rad, position m), right shoulder: weapons without a
 * view profile (and the starting point of a new profile's sprint pose).
 */
export const SPRINT_POSE = {
  rifle: { rot: [-0.32, 0.6, 0.4], pos: [-0.04, -0.05, 0.05] },
  pistol: { rot: [0.45, 0.25, 0.2], pos: [-0.03, -0.035, 0.07] },
  shotgun: { rot: [-0.3, 0.55, 0.42], pos: [-0.04, -0.05, 0.05] },
  bolt: { rot: [-0.3, 0.55, 0.42], pos: [-0.04, -0.05, 0.05] },
} as const;

/** What the viewmodel reads off the player (the calibration page passes a stand-in). */
export type ViewmodelPlayer = Pick<PlayerController, 'yaw' | 'velocity' | 'crouching' | 'sprinting' | 'grounded' | 'bobPhase'>;

export interface ViewmodelInput {
  player: ViewmodelPlayer;
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

/** How much of the aimed recoil goes rearward instead of flipping the muzzle (0..1). */
export const rearwardShare = (ads: number): number => feel.adsRecoilRearward * ads * ads;

/** Roll of the weapon at the hip (rad) for weapons without a view profile: canted toward the centre. */
const HIP_CANT = 0.12;

/**
 * Share of each motion layer taken away at full ADS (0 keeps all of it, 1 none).
 * LEGACY is the old behaviour, kept for weapons without a view profile.
 * PROFILED: aimed, the gun turns about the eye (rear and front sight stay lined up, the
 * whole picture moves a little) and hardly shifts sideways (a shift splits rear from
 * front sight), so the sight stays usable on every weapon. Global on purpose: a weapon's
 * own taste is its profile's motion multipliers, not a different aimed behaviour.
 */
interface AdsCut {
  inertia: number;
  inertiaRoll: number;
  inertiaShift: number;
  strafeRoll: number;
  linear: number;
  sway: number;
  bobTurn: number;
  bobShift: number;
  landing: number;
  jolt: number;
  recoilShift: number;
  recoilRoll: number;
  /** The weapon's own animation pose (bolt work, reloads): its turn and its shift. */
  poseTurn: number;
  poseShift: number;
  air: number;
}
const LEGACY_CUT: AdsCut = { inertia: 0.35, inertiaRoll: 0, inertiaShift: 0, strafeRoll: 0.8, linear: 0, sway: 0.55, bobTurn: 0.8, bobShift: 0.8, landing: 0, jolt: 0, recoilShift: 0, recoilRoll: 0, poseTurn: 0, poseShift: 0, air: 0 };
const PROFILED_CUT: AdsCut = { inertia: 0.85, inertiaRoll: 0.9, inertiaShift: 0.95, strafeRoll: 0.95, linear: 0.97, sway: 0.6, bobTurn: 0.85, bobShift: 0.95, landing: 0.7, jolt: 0.6, recoilShift: 0.8, recoilRoll: 0.7, poseTurn: 0.95, poseShift: 0.95, air: 0.9 };

/** Near plane of the weapon pass for profiled weapons (m). Fixed: nothing is hidden by moving it. */
const VIEW_NEAR = 0.01;

/**
 * Aimed-alignment tolerances. `solve`: the base pose against its target, should be zero (a
 * bug otherwise). `rest`: everything but breathing once the motion has settled.
 */
const ADS_TOL = { solveMm: 0.05, solveDeg: 0.005, restMm: 0.2, restDeg: 0.02 };

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

/**
 * The physical weapon, expressed in camera space. Rendered in its own pass with
 * the SAME FOV as the main camera, so camera space maps 1:1 to the world: the
 * muzzle you see is the muzzle bullets leave from.
 *
 * Weapons with a view profile (ViewProfile.ts) sit in layers that each do one job:
 *
 *   aimReference        the camera's aim axis (the screen centre unless a visual punch or
 *                       shake moved the view): eye at the origin, aiming along -Z
 *   └ weaponRig         shoulder side (a mirror)
 *     └ basePoseRoot    hip ↔ aimed ↔ sprint. Aimed is SOLVED from the ADSPoint onto the
 *                       aim axis, never stored. Calibration only: no motion goes in here.
 *       └ proceduralRoot  inertia, linear inertia, sway, bob, landing, recoil, jolts,
 *                         reload, equip, wall: offsets only. They turn about the grip at the
 *                         hip and about the eye aimed, and all settle back to nothing.
 *         └ WeaponInstance (rig.root) → OrientationRoot → model, ADSPoint, MuzzlePoint...
 *
 * Weapons without one still use the old automatic placement (pivot > recoilPivot >
 * buttOffset > mirror > rig) until they get a profile.
 *
 * Weight, length and ergonomics drive the motion through Handling.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly flash = new MuzzleFlash();

  // Profiled weapons (see above).
  readonly aimReference = new THREE.Group();
  /** The player's arms on a profiled weapon's grips (FirstPersonHands.ts). */
  readonly arms = new FirstPersonArms();
  private weaponRig = new THREE.Group();
  private basePoseRoot = new THREE.Group();
  private proceduralRoot = new THREE.Group();
  // Weapons without a profile: pivot (pose) > recoilPivot (at the butt) > buttOffset > mirror (shoulder side) > rig
  private pivot = new THREE.Group();
  private recoilPivot = new THREE.Group();
  private buttOffset = new THREE.Group();
  private mirror = new THREE.Group();
  /** The arms' space for a weapon without a profile: camera space, mirrored to the shoulder. */
  private legacyArms = new THREE.Group();
  /** The gun's own lights (setLight scales them with the light around you). */
  private lights = {
    fill: new THREE.HemisphereLight(0xdfe8ff, 0x4a4540, 1.35),
    key: new THREE.DirectionalLight(0xfff2e0, 2.5),
    rim: new THREE.DirectionalLight(0x9fc4ff, 0.9),
  };
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
  private sinceKick = 99;
  private lookRate = new THREE.Vector2();
  private prevVel = new THREE.Vector3();
  private accel = new THREE.Vector2();

  /** This frame's motion layers, shared by both placements. */
  private m = {
    ads: 0,
    adsEase: 0,
    sideV: 1,
    sideSign: 1,
    sideTransit: 0,
    latVel: 0,
    iner: new THREE.Vector3(),
    linP: new THREE.Vector3(),
    swayX: 0,
    swayY: 0,
    bobX: 0,
    bobY: 0,
    bobRoll: 0,
    bobYaw: 0,
    bobPitch: 0,
    landY: 0,
    landPitch: 0,
    equipDown: 0,
    pull: 0,
    raise: 0,
    rp: new THREE.Vector3(),
    rr: new THREE.Vector3(),
    jr: new THREE.Vector3(),
    sb: 0,
    sprintBlendPrev: 0,
    crouchY: 0,
  };

  // Old placement
  private adsPos = new THREE.Vector3();
  private hipPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  /**
   * The zero (old placement): how far the bore points above / beside the sight line (rad,
   * pitch / yaw). Aimed, the sights line up with the eye and the bore keeps this angle to
   * them, like a zeroed rifle; the shot direction adds it back (forwardWorld(…, true)).
   */
  readonly zero = { pitch: 0, yaw: 0 };
  private zeroEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private q = new THREE.Quaternion();

  // Profiled placement: poses from the profile (aim space), the ADSPoint frame and its target.
  private hipP = new THREE.Vector3();
  private hipQ = new THREE.Quaternion();
  private adsP = new THREE.Vector3();
  private adsQ = new THREE.Quaternion();
  private sprintP = new THREE.Vector3();
  private sprintQ = new THREE.Quaternion();
  private frameP = new THREE.Vector3();
  private frameQ = new THREE.Quaternion();
  private targetP = new THREE.Vector3();
  private targetQ = new THREE.Quaternion();
  private muzzleZ = { hip: 0, ads: 0 };
  /** FocusAim settings of the weapon in hand (null: TrueADS or no profile). */
  private focus: AimSettings | null = null;
  /** What full aim takes away from each motion layer, for the weapon in hand. */
  private cut: AdsCut = PROFILED_CUT;
  // This frame: base pose, motion with and without breathing sway (x ↦ q·x + t, aim space).
  private baseP = new THREE.Vector3();
  private baseQ = new THREE.Quaternion();
  private motionQ = new THREE.Quaternion();
  private motionT = new THREE.Vector3();
  private restQ = new THREE.Quaternion();
  private restT = new THREE.Vector3();
  private readonly t = { q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3() };
  /** Shot direction this frame, camera space (profiled weapons). */
  private shotDir = new THREE.Vector3(0, 0, -1);
  private restHold = 0;
  private warnedAt = { solve: -99, rest: -99 };

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
  /**
   * Aimed alignment of a profiled weapon, measured every frame it is fully aimed: the
   * ADSPoint against where the solve puts it (on the aim axis, eyeRelief out, level).
   */
  readonly adsCheck = {
    profiled: false,
    /** FocusAim: no sight alignment to measure (the numbers below stay 0). */
    focus: false,
    /** Fully aimed this frame: the numbers below are current. */
    aimed: false,
    /** Base pose alone: the solve itself, ~0 unless something is broken. */
    solveMm: 0,
    solveDeg: 0,
    /** With every motion layer: the sight picture as you see it now. */
    liveMm: 0,
    liveDeg: 0,
    liveRollDeg: 0,
    /** Every layer but breathing sway: what is left once the motion settles (→ 0). */
    restMm: 0,
    restDeg: 0,
    /** Aim axis against the screen centre (a visual punch or shake): the view, not the weapon. */
    aimVsScreenDeg: 0,
  };

  constructor(aspect: number, weapons: WeaponData[]) {
    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.01, 10);
    this.aimReference.name = 'AimReference';
    this.weaponRig.name = 'WeaponRig';
    this.basePoseRoot.name = 'BasePoseRoot';
    this.proceduralRoot.name = 'ProceduralRoot';
    this.scene.add(this.aimReference);
    this.aimReference.add(this.weaponRig);
    this.weaponRig.add(this.basePoseRoot);
    this.weaponRig.add(this.arms.group);
    this.basePoseRoot.add(this.proceduralRoot);
    this.scene.add(this.pivot);
    this.legacyArms.name = 'LegacyArms';
    this.scene.add(this.legacyArms);
    this.pivot.add(this.recoilPivot);
    this.recoilPivot.add(this.buttOffset);
    this.buttOffset.add(this.mirror);
    this.recoilPivot.rotation.order = 'YXZ';
    for (const w of weapons) {
      const profile = viewProfile(w.id);
      const r = (profile && buildProfiledRig(profile, w)) || this.legacyRig(w);
      // The old rigs' own hands stay hidden; arms are drawn on profiled weapons (see `arms`).
      r.leftHand.visible = false;
      r.rightHand.visible = false;
      r.root.visible = false;
      (r.view ? this.proceduralRoot : this.mirror).add(r.root);
      this.rigs.set(w.id, r);
    }
    this.side.reset(1);
    // Lighting tuned to roughly match the arena.
    // A touch brighter than the room: aimed, the gun reads as parts and edges, not a black mass.
    this.scene.add(this.lights.fill, this.lights.key, this.lights.rim);
    this.lights.key.position.set(0.6, 1, 0.4);
    this.lights.rim.position.set(-0.8, 0.3, -0.6);
  }

  /**
   * The light around you (ViewLight): `level` 1 in a lit room, less in the dark; `color`
   * its hue. The gun's own lights and reflections follow it.
   */
  setLight(level: number, color: THREE.Color): void {
    const L = this.lights;
    L.fill.intensity = 1.35 * level;
    L.key.intensity = 2.5 * level;
    L.rim.intensity = 0.9 * level;
    L.fill.color.setHex(0xdfe8ff).multiply(color);
    L.key.color.setHex(0xfff2e0).multiply(color);
    L.rim.color.setHex(0x9fc4ff).multiply(color);
    this.scene.environmentIntensity = 0.6 * level;
  }

  /** Old automatic placement: the procedural rig dressed in the model (WeaponMeshes.dressRig). */
  private legacyRig(w: WeaponData): WeaponRig {
    const r = buildWeaponModel(w.model, false, false, w.sight.sightDistance);
    compactViewRig(r);
    return r;
  }

  setWeapon(weapon: Weapon, handling: Handling): void {
    if (this.rig) this.rig.root.visible = false;
    this.weapon = weapon;
    this.rig = this.rigs.get(weapon.data.id)!;
    this.rig.root.visible = true;
    this.aimReference.visible = !!this.rig.view;
    this.pivot.visible = !this.rig.view;
    (this.rig.view ? this.weaponRig : this.legacyArms).add(this.arms.group);
    this.adsCheck.profiled = !!this.rig.view;
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
    const rig = this.rig;
    if (!d || !rig) return;
    this.handling = handling;
    const view = rig.view;
    if (view) {
      const p = view.profile;
      this.hipP.set(...p.hip.position);
      poseQuaternion(p.hip.rotation, this.hipQ);
      this.sprintP.set(...p.sprint.position);
      poseQuaternion(p.sprint.rotation, this.sprintQ);
      view.frame.decompose(this.frameP, this.frameQ, this.v);
      this.focus = aimMode(p) === 'FocusAim' ? { ...FOCUS_DEFAULTS, ...p.aim } : null;
      this.adsCheck.focus = !!this.focus;
      if (this.focus) {
        // FocusAim: the hip pose brought in (no sight alignment); steadier by the weapon's own multipliers.
        const f = this.focus;
        this.adsP.set(...f.aimWeaponPositionOffset).add(this.hipP);
        const r = p.hip.rotation;
        const o = f.aimWeaponRotationOffset;
        poseQuaternion([r[0] + o[0], r[1] + o[1], r[2] + o[2]], this.adsQ);
        const keep = (k: number) => 1 - Math.min(1, Math.max(0, k));
        this.cut = {
          ...PROFILED_CUT,
          sway: keep(f.aimSwayMultiplier),
          bobTurn: keep(f.aimBobMultiplier),
          bobShift: keep(f.aimBobMultiplier),
          inertia: keep(f.aimInertiaMultiplier),
          inertiaRoll: keep(f.aimInertiaMultiplier),
          inertiaShift: keep(f.aimInertiaMultiplier),
        };
      } else {
        solveAdsPose(p, view.frame, this.adsP, this.adsQ);
        this.cut = PROFILED_CUT;
      }
      adsTarget(p, new THREE.Matrix4()).decompose(this.targetP, this.targetQ, this.v);
      const mz = rig.muzzle.position;
      this.muzzleZ.hip = this.v.copy(mz).applyQuaternion(this.hipQ).add(this.hipP).z;
      this.muzzleZ.ads = this.v.copy(mz).applyQuaternion(this.adsQ).add(this.adsP).z;
      return;
    }
    this.hipPos.set(...d.viewmodel!.hipPosition);
    const s = rig.sight.position;
    const ads = d.viewmodel!.ads;
    if (ads) this.adsPos.set(...ads.position);
    else this.adsPos.set(-s.x, -s.y, -(rig.eyeRelief ?? d.sight.sightDistance! - (rig.sightShift ?? 0)) - s.z);
    const b = rig.butt;
    this.recoilPivot.position.copy(b);
    this.buttOffset.position.set(-b.x, -b.y, -b.z);
  }

  get activeRig(): WeaponRig | null {
    return this.rig;
  }

  /** The weapon's shouldered position (aim space, right shoulder): the wall probes start near it. */
  get hipPosition(): readonly number[] {
    const view = this.rig?.view;
    return view ? view.profile.hip.position : this.weapon!.data.viewmodel!.hipPosition;
  }

  /** Aimed horizontal FOV (deg, 16:9): TrueADS the profile's ADS FOV, FocusAim its aim FOV. */
  get adsFov(): number {
    const view = this.rig?.view;
    if (!view) return this.weapon!.data.sight.adsFov!;
    return this.focus ? this.focus.aimFOV : view.profile.ads.fov;
  }

  /** The weapon's own hip FOV (horizontal deg), or null: the player's FOV setting. */
  get hipFov(): number | null {
    return this.rig?.view?.profile.aim?.hipFOV ?? null;
  }

  /** Look sensitivity at full aim (× on top of the FOV's own scaling). */
  get aimSensitivity(): number {
    return this.rig?.view?.profile.aim?.aimSensitivityMultiplier ?? 1;
  }

  /** Muzzle-end distance in front of the eye at rest (m), used by the wall probes. */
  restReach(ads: number): number {
    if (!this.rig) return 0;
    if (this.rig.view) return -(this.muzzleZ.hip + (this.muzzleZ.ads - this.muzzleZ.hip) * ads);
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
    // Aimed recoil "rework": when shouldered and aimed, the gun drives straight back
    // into the shoulder instead of flipping the sights out of view; the climb is
    // carried by the view instead (RecoilSystem), so the dot stays on the target.
    const rw = rearwardShare(ads);
    this.recoilRot.impulse(vertical * w * (1 - 0.85 * rw), -horizontal * w * side * (1 - 0.6 * rw), randSign() * r.roll * scale * w * (1 - 0.5 * rw));
    const wp = Math.sqrt(k * 1.6) * 1.9;
    this.recoilPos.impulse((Math.random() * 2 - 1) * r.back * 0.1 * wp, r.back * (0.15 - 0.1 * rw) * wp, r.back * scale * wp * (1 + 0.9 * rw));
    if (feel.muzzleFlash) this.flash.trigger(data.fx.muzzleFlashScale * (1 - 0.25 * ads));
    this.sinceKick = 0;
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
    const rig = this.rig;
    if (!this.weapon || !rig || !this.handling) return;
    const view = rig.view;
    this.motion(dt, input, view ? this.cut : LEGACY_CUT);
    if (view) {
      this.placeProfiled(input, view);
      this.checkAds(dt, input, view);
    } else this.placeLegacy(input);

    // Viewmodel space == camera space. The gun has its own field of view at the hip
    // (player.json viewmodelFov): drawn at a wide world FOV a gun looks small and far off.
    // Aimed it is the world's, so the sight picture sits over the world as it is.
    // Old placement only: aimed, the near plane cuts the stock at the eye (a profiled weapon
    // sits where it should and keeps a fixed near plane).
    const mc = input.mainCamera;
    const fov = mc.fov - Math.max(0, mc.fov - hfovToVfov(playerConfig.viewmodelFov)) * (1 - this.adsAmount);
    const near = view ? VIEW_NEAR : 0.01 + 0.045 * this.m.ads;
    if (Math.abs(this.camera.fov - fov) > 1e-6 || this.camera.aspect !== mc.aspect || Math.abs(this.camera.near - near) > 1e-4) {
      this.camera.fov = fov;
      this.camera.aspect = mc.aspect;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    this.flash.update(dt);
    // The weapon in hand only: the fifteen holstered rigs (and the parts merged into
    // their anchors) are hidden. Points under hidden parts are read with getWorldPosition.
    updateVisibleMatrices(view ? this.aimReference : this.pivot, true);
    if (!view) this.legacyArms.updateMatrixWorld(true);
    const w = this.weapon;
    this.arms.update(dt, rig, view ? this.weaponRig : this.legacyArms, { ads: this.adsAmount, sprint: this.sprintBlend, sinceShot: w.timeSinceShot, reloading: w.state === 'reloading' });
  }

  /** Every motion layer for this frame (springs, noise, poses), before any is placed. */
  private motion(dt: number, input: ViewmodelInput, K: AdsCut): void {
    const weapon = this.weapon!;
    const h = this.handling!;
    const p = input.player;
    const m = this.m;
    this.time += dt;
    this.sinceKick += dt;
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
    m.latVel = latVel;

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
    m.ads = ads;
    m.adsEase = smoothstep(clamp(this.ads.value, 0, 1.04));

    // --- Shoulder side (the mirror flips while the gun is low and centred) ---
    this.side.target = input.shoulder;
    this.side.update(dt);
    m.sideV = clamp(this.side.value, -1, 1);
    m.sideSign = m.sideV >= 0 ? 1 : -1;
    m.sideTransit = 1 - Math.abs(m.sideV);
    this.switchingShoulder = Math.abs(m.sideV) < 0.75;

    // --- Inertia: lag ≈ turn rate × inertia time; the follow spring settles it ---
    const rate = this.lookRate;
    const rk = damp(25, dt);
    rate.x += (input.lookPitch * invDt - rate.x) * rk;
    rate.y += (input.lookYaw * invDt - rate.y) * rk;
    const inertiaTime = h.inertiaTime * (1 - K.inertia * ads);
    const maxLag = 6 * DEG;
    const lag = this.inertia;
    lag.stiffness = h.followFreq * h.followFreq;
    lag.damping = 2 * h.followZeta * h.followFreq;
    lag.target.set(
      clamp(-rate.x * inertiaTime, -maxLag, maxLag),
      clamp(-rate.y * inertiaTime, -maxLag, maxLag),
      -(latVel / 6) * 2.5 * DEG * (1 - ads * K.strafeRoll),
    );
    m.iner = lag.update(dt);
    this.inertiaDeg.set(m.iner.x / DEG, m.iner.y / DEG);

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
    m.linP = lin.update(dt);

    // --- Procedural sway: breathing + hand tremor + slow drift, worse when tired ---
    const stance = p.crouching ? 0.7 : 1;
    const swayAmp = h.swayScale * stance * (1 - K.sway * ads);
    const breathRate = 0.22 + 0.25 * fatigue;
    this.breathPhase += Math.PI * 2 * breathRate * dt;
    const settle = 1 + Math.min(3, Math.abs(this.ads.velocity) * 0.6);
    const t = this.time;
    const breathX = Math.sin(this.breathPhase) * 0.1 * (1 + 1.6 * fatigue);
    const breathY = Math.sin(this.breathPhase * 0.5 + 1.3) * 0.04 * (1 + 1.6 * fatigue);
    const tremor = 0.035 * (1 + 3 * fatigue * fatigue) * settle;
    const drift = 0.18 * (1 + 0.6 * (1 - ads));
    m.swayX = swayAmp * (breathX + this.nTremorX.sample(t * 2.6) * tremor + this.nDriftX.sample(t * 0.18) * drift) * DEG;
    m.swayY = swayAmp * (breathY + this.nTremorY.sample(t * 2.9 + 40) * tremor + this.nDriftY.sample(t * 0.16 + 80) * drift) * DEG;
    this.swayDeg.set(m.swayX / DEG, m.swayY / DEG);

    // --- Walk bob (direction-aware) ---
    m.sprintBlendPrev = this.sprintBlend;
    const sprinting = p.sprinting && weapon.state !== 'reloading';
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * damp(10, dt);
    this.crouchBlend += ((p.crouching ? 1 : 0) - this.crouchBlend) * damp(10, dt);
    const back = fwdVel < -0.5 ? 0.7 : 1;
    const bob = (1 + 0.6 * this.sprintBlend) * moving * (p.grounded ? 1 : 0) * back * (1 - 0.35 * this.crouchBlend);
    const bobShift = bob * (1 - K.bobShift * ads);
    const bobTurn = bob * (1 - K.bobTurn * ads);
    const ph = p.bobPhase;
    m.bobX = Math.sin(ph) * 0.007 * bobShift;
    m.bobY = -Math.abs(Math.cos(ph)) * 0.008 * bobShift + 0.004 * bobShift;
    m.bobRoll = Math.sin(ph) * (1.3 + Math.abs(latVel) * 0.15) * DEG * bobTurn;
    m.bobYaw = Math.sin(ph) * 0.7 * DEG * bobTurn;
    m.bobPitch = Math.cos(ph * 2) * 0.35 * DEG * bobTurn;

    // --- Air / landing ---
    const targetAir = p.grounded ? 0 : clamp(-p.velocity.y * 0.0025, -0.02, 0.03);
    this.airOffset += (targetAir - this.airOffset) * damp(10, dt);
    m.landY = this.land.update(dt);
    m.landPitch = this.landRot.update(dt) * DEG * 3;

    // --- Equip / holster ---
    let equipDown = 0;
    if (weapon.state === 'equipping') equipDown = 1 - (1 - Math.pow(1 - weapon.stateProgress, 3));
    else if (weapon.state === 'holstering') equipDown = weapon.stateProgress * weapon.stateProgress;
    else if (weapon.state === 'holstered') equipDown = 1;
    m.equipDown = equipDown;

    // --- Procedural reload / cycling ---
    this.animator.update(weapon, this.pose);

    // --- Wall compression: slide back, then tilt up into a high-ready ---
    this.wall.stiffness = (h.followFreq * 0.9) ** 2;
    this.wall.damping = 2 * 0.85 * h.followFreq * 0.9;
    this.wall.target = input.wallTarget;
    this.wall.update(dt);
    const wc = clamp(this.wall.value, 0, 1);
    this.wallCompression = wc;
    m.pull = Math.min(wc, 0.5) * 2 * Math.min(0.3 * weapon.data.handling.length, 0.26);
    m.raise = smoothstep((wc - 0.35) / 0.65);

    // --- Recoil + jolts ---
    m.rp = this.recoilPos.update(dt);
    const rr = this.recoilRot.update(dt);
    rr.x = clamp(rr.x, -6 * DEG, (14 - 10 * rearwardShare(ads)) * DEG);
    rr.y = clamp(rr.y, -6 * DEG, 6 * DEG);
    m.rr = rr;
    m.jr = this.jolt.update(dt);
    this.recoilDeg.set(rr.x / DEG, -rr.y / DEG);

    // --- Sprint pose share, crouch ---
    m.sb = this.sprintBlend * (1 - ads);
    m.crouchY = -0.012 * this.crouchBlend * (1 - ads);
  }

  /** Old automatic placement: every layer summed into one pose (weapons without a view profile). */
  private placeLegacy(input: ViewmodelInput): void {
    const rig = this.rig!;
    const d = this.weapon!.data;
    const m = this.m;
    const { ads, adsEase, sideV, sideSign, sideTransit } = m;
    this.mirror.scale.x = sideSign;
    this.legacyArms.scale.x = sideSign;

    // --- Base position: shouldered (point fire) ↔ sights on the eye ---
    const pull = this.hipPull();
    const pos = this.tmp.set(this.hipPos.x * sideV * pull, this.hipPos.y * pull, this.hipPos.z).lerp(this.adsPos, adsEase);
    pos.y -= Math.sin(adsEase * Math.PI) * 0.012 + sideTransit * 0.09;

    // --- Aim alignment: point the bore at the aim point (+ zero drop compensation) ---
    const muzzleRest = this.v.copy(pos).add(rig.muzzle.position);
    const toAim = this.v2.copy(input.aimPoint).sub(muzzleRest);
    const boreYaw = Math.atan2(-toAim.x, -toAim.z);
    const borePitch = Math.atan2(toAim.y, Math.hypot(toAim.x, toAim.z)) + input.dropAngle;
    // Aimed, the sights line up instead (rear notch, front post and eye on one line; the
    // sights sit 5-7 cm over the bore, so pointing the bore tipped them off the eye line).
    // The bore keeps its angle to them, the zero, which the shot direction adds back.
    const toSight = this.v3.copy(input.aimPoint).sub(this.v.copy(pos).add(rig.sight.position));
    const sightYaw = Math.atan2(-toSight.x, -toSight.z);
    const sightPitch = Math.atan2(toSight.y, Math.hypot(toSight.x, toSight.z));
    // A pose set by hand (gun-pose.html) is the sight picture as it should be: aimed, the
    // gun takes exactly that turn. Else a model whose sight line slopes to its bore tips
    // so the line itself is level, about the rear sight (where the eye looks through).
    const handAds = d.viewmodel?.ads;
    const adsRot = handAds?.rotation;
    const alignYaw = handAds ? boreYaw * (1 - adsEase) + adsRot![1] * DEG * adsEase : boreYaw + (sightYaw - boreYaw) * adsEase;
    const tilt = handAds ? 0 : (rig.sightTilt ?? 0) * adsEase;
    const alignPitch = handAds ? borePitch * (1 - adsEase) + adsRot![0] * DEG * adsEase : borePitch + (sightPitch - borePitch) * adsEase + tilt;
    pos.y += rig.sight.position.z * Math.sin(tilt);
    const hipRot = d.viewmodel?.hipRotation;
    const hipK = (1 - adsEase) * (1 - m.sprintBlendPrev * (1 - ads));
    this.zero.pitch = borePitch - alignPitch;
    this.zero.yaw = boreYaw - alignYaw;

    // --- Every layer summed ---
    const { iner, linP, jr, rr, rp, sb } = m;
    const pose = this.pose;
    const sp = SPRINT_POSE[d.animSet];
    pos.x += iner.y * 0.06 - m.latVel * 0.001 * (1 - ads) + linP.x + m.bobX + sp.pos[0] * sb * sideV + pose.pos.x * sideSign - m.raise * 0.03 * sideV;
    pos.y += iner.x * 0.05 + linP.y + m.bobY + sp.pos[1] * sb + pose.pos.y + this.airOffset + m.landY + m.crouchY - 0.28 * m.equipDown + m.raise * 0.05;
    pos.z += linP.z + sp.pos[2] * sb + pose.pos.z + 0.04 * m.equipDown + m.pull;
    this.pivot.position.copy(pos);

    this.euler.set(
      alignPitch + iner.x + m.swayX + m.bobPitch + m.landPitch + sp.rot[0] * sb + pose.rot.x + jr.x - 0.9 * m.equipDown + m.raise * 0.95 + (hipRot ? hipRot[0] * DEG * hipK : 0),
      alignYaw + iner.y + m.swayY + m.bobYaw + (sp.rot[1] * sb + pose.rot.y) * sideSign + jr.y + 0.15 * m.equipDown * sideSign - linP.x * 0.4 + (hipRot ? hipRot[1] * DEG * hipK * sideSign : 0),
      iner.y * 0.6 + iner.z + m.bobRoll + (sp.rot[2] * sb + pose.rot.z) * sideSign + jr.z + 0.35 * m.equipDown * sideSign + m.raise * 0.25 * sideV +
        // Hip carry: the gun sits canted, top toward the centre (gone when aimed or sprinting).
        (hipRot ? hipRot[2] * DEG * hipK : HIP_CANT * (1 - adsEase) * (1 - sb)) * sideSign +
        (handAds ? adsRot![2] * DEG * adsEase : 0),
      'YXZ',
    );
    this.pivot.quaternion.setFromEuler(this.euler);
    // The shoulder stops the gun: rearward travel is capped, so recoil can never shove the
    // weapon into the camera. Aimed, barely at all (6 mm): the sight picture keeps its
    // size shot after shot instead of swelling toward the eye and back.
    const maxBack = 0.03 - 0.024 * ads;
    const backZ = rp.z > 0 ? maxBack * Math.tanh(rp.z / maxBack) : Math.max(rp.z, -0.02);
    this.recoilPivot.position.set(rig.butt.x + clamp(rp.x, -0.01, 0.01), rig.butt.y + clamp(rp.y, -0.015, 0.015), rig.butt.z + backZ);
    this.recoilPivot.rotation.set(rr.x, rr.y, rr.z);
  }

  /** Profiled placement: the base pose from the profile, the motion layered on top of it. */
  private placeProfiled(input: ViewmodelInput, view: ProfiledView): void {
    const m = this.m;
    const side = Math.abs(m.sideV);
    // The aim axis in camera space: bullets go along it (the screen centre unless a visual
    // punch or shake has moved the view; those never move the aim).
    this.aimReference.quaternion.setFromUnitVectors(FORWARD, this.v.copy(input.aimPoint).normalize());
    this.weaponRig.scale.x = m.sideSign;

    // --- Base pose: hip ↔ aimed (solved) ↔ sprint. Calibration only. ---
    const pull = this.hipPull();
    const bp = this.baseP.copy(this.hipP);
    bp.x *= side * pull;
    bp.y *= pull;
    const bq = this.baseQ.slerpQuaternions(IDENTITY, this.hipQ, side);
    if (this.focus) {
      // FocusAim's pose is the hip's brought in: it crosses shoulders like the hip pose.
      const ap = this.v3.copy(this.adsP);
      ap.x *= side;
      bp.lerp(ap, m.adsEase);
      bq.slerp(this.t.q2.slerpQuaternions(IDENTITY, this.adsQ, side), m.adsEase);
    } else {
      bp.lerp(this.adsP, m.adsEase);
      bq.slerp(this.adsQ, m.adsEase);
    }
    if (m.sb > 0) {
      const sp = this.v2.copy(this.sprintP);
      sp.x *= side * pull;
      sp.y *= pull;
      bp.lerp(sp, m.sb);
      bq.slerp(this.t.q1.slerpQuaternions(IDENTITY, this.sprintQ, side), m.sb);
    }
    this.basePoseRoot.position.copy(bp);
    this.basePoseRoot.quaternion.copy(bq);

    // --- Motion: one rigid offset in aim space, hung under the base pose as B⁻¹·P·B ---
    this.composeMotion(view, true, this.motionQ, this.motionT);
    const bqInv = this.t.q2.copy(bq).invert();
    this.proceduralRoot.quaternion.copy(bqInv).multiply(this.motionQ).multiply(bq);
    this.proceduralRoot.position.copy(bp).applyQuaternion(this.motionQ).add(this.motionT).sub(bp).applyQuaternion(bqInv);

    // --- Shot direction: from the muzzle to the camera's aim point, raised for drop, then
    // turned by the motion (sway, inertia and recoil move the point of impact with the gun). ---
    const mb = this.v2.copy(this.rig!.muzzle.position).applyQuaternion(bq).add(bp);
    mb.x *= m.sideSign;
    mb.applyQuaternion(this.aimReference.quaternion);
    const dir = this.shotDir.copy(input.aimPoint).sub(mb).normalize();
    const axis = this.v3.crossVectors(dir, UP);
    if (axis.lengthSq() > 1e-8) dir.applyAxisAngle(axis.normalize(), input.dropAngle);
    // The motion turn is in the mirrored aim space: mirror it back, then into camera space.
    const turn = this.t.q1.copy(this.motionQ);
    if (m.sideSign < 0) turn.set(turn.x, -turn.y, -turn.z, turn.w);
    turn.premultiply(this.aimReference.quaternion).multiply(this.t.q3.copy(this.aimReference.quaternion).invert());
    dir.applyQuaternion(turn);
  }

  /**
   * The motion layers as one rigid transform in aim space (x ↦ q·x + t). The world's push
   * on the gun (inertia, sway, bob, landing, jolts) keeps its direction on either shoulder,
   * so its yaw, roll and sideways parts are flipped against the shoulder mirror; the gun's
   * own moves (reload, equip, wall) mirror with it. Turns are about the grip at the hip
   * and about the eye aimed (the sight picture stays whole), recoil about the butt → eye.
   */
  private composeMotion(view: ProfiledView, withSway: boolean, q: THREE.Quaternion, t: THREE.Vector3): void {
    const m = this.m;
    const K = this.cut;
    const mot = view.profile.motion;
    const { ads, adsEase, sideSign: s, iner, linP, jr, rr, rp } = m;
    const side = Math.abs(m.sideV);
    const bp = this.baseP;
    const bq = this.baseQ;
    const pose = this.pose;
    const inr = mot.inertia;
    const bob = mot.bob;
    const rc = mot.recoil;
    const sway = withSway ? mot.sway : 0;
    const lin = (1 - K.linear * ads) * inr;
    const shift = (1 - K.inertiaShift * ads) * inr;
    const roll = (1 - K.inertiaRoll * ads) * inr;
    const land = 1 - K.landing * ads;
    const jolt = 1 - K.jolt * ads;
    // Bolt work and reloads aimed (a bolt action, a shell gun): the gun stays on the eye line.
    const poseTurn = 1 - K.poseTurn * ads;
    const poseShift = 1 - K.poseShift * ads;
    const poseR = pose.rot;
    const poseP = pose.pos;

    const pitch = iner.x * inr + m.swayX * sway + m.bobPitch * bob + m.landPitch * land + jr.x * jolt + poseR.x * poseTurn - 0.9 * m.equipDown + m.raise * 0.95;
    const yaw = (iner.y * inr + m.swayY * sway + m.bobYaw * bob + jr.y * jolt - linP.x * 0.4 * lin) * s + poseR.y * poseTurn + 0.15 * m.equipDown;
    const rollA = (iner.y * 0.6 * roll + iner.z * inr + m.bobRoll * bob + jr.z * jolt) * s + poseR.z * poseTurn + 0.35 * m.equipDown + m.raise * 0.25 * side;
    const qM = this.t.q1.setFromEuler(this.euler.set(pitch, yaw, rollA, 'YXZ'));
    const shiftV = this.t.a.set(
      (iner.y * 0.06 * shift - m.latVel * 0.001 * (1 - ads) + linP.x * lin + m.bobX * bob) * s + poseP.x * poseShift - m.raise * 0.03 * side,
      iner.x * 0.05 * shift + linP.y * lin + m.bobY * bob + poseP.y * poseShift + this.airOffset * (1 - K.air * ads) + m.landY * land + m.crouchY - 0.28 * m.equipDown + m.raise * 0.05 -
        Math.sin(adsEase * Math.PI) * 0.012 - m.sideTransit * 0.09,
      linP.z * lin + poseP.z * poseShift + 0.04 * m.equipDown + m.pull,
    );

    // Recoil, in the gun's own frame. The shoulder stops the gun: rearward travel is capped,
    // aimed to 6 mm. The kick carries the shoulder side already: undone under the mirror.
    const maxBack = 0.03 - 0.024 * ads;
    const backZ = rp.z > 0 ? maxBack * Math.tanh(rp.z / maxBack) : Math.max(rp.z, -0.02);
    const recShift = (1 - K.recoilShift * ads) * rc;
    const tR = this.t.b.set(clamp(rp.x, -0.01, 0.01) * recShift, clamp(rp.y, -0.015, 0.015) * recShift, backZ * rc).applyQuaternion(bq);
    const qR = this.t.q2.setFromEuler(this.euler.set(rr.x * rc, rr.y * rc * s, rr.z * rc * (1 - K.recoilRoll * ads), 'YXZ'));
    qR.premultiply(bq).multiply(this.t.q3.copy(bq).invert());

    // Pivots: grip and butt at the hip, the eye (origin) aimed with TrueADS (the sight
    // picture stays whole); FocusAim has no sight picture to keep: grip and butt throughout.
    const toEye = this.focus ? 0 : adsEase;
    const pm = this.t.c.copy(bp).multiplyScalar(1 - toEye);
    const pr = this.t.d
      .copy(this.rig!.butt)
      .applyQuaternion(bq)
      .add(bp)
      .multiplyScalar(1 - toEye);

    // P = T(shift + tR) · Rot(qM about pm) · Rot(qR about pr)
    q.multiplyQuaternions(qM, qR);
    const e = this.t.e.copy(pr).applyQuaternion(qR);
    t.copy(pr).sub(e).applyQuaternion(qM).add(pm);
    t.sub(e.copy(pm).applyQuaternion(qM)).add(shiftV).add(tR);
  }

  /** Measure the aimed alignment (see adsCheck) and warn when it is off. */
  private checkAds(dt: number, input: ViewmodelInput, view: ProfiledView): void {
    const c = this.adsCheck;
    c.aimVsScreenDeg = Math.acos(clamp(-input.aimPoint.z / Math.max(1e-6, input.aimPoint.length()), -1, 1)) / DEG;
    c.aimed = this.ads.value >= 0.999 && this.weapon!.state !== 'holstered';
    if (!c.aimed || this.focus) {
      this.restHold = 0;
      return;
    }
    const err = (q: THREE.Quaternion | null, t: THREE.Vector3 | null): [number, number, number] => {
      // The ADSPoint in aim space: (motion ·) base · frame.
      const fq = this.t.q1.copy(this.baseQ).multiply(this.frameQ);
      const fp = this.t.a.copy(this.frameP).applyQuaternion(this.baseQ).add(this.baseP);
      if (q && t) {
        fq.premultiply(q);
        fp.applyQuaternion(q).add(t);
      }
      const mm = fp.distanceTo(this.targetP) * 1000;
      const f = this.t.b.copy(FORWARD).applyQuaternion(fq);
      const ft = this.t.c.copy(FORWARD).applyQuaternion(this.targetQ);
      const deg = Math.acos(clamp(f.dot(ft), -1, 1)) / DEG;
      const u = this.t.d.copy(UP).applyQuaternion(fq);
      const ut = this.t.e.copy(UP).applyQuaternion(this.targetQ);
      const rollDeg = Math.atan2(ut.clone().cross(u).dot(ft), ut.dot(u)) / DEG;
      return [mm, deg, rollDeg];
    };
    [c.solveMm, c.solveDeg] = err(null, null);
    [c.liveMm, c.liveDeg, c.liveRollDeg] = err(this.motionQ, this.motionT);
    this.composeMotion(view, false, this.restQ, this.restT);
    [c.restMm, c.restDeg] = err(this.restQ, this.restT);

    const id = view.profile.id;
    if ((c.solveMm > ADS_TOL.solveMm || c.solveDeg > ADS_TOL.solveDeg) && this.time - this.warnedAt.solve > 5) {
      this.warnedAt.solve = this.time;
      console.warn(`[view] ${id}: aimed pose misses its ADSPoint by ${c.solveMm.toFixed(2)} mm / ${c.solveDeg.toFixed(3)}° (solve)`);
    }
    // Still, not turning, no shot for a second: whatever is left once the motion settles must go.
    const quiet = input.player.velocity.lengthSq() < 0.0025 && this.lookRate.lengthSq() < 1e-4 && this.sinceKick > 1 && this.weapon!.state === 'ready';
    this.restHold = quiet ? this.restHold + dt : 0;
    if (this.restHold > 1.5 && (c.restMm > ADS_TOL.restMm || c.restDeg > ADS_TOL.restDeg) && this.time - this.warnedAt.rest > 5) {
      this.warnedAt.rest = this.time;
      console.warn(`[view] ${id}: not back on its ADSPoint after the motion settled: ${c.restMm.toFixed(2)} mm / ${c.restDeg.toFixed(3)}°`);
    }
  }

  /**
   * Calibration only (weapon-calibration.html): rebuild weapon `data.id` from a working copy
   * of its profile. The game never calls this; its profiles are frozen.
   */
  setViewProfile(data: WeaponData, profile: Readonly<ViewProfile>): boolean {
    const r = buildProfiledRig(profile, data);
    if (!r) return false;
    r.leftHand.visible = false;
    r.rightHand.visible = false;
    r.root.visible = false;
    const old = this.rigs.get(data.id);
    if (old) {
      old.root.removeFromParent();
      old.root.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
    }
    this.proceduralRoot.add(r.root);
    this.rigs.set(data.id, r);
    if (this.weapon?.data.id === data.id) {
      this.rig = r;
      r.root.visible = true;
      this.aimReference.visible = true;
      this.pivot.visible = false;
      this.weaponRig.add(this.arms.group);
      this.adsCheck.profiled = true;
      this.animator.setRig(r);
      this.flash.attachTo(r.muzzle);
      this.refresh(this.handling!);
    }
    return true;
  }

  /**
   * Calibration only: put hands `def` (or the current ones, re-placed) on the weapon in hand,
   * a procedural gun's (its rig's own space). Reload paths start from the new grips.
   */
  setHands(def?: WeaponHands): void {
    const rig = this.rig;
    if (!rig) return;
    if (def) attachHands(rig, def);
    else layoutHands(rig);
    this.animator.setRig(rig);
  }

  /**
   * The gun is drawn at its own, narrower field of view: bigger. Its hip and sprint poses
   * come in toward the eye's axis by the same ratio, so it stays where it was on screen
   * (bigger, not pushed further into the corner). Aimed, nothing changes.
   */
  private hipPull(): number {
    const own = Math.tan((hfovToVfov(playerConfig.viewmodelFov) * DEG) / 2);
    const world = Math.tan((hfovToVfov(playerConfig.baseFov) * DEG) / 2);
    return Math.min(1, own / world);
  }

  /** World position of a point on the weapon (muzzle, eject port, laser). */
  toWorld(local: THREE.Object3D, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    local.getWorldPosition(out);
    // Drawn at the gun's own field of view: the world point on screen where it is drawn
    // (flash, smoke, tracers and shells start at the muzzle and port you see).
    const k = Math.tan((mainCamera.fov * DEG) / 2) / Math.tan((this.camera.fov * DEG) / 2);
    out.x *= k;
    out.y *= k;
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  /** World-space forward (bore direction, -Z of the weapon) of a weapon part. */
  forwardWorld(local: THREE.Object3D, mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3, zeroed = false): THREE.Vector3 {
    local.getWorldQuaternion(this.q);
    out.set(0, 0, -1).applyQuaternion(this.q);
    // The bore's zero (see `zero`): small turns in the weapon's view space.
    if (zeroed) out.applyEuler(this.zeroEuler.set(this.zero.pitch, this.zero.yaw, 0));
    return out.transformDirection(mainCamera.matrixWorld);
  }

  /**
   * World direction a shot leaves the muzzle in. Profiled weapons: toward the camera's aim
   * point (+ drop), turned by the weapon's motion; a model's own crookedness can't send it
   * aside. Others: along the bore plus the zero.
   */
  shotDirection(mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    if (this.rig?.view) return out.copy(this.shotDir).transformDirection(mainCamera.matrixWorld);
    return this.forwardWorld(this.rig!.muzzle, mainCamera, out, true);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
