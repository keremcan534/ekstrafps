import type { AnimSet, FireMode, WeaponData } from './WeaponData';
import { feel } from '../config/Feel';

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
  /** Firing is physically impossible right now (sprinting, gun jammed against a wall, shoulder swap). */
  blocked: boolean;
}

interface TimelineEvent {
  t: number;
  sound?: AudioKey;
  /** Magazine seated: refill the magazine. */
  commit?: boolean;
  /** Bolt/slide goes forward: chamber a round if the chamber is empty. */
  chamber?: boolean;
}

/**
 * Magazine reload timelines (normalized time). The viewmodel animation reads the
 * same timings, so the magazine visually leaves/enters exactly when the sound plays
 * and ammo is committed.
 */
export const RELOAD_TIMELINES: Record<Exclude<AnimSet, 'shotgun'>, { tactical: TimelineEvent[]; empty: TimelineEvent[] }> = {
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
      { t: 0.78, sound: 'boltForward', chamber: true },
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
      { t: 0.74, sound: 'boltForward', chamber: true },
    ],
  },
};

const SEMI_BUFFER = 0.14;
const AUTO_RELOAD_DELAY = 0.32;
const PUMP_SOUND_DELAY = 0.24;
const PUMP_CHAMBER_TIME = 0.42;

/**
 * Weapon mechanism: state machine, magazine + chamber, fire modes, fire timing,
 * reload rules. Shared by every gun; behaviour differences come from WeaponData.
 *
 * Ammo model:
 *  - closed bolt: `chambered` round + `ammo` in the magazine (tactical reload = mag + 1)
 *  - open bolt (PPSh): fires straight from the magazine
 *  - pump: firing empties the chamber; the pump stroke chambers from the tube
 *
 * Interruption rules:
 *  - Can't fire unless 'ready' and not blocked (sprint, wall, shoulder swap).
 *  - Magazine reload: switching weapons cancels it; the magazine only refills at
 *    the commit point, the chamber only loads when the bolt goes forward.
 *  - Shell reload: each shell counts immediately; fire stops it after the current
 *    shell and shoots as soon as the gun is up.
 *
 * Architecture hooks for later: malfunctions (`malfunction`), magazine checks,
 * attachments (laser exists; flashlight/suppressor/bipod plug in at the controller).
 */
export class Weapon {
  /** Rounds in the magazine (or shotgun tube). */
  ammo: number;
  /** Closed-bolt guns: a round sits in the chamber. */
  chambered: boolean;
  state: WeaponState = 'holstered';
  stateTime = 0;
  fireModeIndex = 0;
  /** Hook: malfunction type (none implemented yet). */
  malfunction: 'none' | 'misfire' | 'jam' = 'none';
  /** Equip/holster speed multiplier from ergonomics (set by the controller). */
  raiseScale = 1;

  /** Seconds until the next shot is allowed (can go negative to preserve cadence). */
  cooldown = 0;
  /** Consecutive shots in the current string of fire (0 = first shot). */
  shotIndex = 0;
  timeSinceShot = 99;
  totalShots = 0;

  reloadEmpty = false;
  reloadDuration = 0;
  shellPhase: ShellPhase = 'start';
  shellPhaseTime = 0;
  /** Time since last pump started (shotgun), for animation. */
  pumpTime = 99;

  private semiBuffer = 0;
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
    this.chambered = data.closedBolt;
  }

  get fireMode(): FireMode {
    return this.data.fireModes[this.fireModeIndex % this.data.fireModes.length];
  }

  get fireInterval(): number {
    return 60 / Math.max(1, this.data.fireRate);
  }

  /** Total rounds that can be fired without reloading. */
  get roundsAvailable(): number {
    return this.ammo + (this.chambered ? 1 : 0);
  }

  get equipDuration(): number {
    return this.data.equipTime * this.raiseScale;
  }

  get holsterDuration(): number {
    return this.data.holsterTime * this.raiseScale;
  }

  /** 0..1 progress through the current timed state. */
  get stateProgress(): number {
    switch (this.state) {
      case 'equipping':
        return Math.min(1, this.stateTime / Math.max(0.01, this.equipDuration));
      case 'holstering':
        return Math.min(1, this.stateTime / Math.max(0.01, this.holsterDuration));
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

  /** Pistol slide locks back on an empty gun. */
  get actionLockedBack(): boolean {
    if (this.data.animSet !== 'pistol') return false;
    if (this.state === 'reloading') return this.reloadEmpty && this.stateProgress < 0.74;
    return !this.chambered && this.timeSinceShot > 0.05;
  }

  private get canFireRound(): boolean {
    return this.data.closedBolt ? this.chambered : this.ammo > 0;
  }

  cycleFireMode(): FireMode {
    this.fireModeIndex = (this.fireModeIndex + 1) % this.data.fireModes.length;
    return this.fireMode;
  }

  equip(): void {
    this.state = 'equipping';
    this.stateTime = 0;
    this.listener.onSound(this, 'equip');
  }

  holster(): void {
    const wasUp = this.state === 'ready' ? 1 : this.stateProgress;
    this.eventIndex = 0;
    this.state = 'holstering';
    // If we were only partly up, start partly down.
    this.stateTime = (1 - wasUp) * this.holsterDuration;
    this.autoReloadTimer = -1;
  }

  update(dt: number, input: WeaponInput): void {
    this.timeSinceShot += dt;
    this.pumpTime += dt;
    this.stateTime += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    this.semiBuffer = input.firePressed ? SEMI_BUFFER : this.semiBuffer - dt;

    if (this.pumpSoundPending && this.pumpTime >= PUMP_SOUND_DELAY) {
      this.pumpSoundPending = false;
      this.listener.onSound(this, 'pump');
    }
    // The pump stroke chambers the next shell.
    if (this.fireMode === 'pump' && !this.chambered && this.pumpTime >= PUMP_CHAMBER_TIME && this.pumpTime < 1 && this.ammo > 0) {
      this.ammo--;
      this.chambered = true;
    }

    switch (this.state) {
      case 'equipping':
        if (this.stateTime >= this.equipDuration) this.setState('ready');
        break;
      case 'holstering':
        if (this.stateTime >= this.holsterDuration) this.setState('holstered');
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

    const mode = this.fireMode;
    const wantsFire = mode === 'auto' ? input.fireHeld : this.semiBuffer > 0;
    if (!wantsFire || input.blocked || this.cooldown > 0) return;

    if (!this.canFireRound) {
      if (input.firePressed) {
        this.listener.onDryFire(this);
        this.listener.onSound(this, 'dry');
        if (this.ammo > 0 && this.data.closedBolt && mode !== 'pump') {
          // Rounds in the mag but nothing chambered: rack it (immediate action).
          this.ammo--;
          this.chambered = true;
          this.listener.onSound(this, 'boltForward');
        } else if (this.autoReloadTimer < 0) {
          this.autoReloadTimer = 0.12;
        }
      }
      this.semiBuffer = 0;
      return;
    }

    // Allow multiple shots in one long frame, but never "catch up" a burst after idling.
    if (this.cooldown < -dt) this.cooldown = -dt;
    let shotsThisFrame = 0;
    while (this.cooldown <= 0 && this.canFireRound && shotsThisFrame < 4) {
      this.fireOnce();
      shotsThisFrame++;
      if (mode !== 'auto') break;
    }
  }

  private fireOnce(): void {
    const continuing = this.timeSinceShot < this.fireInterval * 1.5 + 0.06;
    this.shotIndex = continuing ? this.shotIndex + 1 : 0;
    this.timeSinceShot = 0;
    this.cooldown += this.fireInterval;
    this.semiBuffer = 0;
    this.totalShots++;

    if (!this.data.closedBolt) {
      this.ammo--;
    } else {
      this.chambered = false;
      if (this.fireMode !== 'pump' && this.ammo > 0) {
        this.ammo--;
        this.chambered = true;
      }
    }
    if (feel.infiniteAmmo) this.ammo = this.data.magazineSize;

    if (this.fireMode === 'pump') {
      this.pumpTime = 0;
      this.pumpSoundPending = true;
    }
    this.listener.onShot(this);
    if (this.roundsAvailable === 0) this.autoReloadTimer = AUTO_RELOAD_DELAY + (this.fireMode === 'pump' ? 0.5 : 0);
  }

  /** Returns true if a reload actually started. */
  startReload(): boolean {
    if (this.state !== 'ready' || this.ammo >= this.data.magazineSize) return false;
    if (this.fireMode === 'pump' && this.pumpTime < 0.6) return false; // finish pumping first
    this.autoReloadTimer = -1;
    this.reloadEmpty = this.data.closedBolt ? !this.chambered : this.ammo === 0;
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
    const timeline = RELOAD_TIMELINES[this.data.animSet === 'pistol' ? 'pistol' : 'rifle'];
    const events = this.reloadEmpty ? timeline.empty : timeline.tactical;
    const t = this.stateTime / this.reloadDuration;
    while (this.eventIndex < events.length && t >= events[this.eventIndex].t) {
      const e = events[this.eventIndex++];
      if (e.sound) this.listener.onSound(this, e.sound);
      if (e.commit) this.ammo = this.data.magazineSize;
      if (e.chamber) this.chamberFromMagazine();
    }
    if (t >= 1) {
      this.chamberFromMagazine();
      this.setState('ready');
    }
  }

  private chamberFromMagazine(): void {
    if (this.data.closedBolt && !this.chambered && this.ammo > 0) {
      this.ammo--;
      this.chambered = true;
    }
  }

  private updateShellReload(dt: number, input: WeaponInput): void {
    this.shellPhaseTime += dt;
    if ((input.firePressed || input.fireHeld) && this.roundsAvailable > 0) this.stopShellReload = true;

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
        this.chamberFromMagazine();
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

  private setState(state: WeaponState): void {
    this.state = state;
    this.stateTime = 0;
  }

  /** Lab helper: refill instantly. */
  refill(): void {
    this.ammo = this.data.magazineSize;
    if (this.data.closedBolt) this.chambered = true;
  }
}
