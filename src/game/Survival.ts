import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SIDEARMS, byPlayer, loadProfile, raid, settleRaid } from './Progress';
import type { Physics, RAPIER } from '../core/Physics';
import type { Site9, SpawnPoint, WallBuy, AmmoSpot, HazardSpot } from '../world/Site9';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { DoorSlot } from '../world/LayoutBuilder';
import type { NavGrid } from '../ai/NavGrid';
import type { WeaponController } from '../weapons/WeaponController';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerHealth } from '../player/PlayerHealth';
import type { AudioSystem } from '../audio/AudioSystem';
import { bakedRig, buildWeaponModel } from '../weapons/WeaponModels';
import type { ModelKey } from '../weapons/WeaponData';
import { mergeStatic } from '../world/MeshBuilder';
import type { LinkDef } from '../world/LayoutBuilder';
import { RogueRobot, type MeleeTarget, type RobotVariant } from '../enemies/RogueRobot';
import type { SurvivalHUD } from '../ui/SurvivalHUD';
import type { DamageInfo } from '../targets/Humanoid';
import type { Lighting } from './Lighting';
import type { Combatant } from './TeamAgent';
import { aiWorld } from '../ai/World';
import { Builder } from './Builder';
import { Utilities } from './Utilities';
import type { WallSpot } from '../world/Site9';

export interface SurvivalDeps {
  /** ?watch: the player is a spectator camera, nobody's target. */
  watching?: boolean;
  map: Site9;
  physics: Physics;
  scene: THREE.Scene;
  nav: NavGrid;
  weapons: WeaponController;
  player: PlayerController;
  health: PlayerHealth;
  audio: AudioSystem;
  impacts: ImpactSystem;
  hud: SurvivalHUD;
  mobile: boolean;
  /** Damage the player (with all hit feedback). */
  hurtPlayer(damage: number, from: THREE.Vector3): void;
  /** Hire an allied operator at this position (Vanta contractor). */
  hireAlly?(at: THREE.Vector3): boolean;
  /** 'teams': four teams (you + 3 AI) race for points, PvPvE. 'solo': classic survival. */
  mode?: 'solo' | 'teams';
  /** Extra zones open from the start (other teams' start rooms). */
  startZones?: string[];
  /** Positions the director may also send mobs at (AI team leaders). */
  focusProvider?: () => THREE.Vector3[];
  /** A team's score crossed a raid threshold → blackout + SABLE raid. */
  onRaid?: (team: string) => void;
  /** Everyone with a wallet on a team (the player's included) — for the team share. */
  members?: (team: string) => Wallet[];
  /** Whose wallet a shooter is (player controller / soldier). */
  walletOf?: (owner: object) => Wallet | null;
  /** Facility power + flashlight (breakers). */
  lighting?: Lighting | null;
  /** Everyone fighting this frame (sentries pick targets from it). */
  world?: () => Combatant[];
  toast?: (text: string) => void;
  onPowerRestored?: () => void;
}

/** Personal money: the player and every operator earn and spend their own. */
export interface Wallet {
  points: number;
  add(n: number): void;
}

/** Share of every teammate's earnings you also get (CoD-style team economy). */
export const TEAM_SHARE = 0.15;
/** Your squad's kills pay you half as much again (you lead it): the allies no longer take all the early robots' cash. */
const LEADER_SHARE = 0.5;

interface Door {
  slot: DoorSlot;
  cost: number;
  zones: [string, string];
  to: [string, string];
  open: boolean;
  collider: RAPIER.Collider;
  shutter: THREE.Object3D;
  lift: number;
}

export interface Interactable {
  pos: THREE.Vector3;
  radius: number;
  label(): string;
  cost(): number;
  use(): boolean;
}

type DirectorPhase = 'relax' | 'buildup' | 'peak' | 'fade';

interface Hazard {
  spot: HazardSpot;
  kind: 'electric' | 'gas' | 'fire';
  emit: number;
  sound: number;
  tick: number;
  glow: THREE.MeshBasicMaterial;
}

const HAZARD_DPS = { electric: 70, gas: 26, fire: 80 };

/** Enough to open one starter shutter right away ($750). */
export const START_POINTS = 800;
const POINTS = { hit: 10, kill: 60, headKill: 100 };
/** Wall-buy weapon templates per `${model}|${mobile}` (cloned: shared geometry). */
const wallModels = new Map<string, THREE.Object3D>();

/**
 * Site-9 survival. Economy is Zombies-style (points for hits and kills, spent on
 * shutters, wall weapons, ammo and hired operators); pacing is Left 4 Dead's:
 *
 * - Wanderers: newly opened zones get a few powered-down robots standing where
 *   they were left. They wake when they see you, hear gunfire, get shot, or a
 *   neighbour wakes.
 * - The director tracks your "intensity" (damage taken, robots in your face,
 *   kills nearby) and cycles build-up → peak → fade → relax. Mobs only arrive
 *   from spawn points you cannot see (service lifts chime first).
 * - Dynamic difficulty: a skill estimate (your health, recent damage, how calm
 *   things are) scales mob size and robot toughness up or down; threat also
 *   grows with time and with how much of the facility you have opened.
 */
export class Survival {
  /** The player's spendable points (key 'alpha'). */
  readonly teamPoints = new Map<string, number>([['alpha', START_POINTS]]);
  /** Ammo cache approach points (AI restocks). */
  readonly ammoCaches: THREE.Vector3[] = [];
  readonly playerWallet: Wallet = ((sv: Survival): Wallet => ({
    get points() {
      return sv.points;
    },
    set points(v: number) {
      sv.points = v;
    },
    add: (n: number) => sv.addPoints(n),
  }))(this);
  /** Total earned per team (the race). */
  readonly score = new Map<string, number>([['alpha', 0]]);
  private raidAt = [6000, 14000, 22000];

  get points(): number {
    return this.teamPoints.get('alpha') ?? 0;
  }

  set points(v: number) {
    this.teamPoints.set('alpha', v);
  }

  /** Score at which the next SABLE raid triggers (team games). */
  get nextRaid(): number | null {
    return this.deps.mode === 'teams' ? (this.raidAt[0] ?? null) : null;
  }

  /**
   * Points for a hit or kill: the shooter's own wallet gets them, every teammate
   * gets a small share, and the team's race score goes up (raids, the win).
   */
  award(team: string, n: number, owner?: object | null): void {
    if (!team || team === 'bd' || team === 'robots' || team === 'salvage' || team === 'cult' || this.over) return;
    const members = this.deps.members?.(team);
    if (!members) {
      if (team === 'alpha') this.addPoints(n);
    } else {
      const earner = (owner && this.deps.walletOf?.(owner)) || (team === 'alpha' && !owner ? this.playerWallet : null);
      earner?.add(earner === this.playerWallet && this.perks.has('scavenger') ? Math.round(n * 1.1) : n);
      const share = Math.round(n * TEAM_SHARE);
      const lead = Math.round(n * LEADER_SHARE);
      if (share > 0) for (const m of members) if (m !== earner) m.add(m === this.playerWallet ? lead : share);
    }
    const sc = (this.score.get(team) ?? 0) + n;
    this.score.set(team, sc);
    if (this.deps.mode !== 'teams') return;
    // No score cap: the race runs until the clock calls extraction.
    if (sc >= this.raidAt[0]) {
      this.raidAt.shift();
      this.deps.onRaid?.(team);
    }
  }

  /** Losing people costs: a team's race score drops when one of its operators dies. */
  penalize(team: string, n: number): void {
    if (this.over || !this.score.has(team)) return;
    this.score.set(team, Math.max(0, (this.score.get(team) ?? 0) - n));
  }

  /** Match clock (seconds). */
  get time(): number {
    return this.elapsed;
  }

  private megaUntil = -1;
  /** Points a team loses per operator killed (rises with match heat). */
  deathPenalty = 100;

  /** A giant wave from every opened lift and bay, spread over all teams. */
  megaHorde(size: number): void {
    this.mobLeft += size;
    this.phase = 'buildup';
    this.spawnTimer = 0;
    this.megaUntil = this.elapsed + 75;
    this.deps.hud.showBanner('MEGA HORDE', 'round');
    this.deps.audio.play('director.horde');
  }

  /** A soldier of `victimTeam` was hit by someone (points for the shooter's team). */
  onSoldierHit(victimTeam: string, info: DamageInfo, killed: boolean): void {
    if (killed) this.penalize(victimTeam, this.deathPenalty);
    const t = info.hit.team;
    if (!t || t === victimTeam) return;
    // A soldier kill pays double a robot horde's worth: fighting other teams beats farming.
    this.award(t, killed ? 300 : 10, info.hit.owner);
  }
  readonly unlocked = new Set<string>(['start']);
  readonly doors: Door[] = [];
  readonly robots: RogueRobot[] = [];
  private tmp2 = new THREE.Vector3();
  private interactables: Interactable[] = [];
  private focus: Interactable | null = null;
  private over = false;
  private kills = 0;
  /** Career perks equipped for this raid. */
  private perks = new Set<string>();
  private elapsed = 0;
  // Director
  private phase: DirectorPhase = 'relax';
  private phaseTimer = 9; // a short calm start
  private trickleTimer = 12;
  private hazards: Hazard[] = [];
  /** Allied bodies hazards can hurt. */
  allyBodies: { pos: THREE.Vector3; hit(d: number, from: THREE.Vector3): void; alive: boolean }[] = [];
  intensity = 0;
  skill = 1;
  private skillTimer = 0;
  private recentDamage = 0;
  private mobLeft = 0;
  private spawnTimer = 0;
  private pending: { sp: SpawnPoint; t: number; mob: boolean }[] = [];
  private wakeQueue: { r: RogueRobot; t: number }[] = [];
  /** Dormant-robot sight checks: rays owed this frame, and whose turn it is. */
  private wakeBudget = 0;
  private wakeCursor = 0;
  private playerTarget: MeleeTarget;
  extraTargets: MeleeTarget[] = [];
  /** Shown instead of the nearest interactable (e.g. "Revive Kato"); F does that instead. */
  overridePrompt: string | null = null;
  /** Stations, breakers, supply crate, sentries. */
  utilities: Utilities | null = null;
  /** Build mode: barricades, traps, deployable sentries. */
  builder!: Builder;
  private navRefresh: { x0: number; z0: number; x1: number; z1: number; frames: number }[] = [];
  private tmp = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private probe = new THREE.Vector3();

  constructor(private deps: SurvivalDeps) {
    const { map, physics, scene, nav, mobile } = deps;
    this.playerTarget = {
      pos: deps.player.feet,
      get alive() {
        return !deps.health.dead && !deps.watching;
      },
      hit: (d, from) => deps.hurtPlayer(d, from),
    };
    for (const slot of map.doors) this.buildDoor(slot);
    // Random content on free wall spots: extra weapons now, stations etc. below.
    const spots = this.pickSpots();
    for (const s of spots.weapon) map.addWallBuy(s);
    for (const wb of map.wallBuys) this.buildWallBuy(wb);
    this.placeAmmo(map.ammoSpots);
    this.placeHazards(map.hazardSpots);
    this.utilities = new Utilities(this, deps, spots);
    this.builder = new Builder(this, deps, () => deps.world?.() ?? []);
    for (const t of map.terminals) {
      this.interactables.push({
        pos: t.pos.clone(),
        radius: 2.4,
        label: () => 'Hire Vanta contractor',
        cost: () => t.cost,
        use: () => {
          if (!deps.hireAlly) {
            deps.hud.flashPrompt();
            return false;
          }
          if (this.points < t.cost) return this.spend(t.cost);
          const at = t.pos.clone().add(new THREE.Vector3(Math.sin(t.yaw) * 2, -1.3, Math.cos(t.yaw) * 2));
          if (!deps.hireAlly(at)) {
            deps.hud.flashPrompt();
            return false;
          }
          return this.spend(t.cost);
        },
      });
    }
    // Four teams farm robots: the facility needs a lot more of them.
    const pool = deps.mode === 'teams' ? (mobile ? 24 : 46) : mobile ? 14 : 24;
    for (let i = 0; i < pool; i++) {
      this.robots.push(
        new RogueRobot(physics, scene, nav, {
          onDamage: (_r, info) => this.award(info.hit.team || 'alpha', POINTS.hit, info.hit.owner),
          onDeath: (r, info) => {
            if (info.hit.team === 'alpha' || !info.hit.team) this.kills++;
            if (byPlayer(info.hit)) {
              raid.robots++;
              if (info.zone === 'head') raid.headshots++;
            }
            if (r.pos.distanceTo(deps.player.feet) < 12) this.intensity = Math.min(1, this.intensity + 0.04);
            this.award(info.hit.team || 'alpha', info.zone === 'head' ? POINTS.headKill : POINTS.kill, info.hit.owner);
          },
          onAttack: (r) => {
            deps.audio.play('robot.stagger', { position: r.pos, volume: 0.6 });
            aiWorld.emit('robot', r.pos, 'robots', r);
          },
          onThud: (at, s) => deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * s }),
          onShort: (r, big) => {
            const at = this.tmp2.set(r.pos.x, 1.2 + Math.random() * 0.4, r.pos.z);
            deps.impacts.shortOut(at, big);
            deps.audio.play('hazard.zap', { position: at, volume: big ? 1 : 0.55 });
          },
          onReboot: (r) => deps.audio.play('robot.boot', { position: r.pos }),
          onWake: (r) => {
            aiWorld.emit('robot', r.pos, 'robots', r, 1.2);
            deps.audio.play('robot.wake', { position: r.pos });
            // Wakes its neighbours a moment later.
            for (const o of this.robots) {
              if (o !== r && o.dormant && o.pos.distanceTo(r.pos) < 8) this.wakeQueue.push({ r: o, t: 0.3 + Math.random() * 0.6 });
            }
          },
        }),
      );
    }
    if (mobile) for (const r of this.robots) r.body.setCastShadow(false);
    for (const z of deps.startZones ?? []) {
      this.unlocked.add(z);
      this.populateZone(z, 6); // plenty to farm from the first minute
    }
    if (deps.mode === 'teams') this.phaseTimer = 5;
    deps.weapons.infiniteReserve.add('heavy_pistol');
    deps.weapons.startLoadout('heavy_pistol');
    deps.hud.setPoints(this.points);
    deps.hud.setRound(1);
  }

  // ---------------------------------------------------------------- economy

  addPoints(n: number): void {
    this.points += n;
    this.deps.hud.setPoints(this.points, n);
  }

  addInteractable(it: Interactable): void {
    this.interactables.push(it);
  }

  /** Something solid was placed after the nav grid was baked: re-scan around it. */
  carveNav(at: THREE.Vector3, r: number): void {
    this.navRefresh.push({ x0: at.x - r, z0: at.z - r, x1: at.x + r, z1: at.z + r, frames: 2 });
  }

  spend(n: number): boolean {
    if (this.points < n) {
      this.deps.audio.play('dry_fire');
      this.deps.hud.flashPrompt();
      return false;
    }
    this.points -= n;
    this.deps.hud.setPoints(this.points, -n);
    this.deps.audio.play('ui.firemode');
    return true;
  }

  /** Feed the director: the player took damage. */
  onPlayerDamaged(amount: number): void {
    this.intensity = Math.min(1, this.intensity + amount / 70);
    this.recentDamage += amount;
  }

  /** Gunfire wakes dormant robots in earshot. */
  hearShot(pos: THREE.Vector3, suppressed: boolean): void {
    const r2 = (suppressed ? 9 : 24) ** 2;
    for (const r of this.robots) if (r.dormant && r.pos.distanceToSquared(pos) < r2) this.wakeQueue.push({ r, t: Math.random() * 0.5 });
  }

  // ---------------------------------------------------------------- doors

  private buildDoor(slot: DoorSlot): void {
    const { map, physics } = this.deps;
    const link = slot.link;
    const ra = map.rooms.find((r) => r.id === link.a)!;
    const rb = map.rooms.find((r) => r.id === link.b)!;
    const w = slot.width;
    const h = slot.height;
    const shutter = new THREE.Group();
    shutter.position.copy(slot.center);
    if (!slot.alongX) shutter.rotation.y = Math.PI / 2;
    // Roll-up security shutter: ribbed steel, hazard stripe base, price signs both sides.
    // Painted, worn steel: dark enough to sit in a night-time room (bright bare metal glowed off the fill light).
    const steel = new THREE.MeshStandardMaterial({ map: shutterTexture(), color: 0x8a8f95, metalness: 0.35, roughness: 0.6 });
    // Slats, a heavy bottom bar and a pull handle each side, one mesh (shutters aren't culled
    // with the rooms: every extra part was a draw call per door in view). The bar and the
    // handles sample the texture's dark band.
    const dark = (g: THREE.BufferGeometry) => {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, 0.125);
      return g;
    };
    const parts = [new THREE.BoxGeometry(w, h, 0.14).translate(0, h / 2, 0), dark(new THREE.BoxGeometry(w, 0.16, 0.24).translate(0, 0.08, 0))];
    for (const s of [-1, 1]) parts.push(dark(new THREE.BoxGeometry(0.34, 0.05, 0.06).translate(w * 0.22, 0.42, s * 0.11)));
    const panel = new THREE.Mesh(mergeGeometries(parts)!, steel);
    panel.castShadow = true;
    panel.receiveShadow = true;
    shutter.add(panel);
    // Price signs on both faces, one mesh.
    const sy = Math.min(h - 0.5, 1.9);
    const front = new THREE.PlaneGeometry(1.6, 0.5).translate(0, sy, 0.08);
    const back = new THREE.PlaneGeometry(1.6, 0.5).rotateY(Math.PI).translate(0, sy, -0.08);
    shutter.add(new THREE.Mesh(mergeGeometries([front, back])!, printedSign(priceTexture(link.cost ?? 0), 0.4)));
    map.group.add(shutter);
    const half = slot.alongX ? new THREE.Vector3(w / 2, h / 2, 0.12) : new THREE.Vector3(0.12, h / 2, w / 2);
    const collider = physics.addStaticBox(this.tmp.copy(slot.center).setY(h / 2), half);
    const door: Door = {
      slot, cost: link.cost ?? 0, zones: [ra.zone, rb.zone], to: [ra.name, rb.name], open: false, collider, shutter, lift: 0,
    };
    // The nav grid was baked before the shutters existed: closed ones must block paths.
    const r = w / 2 + 1;
    this.navRefresh.push({ x0: slot.center.x - r, z0: slot.center.z - r, x1: slot.center.x + r, z1: slot.center.z + r, frames: 2 });
    this.doors.push(door);
    this.interactables.push({
      pos: slot.center.clone().setY(1.2),
      radius: Math.max(2.6, w / 2 + 1.2),
      label: () => {
        const dest = this.unlocked.has(door.zones[0]) ? door.to[1] : door.to[0];
        return `Open shutter: ${dest}`;
      },
      cost: () => (door.open ? -1 : door.cost),
      use: () => {
        if (door.open || !this.spend(door.cost)) return false;
        this.openDoor(door);
        return true;
      },
    });
  }

  openDoor(door: Door, populate = true): void {
    door.open = true;
    aiWorld.emit('door', door.slot.center, '', null);
    this.reachVersion++;
    this.deps.physics.world.removeCollider(door.collider, true);
    const fresh = door.zones.filter((z) => !this.unlocked.has(z));
    for (const z of door.zones) this.unlocked.add(z);
    this.deps.audio.play('reload.rifle.boltback', { position: door.slot.center, volume: 1 });
    this.deps.audio.play('robot.fall', { position: door.slot.center, volume: 0.5 });
    const c = door.slot.center;
    const r = door.slot.width / 2 + 1;
    // The nav grid sees the opening after the next physics step.
    this.navRefresh.push({ x0: c.x - r, z0: c.z - r, x1: c.x + r, z1: c.z + r, frames: 2 });
    if (populate) for (const z of fresh) this.populateZone(z, (this.deps.mode === 'teams' ? 5 : 3) + ((Math.random() * (2 + this.threat)) | 0));
  }

  private reachVersion = 0;
  private reachCache = new Map<string, { v: number; set: Set<string> }>();

  /**
   * Zones you can actually walk to from `zone` (archways + opened shutters).
   * "Unlocked" is global (any team opens doors); this is what matters to a squad.
   */
  reachable(zone: string | null): Set<string> {
    if (!zone) return this.unlocked;
    const c = this.reachCache.get(zone);
    if (c && c.v === this.reachVersion) return c.set;
    const { map } = this.deps;
    const roomZone = new Map(map.rooms.map((r) => [r.id, r.zone]));
    const set = new Set<string>([zone]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of map.links) {
        const za = roomZone.get(l.a)!;
        const zb = roomZone.get(l.b)!;
        if (set.has(za) === set.has(zb)) continue;
        if (l.kind === 'buy' && !this.isLinkOpen(l)) continue;
        set.add(set.has(za) ? zb : za);
        grew = true;
      }
    }
    this.reachCache.set(zone, { v: this.reachVersion, set });
    return set;
  }

  isLinkOpen(link: LinkDef): boolean {
    return this.doors.find((d) => d.slot.link === link)?.open ?? false;
  }

  isDoorOpen(slot: DoorSlot): boolean {
    return this.doors.find((d) => d.slot === slot)?.open ?? false;
  }

  // ---------------------------------------------------------------- wall weapons

  private buildWallBuy(wb: WallBuy): void {
    const { map, weapons } = this.deps;
    const idx = weapons.indexOf(wb.weapon);
    if (idx < 0) return;
    const data = weapons.weapons[idx].data;
    const n = new THREE.Vector3(Math.sin(wb.yaw), 0, Math.cos(wb.yaw));
    // Board + label + the actual weapon model hung on it.
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.8 }));
    board.position.copy(wb.pos).addScaledVector(n, 0.02);
    board.rotation.y = wb.yaw;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.28), printedSign(buyTexture(data.name, wb.cost), 0.4));
    label.position.copy(wb.pos).addScaledVector(n, 0.025).setY(wb.pos.y - 0.55);
    label.rotation.y = wb.yaw;
    const model = this.wallModel(data.model);
    model.position.copy(wb.pos).addScaledVector(n, 0.12);
    model.rotation.y = wb.yaw - Math.PI / 2;
    map.roomGroupAt(wb.pos.x, wb.pos.z).add(board, label, model);
    this.interactables.push({
      pos: wb.pos.clone(),
      radius: 2.2,
      label: () => (weapons.owned?.includes(idx) ? `Ammo: ${data.name}` : `Buy ${data.name}`),
      cost: () => (weapons.owned?.includes(idx) ? Math.round(wb.cost / 2) : wb.cost),
      use: () => {
        const owned = weapons.owned?.includes(idx);
        if (!this.spend(owned ? Math.round(wb.cost / 2) : wb.cost)) return false;
        weapons.giveWeapon(wb.weapon);
        this.deps.audio.play('reload.rifle.magin');
        return true;
      },
    });
  }

  /**
   * The weapon hung on a wall buy, built once per model and cloned (every board
   * of the same gun shares its geometry). Phones: the low-detail build baked to
   * vertex colours (~1-2 draw calls, a few thousand vertices instead of ~100k).
   */
  private wallModel(model: ModelKey): THREE.Object3D {
    const key = `${model}|${this.deps.mobile}`;
    let t = wallModels.get(key);
    if (!t) {
      if (this.deps.mobile) {
        const rig = bakedRig(model, true);
        rig.leftHand.removeFromParent();
        rig.rightHand.removeFromParent();
        t = rig.root;
      } else {
        const rig = buildWeaponModel(model, false, true);
        rig.leftHand.visible = false;
        rig.rightHand.visible = false;
        t = mergeStatic(rig.root);
      }
      // Static on a wall: cull it off screen again (rigs come with culling off).
      t.traverse((o) => {
        o.frustumCulled = true;
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
      });
      wallModels.set(key, t);
    }
    return t.clone();
  }

  // ---------------------------------------------------------------- ammo caches

  /** Roughly one cache per zone, at a random one of its spots (always one in the lobby). */
  private placeAmmo(spots: AmmoSpot[]): void {
    const byZone = new Map<string, AmmoSpot[]>();
    for (const s of spots) byZone.set(s.zone, [...(byZone.get(s.zone) ?? []), s]);
    for (const [zone, list] of byZone) {
      if (!['start', 'hangar', 'barracks', 'power'].includes(zone) && Math.random() < 0.25) continue;
      this.buildAmmo(list[(Math.random() * list.length) | 0]);
    }
  }

  private buildAmmo(spot: AmmoSpot): void {
    const { map, weapons } = this.deps;
    const g = new THREE.Group();
    g.position.copy(spot.pos);
    g.rotation.y = spot.yaw;
    const olive = new THREE.MeshStandardMaterial({ color: 0x4b5532, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23251c, roughness: 0.7, metalness: 0.4 });
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.62, 0.62), olive);
    crate.position.y = 0.31;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.08, 0.66), dark);
    lid.position.y = 0.64;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.22), printedSign(stencilTexture('AMMO $400'), 0.3));
    label.position.set(0, 0.36, 0.315);
    for (const m of [crate, lid]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    g.add(crate, lid, label);
    map.roomGroupAt(spot.pos.x, spot.pos.z).add(g);
    this.deps.physics.addStaticBox(spot.pos.clone().setY(0.34), new THREE.Vector3(0.55, 0.34, 0.31), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, spot.yaw, 0)));
    this.navRefresh.push({ x0: spot.pos.x - 1.2, z0: spot.pos.z - 1.2, x1: spot.pos.x + 1.2, z1: spot.pos.z + 1.2, frames: 2 });
    this.ammoCaches.push(spot.pos.clone().add(new THREE.Vector3(Math.sin(spot.yaw) * 1.1, 0, Math.cos(spot.yaw) * 1.1)).setY(0));
    this.interactables.push({
      pos: spot.pos.clone().setY(0.6),
      radius: 2.0,
      label: () => 'Ammo cache: refill both weapons',
      cost: () => 400,
      use: () => {
        if (!this.spend(400)) return false;
        for (const i of weapons.owned ?? []) if (weapons.weapons[i].reserve !== Infinity) weapons.weapons[i].reserve = weapons.weapons[i].maxReserve;
        this.deps.audio.play('reload.rifle.magin');
        return true;
      },
    });
  }

  /**
   * Validate the map's free wall spots (room to stand in front, not blocked by
   * furniture) and deal them out, spreading each kind over different rooms.
   */
  private pickSpots(): Record<'weapon' | 'med' | 'armor' | 'breaker' | 'crate' | 'turret', WallSpot[]> {
    const { map, nav } = this.deps;
    const ok = map.wallSpots.filter((s) => {
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      return nav.walkable(s.pos.x + fx * 1.4, s.pos.z + fz * 1.4) && nav.walkable(s.pos.x + fx * 2.2, s.pos.z + fz * 2.2);
    });
    ok.sort(() => Math.random() - 0.5);
    const used = new Set<WallSpot>();
    const take = (n: number, prefer?: (s: WallSpot) => boolean): WallSpot[] => {
      const out: WallSpot[] = [];
      const rooms = new Set<string>();
      for (const pass of [0, 1, 2]) {
        for (const s of ok) {
          if (out.length >= n) break;
          if (used.has(s) || (pass === 0 && prefer && !prefer(s)) || (pass < 2 && rooms.has(s.room))) continue;
          used.add(s);
          rooms.add(s.room);
          out.push(s);
        }
      }
      return out;
    };
    const breaker = take(3, (s) => s.room === 'power');
    return {
      breaker,
      weapon: take(10, (s) => s.room !== 'lobby'),
      med: take(5),
      armor: take(3, (s) => s.zone !== 'start'),
      turret: take(5),
      crate: take(5, (s) => s.zone !== 'start'),
    };
  }

  // ---------------------------------------------------------------- hazards

  /** 4 random hazards per game, in different zones beyond the start. */
  private placeHazards(spots: HazardSpot[]): void {
    const pool = spots.filter((s) => !['start', 'lounge', 'security'].includes(s.zone)).sort(() => Math.random() - 0.5);
    const used = new Set<string>();
    const kinds: Hazard['kind'][] = ['electric', 'gas', 'fire'];
    for (const s of pool) {
      if (this.hazards.length >= 4 || used.has(s.zone)) continue;
      used.add(s.zone);
      this.buildHazard(s, kinds[(Math.random() * kinds.length) | 0]);
    }
  }

  private buildHazard(spot: HazardSpot, kind: Hazard['kind']): void {
    const [x0, z0, x1, z1] = spot.rect;
    const w = x1 - x0;
    const d = z1 - z0;
    const color = kind === 'electric' ? 0x3aa0ff : kind === 'gas' ? 0x6ad04a : 0xff7a1a;
    const g = new THREE.Group();
    g.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: kind === 'fire' ? 0x161210 : kind === 'gas' ? 0x2e3a22 : 0x1c2026, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.025;
    floor.receiveShadow = true;
    const glow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.95, d * 0.95), glow);
    glowPlane.rotation.x = -Math.PI / 2;
    glowPlane.position.y = 0.035;
    // Hazard tape border.
    const tape = new THREE.MeshStandardMaterial({ map: tapeTexture(), roughness: 0.6 });
    for (const [bw, bd, bx, bz] of [[w, 0.18, 0, -d / 2], [w, 0.18, 0, d / 2], [0.18, d, -w / 2, 0], [0.18, d, w / 2, 0]] as const) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.02, bd), tape);
      b.position.set(bx, 0.03, bz);
      g.add(b);
    }
    g.add(floor, glowPlane);
    this.deps.map.roomGroupAt(g.position.x, g.position.z).add(g);
    this.hazards.push({ spot, kind, emit: 0, sound: Math.random(), tick: 0, glow });
  }

  private updateHazards(dt: number): void {
    const p = this.deps.player.feet;
    for (const h of this.hazards) {
      const [x0, z0, x1, z1] = h.spot.rect;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const near = Math.hypot(p.x - cx, p.z - cz);
      if (near > 60) continue;
      // Effects.
      h.emit -= dt;
      if (h.emit <= 0) {
        h.emit = h.kind === 'electric' ? 0.12 + Math.random() * 0.35 : h.kind === 'fire' ? 0.03 : 0.05;
        h.spot && this.deps.impacts.hazard(h.kind, x0 + Math.random() * (x1 - x0), z0 + Math.random() * (z1 - z0));
      }
      h.glow.opacity = h.kind === 'electric' ? (Math.random() < 0.15 ? 0.55 : 0.12) : h.kind === 'fire' ? 0.3 + Math.random() * 0.15 : 0.06;
      h.sound -= dt;
      if (near < 22 && h.sound <= 0) {
        h.sound = h.kind === 'electric' ? 0.5 + Math.random() * 0.9 : h.kind === 'fire' ? 0.6 : 1.2;
        this.tmp.set(cx, 0.5, cz);
        this.deps.audio.play(`hazard.${h.kind === 'electric' ? 'zap' : h.kind}`, { position: this.tmp });
      }
      // Damage ticks (player, allies and robots alike).
      h.tick -= dt;
      if (h.tick > 0) continue;
      h.tick = 0.25;
      const dmg = HAZARD_DPS[h.kind] * 0.25;
      this.tmp.set(cx, 0, cz);
      const inside = (v: THREE.Vector3) => v.x > x0 && v.x < x1 && v.z > z0 && v.z < z1;
      if (inside(p) && !this.deps.health.dead) this.deps.hurtPlayer(dmg, this.tmp);
      for (const a of this.allyBodies) if (a.alive && inside(a.pos)) a.hit(dmg * 0.5, this.tmp);
      for (const r of this.robots) if (r.alive && inside(r.pos)) r.body.meleeHit(dmg, this.tmp, 0.15);
    }
  }

  // ---------------------------------------------------------------- interaction

  /** What USE would do right now (for the touch button). */
  get prompt(): { label: string; cost: number; affordable: boolean } | null {
    if (this.over || !this.focus) return null;
    const cost = this.focus.cost();
    return { label: this.focus.label(), cost, affordable: this.points >= cost };
  }

  /** F / USE. */
  interact(): void {
    if (this.over || !this.focus) return;
    this.focus.use();
  }

  private updateFocus(): void {
    if (this.overridePrompt) {
      this.focus = null;
      this.deps.hud.setPrompt(this.overridePrompt, 0, true);
      return;
    }
    const p = this.deps.player;
    const eye = this.tmp.set(p.feet.x, p.feet.y + p.eyeHeight, p.feet.z);
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let best: Interactable | null = null;
    let bestScore = Infinity;
    for (const it of this.interactables) {
      if (it.cost() < 0) continue;
      const dx = it.pos.x - eye.x;
      const dz = it.pos.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > it.radius) continue;
      const facing = d < 0.8 ? 1 : (dx * fx + dz * fz) / d;
      if (facing < 0.35) continue;
      const score = d - facing;
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    this.focus = best;
    this.deps.hud.setPrompt(best ? best.label() : '', best ? best.cost() : 0, best ? this.points >= best.cost() : false);
  }

  // ---------------------------------------------------------------- director

  /** 1 at the start; grows with time and with how much of Site-9 is open. */
  get threat(): number {
    return 1 + this.elapsed / 100 + (this.unlocked.size - 1) * 0.45;
  }

  /** The player cannot see this point (and it is not right next to them). */
  private hidden(pos: THREE.Vector3, minDist = 14): boolean {
    const p = this.deps.player;
    this.eye.set(p.feet.x, p.feet.y + p.eyeHeight, p.feet.z);
    if (this.eye.distanceTo(pos) < minDist) return false;
    const phys = this.deps.physics;
    this.probe.set(pos.x, 1.0, pos.z);
    if (phys.lineOfSight(this.eye, this.probe)) return false;
    this.probe.y = 1.9;
    return !phys.lineOfSight(this.eye, this.probe);
  }

  private pickMobSpawn(): SpawnPoint | null {
    // Half the mobs come for the player's squad, the rest for the AI teams (an even split
    // over four teams left you a quarter: too quiet, and your allies took what came).
    const foci = this.deps.focusProvider?.() ?? [];
    const p = foci.length && Math.random() < 0.5 ? foci[(Math.random() * foci.length) | 0] : this.deps.player.feet;
    const me = this.deps.player.feet;
    // Only from zones the target can be reached from (a bay behind a shut door sends
    // robots nowhere). Lifts are natural entrances (doors open, they step out): 5 m
    // away is enough. Hatches: robots climb out of the floor, so in sight is fine past
    // 10 m. Bays must be out of sight.
    const reach = this.reachable(this.deps.map.zoneAt(p.x, p.z));
    const ok = (kind: SpawnPoint['kind'], d: number, pos: THREE.Vector3) =>
      kind === 'lift' ? d > 5 : kind === 'hatch' ? d > 10 || (d > 8 && this.hidden(pos)) : d > 8 && this.hidden(pos);
    const cands = this.deps.map.spawnPoints
      .filter((s) => this.unlocked.has(s.zone) && (reach.size === 0 || reach.has(s.zone)) && !(s.openTimer && s.openTimer > 0))
      .map((s) => ({ s, d: s.pos.distanceTo(p) }))
      .filter((x) => x.d < 75 && ok(x.s.kind, Math.min(x.d, x.s.pos.distanceTo(me)), x.s.pos))
      .sort((a, b) => a.d - b.d)
      // The nearest several, so mobs come from more directions than the same two bays.
      .slice(0, 7);
    return cands.length ? cands[(Math.random() * cands.length) | 0].s : null;
  }

  private robotStats(): { health: number; speed: number; variant: RobotVariant; damage: number } {
    const t = this.threat;
    const health = (85 + 30 * (t - 1)) * (0.85 + 0.15 * this.skill);
    const sprint = Math.random() < Math.min(0.55, Math.max(0, (t - 2.5) * 0.12 * this.skill));
    const speed = sprint ? 3.4 + Math.random() * 0.6 : Math.min(2.7, 1.35 + 0.12 * t) * (0.85 + Math.random() * 0.3);
    return { health, speed, variant: sprint ? 'runner' : 'normal', damage: 60 };
  }

  /** Match heat 0..1 (the team match sets it): more robots as the clock runs. */
  heat = 0;

  /** Mob member: arrives from a hidden lift / bay / hatch. */
  private queueMobSpawn(): boolean {
    const sp = this.pickMobSpawn();
    if (!sp) return false;
    if (sp.kind === 'lift') {
      this.deps.audio.play('lift.arrive', { position: sp.pos });
      if (sp.light) sp.light.emissiveIntensity = 3;
      sp.openTimer = 3.6; // doors open after the chime, close again after it steps out
    }
    this.pending.push({ sp, t: sp.kind === 'lift' ? 1.1 : 0.2, mob: true });
    return true;
  }

  /** A few powered-down wanderers in a freshly opened zone, out of sight. */
  private populateZone(zone: string, count: number): void {
    const rooms = this.deps.map.rooms.filter((r) => r.zone === zone);
    let placed = 0;
    for (let tries = 0; tries < 40 && placed < count; tries++) {
      const r = rooms[(Math.random() * rooms.length) | 0];
      const x = r.rect[0] + 2 + Math.random() * (r.rect[2] - r.rect[0] - 4);
      const z = r.rect[1] + 2 + Math.random() * (r.rect[3] - r.rect[1] - 4);
      if (!this.deps.nav.walkable(x, z)) continue;
      this.tmp.set(x, 0, z);
      if (!this.hidden(this.tmp, 12)) continue;
      const robot = this.robots.find((o) => !o.active);
      if (!robot) return;
      const { health, damage } = this.robotStats();
      robot.setVariant('normal');
      robot.spawn(this.tmp, health, Math.min(2.6, 1.4 + 0.12 * this.threat), damage, 'idle');
      placed++;
    }
  }

  /** Seconds left of the raid's EMP: robots are down and no new ones come. */
  emp = 0;

  /** The raid's EMP: every robot in the facility shorts out for a while. */
  shortCircuit(seconds: number): void {
    this.emp = Math.max(this.emp, seconds);
    this.wakeQueue.length = 0;
    this.pending.length = 0;
    for (const r of this.robots) if (r.alive) r.shortCircuit(seconds * (0.9 + Math.random() * 0.25));
  }

  private updateDirector(dt: number): void {
    if (this.emp > 0) {
      this.emp -= dt;
      return;
    }
    const p = this.deps.player.feet;
    // Intensity: robots in your face push it up; calm lets it fall.
    let near = 0;
    let aggro = 0;
    for (const r of this.robots) {
      if (!r.aggro) continue;
      aggro++;
      if (r.pos.distanceTo(p) < 6) near++;
    }
    if (near) this.intensity = Math.min(1, this.intensity + near * 0.05 * dt);
    else this.intensity = Math.max(0, this.intensity - dt * (aggro ? 0.03 : 0.06));
    this.recentDamage = Math.max(0, this.recentDamage - dt * 4);

    // Dynamic difficulty: comfortable players get pushed harder, struggling ones get room.
    this.skillTimer -= dt;
    if (this.skillTimer <= 0) {
      this.skillTimer = 8;
      const hp = this.deps.health.health;
      if (hp > 85 && this.intensity < 0.5 && this.recentDamage < 20) this.skill += 0.06;
      else if (hp < 45 || this.recentDamage > 60) this.skill -= 0.1;
      this.skill = Math.min(1.5, Math.max(0.6, this.skill));
    }

    this.phaseTimer -= dt;
    const teams = this.deps.mode === 'teams';
    const mega = this.elapsed < this.megaUntil ? 1.7 : 1;
    // Up to +20% as the match heats up.
    const grow = 1 + 0.2 * this.heat;
    const cap = (teams ? (this.deps.mobile ? 22 : 36) : this.deps.mobile ? 10 : 18) * mega * grow;
    // Between mobs the pressure never fully stops: lone hunters trickle in.
    if (this.phase === 'relax' || this.phase === 'fade') {
      this.trickleTimer -= dt;
      if (this.trickleTimer <= 0) {
        // Team games: a steady stream from the start (the first minutes were too quiet).
        const early = teams && this.elapsed < 150 ? 0.55 : 1;
        this.trickleTimer = Math.max(3, 9 - this.threat * 0.8) * (0.7 + Math.random() * 0.6) * (teams ? 0.5 : 1) * early;
        if (aggro < (2 + this.threat) * (teams ? 3.5 : 1) * grow) this.queueMobSpawn();
      }
    }
    switch (this.phase) {
      case 'relax':
        if (this.phaseTimer <= 0) {
          this.phase = 'buildup';
          this.mobLeft = Math.max(4, Math.min(teams ? 90 : 45, Math.round((4 + this.threat * 2.6) * this.skill * (teams ? 2.2 : 1) * grow)));
          this.spawnTimer = 0.5;
          this.deps.hud.horde();
          this.deps.audio.play('director.horde');
        }
        break;
      case 'buildup':
        this.spawnTimer -= dt;
        if (this.mobLeft > 0 && this.spawnTimer <= 0 && aggro < cap) {
          if (this.queueMobSpawn()) this.mobLeft--;
          this.spawnTimer = 0.45 + Math.random() * 0.6;
        }
        if (this.intensity >= 0.85) {
          this.phase = 'peak';
          this.phaseTimer = 4.5;
        } else if (this.mobLeft === 0) this.phase = 'fade';
        break;
      case 'peak':
        if (this.phaseTimer <= 0) this.phase = this.mobLeft > 0 ? 'buildup' : 'fade';
        break;
      case 'fade':
        if (aggro <= (teams ? 6 : 1) && this.intensity < 0.35) {
          this.phase = 'relax';
          // Team games: short lulls (steady pressure; the trickle keeps going meanwhile).
          this.phaseTimer = Math.max(8, 24 - this.threat * 2.5) * (teams ? 0.6 : 1);
          // Top up the wanderers in opened zones while it is quiet.
          let idle = 0;
          for (const r of this.robots) if (r.dormant) idle++;
          if (idle < (teams ? 14 : 6)) {
            const zones = [...this.unlocked].filter((z) => z !== 'start');
            for (let i = 0; i < (teams ? 3 : 1) && zones.length; i++) this.populateZone(zones[(Math.random() * zones.length) | 0], teams ? 3 : 2);
          }
        }
        break;
    }
  }

  /**
   * Career loadout (ARMORY in the main menu): sidearm and perks. Applied when the
   * raid starts (PLAY), so changes made in the menu count straight away.
   */
  applyCareer(): void {
    raid.reset();
    const prof = loadProfile();
    const sidearm = SIDEARMS.find((w) => w.id === prof.sidearm && prof.owned.includes(w.id))?.weapon ?? 'heavy_pistol';
    this.perks = new Set(prof.perks);
    if (this.perks.has('pockets')) this.addPoints(300);
    if (this.perks.has('plates')) this.deps.health.armor = this.deps.health.maxArmor * 0.5;
    if (sidearm !== 'heavy_pistol') {
      this.deps.weapons.infiniteReserve.add(sidearm);
      this.deps.weapons.startLoadout(sidearm);
    }
  }

  onPlayerDeath(): void {
    if (this.over || this.deps.mode === 'teams') return;
    this.over = true;
    const pay = settleRaid({ mode: 'solo', fate: 'survival', cash: this.points });
    this.deps.hud.gameOver(this.elapsed, this.kills, this.points, pay);
  }

  get activeRobots(): number {
    let n = 0;
    for (const r of this.robots) if (r.aggro) n++;
    return n;
  }

  update(dt: number): void {
    if (!this.over) this.elapsed += dt;
    // Door shutters roll up.
    for (const d of this.doors) {
      if (d.open && d.lift < 1) {
        d.lift = Math.min(1, d.lift + dt * 1.2);
        d.shutter.position.y = d.slot.center.y + d.lift * (d.slot.height + 0.2);
        d.shutter.scale.y = 1 - d.lift * 0.9;
        if (d.lift >= 1) d.shutter.visible = false;
      }
    }
    for (let i = this.navRefresh.length - 1; i >= 0; i--) {
      const r = this.navRefresh[i];
      if (--r.frames <= 0) {
        this.deps.nav.refreshArea(r.x0, r.z0, r.x1, r.z1);
        this.navRefresh.splice(i, 1);
      }
    }
    if (!this.over) this.updateFocus();
    else this.deps.hud.setPrompt('', 0, false);
    this.utilities?.update(dt, this.deps.world?.() ?? []);
    this.builder.update(dt);

    // Arrivals (lift doors take a moment), lift lights fade.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const a = this.pending[i];
      a.t -= dt;
      if (a.t > 0) continue;
      this.pending.splice(i, 1);
      const robot = this.robots.find((o) => !o.active);
      if (!robot) continue;
      const { health, speed, variant, damage } = this.robotStats();
      robot.setVariant(variant);
      const toward = Math.atan2(this.deps.player.feet.x - a.sp.pos.x, this.deps.player.feet.z - a.sp.pos.z);
      robot.spawn(a.sp.pos, health, speed, damage, a.sp.kind === 'hatch' ? 'rise' : 'step', toward);
    }
    for (const sp of this.deps.map.spawnPoints) {
      if (sp.light && sp.light.emissiveIntensity > 0.4) sp.light.emissiveIntensity = Math.max(0.4, sp.light.emissiveIntensity - dt * 1.5);
      if (!sp.doors) continue;
      if (sp.openTimer! > 0) sp.openTimer! -= dt;
      const want = sp.openTimer! > 0 && sp.openTimer! < 3.1 ? 1 : 0;
      sp.open = sp.open! + Math.max(-dt * 2, Math.min(dt * 2, want - sp.open!));
      for (const d of sp.doors) d.position.copy(d.userData.home).addScaledVector(sp.slide!, d.userData.side * sp.open! * 1.15);
    }

    // Wanderers notice you (sight, proximity) and wake their neighbours.
    const p = this.deps.player;
    this.eye.set(p.feet.x, p.feet.y + p.eyeHeight, p.feet.z);
    // Proximity every frame; the sight ray round-robin, each robot ~5 times a second.
    const robots = this.robots;
    this.wakeBudget = Math.min(robots.length, this.wakeBudget + dt * 5 * robots.length);
    let rays = this.wakeBudget | 0;
    this.wakeBudget -= rays;
    if (!this.deps.health.dead) {
      for (const r of robots) if (r.dormant && r.pos.distanceToSquared(p.feet) < 16) r.wake();
      for (; rays > 0 && robots.length; rays--) {
        this.wakeCursor = (this.wakeCursor + 1) % robots.length;
        const r = robots[this.wakeCursor];
        if (r.dormant && r.pos.distanceToSquared(p.feet) < 121 && this.deps.physics.lineOfSight(this.probe.set(r.pos.x, 1.6, r.pos.z), this.eye)) r.wake();
      }
    }
    for (let i = this.wakeQueue.length - 1; i >= 0; i--) {
      const w = this.wakeQueue[i];
      w.t -= dt;
      if (w.t <= 0) {
        w.r.wake();
        this.wakeQueue.splice(i, 1);
      }
    }

    this.updateHazards(dt);
    const targets = [this.playerTarget, ...this.extraTargets];
    for (const r of this.robots) r.update(dt, targets, this.robots);
    if (!this.over) this.updateDirector(dt);
    this.deps.hud.setRound(Math.floor(this.threat));
    this.deps.hud.setRemaining(this.activeRobots);
  }
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let shutterTex: THREE.Texture | null = null;
/**
 * A printed / backlit label: lit by the room like everything else, plus a faint glow of
 * its own so it still reads in the dark (unlit, untonemapped labels glared at night).
 */
function printedSign(map: THREE.Texture, glow: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: glow, roughness: 0.55 });
}

function shutterTexture(): THREE.Texture {
  if (shutterTex) return shutterTex;
  shutterTex = canvas(128, 256, (g) => {
    g.fillStyle = '#9ea3a8';
    g.fillRect(0, 0, 128, 256);
    for (let y = 0; y < 256; y += 16) {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, y, 128, 3);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(0, y + 3, 128, 2);
    }
    for (let x = -256; x < 128; x += 28) {
      g.fillStyle = '#e0a51c';
      g.beginPath();
      g.moveTo(x, 256);
      g.lineTo(x + 14, 256);
      g.lineTo(x + 14 + 24, 226);
      g.lineTo(x + 24, 226);
      g.fill();
    }
    g.fillStyle = '#1b1d20';
    g.fillRect(0, 222, 128, 4);
  });
  return shutterTex;
}

let tapeTex: THREE.Texture | null = null;
function tapeTexture(): THREE.Texture {
  if (tapeTex) return tapeTex;
  tapeTex = canvas(128, 16, (g) => {
    g.fillStyle = '#1b1d20';
    g.fillRect(0, 0, 128, 16);
    g.fillStyle = '#e0a51c';
    for (let x = -16; x < 128; x += 16) {
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x + 8, 16);
      g.lineTo(x + 16, 0);
      g.lineTo(x + 8, 0);
      g.fill();
    }
  });
  tapeTex.wrapS = THREE.RepeatWrapping;
  tapeTex.repeat.set(4, 1);
  return tapeTex;
}

function stencilTexture(text: string): THREE.Texture {
  return canvas(256, 72, (g) => {
    g.fillStyle = 'rgba(0,0,0,0)';
    g.clearRect(0, 0, 256, 72);
    g.fillStyle = '#e8d38a';
    g.font = '800 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 38);
  });
}

function priceTexture(cost: number): THREE.Texture {
  return canvas(256, 80, (g) => {
    g.fillStyle = '#16181b';
    g.fillRect(0, 0, 256, 80);
    g.strokeStyle = '#e0a51c';
    g.lineWidth = 4;
    g.strokeRect(3, 3, 250, 74);
    g.fillStyle = '#e0a51c';
    g.font = '700 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`$ ${cost}`, 128, 42);
  });
}

function buyTexture(name: string, cost: number): THREE.Texture {
  return canvas(512, 96, (g) => {
    g.fillStyle = '#16181b';
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#f0f0f0';
    g.font = '600 38px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(name.toUpperCase(), 18, 50);
    g.fillStyle = '#e0a51c';
    g.textAlign = 'right';
    g.fillText(`$ ${cost}`, 494, 50);
  });
}
