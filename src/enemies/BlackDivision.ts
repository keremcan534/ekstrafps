import * as THREE from 'three';
import { GROUPS } from '../core/Physics';
import { JOG, RUN, WALK, Soldier, type PlayerTarget, type Role, type SoldierDeps, type VoiceLine } from './Soldier';

type SquadState = 'patrol' | 'combat' | 'search';

const LINES: Record<VoiceLine, string> = {
  see_enemy: 'I see the enemy.',
  spread_out: 'Spread out.',
  contact: 'Contact.',
  flanking: 'Flanking.',
  moving: 'Moving.',
  reloading: 'Reloading.',
  target_down: 'Target down.',
  man_down: 'Man down.',
  lost_visual: 'Lost visual.',
  hit: 'I am hit.',
};
const ROLES: Role[] = ['anchor', 'flankL', 'flankR', 'push'];
const SPACING = 2.6;

interface PendingLine {
  at: number;
  soldier: Soldier;
  line: VoiceLine;
}

/**
 * Black Division squad: four operators that patrol in a column on the leader's
 * trail. When one of them sees you he stops and reports it ("I see the enemy."),
 * the leader orders "Spread out." and the squad splits into roles:
 *
 *   anchor  holds a long position and keeps you pinned
 *   flankL / flankR  swing ~75° around your last known position
 *   push    closes in to ~10 m
 *
 * Each picks positions that see you (low cover preferred: crouch, peek, shoot),
 * shares what it sees with the others, searches when they lose you, and goes
 * back to patrolling after a while. They also react to your gunfire.
 */
export class BlackDivision {
  readonly soldiers: Soldier[] = [];
  state: SquadState = 'patrol';
  readonly lastKnown = new THREE.Vector3();
  lastSeenAgo = 99;
  private time = 0;
  private routeIndex = 0;
  private trail: THREE.Vector3[] = [];
  private pending: PendingLine[] = [];
  private voiceCooldown = 0;
  private searchTime = 0;
  private respawnTimer = -1;
  private resumeTimer = -1;
  private aimPoint = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  /** Enemy radio subtitle (only when the speaker is within earshot). */
  onRadio: ((text: string) => void) | null = null;

  constructor(
    private deps: SoldierDeps,
    private route: THREE.Vector3[],
    private spawnIndex: number,
    private listener: () => THREE.Vector3,
    size = 4,
  ) {
    for (let i = 0; i < size; i++) {
      this.soldiers.push(
        new Soldier(deps, i, {
          onSpotted: (s) => this.engage(s, true),
          onDamaged: (s) => {
            if (this.state === 'patrol') this.engage(s, false);
            this.lastSeenAgo = Math.min(this.lastSeenAgo, 1);
            if (Math.random() < 0.35) this.say(s, 'hit', 0.25);
          },
          onKilled: (s) => {
            const mate = this.nearestAlive(s.pos);
            if (mate) this.say(mate, 'man_down', 0.7);
            if (this.state === 'patrol') {
              if (mate) this.engage(mate, false);
            }
            this.assignRoles();
            if (this.aliveCount === 0) this.respawnTimer = 15;
          },
          say: (s, line) => this.say(s, line),
          onThud: (at, st) => this.deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * st }),
        }),
      );
    }
    this.spawn();
  }

  get aliveCount(): number {
    let n = 0;
    for (const s of this.soldiers) if (s.alive) n++;
    return n;
  }

  get statusText(): string {
    return `BLACK DIVISION ${this.aliveCount}/${this.soldiers.length} · ${this.state.toUpperCase()}`;
  }

  /** (Re)spawn the whole squad in a column at the patrol start. */
  spawn(): void {
    const at = this.route[this.spawnIndex];
    const prev = this.route[(this.spawnIndex - 1 + this.route.length) % this.route.length];
    const dir = this.tmp.subVectors(at, prev).setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    this.trail = [];
    this.soldiers.forEach((s, i) => {
      const p = this.deps.nav.nearestWalkable(at.x - dir.x * SPACING * i, at.z - dir.z * SPACING * i, new THREE.Vector3(), 3) ?? at.clone();
      s.spawn(p, yaw);
      this.trail.unshift(p.clone());
    });
    this.state = 'patrol';
    this.routeIndex = this.spawnIndex;
    this.lastSeenAgo = 99;
    this.respawnTimer = -1;
    this.resumeTimer = -1;
    this.pending.length = 0;
    this.assignRoles();
  }

  /** Player gunfire: loud rifles carry ~45 m, suppressed ~14 m. */
  hearShot(pos: THREE.Vector3, suppressed: boolean): void {
    const range = suppressed ? 14 : 45;
    let nearest: Soldier | null = null;
    let best = range;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const d = s.pos.distanceTo(pos);
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    if (!nearest) return;
    const noise = 2 + best * 0.08;
    const guess = this.tmp.set(pos.x + (Math.random() - 0.5) * noise * 2, 0, pos.z + (Math.random() - 0.5) * noise * 2);
    if (this.state === 'patrol') {
      this.engage(nearest, false);
      this.lastKnown.copy(guess);
    } else if (this.lastSeenAgo > 2) {
      this.lastKnown.copy(guess);
      if (this.state === 'search') this.enterCombat();
    }
  }

  onPlayerKilled(): void {
    if (this.state === 'patrol') return;
    const s = this.nearestAlive(this.lastKnown);
    if (s) this.say(s, 'target_down', 0.8);
    this.resumeTimer = 4;
  }

  // ------------------------------------------------------------ voice

  private say(s: Soldier, line: VoiceLine, delay = 0): void {
    this.pending.push({ at: this.time + delay, soldier: s, line });
  }

  private flushVoice(): void {
    if (this.voiceCooldown > 0 || !this.pending.length) return;
    const i = this.pending.findIndex((p) => p.at <= this.time);
    if (i < 0) return;
    const { soldier, line } = this.pending.splice(i, 1)[0];
    if (!soldier.alive) return;
    const head = soldier.headPos;
    this.deps.audio.play(`bd.${line}`, { position: head, pitch: soldier.voicePitch, volume: 1.3 });
    if (head.distanceTo(this.listener()) < 60) this.onRadio?.(LINES[line]);
    this.voiceCooldown = 1.25;
  }

  // ------------------------------------------------------------ squad brain

  private nearestAlive(p: THREE.Vector3): Soldier | null {
    let best: Soldier | null = null;
    let bd = Infinity;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const d = s.pos.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  private assignRoles(): void {
    let k = 0;
    for (const s of this.soldiers) if (s.alive) s.role = ROLES[k++ % ROLES.length];
  }

  private get anchor(): Soldier | null {
    return this.soldiers.find((s) => s.alive && s.role === 'anchor') ?? this.soldiers.find((s) => s.alive) ?? null;
  }

  /** Contact: the spotter calls it, the leader spreads the squad out. */
  private engage(spotter: Soldier, spotted: boolean, player?: PlayerTarget): void {
    if (this.state !== 'patrol') return;
    if (player) this.lastKnown.copy(player.feet);
    this.lastSeenAgo = spotted ? 0 : 3;
    this.assignRoles();
    this.enterCombat();
    this.say(spotter, spotted ? 'see_enemy' : 'contact');
    const lead = this.anchor;
    if (lead) this.say(lead, 'spread_out', 1.6);
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      s.holdTimer = s === spotter ? 1.1 : 0.4 + Math.random() * 0.7;
      // Aim settles from scratch once the fight starts (spotting time does not count).
      s.visibleTime = 0;
      s.stop();
      s.onAcquire();
    }
  }

  private enterCombat(): void {
    this.state = 'combat';
    this.searchTime = 0;
    this.resumeTimer = -1;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      s.state = 'combat';
      s.hasGoal = false;
      s.decideTimer = 0;
      s.saidFlank = false;
    }
  }

  private beginSearch(): void {
    this.state = 'search';
    this.searchTime = 0;
    const a = this.anchor;
    if (a) this.say(a, 'lost_visual');
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      s.state = 'search';
      s.hasGoal = false;
      s.holdTimer = Math.random() * 1.5;
    }
  }

  private resumePatrol(): void {
    this.state = 'patrol';
    this.resumeTimer = -1;
    // Leader heads for the nearest route point; the column re-forms on its trail.
    const lead = this.soldiers.find((s) => s.alive);
    if (lead) {
      let best = 0;
      let bd = Infinity;
      this.route.forEach((p, i) => {
        const d = p.distanceToSquared(lead.pos);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      this.routeIndex = best;
      lead.setPath(this.route[best], WALK);
      this.trail = [lead.pos.clone()];
    }
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      s.state = 'patrol';
      s.awareness = 0;
      s.crouchTarget = 0;
      s.hasGoal = false;
    }
  }

  update(dt: number, player: PlayerTarget, aiEnabled: boolean): void {
    this.time += dt;
    this.voiceCooldown -= dt;
    this.flushVoice();
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.spawn();
    }
    if (this.resumeTimer > 0) {
      this.resumeTimer -= dt;
      if (this.resumeTimer <= 0) this.resumePatrol();
    }
    const target: PlayerTarget = aiEnabled ? player : { ...player, alive: false };
    // AI switched off mid-fight (lab key U): stand down and go back to patrolling.
    if (!aiEnabled && this.state !== 'patrol') this.resumePatrol();

    // Perception + shared knowledge.
    let anySees = false;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      if (s.perceive(dt, target) && this.state === 'patrol') this.engage(s, true, target);
      if (s.sees && this.state !== 'patrol') anySees = true;
    }
    if (anySees) {
      this.lastKnown.copy(player.feet);
      this.lastSeenAgo = 0;
      if (this.state === 'search') {
        this.enterCombat();
        const s = this.soldiers.find((x) => x.alive && x.sees);
        if (s) this.say(s, 'contact');
      }
    } else this.lastSeenAgo += dt;
    if (this.state === 'combat' && this.lastSeenAgo > 11 && target.alive) this.beginSearch();
    if (this.state === 'search') {
      this.searchTime += dt;
      if (this.searchTime > 40) this.resumePatrol();
    }

    switch (this.state) {
      case 'patrol':
        this.updatePatrol(dt, target);
        break;
      case 'combat':
        for (const s of this.soldiers) this.updateCombat(dt, s, target);
        break;
      case 'search':
        for (const s of this.soldiers) this.updateSearch(dt, s, target);
        break;
    }
    // Dead bodies keep simulating their ragdolls.
    for (const s of this.soldiers) if (!s.alive) s.update(dt, target, this.soldiers, null, 'low', false);
  }

  // ------------------------------------------------------------ patrol

  private updatePatrol(dt: number, player: PlayerTarget): void {
    const alive = this.soldiers.filter((s) => s.alive);
    if (!alive.length) return;
    const lead = alive[0];
    if (lead.pathDone) {
      this.routeIndex = (this.routeIndex + 1) % this.route.length;
      lead.setPath(this.route[this.routeIndex], WALK);
    }
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceToSquared(lead.pos) > 0.09) {
      this.trail.push(lead.pos.clone());
      if (this.trail.length > 400) this.trail.shift();
    }
    lead.update(dt, player, this.soldiers, null, 'low', false);
    for (let k = 1; k < alive.length; k++) {
      const s = alive[k];
      const target = this.trailPoint(k * SPACING) ?? lead.pos;
      const d = Math.hypot(target.x - s.pos.x, target.z - s.pos.z);
      s.repathTimer -= dt;
      if (d > 5 && !this.deps.nav.clearLine(s.pos.x, s.pos.z, target.x, target.z)) {
        if (s.pathDone || s.repathTimer <= 0) {
          s.setPath(target, JOG);
          s.repathTimer = 1.5;
        }
      } else if (d > 0.3) s.steerTo(target, WALK * (d > 2.5 ? 1.5 : d > 1 ? 1.1 : 0.8));
      else s.stop();
      s.update(dt, player, this.soldiers, null, 'low', false);
    }
  }

  /** Point on the leader's trail `distance` metres behind its current position. */
  private trailPoint(distance: number): THREE.Vector3 | null {
    let acc = 0;
    for (let i = this.trail.length - 1; i > 0; i--) {
      const a = this.trail[i];
      const b = this.trail[i - 1];
      const seg = a.distanceTo(b);
      if (acc + seg >= distance) return this.tmp2.copy(a).lerp(b, (distance - acc) / seg);
      acc += seg;
    }
    return this.trail[0] ?? null;
  }

  // ------------------------------------------------------------ combat

  private updateCombat(dt: number, s: Soldier, player: PlayerTarget): void {
    if (!s.alive) return;
    s.decideTimer -= dt;
    s.holdTimer -= dt;
    if (s.sees && !s.wasSeeing) s.onAcquire();
    s.wasSeeing = s.sees;
    s.noLosTime = s.sees ? 0 : s.noLosTime + dt;

    const aim = this.aimPoint;
    if (s.sees) aim.copy(s.seeChest ? player.chest : player.head);
    else aim.copy(this.lastKnown).setY(1.25);

    if (s.holdTimer > 0) {
      // Just made contact: stop, turn, bring the rifle up.
      s.crouchTarget = 0;
      s.update(dt, player, this.soldiers, aim, s.sees && s.holdTimer < 0.4 ? 'aim' : 'ready', false);
      return;
    }

    const close = player.alive && s.pos.distanceTo(player.feet) < 6 && s.sees;
    if (!close && (!s.hasGoal || s.decideTimer <= 0 || (s.noLosTime > 4 && s.pathDone))) this.pickPosition(s);
    if (close) s.stop();

    const moving = !s.pathDone;
    if (moving) s.moveSpeed = s.sees ? JOG : RUN;
    // Low cover: crouch behind it, stand up to shoot.
    if (!moving && s.goalLowCover) {
      s.peekPhase += dt;
      const up = s.peekPhase % 3.8 < 2.3;
      s.crouchTarget = up && s.reloadTimer <= 0 ? 0 : 1;
    } else s.crouchTarget = 0;

    if (s.ammo < 10 && !s.sees && s.startReload() && Math.random() < 0.5) this.say(s, 'reloading');
    const wantFire = s.sees && (!moving || s.moveSpeed <= JOG);
    const facing = s.sees || s.noLosTime < 3 || !moving;
    s.update(dt, player, this.soldiers, facing ? aim : null, s.sees ? 'aim' : 'ready', wantFire);
  }

  /** Cover-aware position around the last known player position, by role. */
  private pickPosition(s: Soldier): void {
    const T = this.lastKnown;
    const anchor = this.anchor ?? s;
    const base = Math.atan2(anchor.pos.x - T.x, anchor.pos.z - T.z);
    let bearing: number;
    let dist: number;
    switch (s.role) {
      case 'anchor':
        bearing = Math.atan2(s.pos.x - T.x, s.pos.z - T.z);
        dist = 22;
        break;
      case 'flankL':
        bearing = base + 1.3;
        dist = 16;
        break;
      case 'flankR':
        bearing = base - 1.3;
        dist = 16;
        break;
      default:
        bearing = base + (Math.random() - 0.5) * 0.8;
        dist = 10;
    }
    const physics = this.deps.physics;
    const target = this.tmp.set(T.x, 1.2, T.z);
    const eye = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    let bestLow = false;
    let bestScore = Infinity;
    for (let k = 0; k < 22; k++) {
      const b = bearing + (Math.random() - 0.5) * 1.1;
      const d = Math.max(5, dist + (Math.random() - 0.5) * 8);
      const p = this.deps.nav.nearestWalkable(T.x + Math.sin(b) * d, T.z + Math.cos(b) * d, new THREE.Vector3(), 1.5);
      if (!p) continue;
      const standLos = physics.lineOfSight(eye.set(p.x, 1.55, p.z), target, GROUPS.sight);
      const crouchLos = physics.lineOfSight(eye.set(p.x, 0.95, p.z), target, GROUPS.sight);
      const low = standLos && !crouchLos;
      const actual = Math.hypot(p.x - T.x, p.z - T.z);
      const angle = Math.abs(Math.atan2(Math.sin(b - bearing), Math.cos(b - bearing)));
      let score = Math.abs(actual - dist) * 0.5 + angle * 3 + (standLos ? 0 : 5) - (low ? 4 : 0) + p.distanceTo(s.pos) * 0.08;
      for (const m of this.soldiers) {
        if (m === s || !m.alive) continue;
        if (m.hasGoal && m.goal.distanceTo(p) < 4) score += 8;
        if (m.pos.distanceTo(p) < 3) score += 3;
      }
      if (score < bestScore) {
        bestScore = score;
        best = p;
        bestLow = low;
      }
    }
    s.decideTimer = 5 + Math.random() * 4;
    if (!best || !s.setPath(best, s.sees ? JOG : RUN)) return;
    s.goal.copy(best);
    s.hasGoal = true;
    s.goalLowCover = bestLow;
    s.noLosTime = 0;
    if ((s.role === 'flankL' || s.role === 'flankR') && !s.saidFlank) {
      s.saidFlank = true;
      this.say(s, 'flanking', 0.4 + Math.random());
    }
  }

  // ------------------------------------------------------------ search

  private updateSearch(dt: number, s: Soldier, player: PlayerTarget): void {
    if (!s.alive) return;
    s.holdTimer -= dt;
    s.crouchTarget = 0;
    if (s.pathDone && s.holdTimer <= 0) {
      const r = 3 + Math.random() * 8;
      const a = Math.random() * Math.PI * 2;
      const p = this.deps.nav.nearestWalkable(this.lastKnown.x + Math.sin(a) * r, this.lastKnown.z + Math.cos(a) * r, new THREE.Vector3(), 3);
      if (p) s.setPath(p, JOG);
      s.holdTimer = 2 + Math.random() * 2.5;
    }
    // Sweep the rifle across the area while moving between points.
    const look = this.tmp.copy(this.lastKnown).setY(1.3);
    look.x += Math.sin(this.time * 0.7 + s.index) * 6;
    look.z += Math.cos(this.time * 0.6 + s.index) * 6;
    s.update(dt, player, this.soldiers, s.pathDone ? look : null, 'ready', false);
  }
}
