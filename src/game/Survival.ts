import * as THREE from 'three';
import type { Physics, RAPIER } from '../core/Physics';
import type { Site9, SpawnPoint, WallBuy } from '../world/Site9';
import type { DoorSlot } from '../world/LayoutBuilder';
import type { NavGrid } from '../ai/NavGrid';
import type { WeaponController } from '../weapons/WeaponController';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerHealth } from '../player/PlayerHealth';
import type { AudioSystem } from '../audio/AudioSystem';
import { buildWeaponModel } from '../weapons/WeaponModels';
import { RogueRobot, type MeleeTarget } from '../enemies/RogueRobot';
import type { SurvivalHUD } from '../ui/SurvivalHUD';

export interface SurvivalDeps {
  map: Site9;
  physics: Physics;
  scene: THREE.Scene;
  nav: NavGrid;
  weapons: WeaponController;
  player: PlayerController;
  health: PlayerHealth;
  audio: AudioSystem;
  hud: SurvivalHUD;
  mobile: boolean;
  /** Damage the player (with all hit feedback). */
  hurtPlayer(damage: number, from: THREE.Vector3): void;
  /** Hire an allied operator at this position (Vanta contractor). */
  hireAlly?(at: THREE.Vector3): boolean;
}

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

interface Interactable {
  pos: THREE.Vector3;
  radius: number;
  label(): string;
  cost(): number;
  use(): boolean;
}

type DirectorPhase = 'relax' | 'buildup' | 'peak' | 'fade';

const START_POINTS = 500;
const POINTS = { hit: 10, kill: 60, headKill: 100 };

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
  points = START_POINTS;
  readonly unlocked = new Set<string>(['start']);
  readonly doors: Door[] = [];
  readonly robots: RogueRobot[] = [];
  private interactables: Interactable[] = [];
  private focus: Interactable | null = null;
  private over = false;
  private kills = 0;
  private elapsed = 0;
  // Director
  private phase: DirectorPhase = 'relax';
  private phaseTimer = 18; // a calm start
  intensity = 0;
  skill = 1;
  private skillTimer = 0;
  private recentDamage = 0;
  private mobLeft = 0;
  private spawnTimer = 0;
  private pending: { sp: SpawnPoint; t: number; mob: boolean }[] = [];
  private wakeQueue: { r: RogueRobot; t: number }[] = [];
  private playerTarget: MeleeTarget;
  extraTargets: MeleeTarget[] = [];
  private navRefresh: { x0: number; z0: number; x1: number; z1: number; frames: number }[] = [];
  private tmp = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private probe = new THREE.Vector3();

  constructor(private deps: SurvivalDeps) {
    const { map, physics, scene, nav, mobile } = deps;
    this.playerTarget = {
      pos: deps.player.feet,
      get alive() {
        return !deps.health.dead;
      },
      hit: (d, from) => deps.hurtPlayer(d, from),
    };
    for (const slot of map.doors) this.buildDoor(slot);
    for (const wb of map.wallBuys) this.buildWallBuy(wb);
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
    const pool = mobile ? 14 : 24;
    for (let i = 0; i < pool; i++) {
      this.robots.push(
        new RogueRobot(physics, scene, nav, {
          onDamage: (_r, info) => {
            if (!info.hit.hostile && !info.hit.ally) this.addPoints(POINTS.hit);
          },
          onDeath: (r, info) => {
            this.kills++;
            if (r.pos.distanceTo(deps.player.feet) < 12) this.intensity = Math.min(1, this.intensity + 0.04);
            if (!info.hit.hostile && !info.hit.ally) this.addPoints(info.zone === 'head' ? POINTS.headKill : POINTS.kill);
          },
          onAttack: (r) => deps.audio.play('robot.stagger', { position: r.pos, volume: 0.6 }),
          onThud: (at, s) => deps.audio.play('robot.fall', { position: at, volume: 0.25 + 0.5 * s }),
          onWake: (r) => {
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
    deps.weapons.startLoadout('heavy_pistol');
    deps.hud.setPoints(this.points);
    deps.hud.setRound(1);
  }

  // ---------------------------------------------------------------- economy

  addPoints(n: number): void {
    this.points += n;
    this.deps.hud.setPoints(this.points, n);
  }

  private spend(n: number): boolean {
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
    const steel = new THREE.MeshStandardMaterial({ map: shutterTexture(), color: 0xc9ced4, metalness: 0.6, roughness: 0.45 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.14), steel);
    panel.position.y = h / 2;
    panel.castShadow = true;
    panel.receiveShadow = true;
    shutter.add(panel);
    const sign = new THREE.MeshBasicMaterial({ map: priceTexture(link.cost ?? 0), toneMapped: false });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), sign);
      m.position.set(0, Math.min(h - 0.5, 1.9), s * 0.08);
      m.rotation.y = s > 0 ? 0 : Math.PI;
      shutter.add(m);
    }
    map.group.add(shutter);
    const half = slot.alongX ? new THREE.Vector3(w / 2, h / 2, 0.12) : new THREE.Vector3(0.12, h / 2, w / 2);
    const collider = physics.addStaticBox(this.tmp.copy(slot.center).setY(h / 2), half);
    const door: Door = {
      slot, cost: link.cost ?? 0, zones: [ra.zone, rb.zone], to: [ra.name, rb.name], open: false, collider, shutter, lift: 0,
    };
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

  private openDoor(door: Door): void {
    door.open = true;
    this.deps.physics.world.removeCollider(door.collider, true);
    const fresh = door.zones.filter((z) => !this.unlocked.has(z));
    for (const z of door.zones) this.unlocked.add(z);
    this.deps.audio.play('reload.rifle.boltback', { position: door.slot.center, volume: 1 });
    this.deps.audio.play('robot.fall', { position: door.slot.center, volume: 0.5 });
    const c = door.slot.center;
    const r = door.slot.width / 2 + 1;
    // The nav grid sees the opening after the next physics step.
    this.navRefresh.push({ x0: c.x - r, z0: c.z - r, x1: c.x + r, z1: c.z + r, frames: 2 });
    for (const z of fresh) this.populateZone(z, 2 + ((Math.random() * 3) | 0));
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
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.28), new THREE.MeshBasicMaterial({ map: buyTexture(data.name, wb.cost), toneMapped: false }));
    label.position.copy(wb.pos).addScaledVector(n, 0.025).setY(wb.pos.y - 0.55);
    label.rotation.y = wb.yaw;
    const rig = buildWeaponModel(data.model);
    rig.leftHand.visible = false;
    rig.rightHand.visible = false;
    rig.root.traverse((o) => {
      o.frustumCulled = true;
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    rig.root.position.copy(wb.pos).addScaledVector(n, 0.12);
    rig.root.rotation.y = wb.yaw - Math.PI / 2;
    map.group.add(board, label, rig.root);
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

  // ---------------------------------------------------------------- interaction

  /** F / USE. */
  interact(): void {
    if (this.over || !this.focus) return;
    this.focus.use();
  }

  private updateFocus(): void {
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
    return 1 + this.elapsed / 150 + (this.unlocked.size - 1) * 0.4;
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
    const p = this.deps.player.feet;
    // Lifts are natural entrances (doors open, they step out), so they only need
    // some distance; bays and hatches must be out of sight.
    const cands = this.deps.map.spawnPoints
      .filter((s) => this.unlocked.has(s.zone) && !(s.openTimer && s.openTimer > 0))
      .map((s) => ({ s, d: s.pos.distanceTo(p) }))
      .filter((x) => x.d < 60 && (x.s.kind === 'lift' ? x.d > 8 : this.hidden(x.s.pos)))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    return cands.length ? cands[(Math.random() * cands.length) | 0].s : null;
  }

  private robotStats(): { health: number; speed: number } {
    const t = this.threat;
    const health = (85 + 30 * (t - 1)) * (0.85 + 0.15 * this.skill);
    const sprint = Math.random() < Math.min(0.55, Math.max(0, (t - 2.5) * 0.12 * this.skill));
    const speed = sprint ? 3.4 + Math.random() * 0.6 : Math.min(2.7, 1.35 + 0.12 * t) * (0.85 + Math.random() * 0.3);
    return { health, speed };
  }

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
      const { health } = this.robotStats();
      robot.spawn(this.tmp, health, Math.min(2.6, 1.4 + 0.12 * this.threat), 60, 'idle');
      placed++;
    }
  }

  private updateDirector(dt: number): void {
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
    const cap = this.deps.mobile ? 10 : 18;
    switch (this.phase) {
      case 'relax':
        if (this.phaseTimer <= 0) {
          this.phase = 'buildup';
          this.mobLeft = Math.max(3, Math.min(40, Math.round((3 + this.threat * 2.2) * this.skill)));
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
        if (aggro <= 1 && this.intensity < 0.35) {
          this.phase = 'relax';
          this.phaseTimer = Math.max(14, 36 - this.threat * 3);
          // Top up the wanderers in opened zones while it is quiet.
          let idle = 0;
          for (const r of this.robots) if (r.dormant) idle++;
          if (idle < 6) {
            const zones = [...this.unlocked].filter((z) => z !== 'start');
            if (zones.length) this.populateZone(zones[(Math.random() * zones.length) | 0], 2);
          }
        }
        break;
    }
  }

  onPlayerDeath(): void {
    if (this.over) return;
    this.over = true;
    this.deps.hud.gameOver(this.elapsed, this.kills, this.points);
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

    // Arrivals (lift doors take a moment), lift lights fade.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const a = this.pending[i];
      a.t -= dt;
      if (a.t > 0) continue;
      this.pending.splice(i, 1);
      const robot = this.robots.find((o) => !o.active);
      if (!robot) continue;
      const { health, speed } = this.robotStats();
      const toward = Math.atan2(this.deps.player.feet.x - a.sp.pos.x, this.deps.player.feet.z - a.sp.pos.z);
      robot.spawn(a.sp.pos, health, speed, 60, a.sp.kind === 'hatch' ? 'rise' : 'step', toward);
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
    for (const r of this.robots) {
      if (!r.dormant || this.deps.health.dead) continue;
      const d = r.pos.distanceTo(p.feet);
      if (d < 4 || (d < 11 && this.deps.physics.lineOfSight(this.probe.set(r.pos.x, 1.6, r.pos.z), this.eye))) r.wake();
    }
    for (let i = this.wakeQueue.length - 1; i >= 0; i--) {
      const w = this.wakeQueue[i];
      w.t -= dt;
      if (w.t <= 0) {
        w.r.wake();
        this.wakeQueue.splice(i, 1);
      }
    }

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
function shutterTexture(): THREE.Texture {
  if (shutterTex) return shutterTex;
  shutterTex = canvas(128, 256, (g) => {
    g.fillStyle = '#c4c9cf';
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
