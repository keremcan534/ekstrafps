import * as THREE from 'three';
import type { Game } from '../../../src/core/Game';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../../src/enemies/Soldier';

/**
 * Trailer staging only (the game has no blood): the dead after a fight. Real soldier rigs
 * killed at setup so they fall as ragdolls during the preroll, then wet blood under them
 * (pools that spread, a drag trail, a spray across the floor) and spent brass around.
 * Medium gore: dark, glossy, never bright red.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Small deterministic PRNG (the stage must not depend on the order of Math.random calls). */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'pool' | 'trail' | 'spray';

/** A splat on a canvas: colour in RGB, its shape in alpha. */
function splatTexture(kind: Kind, seed: number): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const blob = (x: number, y: number, rad: number, a: number) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(140,10,13,${a})`);
    gr.addColorStop(0.72, `rgba(116,7,10,${a})`);
    gr.addColorStop(1, 'rgba(60,2,4,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  };
  if (kind === 'pool') {
    // One body of blood with lobes, a darker clotted centre, droplets at the rim.
    for (let i = 0; i < 14; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * S * 0.16;
      blob(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d * 0.8, S * (0.16 + r() * 0.16), 0.95);
    }
    for (let i = 0; i < 22; i++) {
      const a = r() * Math.PI * 2;
      const d = S * (0.3 + r() * 0.15);
      blob(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d * 0.8, S * (0.01 + r() * 0.025), 0.9);
    }
  } else if (kind === 'trail') {
    // A smear along x: broken, thinning, with drag streaks.
    for (let i = 0; i < 40; i++) {
      const k = i / 40;
      const x = S * (0.08 + k * 0.84);
      blob(x, S / 2 + (r() - 0.5) * S * 0.08, S * (0.07 + 0.05 * (1 - k)) * (0.6 + r() * 0.5), 0.75 * (1 - k * 0.6));
    }
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, S / 2 - S * 0.1 + r() * S * 0.2, S, 1 + r() * 2);
    }
    g.globalCompositeOperation = 'source-over';
  } else {
    // A spray fanning out along x from a point: drops that stretch with distance.
    for (let i = 0; i < 70; i++) {
      const d = Math.pow(r(), 0.7);
      const x = S * (0.1 + d * 0.85);
      const y = S / 2 + (r() - 0.5) * S * (0.1 + d * 0.5);
      const rad = S * (0.006 + (1 - d) * 0.025 * r());
      g.save();
      g.translate(x, y);
      g.scale(1 + d * 2.5, 1);
      blob(0, 0, rad, 0.95);
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface Splat {
  mesh: THREE.Mesh;
  /** Spreading pools: full size at `t0 + grow` seconds. */
  tick(t: number): void;
}

/** A splat lying on the floor (y = 0) at `at`, `size` metres across, rotated by `yaw`. */
export function splat(scene: THREE.Object3D, kind: Kind, at: THREE.Vector3, size: number, yaw: number, seed: number, t0 = -99, grow = 0): Splat {
  const mat = new THREE.MeshStandardMaterial({
    map: splatTexture(kind, seed), transparent: true, depthWrite: false, roughness: 0.1, metalness: 0.15, envMapIntensity: 1.5,
    polygonOffset: true, polygonOffsetFactor: -2 - (seed % 3), polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, kind === 'pool' ? 1 : 0.42), mat);
  mesh.rotation.set(-Math.PI / 2, 0, yaw);
  mesh.position.set(at.x, 0.004 + (seed % 5) * 0.0008, at.z);
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const set = (k: number) => mesh.scale.set(size * k, size * k, 1);
  set(grow > 0 ? 0.35 : 1);
  return {
    mesh,
    tick(t) {
      if (grow <= 0) return;
      const k = Math.min(1, Math.max(0, (t - t0) / grow));
      set(0.35 + 0.65 * (1 - (1 - k) * (1 - k)));
    },
  };
}

/** Spent brass scattered round a firing position. */
export function brass(scene: THREE.Object3D, at: THREE.Vector3, n: number, radius: number, seed: number): void {
  const r = rng(seed);
  const geo = new THREE.CylinderGeometry(0.0055, 0.0055, 0.045, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8893a, metalness: 0.9, roughness: 0.32 });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * radius;
    q.setFromEuler(new THREE.Euler(Math.PI / 2, r() * Math.PI * 2, 0, 'YXZ'));
    m.compose(v(at.x + Math.cos(a) * d, 0.0055, at.z + Math.sin(a) * d), q, v(1, 1, 1));
    mesh.setMatrixAt(i, m);
  }
  mesh.castShadow = true;
  scene.add(mesh);
}

export interface Body {
  soldier: Soldier;
  /** Where the blood goes once the body has settled. */
  splats: Splat[];
}

export interface CorpseSpec {
  at: THREE.Vector3;
  yaw: number;
  /** Direction the killing shove pushes (world, xz). */
  shove: THREE.Vector3;
  palette?: 'vanta' | 'bd';
  weapon?: string;
  /** Extra: a drag trail toward this point, a spray in this direction. */
  trail?: THREE.Vector3;
  spray?: number;
}

/**
 * Kill soldiers where they stand (at setup) so they fall during the preroll; `settle()` at
 * t >= 0 lays the blood under where they ended up; `update()` keeps the ragdolls synced.
 */
export class Aftermath {
  bodies: Body[] = [];
  private settled = false;
  private target: PlayerTarget = { feet: v(0, -50, 0), head: v(0, -48, 0), chest: v(0, -49, 0), velocity: v(0, 0, 0), sprinting: false, crouching: false, alive: false };

  constructor(private game: Game, private specs: CorpseSpec[], private seed = 7, private spread = 0) {
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
    specs.forEach((sp, i) => {
      const pal = sp.palette ?? 'vanta';
      const s = new Soldier(deps, 80 + i, hooks, pal === 'bd' ? 'bd' : 'alpha', pal);
      const w = game.weapons.weapons.find((x) => x.data.id === (sp.weapon ?? 'm4a1'))?.data;
      if (w) s.setWeapon(w);
      s.spawn(sp.at, sp.yaw);
      s.body.meleeHit(99999, sp.at.clone().sub(sp.shove.clone().setY(0).normalize()).setY(1.2), 2.4);
      this.bodies.push({ soldier: s, splats: [] });
    });
  }

  private settle(t: number): void {
    const scene = this.game.scene;
    const p = new THREE.Vector3();
    this.bodies.forEach((b, i) => {
      const sp = this.specs[i];
      const r = rng(this.seed * 31 + i);
      b.soldier.body.part('torso').group.getWorldPosition(p);
      const torso = p.clone();
      b.soldier.body.part('head').group.getWorldPosition(p);
      const head = p.clone();
      ((window as unknown as { __probeInfo?: Record<string, unknown> }).__probeInfo ??= {})[`body${i}`] = [+torso.x.toFixed(2), +torso.y.toFixed(2), +torso.z.toFixed(2)];
      // The main pool under the chest, a second where the head lies.
      b.splats.push(splat(scene, 'pool', torso.clone().lerp(head, 0.3), 1.9 + r() * 0.4, r() * 6.28, this.seed + i * 7, t, this.spread));
      b.splats.push(splat(scene, 'pool', head, 0.75 + r() * 0.25, r() * 6.28, this.seed + i * 7 + 1, t, this.spread * 0.8));
      if (sp.trail) {
        const mid = torso.clone().lerp(sp.trail, 0.5);
        const len = torso.distanceTo(sp.trail);
        b.splats.push(splat(scene, 'trail', mid, len, -Math.atan2(sp.trail.z - torso.z, sp.trail.x - torso.x), this.seed + i * 7 + 2));
      }
      if (sp.spray !== undefined) {
        const d = v(Math.cos(sp.spray), 0, Math.sin(sp.spray));
        b.splats.push(splat(scene, 'spray', torso.clone().addScaledVector(d, 1.1), 2.0, -sp.spray, this.seed + i * 7 + 3));
      }
    });
  }

  update(dt: number, t: number): void {
    if (!this.settled && t >= 0) {
      this.settled = true;
      this.settle(t);
    }
    for (const b of this.bodies) {
      b.soldier.update(dt, this.target, [], null, 'low', false);
      for (const s of b.splats) s.tick(t);
    }
  }
}

/** The assembly-aisle dead after the breach (shared by CR and WD, so the ending matches). */
export function aisleDead(game: Game, aisleZ: number, spread = 0): Aftermath {
  const z = aisleZ;
  return new Aftermath(game, [
    { at: v(-51.2, 0, z - 1.7), yaw: Math.PI / 2, shove: v(1, 0, -0.3), weapon: 'm4a1', spray: 0.2 },
    { at: v(-54.4, 0, z + 1.4), yaw: Math.PI / 2 + 0.4, shove: v(0.6, 0, 1), weapon: 'ak47', trail: v(-55.8, 0, z + 2.9) },
    { at: v(-58.1, 0, z - 0.4), yaw: Math.PI / 2 - 0.3, shove: v(1, 0, 0.2), weapon: 'mosin' },
    { at: v(-46.4, 0, z + 2.3), yaw: -Math.PI / 2, shove: v(-1, 0, 0.5), palette: 'bd', weapon: 'ak47', spray: Math.PI + 0.3 },
  ], 11, spread);
}
