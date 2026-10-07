import GUI from 'lil-gui';
import { AI_TUNING, PROFILES } from '../ai/Tuning';
import type { WeaponData } from '../weapons/WeaponData';
import { WEAPON_DEFAULTS, weaponFile } from '../weapons/WeaponData';
import { AMMO_DEFAULTS, ammoTable } from '../weapons/AmmoData';
import { viewProfile } from '../weapons/ViewProfile';
import { playerConfig, playerConfigDefaults } from '../player/PlayerConfig';
import { feel, feelDefaults } from '../config/Feel';
import { motionTuning, motionTuningDefaults } from '../weapons/motion/MotionTuning';
import { TARKOV } from '../weapons/TarkovRecoil';
import { aiMonitor } from './AIMonitor';

export interface TuningHooks {
  getWeapon(): WeaponData;
  getAmmoId(): string;
  /** Re-derive handling after any weapon/ammo edit. */
  onWeaponTuned(): void;
  onFeelChanged(): void;
  refillAmmo(): void;
  setQuality(pixelRatio: number, shadows: boolean): void;
  quality: { pixelRatio: number; shadows: boolean };
}

/**
 * Live tuning panel (Tab / ⚙). Edits the same objects the game reads every
 * frame, so changes apply instantly. "Save to source" writes the values back
 * to src/config/*.json through the Vite dev server.
 */
export class TuningPanel {
  readonly gui: GUI;
  private weaponFolder: GUI | null = null;
  private currentWeaponId = '';
  private status: { message: string };
  private shown = true;

  constructor(private hooks: TuningHooks) {
    this.gui = new GUI({ title: 'Weapon Lab tuning', width: 330 });
    this.gui.domElement.classList.add('tuning');
    this.status = { message: 'Tab / ⚙ toggles' };
    const refresh = () => this.gui.controllersRecursive().forEach((c) => c.updateDisplay());

    // Watch the AI: a Site-9 team match with no player in it (free camera, live stats),
    // or the 3 vs 3 firefight test.
    const watch = this.gui.addFolder('AI watch');
    const go = (q: string) => () => {
      location.href = `?${q}`;
    };
    const w = {
      match: go('map=site9&mode=teams&watch'),
      firefight: go('aitest=J'),
      squads: go('aitest=E'),
    };
    watch.add(w, 'match').name('▶ Watch AI team match (Site-9)');
    watch.add(w, 'firefight').name('▶ 3 vs 3 firefight test');
    watch.add(w, 'squads').name('▶ 3 vs 3 squads test');
    watch.add(aiMonitor, 'on').name('AI monitor stats (F6)').listen();

    const actions = this.gui.addFolder('Save / reset');
    const a = {
      saveWeapon: () => this.save(weaponFile(hooks.getWeapon().id), hooks.getWeapon()),
      saveAmmo: () => this.save('ammo', ammoTable),
      savePlayer: () => this.save('player', playerConfig),
      saveFeel: () => this.save('feel', feel),
      saveMotion: () => this.save('weaponMotion', motionTuning),
      copyWeapon: () => this.copy(hooks.getWeapon()),
      resetWeapon: () => {
        const w = hooks.getWeapon();
        const def = WEAPON_DEFAULTS.find((d) => d.id === w.id);
        if (def) deepAssign(w, structuredClone(def));
        hooks.onWeaponTuned();
        refresh();
      },
      resetAmmo: () => {
        const id = hooks.getAmmoId();
        deepAssign(ammoTable[id], structuredClone(AMMO_DEFAULTS[id]));
        hooks.onWeaponTuned();
        refresh();
      },
      resetPlayer: () => {
        deepAssign(playerConfig, structuredClone(playerConfigDefaults));
        refresh();
      },
      resetFeel: () => {
        deepAssign(feel, structuredClone(feelDefaults));
        hooks.onFeelChanged();
        hooks.onWeaponTuned();
        refresh();
      },
      resetMotion: () => {
        deepAssign(motionTuning, structuredClone(motionTuningDefaults));
        refresh();
      },
      refill: () => hooks.refillAmmo(),
    };
    actions.add(a, 'saveWeapon').name('💾 Save weapon to source');
    actions.add(a, 'saveAmmo').name('💾 Save ammo to source');
    actions.add(a, 'savePlayer').name('💾 Save player to source');
    actions.add(a, 'saveFeel').name('💾 Save feel to source');
    actions.add(a, 'saveMotion').name('💾 Save weapon motion to source');
    actions.add(a, 'copyWeapon').name('Copy weapon JSON');
    actions.add(a, 'resetWeapon').name('Reset weapon');
    actions.add(a, 'resetAmmo').name('Reset ammo');
    actions.add(a, 'resetPlayer').name('Reset player');
    actions.add(a, 'resetFeel').name('Reset feel');
    actions.add(a, 'resetMotion').name('Reset weapon motion');
    actions.add(a, 'refill').name('Refill ammo');
    actions.add(this.status, 'message').name('Status').disable().listen();

    const tuned = () => hooks.onWeaponTuned();
    const feelF = this.gui.addFolder('Global feel').close();
    feelF.add(feel, 'recoilScale', 0, 3, 0.05).name('Weapon recoil scale');
    feelF.add(feel, 'cameraRecoilScale', 0, 3, 0.05).name('View recoil scale');
    feelF.add(feel, 'inertiaScale', 0, 3, 0.05).name('Inertia scale').onChange(tuned);
    feelF.add(feel, 'swayScale', 0, 3, 0.05).name('Sway scale').onChange(tuned);
    feelF.add(feel, 'armStamina').name('Arm stamina');
    feelF.add(feel, 'impactForceScale', 0, 5, 0.1).name('Impact force scale');
    feelF.add(feel, 'hitReactionScale', 0, 3, 0.05).name('Robot reaction scale');
    feelF.add(feel, 'ragdollForce', 0, 4, 0.05).name('Ragdoll death force');
    feelF.add(feel, 'hitmarkerScale', 0.5, 2, 0.05).name('Hitmarker scale');
    feelF.add(feel, 'muzzleFlash');
    feelF.add(feel, 'tracers');
    feelF.add(feel, 'bulletTrails').name('Bullet trails (air)');
    feelF.add(feel, 'shells');
    feelF.add(feel, 'decals');
    feelF.add(feel, 'damageNumbers').name('Damage numbers (N)').listen();
    feelF.add(feel, 'debugCrosshair').name('Debug crosshair (J)').listen();
    feelF.add(feel, 'infiniteAmmo').name('Infinite ammo (I)').listen();
    feelF.add(feel, 'haptics').name('Haptics (Android)');
    feelF.add(feel, 'masterVolume', 0, 1, 0.01).onChange(() => hooks.onFeelChanged());
    feelF.add(feel, 'robotRespawnTime', 0.5, 15, 0.5);

    const bd = this.gui.addFolder('SABLE').close();
    bd.add(feel, 'enemyAI').name('Enemy AI (U)').listen();
    bd.add(feel, 'godMode').name('God mode (O)').listen();
    bd.add(feel, 'enemyDamageScale', 0, 2, 0.05).name('Enemy damage scale');
    bd.add(feel, 'enemyAccuracy', 0.2, 3, 0.05).name('Enemy accuracy');
    bd.add(feel, 'playerRegen').name('Player health regen');

    // Tactical AI: everything is read live (decisions, cover, squads).
    const ai = this.gui.addFolder('Tactical AI').close();
    ai.add(AI_TUNING, 'debug').name('AI debug view (F4)').listen();
    ai.add(AI_TUNING, 'decisionInterval', 0.05, 1, 0.01).name('Decision interval (s)');
    ai.add(AI_TUNING, 'squadInterval', 0.1, 2, 0.05).name('Squad brain interval (s)');
    ai.add(AI_TUNING, 'perceptionInterval', 0.05, 0.5, 0.01).name('Perception tick (s)');
    ai.add(AI_TUNING, 'rayBudgetPerFrame', 10, 200, 1).name('Ray budget / frame');
    ai.add(AI_TUNING, 'visionRange', 20, 150, 1).name('Vision range (m)');
    ai.add(AI_TUNING, 'recognitionSpeed', 0.2, 4, 0.05).name('Recognition speed');
    ai.add(AI_TUNING, 'hearingScale', 0.2, 3, 0.05).name('Hearing distance ×');
    ai.add(AI_TUNING, 'contactMemory', 2, 40, 0.5).name('Contact memory (s)');
    ai.add(AI_TUNING, 'maxHoldCover', 2, 30, 0.5).name('Max hold in cover (s)');
    ai.add(AI_TUNING, 'minRepositionInterval', 0.5, 10, 0.25).name('Min reposition interval (s)');
    ai.add(AI_TUNING, 'peekExposure', 0.3, 3, 0.05).name('Peek exposure (s)');
    ai.add(AI_TUNING, 'suppressionGain', 0, 3, 0.05).name('Suppression gain');
    ai.add(AI_TUNING, 'suppressionDecay', 0.05, 2, 0.01).name('Suppression decay /s');
    ai.add(AI_TUNING, 'suppressedLevel', 0.1, 1.5, 0.05).name('Suppressed threshold');
    ai.add(AI_TUNING, 'flankUtility', 0, 3, 0.05).name('Flank utility ×');
    ai.add(AI_TUNING, 'pushUtility', 0, 3, 0.05).name('Push utility ×');
    ai.add(AI_TUNING, 'retreatUtility', 0, 3, 0.05).name('Retreat utility ×');
    ai.add(AI_TUNING, 'suppressUtility', 0, 3, 0.05).name('Suppress utility ×');
    ai.add(AI_TUNING, 'searchDuration', 5, 90, 1).name('Search duration (s)');
    ai.add(AI_TUNING, 'passivityTimeout', 2, 30, 0.5).name('Passivity timeout (s)');
    ai.add(AI_TUNING, 'squadStallTime', 4, 40, 0.5).name('Squad stall → new plan (s)');
    ai.add(AI_TUNING, 'commDelayMin', 0, 2, 0.05).name('Radio delay min (s)');
    ai.add(AI_TUNING, 'commDelayMax', 0, 3, 0.05).name('Radio delay max (s)');
    ai.add(AI_TUNING, 'formationSpacing', 1, 8, 0.1).name('Formation spacing (m)');
    ai.add(AI_TUNING, 'friendlyTactical', 8, 40, 1).name('Friendly tactical zone (m)');
    ai.add(AI_TUNING, 'friendlyTooFar', 15, 80, 1).name('Friendly too far (m)');
    const prof = ai.addFolder('Personality multipliers').close();
    for (const p of Object.values(PROFILES)) {
      const f = prof.addFolder(p.id).close();
      for (const k of ['cover', 'push', 'flank', 'suppress', 'hold', 'exposure', 'retreatHp', 'cooperation', 'pace', 'patience'] as const) f.add(p, k, 0, 3, 0.05);
    }

    const p = this.gui.addFolder('Player movement').close();
    p.add(playerConfig, 'walkSpeed', 1, 15, 0.1);
    p.add(playerConfig, 'sprintSpeed', 1, 20, 0.1);
    p.add(playerConfig, 'crouchSpeed', 0.5, 8, 0.1);
    p.add(playerConfig, 'adsSpeedMultiplier', 0.2, 1, 0.01);
    p.add(playerConfig, 'groundAcceleration', 5, 200, 1);
    p.add(playerConfig, 'groundDeceleration', 5, 200, 1);
    p.add(playerConfig, 'airAcceleration', 0, 80, 1);
    p.add(playerConfig, 'gravity', 5, 60, 0.5);
    p.add(playerConfig, 'jumpVelocity', 2, 15, 0.1);
    p.add(playerConfig, 'coyoteTime', 0, 0.3, 0.01);
    p.add(playerConfig, 'jumpBuffer', 0, 0.3, 0.01);
    p.add(playerConfig, 'crouchTransitionSpeed', 2, 30, 0.5);

    const c = this.gui.addFolder('Camera').close();
    c.add(playerConfig, 'baseFov', 60, 120, 1).name('FOV (horizontal 16:9)');
    c.add(playerConfig, 'sprintFovAdd', 0, 20, 0.5);
    c.add(playerConfig, 'fovLerpSpeed', 1, 30, 0.5);
    c.add(playerConfig, 'cameraBobAmount', 0, 0.08, 0.001);
    c.add(playerConfig, 'cameraBobFrequency', 0.3, 2, 0.05);
    c.add(playerConfig, 'cameraRollOnStrafe', 0, 3, 0.1);
    c.add(playerConfig, 'landingDipScale', 0, 0.08, 0.001);
    c.add(playerConfig, 'landingPitchKick', 0, 5, 0.1);
    c.add(playerConfig, 'cameraShakeScale', 0, 3, 0.05).name('Camera shake');
    c.add(playerConfig, 'mouseSensitivity', 0.0003, 0.01, 0.0001);
    c.add(playerConfig, 'touchSensitivity', 0.001, 0.02, 0.0001);
    c.add(playerConfig, 'touchAimAssist', 0, 1, 0.05).name('Touch aim assist');

    this.addMotionFolder();

    const q = this.gui.addFolder('Quality').close();
    q.add(hooks.quality, 'pixelRatio', 0.5, 2, 0.05).onFinishChange(() => hooks.setQuality(hooks.quality.pixelRatio, hooks.quality.shadows));
    q.add(hooks.quality, 'shadows').onChange(() => hooks.setQuality(hooks.quality.pixelRatio, hooks.quality.shadows));

    this.setVisible(false);
  }

  get visible(): boolean {
    return this.gui.domElement.style.display !== 'none';
  }

  setVisible(v: boolean): void {
    this.gui.domElement.style.display = v ? '' : 'none';
    this.shown = v;
    // Weapon swaps while hidden only left the folder stale: build it now.
    if (v) this.syncWeapon();
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  /**
   * Rebuild the weapon + ammo folders when the equipped weapon changes. Called
   * every frame; while the panel is hidden it does nothing (setVisible(true)
   * rebuilds), so weapon swaps don't build ~60 hidden controllers mid-fight.
   */
  syncWeapon(): void {
    if (!this.shown) return;
    const w = this.hooks.getWeapon();
    if (w.id === this.currentWeaponId) return;
    this.currentWeaponId = w.id;
    this.weaponFolder?.destroy();
    const f = (this.weaponFolder = this.gui.addFolder(`Weapon: ${w.name}`));
    this.gui.$children.insertBefore(f.domElement, this.gui.$children.children[1] ?? null);
    const tuned = () => this.hooks.onWeaponTuned();

    const h = f.addFolder('Handling (weight / length / ergonomics)');
    h.add(w.handling, 'weight', 0.5, 8, 0.05).name('Weight (kg)').onChange(tuned);
    h.add(w.handling, 'length', 0.15, 1.4, 0.01).name('Length (m)').onChange(tuned);
    h.add(w.handling, 'ergonomics', 0, 100, 1).name('Ergonomics').onChange(tuned);

    const m = f.addFolder('Mechanism & accuracy').close();
    m.add(w, 'fireRate', 30, 1500, 5).name('Fire rate (rpm)');
    m.add(w, 'magazineSize', 1, 100, 1);
    m.add(w, 'barrelLength', 0.08, 0.8, 0.005).name('Barrel (m)').onChange(tuned);
    m.add(w.accuracy, 'moa', 0, 15, 0.1).name('Mechanical MOA').onChange(tuned);
    m.add(w, 'ammo', Object.keys(ammoTable)).name('Ammo').onChange(() => {
      tuned();
      this.currentWeaponId = '';
      this.syncWeapon();
    });
    m.add(w.reload, 'time', 0.2, 5, 0.05).name('Reload time');
    m.add(w.reload, 'emptyTime', 0.2, 5, 0.05).name('Empty reload time');
    m.add(w, 'equipTime', 0.05, 2, 0.01);

    // Recoil: the weapon's Tarkov numbers (src/config/tarkovRecoil.json), live; not saved from here.
    const tk = TARKOV.weapons[w.id];
    if (tk) {
      const rc = f.addFolder(`Recoil (Tarkov: ${tk.source})`).close();
      rc.add(tk, 'up', 0, 600, 1).name('RecoilForceUp');
      rc.add(tk, 'back', 0, 1000, 1).name('RecoilForceBack');
      rc.add(tk, 'angle', 45, 135, 1).name('RecoilAngle');
      rc.add(tk, 'dispersion', 0, 45, 0.5).name('RecolDispersion');
      rc.add(tk, 'returnSpeed', 0.5, 8, 0.05).name('Return speed');
      rc.add(tk, 'damping', 0.3, 1.2, 0.01).name('Damping');
      rc.add(tk, 'camera', 0, 0.1, 0.005).name('RecoilCamera');
      rc.add(tk, 'cameraSnap', 0.5, 8, 0.1).name('CameraSnap');
      rc.add(tk, 'stableShot', 1, 10, 1).name('Stable after shot');
    }

    const ads = f.addFolder('Aim / sights').close();
    ads.add(w.aim, 'hipConvergence', 2, 100, 0.5).name('Point-fire convergence (m)');
    ads.add(w.aim, 'zeroDistance', 10, 300, 5).name('Zero (m)  [ / ]').listen();
    const vm = w.viewmodel;
    if (viewProfile(w.id) || !vm) {
      // Its first-person placement lives in its view profile, edited in the calibration page.
      ads.add({ file: 'weapon-calibration.html' }, 'file').name('Placement').disable();
    } else {
      ads.add(w.sight, 'adsFov', 20, 110, 0.5).name('ADS FOV (horizontal)');
      ads.add(w.sight, 'sightDistance', 0.05, 0.6, 0.005).name('Eye to sight (m)').onChange(tuned);
      const hip = { x: vm.hipPosition[0], y: vm.hipPosition[1], z: vm.hipPosition[2] };
      const setHip = () => {
        vm.hipPosition = [hip.x, hip.y, hip.z];
        tuned();
      };
      ads.add(hip, 'x', -0.4, 0.4, 0.001).name('Shoulder pos X').onChange(setHip);
      ads.add(hip, 'y', -0.4, 0.2, 0.001).name('Shoulder pos Y').onChange(setHip);
      ads.add(hip, 'z', -0.8, 0, 0.001).name('Shoulder pos Z').onChange(setHip);
    }

    const fx = f.addFolder('FX').close();
    fx.add(w.fx, 'tracerEvery', 0, 10, 1).name('Visual tracer every N');
    fx.add(w.fx, 'muzzleFlashScale', 0, 3, 0.05);
    fx.add(w.fx, 'smoke', 0, 2, 0.05);
    fx.add(w.fx, 'shellEjectSpeed', 0, 8, 0.1);

    const am = ammoTable[w.ammo];
    const af = f.addFolder(`Ammo: ${am.name}`).close();
    af.add(am, 'muzzleVelocity', 100, 1200, 5).name('Muzzle velocity (m/s)').onChange(tuned);
    af.add(am, 'projectileMass', 1, 30, 0.1).name('Projectile mass (g)');
    af.add(am, 'damage', 1, 200, 1);
    af.add(am, 'penetration', 0, 80, 1).name('Penetration (hook)');
    af.add(am, 'ballisticCoefficient', 0.02, 0.8, 0.01).name('Ballistic coeff.').onChange(tuned);
    af.add(am, 'ricochetChance', 0, 1, 0.01);
    af.add(am, 'tracer');
    af.add(am, 'accuracyModifier', 0.2, 3, 0.05).onChange(tuned);
    af.add(am, 'recoilModifier', 0.2, 3, 0.05);
    af.add(am, 'pellets', 1, 20, 1);
    af.add(am, 'pelletSpread', 0, 10, 0.1).name('Pellet spread (deg)');
    af.add(am, 'impactBoost', 0, 10, 0.1).name('Physics impact boost');
  }

  /**
   * First-person weapon motion (src/config/weaponMotion.json): one folder per layer, read
   * live every frame. Most values multiply what the weapon's handling already gives.
   */
  private addMotionFolder(): void {
    const M = motionTuning;
    const root = this.gui.addFolder('Weapon motion (feel)').close();
    const f = (name: string) => root.addFolder(name).close();

    const ci = f('Camera inertia');
    ci.add(M.cameraInertia, 'rotationLag', 0, 3, 0.05).name('Rotation lag ×');
    ci.add(M.cameraInertia, 'positionLag', 0, 0.2, 0.005).name('Position lag (m/rad)');
    ci.add(M.cameraInertia, 'springStrength', 0.3, 2.5, 0.05).name('Spring strength ×');
    ci.add(M.cameraInertia, 'springDamping', 0.3, 2.5, 0.05).name('Spring damping ×');
    ci.add(M.cameraInertia, 'overshootStrength', 0, 2, 0.05).name('Overshoot (momentum)');
    ci.add(M.cameraInertia, 'rollFromYaw', 0, 2, 0.05).name('Roll from yaw');
    ci.add(M.cameraInertia, 'maxRotationOffset', 0.5, 15, 0.5).name('Max rotation (°)');
    ci.add(M.cameraInertia, 'maxPositionOffset', 0, 0.04, 0.001).name('Max position (m)');

    const ac = f('Acceleration motion');
    ac.add(M.acceleration, 'strength', 0, 3, 0.05).name('Strength ×');
    ac.add(M.acceleration, 'lateral', 0, 0.008, 0.0001).name('Strafe lag (m per m/s)');
    ac.add(M.acceleration, 'forward', 0, 0.008, 0.0001).name('Fwd/back lag (m per m/s)');
    ac.add(M.acceleration, 'vertical', 0, 0.008, 0.0001).name('Vertical lag (m per m/s)');
    ac.add(M.acceleration, 'tilt', 0, 1.5, 0.01).name('Tilt (° per m/s)');
    ac.add(M.acceleration, 'strafeRoll', 0, 8, 0.1).name('Strafe roll (°)');
    ac.add(M.acceleration, 'backwardPitch', 0, 4, 0.1).name('Backward pitch (°)');
    ac.add(M.acceleration, 'springFrequency', 0.3, 2.5, 0.05).name('Spring frequency ×');
    ac.add(M.acceleration, 'damping', 0.1, 1.5, 0.01).name('Damping ratio');
    ac.add(M.acceleration, 'maxPositionOffset', 0, 0.08, 0.001).name('Max position (m)');

    const wk = f('Walking motion');
    wk.add(M.walking, 'amplitude', 0, 3, 0.05).name('Amplitude ×');
    wk.add(M.walking, 'vertical', 0, 0.02, 0.0005).name('Body step (m)');
    wk.add(M.walking, 'horizontal', 0, 0.02, 0.0005).name('Shoulder sway (m)');
    wk.add(M.walking, 'roll', 0, 5, 0.05).name('Roll (°)');
    wk.add(M.walking, 'pitch', 0, 3, 0.05).name('Pitch (°)');
    wk.add(M.walking, 'yaw', 0, 3, 0.05).name('Yaw (°)');
    wk.add(M.walking, 'stepImpulse', 0, 4, 0.05).name('Footfall impulse ×');
    wk.add(M.walking, 'handCorrection', 0, 1.5, 0.05).name('Hand correction (°)');
    wk.add(M.walking, 'variation', 0, 0.6, 0.01).name('Step variation');

    const sp = f('Sprint motion');
    sp.add(M.sprint, 'amplitude', 0, 4, 0.05).name('Amplitude ×');
    sp.add(M.sprint, 'stepImpulse', 0, 6, 0.05).name('Footfall impulse ×');
    sp.add(M.sprint, 'enterSpeed', 2, 25, 0.5).name('Pose spring (rad/s)');
    sp.add(M.sprint, 'enterDamping', 0.2, 1.5, 0.01).name('Pose damping ratio');
    sp.add(M.sprint, 'momentum', 0, 3, 0.05).name('Momentum ×');

    const ad = f('ADS motion');
    ad.add(M.ads, 'arcDip', 0, 0.04, 0.001).name('Path dip (m)');
    ad.add(M.ads, 'arcRoll', 0, 8, 0.1).name('Path cant (°)');
    ad.add(M.ads, 'leadPitch', 0, 1, 0.01).name('Muzzle trail (° per 1/s)');
    ad.add(M.ads, 'push', 0, 0.01, 0.0005).name('Push (m per 1/s)');
    ad.add(M.ads, 'handImpulse', 0, 3, 0.05).name('Hand start impulse ×');
    ad.add(M.ads, 'settleImpulse', 0, 3, 0.05).name('Shoulder settle ×');

    const br = f('Breathing');
    br.add(M.breathing, 'amplitude', 0, 3, 0.05).name('Amplitude ×');
    br.add(M.breathing, 'rate', 0.05, 0.6, 0.01).name('Rate (Hz)');
    br.add(M.breathing, 'variation', 0, 0.6, 0.01).name('Rate/depth variation');
    br.add(M.breathing, 'pitch', 0, 0.5, 0.01).name('Pitch (°)');
    br.add(M.breathing, 'lift', 0, 0.003, 0.0001).name('Lift (m)');

    const id = f('Idle noise');
    id.add(M.idleNoise, 'amplitude', 0, 3, 0.05).name('Amplitude ×');
    id.add(M.idleNoise, 'tremor', 0, 0.2, 0.005).name('Tremor (°)');
    id.add(M.idleNoise, 'drift', 0, 0.6, 0.01).name('Drift (°)');
    id.add(M.idleNoise, 'roll', 0, 0.6, 0.01).name('Roll (°)');
    id.add(M.idleNoise, 'position', 0, 0.002, 0.0001).name('Position (m)');
    id.add(M.idleNoise, 'correction', 0, 0.4, 0.01).name('Hand corrections (°)');

    // Tarkov recoil: how its numbers become motion (shared by every weapon; not saved from here).
    const rc = f('Recoil (Tarkov model)');
    const T = TARKOV.model;
    rc.add(T, 'forceToDegPerSec', 0.1, 3, 0.05).name('Kick (deg/s per force)');
    rc.add(T, 'returnToOmega', 0.5, 6, 0.05).name('Return spring ×');
    rc.add(T, 'dampingToZeta', 0.3, 1.5, 0.01).name('Damping ×');
    rc.add(T, 'cameraShare', 0, 20, 0.5).name('View share ×');
    rc.add(T, 'cameraFollow', 0.2, 8, 0.1).name('View follow ×');
    rc.add(T, 'backToMeters', 0, 0.01, 0.0001).name('Rearward kick (m/s per force)');

    const ld = f('Landing / crouch');
    ld.add(M.landing, 'strength', 0, 3, 0.05).name('Landing strength ×');
    ld.add(M.landing, 'dip', 0, 0.1, 0.001).name('Dip (m/s per m/s fall)');
    ld.add(M.landing, 'pitch', 0, 8, 0.1).name('Pitch ×');
    ld.add(M.landing, 'crouchInertia', 0, 0.006, 0.0001).name('Crouch inertia (m per m/s)');

    const sw = f('Weapon switching');
    sw.add(M.switching, 'overshoot', 0, 0.3, 0.005).name('Draw overshoot');
    sw.add(M.switching, 'settleImpulse', 0, 3, 0.05).name('Grab settle ×');
    sw.add(M.switching, 'drop', 0.05, 0.5, 0.01).name('Holster drop (m)');
    sw.add(M.switching, 'sweep', 0, 2, 0.05).name('Carry sweep ×');

    const rl = f('Reload');
    rl.add(M.reload, 'handReaction', 0, 3, 0.05).name('Hand reaction ×');
    rl.add(M.reload, 'microMotion', 0, 3, 0.05).name('Arms micro-motion ×');

    const cl = f('Weapon classes');
    for (const [name, c] of Object.entries(M.classes)) {
      const k = cl.addFolder(name).close();
      k.add(c, 'mass', 0.2, 3, 0.05).name('Mass ×');
      k.add(c, 'response', 0.3, 2, 0.05).name('Response ×');
      k.add(c, 'bob', 0, 2, 0.05).name('Bob ×');
    }
  }

  private async save(file: string, data: unknown): Promise<void> {
    try {
      const res = await fetch('/__tuning/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, data }),
      });
      const json = (await res.json()) as { ok: boolean; file?: string; error?: string };
      this.status.message = json.ok ? `Saved ${json.file}` : `Save failed: ${json.error}`;
    } catch {
      this.status.message = 'Save needs the dev server (npm run dev)';
    }
  }

  private async copy(data: unknown): Promise<void> {
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.status.message = 'Weapon JSON copied';
    } catch {
      console.log(text);
      this.status.message = 'Clipboard blocked: JSON logged to console';
    }
  }
}

/** Copy values into an existing object tree so live references stay valid. */
function deepAssign(target: object, source: object): void {
  const tgt = target as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const s = src[key];
    const t = tgt[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && t && typeof t === 'object') {
      deepAssign(t, s);
    } else {
      tgt[key] = s;
    }
  }
}
