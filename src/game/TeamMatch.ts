import * as THREE from 'three';
import { AITeam, type TeamContext, type TeamDef } from './AITeam';
import type { Combatant, TeamAgent } from './TeamAgent';
import type { Survival } from './Survival';
import { TEAM_STARTS, type Site9 } from '../world/Site9';
import { Scoreboard, type TeamRow } from '../ui/Scoreboard';
import type { SoldierDeps } from '../enemies/Soldier';
import type { WeaponData } from '../weapons/WeaponData';
import type { AudioSystem } from '../audio/AudioSystem';
import type { StatusHUD } from '../ui/StatusHUD';
import type { HUD } from '../ui/HUD';
import type { SurvivalHUD } from '../ui/SurvivalHUD';
import type { DamageInfo } from '../targets/Humanoid';
import type { Lighting } from './Lighting';
import { GROUPS } from '../core/Physics';

export const TEAM_ROWS: TeamRow[] = [
  { id: 'alpha', name: 'VANTA', color: '#4fa8ff' },
  { id: 'bravo', name: 'BRAVO', color: '#ffa040' },
  { id: 'charlie', name: 'CHARLIE', color: '#9dff4a' },
  { id: 'delta', name: 'DELTA', color: '#d06aff' },
];
const NAME: Record<string, string> = { alpha: 'Vanta', bravo: 'Bravo', charlie: 'Charlie', delta: 'Delta', bd: 'Black Division', robots: 'Robots' };
const COLOR: Record<string, string> = { alpha: '#4fa8ff', bravo: '#ffa040', charlie: '#9dff4a', delta: '#d06aff', bd: '#ff3b2f', robots: '#bbb' };

/** Seconds of power-out per raid (the raid ends early when Black Division is wiped). */
const RAID_TIME = 150;

export interface MatchDeps {
  ui: HTMLElement;
  scene: THREE.Scene;
  map: Site9;
  survival: Survival;
  soldierDeps: SoldierDeps;
  weaponData(id: string): WeaponData | undefined;
  audio: AudioSystem;
  status: StatusHUD;
  hud: HUD;
  svHud: SurvivalHUD;
  /** The player's eye (raid landings stay out of its sight). */
  eye: THREE.Vector3;
  lighting: Lighting;
  /** Everyone on the player's team that isn't the player (hired contractors). */
  allies(): TeamAgent[];
  playerAlive(): boolean;
  playerPos: THREE.Vector3;
}

/**
 * The four-team race on Site-9: you (Vanta) and three AI teams start in
 * opposite corners, earn points on robots and each other, buy weapons, open the
 * facility and hire contractors. When a team crosses a raid threshold the power
 * dies and two Black Division squads storm in, hostile to everyone. First to the
 * win score takes the match.
 */
export class TeamMatch {
  readonly teams: AITeam[] = [];
  readonly raiders: AITeam[] = [];
  private ctx: TeamContext;
  private board: Scoreboard;
  private alive = new Map<string, number>();
  private raidTime = -1;
  private finished = false;
  /** Rounds in each AI soldier's magazine last frame (to notice shots). */
  private lastAmmo = new Map<TeamAgent, number>();
  /** When each AI soldier last fired (minimap: gunfire gives you away). */
  private lastShot = new Map<TeamAgent, number>();
  private time = 0;
  private probe = new THREE.Vector3();
  /** Called when the match ends (release the mouse etc.). */
  onEnd: (() => void) | null = null;

  constructor(private d: MatchDeps, private worldRef: () => Combatant[]) {
    this.ctx = {
      deps: d.soldierDeps,
      map: d.map,
      survival: d.survival,
      weaponData: d.weaponData,
      world: worldRef,
      robots: () => d.survival.robots,
      respawnPoint: () => this.respawnPoint(),
      onKill: (victim, info) => this.feedKill(victim.team, victim.personality.name, info),
      intel: (team) => this.intel(team),
    };
    const defs: TeamDef[] = [
      { id: 'bravo', name: 'Bravo', color: COLOR.bravo, palette: 'bravo', style: 'disciplined', start: this.startOf('bravo'), economy: true },
      { id: 'charlie', name: 'Charlie', color: COLOR.charlie, palette: 'charlie', style: 'reckless', start: this.startOf('charlie'), economy: true },
      { id: 'delta', name: 'Delta', color: COLOR.delta, palette: 'delta', style: 'balanced', start: this.startOf('delta'), economy: true },
    ];
    for (const def of defs) {
      d.survival.score.set(def.id, 0);
      this.teams.push(new AITeam(def, this.ctx));
    }
    this.board = new Scoreboard(d.ui, TEAM_ROWS);
  }

  private heardPlayer: { pos: THREE.Vector3; t: number } | null = null;

  /** The player fired (AI teams hear it). */
  playerShot(pos: THREE.Vector3): void {
    if (!this.heardPlayer) this.heardPlayer = { pos: new THREE.Vector3(), t: 0 };
    this.heardPlayer.pos.copy(pos);
    this.heardPlayer.t = this.time;
  }

  /** Where other teams' operators were heard in the last 20 s. */
  intel(team: string): { team: string; pos: THREE.Vector3 }[] {
    const out: { team: string; pos: THREE.Vector3 }[] = [];
    for (const [a, t] of this.lastShot) if (this.time - t < 20 && a.alive && a.team !== team && a.team !== 'bd') out.push({ team: a.team, pos: a.soldier.pos.clone() });
    if (team !== 'alpha' && this.heardPlayer && this.time - this.heardPlayer.t < 20) out.push({ team: 'alpha', pos: this.heardPlayer.pos.clone() });
    return out;
  }

  /** Enemy soldiers that fired in the last few seconds (minimap). */
  loud(out: { x: number; z: number }[], team: string): void {
    for (const [a, t] of this.lastShot) {
      if (this.time - t < 2.5 && a.alive && a.team !== team) out.push({ x: a.soldier.pos.x, z: a.soldier.pos.z });
    }
  }

  private startOf(team: string): THREE.Vector3 {
    const s = TEAM_STARTS[team];
    return new THREE.Vector3(s.pos[0], 0, s.pos[1]);
  }

  get raidActive(): boolean {
    return this.raidTime >= 0;
  }

  /** All AI soldiers (teams + raiders) for the combatant list, visibility, aim assist. */
  *agents(): Generator<TeamAgent> {
    for (const t of this.teams) yield* t.agents;
    for (const t of this.raiders) yield* t.agents;
  }

  pushCombatants(out: Combatant[]): void {
    for (const a of this.agents()) if (a.alive) out.push(a.self);
  }

  /** Where the director may also send robot mobs: AI team leaders. */
  foci(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const t of this.teams) {
      const l = t.leader;
      if (l) out.push(l.soldier.pos);
    }
    return out;
  }

  /** A random walkable point in an opened room, far from everyone. */
  respawnPoint(): THREE.Vector3 {
    const sv = this.d.survival;
    const nav = this.d.soldierDeps.nav;
    const rooms = this.d.map.rooms.filter((r) => sv.unlocked.has(r.zone));
    const others = this.worldRef().filter((c) => c.kind !== 'robot' && c.alive);
    let best: THREE.Vector3 | null = null;
    let bestD = -1;
    for (let i = 0; i < 24; i++) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const x = r.rect[0] + 2.5 + Math.random() * (r.rect[2] - r.rect[0] - 5);
      const z = r.rect[1] + 2.5 + Math.random() * (r.rect[3] - r.rect[1] - 5);
      if (!nav.walkable(x, z)) continue;
      let near = Infinity;
      for (const c of others) near = Math.min(near, Math.hypot(c.pos.x - x, c.pos.z - z));
      if (near > bestD) {
        bestD = near;
        best = new THREE.Vector3(x, 0, z);
      }
      if (near > 45) break;
    }
    return best ?? this.startOf('alpha');
  }

  // ---------------------------------------------------------------- raid

  startRaid(team: string): void {
    if (this.raidActive || this.finished) return;
    this.raidTime = 0;
    this.d.lighting.setRaid(true);
    this.d.audio.play('power.down');
    this.d.svHud.showBanner('POWER FAILURE', 'raid');
    this.d.status.radio(`${NAME[team] ?? team} tripped the grid. Lights out.`);
    setTimeout(() => {
      if (!this.raidActive) return;
      this.d.audio.play('raid.siren');
      const where = this.deployRaiders(team);
      this.d.svHud.showBanner('BLACK DIVISION INCOMING', 'raid');
      this.d.status.radio(`Black Division breach: ${where}. They kill everyone. Breakers restore power.`);
    }, 4500);
  }

  /** Returns where they landed (radio). */
  private deployRaiders(leader: string): string {
    // One squad lands far from everyone, one goes in on the team that tripped the
    // alarm. Never on top of anyone and never in your sight.
    const targetTeam = leader === 'alpha' ? null : this.teams.find((t) => t.def.id === leader);
    const near = targetTeam?.leader?.soldier.pos ?? this.d.playerPos;
    const points = [this.raidPoint(null), this.raidPoint(near)];
    points.forEach((at, i) => {
      if (this.raiders[i]) this.raiders[i].redeploy(at);
      else {
        const def: TeamDef = { id: 'bd', name: 'Black Division', color: COLOR.bd, palette: 'bd', style: 'hunter', start: at, economy: false };
        this.raiders.push(new AITeam(def, this.ctx, 4));
      }
    });
    const rooms = points.map((p) => this.d.map.rooms.find((r) => p.x >= r.rect[0] && p.x <= r.rect[2] && p.z >= r.rect[1] && p.z <= r.rect[3])?.name ?? 'unknown');
    return [...new Set(rooms)].join(' and ');
  }

  /**
   * Raid landing zone: an opened room at least 40 m from you and your squad,
   * 22 m from any other soldier, out of your line of sight. With `near`, prefer
   * 30-60 m from that point (going in on that team).
   */
  private raidPoint(near: THREE.Vector3 | null): THREE.Vector3 {
    const sv = this.d.survival;
    const nav = this.d.soldierDeps.nav;
    const phys = this.d.soldierDeps.physics;
    const rooms = this.d.map.rooms.filter((r) => sv.unlocked.has(r.zone));
    const people = this.worldRef().filter((c) => c.kind !== 'robot' && c.alive);
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 60; i++) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const x = r.rect[0] + 2.5 + Math.random() * (r.rect[2] - r.rect[0] - 5);
      const z = r.rect[1] + 2.5 + Math.random() * (r.rect[3] - r.rect[1] - 5);
      if (!nav.walkable(x, z)) continue;
      let ok = true;
      let nearest = Infinity;
      for (const c of people) {
        const d = Math.hypot(c.pos.x - x, c.pos.z - z);
        nearest = Math.min(nearest, d);
        if (d < (c.team === 'alpha' ? 40 : 22)) ok = false;
      }
      if (!ok) continue;
      this.probe.set(x, 1.5, z);
      if (phys.lineOfSight(this.d.eye, this.probe, GROUPS.sight)) continue;
      const score = near ? -Math.abs(Math.hypot(near.x - x, near.z - z) - 42) : nearest;
      if (score > bestScore) {
        bestScore = score;
        best = new THREE.Vector3(x, 0, z);
      }
    }
    return best ?? this.respawnPoint();
  }

  /** A breaker brought the lights back early. */
  powerRestored(): void {
    this.d.status.radio('Power restored at a breaker. Black Division is still in here.');
  }

  private endRaid(): void {
    this.raidTime = -1;
    this.d.lighting.setRaid(false);
    this.d.audio.play('lift.arrive', { volume: 0.4 });
    this.d.status.radio('Power restored.');
  }

  // ---------------------------------------------------------------- feed / end

  private feedKill(victimTeam: string, name: string, info: DamageInfo): void {
    const k = info.hit.team || 'robots';
    this.board.feedLine(`<b style="color:${COLOR[k] ?? '#ccc'}">${NAME[k] ?? k}</b> ✕ <span style="color:${COLOR[victimTeam] ?? '#ccc'}">${name}</span>`);
  }

  /** The player went down / died to someone (feed line). */
  feedPlayer(killerTeam: string): void {
    this.board.feedLine(`<b style="color:${COLOR[killerTeam] ?? '#ccc'}">${NAME[killerTeam] ?? killerTeam}</b> ✕ <span style="color:${COLOR.alpha}">YOU</span>`);
  }

  win(team: string): void {
    if (this.finished) return;
    this.finished = true;
    const row = TEAM_ROWS.find((t) => t.id === team) ?? TEAM_ROWS[0];
    this.d.audio.play(team === 'alpha' ? 'lift.arrive' : 'director.horde');
    this.board.showEnd(row, team === 'alpha', this.d.survival.score);
    this.onEnd?.();
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, world: Combatant[]): void {
    this.time += dt;
    for (const t of this.teams) t.update(dt, world);
    for (const t of this.raiders) t.update(dt, world);
    for (const a of [...this.agents(), ...this.d.allies()]) {
      const ammo = a.soldier.ammo;
      const prev = this.lastAmmo.get(a);
      if (prev !== undefined && ammo < prev) this.lastShot.set(a, this.time);
      this.lastAmmo.set(a, ammo);
    }

    // Raid clock: ends when Black Division is wiped or time runs out.
    if (this.raidActive) {
      this.raidTime += dt;
      const deployed = this.raiders.length > 0 && this.raidTime > 6;
      if (this.raidTime > RAID_TIME || (deployed && this.raiders.every((t) => t.aliveCount === 0))) this.endRaid();
    }

    // Scoreboard.
    const sv = this.d.survival;
    this.alive.set('alpha', (this.d.playerAlive() ? 1 : 0) + this.d.allies().filter((a) => a.alive).length);
    for (const t of this.teams) this.alive.set(t.def.id, t.aliveCount);
    let leader: string | null = null;
    let top = 0;
    for (const [id, s] of sv.score) {
      if (s > top) {
        top = s;
        leader = id;
      }
    }
    this.board.update(sv.score, this.alive, sv.nextRaid, leader);
  }
}
