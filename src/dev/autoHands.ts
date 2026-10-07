import * as THREE from 'three';
import type { Viewmodel } from '../weapons/Viewmodel';
import type { WeaponRig } from '../weapons/WeaponModels';
import { FINGER_NAMES, type WeaponHands } from '../weapons/HandPose';
import { layoutHands } from '../weapons/HandGrips';
import { isV2, legacyHands, type WeaponHandsV2 } from '../weapons/hands/HandProfile';
import { orientationMatrix, widenModel, type ViewProfile } from '../weapons/ViewProfile';
import { WeaponSurface, fingerGaps, gloveInside } from './handChecks';

/**
 * Hands on a weapon by search instead of by hand (weapon-calibration.html, "Otomatik
 * eller"). A tuned weapon's hands are the template (the AK-47's for rifles and SMGs, the
 * Kar98k's for bolt actions): its turns and finger poses as they are, its grips placed again
 * on this weapon's own geometry:
 *
 * - right hand: from the template's place (same height under the bore) and the old blocky
 *   hand's, a sweep along the gun and up / down, then a small search (position ±, turn ±8°),
 *   keeping the template's lateral place and turn so the grip still reads the same;
 * - left hand: cupped under the handguard the way the template's is, at the template's place
 *   relative to the handguard's cross-section there; a sweep along the gun finds where it
 *   fits (and the arm reaches), then a small search tidies it.
 *
 * The score: glove inside the weapon, finger joints into it, the wrapping fingers off it, the
 * palm away from the surface (the template's palm lies on it), the arm out of reach, a wrist
 * bent past 70°. The page then runs the 16-state check and keeps what passes.
 */

type Side = 'right' | 'left';

/** A template: tuned hands in weapon space (rig root: metres, -Z along the bore, +Y up). */
export interface HandTemplate {
  hands: WeaponHands;
  right: THREE.Vector3;
  left: THREE.Vector3;
  /** Height of the template weapon's bore (its muzzle point). */
  boreY: number;
}

/**
 * A tuned weapon's hands as a template (its view profile, positions into weapon space). The
 * search works on schema-1 hands: a schema-2 profile is converted (the same hands, the palm on
 * the grip, its library poses as degrees).
 */
export function templateOf(p: Readonly<ViewProfile>): HandTemplate | null {
  if (!p.hands) return null;
  const O = orientationMatrix(p, new THREE.Matrix4());
  const v2 = isV2(p.hands);
  const hands: WeaponHands = v2 ? legacyHands(p.hands as WeaponHandsV2, O) : (structuredClone(p.hands) as WeaponHands);
  const at = new Float32Array([...hands.rightGrip.position, ...hands.leftGrip.position, ...p.points.muzzle]);
  // Schema-2 targets are set on the model as drawn; schema-1 grips get its widening.
  if (!v2) widenModel(p, at, null);
  const W = (i: number) => new THREE.Vector3(at[i], at[i + 1], at[i + 2]).applyMatrix4(O);
  return { hands, right: W(0), left: W(3), boreY: W(6).y };
}

export interface AutoHandsHost {
  vm: Viewmodel;
  /** Advance the page `n` frames (the weapon still, the arms posed). */
  step: (n: number) => void;
}

export interface SidePlacement {
  score: number;
  tries: number;
  /** Wrist °, arm out of reach (cm), glove points inside / deepest (mm), finger gaps (mm). */
  summary: string;
}

/**
 * How a weapon is held. 'rifle': left hand under the handguard (a bolt action's too).
 * 'pump': left hand on the pump, its grip riding with it. 'pistol': left hand on the grip's
 * left side, its fingers over the right hand's (they touch the hand, not the gun).
 */
export type HoldKind = 'rifle' | 'pump' | 'pistol';

/** The template's palm lies this far off the weapon's surface (m). */
const PALM_GAP: Record<Side, number> = { right: 0.001, left: 0.005 };
/** Fingers that wrap the grip / handguard: they should touch it. */
const WRAP: Record<HoldKind, Record<Side, readonly string[]>> = {
  rifle: { right: ['middle', 'ring', 'pinky'], left: ['index', 'middle', 'ring'] },
  pump: { right: ['middle', 'ring', 'pinky'], left: ['index', 'middle', 'ring'] },
  pistol: { right: ['middle', 'ring', 'pinky'], left: [] },
};

class Placer {
  private surf: WeaponSurface;
  /** The weapon's triangles in weapon space (the palm's distance from further off). */
  private tris: Float32Array | null = null;
  private rig: WeaponRig;
  private toDef: THREE.Matrix4;
  private toRig: THREE.Matrix4;

  constructor(
    private host: AutoHandsHost,
    private kind: HoldKind,
  ) {
    const rig = host.vm.activeRig;
    if (!rig?.hands) throw new Error('no hands on the weapon in hand');
    this.rig = rig;
    this.toRig = rig.hands.toRig.clone();
    this.toDef = this.toRig.clone().invert();
    host.vm.arms.preview = { action: 'grip', trigger: 0, pull: 0, instant: true };
    host.step(3);
    this.surf = new WeaponSurface(host.vm);
  }

  /** The hands being placed (always schema 1 here: placeHands puts the template's on first). */
  get def(): WeaponHands {
    return this.rig.hands!.def as WeaponHands;
  }

  /** A grip's place in weapon space. */
  at(side: Side): THREE.Vector3 {
    const g = side === 'right' ? this.def.rightGrip : this.def.leftGrip;
    return new THREE.Vector3(...g.position).applyMatrix4(this.toRig);
  }

  set(side: Side, pos: THREE.Vector3, rot: readonly number[]): void {
    const g = side === 'right' ? this.def.rightGrip : this.def.leftGrip;
    g.position = pos.clone().applyMatrix4(this.toDef).toArray().map((v) => +v.toFixed(4)) as [number, number, number];
    g.rotation = rot.map((v) => +v.toFixed(2)) as [number, number, number];
    layoutHands(this.rig);
  }

  /** Score of the hand on its grip now (lower is better). */
  score(side: Side): { s: number; summary: string } {
    const vm = this.host.vm;
    this.host.step(3);
    const gaps = fingerGaps(vm, side, this.surf);
    const ins = gloveInside(vm, side, this.surf, 6);
    const st = vm.arms.stats[side];
    const node = side === 'right' ? this.rig.hands!.right : this.rig.hands!.left;
    const w = node.getWorldPosition(new THREE.Vector3());
    const near = this.surf.nearest(w);
    // Over a grid cell away the quick lookup has nothing: measure against every triangle, so
    // a hand that started off the gun still feels where the surface is.
    const palm = near ? near.d : this.farDistance(w.applyMatrix4(this.rig.root.matrixWorld.clone().invert()));
    // A hand over the sight line covers the front sight (a thumb on a thin handguard).
    const over = this.overSights(side);
    let s = over * 6 + ins.count * 0.3 + ins.maxMm * 3 + st.reachM * 100 + Math.max(0, st.reachM - 0.1) * 300 + Math.max(0, st.wristBendDeg - 70) * 2 + Math.abs(palm - PALM_GAP[side]) * 1500;
    for (const [f, g] of Object.entries(gaps)) {
      for (const x of g) if (x * 1000 < -1) s += (-1 - x * 1000) * 2;
      if (WRAP[this.kind][side].includes(f)) {
        const mn = Math.min(...g) * 1000;
        if (mn > 3) s += (mn - 3) * 1.5;
      }
    }
    const summary =
      `${over > 0 ? `nişan hattının ${over.toFixed(0)} mm üstünde, ` : ''}bilek ${st.wristBendDeg.toFixed(0)}°, kol +${(st.reachM * 100).toFixed(0)} cm, içeride ${ins.count} nokta / ${ins.maxMm.toFixed(1)} mm, avuç ${(palm * 1000).toFixed(0)} mm, parmak ` +
      FINGER_NAMES.map((f) => `${f[0].toUpperCase()}${(Math.min(...gaps[f]) * 1000).toFixed(0)}`).join(' ');
    return { s, summary };
  }

  /**
   * Pattern search from `pos` / `rot`: position within ±`reach` (m, past it each mm costs),
   * the lateral place within ±8 mm and the turn within ±8° kept freely.
   */
  search(side: Side, pos: THREE.Vector3, rot: readonly number[], sweep: { z: number[]; y: number[] } | null, budget = 300): SidePlacement {
    const base = pos.clone();
    const baseRot = [...rot];
    const apply = (x: number[]) => this.set(side, base.clone().add(new THREE.Vector3(x[0], x[1], x[2])), [baseRot[0] + x[3], baseRot[1] + x[4], baseRot[2] + x[5]]);
    // A pistol's support hand has no template turn of its own to keep: more freedom.
    const turn = this.kind === 'pistol' && side === 'left' ? 20 : 8;
    const keep = (x: number[]) => Math.max(0, Math.abs(x[0]) * 1000 - 8) * 3 + x.slice(3).reduce((a, v) => a + Math.max(0, Math.abs(v) - turn) * 3, 0);
    const evalAt = (x: number[]) => {
      apply(x);
      const r = this.score(side);
      return { s: r.s + keep(x), summary: r.summary };
    };
    let x = [0, 0, 0, 0, 0, 0];
    let best = evalAt(x);
    let tries = 1;
    if (sweep) {
      for (const dz of sweep.z)
        for (const dy of sweep.y) {
          const y = [0, dy, dz, 0, 0, 0];
          const r = evalAt(y);
          tries++;
          if (r.s < best.s) [best, x] = [r, y];
        }
    }
    for (const [sp, sr] of [
      [0.008, 4],
      [0.004, 2],
      [0.002, 1],
    ]) {
      let improved = true;
      while (improved && tries < budget) {
        improved = false;
        for (let k = 0; k < 6; k++)
          for (const sg of [1, -1]) {
            const y = [...x];
            y[k] += sg * (k < 3 ? sp : sr);
            const r = evalAt(y);
            tries++;
            if (r.s < best.s - 1e-6) {
              [best, x] = [r, y];
              improved = true;
            }
          }
      }
    }
    apply(x);
    return { score: +best.s.toFixed(1), tries, summary: best.summary };
  }

  /**
   * How far (mm) the hand's joints rise above a line 15 mm under the sight line, ahead of the
   * rear sight: aimed, anything up there sits in the sight picture.
   */
  private overSights(side: Side): number {
    const b = this.host.vm.arms.bonesOf(side);
    if (!b) return 0;
    const m = this.rig.root.matrixWorld;
    const o = this.rig.sight.getWorldPosition(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
    const p = new THREE.Vector3();
    let over = 0;
    for (const bone of [b.hand, ...Object.values(b.fingers).flat()]) {
      bone.getWorldPosition(p).sub(o);
      if (p.dot(fwd) < 0.03) continue;
      over = Math.max(over, p.dot(up) + 0.015);
    }
    return over * 1000;
  }

  /** Distance (m) from `p` (weapon space) to the nearest point of the weapon. */
  private farDistance(p: THREE.Vector3): number {
    const P = (this.tris ??= this.triangles());
    const t = new THREE.Triangle();
    const q = new THREE.Vector3();
    let best = Infinity;
    for (let i = 0; i < P.length; i += 9) {
      t.a.set(P[i], P[i + 1], P[i + 2]);
      t.b.set(P[i + 3], P[i + 4], P[i + 5]);
      t.c.set(P[i + 6], P[i + 7], P[i + 8]);
      best = Math.min(best, t.closestPointToPoint(p, q).distanceTo(p));
    }
    return best;
  }

  /** The weapon's triangles in weapon space (what the hands can touch). */
  triangles(): Float32Array {
    const root = this.rig.root;
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const out: number[] = [];
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.gizmo || ([] as THREE.Material[]).concat(mesh.material).some((mt) => mt.transparent)) return;
      for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) if (!p.visible) return;
      m.multiplyMatrices(inv, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let k = 0; k < n; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
      }
    });
    return new Float32Array(out);
  }
}

/** The weapon cut across at depth `z` near the bore: its extent (weapon space), or null. */
function section(P: Float32Array, z: number, boreY: number): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let t = 0; t < P.length; t += 9) {
    for (let e = 0; e < 3; e++) {
      const a = t + e * 3;
      const b = t + ((e + 1) % 3) * 3;
      const da = P[a + 2] - z;
      const db = P[b + 2] - z;
      if (da < 0 === db < 0) continue;
      const f = da / (da - db);
      const x = P[a] + (P[b] - P[a]) * f;
      const y = P[a + 1] + (P[b + 1] - P[a + 1]) * f;
      if (Math.abs(x) > 0.06 || y < boreY - 0.07 || y > boreY + 0.07) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x0 < x1 ? { x0, x1, y0, y1 } : null;
}

const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
};

export interface AutoHandsResult {
  right: SidePlacement;
  left: SidePlacement;
}

/**
 * Place both hands of the weapon in hand (its hands already on it, the template's poses):
 * right on the pistol grip, left on the handguard. `rest`: the old blocky hands' places
 * (weapon space), a second start for the right hand.
 */
export function placeHands(host: AutoHandsHost, tpl: HandTemplate, rest: { right: THREE.Vector3 } | null, kind: HoldKind = 'rifle'): AutoHandsResult {
  const pl = new Placer(host, kind);
  const rig = host.vm.activeRig!;
  const boreY = rig.muzzle.position.y;
  const dy = boreY - tpl.boreY;
  const P = pl.triangles();

  // --- Right: the template's place (same depth under the bore) or the old hand's, the better ---
  const fromTpl = tpl.right.clone().setY(tpl.right.y + dy);
  const rotR = tpl.hands.rightGrip.rotation;
  const starts = [fromTpl, ...(rest ? [new THREE.Vector3(tpl.right.x, rest.right.y, rest.right.z)] : [])];
  let start = starts[0];
  let bestStart = Infinity;
  for (const s of starts) {
    pl.set('right', s, rotR);
    const r = pl.score('right').s;
    if (r < bestStart) [bestStart, start] = [r, s];
  }
  const right = pl.search('right', start, rotR, { z: range(-0.14, 0.14, 0.02), y: range(-0.06, 0.06, 0.015) });

  const rotL = tpl.hands.leftGrip.rotation;
  // --- Left on a pistol: on the grip's left side, a little forward of and under the right palm ---
  if (kind === 'pistol') {
    const start = pl.at('right').add(new THREE.Vector3(-0.03, -0.012, -0.012));
    const left = pl.search('left', start, rotL, { z: range(-0.03, 0.03, 0.01), y: range(-0.03, 0.03, 0.01) }, 200);
    host.vm.arms.preview = {};
    return { right, left };
  }
  // --- Left: under the handguard like the template, the place along it by sweep ---
  // The template's palm: 2.5 mm off the handguard's right edge, 14 mm over its bottom.
  const leftAt = (z: number) => {
    const s = section(P, z, boreY);
    return s ? new THREE.Vector3(s.x1 + 0.0025, s.y0 + 0.014, z) : null;
  };
  const rz = pl.at('right').z;
  const want = rz + (tpl.left.z - tpl.right.z);
  let bestL: { s: number; pos: THREE.Vector3 } | null = null;
  // Within 10 cm of the template's distance from the right hand (an arm reaching past it
  // stretches the sleeve); on a pump gun, along the pump.
  const pump = kind === 'pump' && rig.pump ? new THREE.Box3().setFromObject(rig.pump).applyMatrix4(rig.root.matrixWorld.clone().invert()) : null;
  const zs = pump && !pump.isEmpty() ? range(pump.min.z + 0.02, pump.max.z - 0.02, 0.01) : range(want - 0.1, want + 0.1, 0.02);
  for (const z of zs) {
    const pos = leftAt(z);
    if (!pos) continue;
    pl.set('left', pos, rotL);
    const s = pl.score('left').s;
    if (!bestL || s < bestL.s) bestL = { s, pos };
  }
  const left = bestL
    ? pl.search('left', bestL.pos, rotL, null, 160)
    : pl.search('left', tpl.left.clone().setY(tpl.left.y + dy), rotL, { z: range(-0.1, 0.1, 0.02), y: range(-0.04, 0.04, 0.02) });
  host.vm.arms.preview = {};
  return { right, left };
}
