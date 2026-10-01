/** Minimal health component. Anything that can take damage owns one. */
export class Damageable {
  health: number;

  constructor(public maxHealth: number) {
    this.health = maxHealth;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  /** Returns the damage actually dealt (never more than remaining health). */
  applyDamage(amount: number): number {
    if (!this.alive) return 0;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    return dealt;
  }

  reset(): void {
    this.health = this.maxHealth;
  }
}
