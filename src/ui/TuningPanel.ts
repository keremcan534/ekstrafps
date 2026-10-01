import GUI from 'lil-gui';
import type { WeaponData } from '../weapons/WeaponData';
import { WEAPON_DEFAULTS, WEAPON_FILES } from '../weapons/WeaponData';
import { playerConfig, playerConfigDefaults } from '../player/PlayerConfig';
import { feel, feelDefaults } from '../config/Feel';

export interface TuningHooks {
  getWeapon(): WeaponData;
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

  constructor(private hooks: TuningHooks) {
    this.gui = new GUI({ title: 'Weapon Lab tuning', width: 320 });
    this.gui.domElement.classList.add('tuning');
    this.status = { message: 'Tab / ⚙ toggles' };

    const actions = this.gui.addFolder('Save / reset');
    const a = {
      saveWeapon: () => this.save(WEAPON_FILES[hooks.getWeapon().id], hooks.getWeapon()),
      savePlayer: () => this.save('player', playerConfig),
      saveFeel: () => this.save('feel', feel),
      copyWeapon: () => this.copy(hooks.getWeapon()),
      resetWeapon: () => {
        const w = hooks.getWeapon();
        const def = WEAPON_DEFAULTS.find((d) => d.id === w.id);
        if (def) deepAssign(w, structuredClone(def));
        hooks.onWeaponTuned();
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      },
      resetPlayer: () => {
        deepAssign(playerConfig, structuredClone(playerConfigDefaults));
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      },
      resetFeel: () => {
        deepAssign(feel, structuredClone(feelDefaults));
        hooks.onFeelChanged();
        this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      },
      refill: () => hooks.refillAmmo(),
    };
    actions.add(a, 'saveWeapon').name('💾 Save weapon to source');
    actions.add(a, 'savePlayer').name('💾 Save player to source');
    actions.add(a, 'saveFeel').name('💾 Save feel to source');
    actions.add(a, 'copyWeapon').name('Copy weapon JSON');
    actions.add(a, 'resetWeapon').name('Reset weapon');
    actions.add(a, 'resetPlayer').name('Reset player');
    actions.add(a, 'resetFeel').name('Reset feel');
    actions.add(a, 'refill').name('Refill ammo');
    actions.add(this.status, 'message').name('Status').disable().listen();

    const feelF = this.gui.addFolder('Global feel').close();
    const onFeel = () => hooks.onFeelChanged();
    feelF.add(feel, 'recoilScale', 0, 3, 0.05).name('Recoil scale (aim)');
    feelF.add(feel, 'cameraRecoilScale', 0, 3, 0.05).name('Camera recoil scale');
    feelF.add(feel, 'visualRecoilScale', 0, 3, 0.05).name('Visual recoil scale');
    feelF.add(feel, 'impactForceScale', 0, 5, 0.1).name('Impact force scale');
    feelF.add(feel, 'hitReactionScale', 0, 3, 0.05).name('Robot reaction scale');
    feelF.add(feel, 'hitmarkerScale', 0.5, 2, 0.05).name('Hitmarker scale');
    feelF.add(feel, 'muzzleFlash');
    feelF.add(feel, 'tracers');
    feelF.add(feel, 'shells');
    feelF.add(feel, 'decals');
    feelF.add(feel, 'damageNumbers').name('Damage numbers (N)').listen();
    feelF.add(feel, 'haptics').name('Haptics (Android)');
    feelF.add(feel, 'masterVolume', 0, 1, 0.01).onChange(onFeel);
    feelF.add(feel, 'robotRespawnTime', 0.5, 15, 0.5);

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
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  /** Rebuild the weapon folder when the equipped weapon changes. */
  syncWeapon(): void {
    const w = this.hooks.getWeapon();
    if (w.id === this.currentWeaponId) return;
    this.currentWeaponId = w.id;
    this.weaponFolder?.destroy();
    const f = (this.weaponFolder = this.gui.addFolder(`Weapon: ${w.name}`));
    // Keep the weapon folder right under the actions.
    this.gui.$children.insertBefore(f.domElement, this.gui.$children.children[1] ?? null);
    const tuned = () => this.hooks.onWeaponTuned();

    const core = f.addFolder('Damage & fire');
    core.add(w, 'damage', 1, 300, 1);
    core.add(w, 'fireRate', 30, 1500, 5).name('Fire rate (rpm)');
    core.add(w, 'fireMode', ['auto', 'semi', 'pump']);
    core.add(w, 'magazineSize', 1, 100, 1);
    core.add(w, 'pellets', 1, 20, 1);
    core.add(w, 'range', 5, 400, 1);
    core.add(w, 'critMultiplier', 1, 5, 0.05);
    core.add(w, 'impactForce', 0, 40, 0.5).name('Impact force');
    core.add(w, 'hitReaction', 0, 6, 0.1).name('Robot reaction');
    core.add(w, 'equipTime', 0.05, 2, 0.01);
    core.add(w.reload, 'time', 0.2, 5, 0.05).name('Reload time');
    core.add(w.reload, 'emptyTime', 0.2, 5, 0.05).name('Empty reload time');

    const sp = f.addFolder('Spread').close();
    sp.add(w.spread, 'hip', 0, 15, 0.05).name('Hipfire spread');
    sp.add(w.spread, 'ads', 0, 10, 0.01).name('ADS spread');
    sp.add(w.spread, 'moving', 0, 10, 0.05).name('Moving spread');
    sp.add(w.spread, 'air', 0, 15, 0.1);
    sp.add(w.spread, 'bloomPerShot', 0, 3, 0.01);
    sp.add(w.spread, 'bloomMax', 0, 10, 0.05);
    sp.add(w.spread, 'bloomRecovery', 0, 40, 0.5);

    const rc = f.addFolder('Recoil (aim)');
    rc.add(w.recoil, 'vertical', 0, 8, 0.01).name('Vertical recoil');
    rc.add(w.recoil, 'horizontal', 0, 4, 0.01).name('Horizontal recoil');
    rc.add(w.recoil, 'horizontalBias', -2, 2, 0.01);
    rc.add(w.recoil, 'patternAmplitude', 0, 2, 0.01);
    rc.add(w.recoil, 'patternFrequency', 0, 2, 0.01);
    rc.add(w.recoil, 'firstShotMultiplier', 0, 2, 0.01);
    rc.add(w.recoil, 'buildUpPerShot', 0, 0.5, 0.005);
    rc.add(w.recoil, 'buildUpMax', 0, 3, 0.05);
    rc.add(w.recoil, 'snappiness', 1, 80, 1);
    rc.add(w.recoil, 'recoverySpeed', 0, 30, 0.1).name('Recoil recovery');
    rc.add(w.recoil, 'recoveryDelay', 0, 0.5, 0.01);
    rc.add(w.recoil, 'adsMultiplier', 0, 1.5, 0.01);

    const cr = f.addFolder('Camera recoil').close();
    cr.add(w.cameraRecoil, 'pitch', 0, 10, 0.05);
    cr.add(w.cameraRecoil, 'yaw', 0, 5, 0.05);
    cr.add(w.cameraRecoil, 'roll', 0, 10, 0.05);
    cr.add(w.cameraRecoil, 'stiffness', 20, 600, 5);
    cr.add(w.cameraRecoil, 'damping', 1, 60, 0.5);
    cr.add(w.cameraRecoil, 'fovPunch', 0, 8, 0.05);
    cr.add(w.cameraRecoil, 'shake', 0, 1, 0.005).name('Camera shake');

    const vr = f.addFolder('Visual recoil').close();
    vr.add(w.visualRecoil, 'kickBack', 0, 0.3, 0.001);
    vr.add(w.visualRecoil, 'kickUp', 0, 40, 0.1);
    vr.add(w.visualRecoil, 'kickSide', 0, 10, 0.1);
    vr.add(w.visualRecoil, 'kickRoll', 0, 20, 0.1);
    vr.add(w.visualRecoil, 'kickRaise', 0, 0.1, 0.001);
    vr.add(w.visualRecoil, 'rotStiffness', 20, 600, 5);
    vr.add(w.visualRecoil, 'rotDamping', 1, 60, 0.5);
    vr.add(w.visualRecoil, 'posStiffness', 20, 600, 5);
    vr.add(w.visualRecoil, 'posDamping', 1, 60, 0.5);
    vr.add(w.visualRecoil, 'adsMultiplier', 0, 1.5, 0.01);

    const ads = f.addFolder('ADS / sway / bob').close();
    ads.add(w.ads, 'fov', 20, 110, 0.5).name('ADS FOV (horizontal)');
    ads.add(w.ads, 'speed', 1, 30, 0.1).name('ADS speed');
    ads.add(w.ads, 'swayMultiplier', 0, 1.5, 0.01);
    ads.add(w.ads, 'bobMultiplier', 0, 1.5, 0.01);
    ads.add(w.ads, 'sightDistance', 0.05, 0.6, 0.005).onChange(tuned);
    ads.add(w.sway, 'amount', 0, 4, 0.05).name('Weapon sway');
    ads.add(w.sway, 'max', 0, 15, 0.1).name('Sway max (deg)');
    ads.add(w.sway, 'stiffness', 10, 400, 1).name('Sway stiffness');
    ads.add(w.sway, 'damping', 1, 40, 0.5).name('Sway damping');
    ads.add(w.bob, 'amount', 0, 4, 0.05).name('Weapon bob');
    ads.add(w.bob, 'sprintAmount', 0, 5, 0.05).name('Sprint bob');
    ads.add(w.viewmodel, 'fov', 30, 90, 0.5).name('Viewmodel FOV');
    const hip = { x: w.viewmodel.hipPosition[0], y: w.viewmodel.hipPosition[1], z: w.viewmodel.hipPosition[2] };
    const setHip = () => {
      w.viewmodel.hipPosition = [hip.x, hip.y, hip.z];
      tuned();
    };
    ads.add(hip, 'x', -0.4, 0.4, 0.001).name('Hip pos X').onChange(setHip);
    ads.add(hip, 'y', -0.4, 0.2, 0.001).name('Hip pos Y').onChange(setHip);
    ads.add(hip, 'z', -0.8, 0, 0.001).name('Hip pos Z').onChange(setHip);

    const fx = f.addFolder('FX').close();
    fx.add(w.fx, 'tracerEvery', 0, 10, 1);
    fx.add(w.fx, 'muzzleFlashScale', 0, 3, 0.05);
    fx.add(w.fx, 'smoke', 0, 2, 0.05);
    fx.add(w.fx, 'shellEjectSpeed', 0, 8, 0.1);
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
      this.status.message = 'Clipboard blocked – JSON logged to console';
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
