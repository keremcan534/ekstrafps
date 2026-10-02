import * as THREE from 'three';
import { GROUPS } from '../core/Physics';
import { JOG, RUN, WALK, Soldier, type PlayerTarget, type SoldierDeps } from './Soldier';
import type { RogueRobot, MeleeTarget } from './RogueRobot';

/**
 * Hired Vanta Security operator: a Soldier on the player's team (blue kit,
 * friendly-fire safe). Follows the player in a loose formation, engages the
 * nearest rogue robot it can see, reloads when things are quiet. Robots go for
 * allies too, so they soak attention (and can die).
 */
export class Ally {
  readonly soldier: Soldier;
  readonly melee: MeleeTarget;
  private target: RogueRobot | null = null;
  private tgt: PlayerTarget = {
    feet: new THREE.Vector3(), head: new THREE.Vector3(), chest: new THREE.Vector3(), velocity: new THREE.Vector3(),
    sprinting: false, crouching: false, alive: false,
  };
  /** Set by the game: go and pick the player up. */
  reviving = false;
  /** Seconds spent reviving (4 s to get them up). */
  reviveTime = 0;
  private scanTimer = 0;
  private repath = 0;
  private slot = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(private deps: SoldierDeps, readonly index: number) {
    this.soldier = new Soldier(deps, 10 + index, {
      onSpotted: () => {},
      onDamaged: () => {},
      onKilled: () => deps.audio.play('bd.man_down', { pitch: 1.12 }),
      say: () => {},
      onThud: (at, s) => deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * s }),
    }, 'ally');
    this.soldier.body.friendly = true;
    const soldier = this.soldier;
    this.melee = {
      pos: soldier.pos,
      get alive() {
        return soldier.alive;
      },
      hit: (d, from) => soldier.body.meleeHit(d, from),
    };
  }

  get alive(): boolean {
    return this.soldier.alive;
  }

  spawn(at: THREE.Vector3, yaw: number): void {
    this.soldier.spawn(at, yaw);
    this.soldier.state = 'combat';
  }

  /** Returns true the frame the revive completes. */
  update(dt: number, player: { feet: THREE.Vector3; yaw: number }, robots: RogueRobot[], mates: Soldier[]): boolean {
    const s = this.soldier;
    if (!s.alive) {
      this.reviving = false;
      s.update(dt, this.tgt, mates, null, 'low', false);
      return false;
    }
    if (this.reviving) {
      // Run to the player, kneel, hands on them for 4 s (no shooting while doing it).
      const d = Math.hypot(player.feet.x - s.pos.x, player.feet.z - s.pos.z);
      this.repath -= dt;
      if (d > 1.3) {
        this.reviveTime = 0;
        s.crouchTarget = 0;
        if (this.repath <= 0 || s.pathDone) {
          if (this.deps.nav.clearLine(s.pos.x, s.pos.z, player.feet.x, player.feet.z)) s.steerTo(player.feet, RUN);
          else s.setPath(player.feet, RUN);
          this.repath = 0.6;
        }
        s.update(dt, this.tgt, mates, null, 'ready', false);
        return false;
      }
      s.stop();
      s.crouchTarget = 1;
      this.reviveTime += dt;
      this.aim.copy(player.feet).y += 0.3;
      s.update(dt, this.tgt, mates, this.aim, 'low', false);
      if (this.reviveTime >= 4) {
        this.reviving = false;
        this.reviveTime = 0;
        s.crouchTarget = 0;
        return true;
      }
      return false;
    }
    // Target: the nearest awake robot it can actually see.
    this.scanTimer -= dt;
    if (this.scanTimer <= 0 || (this.target && !this.target.alive)) {
      this.scanTimer = 0.25;
      this.eye.copy(s.headPos).y += 0.1;
      let best: RogueRobot | null = null;
      let bd = 35 * 35;
      for (const r of robots) {
        if (!r.aggro) continue;
        const d = r.pos.distanceToSquared(s.pos);
        if (d > bd) continue;
        this.aim.copy(r.body.part('torso').worldPos).y += 0.3;
        if (!this.deps.physics.lineOfSight(this.eye, this.aim, GROUPS.sight)) continue;
        bd = d;
        best = r;
      }
      if (best && best !== this.target) {
        s.onAcquire();
        s.visibleTime = 0;
      }
      this.target = best;
    }
    const t = this.target;
    this.tgt.alive = !!t;
    if (t) {
      const torso = t.body.part('torso').worldPos;
      this.tgt.feet.copy(t.pos);
      this.tgt.chest.copy(torso).y += 0.3;
      this.tgt.head.copy(t.body.part('head').worldPos).y += 0.15;
      s.visibleTime += dt;
    }

    // Formation: behind the player, left/right by index.
    const side = this.index % 2 === 0 ? 1 : -1;
    const back = 2.4 + Math.floor(this.index / 2) * 1.6;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    this.slot.set(player.feet.x - fx * back - fz * side * 2.0, 0, player.feet.z - fz * back + fx * side * 2.0);
    if (!this.deps.nav.walkable(this.slot.x, this.slot.z)) this.slot.copy(player.feet);
    const d = Math.hypot(this.slot.x - s.pos.x, this.slot.z - s.pos.z);
    this.repath -= dt;
    if (d > 7 && (this.repath <= 0 || s.pathDone)) {
      s.setPath(this.slot, RUN);
      this.repath = 1;
    } else if (d <= 7 && d > 1.4) {
      if (this.deps.nav.clearLine(s.pos.x, s.pos.z, this.slot.x, this.slot.z)) s.steerTo(this.slot, t ? WALK : JOG);
      else if (this.repath <= 0 || s.pathDone) {
        s.setPath(this.slot, JOG);
        this.repath = 1;
      }
    } else if (d <= 1.4) s.stop();

    if (!t && s.ammo < 15) s.startReload();
    s.crouchTarget = 0;
    s.update(dt, this.tgt, mates, t ? this.tgt.chest : null, t ? 'aim' : 'ready', !!t);
    return false;
  }
}
