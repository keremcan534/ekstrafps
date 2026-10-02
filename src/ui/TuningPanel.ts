import GUI from 'lil-gui';
import type { WeaponData } from '../weapons/WeaponData';
import { WEAPON_DEFAULTS, weaponFile } from '../weapons/WeaponData';
import { AMMO_DEFAULTS, ammoTable } from '../weapons/AmmoData';
import { playerConfig, playerConfigDefaults } from '../player/PlayerConfig';
import { feel, feelDefaults } from '../config/Feel';

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

  constructor(private hooks: TuningHooks) {
    this.gui = new GUI({ title: 'Weapon Lab tuning', width: 330 });
    this.gui.domElement.classList.add('tuning');
    this.status = { message: 'Tab / ⚙ toggles' };
    const refresh = () => this.gui.controllersRecursive().forEach((c) => c.updateDisplay());

    const actions = this.gui.addFolder('Save / reset');
    const a = {
      saveWeapon: () => this.save(weaponFile(hooks.getWeapon().id), hooks.getWeapon()),
      saveAmmo: () => this.save('ammo', ammoTable),
      savePlayer: () => this.save('player', playerConfig),
      saveFeel: () => this.save('feel', feel),
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
      refill: () => hooks.refillAmmo(),
    };
    actions.add(a, 'saveWeapon').name('💾 Save weapon to source');
    actions.add(a, 'saveAmmo').name('💾 Save ammo to source');
    actions.add(a, 'savePlayer').name('💾 Save player to source');
    actions.add(a, 'saveFeel').name('💾 Save feel to source');
    actions.add(a, 'copyWeapon').name('Copy weapon JSON');
    actions.add(a, 'resetWeapon').name('Reset weapon');
    actions.add(a, 'resetAmmo').name('Reset ammo');
    actions.add(a, 'resetPlayer').name('Reset player');
    actions.add(a, 'resetFeel').name('Reset feel');
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

    const bd = this.gui.addFolder('Black Division').close();
    bd.add(feel, 'enemyAI').name('Enemy AI (U)').listen();
    bd.add(feel, 'godMode').name('God mode (O)').listen();
    bd.add(feel, 'enemyDamageScale', 0, 2, 0.05).name('Enemy damage scale');
    bd.add(feel, 'enemyAccuracy', 0.2, 3, 0.05).name('Enemy accuracy');
    bd.add(feel, 'playerRegen').name('Player health regen');

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

  /** Rebuild the weapon + ammo folders when the equipped weapon changes. */
  syncWeapon(): void {
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

    const rc = f.addFolder('Recoil (procedural)');
    rc.add(w.recoil, 'vertical', 0, 12, 0.05).name('Muzzle climb (deg)');
    rc.add(w.recoil, 'horizontal', 0, 5, 0.05).name('Horizontal random');
    rc.add(w.recoil, 'horizontalBias', -3, 3, 0.05).name('Horizontal bias');
    rc.add(w.recoil, 'back', 0, 0.15, 0.001).name('Translation kick (m)');
    rc.add(w.recoil, 'shoulder', 30, 500, 5).name('Shoulder absorption');
    rc.add(w.recoil, 'damping', 0.2, 1.2, 0.01).name('Recoil damping');
    rc.add(w.recoil, 'cameraTransfer', 0, 1, 0.01).name('View transfer');
    rc.add(w.recoil, 'cameraKeep', 0, 1, 0.01).name('View kept (player corrects)');
    rc.add(w.recoil, 'cameraRecovery', 0, 15, 0.1).name('View recovery speed');
    rc.add(w.recoil, 'dispersion', 0, 1, 0.01).name('Recoil dispersion (deg)');
    rc.add(w.recoil, 'punch', 0, 3, 0.05).name('Camera punch (visual)');
    rc.add(w.recoil, 'roll', 0, 8, 0.1).name('Roll kick');

    const ads = f.addFolder('Aim / sights').close();
    ads.add(w.aim, 'hipConvergence', 2, 100, 0.5).name('Point-fire convergence (m)');
    ads.add(w.aim, 'zeroDistance', 10, 300, 5).name('Zero (m)  [ / ]').listen();
    ads.add(w.sight, 'adsFov', 20, 110, 0.5).name('ADS FOV (horizontal)');
    ads.add(w.sight, 'sightDistance', 0.05, 0.6, 0.005).name('Eye to sight (m)').onChange(tuned);
    const hip = { x: w.viewmodel.hipPosition[0], y: w.viewmodel.hipPosition[1], z: w.viewmodel.hipPosition[2] };
    const setHip = () => {
      w.viewmodel.hipPosition = [hip.x, hip.y, hip.z];
      tuned();
    };
    ads.add(hip, 'x', -0.4, 0.4, 0.001).name('Shoulder pos X').onChange(setHip);
    ads.add(hip, 'y', -0.4, 0.2, 0.001).name('Shoulder pos Y').onChange(setHip);
    ads.add(hip, 'z', -0.8, 0, 0.001).name('Shoulder pos Z').onChange(setHip);

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
