import * as THREE from 'three';
import type { PlayerTarget, Soldier, SoldierDeps } from './Soldier';
import { TeamAgent, randomPersonality, type Combatant } from '../game/TeamAgent';
import { SquadBrain } from '../ai/Squad';
import { SquadVoice } from '../ai/SquadVoice';
import { pickCommanderLine, type CommanderCategory } from '../audio/CommanderVoice';
import { PERSONAS, type PersonaId } from '../ai/Persona';

type SquadState = 'patrol' | 'combat' | 'search';

const SIZE = 4;
const WEAPONS = ['asval', 'ak47', 'm4a1', 'mk47'];
/** A squad with a shape: the Warden hunts, one pushes, one works corners, one lies in wait. */
const PERSONALITY: PersonaId[] = ['gigachad', 'chad', 'normal', 'turtle'];
const WALK = 1.5;
const RESPAWN = 10;

/**
 * The Weapon Lab's SABLE squad on the tactical AI (the same brains as the AI teams):
 * the Warden and three operators patrol the yard, and on contact they fight like
 * players: cover, lean-peeks round corners (Q / E), suppressing fire, flanks, pushes,
 * searches of the last known position, radio callouts. The Warden talks (his voice
 * pack): first contact, orders, taunts, when he's hit, when a man goes down.
 */
export class TacticalSable {
  readonly agents: TeamAgent[] = [];
  state: SquadState = 'patrol';
  onRadio: ((text: string) => void) | null = null;
  private squad: SquadBrain;
  private voice: SquadVoice;
  private world: Combatant[] = [];
  private mates: Soldier[] = [];
  private routeIndex: number;
  private time = 0;
  private respawnTimer = 0;
  private announced = false;
  private lastSeen = -1e9;
  private fightEnded = -1e9;
  // The Warden's voice.
  private cmdBusyUntil = 0;
  private cmdNext = 0;
  private wardenHurtAt = -1e9;
  private wardenHp = 1;
  private wasAlive: boolean[] = [];

  constructor(
    private deps: SoldierDeps,
    private route: THREE.Vector3[],
    private spawnIndex: number,
    private player: () => Combatant,
    private listener: () => THREE.Vector3,
  ) {
    this.squad = new SquadBrain('bd', false, deps.nav);
    this.voice = new SquadVoice(deps.audio);
    this.routeIndex = spawnIndex;
    for (let i = 0; i < SIZE; i++) {
      const warden = i === 0;
      const p = randomPersonality(0.15);
      if (warden) {
        p.name = 'The Warden';
        p.role = 'assault';
        p.aggression = 0.8;
      }
      const a = new TeamAgent(deps, 'bd', 40 + i, p, warden ? 'bdboss' : 'bd', undefined, 'disciplined');
      a.soldier.body.canGoDown = () => false;
      a.bot.setPersona(PERSONAS[PERSONALITY[i % PERSONALITY.length]]);
      this.squad.add(a.bot);
      this.agents.push(a);
      this.mates.push(a.soldier);
    }
    this.spawn();
  }

  get soldiers(): Soldier[] {
    return this.mates;
  }

  get aliveCount(): number {
    return this.agents.filter((a) => a.alive).length;
  }

  private get warden(): TeamAgent | null {
    const w = this.agents[0];
    return w.alive ? w : null;
  }

  spawn(): void {
    const at = this.route[this.spawnIndex];
    this.routeIndex = this.spawnIndex;
    this.agents.forEach((a, i) => {
      const p = this.deps.nav.nearestWalkable(at.x + (i % 2) * 1.4 - 0.7, at.z + ((i / 2) | 0) * 1.4, new THREE.Vector3(), 4) ?? at.clone();
      a.spawn(p, Math.random() * Math.PI * 2);
      a.arm(WEAPONS[i % WEAPONS.length]);
      // Sharper than the AI teams: quick to read a fight, accurate, the Warden most of all.
      a.baseSkill = a.soldier.skill = i === 0 ? 1.35 : 1.25;
      a.chad = i === 0;
    });
    this.wasAlive = this.agents.map(() => true);
    this.state = 'patrol';
    this.respawnTimer = 0;
    this.wardenHp = 1;
  }

  /** Player shots reach the bots through the shared noise system (aiWorld). */
  hearShot(_pos: THREE.Vector3, _suppressed: boolean): void {}

  /** You reloading close by: the Warden lets you know he heard. */
  hearReload(pos: THREE.Vector3): void {
    const w = this.warden;
    if (w && this.state !== 'patrol' && w.soldier.pos.distanceTo(pos) < 25) this.sayCmd('reload', 0.2);
  }

  onPlayerKilled(): void {
    if (this.warden) this.sayCmd('kill', 0.8);
  }

  update(dt: number, _player: PlayerTarget, aiEnabled: boolean): void {
    this.time += dt;
    const alive = this.agents.filter((a) => a.alive);
    if (!alive.length) {
      this.respawnTimer += dt;
      if (this.respawnTimer > RESPAWN) this.spawn();
    }
    // Who's in the fight: the player (AI on) and the squad itself.
    const w = this.world;
    w.length = 0;
    const pc = this.player();
    if (aiEnabled && pc.alive) w.push(pc);
    for (const a of this.agents) {
      a.refreshSelf();
      if (a.alive) w.push(a.self);
    }
    this.orders();
    this.squad.update(dt);
    for (const a of this.agents) a.update(dt, w, this.mates);
    this.voice.update(this.time, this.agents.map((a) => a.bot));
    this.updateState(pc);
    this.warden0(pc);
  }

  /** Patrol: the leader walks the route, the rest follow him (the brains take over in a fight). */
  private orders(): void {
    const L = this.agents.find((a) => a.alive && !a.downed);
    if (!L) return;
    const o = L.gotoOrder;
    const at = this.route[this.routeIndex];
    if (L.distTo(at) < 2) this.routeIndex = (this.routeIndex + 1) % this.route.length;
    o.at = this.route[this.routeIndex];
    o.speed = this.state === 'patrol' ? WALK : 3.7;
    L.order = o;
    for (const a of this.agents) {
      if (a === L || !a.alive) continue;
      a.followTarget = L;
      a.order = a.followOrder;
    }
  }

  private updateState(pc: Combatant): void {
    let sees = false;
    let knows = false;
    for (const a of this.agents) {
      if (!a.alive) continue;
      const t = a.bot.target;
      if (!t || t.target !== pc) continue;
      knows = true;
      if (t.visible) sees = true;
    }
    const was = this.state;
    if (sees) this.lastSeen = this.time;
    this.state = sees || this.time - this.lastSeen < 6 ? 'combat' : knows ? 'search' : 'patrol';
    if (this.state === was) return;
    // A new phase of the fight: the Warden has something to say soon.
    this.cmdNext = Math.min(this.cmdNext, this.time + 4 + Math.random() * 3);
    if (this.state === 'combat') {
      // First blood of the night: the alarm, the facility voice, the sting (SquadVoice).
      if (!this.announced) {
        this.announced = true;
        this.deps.audio.play('alarm.short');
        setTimeout(() => this.deps.audio.play('announce.intruders'), 1700);
      }
      this.sayCmd(was === 'patrol' || this.time - this.fightEnded > 40 ? 'firstcontact' : 'threat', 2.6);
    } else if (was === 'combat') {
      this.fightEnded = this.time;
      if (this.state === 'search') this.sayCmd(Math.random() < 0.5 ? 'lost' : 'search', 0.6);
    }
  }

  /** The Warden: what he says, and when. */
  private warden0(pc: Combatant): void {
    // His men going down.
    this.agents.forEach((a, i) => {
      if (this.wasAlive[i] && !a.alive && i !== 0) this.sayCmd('allydown', 0.9);
      this.wasAlive[i] = a.alive;
    });
    const w = this.warden;
    if (!w) return;
    // Hit: how he sounds depends on how bad.
    const hp = w.soldier.body.health.health / w.soldier.body.health.maxHealth;
    if (w.bot.hurtAt > this.wardenHurtAt) {
      this.wardenHurtAt = w.bot.hurtAt;
      if (hp < 0.25 && this.wardenHp >= 0.25) this.sayCmd('neardeath', 0.3);
      else if (hp < 0.5 && this.wardenHp >= 0.5) this.sayCmd('lowhp', 0.3);
      else if (Math.random() < 0.4) this.sayCmd('hit', 0.25);
    }
    this.wardenHp = hp;
    if (this.time < this.cmdNext) return;
    if (this.state === 'combat') {
      if (pc.alive && w.soldier.pos.distanceTo(pc.pos) < 7) this.sayCmd('close');
      else this.sayCmd(Math.random() < 0.6 ? 'command' : 'threat');
      this.cmdNext = this.time + 11 + Math.random() * 9;
    } else if (this.state === 'search') {
      this.sayCmd('search');
      this.cmdNext = this.time + 14 + Math.random() * 10;
    } else {
      if (Math.random() < 0.3) this.sayCmd('rare');
      this.cmdNext = this.time + 45 + Math.random() * 45;
    }
  }

  private sayCmd(cat: CommanderCategory, delay = 0): void {
    setTimeout(() => {
      const w = this.warden;
      if (!w || this.time < this.cmdBusyUntil) return;
      const line = pickCommanderLine(cat);
      if (!line) return;
      const head = w.soldier.headPos;
      this.deps.audio.play(`bd.cmd.${line.id}`, { position: head, volume: 1.4 });
      if (head.distanceTo(this.listener()) < 60) this.onRadio?.(line.text);
      // Long lines hold the channel.
      this.cmdBusyUntil = this.time + 1.25 + line.text.length * 0.045;
      this.cmdNext = Math.max(this.cmdNext, this.time + 6);
    }, delay * 1000);
  }
}
