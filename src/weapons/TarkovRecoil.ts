import config from '../config/tarkovRecoil.json';
import { isMobileMode } from '../core/math';

/** One per-shot transformation curve (Tarkov's WeaponRecoilSettings). */
interface TarkovCurve {
  target: 'HandsRotation' | 'HandsPosition' | 'CameraRotation';
  axis: 'X' | 'Y' | 'Z';
  /** Value multiplier from the hip and aimed. */
  hip: number;
  aim: number;
  /** Playback speed: the curve's 0…1 runs in 1/speed s. */
  speed: number;
  keys: [number, number][];
}

/** A weapon's recoil, as Escape from Tarkov's database has it (default preset, mods applied). */
export interface TarkovWeapon {
  source: string;
  /** RecoilForceUp / RecoilForceBack. */
  up: number;
  back: number;
  /** RecoilCategoryMultiplierHandRotation. */
  category: number;
  /** RecoilAngle (90 straight up, less leans right) ± RecolDispersion (deg). */
  angle: number;
  dispersion: number;
  /** RecoilReturnSpeedHandRotation, RecoilDampingHandRotation, RecoilReturnPathDampingHandRotation. */
  returnSpeed: number;
  damping: number;
  pathDamping: number;
  /** RecoilCamera, CameraSnap. */
  camera: number;
  cameraSnap: number;
  /** RecoilStableIndexShot, RecoilStableAngleIncreaseStep, ProgressRecoilAngleOnStable.y. */
  stableShot: number;
  stableStep: number;
  stableAngle: number;
  /** PostRecoilVertical/HorizontalRangeHandRotation (deg; vertical negative = up). */
  postVertical: [number, number];
  postHorizontal: [number, number];
  /** RecoilPosZMult. */
  backMult: number;
  curves: TarkovCurve[];
}

interface TarkovConfig {
  /**
   * How Tarkov's numbers become motion here (its client code is not public: these few
   * constants are ours, every weapon's numbers are Tarkov's).
   *   forceToDegPerSec  hand turn speed (deg/s) per unit of up × category
   *   returnToOmega     the return spring's natural frequency (rad/s) per unit of returnSpeed
   *   dampingToZeta     its damping ratio per unit of damping
   *   cameraShare       share of the hands' turn the view follows, per unit of RecoilCamera
   *   cameraFollow      how fast it follows (1/s) per unit of CameraSnap × cameraSnapMult
   *   aimCameraFollow   aimed, the view also turns this share of the rest toward the weapon
   *                     (our reading of Tarkov's CameraToWeaponAngle: the sight stays near
   *                     the centre and the whole view climbs)
   *   backToMeters      rearward speed (m/s) per unit of back
   *   burstGap          a string of fire ends after this many shot intervals without a shot
   */
  model: {
    forceToDegPerSec: number;
    returnToOmega: number;
    dampingToZeta: number;
    cameraShare: number;
    cameraFollow: number;
    aimCameraFollow: number;
    backToMeters: number;
    burstGap: number;
  };
  /** From Tarkov's globals.json (Aiming): RecoilConvergenceMult, CameraSnapGlobalMult, Recoil[XYZ]IntensityByPose. */
  globals: { convergence: number; cameraSnapMult: number; intensityCrouch: [number, number, number]; intensityStand: [number, number, number] };
  weapons: Record<string, TarkovWeapon>;
}

/** How hard the Tarkov numbers hit on this platform (tarkovRecoil.json `feel`, see its notes). */
export interface RecoilFeel {
  climb: number;
  viewShare: number;
  aimViewShare: number;
  post: number;
  settle: boolean;
  back: number;
  aimBack: number;
  moveSpread: number;
  adsZoom: number;
  sightScale: number;
  sightBead: boolean;
}

export const TARKOV = config as unknown as TarkovConfig & { feel: { desktop: RecoilFeel; mobile: RecoilFeel } };

let profile: RecoilFeel | null = null;
/** The feel profile in use: phones get the light one (minimal climb, no view drift). */
export function recoilFeel(): RecoilFeel {
  return (profile ??= isMobileMode() ? TARKOV.feel.mobile : TARKOV.feel.desktop);
}

/** Tarkov's curves have flat tangents: each segment eases in and out. */
function sampleCurve(keys: [number, number][], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1][1];
}

const MAX_SHOTS = 16;
const SUBSTEP = 1 / 240;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Escape from Tarkov's recoil (the 0.14+ model), driven by its own per-weapon numbers.
 *
 * How hard it hits is the platform's feel profile (recoilFeel(): tarkovRecoil.json `feel`):
 * the climb is scaled, the view carries only a small share of it (the sights rise on screen and
 * come back; the screen doesn't slide up), a string of fire leaves no lasting offset in the look,
 * and the rearward kick into the shoulder is what you feel. Phones: minimal climb.
 *
 *   hands   Every shot turns the hands: a kick of up × category at RecoilAngle ± RecolDispersion
 *           into a spring that pulls back at returnSpeed with damping. In full auto the kicks
 *           pile up until the spring holds them: the muzzle climbs for the first few shots and
 *           then levels off ("stable"). From stableShot on the kick's direction spreads by
 *           stableStep a shot up to stableAngle: the weapon stops climbing and shakes sideways.
 *   post    Each string of fire picks a spot within postVertical / postHorizontal: the hands
 *           come back there, not to where they started (the more of the string was fired, the
 *           further), with pathDamping calming the way back. Once settled it passes into the
 *           shooter's own aim, so it stays until the player corrects it.
 *   camera  The view follows camera × cameraShare of the hands' turn, at cameraSnap: part of the
 *           climb moves the whole screen, the rest the weapon on it; aimed, the view turns most
 *           of the way with the weapon. Bullets go where the muzzle points (view + hands).
 *   back    A rearward kick of back × backMult into the shoulder.
 *   curves  Per-shot animation curves on top (the hands' flip / roll / swing and hop, the
 *           view's roll), from the hip and aimed.
 *
 * All angles in degrees: pitch up +, yaw right +.
 */
export class TarkovRecoil {
  w: TarkovWeapon = TARKOV.weapons.ak47;
  /** The hands' turn (deg) and its speed: the total muzzle climb from recoil. */
  readonly hand = { x: 0, y: 0, vx: 0, vy: 0 };
  /** The share of it the view carries (deg). */
  readonly cam = { x: 0, y: 0 };
  /** Where the hands come back to (deg): this string of fire's post-recoil offset. */
  readonly rest = { x: 0, y: 0 };
  /** Rearward travel (m, + back) and its speed. */
  back = 0;
  private backV = 0;
  /** Aimed 0…1 (set every frame): the view's share of the turn grows with it. */
  aim = 0;
  /** Post-recoil offset settled since last taken (deg): the game moves it into the base look. */
  readonly settled = { x: 0, y: 0 };
  /**
   * Per-shot curves' sums. Tarkov's weapon space runs the barrel along Y (RecoilCenter's
   * y −0.25 is the stock, behind it), so its hands' X turn is the flip (negative up), Y the
   * roll about the bore, Z the swing sideways; its Y move is along the bore (taken as back),
   * Z up, X sideways. Here: rot deg (x up, y right, z roll), pos m (x right, y up, z back).
   */
  readonly curveRot = { x: 0, y: 0, z: 0 };
  readonly curvePos = { x: 0, y: 0, z: 0 };
  /** The view's roll from its curve (deg). */
  cameraRoll = 0;
  /** Shot index in this string of fire (0 = first) and time since the last shot. */
  shot = -1;
  sinceShot = 99;
  private interval = 0.1;
  private post = { x: 0, y: 0 };
  private times = new Float32Array(MAX_SHOTS).fill(99);
  private aimed = new Float32Array(MAX_SHOTS);
  private next = 0;

  setWeapon(id: string, rpm: number): void {
    this.w = TARKOV.weapons[id] ?? TARKOV.weapons.ak47;
    this.interval = 60 / Math.max(30, rpm);
  }

  /** The string of fire is over: the next shot starts a new one. */
  get firing(): boolean {
    return this.sinceShot < Math.max(this.interval * TARKOV.model.burstGap, this.interval + 0.08);
  }

  /** The hands' spring (ω rad/s, ζ) now: calmer on the way back. */
  spring(): [number, number] {
    const M = TARKOV.model;
    const w = this.w;
    const omega = w.returnSpeed * M.returnToOmega * TARKOV.globals.convergence;
    const zeta = w.damping * M.dampingToZeta;
    return [omega, this.firing ? zeta : 1 - (1 - zeta) * (1 - w.pathDamping)];
  }

  /** The share of the hands' turn the view carries now (the feel profile's, from the hip to aimed). */
  share(): number {
    const f = recoilFeel();
    return lerp(f.viewShare, f.aimViewShare, this.aim);
  }

  /**
   * One shot. `scale`: every outside factor (ammo, skill, settings); `aimed` 0…1; `rand` for
   * reproducible runs (the graph).
   */
  fire(scale: number, aimed: number, crouching: boolean, rand: () => number = Math.random): void {
    const w = this.w;
    const M = TARKOV.model;
    const G = TARKOV.globals;
    const I = crouching ? G.intensityCrouch : G.intensityStand;
    const F = recoilFeel();
    this.shot = this.firing ? this.shot + 1 : 0;
    const n = this.shot + 1;
    if (this.shot === 0) {
      this.post.x = -lerp(w.postVertical[0], w.postVertical[1], rand()) * F.post;
      this.post.y = lerp(w.postHorizontal[0], w.postHorizontal[1], rand()) * F.post;
    }
    const progress = Math.min(1, n / Math.max(1, w.stableShot));
    this.rest.x = this.post.x * progress;
    this.rest.y = this.post.y * progress;

    const spread = n >= w.stableShot ? Math.min(w.stableAngle, w.dispersion + (n - w.stableShot + 1) * w.stableStep) : w.dispersion;
    const a = ((w.angle + (rand() * 2 - 1) * spread) * Math.PI) / 180;
    const f = w.up * w.category * M.forceToDegPerSec * scale * F.climb;
    this.hand.vx += f * Math.sin(a) * I[1];
    this.hand.vy += f * Math.cos(a) * I[0];
    this.backV += w.back * w.backMult * M.backToMeters * scale * I[2] * F.back;

    this.times[this.next] = 0;
    this.aimed[this.next] = aimed;
    this.next = (this.next + 1) % MAX_SHOTS;
    this.sinceShot = 0;
  }

  update(dt: number): void {
    const w = this.w;
    const M = TARKOV.model;
    this.sinceShot += dt;
    const [om, ze] = this.spring();
    const h = this.hand;
    const share = this.share();
    const follow = w.cameraSnap * TARKOV.globals.cameraSnapMult * M.cameraFollow;
    // The shoulder: stiff and well damped.
    const bk = 320;
    const bc = 2 * 0.7 * Math.sqrt(bk);
    for (let left = dt; left > 1e-6; left -= SUBSTEP) {
      const s = Math.min(SUBSTEP, left);
      h.vx += (-om * om * (h.x - this.rest.x) - 2 * ze * om * h.vx) * s;
      h.vy += (-om * om * (h.y - this.rest.y) - 2 * ze * om * h.vy) * s;
      h.x += h.vx * s;
      h.y += h.vy * s;
      const k = 1 - Math.exp(-follow * s);
      this.cam.x += (h.x * share - this.cam.x) * k;
      this.cam.y += (h.y * share - this.cam.y) * k;
      this.backV += (-bk * this.back - bc * this.backV) * s;
      this.back += this.backV * s;
    }

    this.settle(dt);

    const cr = this.curveRot;
    const cp = this.curvePos;
    cr.x = cr.y = cr.z = cp.x = cp.y = cp.z = this.cameraRoll = 0;
    for (let i = 0; i < MAX_SHOTS; i++) {
      const t = (this.times[i] += dt);
      if (t > 4) continue;
      for (const c of w.curves) {
        const u = t * c.speed;
        if (u >= 1) continue;
        const v = sampleCurve(c.keys, u) * lerp(c.hip, c.aim, this.aimed[i]);
        if (c.target === 'HandsRotation') {
          if (c.axis === 'X') cr.x -= v;
          else if (c.axis === 'Y') cr.z += v;
          else cr.y += v;
        } else if (c.target === 'HandsPosition') {
          if (c.axis === 'X') cp.x += v;
          else if (c.axis === 'Y') cp.z += v;
          else cp.y += v;
        } else if (c.axis === 'Z') this.cameraRoll += v;
      }
    }
  }

  /**
   * Once a string of fire is over, the post-recoil spot moves into the shooter's aim: taken
   * out of the recoil here (the muzzle doesn't move) and added to `settled`, which the game
   * passes into the base look. Nobody taking it (the calibration page) just drops it.
   */
  private settle(dt: number): void {
    if (this.firing || (this.rest.x === 0 && this.rest.y === 0)) return;
    const k = 1 - Math.exp(-3 * dt);
    if (!recoilFeel().settle) {
      // The hands come back to where they were aimed: the offset fades, nothing passes into the look.
      this.rest.x -= this.rest.x * k;
      this.rest.y -= this.rest.y * k;
      this.post.x -= this.post.x * k;
      this.post.y -= this.post.y * k;
      if (Math.abs(this.rest.x) + Math.abs(this.rest.y) < 1e-4) this.rest.x = this.rest.y = 0;
      return;
    }
    const dx = this.rest.x * k;
    const dy = this.rest.y * k;
    this.rest.x -= dx;
    this.rest.y -= dy;
    this.post.x -= dx;
    this.post.y -= dy;
    this.hand.x -= dx;
    this.hand.y -= dy;
    const share = this.share();
    this.cam.x -= dx * share;
    this.cam.y -= dy * share;
    this.settled.x += dx;
    this.settled.y += dy;
    if (Math.abs(this.rest.x) + Math.abs(this.rest.y) < 1e-4) this.rest.x = this.rest.y = 0;
  }

  /** The settled offset since the last call (deg), cleared. */
  takeSettled(): [number, number] {
    const r: [number, number] = [this.settled.x, this.settled.y];
    this.settled.x = this.settled.y = 0;
    return r;
  }

  reset(): void {
    this.hand.x = this.hand.y = this.hand.vx = this.hand.vy = 0;
    this.cam.x = this.cam.y = this.rest.x = this.rest.y = 0;
    this.back = this.backV = 0;
    this.settled.x = this.settled.y = 0;
    this.curveRot.x = this.curveRot.y = this.curveRot.z = 0;
    this.curvePos.x = this.curvePos.y = this.curvePos.z = 0;
    this.cameraRoll = 0;
    this.shot = -1;
    this.sinceShot = 99;
    this.times.fill(99);
  }
}
