import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OBSTACLES, obstacleAt, type Obstacle } from './Obstacles';
import type { Survival, SurvivalDeps } from './Survival';
import type { Combatant } from './TeamAgent';

export type BuildKind = 'barricade' | 'trap' | 'sentry';

export const BUILD_ITEMS: Record<BuildKind, { name: string; cost: number; max: number }> = {
  barricade: { name: 'Barricade', cost: 300, max: 4 },
  trap: { name: 'Shock trap', cost: 250, max: 3 },
  sentry: { name: 'Sentry', cost: 1200, max: 1 },
};
const ORDER: (BuildKind | null)[] = [null, 'barricade', 'trap', 'sentry'];

const BAR_W = 2.4;
const BAR_H = 1.3;
const BAR_T = 0.3;
const BAR_HP = 900;
const TRAP_R = 1.3;
const TRAP_CHARGES = 40;
const SENTRY_TIME = 45;
const STEEL = new THREE.Color(0x59606a);
const RUST = new THREE.Color(0x3a2418);

interface Barricade extends Obstacle {
  group: THREE.Group;
  collider: RAPIER.Collider;
  hp: number;
  lastHit: number;
  crack: THREE.MeshStandardMaterial;
}

interface Trap {
  pos: THREE.Vector3;
  group: THREE.Group;
  glow: THREE.MeshStandardMaterial;
  charges: number;
  tick: number;
}

/**
 * Build mode (J / BUILD button): put up barricades (block bullets and bodies;
 * robots chew through them, enemy soldiers breach them), shock traps on the
 * floor, and a portable sentry. Paid from your own wallet; a few of each at a time.
 */
export class Builder {
  mode: BuildKind | null = null;
  private barricades: Barricade[] = [];
  private traps: Trap[] = [];
  private ghosts = new Map<BuildKind, THREE.Group>();
  private ghostOk: THREE.MeshBasicMaterial;
  private ghostBad: THREE.MeshBasicMaterial;
  private at = new THREE.Vector3();
  private yaw = 0;
  private valid = false;
  private time = 0;
  private tmp = new THREE.Vector3();
  private mats = {
    steel: new THREE.MeshStandardMaterial({ color: 0x59606a, roughness: 0.5, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.7, metalness: 0.3 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.6 }),
    sand: new THREE.MeshStandardMaterial({ color: 0x7d6f55, roughness: 1 }),
  };
  onChange: (() => void) | null = null;

  constructor(
    private sv: Survival,
    private deps: SurvivalDeps,
    private world: () => Combatant[],
  ) {
    this.ghostOk = new THREE.MeshBasicMaterial({ color: 0x2bff7a, transparent: true, opacity: 0.35, depthWrite: false });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.35, depthWrite: false });
  }

  get active(): boolean {
    return this.mode !== null;
  }

  /** J: off → barricade → trap → sentry → off. */
  cycle(): void {
    this.mode = ORDER[(ORDER.indexOf(this.mode) + 1) % ORDER.length];
    for (const [k, g] of this.ghosts) g.visible = k === this.mode;
    if (this.mode) {
      const it = BUILD_ITEMS[this.mode];
      this.deps.toast?.(`BUILD: ${it.name} $${it.cost} · F place · J next`);
    } else this.deps.toast?.('Build mode off');
    this.onChange?.();
  }

  exit(): void {
    this.mode = null;
    for (const g of this.ghosts.values()) g.visible = false;
    this.onChange?.();
  }

  /** Touch USE button / HUD line. */
  get prompt(): { label: string; cost: number; affordable: boolean } | null {
    if (!this.mode) return null;
    const it = BUILD_ITEMS[this.mode];
    return { label: this.valid ? `Place ${it.name}` : 'No room here', cost: it.cost, affordable: this.valid && this.sv.points >= it.cost };
  }

  private count(kind: BuildKind): number {
    if (kind === 'barricade') return this.barricades.length;
    if (kind === 'trap') return this.traps.length;
    return this.sv.utilities?.deployed('alpha') ?? 0;
  }

  /** F: build the selected item at the ghost. */
  place(): boolean {
    const kind = this.mode;
    if (!kind) return false;
    const it = BUILD_ITEMS[kind];
    if (!this.valid) {
      this.deps.toast?.('Not enough room here');
      return false;
    }
    if (this.count(kind) >= it.max) {
      this.deps.toast?.(`${it.name}: max ${it.max} at a time`);
      return false;
    }
    if (!this.sv.spend(it.cost)) return false;
    const at = this.at.clone();
    if (kind === 'barricade') this.buildBarricade(at, this.yaw);
    else if (kind === 'trap') this.buildTrap(at);
    else this.sv.utilities?.deploy(at, this.yaw + Math.PI, 'alpha', this.deps.player, SENTRY_TIME);
    this.deps.audio.play('reload.rifle.boltback', { position: at, volume: 0.9 });
    return true;
  }

  // ---------------------------------------------------------------- pieces

  private roomGroup(at: THREE.Vector3): THREE.Object3D {
    return this.deps.map.roomGroupAt(at.x, at.z);
  }

  private box(g: THREE.Object3D, mat: THREE.Material, size: [number, number, number], pos: [number, number, number], rotY = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...pos);
    m.rotation.y = rotY;
    m.castShadow = !this.deps.mobile;
    m.receiveShadow = true;
    g.add(m);
    return m;
  }

  private barricadeRig(g: THREE.Group, mat?: THREE.Material): THREE.MeshStandardMaterial {
    const crack = new THREE.MeshStandardMaterial({ color: 0x59606a, roughness: 0.5, metalness: 0.6 });
    // Sandbag base, a steel plate wall, a hazard stripe and braces behind it.
    for (let i = 0; i < 4; i++) this.box(g, mat ?? this.mats.sand, [0.62, 0.22, 0.42], [-0.9 + i * 0.6, 0.11, 0.05]);
    for (let i = 0; i < 3; i++) this.box(g, mat ?? this.mats.sand, [0.62, 0.2, 0.4], [-0.6 + i * 0.6, 0.32, 0.05]);
    this.box(g, mat ?? crack, [BAR_W, BAR_H - 0.3, 0.06], [0, 0.3 + (BAR_H - 0.3) / 2, -0.1]);
    this.box(g, mat ?? this.mats.stripe, [BAR_W, 0.08, 0.08], [0, BAR_H - 0.02, -0.1]);
    for (const x of [-1.05, 0, 1.05]) this.box(g, mat ?? this.mats.dark, [0.08, BAR_H, 0.08], [x, BAR_H / 2, -0.06]);
    for (const x of [-0.8, 0.8]) {
      const brace = this.box(g, mat ?? this.mats.dark, [0.06, 1.2, 0.06], [x, 0.55, 0.25]);
      brace.rotation.x = -0.55;
    }
    return crack;
  }

  private trapRig(g: THREE.Group, mat?: THREE.Material): THREE.MeshStandardMaterial {
    const glow = new THREE.MeshStandardMaterial({ color: 0x06141c, emissive: 0x30d0ff, emissiveIntensity: 0.6 });
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(TRAP_R * 0.85, TRAP_R * 0.9, 0.05, 20), mat ?? this.mats.dark);
    plate.position.y = 0.025;
    g.add(plate);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(TRAP_R * 0.7, 0.025, 6, 28), mat ?? glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      this.box(g, mat ?? this.mats.steel, [0.12, 0.1, 0.12], [Math.sin(a) * TRAP_R * 0.75, 0.07, Math.cos(a) * TRAP_R * 0.75]);
    }
    this.box(g, mat ?? this.mats.stripe, [0.3, 0.08, 0.2], [0, 0.08, 0]);
    return glow;
  }

  private ghost(kind: BuildKind): THREE.Group {
    let g = this.ghosts.get(kind);
    if (g) return g;
    g = new THREE.Group();
    if (kind === 'barricade') this.barricadeRig(g, this.ghostOk);
    else if (kind === 'trap') this.trapRig(g, this.ghostOk);
    else {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.3, 10), this.ghostOk);
      m.position.y = 0.65;
      g.add(m);
    }
    g.traverse((o) => {
      (o as THREE.Mesh).castShadow = false;
      o.renderOrder = 5;
    });
    this.deps.scene.add(g);
    this.ghosts.set(kind, g);
    return g;
  }

  private buildBarricade(at: THREE.Vector3, yaw: number): void {
    const g = new THREE.Group();
    g.position.copy(at);
    g.rotation.y = yaw;
    const crack = this.barricadeRig(g);
    this.roomGroup(at).add(g);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const b: Barricade = {
      x: at.x, z: at.z, hx: BAR_W / 2, hz: BAR_T / 2 + 0.1, cos: Math.cos(yaw), sin: Math.sin(yaw), alive: true, team: 'alpha',
      group: g, collider: null as unknown as RAPIER.Collider, hp: BAR_HP, lastHit: -9, crack,
      damage: (n) => this.hurt(b, n),
    };
    b.collider = this.deps.physics.addStaticBox(this.tmp.set(at.x, BAR_H / 2, at.z), new THREE.Vector3(BAR_W / 2, BAR_H / 2, BAR_T / 2), q, {
      surface: 'metal',
      allowDecals: true,
      decalParent: g,
      onBulletHit: (hit) => {
        // Enemy fire wears it down (your own team's doesn't).
        if (hit.team !== 'alpha') this.hurt(b, hit.damage * 0.6);
      },
    });
    this.barricades.push(b);
    OBSTACLES.push(b);
  }

  private hurt(b: Barricade, n: number): void {
    if (!b.alive) return;
    b.hp -= n;
    const k = Math.max(0, b.hp / BAR_HP);
    b.crack.color.lerpColors(RUST, STEEL, k);
    if (this.time - b.lastHit > 0.35) {
      b.lastHit = this.time;
      this.deps.audio.play('impact.metal', { position: this.tmp.set(b.x, 0.9, b.z) });
    }
    if (b.hp <= 0) this.destroy(b);
  }

  private destroy(b: Barricade): void {
    b.alive = false;
    b.group.removeFromParent();
    this.deps.physics.world.removeCollider(b.collider, true);
    this.barricades.splice(this.barricades.indexOf(b), 1);
    OBSTACLES.splice(OBSTACLES.indexOf(b), 1);
    this.tmp.set(b.x, 0.6, b.z);
    this.deps.audio.play('robot.fall', { position: this.tmp });
    this.deps.impacts.explosion(this.tmp);
    this.deps.toast?.('A barricade went down');
  }

  private buildTrap(at: THREE.Vector3): void {
    const g = new THREE.Group();
    g.position.copy(at);
    const glow = this.trapRig(g);
    this.roomGroup(at).add(g);
    this.traps.push({ pos: at, group: g, glow, charges: TRAP_CHARGES, tick: 0 });
  }

  // ---------------------------------------------------------------- frame

  update(dt: number): void {
    this.time += dt;
    // Ghost in front of you, snapped to the ground.
    if (this.mode) {
      const p = this.deps.player.feet;
      const yaw = this.deps.player.yaw;
      const d = this.mode === 'barricade' ? 2.4 : 2.0;
      this.at.set(p.x - Math.sin(yaw) * d, 0, p.z - Math.cos(yaw) * d);
      this.yaw = yaw;
      this.valid = this.canPlace(this.mode);
      const g = this.ghost(this.mode);
      g.visible = true;
      g.position.copy(this.at);
      g.rotation.y = yaw;
      const mat = this.valid ? this.ghostOk : this.ghostBad;
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = mat;
      });
    }
    // Traps: zap whatever hostile stands on them.
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const t = this.traps[i];
      t.glow.emissiveIntensity = 0.5 + Math.sin(this.time * 6 + i) * 0.2;
      t.tick -= dt;
      if (t.tick > 0) continue;
      t.tick = 0.4;
      let hit = false;
      for (const r of this.sv.robots) {
        if (!r.alive || Math.hypot(r.pos.x - t.pos.x, r.pos.z - t.pos.z) > TRAP_R) continue;
        r.body.meleeHit(24, t.pos, 0.2);
        if (!r.alive) this.sv.award('alpha', 40, this.deps.player);
        hit = true;
      }
      for (const c of this.world()) {
        if (c.kind !== 'soldier' || c.team === 'alpha' || !c.alive || c.downed) continue;
        if (Math.hypot(c.pos.x - t.pos.x, c.pos.z - t.pos.z) > TRAP_R) continue;
        c.hit(16, t.pos);
        hit = true;
      }
      if (!hit) continue;
      t.charges--;
      t.glow.emissiveIntensity = 3;
      this.deps.impacts.hazard('electric', t.pos.x + (Math.random() - 0.5), t.pos.z + (Math.random() - 0.5));
      this.deps.audio.play('hazard.zap', { position: this.tmp.set(t.pos.x, 0.3, t.pos.z) });
      if (t.charges <= 0) {
        t.group.removeFromParent();
        this.traps.splice(i, 1);
        this.deps.toast?.('A shock trap burned out');
      }
    }
  }

  private canPlace(kind: BuildKind): boolean {
    const nav = this.deps.nav;
    const a = this.at;
    const p = this.deps.player.feet;
    if (!nav.walkable(a.x, a.z)) return false;
    if (kind === 'barricade') {
      const cx = Math.cos(this.yaw);
      const sx = -Math.sin(this.yaw);
      for (const s of [-1, 1]) if (!nav.walkable(a.x + cx * s * 1.0, a.z + sx * s * 1.0)) return false;
      if (Math.hypot(a.x - p.x, a.z - p.z) < 1.4) return false;
    }
    // Not on top of another build.
    if (obstacleAt(a.x, a.z, kind === 'barricade' ? 0.6 : 0.9)) return false;
    for (const t of this.traps) if (Math.hypot(t.pos.x - a.x, t.pos.z - a.z) < TRAP_R * 2) return false;
    return true;
  }
}
