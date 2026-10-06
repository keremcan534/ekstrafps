#!/usr/bin/env node
/**
 * First-person arms: skin the Meshy arms mesh to a hand skeleton.
 *   node scripts/rig-arms.mjs [--debug]
 *
 * In: production/assets/src/hands/arms.glb (Meshy image-to-3D: both forearms and open gloved
 * hands in one mesh, no skeleton; the model faces -z like a first-person camera, hands up).
 * Out: public/hands/arms.glb, the same mesh in metres, skinned to (per side)
 *
 *   RightUpperArm → RightForeArm → RightHand → RightThumb01..03, RightIndex01..03,
 *                                              RightMiddle01..03, RightRing01..03,
 *                                              RightPinky01..03                 (and Left…)
 *
 * The joints are found on the mesh itself. Geodesic distance from the sleeve's end (over the
 * welded surface) peaks at the fingertips; sweeping it downward, each finger is its own region
 * until it meets the palm at the web (the merge, by persistence: the five most persistent
 * peaks are the fingers). Each finger's centre line is the centroids of its equal-distance
 * rings; the knuckle (MCP) sits a little under the web along the finger, the other joints at
 * anatomical proportions; the wrist one palm length down the trunk from the middle knuckle.
 *
 * Every bone points along +Y, +Z toward the palm side, X = Y × Z: a positive turn about X
 * curls a finger into the palm (both hands), about Z spreads it (mirrored per hand at run
 * time), about Y twists it. Skin weights: each vertex belongs to one region (a finger, or the
 * palm and forearm), and is weighted among that region's bones by inverse distance (power 5;
 * the palm's distance is to the palm plate, not a line), so joints bend smoothly and fingers
 * never pull each other. The bind pose is the model's own open hand.
 *
 * `--debug` writes the found joints to production/assets/src/hands/arms-rig.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import * as THREE from 'three';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'production/assets/src/hands/arms.glb');
const OUT = join(root, 'public/hands/arms.glb');
const debug = process.argv.includes('--debug');

/** Middle finger, knuckle to tip, of the gloved hand (m): sets the model's scale. */
const MIDDLE_LENGTH = 0.08;
/** Upper arm (m): the bone the IK turns; the mesh has no upper arm (a sleeve tube is drawn). */
const UPPER_ARM = 0.34;
/** Joints along a finger, as fractions of knuckle → tip: PIP, DIP. */
const PIP = 0.48;
const DIP = 0.75;
/** Thumb: IP as a fraction of MCP → tip. */
const THUMB_IP = 0.52;
/** Weight falloff (inverse distance power). */
const POWER = 5;
/** The thumb metacarpal's distance counts this much more on the palm. */
const THUMB_BALL = 1.5;
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const posAttr = prim.getAttribute('POSITION');
const P = posAttr.getArray();
const IDX = prim.getIndices().getArray();
const N = P.length / 3;

const V = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);

// ------------------------------------------------------------------ weld + parts
// UV seams split vertices: weld by position so the surface is one graph.
const weld = new Int32Array(N);
{
  const key = new Map();
  for (let i = 0; i < N; i++) {
    const k = `${Math.round(P[i * 3] * 2e4)},${Math.round(P[i * 3 + 1] * 2e4)},${Math.round(P[i * 3 + 2] * 2e4)}`;
    if (!key.has(k)) key.set(k, i);
    weld[i] = key.get(k);
  }
}
const nbrSets = new Map();
const link = (a, b) => {
  if (a === b) return;
  let s = nbrSets.get(a);
  if (!s) nbrSets.set(a, (s = new Set()));
  s.add(b);
};
for (let t = 0; t < IDX.length; t += 3) {
  const a = weld[IDX[t]], b = weld[IDX[t + 1]], c = weld[IDX[t + 2]];
  link(a, b); link(b, a); link(b, c); link(c, b); link(a, c); link(c, a);
}
const adj = new Map([...nbrSets].map(([k, s]) => [k, [...s]]));
const pos = new Map([...adj.keys()].map((i) => [i, V(i)]));

const groups = [];
/** Loose bits (stitching, fingertip caps): skinned like the nearest arm vertex. */
const small = [];
{
  const seen = new Set();
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const g = [s];
    seen.add(s);
    for (let k = 0; k < g.length; k++) for (const b of adj.get(g[k])) if (!seen.has(b)) { seen.add(b); g.push(b); }
    if (g.length > 1000) groups.push(g);
    else small.push(...g);
  }
}
if (groups.length !== 2) throw new Error(`expected two arms, found ${groups.length} large parts`);

// ------------------------------------------------------------------ geodesics
class Heap {
  constructor() { this.k = []; this.d = []; }
  push(k, d) {
    const K = this.k, D = this.d;
    let i = K.length;
    K.push(k); D.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (D[p] <= d) break;
      K[i] = K[p]; D[i] = D[p]; i = p;
    }
    K[i] = k; D[i] = d;
  }
  pop() {
    const K = this.k, D = this.d;
    const top = K[0];
    const lk = K.pop(), ld = D.pop();
    if (K.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= K.length) break;
        if (c + 1 < K.length && D[c + 1] < D[c]) c++;
        if (D[c] >= ld) break;
        K[i] = K[c]; D[i] = D[c]; i = c;
      }
      K[i] = lk; D[i] = ld;
    }
    return top;
  }
  get size() { return this.k.length; }
}
function geodesic(sources) {
  const dist = new Map();
  const h = new Heap();
  for (const s of sources) { dist.set(s, 0); h.push(s, 0); }
  while (h.size) {
    const a = h.pop();
    const da = dist.get(a);
    const pa = pos.get(a);
    for (const b of adj.get(a)) {
      const nd = da + pa.distanceTo(pos.get(b));
      if (nd < (dist.get(b) ?? Infinity)) { dist.set(b, nd); h.push(b, nd); }
    }
  }
  return dist;
}
const centroid = (ids) => {
  const c = new THREE.Vector3();
  for (const i of ids) c.add(pos.get(i));
  return c.multiplyScalar(1 / Math.max(1, ids.length));
};
const centroidV = (ps) => ps.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / ps.length);

// ------------------------------------------------------------------ one arm
function analyse(ids, side) {
  // The sleeve's end: the low end of the arm's main axis (hands are up in this model).
  const c = centroid(ids);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of ids) {
    const d = pos.get(i).clone().sub(c).toArray();
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
  }
  let ax = new THREE.Vector3(1, 1, 1);
  for (let it = 0; it < 100; it++) ax = new THREE.Vector3(...[0, 1, 2].map((a) => C[a][0] * ax.x + C[a][1] * ax.y + C[a][2] * ax.z)).normalize();
  if (ax.y > 0) ax.negate();
  let best = -Infinity;
  for (const i of ids) best = Math.max(best, pos.get(i).clone().sub(c).dot(ax));
  const endSet = ids.filter((i) => pos.get(i).clone().sub(c).dot(ax) > best - 0.03);
  const dRoot = geodesic(endSet);

  // Superlevel sweep (union-find, elder rule): every peak is born at its tip and dies where
  // it merges into an older one. `web` = a peak's first merge with another real peak.
  const order = [...ids].sort((a, b) => dRoot.get(b) - dRoot.get(a));
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(a) !== r) { const n = parent.get(a); parent.set(a, r); a = n; }
    return r;
  };
  const peakOf = new Map();
  const death = new Map();
  const web = new Map();
  const peakAt = new Map();
  const mergedInto = new Map();
  const TAU = 0.06;
  for (const v of order) {
    const lv = dRoot.get(v);
    const roots = [...new Set(adj.get(v).filter((n) => parent.has(n)).map(find))];
    parent.set(v, v);
    if (!roots.length) {
      peakOf.set(v, v);
    } else {
      roots.sort((a, b) => dRoot.get(peakOf.get(b)) - dRoot.get(peakOf.get(a)));
      const keep = roots[0];
      const kp = peakOf.get(keep);
      for (const other of roots.slice(1)) {
        const op = peakOf.get(other);
        death.set(op, lv);
        mergedInto.set(op, kp);
        if (dRoot.get(op) - lv > TAU) {
          if (!web.has(op)) web.set(op, lv);
          if (!web.has(kp)) web.set(kp, lv);
        }
        parent.set(other, keep);
      }
      parent.set(v, keep);
    }
    peakAt.set(v, peakOf.get(find(v)));
  }
  const persistence = (p) => dRoot.get(p) - (death.get(p) ?? 0);
  const peaks = [...new Set(peakAt.values())].sort((a, b) => persistence(b) - persistence(a)).slice(0, 5);
  if (peaks.length < 5) throw new Error(`${side}: found ${peaks.length} fingers`);

  // Regions: a finger's vertices are the ones that joined its component above its web (a
  // vertex first caught by a bump on the finger belongs to the finger the bump merged into).
  const region = new Map();
  const owner = (q) => {
    while (!peaks.includes(q) && mergedInto.has(q)) q = mergedInto.get(q);
    return q;
  };
  for (const v of ids) {
    const p = owner(peakAt.get(v));
    region.set(v, peaks.includes(p) && dRoot.get(v) > web.get(p) ? p : -1);
  }

  // Centre lines: ring centroids from the tip down to the web.
  const STEP = 0.015;
  const line = (p) => {
    const top = dRoot.get(p);
    const bins = new Map();
    for (const v of ids) {
      if (region.get(v) !== p) continue;
      const b = Math.floor((top - dRoot.get(v)) / STEP);
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(v);
    }
    const pts = [...bins.keys()].sort((a, b) => a - b).filter((b) => bins.get(b).length >= 4).map((b) => centroid(bins.get(b)));
    pts[0] = pos.get(p).clone();
    return pts;
  };
  const lines = new Map(peaks.map((p) => [p, line(p)]));

  // Which finger is which: the thumb joins the hand last (lowest web); the others in order
  // across the hand from the thumb.
  const thumb = [...peaks].sort((a, b) => web.get(a) - web.get(b))[0];
  const tBase = lines.get(thumb).at(-1);
  const rest = peaks.filter((p) => p !== thumb).sort((a, b) => lines.get(a).at(-1).distanceTo(tBase) - lines.get(b).at(-1).distanceTo(tBase));
  const named = { Thumb: thumb, Index: rest[0], Middle: rest[1], Ring: rest[2], Pinky: rest[3] };

  // Trunk centre line (palm + forearm): rings of the trunk region, by distance.
  const trunkLine = [];
  {
    const bins = new Map();
    for (const v of ids) {
      if (region.get(v) !== -1) continue;
      const b = Math.floor(dRoot.get(v) / STEP);
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(v);
    }
    for (const b of [...bins.keys()].sort((a, b) => a - b)) if (bins.get(b).length >= 8) trunkLine.push({ d: (b + 0.5) * STEP, c: centroid(bins.get(b)) });
  }
  return { ids, side, dRoot, region, named, lines, trunkLine, end: centroid(endSet) };
}

/** Arc-length point along a polyline (from its start). */
function along(pts, t) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = pts[i].distanceTo(pts[i - 1]);
    if (acc + seg >= t) return pts[i - 1].clone().lerp(pts[i], (t - acc) / seg);
    acc += seg;
  }
  return pts.at(-1).clone();
}
const lengthOf = (pts) => pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0);
/** Smoothed polyline (moving average, ends kept). */
const smooth = (pts, k = 2) => pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p.clone() : centroidV(pts.slice(Math.max(0, i - k), i + k + 1).map((q) => q.clone()))));
/** Direction of the base end of a finger line (web → about half way up). */
function baseDir(webToTip) {
  const n = webToTip.length;
  const a = centroidV(webToTip.slice(0, Math.max(2, Math.floor(n * 0.25))).map((q) => q.clone()));
  const b = centroidV(webToTip.slice(Math.floor(n * 0.35), Math.max(Math.floor(n * 0.35) + 1, Math.floor(n * 0.6))).map((q) => q.clone()));
  return b.sub(a).normalize();
}

// ------------------------------------------------------------------ joints
function joints(arm) {
  const side = arm.side;
  const fj = {};
  for (const f of FINGERS) {
    const webToTip = smooth(arm.lines.get(arm.named[f])).reverse();
    const web = webToTip[0];
    const dir = baseDir(webToTip);
    const Lw = lengthOf(webToTip);
    if (f === 'Thumb') {
      fj[f] = { mcp: web.clone(), ip: along(webToTip, Lw * THUMB_IP), tip: webToTip.at(-1).clone(), dir, L: Lw };
    } else {
      // The knuckle sits under the web, along the finger (the web is a third of the way up
      // the first phalanx).
      const back = Lw * 0.19;
      const mcp = web.clone().addScaledVector(dir, -back);
      const L = Lw + back;
      const pts = [mcp, ...webToTip];
      fj[f] = { mcp, pip: along(pts, L * PIP), dip: along(pts, L * DIP), tip: webToTip.at(-1).clone(), dir, L };
    }
  }
  const s = MIDDLE_LENGTH / fj.Middle.L;

  // Wrist: down the trunk from the middle knuckle by a palm length (0.92 × middle finger).
  const mid = fj.Middle.mcp;
  const palmLen = fj.Middle.L * 0.92;
  let wrist = null;
  const tl = [...arm.trunkLine].sort((a, b) => b.d - a.d).map((t) => t.c);
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1].distanceTo(mid), b = tl[i].distanceTo(mid);
    if (a <= palmLen && b > palmLen) { wrist = tl[i - 1].clone().lerp(tl[i], (palmLen - a) / (b - a)); break; }
  }
  if (!wrist) throw new Error(`${side}: wrist not found`);
  const elbow = arm.end.clone();

  // Hand frame: Y wrist → middle knuckle, radial = little → index knuckle, Z toward the palm.
  const Y = mid.clone().sub(wrist).normalize();
  const radial = fj.Index.mcp.clone().sub(fj.Pinky.mcp).normalize();
  const palm = side === 'Right' ? radial.clone().cross(Y) : Y.clone().cross(radial);
  palm.addScaledVector(Y, -palm.dot(Y)).normalize();

  // Thumb metacarpal: from near the wrist on the thumb side to the thumb's MCP.
  const tj = fj.Thumb;
  tj.cmc = wrist.clone().lerp(tj.mcp, 0.3);

  const bones = [];
  const bone = (name, parent, head, tail, Zhint) => {
    const y = tail.clone().sub(head).normalize();
    const z = Zhint.clone().addScaledVector(y, -Zhint.dot(y)).normalize();
    const x = y.clone().cross(z);
    bones.push({ name: side + name, parent: parent && side + parent, head, tail, basis: new THREE.Matrix4().makeBasis(x, y, z) });
  };
  const shoulder = elbow.clone().addScaledVector(wrist.clone().sub(elbow).normalize(), -UPPER_ARM / s);
  bone('UpperArm', null, shoulder, elbow, palm);
  bone('ForeArm', 'UpperArm', elbow, wrist, palm);
  bone('Hand', 'ForeArm', wrist, mid, palm);
  // The thumb's pad faces the palm and across it (toward the little finger).
  const thumbPad = palm.clone().multiplyScalar(0.7).addScaledVector(radial, -0.7);
  bone('Thumb01', 'Hand', tj.cmc, tj.mcp, thumbPad);
  bone('Thumb02', 'Thumb01', tj.mcp, tj.ip, thumbPad);
  bone('Thumb03', 'Thumb02', tj.ip, tj.tip, thumbPad);
  for (const f of FINGERS.slice(1)) {
    const j = fj[f];
    bone(`${f}01`, 'Hand', j.mcp, j.pip, palm);
    bone(`${f}02`, `${f}01`, j.pip, j.dip, palm);
    bone(`${f}03`, `${f}02`, j.dip, j.tip, palm);
  }
  // The palm plate (the Hand bone's skin distance): the wrist (narrower) to the knuckle line.
  const half = fj.Index.mcp.distanceTo(fj.Pinky.mcp) * 0.5;
  const plate = [
    wrist.clone().addScaledVector(radial, half * 0.75),
    wrist.clone().addScaledVector(radial, -half * 0.75),
    fj.Pinky.mcp.clone(),
    fj.Index.mcp.clone(),
  ];
  return { bones, s, plate, fj, wrist, elbow };
}

// ------------------------------------------------------------------ weights
function segDist(p, a, b) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
const tri = new THREE.Triangle();
const tmp = new THREE.Vector3();
function plateDist(p, q) {
  tri.set(q[0], q[1], q[2]);
  const d1 = p.distanceTo(tri.closestPointToPoint(p, tmp));
  tri.set(q[0], q[2], q[3]);
  const d2 = p.distanceTo(tri.closestPointToPoint(p, tmp));
  return Math.min(d1, d2);
}

function weigh(arm, rig, jointIndex) {
  const out = new Map();
  const byName = new Map(rig.bones.map((b) => [b.name, b]));
  const peakName = new Map(Object.entries(arm.named).map(([f, p]) => [p, f]));
  const S = arm.side;
  const trunkBones = [`${S}ForeArm`, `${S}Hand`, `${S}Thumb01`, ...FINGERS.slice(1).map((f) => `${S}${f}01`)];
  for (const v of arm.ids) {
    const p = pos.get(v);
    const r = arm.region.get(v);
    const f = peakName.get(r);
    const names = r === -1 ? trunkBones : [`${S}${f}01`, `${S}${f}02`, `${S}${f}03`, `${S}Hand`];
    const w = names.map((n) => {
      const b = byName.get(n);
      // The thumb's metacarpal only takes the ball of the thumb, not the middle of the palm.
      const d = n === `${S}Hand` ? plateDist(p, rig.plate) : segDist(p, b.head, b.tail) * (r === -1 && n === `${S}Thumb01` ? THUMB_BALL : 1);
      return [jointIndex.get(n), 1 / Math.max(d, 1e-4) ** POWER];
    });
    w.sort((a, b) => b[1] - a[1]);
    const top = w.slice(0, 4);
    const sum = top.reduce((sm, x) => sm + x[1], 0);
    out.set(v, top.map(([j, x]) => [j, x / sum]));
  }
  return out;
}

// ------------------------------------------------------------------ run
const arms = groups.map((g) => analyse(g, centroid(g).x > 0 ? 'Right' : 'Left')).sort((a, b) => (a.side === b.side ? 0 : a.side === 'Right' ? -1 : 1));
const rigs = arms.map(joints);
const s = (rigs[0].s + rigs[1].s) / 2;
console.log(`scale ${s.toFixed(4)} m/unit (right ${rigs[0].s.toFixed(4)}, left ${rigs[1].s.toFixed(4)})`);
for (const [k, r] of rigs.entries()) {
  const fj = r.fj;
  console.log(arms[k].side, 'palm width', (fj.Index.mcp.distanceTo(fj.Pinky.mcp) * s).toFixed(3), 'm, hand length', (r.wrist.distanceTo(fj.Middle.tip) * s).toFixed(3), 'm, forearm', (r.wrist.distanceTo(r.elbow) * s).toFixed(3), 'm');
  console.log('  ' + ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map((f) => `${f} ${(fj[f].L * s * 100).toFixed(1)} cm`).join(', '));
}

const allBones = rigs.flatMap((r) => r.bones);
const jointIndex = new Map(allBones.map((b, i) => [b.name, i]));
const weights = new Map();
for (const [k, arm] of arms.entries()) for (const [v, w] of weigh(arm, rigs[k], jointIndex)) weights.set(v, w);
{
  const armVerts = [...weights.keys()];
  for (const v of small) {
    const p = pos.get(v);
    let best = -1, bd = Infinity;
    for (const a of armVerts) { const d = p.distanceToSquared(pos.get(a)); if (d < bd) { bd = d; best = a; } }
    weights.set(v, weights.get(best));
  }
  console.log(`${small.length} loose vertices skinned like their nearest arm vertex`);
}

if (debug) {
  const dump = {
    scale: s,
    bones: allBones.map((b) => ({ name: b.name, head: b.head.clone().multiplyScalar(s).toArray(), tail: b.tail.clone().multiplyScalar(s).toArray() })),
    plates: rigs.map((r) => r.plate.map((p) => p.clone().multiplyScalar(s).toArray())),
  };
  writeFileSync(join(root, 'production/assets/src/hands/arms-rig.json'), JSON.stringify(dump));
}

// ------------------------------------------------------------------ write the skinned model
// Metres; the bones' world frames at bind are their basis at the head.
for (let i = 0; i < P.length; i++) P[i] *= s;
posAttr.setArray(P);
const world = new Map(allBones.map((b) => [b.name, b.basis.clone().setPosition(b.head.clone().multiplyScalar(s))]));

const J = new Uint16Array(N * 4);
const W = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
  const w = weights.get(weld[i]);
  for (let k = 0; k < 4; k++) {
    J[i * 4 + k] = w?.[k]?.[0] ?? 0;
    W[i * 4 + k] = w?.[k]?.[1] ?? 0;
  }
  if (!w) W[i * 4] = 1;
}
const buffer = doc.getRoot().listBuffers()[0];
prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(J).setBuffer(buffer));
prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(W).setBuffer(buffer));

const scene = doc.getRoot().listScenes()[0];
const meshNode = doc.getRoot().listNodes().find((n) => n.getMesh());
meshNode.setName('Gloves');
const armsRoot = doc.createNode('Arms');
scene.addChild(armsRoot);
const nodes = new Map();
const skin = doc.createSkin('ArmsSkin');
const ibm = new Float32Array(allBones.length * 16);
for (const [i, b] of allBones.entries()) {
  const n = doc.createNode(b.name);
  const local = b.parent ? world.get(b.parent).clone().invert().multiply(world.get(b.name)) : world.get(b.name).clone();
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  local.decompose(t, q, sc);
  n.setTranslation(t.toArray()).setRotation(q.toArray());
  n.setExtras({ length: b.head.distanceTo(b.tail) * s });
  (b.parent ? nodes.get(b.parent) : armsRoot).addChild(n);
  nodes.set(b.name, n);
  skin.addJoint(n);
  ibm.set(world.get(b.name).clone().invert().elements, i * 16);
}
skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
skin.setSkeleton(armsRoot);
scene.removeChild(meshNode);
armsRoot.addChild(meshNode);
meshNode.setSkin(skin);
await doc.transform(prune());

// Textures: WebP, at most 2048 px (as the other Meshy packs). Geometry left as it is.
const work = join(tmpdir(), 'site9-rig-arms');
mkdirSync(work, { recursive: true });
const raw = join(work, 'arms-rigged.glb');
await io.write(raw, doc);
mkdirSync(dirname(OUT), { recursive: true });
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '--yes', '@gltf-transform/cli', 'optimize', raw, OUT,
  '--compress', 'quantize', '--instance', 'false', '--simplify', 'false', '--join', 'false', '--flatten', 'false',
  '--texture-compress', 'webp', '--texture-size', '2048',
], { stdio: 'inherit', shell: process.platform === 'win32' });
rmSync(work, { recursive: true, force: true });
console.log(`${OUT}: ${(statSync(OUT).size / 1e6).toFixed(2)} MB, ${allBones.length} bones`);
