import * as THREE from 'three';
import type { Physics } from '../core/Physics';
import { GROUPS } from '../core/Physics';
import type { NavGrid } from '../ai/NavGrid';
import type { AudioSystem } from '../audio/AudioSystem';
import type { Site9 } from '../world/Site9';
import type { Lighting } from './Lighting';
import type { Survival } from './Survival';
import type { Combatant } from './TeamAgent';
import type { MeleeTarget } from '../enemies/RogueRobot';
import type { DamageInfo } from '../targets/Humanoid';
import { Civilian } from '../enemies/Civilian';
import { Cultist, type Prey } from '../enemies/Cultist';
import { choirEyes } from '../enemies/CivilianSkin';
import { aiWorld } from '../ai/World';
import { byPlayer, raid } from './Progress';

export interface InhabitantDeps {
  physics: Physics;
  scene: THREE.Object3D;
  nav: NavGrid;
  map: Site9;
  audio: AudioSystem;
  lighting: Lighting;
  survival: Survival;
  mobile: boolean;
  /** You (feet, eye, view direction, alive). */
  prey: Prey;
  hurtPlayer(damage: number, from: THREE.Vector3): void;
  /** Jumpscare kick on the camera. */
  jolt(): void;
  toast(text: string): void;
  radio(text: string): void;
}

/** Rooms the lab staff were hiding in when it all went wrong. */
const LAB_ROOMS = ['labs', 'cleanroom', 'prototypes'];
const CIVILIAN_PENALTY = 250;

/**
 * Everyone on Site-9 who isn't fighting for the contract:
 *  - lab staff hiding in the labs, who panic and run at gunfire, blasts and
 *    robots (robots hunt them; killing one costs you $250 and XP)
 *  - The Choir, who only come out in a blackout (see Cultist)
 */
export class Inhabitants {
  readonly civilians: Civilian[] = [];
  readonly cult: Cultist[] = [];
  private civC = new Map<Civilian, MeleeTarget>();
  private cultC = new Map<Cultist, Combatant>();
  private spawnTimer = 6;
  private announced = false;
  /** Last noise id the lab staff reacted to. */
  private noiseSeen = -1;
  private tmp = new THREE.Vector3();
  private chest = new THREE.Vector3();
  /** Lab staff: when each may speak again, and what they were doing last frame. */
  private nextLine = new Map<Civilian, number>();
  private wasFleeing = new Set<Civilian>();

  constructor(private d: InhabitantDeps) {
    const civHooks = {
      onKilled: (c: Civilian, info: DamageInfo) => {
        if (!byPlayer(info.hit)) return;
        raid.civilians++;
        const sv = d.survival;
        sv.addPoints(-Math.min(sv.points, CIVILIAN_PENALTY));
        d.toast(`Civilian killed: −$${CIVILIAN_PENALTY}`);
        void c;
      },
      onThud: (at: THREE.Vector3, s: number) => d.audio.play('robot.fall', { position: at, volume: 0.15 + 0.3 * s }),
      onHurt: (c: Civilian, info: DamageInfo) => {
        if (byPlayer(info.hit)) this.say(c, 'plead', 3, true);
      },
    };
    const count = d.mobile ? 6 : 10;
    const rooms = d.map.rooms.filter((r) => LAB_ROOMS.includes(r.id));
    for (let i = 0; i < count; i++) {
      const c = new Civilian(d.physics, d.scene, d.nav, i, civHooks);
      const r = rooms[i % rooms.length];
      const at = this.pointIn(r.rect, 3) ?? new THREE.Vector3((r.rect[0] + r.rect[2]) / 2, 0, (r.rect[1] + r.rect[3]) / 2);
      c.spawn(at, Math.random() * Math.PI * 2);
      if (d.mobile) c.body.setCastShadow(false);
      this.civilians.push(c);
    }

    const cultHooks = {
      onKilled: (c: Cultist, info: DamageInfo) => {
        if (byPlayer(info.hit)) raid.choir++;
        const t = info.hit.team;
        if (t && t !== 'cult' && t !== 'robots') d.survival.award(t, 300, info.hit.owner);
        void c;
      },
      onThud: (at: THREE.Vector3, s: number) => d.audio.play('robot.fall', { position: at, volume: 0.2 + 0.4 * s }),
      onLunge: (c: Cultist) => {
        d.audio.play('choir.sting', { volume: Math.min(1, 9 / Math.max(3, c.pos.distanceTo(d.prey.feet))) });
        d.audio.play('choir.hiss', { position: c.pos, pitch: 1.25 });
      },
      onSlash: (c: Cultist, dmg: number) => {
        d.audio.play('choir.slash', { position: c.pos });
        d.hurtPlayer(dmg, c.pos);
        d.jolt();
      },
      onFlinch: (c: Cultist) => d.audio.play('choir.hiss', { position: c.pos }),
      onWhisper: (c: Cultist) => d.audio.play('choir.whisper', { position: c.pos }),
    };
    for (let i = 0; i < (d.mobile ? 2 : 3); i++) {
      const c = new Cultist(d.physics, d.scene, d.nav, i, cultHooks);
      if (d.mobile) c.body.setCastShadow(false);
      this.cult.push(c);
    }
  }

  /** Each of them keeps one voice: long hair (odd skins) → one of the women's voices. */
  private speaker(c: Civilian): number {
    return (c.index % 2 ? 3 : 0) + ((c.index >> 1) % 3);
  }

  private say(c: Civilian, kind: 'panic' | 'plead' | 'whimper', cooldown: number, force = false): void {
    const now = aiWorld.time;
    if (!force && (this.nextLine.get(c) ?? 0) > now) return;
    this.nextLine.set(c, now + cooldown);
    this.d.audio.play(`civ.${kind}.${this.speaker(c)}`, { position: c.body.part('head').worldPos });
  }

  /** A walkable point inside a room rect (margin m from the walls). */
  private pointIn(rect: readonly number[], margin: number): THREE.Vector3 | null {
    for (let i = 0; i < 20; i++) {
      const x = rect[0] + margin + Math.random() * (rect[2] - rect[0] - margin * 2);
      const z = rect[1] + margin + Math.random() * (rect[3] - rect[1] - margin * 2);
      if (this.d.nav.walkable(x, z)) return new THREE.Vector3(x, 0, z);
    }
    return null;
  }

  /** Robots hunt the lab staff too. */
  meleeTargets(out: MeleeTarget[]): void {
    for (const c of this.civilians) {
      if (!c.alive) continue;
      let t = this.civC.get(c);
      if (!t) this.civC.set(c, (t = { pos: c.pos, get alive() { return c.alive; }, hit: (dmg, from) => c.hit(dmg, from) }));
      out.push(t);
    }
  }

  /** The Choir in the fight: soldiers see and shoot them like any melee threat. */
  combatants(out: Combatant[]): void {
    for (const c of this.cult) {
      if (!c.alive) continue;
      let k = this.cultC.get(c);
      if (!k) {
        k = {
          team: 'cult', kind: 'robot', pos: c.pos, aim: new THREE.Vector3(), head: new THREE.Vector3(),
          get alive() {
            return c.alive;
          },
          downed: false, hit: (dmg, from) => c.hit(dmg, from), ref: c,
        };
        this.cultC.set(c, k);
      }
      k.aim.copy(c.body.part('torso').worldPos).y += 0.25;
      k.head.copy(c.body.part('head').worldPos);
      out.push(k);
    }
  }

  update(dt: number): void {
    const d = this.d;
    const prey = d.prey;
    // --- Lab staff: scares, then their own update; hidden rooms don't draw them.
    const noises = aiWorld.noise.all;
    const now = aiWorld.time;
    let newest = this.noiseSeen;
    for (const n of noises) newest = Math.max(newest, n.id);
    for (const c of this.civilians) {
      if (c.alive) {
        for (const n of noises) {
          if (n.id <= this.noiseSeen || now - n.time > 1) continue;
          const loud = n.kind === 'explosion' ? 38 : n.kind === 'gunshot' ? 24 : n.kind === 'gunshot_sup' ? 10 : 0;
          if (loud && n.pos.distanceToSquared(c.pos) < loud * loud) c.scare(n.pos, n.kind === 'explosion' ? 9 : 6);
        }
        for (const r of d.survival.robots) {
          if (r.alive && r.state === 'chase' && r.pos.distanceToSquared(c.pos) < 81) c.scare(r.pos, 5);
        }
        for (const k of this.cult) if (k.alive && k.pos.distanceToSquared(c.pos) < 64) c.scare(k.pos, 6);
      }
      // Voices: a cry when they bolt (and now and then while running), "don't shoot" when
      // you point a gun at them up close, whimpering while they cower near you.
      if (c.alive) {
        const fleeing = c.state === 'flee';
        if (fleeing && !this.wasFleeing.has(c) && Math.random() < 0.75) this.say(c, 'panic', 4);
        else if (fleeing && Math.random() < dt * 0.15) this.say(c, 'panic', 5);
        if (fleeing) this.wasFleeing.add(c);
        else this.wasFleeing.delete(c);
        const dist = c.pos.distanceTo(prey.feet);
        if (dist < 12 && prey.alive) {
          const to = this.tmp.copy(c.pos).setY(1.3).sub(prey.eye);
          const aimed = to.dot(prey.look) / Math.max(to.length(), 1e-3) > Math.cos(0.12);
          if (aimed && d.physics.lineOfSight(prey.eye, this.chest.copy(c.pos).setY(1.3), GROUPS.sight)) this.say(c, 'plead', 6);
          else if (!fleeing && dist < 9 && Math.random() < dt * 0.25) this.say(c, 'whimper', 7);
        }
      }
      const shown = d.map.isVisibleAt(c.pos.x, c.pos.z);
      c.body.root.visible = shown;
      // Calm and in a room nobody is drawing: frozen mid-cower costs nothing.
      if (!shown && c.alive && c.state === 'hide' && c.panic <= 0) continue;
      c.update(dt);
    }
    this.noiseSeen = newest;

    // --- The Choir: out in a blackout, banished by the light.
    const dark = d.lighting.darkness > 0.8;
    const alive = this.cult.filter((c) => c.alive);
    if (dark && prey.alive) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && alive.length < this.cult.length) {
        const c = this.cult.find((k) => !k.alive)!;
        const at = this.darkSpot();
        if (at) {
          c.spawn(at, Math.atan2(prey.feet.x - at.x, prey.feet.z - at.z));
          if (!this.announced) {
            this.announced = true;
            d.radio('Movement in the dark. Not robots. Keep your light on them.');
          }
        }
        this.spawnTimer = 9 + Math.random() * 9;
      }
    } else {
      this.spawnTimer = Math.min(this.spawnTimer, 4);
      if (!dark) this.announced = false;
      for (const c of alive) c.banished = true;
    }
    // Eyes: a dim ember, brighter when they rush.
    const rushing = alive.some((c) => c.state === 'lunge' || c.state === 'slash');
    choirEyes.emissiveIntensity = rushing ? 3.2 : 0.9 + Math.sin(now * 3.1) * 0.25;
    for (const c of this.cult) {
      if (c.state === 'gone') continue;
      const chest = this.chest.copy(c.pos).setY(1.35);
      const to = this.tmp.subVectors(chest, prey.eye);
      const dist = to.length();
      const cos = to.dot(prey.look) / Math.max(dist, 1e-3);
      const los = dist < 40 && d.physics.lineOfSight(prey.eye, chest, GROUPS.sight);
      const lit = d.lighting.flashlightOn && dist < 18 && cos > Math.cos(0.33) && los;
      const seen = cos > Math.cos(0.8) && los;
      c.update(dt, prey, lit, seen);
      if (c.state === 'dead') continue;
      // Gone back into the dark: vanish out of sight (or when far off).
      if ((c.banished && c.state === 'retreat' && (!los || dist > 16)) || dist > 55) c.vanish();
      else c.body.root.visible = d.map.isVisibleAt(c.pos.x, c.pos.z);
    }
  }

  /** Where one of them steps out: 12-26 m from you, behind a wall or behind your back (it's dark). */
  private darkSpot(): THREE.Vector3 | null {
    const d = this.d;
    const sv = d.survival;
    const prey = d.prey;
    let searches = 0;
    for (let i = 0; i < 24 && searches < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 14;
      const p = d.nav.nearestWalkable(prey.feet.x + Math.sin(a) * r, prey.feet.z + Math.cos(a) * r, new THREE.Vector3(), 2);
      if (!p) continue;
      const zone = d.map.zoneAt(p.x, p.z);
      if (!zone || !sv.unlocked.has(zone)) continue;
      const to = this.tmp.copy(p).setY(1.4).sub(prey.eye);
      const inView = to.dot(prey.look) / Math.max(to.length(), 1e-3) > Math.cos(1.1);
      if (inView && d.physics.lineOfSight(prey.eye, this.chest.copy(p).setY(1.4), GROUPS.sight)) continue;
      searches++;
      if (!d.nav.findPath(p, prey.feet, 2000)) continue;
      return p;
    }
    return null;
  }
}
