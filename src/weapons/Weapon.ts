import type { WeaponData } from './WeaponData';

export type WeaponState = 'holstered' | 'equipping' | 'ready' | 'reloading' | 'holstering';
export type ShellPhase = 'start' | 'insert' | 'end';
type AudioKey = keyof WeaponData['audio'];

/** What the controller needs to react to. Keeps Weapon free of rendering/audio code. */
export interface WeaponListener {
  onShot(weapon: Weapon): void;
  onDryFire(weapon: Weapon): void;
  onSound(weapon: Weapon, key: AudioKey): void;
}

export interface WeaponInput {
  fireHeld: boolean;
  firePressed: boolean;
  reloadPressed: boolean;
  sprinting: boolean;
}

interface TimelineEvent {
  t: number;
  sound?: AudioKey;
  commit?: boolean;
}

/**
 * Magazine reload timelines (normalized time). The viewmodel animation reads the
 * same timings, so the magazine visually leaves/enters exactly when the sound plays
 * and ammo is committed.
 */
export const RELOAD_TIMELINES: Record<'rifle' | 'pistol', { tactical: TimelineEvent[]; empty: TimelineEvent[] }> = {
  rifle: {
    tactical: [
      { t: 0.0, sound: 'reloadStart' },
      { t: 0.22, sound: 'magOut' },
      { t: 0.6, sound: 'magIn', commit: true },
    ],
    empty: [
      { t: 0.0, sound: 'reloadStart' },
      { t: 0.17, sound: 'magOut' },
      { t: 0.48, sound: 'magIn', commit: true },
      { t: 0.7, sound: 'boltBack' },
      { t: 0.78, sound: 'boltForward' },
    ],
  },
  pistol: {
    tactical: [
      { t: 0.0, sound: 'reloadStart' },
      { t: 0.2, sound: 'magOut' },
      { t: 0.6, sound: 'magIn', commit: true },
    ],
    empty: [
      { t: 0.0, sound: 'reloadStart' },
      { t: 0.16, sound: 'magOut' },
      { t: 0.5, sound: 'magIn', commit: true },
      { t: 0.74, sound: 'boltForward' },
    ],
  },
};

const SEMI_BUFFER = 0.14;
const AUTO_RELOAD_DELAY = 0.32;
const PUMP_SOUND_DELAY = 0.24;

/**
 * Weapon logic: state machine, ammo, fire timing, spread bloom, reload rules.
 * Shared by every gun; behaviour differences come from WeaponData.
 *
 * Interruption rules:
 *  - Can't fire unless state is 'ready' (equip/holster/reload block firing).
 *  - Magazine reload: switching weapons cancels it; ammo only refills once the
 *    magazine is inserted (commit point). Fire input is ignored mid-reload.
 *  - Shell reload: each inserted shell counts immediately. Pressing fire with
 *    ammo > 0 stops after the current shell and returns to ready quickly.
 *  - Sprinting doesn't cancel reloads, but blocks firing until sprintToFireTime
 *    has passed after the sprint ends.
 */
export class Weapon {
  ammo: number;
  state: WeaponState = 'holstered';
  stateTime = 0;

  /** Seconds until the next shot is allowed (can go negative to preserve cadence). */
  cooldown = 0;
  /** Consecutive shots in the current string of fire (0 = first shot). */
  shotIndex = 0;
  timeSinceShot = 99;
  /** Current spread bloom in degrees. */
  bloom = 0;
  /** Lowest-level counter, for tracers etc. */
  totalShots = 0;

  reloadEmpty = false;
  reloadDuration = 0;
  shellPhase: ShellPhase = 'start';
  shellPhaseTime = 0;
  /** Time since last pump started (shotgun), for animation. */
  pumpTime = 99;

  private semiBuffer = 0;
  private sprintRecover = 0;
  private eventIndex = 0;
  private autoReloadTimer = -1;
  private pumpSoundPending = false;
  private stopShellReload = false;
  private chamberPumpPlayed = false;

  constructor(
    public readonly data: WeaponData,
    private listener: WeaponListener,
  ) {
    this.ammo = data.magazineSize;
  }

  get fireInterval(): number {
    return 60 / Math.max(1, this.data.fireRate);
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** 0..1 progress through the current timed state. */
  get stateProgress(): number {
    switch (this.state) {
      case 'equipping':
        return Math.min(1, this.stateTime / Math.max(0.01, this.data.equipTime));
      case 'holstering':
        return Math.min(1, this.stateTime / Math.max(0.01, this.data.holsterTime));
      case 'reloading':
        return this.data.reload.kind === 'magazine' ? Math.min(1, this.stateTime / this.reloadDuration) : 0;
      default:
        return 1;
    }
  }

  get shellPhaseDuration(): number {
    const r = this.data.reload;
    if (this.shellPhase === 'start') return r.shellStart;
    if (this.shellPhase === 'insert') return r.shellInsert;
    return r.shellEnd + (this.reloadEmpty ? 0.3 : 0);
  }

  /** Pistol slide / rifle bolt locks back on an empty magazine. */
  get actionLockedBack(): boolean {
    if (this.data.model === 'shotgun') return false;
    if (this.state === 'reloading') {
      const boltForwardT = this.data.model === 'rifle' ? 0.78 : 0.74;
      return this.reloadEmpty && this.stateProgress < boltForwardT;
    }
    return this.ammo === 0 && this.timeSinceShot > 0.05;
  }

  equip(): void {
    this.state = 'equipping';
    this.stateTime = 0;
    this.sprintRecover = 0;
    this.listener.onSound(this, 'equip');
  }

  holster(): void {
    if (this.state === 'reloading') this.cancelReload();
    const wasUp = this.state === 'ready' ? 1 : this.stateProgress;
    this.state = 'holstering';
    // If we were only partly up, start partly down.
    this.stateTime = (1 - wasUp) * this.data.holsterTime;
    this.autoReloadTimer = -1;
  }

  forceHolstered(): void {
    this.state = 'holstered';
    this.stateTime = 0;
  }

  update(dt: number, input: WeaponInput): void {
    this.timeSinceShot += dt;
    this.pumpTime += dt;
    this.stateTime += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    this.bloom = Math.max(0, this.bloom - this.data.spread.bloomRecovery * dt);
    this.semiBuffer = input.firePressed ? SEMI_BUFFER : this.semiBuffer - dt;
    this.sprintRecover = input.sprinting ? this.data.sprintToFireTime : this.sprintRecover - dt;

    if (this.pumpSoundPending && this.pumpTime >= PUMP_SOUND_DELAY) {
      this.pumpSoundPending = false;
      this.listener.onSound(this, 'pump');
    }

    switch (this.state) {
      case 'equipping':
        if (this.stateTime >= this.data.equipTime) this.setState('ready');
        break;
      case 'holstering':
        if (this.stateTime >= this.data.holsterTime) this.setState('holstered');
        break;
      case 'reloading':
        if (this.data.reload.kind === 'magazine') this.updateMagReload();
        else this.updateShellReload(dt, input);
        break;
      case 'ready':
        this.updateReady(dt, input);
        break;
    }
  }

  private updateReady(dt: number, input: WeaponInput): void {
    if (this.autoReloadTimer >= 0) {
      this.autoReloadTimer -= dt;
      if (this.autoReloadTimer < 0) {
        this.startReload();
        return;
      }
    }
    if (input.reloadPressed && this.startReload()) return;

    const wantsFire = this.data.fireMode === 'auto' ? input.fireHeld : this.semiBuffer > 0;
    if (!wantsFire || this.sprintRecover > 0) return;
    // Shotgun can't fire mid-pump.
    if (this.cooldown > 0) return;

    if (this.ammo <= 0) {
      if (input.firePressed) {
        this.listener.onDryFire(this);
        this.listener.onSound(this, 'dry');
        if (this.autoReloadTimer < 0) this.autoReloadTimer = 0.12;
      }
      this.semiBuffer = 0;
      return;
    }

    // Allow multiple shots in one long frame, but never "catch up" a burst after idling.
    if (this.cooldown < -dt) this.cooldown = -dt;
    let shotsThisFrame = 0;
    while (this.cooldown <= 0 && this.ammo > 0 && shotsThisFrame < 4) {
      this.fireOnce();
      shotsThisFrame++;
      if (this.data.fireMode !== 'auto') break;
    }
  }

  private fireOnce(): void {
    const continuing = this.timeSinceShot < this.fireInterval * 1.5 + 0.06;
    this.shotIndex = continuing ? this.shotIndex + 1 : 0;
    this.timeSinceShot = 0;
    this.cooldown += this.fireInterval;
    this.semiBuffer = 0;
    this.ammo--;
    this.totalShots++;
    this.bloom = Math.min(this.data.spread.bloomMax, this.bloom + this.data.spread.bloomPerShot);
    if (this.data.fireMode === 'pump') {
      this.pumpTime = 0;
      this.pumpSoundPending = true;
    }
    this.listener.onShot(this);
    if (this.ammo === 0) this.autoReloadTimer = AUTO_RELOAD_DELAY + (this.data.fireMode === 'pump' ? 0.5 : 0);
  }

  /** Returns true if a reload actually started. */
  startReload(): boolean {
    if (this.state !== 'ready' || this.ammo >= this.data.magazineSize) return false;
    if (this.data.fireMode === 'pump' && this.pumpTime < 0.6) return false; // finish pumping first
    this.autoReloadTimer = -1;
    this.reloadEmpty = this.ammo === 0;
    this.setState('reloading');
    this.eventIndex = 0;
    this.stopShellReload = false;
    this.chamberPumpPlayed = false;
    if (this.data.reload.kind === 'magazine') {
      this.reloadDuration = this.reloadEmpty ? this.data.reload.emptyTime : this.data.reload.time;
    } else {
      this.shellPhase = 'start';
      this.shellPhaseTime = 0;
      this.listener.onSound(this, 'reloadStart');
    }
    return true;
  }

  private updateMagReload(): void {
    const timeline = RELOAD_TIMELINES[this.data.model as 'rifle' | 'pistol'];
    const events = this.reloadEmpty ? timeline.empty : timeline.tactical;
    const t = this.stateTime / this.reloadDuration;
    while (this.eventIndex < events.length && t >= events[this.eventIndex].t) {
      const e = events[this.eventIndex++];
      if (e.sound) this.listener.onSound(this, e.sound);
      if (e.commit) this.ammo = this.data.magazineSize;
    }
    if (t >= 1) {
      this.ammo = this.data.magazineSize; // safety: never leave a finished reload empty
      this.setState('ready');
    }
  }

  private updateShellReload(dt: number, input: WeaponInput): void {
    this.shellPhaseTime += dt;
    if ((input.firePressed || input.fireHeld) && this.ammo > 0) this.stopShellReload = true;

    if (this.shellPhase === 'start') {
      if (this.stopShellReload) return this.enterShellPhase('end');
      if (this.shellPhaseTime >= this.data.reload.shellStart) this.enterShellPhase('insert');
    } else if (this.shellPhase === 'insert') {
      if (this.shellPhaseTime >= this.data.reload.shellInsert) {
        this.ammo = Math.min(this.data.magazineSize, this.ammo + 1);
        this.listener.onSound(this, 'shellInsert');
        if (this.ammo >= this.data.magazineSize || this.stopShellReload) this.enterShellPhase('end');
        else this.enterShellPhase('insert');
      }
    } else {
      if (this.reloadEmpty && !this.chamberPumpPlayed && this.shellPhaseTime >= 0.12) {
        this.chamberPumpPlayed = true;
        this.listener.onSound(this, 'pump');
      }
      const endTime = this.shellPhaseDuration * (this.stopShellReload && !this.reloadEmpty ? 0.55 : 1);
      if (this.shellPhaseTime >= endTime) {
        this.setState('ready');
        // The fire press that interrupted the reload shoots as soon as the gun is up.
        if (this.stopShellReload) this.semiBuffer = SEMI_BUFFER;
      }
    }
  }

  private enterShellPhase(phase: ShellPhase): void {
    this.shellPhase = phase;
    this.shellPhaseTime = 0;
  }

  private cancelReload(): void {
    // Magazine: ammo stays as-is (committed or not). Shells: inserted shells stay.
    this.eventIndex = 0;
  }

  private setState(state: WeaponState): void {
    this.state = state;
    this.stateTime = 0;
  }

  /** Lab helper: refill instantly (debug panel). */
  refill(): void {
    this.ammo = this.data.magazineSize;
  }
}
