import * as THREE from 'three';
import { BunkerExit, HeliExit, type CameraShot, type ExtractSite } from './Extraction';
import { ExtractUI } from '../ui/ExtractUI';
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
/** Match length: when the clock runs out the exits open. */
export const MATCH_TIME = 20 * 60;
/** How long the exits stay open. */
const EXTRACT_TIME = 180;
/** Mega hordes (seconds into the match); one more when the exits open. */
const MEGA_AT = [6 * 60, 11 * 60, 16 * 60];

type Fate = 'field' | 'extracted' | 'kia';

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
  /** Camera shake from a blast at `at` (scaled by distance). */
  shake?(at: THREE.Vector3): void;
  lighting: Lighting;
  /** Everyone on the player's team that isn't the player (hired contractors). */
  allies(): TeamAgent[];
  playerAlive(): boolean;
  playerPos: THREE.Vector3;
  mobile: boolean;
  /** Id of the weapon in your hands (your stand-in carries it in the exit cinematic). */
  playerWeapon(): string;
  /** Take over / release the camera for a cinematic. */
  cinematic(fn: ((dt: number) => CameraShot) | null): void;
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
  private lastSting = -99;
  private probe = new THREE.Vector3();
  /** Called when the match ends (release the mouse etc.). */
  onEnd: (() => void) | null = null;
  /** Extraction phase: the exits are open. */
  extracting = false;
  private extractLeft = 0;
  readonly exits: { pos: THREE.Vector3; name: string }[] = [];
  /** The two exits (helicopter LZ, evac bunker) once extraction opens. */
  private sites: ExtractSite[] = [];
  private exUI: ExtractUI | null = null;
  /** Seconds left of your 5-second countdown in an exit zone. */
  private countLeft = 5;
  private lastBeat = 6;
  private inCinematic = false;
  private exitFx: THREE.Object3D[] = [];
  private fate = new Map<string, Fate>();
  private megaIdx = 0;
  private heatTimer = 0;
  private rushTimer = 330 + Math.random() * 60;
  private rushing: { team: AITeam; warned: boolean } | null = null;

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
      heat: () => this.heat,
      onBossDown: (info) => {
        const t = info.hit.team;
        this.d.svHud.showBanner('COMMANDER DOWN', 'clear');
        this.d.status.radio(`The Warden is down${t ? ` (${NAME[t] ?? t})` : ''}. +1000 to whoever dropped him.`);
        if (t && t !== 'bd' && t !== 'robots') this.d.survival.award(t, 1000, info.hit.owner);
      },
      onRaiderSpotsPlayer: () => {
        // The sting: once per encounter, not every time someone re-acquires you.
        if (this.time - this.lastSting < 25) return;
        this.lastSting = this.time;
        this.d.audio.play('bd.encounter');
      },
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
    setTimeout(() => d.status.radio(`${MATCH_TIME / 60} minutes on the clock. When it runs out the exits open: extract to keep your score, die and lose half.`), 4000);
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

  /** 0 at the start, 1 when the clock runs out: AI gets sharper, deaths cost more. */
  get heat(): number {
    return Math.min(1, this.time / MATCH_TIME);
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
    // The grid goes and takes the robots with it: they short out until the raid is under way.
    this.d.survival.shortCircuit(26);
    this.d.svHud.showBanner('POWER FAILURE', 'raid');
    this.d.status.radio(`${NAME[team] ?? team} tripped the grid. Lights out.`);
    setTimeout(() => {
      if (!this.raidActive) return;
      this.d.audio.play('alarm.short');
      setTimeout(() => this.d.audio.play('announce.intruders'), 1700);
      this.d.audio.play('bd.arrival');
      const where = this.deployRaiders(team);
      this.raiderChatter = 1.5;
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
      // They blow their way in: breaching charge where each squad lands.
      const blast = at.clone().setY(1);
      this.d.audio.play('explosion', { position: blast });
      this.d.soldierDeps.impacts.explosion(blast);
      this.d.shake?.(blast);
      if (this.raiders[i]) this.raiders[i].redeploy(at);
      else {
        const def: TeamDef = { id: 'bd', name: 'Black Division', color: COLOR.bd, palette: 'bd', style: 'hunter', start: at, economy: false, boss: i === 0 };
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

  /** Seconds to the next Black Division radio call during a raid (<0: none scheduled). */
  private raiderChatter = -1;

  /** Black Division radio during a raid: heard across the facility. Call from update(dt). */
  private raiderRadio(dt: number): void {
    if (this.raiderChatter < 0) return;
    this.raiderChatter -= dt;
    if (this.raiderChatter > 0) return;
    const alive = this.raiders.flatMap((t) => t.agents.filter((a) => a.alive));
    if (!alive.length) {
      this.raiderChatter = -1;
      return;
    }
    const a = alive[(Math.random() * alive.length) | 0];
    const lines = ['moving', 'see_enemy', 'contact', 'flanking', 'spread_out', 'target_down'];
    const line = lines[(Math.random() * lines.length) | 0];
    this.d.audio.play(`bd.${line}`, { position: a.soldier.pos.clone().setY(1.7), pitch: 0.86 + Math.random() * 0.06, volume: 1.4 });
    this.raiderChatter = 8 + Math.random() * 6;
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

  win(team: string, tags?: Map<string, string>, sub = ''): void {
    if (this.finished) return;
    this.finished = true;
    const row = TEAM_ROWS.find((t) => t.id === team) ?? TEAM_ROWS[0];
    this.d.audio.play(team === 'alpha' ? 'lift.arrive' : 'director.horde');
    this.board.showEnd(row, team === 'alpha', this.d.survival.score, tags, sub);
    this.onEnd?.();
  }

  // ---------------------------------------------------------------- escalation

  /** You died: it costs, and once the exits are open it's final. */
  playerDied(): void {
    const sv = this.d.survival;
    sv.penalize('alpha', sv.deathPenalty);
    if (this.extracting && this.fate.get('alpha') === 'field') {
      this.fate.set('alpha', 'kia');
      this.resolve();
    }
  }

  /** SAIN-style push: a full squad suddenly storms your position. */
  private tryRush(): void {
    if (!this.d.playerAlive() || this.extracting) return;
    const p = this.d.playerPos;
    const sv = this.d.survival;
    const map = this.d.map;
    const zone = map.zoneAt(p.x, p.z);
    // Only squads that can actually walk to you.
    const cands = this.teams.filter((t) => {
      const L = t.leader;
      return t.aliveCount >= 3 && !t.rushing && L && L.distTo(p) < 140 && sv.reachable(map.zoneAt(L.soldier.pos.x, L.soldier.pos.z)).has(zone ?? '');
    });
    if (!cands.length) return;
    // The closest squad that isn't already on top of you.
    cands.sort((a, b) => a.leader!.distTo(p) - b.leader!.distTo(p));
    const team = cands.find((t) => t.leader!.distTo(p) > 25) ?? cands[0];
    if (team.rush(() => (this.d.playerAlive() ? this.d.playerPos : null))) this.rushing = { team, warned: Math.random() < 0.4 };
  }

  // ---------------------------------------------------------------- extraction

  private startExtraction(): void {
    const sv = this.d.survival;
    this.extracting = true;
    this.extractLeft = EXTRACT_TIME;
    for (const id of ['alpha', ...this.teams.map((t) => t.def.id)]) this.fate.set(id, 'field');
    // Lockdown lifted: every shutter rolls up so every team can reach an exit.
    for (const door of sv.doors) if (!door.open) sv.openDoor(door, false);
    const sd = this.d.soldierDeps;
    const ed = {
      scene: this.d.scene, map: this.d.map, nav: sd.nav, physics: sd.physics, soldierDeps: sd, audio: this.d.audio, impacts: sd.impacts,
      weaponData: this.d.weaponData, allies: this.d.allies, playerPos: this.d.playerPos, playerWeapon: this.d.playerWeapon,
    };
    this.sites = [new HeliExit(ed), new BunkerExit(ed)];
    this.exits.length = 0;
    for (const site of this.sites) this.exits.push({ pos: site.pos, name: site.name });
    this.exUI ??= new ExtractUI(this.d.ui);
    this.countLeft = 5;
    this.d.svHud.showBanner('EXTRACTION OPEN', 'raid');
    this.d.audio.play('raid.siren');
    this.d.status.radio('Exfil is go. Helicopter inbound to the atrium LZ; the evac bunker in the hangar is opening. Get out with your score, or lose half of it.');
    sv.megaHorde(this.d.mobile ? 20 : 34);
    for (const t of this.teams) {
      const L = t.leader ?? t.agents[0];
      const exit = [...this.exits].sort((a, b) => L.distTo(a.pos) - L.distTo(b.pos))[0];
      t.extractTo(exit.pos, () => {
        this.fate.set(t.def.id, 'extracted');
        this.d.status.radio(`${NAME[t.def.id]} extracted at ${exit.name}.`);
        this.board.feedLine(`<b style="color:${COLOR[t.def.id]}">${NAME[t.def.id]}</b> EXTRACTED`);
      });
    }
  }

  /** Your fate is decided: settle everyone else and end the match. */
  private resolve(): void {
    if (this.finished) return;
    // Teams still in the field when you're out: how likely they'd have made it.
    const left = Math.max(0, this.extractLeft) / EXTRACT_TIME;
    for (const t of this.teams) {
      if (this.fate.get(t.def.id) !== 'field') continue;
      const n = t.aliveCount;
      const p = n === 0 ? 0 : Math.min(0.85, 0.3 + 0.15 * n) * (0.4 + 0.6 * left);
      this.fate.set(t.def.id, Math.random() < p ? 'extracted' : 'kia');
    }
    const sv = this.d.survival;
    const tags = new Map<string, string>();
    for (const [id, f] of this.fate) {
      if (f === 'kia') sv.score.set(id, Math.round((sv.score.get(id) ?? 0) * 0.5));
      tags.set(id, f === 'extracted' ? 'EXTRACTED' : 'KIA -50%');
    }
    let best = 'alpha';
    for (const [id, s] of sv.score) if (s > (sv.score.get(best) ?? 0)) best = id;
    const you = this.fate.get('alpha');
    this.win(best, tags, you === 'extracted' ? 'YOU EXTRACTED' : 'KILLED IN ACTION · SCORE HALVED');
  }

  private updateExtraction(dt: number): void {
    for (const site of this.sites) site.update(dt);
    if (this.inCinematic) return;
    this.extractLeft -= dt;
    for (const fx of this.exitFx) fx.rotation.y += dt * 0.6;
    for (const t of this.teams) if (this.fate.get(t.def.id) === 'field' && t.aliveCount === 0) this.fate.set(t.def.id, 'kia');
    // You: hold an exit zone for five seconds (counted down to the millisecond), then the cinematic.
    if (this.d.playerAlive() && this.fate.get('alpha') === 'field') {
      const site = this.sites.find((s) => s.inZone(this.d.playerPos));
      if (site) {
        this.countLeft -= dt;
        const whole = Math.ceil(this.countLeft);
        if (whole < this.lastBeat) {
          this.lastBeat = whole;
          this.d.audio.play('extract.beat', { volume: 0.7 + 0.3 * (1 - this.countLeft / 5) });
        }
        this.exUI?.countdown(this.countLeft, site.name);
        if (this.countLeft <= 0) {
          this.startCinematic(site);
          return;
        }
      } else {
        this.countLeft = 5;
        this.lastBeat = 6;
        this.exUI?.countdown(null);
      }
    }
    if (this.extractLeft <= 0) {
      for (const [id, f] of this.fate) if (f === 'field') this.fate.set(id, 'kia');
      this.resolve();
    }
  }

  /** Dev / testing: run the clock out now (extraction opens on the next frame). */
  forceExtraction(): void {
    if (!this.extracting) this.time = MATCH_TIME;
  }

  /** Countdown done: your squad gets out in a cutscene, then EXTRACTED. */
  private startCinematic(site: ExtractSite): void {
    this.inCinematic = true;
    this.exUI?.countdown(null);
    this.exUI?.letterbox(true);
    this.fate.set('alpha', 'extracted');
    const squad = 1 + Math.min(3, this.d.allies().filter((a) => a.alive && !a.downed).length);
    const cam = site.cinematic(() => {
      this.exUI?.whiteFlash();
      this.d.audio.play('extract.theme');
      const sv = this.d.survival;
      setTimeout(() => {
        this.exUI?.letterbox(false);
        this.exUI?.extracted(
          { site: site.name, score: sv.score.get('alpha') ?? 0, kills: (sv as unknown as { kills: number }).kills ?? 0, time: this.time, squad },
          () => this.d.cinematic(null),
        );
        this.resolve();
      }, 140);
    });
    this.d.cinematic(cam);
    this.d.status.radio(site.name === 'LZ ATRIUM' ? 'Crew chief: "Go go go! Get in!"' : 'Bunker control: "Doors closing. Move!"', 'EXFIL', true);
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, world: Combatant[]): void {
    this.raiderRadio(dt);
    if (this.finished) return;
    this.time += dt;
    const sv0 = this.d.survival;
    // Heat: sharper AI, chads, costlier deaths.
    this.heatTimer -= dt;
    if (this.heatTimer <= 0) {
      this.heatTimer = 8;
      const h = this.heat;
      for (const t of this.teams) t.escalate(h);
      for (const t of this.raiders) t.escalate(h);
      sv0.deathPenalty = Math.round(100 + 250 * h);
    }
    // Mega hordes.
    if (this.megaIdx < MEGA_AT.length && this.time >= MEGA_AT[this.megaIdx]) {
      this.megaIdx++;
      sv0.megaHorde((this.d.mobile ? 14 : 24) + this.megaIdx * (this.d.mobile ? 3 : 6));
      this.d.status.radio('Mega horde: every bay on Site-9 just opened.');
    }
    // Mid/late game: full-squad pushes on you.
    if (this.time > MATCH_TIME * 0.28) {
      this.rushTimer -= dt * (0.6 + this.heat);
      if (this.rushTimer <= 0) {
        this.rushTimer = 120 + Math.random() * 70;
        this.tryRush();
      }
    }
    const r = this.rushing;
    if (r) {
      const L = r.team.leader;
      if (!r.team.rushing || !L) this.rushing = null;
      else if (!r.warned && L.distTo(this.d.playerPos) < 32) {
        r.warned = true;
        this.d.status.radio('Movement: a full squad is closing on you.');
      }
    }
    // Clock.
    if (!this.extracting && this.time >= MATCH_TIME) this.startExtraction();
    if (this.extracting) {
      this.updateExtraction(dt);
      if (this.finished) return;
    }
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
    const secs = Math.max(0, Math.ceil(this.extracting ? this.extractLeft : MATCH_TIME - this.time));
    const mmss = `${(secs / 60) | 0}:${String(secs % 60).padStart(2, '0')}`;
    this.board.update(sv.score, this.alive, this.extracting ? null : sv.nextRaid, leader, this.extracting ? `EXTRACT ${mmss}` : mmss, this.extracting);
  }
}
