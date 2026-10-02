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
  /** The player's eye and look direction (flashlight). */
  eye: THREE.Vector3;
  lookDir(out: THREE.Vector3): THREE.Vector3;
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
  private blackout = 0;
  private flicker = 0;
  private flashlight: THREE.SpotLight;
  private sky: THREE.Color;
  private skyBase: THREE.Color;
  private fogBase: THREE.Color | null;
  private envBase: number;
  private dir = new THREE.Vector3();
  private finished = false;
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

    // Flashlight: always in the scene (adding a light later would recompile every shader).
    this.flashlight = new THREE.SpotLight(0xfff1dc, 0, 32, 0.5, 0.6, 1.4);
    this.flashlight.castShadow = false;
    d.scene.add(this.flashlight, this.flashlight.target);
    this.sky = d.scene.background as THREE.Color;
    this.skyBase = this.sky.clone();
    this.fogBase = d.scene.fog ? (d.scene.fog as THREE.Fog).color.clone() : null;
    this.envBase = d.scene.environmentIntensity;
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
    this.flicker = 0;
    this.d.audio.play('power.down');
    this.d.svHud.showBanner('POWER FAILURE', 'raid');
    this.d.status.radio(`${NAME[team] ?? team} tripped the grid. Lights out.`);
    setTimeout(() => {
      if (!this.raidActive) return;
      this.d.audio.play('raid.siren');
      this.d.svHud.showBanner('BLACK DIVISION INCOMING', 'raid');
      this.d.status.radio('Black Division breach. They kill everyone.');
      this.deployRaiders(team);
    }, 4500);
  }

  private deployRaiders(leader: string): void {
    // One squad lands far from everyone, one goes in on the team that tripped the alarm.
    const targetTeam = leader === 'alpha' ? null : this.teams.find((t) => t.def.id === leader);
    const near = targetTeam?.leader?.soldier.pos ?? this.d.playerPos;
    const points = [this.respawnPoint(), this.pointNear(near, 22, 40)];
    points.forEach((at, i) => {
      if (this.raiders[i]) this.raiders[i].redeploy(at);
      else {
        const def: TeamDef = { id: 'bd', name: 'Black Division', color: COLOR.bd, palette: 'bd', style: 'hunter', start: at, economy: false };
        this.raiders.push(new AITeam(def, this.ctx, 4));
      }
    });
  }

  private pointNear(p: THREE.Vector3, min: number, max: number): THREE.Vector3 {
    const nav = this.d.soldierDeps.nav;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = min + Math.random() * (max - min);
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (nav.walkable(x, z) && this.d.survival.unlocked.has(this.d.map.zoneAt(x, z) ?? '')) return new THREE.Vector3(x, 0, z);
    }
    return this.respawnPoint();
  }

  private endRaid(): void {
    this.raidTime = -1;
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
    for (const t of this.teams) t.update(dt, world);
    for (const t of this.raiders) t.update(dt, world);

    // Raid clock: ends when Black Division is wiped or time runs out.
    if (this.raidActive) {
      this.raidTime += dt;
      const deployed = this.raiders.length > 0 && this.raidTime > 6;
      if (this.raidTime > RAID_TIME || (deployed && this.raiders.every((t) => t.aliveCount === 0))) this.endRaid();
    }
    this.updateLights(dt);

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

  /** Blackout: flickering power-down, dark facility, red emergency strips, your flashlight. */
  private updateLights(dt: number): void {
    const target = this.raidActive ? 1 : 0;
    let k: number;
    if (target > this.blackout) {
      // Power-down: a few hard flickers, then out.
      this.flicker += dt;
      const f = this.flicker;
      const flick = f < 1.6 ? (Math.sin(f * 37) > 0.2 ? 0.15 : 0.9) : 1;
      this.blackout = Math.min(1, this.blackout + dt * 0.55);
      k = Math.max(this.blackout, f < 1.6 ? flick * Math.min(1, f) : this.blackout);
    } else {
      this.blackout = Math.max(0, this.blackout - dt * 0.35);
      k = this.blackout;
    }
    this.d.map.setBlackout(k);
    this.sky.copy(this.skyBase).multiplyScalar(1 - 0.92 * k);
    // Image-based ambient is most of the indoor fill: it has to go dark too.
    this.d.scene.environmentIntensity = this.envBase * (1 - 0.9 * k);
    if (this.fogBase) (this.d.scene.fog as THREE.Fog).color.copy(this.fogBase).multiplyScalar(1 - 0.92 * k);

    const fl = this.flashlight;
    fl.intensity = this.d.playerAlive() ? 8 * Math.min(1, k * 1.4) : 0;
    if (fl.intensity > 0) {
      const dir = this.d.lookDir(this.dir);
      fl.position.copy(this.d.eye).addScaledVector(dir, 0.3).y -= 0.12;
      fl.target.position.copy(this.d.eye).addScaledVector(dir, 10);
      fl.target.updateMatrixWorld();
    }
  }
}
