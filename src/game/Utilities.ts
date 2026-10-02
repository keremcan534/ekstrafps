import * as THREE from 'three';
import { GROUPS } from '../core/Physics';
import { getAmmo } from '../weapons/AmmoData';
import { WEAPON_PRICES, type WallSpot } from '../world/Site9';
import type { Combatant } from './TeamAgent';
import type { Interactable, Survival, SurvivalDeps } from './Survival';

export type UtilityKind = 'med' | 'armor' | 'breaker' | 'crate' | 'turret' | 'ammo';

/** Map marker (full map + minimap). */
export interface UtilityMarker {
  kind: UtilityKind;
  x: number;
  z: number;
  /** Turret running / lights cut at this breaker. */
  on?: boolean;
}

export interface Station {
  kind: 'med' | 'armor' | 'breaker';
  spot: WallSpot;
  /** Where to stand to use it. */
  at: THREE.Vector3;
  cost: number;
}

export interface Turret {
  spot: WallSpot;
  at: THREE.Vector3;
  head: THREE.Object3D;
  lamp: THREE.MeshStandardMaterial;
  muzzle: THREE.Vector3;
  cost: number;
  /** Seconds of operation left (0 = idle). */
  time: number;
  team: string;
  owner: object | null;
  target: Combatant | null;
  scan: number;
  cooldown: number;
  yaw: number;
  shots: number;
  /** Deployed from build mode: removed when its time runs out. */
  temp?: { group: THREE.Object3D; collider: { handle: number } };
}

export const PRICES = { med: 400, armor: 1000, restore: 750, crate: 950, turret: 1500 };
const TURRET_TIME = 60;
const TURRET_RANGE = 26;
/** Supply crate odds: better guns are rarer. */
const CRATE_POOL = Object.keys(WEAPON_PRICES).filter((id) => id !== 'heavy_pistol');

function label(text: string, color: string, w = 256, h = 64): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121416';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.strokeRect(3, 3, w - 6, h - 6);
  g.fillStyle = color;
  g.font = `800 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Site-9's usable extras, placed on random free wall spots each game:
 * - medical stations ($400, full heal),
 * - armor lockers ($1000, plates that soak 60% of incoming damage),
 * - power breakers (cut the facility lights, or restore power during a raid),
 * - a supply crate ($950, random weapon; moves after a few uses),
 * - sentry turrets ($1500, 60 s of automatic fire for whoever paid; points go to them).
 * AI operators use the same things with their own money (see Errands).
 */
export class Utilities {
  readonly stations: Station[] = [];
  readonly turrets: Turret[] = [];
  readonly crateSpots: WallSpot[] = [];
  crateAt = 0;
  readonly markers: UtilityMarker[] = [];
  private crate: THREE.Group | null = null;
  private crateIt: Interactable | null = null;
  private crateCollider: { handle: number } | null = null;
  private crateUses = 0;
  private crateLimit = 4;
  private crateMarker: UtilityMarker | null = null;
  private turretMarkers = new Map<Turret, UtilityMarker>();
  private ammo = getAmmo('762x39_ps');
  private mats = {
    white: new THREE.MeshStandardMaterial({ color: 0xe4e8ea, roughness: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.45, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.6, metalness: 0.4 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x4b5532, roughness: 0.85 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.6 }),
    red: new THREE.MeshStandardMaterial({ color: 0x8a1410, roughness: 0.5 }),
    green: new THREE.MeshStandardMaterial({ color: 0x0a2010, emissive: 0x2bdc6a, emissiveIntensity: 1.6 }),
    violet: new THREE.MeshStandardMaterial({ color: 0x150a20, emissive: 0xb070ff, emissiveIntensity: 1.8 }),
  };
  private tmp = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private breakerLevers: THREE.Object3D[] = [];
  private breakerLamps: THREE.MeshStandardMaterial[] = [];

  constructor(
    private sv: Survival,
    private deps: SurvivalDeps,
    spots: { med: WallSpot[]; armor: WallSpot[]; breaker: WallSpot[]; crate: WallSpot[]; turret: WallSpot[] },
  ) {
    for (const s of spots.med) this.buildMed(s);
    for (const s of spots.armor) this.buildArmor(s);
    if (deps.lighting) for (const s of spots.breaker) this.buildBreaker(s);
    for (const s of spots.turret) this.buildTurret(s);
    this.crateSpots.push(...spots.crate);
    if (this.crateSpots.length) {
      this.placeCrate(0);
      this.registerCrate();
    }
    for (const a of sv.ammoCaches) this.markers.push({ kind: 'ammo', x: a.x, z: a.z });
  }

  private front(s: WallSpot, d: number, y = 0): THREE.Vector3 {
    return new THREE.Vector3(s.pos.x + Math.sin(s.yaw) * d, y, s.pos.z + Math.cos(s.yaw) * d);
  }

  private group(s: WallSpot, d: number): THREE.Group {
    const g = new THREE.Group();
    g.position.copy(this.front(s, d));
    g.rotation.y = s.yaw;
    this.deps.map.roomGroupAt(s.pos.x, s.pos.z).add(g);
    return g;
  }

  private mesh(g: THREE.Object3D, mat: THREE.Material, size: [number, number, number], pos: [number, number, number]): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...pos);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  }

  private sign(g: THREE.Object3D, text: string, color: string, pos: [number, number, number], w = 0.8): void {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: label(text, color), toneMapped: false }));
    m.position.set(...pos);
    g.add(m);
  }

  // ---------------------------------------------------------------- stations

  private buildMed(s: WallSpot): void {
    const g = this.group(s, 0.12);
    this.mesh(g, this.mats.white, [0.75, 0.95, 0.24], [0, 1.45, 0]);
    this.mesh(g, this.mats.green, [0.34, 0.1, 0.02], [0, 1.6, 0.13]);
    this.mesh(g, this.mats.green, [0.1, 0.34, 0.02], [0, 1.6, 0.13]);
    this.mesh(g, this.mats.dark, [0.5, 0.18, 0.02], [0, 1.18, 0.13]);
    this.sign(g, `MEDICAL $${PRICES.med}`, '#2bdc6a', [0, 2.1, 0.02]);
    const st: Station = { kind: 'med', spot: s, at: this.front(s, 1.1), cost: PRICES.med };
    this.stations.push(st);
    this.markers.push({ kind: 'med', x: s.pos.x, z: s.pos.z });
    const h = this.deps.health;
    this.sv.addInteractable({
      pos: this.front(s, 0.3, 1.4), radius: 2.2,
      label: () => (h.health >= h.max ? 'Medical station (you are fine)' : 'Medical station: full heal'),
      cost: () => PRICES.med,
      use: () => {
        if (h.health >= h.max || h.dead || h.downed) return false;
        if (!this.sv.spend(PRICES.med)) return false;
        h.health = h.max;
        this.deps.audio.play('reload.rifle.magin', { volume: 0.6 });
        this.deps.toast?.('Patched up: full health');
        return true;
      },
    });
  }

  private buildArmor(s: WallSpot): void {
    const g = this.group(s, 0.3);
    this.mesh(g, this.mats.steel, [0.9, 2.0, 0.5], [0, 1.0, 0]);
    this.mesh(g, this.mats.dark, [0.02, 1.8, 0.02], [0, 1.0, 0.26]);
    this.mesh(g, this.mats.dark, [0.6, 0.45, 0.06], [0, 1.35, 0.27]); // the plate on display
    this.mesh(g, this.mats.stripe, [0.9, 0.08, 0.52], [0, 0.04, 0]);
    this.sign(g, `ARMOR $${PRICES.armor}`, '#9fc4ff', [0, 2.2, 0.26]);
    this.deps.physics.addStaticBox(this.front(s, 0.3, 1.0), new THREE.Vector3(0.45, 1.0, 0.25), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, 0)));
    this.sv.carveNav(this.front(s, 0.3), 1.2);
    const st: Station = { kind: 'armor', spot: s, at: this.front(s, 1.3), cost: PRICES.armor };
    this.stations.push(st);
    this.markers.push({ kind: 'armor', x: s.pos.x, z: s.pos.z });
    const h = this.deps.health;
    this.sv.addInteractable({
      pos: this.front(s, 0.6, 1.3), radius: 2.2,
      label: () => (h.armor >= h.maxArmor ? 'Armor plates (full)' : 'Armor plates: soak 60% of damage'),
      cost: () => PRICES.armor,
      use: () => {
        if (h.armor >= h.maxArmor || h.dead) return false;
        if (!this.sv.spend(PRICES.armor)) return false;
        h.armor = h.maxArmor;
        this.deps.audio.play('impact.armor', { volume: 0.7 });
        this.deps.toast?.('Armor plates on');
        return true;
      },
    });
  }

  private buildBreaker(s: WallSpot): void {
    const lighting = this.deps.lighting!;
    const g = this.group(s, 0.08);
    this.mesh(g, this.mats.steel, [0.7, 0.9, 0.16], [0, 1.45, 0]);
    this.mesh(g, this.mats.stripe, [0.72, 0.06, 0.17], [0, 1.93, 0]);
    this.mesh(g, this.mats.stripe, [0.72, 0.06, 0.17], [0, 0.97, 0]);
    const pivot = new THREE.Group();
    pivot.position.set(0.12, 1.45, 0.1);
    g.add(pivot);
    this.mesh(pivot, this.mats.red, [0.06, 0.32, 0.06], [0, 0.14, 0.03]);
    const lamp = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x2bdc6a, emissiveIntensity: 1.5 });
    this.mesh(g, lamp, [0.08, 0.08, 0.04], [-0.18, 1.7, 0.09]);
    this.sign(g, 'POWER', '#ffd25a', [0, 2.15, 0.02], 0.6);
    this.breakerLevers.push(pivot);
    this.breakerLamps.push(lamp);
    const st: Station = { kind: 'breaker', spot: s, at: this.front(s, 1.1), cost: 0 };
    this.stations.push(st);
    this.markers.push({ kind: 'breaker', x: s.pos.x, z: s.pos.z });
    this.sv.addInteractable({
      pos: this.front(s, 0.3, 1.4), radius: 2.2,
      label: () => `Breaker: ${lighting.breakerAction}`,
      cost: () => (lighting.breakerAction === 'Restore power' ? PRICES.restore : 0),
      use: () => {
        const restoring = lighting.breakerAction === 'Restore power';
        if (restoring && !this.sv.spend(PRICES.restore)) return false;
        const r = lighting.breaker();
        this.deps.audio.play(r === 'cut' ? 'power.down' : 'lift.arrive', { volume: 0.7 });
        if (r === 'restored') this.deps.onPowerRestored?.();
        this.deps.toast?.(r === 'cut' ? 'Lights cut. Flashlight: L' : r === 'restored' ? 'Power restored' : 'Lights back on');
        return true;
      },
    });
  }

  // ---------------------------------------------------------------- supply crate

  private placeCrate(i: number): void {
    if (this.crate) this.crate.removeFromParent();
    this.crateAt = i;
    const s = this.crateSpots[i];
    const g = this.group(s, 0.75);
    this.mesh(g, this.mats.olive, [1.1, 0.7, 0.7], [0, 0.35, 0]);
    this.mesh(g, this.mats.dark, [1.14, 0.08, 0.74], [0, 0.72, 0]);
    this.mesh(g, this.mats.violet, [0.28, 0.28, 0.02], [0, 0.4, 0.36]);
    this.sign(g, `SUPPLY ? $${PRICES.crate}`, '#c890ff', [0, 1.25, 0], 1.0);
    this.crate = g;
    if (this.crateCollider) this.deps.physics.world.removeCollider(this.crateCollider as never, true);
    this.crateCollider = this.deps.physics.addStaticBox(this.front(s, 0.75, 0.37), new THREE.Vector3(0.55, 0.37, 0.35), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, 0)));
    this.crateIt?.pos.copy(this.front(s, 0.75, 0.8));
    this.crateUses = 0;
    this.crateLimit = 3 + ((Math.random() * 3) | 0);
    if (!this.crateMarker) {
      this.crateMarker = { kind: 'crate', x: 0, z: 0 };
      this.markers.push(this.crateMarker);
    }
    this.crateMarker.x = s.pos.x;
    this.crateMarker.z = s.pos.z;
  }

  /** Crate interactable (registered once; follows the crate). */
  private registerCrate(): void {
    const it: Interactable = {
      pos: new THREE.Vector3(),
      radius: 2.2,
      label: () => 'Supply crate: random weapon',
      cost: () => PRICES.crate,
      use: () => {
        if (!this.sv.spend(PRICES.crate)) return false;
        const id = this.rollCrate();
        this.deps.weapons.giveWeapon(id);
        this.deps.toast?.(`Supply crate: ${id.replace(/_/g, ' ').toUpperCase()}`);
        this.usedCrate();
        return true;
      },
    };
    it.pos.copy(this.front(this.crateSpots[this.crateAt], 0.75, 0.8));
    this.crateIt = it;
    this.sv.addInteractable(it);
  }

  /** Where the crate is now (AI errands). */
  get crateStand(): THREE.Vector3 | null {
    return this.crateSpots.length ? this.front(this.crateSpots[this.crateAt], 1.6) : null;
  }

  rollCrate(): string {
    // Weighted: cheap guns twice as likely as the best ones.
    const w = CRATE_POOL.map((id) => 1 / Math.sqrt(WEAPON_PRICES[id]));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < CRATE_POOL.length; i++) if ((r -= w[i]) <= 0) return CRATE_POOL[i];
    return CRATE_POOL[0];
  }

  usedCrate(): void {
    this.deps.audio.play('equip.rifle', { position: this.crate?.position });
    if (++this.crateUses >= this.crateLimit && this.crateSpots.length > 1) {
      let i = this.crateAt;
      while (i === this.crateAt) i = (Math.random() * this.crateSpots.length) | 0;
      this.deps.audio.play('lift.arrive', { position: this.crate?.position });
      this.deps.toast?.('The supply crate has moved (check the map)');
      this.placeCrate(i);
    }
  }

  // ---------------------------------------------------------------- sentries

  /** Build mode: a tripod sentry at `at`, running for `time` s, then packed away. */
  deploy(at: THREE.Vector3, yaw: number, team: string, owner: object | null, time: number): void {
    const g = new THREE.Group();
    g.position.copy(at);
    g.rotation.y = yaw;
    this.deps.map.roomGroupAt(at.x, at.z).add(g);
    const { head, lamp } = this.turretRig(g);
    const collider = this.deps.physics.addStaticBox(this.tmp.set(at.x, 0.7, at.z), new THREE.Vector3(0.3, 0.7, 0.3));
    const spot: WallSpot = { pos: at.clone(), yaw, room: '', zone: '' };
    const t: Turret = {
      spot, at: at.clone(), head, lamp, muzzle: new THREE.Vector3(), cost: 0,
      time: 0, team: '', owner: null, target: null, scan: 0, cooldown: 0, yaw: 0, shots: 0, temp: { group: g, collider },
    };
    this.turrets.push(t);
    const marker: UtilityMarker = { kind: 'turret', x: at.x, z: at.z, on: true };
    this.markers.push(marker);
    this.turretMarkers.set(t, marker);
    this.activate(t, team, owner);
    t.time = time;
  }

  /** Deployed sentries a team has running. */
  deployed(team: string): number {
    return this.turrets.filter((t) => t.temp && t.team === team && t.time > 0).length;
  }

  private turretRig(g: THREE.Group): { head: THREE.Group; lamp: THREE.MeshStandardMaterial } {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = this.mesh(g, this.mats.dark, [0.05, 0.9, 0.05], [Math.sin(a) * 0.22, 0.42, Math.cos(a) * 0.22]);
      leg.rotation.set(Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35);
    }
    this.mesh(g, this.mats.steel, [0.18, 0.2, 0.18], [0, 0.9, 0]);
    const head = new THREE.Group();
    head.position.set(0, 1.12, 0);
    g.add(head);
    this.mesh(head, this.mats.steel, [0.36, 0.26, 0.5], [0, 0, 0]);
    this.mesh(head, this.mats.dark, [0.4, 0.06, 0.52], [0, 0.15, 0]);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.55, 8), this.mats.dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, 0.5);
    head.add(barrel);
    const lamp = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0xff2a1a, emissiveIntensity: 0.05 });
    this.mesh(head, lamp, [0.06, 0.06, 0.02], [0.1, 0.06, 0.26]);
    return { head, lamp };
  }

  private buildTurret(s: WallSpot): void {
    const g = this.group(s, 1.0);
    const { head, lamp } = this.turretRig(g);
    this.sign(g, `SENTRY $${PRICES.turret}`, '#ff8a5c', [0, 1.7, 0], 0.8);
    this.deps.physics.addStaticBox(this.front(s, 1.0, 0.7), new THREE.Vector3(0.3, 0.7, 0.3));
    this.sv.carveNav(this.front(s, 1.0), 1.0);
    const t: Turret = {
      spot: s, at: this.front(s, 2.0), head, lamp, muzzle: new THREE.Vector3(), cost: PRICES.turret,
      time: 0, team: '', owner: null, target: null, scan: 0, cooldown: 0, yaw: 0, shots: 0,
    };
    this.turrets.push(t);
    const marker: UtilityMarker = { kind: 'turret', x: s.pos.x, z: s.pos.z, on: false };
    this.markers.push(marker);
    this.turretMarkers.set(t, marker);
    this.sv.addInteractable({
      pos: this.front(s, 1.0, 1.1), radius: 2.4,
      label: () => (t.time > 0 ? `Sentry running (${t.team === 'alpha' ? 'yours' : t.team}) ${Math.ceil(t.time)}s` : 'Activate sentry (60 s)'),
      cost: () => (t.time > 0 ? -1 : PRICES.turret),
      use: () => {
        if (t.time > 0 || !this.sv.spend(PRICES.turret)) return false;
        this.activate(t, 'alpha', this.deps.player);
        return true;
      },
    });
  }

  /** Someone paid: the sentry fights for their team for a minute. */
  activate(t: Turret, team: string, owner: object | null): void {
    t.time = TURRET_TIME;
    t.team = team;
    t.owner = owner;
    t.target = null;
    t.lamp.emissiveIntensity = 2.5;
    this.turretMarkers.get(t)!.on = true;
    this.deps.audio.play('robot.boot', { position: t.head.getWorldPosition(this.tmp) });
  }

  update(dt: number, world: Combatant[]): void {
    // Breaker lamps: green = power on, red = cut / grid down.
    const dark = this.deps.lighting?.dark ?? false;
    for (const m of this.breakerLamps) m.emissive.setHex(dark ? 0xff2a1a : 0x2bdc6a);
    for (const l of this.breakerLevers) l.rotation.x += ((dark ? 2.6 : 0) - l.rotation.x) * Math.min(1, dt * 10);

    for (const t of [...this.turrets]) {
      if (t.time <= 0) continue;
      t.time -= dt;
      if (t.time <= 0) {
        t.lamp.emissiveIntensity = 0.05;
        this.turretMarkers.get(t)!.on = false;
        this.deps.audio.play('robot.death', { position: t.head.getWorldPosition(this.tmp), volume: 0.4 });
        if (t.temp) {
          // A deployed sentry packs itself away.
          t.temp.group.removeFromParent();
          this.deps.physics.world.removeCollider(t.temp.collider as never, true);
          this.turrets.splice(this.turrets.indexOf(t), 1);
          this.markers.splice(this.markers.indexOf(this.turretMarkers.get(t)!), 1);
          this.turretMarkers.delete(t);
        }
        continue;
      }
      t.head.getWorldPosition(this.eye);
      t.scan -= dt;
      if (t.scan <= 0 || (t.target && (!t.target.alive || t.target.downed))) {
        t.scan = 0.25;
        let best: Combatant | null = null;
        let bd = TURRET_RANGE * TURRET_RANGE;
        for (const c of world) {
          if (c.team === t.team || !c.alive || c.downed) continue;
          const d = c.pos.distanceToSquared(this.eye);
          if (d > bd) continue;
          if (!this.deps.physics.lineOfSight(this.eye, c.aim, GROUPS.sight)) continue;
          bd = d;
          best = c;
        }
        t.target = best;
      }
      const c = t.target;
      if (!c) continue;
      // Swing the head round (in the mount's local frame), fire once roughly on target.
      const want = Math.atan2(c.aim.x - this.eye.x, c.aim.z - this.eye.z) - t.spot.yaw;
      let dy = want - t.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      t.yaw += Math.max(-dt * 5, Math.min(dt * 5, dy));
      t.head.rotation.y = t.yaw;
      t.cooldown -= dt;
      if (Math.abs(dy) > 0.12 || t.cooldown > 0) continue;
      t.cooldown = 0.11;
      this.dir.subVectors(c.aim, this.eye).normalize();
      this.dir.x += (Math.random() - 0.5) * 0.02;
      this.dir.y += (Math.random() - 0.5) * 0.02;
      this.dir.z += (Math.random() - 0.5) * 0.02;
      this.dir.normalize();
      t.muzzle.copy(this.eye).addScaledVector(this.dir, 0.8);
      const ally = t.team === 'alpha';
      this.deps.weapons.projectiles.fire(t.muzzle, this.dir, 715, this.ammo, 0, t.shots++ % 3 === 0, true, t.owner, !ally, ally, t.team);
      this.deps.impacts.muzzleBlast(t.muzzle, this.dir, 0.8);
      this.deps.audio.play('ak.fire', { position: t.muzzle, volume: 0.75 });
    }
  }
}
