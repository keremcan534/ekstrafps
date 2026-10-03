import * as THREE from 'three';
import { JOG, type Soldier } from '../enemies/Soldier';
import type { NavGrid } from './NavGrid';
import { segmentBlocked } from '../game/Obstacles';

export type NavStatus = 'idle' | 'moving' | 'arrived' | 'failed';

/**
 * Movement with intent and with recovery. Paths (or steers, when the way is
 * clear) to one destination and watches for progress. No progress → a recovery
 * sequence instead of freezing:
 *   1. recalculate the path
 *   2. a nearby alternative point
 *   3. back away a step
 *   4. give up: status 'failed', the brain picks a different tactic
 * A bot is never left standing because one path failed.
 */
export class Navigator {
  readonly dest = new THREE.Vector3();
  hasDest = false;
  status: NavStatus = 'idle';
  speed = JOG;
  arrive = 0.8;
  /** Recovery steps taken (debug). */
  recoveries = 0;
  /** Last destination that failed and when (the brain avoids it for a while). */
  readonly lastFail = new THREE.Vector3();
  lastFailTime = -1e9;
  private best = Infinity;
  private stall = 0;
  private stage = 0;
  private stageFrom = Infinity;
  private repath = 0;
  private pathFails = 0;
  private recover: THREE.Vector3 | null = null;
  private tmp = new THREE.Vector3();

  constructor(private soldier: Soldier, private nav: NavGrid) {}

  /** Head for `p`; re-issuing the same destination keeps the current path. */
  go(p: THREE.Vector3, speed: number, arrive = 0.8): void {
    this.speed = speed;
    this.arrive = arrive;
    this.soldier.moveSpeed = speed;
    if (this.hasDest && this.status === 'moving' && Math.hypot(this.dest.x - p.x, this.dest.z - p.z) < 0.6) return;
    this.dest.set(p.x, 0, p.z);
    this.hasDest = true;
    this.status = 'moving';
    this.best = Infinity;
    this.stall = 0;
    this.stage = 0;
    this.stageFrom = Infinity;
    this.repath = 0;
    this.pathFails = 0;
    this.recover = null;
  }

  stop(): void {
    this.hasDest = false;
    this.recover = null;
    if (this.status === 'moving') this.status = 'idle';
    this.soldier.stop();
  }

  /** Straight-line distance left (0 when idle). */
  get remaining(): number {
    if (!this.hasDest) return 0;
    return Math.hypot(this.dest.x - this.soldier.pos.x, this.dest.z - this.soldier.pos.z);
  }

  /** Was `p` the destination of a failure in the last `window` seconds? */
  failedNear(p: THREE.Vector3, now: number, window = 8, r = 2.5): boolean {
    return now - this.lastFailTime < window && this.lastFail.distanceToSquared(p) < r * r;
  }

  update(dt: number, now: number): void {
    if (!this.hasDest) return;
    const s = this.soldier;
    const target = this.recover ?? this.dest;
    const d = Math.hypot(target.x - s.pos.x, target.z - s.pos.z);
    if (!this.recover && d <= this.arrive) {
      this.status = 'arrived';
      this.hasDest = false;
      s.stop();
      return;
    }
    if (this.recover && d < 0.6) {
      // Recovery waypoint reached: back to the real destination.
      this.recover = null;
      this.repath = 0;
      this.best = Infinity;
      return;
    }

    // Plan: steer when the line is clear, otherwise path (rate limited).
    this.repath -= dt;
    if (this.repath <= 0) {
      if (d < 10 && this.nav.clearLine(s.pos.x, s.pos.z, target.x, target.z) && !segmentBlocked(s.pos.x, s.pos.z, target.x, target.z, 0.4, s.team)) {
        s.steerTo(target, this.speed);
        this.repath = 0.45;
      } else if (s.setPath(target, this.speed)) {
        this.repath = 1.1 + Math.random() * 0.4;
        this.pathFails = 0;
      } else {
        // Unreachable (or the frame's search budget was spent): retry soon, give up after a few.
        this.repath = 0.5;
        if (++this.pathFails >= 4) return this.fail(now);
      }
    }
    s.moveSpeed = this.speed;

    // Progress watch.
    if (d < this.best - 0.25) {
      this.best = d;
      this.stall = 0;
      // Real progress since the last recovery step: the sequence starts over.
      if (this.stage > 0 && this.stageFrom - d > 1.5) this.stage = 0;
    } else this.stall += dt;
    if (this.stall > 1.4) {
      this.stall = 0;
      this.stage++;
      this.recoveries++;
      this.stageFrom = d;
      if (this.stage === 1) {
        this.repath = 0; // 1) recalculate
        this.best = d;
      } else if (this.stage === 2) {
        // 2) a nearby alternative to the destination
        const a = Math.random() * Math.PI * 2;
        const alt = this.nav.nearestWalkable(this.dest.x + Math.sin(a) * 1.8, this.dest.z + Math.cos(a) * 1.8, this.tmp, 2.5);
        if (alt) this.dest.copy(alt);
        this.repath = 0;
        this.best = Infinity;
      } else if (this.stage === 3) {
        // 3) back away a step from where we were trying to go
        const bx = s.pos.x - target.x;
        const bz = s.pos.z - target.z;
        const l = Math.hypot(bx, bz) || 1;
        const back = this.nav.nearestWalkable(s.pos.x + (bx / l) * 1.6, s.pos.z + (bz / l) * 1.6, new THREE.Vector3(), 1.5);
        if (back) {
          this.recover = back;
          s.steerTo(back, this.speed);
          this.repath = 0.6;
        }
        this.best = Infinity;
      } else this.fail(now); // 4) give up: the brain chooses something else
    }
  }

  private fail(now: number): void {
    this.status = 'failed';
    this.lastFail.copy(this.dest);
    this.lastFailTime = now;
    this.hasDest = false;
    this.recover = null;
    this.soldier.stop();
  }
}
