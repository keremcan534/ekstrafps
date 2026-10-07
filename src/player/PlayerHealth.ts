import { skillFx } from '../game/Skills';
import { feel } from '../config/Feel';

/**
 * Player health. Damage comes from SABLE rounds (scaled by
 * feel.enemyDamageScale). Optional slow regeneration after a quiet period keeps
 * the lab testable; death runs a short timer and then respawns.
 */
export class PlayerHealth {
  readonly max = 100;
  health = 100;
  dead = false;
  /** Seconds since the last damage. */
  sinceDamage = 99;
  private deathTimer = 0;

  /** Lab: come back after a few seconds. Survival: death is game over. */
  autoRespawn = true;
  /** Last stand: on the floor, bleeding out until revived. */
  downed = false;
  /** Seconds left before bleeding out. */
  bleed = 0;
  /** Asked when health hits zero: true = go down instead of dying (someone can revive). */
  canGoDown: (() => boolean) | null = null;
  onDowned: (() => void) | null = null;
  onRevived: (() => void) | null = null;
  onDeath: (() => void) | null = null;
  onRespawn: (() => void) | null = null;

  /** Returns the damage actually taken. */
  damage(amount: number): number {
    if (this.dead || feel.godMode) return 0;
    let scaled = amount * feel.enemyDamageScale;
    this.sinceDamage = 0;
    if (this.armor > 0 && !this.downed) {
      const soak = Math.min(this.armor, scaled * 0.6);
      this.armor -= soak;
      scaled -= soak;
    }
    if (this.downed) {
      // Hits while down shorten the bleed-out.
      this.bleed -= scaled * 0.15;
      if (this.bleed <= 0) this.kill();
      return scaled;
    }
    const dealt = Math.min(this.health, scaled);
    this.health -= dealt;
    if (this.health <= 0.001) {
      this.health = 0;
      if (this.canGoDown?.()) {
        this.downed = true;
        this.bleed = 30 * skillFx.bleedOut;
        this.onDowned?.();
      } else this.kill();
    }
    return dealt;
  }

  /** Armor plates: soak 60% of incoming damage until they're used up. */
  armor = 0;
  readonly maxArmor = 100;

  /** Seconds on the floor before an automatic respawn. */
  respawnDelay = 3.5;

  /** Bleed out now (stop waiting for a revive). */
  giveUp(): void {
    if (this.downed) this.kill();
  }

  private kill(): void {
    this.downed = false;
    this.dead = true;
    this.deathTimer = this.respawnDelay;
    this.onDeath?.();
  }

  /** A teammate got you back up. */
  revive(): void {
    if (!this.downed) return;
    this.downed = false;
    this.health = this.max * 0.5;
    this.sinceDamage = 0;
    this.onRevived?.();
  }

  update(dt: number): void {
    this.sinceDamage += dt;
    if (this.downed) {
      this.bleed -= dt;
      if (this.bleed <= 0) this.kill();
      return;
    }
    if (this.dead) {
      if (!this.autoRespawn) return;
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        this.dead = false;
        this.health = this.max;
        this.sinceDamage = 99;
        this.onRespawn?.();
      }
      return;
    }
    if (feel.playerRegen && this.sinceDamage > 6) this.health = Math.min(this.max, this.health + dt * 12);
  }
}
