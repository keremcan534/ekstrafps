import { feel } from '../config/Feel';

/**
 * Player health. Damage comes from Black Division rounds (scaled by
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
  onDeath: (() => void) | null = null;
  onRespawn: (() => void) | null = null;

  /** Returns the damage actually taken. */
  damage(amount: number): number {
    if (this.dead || feel.godMode) return 0;
    const dealt = Math.min(this.health, amount * feel.enemyDamageScale);
    this.health -= dealt;
    this.sinceDamage = 0;
    if (this.health <= 0.001) {
      this.health = 0;
      this.dead = true;
      this.deathTimer = 3.5;
      this.onDeath?.();
    }
    return dealt;
  }

  update(dt: number): void {
    this.sinceDamage += dt;
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
