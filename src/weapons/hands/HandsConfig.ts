import config from '../../config/hands.json';

type V3 = [number, number, number];

/** One arm's IK settings (aim space unless said). */
export interface ArmSettings {
  /** The shoulder pivot (m). */
  shoulder: V3;
  /**
   * Aimed, the firing shoulder sits where the stock is: this offset (m) from the weapon's butt
   * point (shouldered weapons, the firing side only; the support shoulder stays put).
   */
  aimShoulder?: V3;
  /** The preferred way the elbow points (the pole hint): it never inverts against this. */
  elbow: V3;
  /**
   * Hand space: the forearm's natural line out of the wrist (toward the elbow), and how far
   * (0…1) the elbow turns from `elbow` toward where that line would put it (less wrist bend).
   */
  forearm: V3;
  natural: number;
  /** The elbow never points higher than this (the pole's y: −1 straight down … 1 up). */
  elbowUp: number;
}

/**
 * The first-person arms' settings, src/config/hands.json (shared by every weapon: nothing
 * weapon-specific lives here; a weapon's hands are in its view profile).
 */
export interface HandsConfig {
  /** First-person arms at all. Off: the weapon is drawn on its own (no glove model is loaded). */
  enabled: boolean;
  model: string;
  /** The upper arm's sleeve tube (the glove mesh ends at the elbow). */
  sleeve: { radius: [number, number]; color: string };
  right: ArmSettings;
  left: ArmSettings;
  ik: {
    /** Time constant (s) the elbow's direction follows with: it can't flip in a frame. */
    poleSmoothing: number;
    /**
     * Past this share of the arm's length the elbow stops straightening and the upper arm's
     * sleeve takes the rest (the hand stays on its target; the elbow never snaps straight).
     */
    softReach: number;
  };
  /**
   * The trigger finger between SAFE and TRIGGER_READY (`trigger` 0 → 1): the knuckle leads
   * (done by `lead`), the middle and tip joints follow (from `follow`), and on the way the finger
   * lifts `lift` degrees off the receiver at its knuckle, so it goes round the trigger guard
   * instead of through it.
   */
  trigger: { lift: number; lead: number; follow: number };
  /** Easing time constants (s). `pull`: how long a shot keeps the trigger pressed. `turn`: a
   * hand's orientation when an animation has it without giving one (schema-1 weapons). */
  timing: { fingers: number; ik: number; trigger: number; pull: number; turn: number };
  /** Schema-1 profiles only: their grips are the palm's place (palmGrip, hand space) and their
   * reload / bolt hands one fixed turn (deg, weapon space, from flat on top of the weapon). */
  legacy: { palmGrip: V3; reloadRotation: V3; interactionRotation: V3 };
}

const CONFIG = config as unknown as HandsConfig;

/** The arms' settings (the calibration page edits them live; the game only reads them). */
export const handConfig = (): HandsConfig => CONFIG;
