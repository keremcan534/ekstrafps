import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import type { NavGrid } from './NavGrid';
import type { SoldierDeps } from '../enemies/Soldier';
import type { WeaponData } from '../weapons/WeaponData';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerHealth } from '../player/PlayerHealth';
import type { StatusHUD } from '../ui/StatusHUD';
import type { HUD } from '../ui/HUD';
import { feel } from '../config/Feel';
import { TeamAgent, randomPersonality, type Combatant } from '../game/TeamAgent';
import { OBSTACLES, type Obstacle } from '../game/Obstacles';
import { SquadBrain } from './Squad';
import type { Bot, Decision } from './Bot';
import { AI_TUNING } from './Tuning';
import { aiWorld } from './World';
import { SquadVoice } from './SquadVoice';

export interface AITestDeps {
  soldierDeps: SoldierDeps;
  nav: NavGrid;
  physics: Physics;
  player: PlayerController;
  playerC: Combatant;
  health: PlayerHealth;
  weaponData(id: string): WeaponData | undefined;
  status: StatusHUD;
  hud: HUD;
  setSpectator(on: boolean): void;
  clearLab(): void;
}

interface TestTeam {
  id: string;
  squad: SquadBrain;
  agents: TeamAgent[];
}

const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);

const DESCRIPTIONS: Record<string, string> = {
  A: '1 bot vs you · open lane',
  B: '1 bot vs you · container yard',
  C: '3 bots vs you · container yard',
  D: 'you + 2 friendlies vs 3 · container yard',
  E: '3 vs 3 AI only · spectator (WASD fly, Shift fast, Space up, C down)',
  F: 'enemy disappears after contact (you teleport out of sight)',
  G: 'gunshots heard, no visual',
  H: 'bot path blocked',
  I: 'you rush forward; friendlies must keep up',
  J: 'long 3 vs 3 firefight, nobody starts with an advantage · spectator',
};

/**
 * Controlled AI scenarios on the Weapon Lab map (?aitest=A..J, add &aidebug
 * for the debug view, &mortal to take damage). Each test spawns its squads,
 * scripts what it needs (teleports, shots, a blocked path), records what the
 * bots decided, and judges behaviour — not who wins.
 */
export class AITest {
  readonly teams: TestTeam[] = [];
  private world: Combatant[] = [];
  private time = 0;
  private panel: HTMLDivElement;
  private panelTimer = 0;
  private notes: string[] = [];
  private flags: Record<string, number> = {};
  private spectating = false;
  private fly = new THREE.Vector3();
  private script: (t: number, dt: number) => void = () => {};
  private obstacle: Obstacle | null = null;
  private lastKnown = new THREE.Vector3();
  private soundAt = new THREE.Vector3();
  /** Encounter sting + radio callouts, so a firefight sounds like one. */
  private voice: SquadVoice;

  constructor(private d: AITestDeps, readonly id: string) {
    d.clearLab();
    this.voice = new SquadVoice(d.soldierDeps.audio);
    feel.godMode = !new URLSearchParams(location.search).has('mortal');
    this.panel = document.createElement('div');
    this.panel.className = 'ai-test-panel';
    document.body.appendChild(this.panel);
    this.setup(id.toUpperCase());
  }

  *bots(): Generator<Bot> {
    for (const t of this.teams) for (const a of t.agents) yield a.bot;
  }

  /** Test bots are TeamAgents (the game's resolver finds them); nothing extra. */
  resolveOwner(owner: object): Combatant | null {
    void owner;
    return null;
  }

  // ------------------------------------------------------------ setup

  private team(id: string, palette: 'bravo' | 'charlie' | 'vanta', spots: THREE.Vector3[], yaw: number, weapons: string[], friendly = false): TestTeam {
    const squad = new SquadBrain(id, friendly, this.d.nav, friendly ? () => ({ pos: this.d.player.feet, yaw: this.d.player.yaw + Math.PI, speed: this.d.player.horizontalSpeed, alive: !this.d.health.dead && !this.spectating }) : null);
    const t: TestTeam = { id, squad, agents: [] };
    spots.forEach((p, i) => {
      const a = new TeamAgent(this.d.soldierDeps, id, 30 + this.teams.length * 6 + i, randomPersonality(0.2), palette, undefined, i === 0 ? 'disciplined' : 'balanced');
      a.armory = (w) => this.d.weaponData(w);
      a.soldier.body.canGoDown = () => false;
      const at = this.d.nav.nearestWalkable(p.x, p.z, new THREE.Vector3(), 4) ?? p;
      a.spawn(at, yaw);
      a.arm(weapons[i % weapons.length]);
      a.soldier.skill = 1.15;
      a.baseSkill = 1.15;
      if (friendly) {
        a.soldier.avoid = this.d.player.feet;
        a.order = { kind: 'follow', leader: () => (this.d.health.dead ? null : { pos: this.d.player.feet, yaw: this.d.player.yaw + Math.PI, speed: this.d.player.horizontalSpeed }) };
        a.onSay = (ag, text) => this.d.status.radio(text, ag.personality.name.toUpperCase(), true);
      } else a.order = { kind: 'hold' };
      squad.add(a.bot);
      t.agents.push(a);
    });
    this.teams.push(t);
    return t;
  }

  private placePlayer(p: THREE.Vector3, yaw: number): void {
    this.d.player.teleport(p, yaw);
  }

  private spectate(at: THREE.Vector3, yaw: number, pitch: number): void {
    this.spectating = true;
    this.d.setSpectator(true);
    this.fly.copy(at);
    this.d.player.teleport(at, yaw);
    this.d.player.pitch = pitch;
  }

  private setup(id: string): void {
    const rifles = ['ak47', 'm4a1', 'mk47'];
    switch (id) {
      case 'A':
        this.placePlayer(V(0, -6), 0);
        this.team('bravo', 'bravo', [V(1, -48)], 0, ['ak47']);
        break;
      case 'B':
        this.placePlayer(V(0, -71), 0);
        this.team('bravo', 'bravo', [V(3, -112)], 0, ['ak47']);
        break;
      case 'C':
        this.placePlayer(V(0, -71), 0);
        this.team('bravo', 'bravo', [V(-8, -110), V(3, -118), V(13, -110)], 0, rifles);
        break;
      case 'D':
        this.placePlayer(V(0, -70), 0);
        this.team('alpha', 'vanta', [V(-2.5, -68.5), V(2.5, -68.5)], Math.PI, ['m4a1', 'ak47'], true);
        this.team('bravo', 'bravo', [V(-8, -110), V(4, -118), V(14, -108)], 0, rifles);
        break;
      case 'E':
        this.team('bravo', 'bravo', [V(-15, -71), V(-11, -69), V(-18, -75)], Math.PI * 0.9, rifles);
        this.team('charlie', 'charlie', [V(12, -121), V(4, -124), V(17, -116)], 0.1, rifles);
        this.spectate(new THREE.Vector3(0, 22, -82), Math.PI, -0.75);
        break;
      case 'J':
        this.team('bravo', 'bravo', [V(-17, -92), V(-18, -98), V(-15, -86)], Math.PI / 2, rifles);
        this.team('charlie', 'charlie', [V(17, -104), V(18, -98), V(15, -110)], -Math.PI / 2, rifles);
        this.spectate(new THREE.Vector3(0, 24, -98), 0, -1.1);
        break;
      case 'F': {
        this.placePlayer(V(6, -80), 0);
        const t = this.team('bravo', 'bravo', [V(0, -114)], 0, ['ak47']);
        const bot = t.agents[0].bot;
        this.script = (time) => {
          if (bot.target?.visible && bot.target.kind === 'player' && this.flags.seen === undefined) this.flags.seen = time;
          if (!this.flags.hidden && ((this.flags.seen !== undefined && time - this.flags.seen > 1.5) || time > 25)) {
            // Out of sight behind the green container (its far side from the bot).
            this.lastKnown.copy(this.d.player.feet).setY(0);
            this.placePlayer(V(-13.6, -72.5), 0);
            this.flags.hidden = time;
            this.note(`t=${time.toFixed(1)} player hidden; last known ${fmt(this.lastKnown)}`);
          }
          if (this.flags.hidden && !this.flags.searchStart && (bot.decision === 'SEARCH' || bot.decision === 'INVESTIGATE' || bot.decision === 'PUSH' || bot.decision === 'HOLD_ANGLE')) {
            this.flags.searchStart = time;
            this.note(`t=${time.toFixed(1)} bot → ${bot.decision}`);
          }
          if (this.flags.hidden && !this.flags.reached && bot.soldier.pos.distanceTo(this.lastKnown) < 7) {
            this.flags.reached = time;
            this.note(`t=${time.toFixed(1)} bot reached the last known area`);
          }
        };
        break;
      }
      case 'G': {
        this.placePlayer(V(-12, -80), 0);
        const t = this.team('bravo', 'bravo', [V(14, -112)], Math.PI * 0.2, ['ak47']);
        const bot = t.agents[0].bot;
        const start = bot.soldier.pos.clone();
        this.script = (time) => {
          // You fire from behind cover: a gunshot every ~2.5 s, no line of sight.
          if (time > 2 && time - (this.flags.shot ?? 0) > 2.5) {
            this.flags.shot = time;
            aiWorld.emit('gunshot', this.d.player.feet, 'alpha', this.d.player);
            this.d.soldierDeps.audio.play('ak.fire', { position: this.d.player.feet });
          }
          if (!this.flags.react && bot.decision === 'INVESTIGATE') {
            this.flags.react = time;
            this.note(`t=${time.toFixed(1)} bot investigating`);
          }
          const moved = bot.soldier.pos.distanceTo(start);
          if (!this.flags.moved && moved > 5) {
            this.flags.moved = time;
            this.note(`t=${time.toFixed(1)} bot moved ${moved.toFixed(1)} m toward the sound`);
          }
        };
        break;
      }
      case 'H': {
        this.placePlayer(V(-19, -70), 0);
        const t = this.team('bravo', 'bravo', [V(1, -74)], Math.PI, ['ak47']);
        const bot = t.agents[0].bot;
        // An unbreakable obstacle across the way to a sound deep in the yard.
        this.obstacle = { x: 1, z: -84, hx: 3.2, hz: 0.4, cos: 1, sin: 0, alive: true, team: 'test', damage: () => {} };
        OBSTACLES.push(this.obstacle);
        this.soundAt.set(1, 0, -100);
        this.script = (time) => {
          if (!this.flags.sound && time > 0.5) {
            this.flags.sound = time;
            bot.memory.addSound(this.soundAt, 0.7, 'test', aiWorld.time);
          }
          if (!this.flags.recover && bot.navigator.recoveries > 0) {
            this.flags.recover = time;
            this.note(`t=${time.toFixed(1)} navigator recovery started`);
          }
          if (!this.flags.past && bot.soldier.pos.z < -86) {
            this.flags.past = time;
            this.note(`t=${time.toFixed(1)} bot got past the blockage (around it)`);
          }
          this.flags.maxStill = Math.max(this.flags.maxStill ?? 0, bot.sinceMove);
        };
        break;
      }
      case 'I': {
        this.placePlayer(V(0, -4), 0);
        this.team('alpha', 'vanta', [V(-2, -1), V(2, -1)], Math.PI, ['m4a1'], true);
        const from = V(0, -4);
        const to = V(0, -50);
        this.script = (time) => {
          // You sprint 46 m down the lane in 6 s (scripted).
          if (time > 2 && time < 8) {
            const k = (time - 2) / 6;
            this.d.player.hover(new THREE.Vector3().lerpVectors(from, to, k).setY(0.05));
            this.d.player.yaw = 0;
          }
          if (time > 18 && !this.flags.checked) {
            this.flags.checked = time;
            const ds = this.teams[0].agents.map((a) => a.soldier.pos.distanceTo(this.d.player.feet));
            this.note(`t=18 friendly distances to you: ${ds.map((x) => x.toFixed(1)).join(', ')} m`);
            this.flags.maxDist = Math.max(...ds);
          }
        };
        break;
      }
      default:
        this.note(`unknown test ${id}`);
    }
    this.note(`TEST ${id}: ${DESCRIPTIONS[id] ?? ''}`);
    if (!AI_TUNING.debug && new URLSearchParams(location.search).has('aidebug')) AI_TUNING.debug = true;
  }

  private note(s: string): void {
    this.notes.push(s);
    console.log(`[aitest] ${s}`);
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.time += dt;
    if (this.spectating) this.flyCamera(dt);
    const w = this.world;
    w.length = 0;
    if (!this.spectating && !this.d.health.dead) {
      this.d.playerC.alive = true;
      this.d.playerC.downed = this.d.health.downed;
      w.push(this.d.playerC);
    }
    for (const t of this.teams) for (const a of t.agents) {
      a.refreshSelf();
      if (a.alive) w.push(a.self);
    }
    for (const t of this.teams) {
      t.squad.update(dt);
      const mates = t.agents.map((a) => a.soldier);
      for (const a of t.agents) a.update(dt, w, mates);
    }
    this.voice.update(this.time, this.bots());
    this.script(this.time, dt);
    this.panelTimer -= dt;
    if (this.panelTimer <= 0) {
      this.panelTimer = 0.5;
      this.renderPanel();
    }
  }

  /** Spectator: free flight with the movement keys. */
  private flyCamera(dt: number): void {
    const input = (this.d.player as unknown as { lastInput?: { moveX: number; moveY: number; sprintHeld: boolean; jumpHeld?: boolean; crouchHeld: boolean } }).lastInput;
    const pl = this.d.player;
    if (input) {
      const sp = input.sprintHeld ? 22 : 9;
      const fx = -Math.sin(pl.yaw) * Math.cos(pl.pitch);
      const fz = -Math.cos(pl.yaw) * Math.cos(pl.pitch);
      const fy = Math.sin(pl.pitch);
      const rx = Math.cos(pl.yaw);
      const rz = -Math.sin(pl.yaw);
      this.fly.x += (fx * input.moveY + rx * input.moveX) * sp * dt;
      this.fly.z += (fz * input.moveY + rz * input.moveX) * sp * dt;
      this.fly.y += (fy * input.moveY + (input.jumpHeld ? 1 : 0) - (input.crouchHeld ? 1 : 0)) * sp * dt;
    }
    this.fly.y = Math.max(1.5, this.fly.y);
    pl.hover(this.fly);
  }

  /** Behaviour summary (on screen + window.__aitest for automated runs). */
  summary(): Record<string, unknown> {
    const bots = [...this.bots()];
    const dec: Record<string, number> = {};
    const stats: Record<string, number> = {};
    for (const b of bots) for (const [k, v] of Object.entries(b.stats)) {
      if ((k as Decision) === k.toUpperCase()) dec[k] = (dec[k] ?? 0) + v;
      else stats[k] = (stats[k] ?? 0) + v;
    }
    return {
      test: this.id,
      time: +this.time.toFixed(1),
      alive: this.teams.map((t) => `${t.id}:${t.agents.filter((a) => a.alive).length}/${t.agents.length}`),
      decisions: dec,
      stats,
      watchdog: bots.reduce((s, b) => s + b.watchdogCount, 0),
      recoveries: bots.reduce((s, b) => s + b.navigator.recoveries, 0),
      planChanges: this.teams.map((t) => `${t.id}:${t.squad.planChanges}`),
      plans: this.teams.map((t) => `${t.id}:${t.squad.plan}`),
      flags: this.flags,
      notes: this.notes.slice(-8),
      verdict: this.verdict(),
    };
  }

  /** Did the bots behave as the test expects? */
  private verdict(): string {
    const f = this.flags;
    const bots = [...this.bots()];
    const any = (k: string) => bots.some((b) => (b.stats[k] ?? 0) > 0);
    switch (this.id.toUpperCase()) {
      case 'F':
        return f.hidden ? (f.reached ? `PASS: searched last known (${(f.reached - f.hidden).toFixed(1)} s)` : f.searchStart ? 'running: searching' : 'running') : 'waiting for contact';
      case 'G':
        return f.moved ? `PASS: investigated (moved after ${(f.moved - 2).toFixed(1)} s)` : f.react ? 'running: investigating' : 'running';
      case 'H':
        return f.past ? `PASS: recovered (longest stand ${(f.maxStill ?? 0).toFixed(1)} s)` : f.recover ? 'running: recovering' : 'running';
      case 'I':
        return f.checked ? ((f.maxDist ?? 99) < AI_TUNING.friendlyTactical + 6 ? 'PASS: squad kept up' : 'FAIL: left behind') : 'running';
      default:
        return `cover ${any('coverReached') ? '✓' : '·'} · flank ${any('flankDone') ? '✓' : any('FLANK') ? '…' : '·'} · suppress ${any('SUPPRESS') ? '✓' : '·'} · search ${any('SEARCH') ? '✓' : '·'} · retreat ${any('RETREAT') ? '✓' : '·'}`;
    }
  }

  private renderPanel(): void {
    const s = this.summary();
    (window as unknown as { __aitest: unknown }).__aitest = s;
    const dec = s.decisions as Record<string, number>;
    this.panel.innerHTML =
      `<b>AI TEST ${this.id}</b> · ${DESCRIPTIONS[this.id.toUpperCase()] ?? ''}<br>` +
      `t ${s.time}s · ${(s.alive as string[]).join(' ')} · plans ${(s.plans as string[]).join(' ')} · plan changes ${(s.planChanges as string[]).join(' ')}<br>` +
      `decisions: ${Object.entries(dec).map(([k, v]) => `${k} ${v}`).join(' · ')}<br>` +
      `watchdog ${s.watchdog} · nav recoveries ${s.recoveries}<br>` +
      `<i>${s.verdict}</i><br>` +
      (s.notes as string[]).map((n) => `<small>${n}</small>`).join('<br>');
  }
}

const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(1)}, ${v.z.toFixed(1)})`;
