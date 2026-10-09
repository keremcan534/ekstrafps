// Objective anatomy / mesh-quality numbers for an untextured humanoid GLB in A-pose (the Meshy
// text-to-3D "master human" candidates), so base meshes can be scored side by side:
//   node scripts/humanoid-metrics.mjs <a.glb> [b.glb ...] [--json out.json]
// Y-up, facing +Z: the character's RIGHT hand is at -X, the LEFT at +X. Every triangle primitive
// is merged in world space (node transforms; skinned meshes are read in bind pose, skinning is
// ignored). Lengths are model units and % of body height (bbox Y extent). Heuristics are noted
// inline; the finger count (cross-section loops through the hand) is the one that matters most.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { NodeIO } from '@gltf-transform/core';

const args = process.argv.slice(2), ji = args.indexOf('--json'), jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
if (!args.length || (ji >= 0 && !jsonOut)) { console.error('usage: node scripts/humanoid-metrics.mjs <a.glb> [b.glb ...] [--json out.json]'); process.exit(1); }

// mulberry32: deterministic samples, so reruns give the same numbers
const rng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN); // a sorted
const stats = (v) => { const a = Float64Array.from(v).sort(); let s = 0; for (const x of a) s += x; return { mean: s / a.length, med: pct(a, 0.5), p95: pct(a, 0.95) }; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cat = (parts, C) => { const o = new C(parts.reduce((s, p) => s + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

async function load(file) {
  const root = (await new NodeIO().read(file)).getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const nodes = scene ? [] : root.listNodes().filter((n) => n.getMesh()), P = [], I = [], e = [0, 0, 0];
  scene?.traverse((n) => n.getMesh() && nodes.push(n));
  let nv = 0, prims = 0;
  for (const node of nodes) {
    const m = node.getWorldMatrix(); // column-major
    for (const p of node.getMesh().listPrimitives()) {
      const a = p.getAttribute('POSITION');
      if (p.getMode() !== 4 || !a) continue; // TRIANGLES only
      const n = a.getCount(), f = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) { a.getElement(i, e); for (let j = 0; j < 3; j++) f[3 * i + j] = m[j] * e[0] + m[4 + j] * e[1] + m[8 + j] * e[2] + m[12 + j]; }
      const ix = p.getIndices()?.getArray(), cnt = ix ? ix.length : n, t = new Uint32Array(cnt - (cnt % 3));
      for (let i = 0; i < t.length; i++) t[i] = (ix ? ix[i] : i) + nv;
      P.push(f); I.push(t); nv += n; prims++;
    }
  }
  return { pos: cat(P, Float64Array), idx: cat(I, Uint32Array), prims };
}

// Weld by a 1e-5*height position grid, drop collapsed triangles, build the topology tables.
function build({ pos, idx }) {
  const nv0 = pos.length / 3, nt0 = idx.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < lo[k]) lo[k] = pos[i]; if (pos[i] > hi[k]) hi[k] = pos[i]; }
  const size = sub(hi, lo), H = size[1];
  let q = 1e-5 * H;
  while (size.reduce((s, v) => s * (v / q + 2), 1) > 2 ** 52) q *= 2; // keep the integer key exact
  const ny = Math.floor(size[1] / q) + 2, nz = Math.floor(size[2] / q) + 2;
  const map = new Map(), W = new Int32Array(nv0), P = new Float64Array(nv0 * 3);
  let nw = 0;
  for (let i = 0; i < nv0; i++) {
    const key = (Math.round((pos[3 * i] - lo[0]) / q) * ny + Math.round((pos[3 * i + 1] - lo[1]) / q)) * nz + Math.round((pos[3 * i + 2] - lo[2]) / q);
    let w = map.get(key);
    if (w === undefined) { w = nw++; map.set(key, w); P[3 * w] = pos[3 * i]; P[3 * w + 1] = pos[3 * i + 1]; P[3 * w + 2] = pos[3 * i + 2]; }
    W[i] = w;
  }
  let T = new Int32Array(nt0 * 3), nt = 0;
  for (let t = 0; t < nt0; t++) {
    const a = W[idx[3 * t]], b = W[idx[3 * t + 1]], c = W[idx[3 * t + 2]];
    if (a === b || b === c || a === c) continue; // collapsed by the weld: counted as degenerate
    T[3 * nt] = a; T[3 * nt + 1] = b; T[3 * nt + 2] = c; nt++;
  }
  T = T.subarray(0, 3 * nt);
  const area = new Float64Array(nt), asp = new Float32Array(nt);
  let nAsp = 0, degenerate = nt0 - nt, A = 0, cxA = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const wx = vx - ux, wy = vy - uy, wz = vz - uz;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, ar = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    area[t] = ar; A += ar; cxA += (ar * (P[a] + P[b] + P[c])) / 3;
    if (ar <= 1e-12 * H * H) { degenerate++; continue; }
    const l2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
    asp[nAsp++] = (l2 * Math.sqrt(3)) / (4 * ar); // longest edge vs. altitude, equilateral = 1
  }
  const aspS = asp.subarray(0, nAsp).sort(), over10 = aspS.reduce((n, a) => n + (a > 10), 0);
  // edge use counts: sort the (min,max) vertex-pair keys and count runs
  const ek = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) { const a = T[3 * t + j], b = T[3 * t + ((j + 1) % 3)]; ek[3 * t + j] = a < b ? a * nw + b : b * nw + a; }
  ek.sort();
  let boundary = 0, nonmanifold = 0;
  for (let i = 0; i < ek.length; ) { let j = i + 1; while (j < ek.length && ek[j] === ek[i]) j++; if (j - i === 1) boundary++; else if (j - i > 2) nonmanifold++; i = j; }
  // connected components: union-find over welded triangles
  const par = new Int32Array(nw);
  for (let i = 0; i < nw; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < nt; t++) for (const b of [T[3 * t + 1], T[3 * t + 2]]) { const x = find(T[3 * t]), y = find(b); if (x !== y) par[x] = y; }
  const root = new Int32Array(nw), compTris = new Map(), compVerts = new Map();
  for (let i = 0; i < nw; i++) { root[i] = find(i); compVerts.set(root[i], (compVerts.get(root[i]) || 0) + 1); }
  for (let t = 0; t < nt; t++) compTris.set(root[T[3 * t]], (compTris.get(root[T[3 * t]]) || 0) + 1);
  const comps = [...compTris.values()].sort((a, b) => b - a);
  // vertex -> triangles (CSR), for flood fills
  const vo = new Int32Array(nw + 1), vt = new Int32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) vo[T[i] + 1]++;
  for (let i = 0; i < nw; i++) vo[i + 1] += vo[i];
  const cur = vo.slice(0, nw);
  for (let i = 0; i < nt * 3; i++) vt[cur[T[i]]++] = (i / 3) | 0;
  return {
    P, T, nt, nw, nv0, nt0, H, lo, hi, size, cx: cxA / A, area, root, compVerts, vo, vt,
    topo: { components: comps.length, compTris: comps.slice(0, 5), boundary, nonmanifold, degenerate, aspect: { med: pct(aspS, 0.5), p95: pct(aspS, 0.95), over10: (100 * over10) / (nAsp || 1) } },
  };
}

// Area-weighted random points on the given triangles (null = all).
function sample(M, tris, n, seed) {
  const r = rng(seed), N = tris ? tris.length : M.nt, cum = new Float64Array(N), out = new Float64Array(n * 3);
  let s = 0;
  for (let k = 0; k < N; k++) cum[k] = s += M.area[tris ? tris[k] : k];
  for (let i = 0; i < n && N; i++) {
    const u = r() * s;
    let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
    const t = tris ? tris[lo] : lo, a = 3 * M.T[3 * t], b = 3 * M.T[3 * t + 1], c = 3 * M.T[3 * t + 2];
    const s1 = Math.sqrt(r()), r2 = r(), wa = 1 - s1, wb = s1 * (1 - r2), wc = s1 * r2;
    for (let k = 0; k < 3; k++) out[3 * i + k] = wa * M.P[a + k] + wb * M.P[b + k] + wc * M.P[c + k];
  }
  return out;
}

// Uniform hash grid; nearest() grows cube shells until no closer point can exist (capped at rMax cells).
function grid(pts, cell, o) {
  const g = new Map(), key = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
  const c = (v, k) => Math.floor((v - o[k]) / cell);
  for (let i = 0; i < pts.length / 3; i++) { const k = key(c(pts[3 * i], 0), c(pts[3 * i + 1], 1), c(pts[3 * i + 2], 2)); (g.get(k) || g.set(k, []).get(k)).push(i); }
  return { g, cell, pts, key, c };
}
function nearest(G, x, y, z, rMax = 5) {
  const { g, cell, pts, key, c } = G, ix = c(x, 0), iy = c(y, 1), iz = c(z, 2);
  let best = Infinity;
  for (let r = 0; r <= rMax; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const l = g.get(key(ix + dx, iy + dy, iz + dz));
      if (l) for (const i of l) { const ex = pts[3 * i] - x, ey = pts[3 * i + 1] - y, ez = pts[3 * i + 2] - z, d = ex * ex + ey * ey + ez * ez; if (d < best) best = d; }
    }
    if (best <= (r * cell) ** 2) break;
  }
  return Math.min(Math.sqrt(best), rMax * cell);
}
// Distances (% height) from the query points, mirrored about x = mx (null: not mirrored), to the target set.
const mirrorDist = (M, G, q, mx) => { const d = new Float64Array(q.length / 3); for (let i = 0; i < d.length; i++) d[i] = (100 * nearest(G, mx === null ? q[3 * i] : 2 * mx - q[3 * i], q[3 * i + 1], q[3 * i + 2])) / M.H; return d; };
// Triangles whose centroid lies in the cube of half-size r around p (hash grid of triangle centroids).
function near(M, p, r) {
  if (!M.tg) {
    const c = new Float64Array(M.nt * 3);
    for (let i = 0; i < M.nt * 3; i++) { const t = 3 * ((i / 3) | 0), j = i % 3; c[i] = (M.P[3 * M.T[t] + j] + M.P[3 * M.T[t + 1] + j] + M.P[3 * M.T[t + 2] + j]) / 3; }
    M.tg = grid(c, 0.04 * M.H, M.lo);
  }
  const { g, key, c, cell } = M.tg, n = Math.ceil(r / cell), ix = c(p[0], 0), iy = c(p[1], 1), iz = c(p[2], 2), out = [];
  for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (let dz = -n; dz <= n; dz++) { const l = g.get(key(ix + dx, iy + dy, iz + dz)); if (l) for (const t of l) out.push(t); }
  return Int32Array.from(out);
}

// Cut the triangles with the plane n·p = off. Each crossing triangle gives one segment whose ends sit
// on two of its edges; ends are keyed by welded edge, so segments sharing an edge join up and every
// connected group is one cross-section loop (or an open chain where the triangle set ends).
function slice(M, tris, n, off) {
  const { P, T, nw } = M, N = tris ? tris.length : M.nt, ids = new Map(), seg = [], ends = [];
  const D = (v) => P[3 * v] * n[0] + P[3 * v + 1] * n[1] + P[3 * v + 2] * n[2] - off;
  const cross = (u, w, du, dw) => {
    if (u > w) [u, w, du, dw] = [w, u, dw, du]; // same point from both triangles on the edge
    const k = u * nw + w, f = du / (du - dw);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    ends.push(id);
    for (let j = 0; j < 3; j++) seg.push(P[3 * u + j] + f * (P[3 * w + j] - P[3 * u + j]));
  };
  for (let k = 0; k < N; k++) {
    const t = tris ? tris[k] : k, a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    const da = D(a), db = D(b), dc = D(c), sa = da >= 0, sb = db >= 0, sc = dc >= 0; // d=0 counts as above: no double hits
    if (sa === sb && sb === sc) continue;
    if (sa !== sb) cross(a, b, da, db);
    if (sb !== sc) cross(b, c, db, dc);
    if (sc !== sa) cross(c, a, dc, da);
  }
  const par = Int32Array.from({ length: ids.size }, (_, i) => i), use = new Int32Array(ids.size);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let s = 0; s < ends.length; s += 2) { use[ends[s]]++; use[ends[s + 1]]++; const a = find(ends[s]), b = find(ends[s + 1]); if (a !== b) par[a] = b; }
  const by = new Map();
  for (let s = 0; s < ends.length / 2; s++) {
    const r = find(ends[2 * s]), p = seg.slice(6 * s, 6 * s + 6), l = Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]);
    let L = by.get(r);
    if (!L) by.set(r, (L = { segs: [], perim: 0, sum: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], closed: true }));
    L.segs.push(s); L.perim += l;
    for (let j = 0; j < 3; j++) { L.sum[j] += ((p[j] + p[j + 3]) / 2) * l; L.min[j] = Math.min(L.min[j], p[j], p[j + 3]); L.max[j] = Math.max(L.max[j], p[j], p[j + 3]); }
    if (use[ends[2 * s]] !== 2 || use[ends[2 * s + 1]] !== 2) L.closed = false;
  }
  const loops = [...by.values()];
  for (const L of loops) L.c = L.perim ? L.sum.map((v) => v / L.perim) : L.min.map((v, j) => (v + L.max[j]) / 2);
  return { seg, loops };
}
// Is point q inside loop L of slice S (plane normal n)? Even-odd ray cast in the plane.
function inside(S, L, q, n) {
  const u = unit(Math.abs(n[0]) < 0.9 ? [0, n[2], -n[1]] : [-n[2], 0, n[0]]), v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  let odd = false;
  for (const i of L.segs) {
    const a = sub(S.seg.slice(6 * i, 6 * i + 3), q), b = sub(S.seg.slice(6 * i + 3, 6 * i + 6), q), av = dot(a, v), bv = dot(b, v);
    if (av > 0 !== bv > 0 && dot(a, u) + ((dot(b, u) - dot(a, u)) * av) / (av - bv) > 0) odd = !odd;
  }
  return odd;
}
// Smallest distance between two loops of one planar slice (endpoint-to-segment both ways; exact for
// coplanar segments that don't cross, ~0 for crossing ones). B's segments are pre-culled to A's box.
function loopDist(S, A, B, cap) {
  const s = S.seg, inBox = (L, i) => s[i] > L.min[0] - cap && s[i] < L.max[0] + cap && s[i + 1] > L.min[1] - cap && s[i + 1] < L.max[1] + cap && s[i + 2] > L.min[2] - cap && s[i + 2] < L.max[2] + cap;
  const ps = (px, py, pz, i) => {
    const ax = s[i], ay = s[i + 1], az = s[i + 2], dx = s[i + 3] - ax, dy = s[i + 4] - ay, dz = s[i + 5] - az, l2 = dx * dx + dy * dy + dz * dz;
    const f = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(px - ax - f * dx, py - ay - f * dy, pz - az - f * dz);
  };
  let best = cap;
  const bs = B.segs.filter((j) => inBox(A, 6 * j) || inBox(A, 6 * j + 3));
  for (const i of A.segs) for (const j of bs) for (let e = 0; e < 6; e += 3) {
    best = Math.min(best, ps(s[6 * i + e], s[6 * i + e + 1], s[6 * i + e + 2], 6 * j), ps(s[6 * j + e], s[6 * j + e + 1], s[6 * j + e + 2], 6 * i));
  }
  return best;
}

// Shoulder joint per side (s = +1 left, -1 right) at 81% height: the torso's lateral extent in
// horizontal slices at 78–84% (the cut's x-intervals merged, the one holding the centroid = torso,
// so hands raised into the band don't count). If that reaches > 0.3*height out (an arm in the band,
// T-pose-like), the torso's extent at 72% (under a raised arm); failing that, the 90th percentile of
// the band vertices' |x| (that one lands out on a raised arm, hence last).
function shoulder(M, s) {
  const { P, H, nw, cx, lo } = M, y0 = lo[1] + 0.78 * H, y1 = lo[1] + 0.84 * H, med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const torso = (f) => { // [lateral extent, z there] of the torso cut at f*height
    const S = slice(M, null, [0, 1, 0], lo[1] + f * H), m = [];
    for (const l of S.loops.sort((a, b) => a.min[0] - b.min[0])) { const t = m[m.length - 1]; if (t && l.min[0] <= t.hi) { t.hi = Math.max(t.hi, l.max[0]); t.ls.push(l); } else m.push({ lo: l.min[0], hi: l.max[0], ls: [l] }); }
    const t = m.find((i) => i.lo <= cx && i.hi >= cx), lat = t && (s > 0 ? t.hi - cx : cx - t.lo), z = [];
    if (t) for (const l of t.ls) for (const i of l.segs) if (s * (S.seg[6 * i] - cx) > lat - 0.02 * H) z.push(S.seg[6 * i + 2]);
    return t ? [lat, med(z)] : [Infinity, 0];
  };
  const band = [0.78, 0.8, 0.82, 0.84].map(torso);
  let [lat, z] = [med(band.map((b) => b[0])), med(band.map((b) => b[1]))], how = 'torso';
  if (!(lat <= 0.3 * H)) [[lat, z], how] = [torso(0.72), 'chest'];
  if (!(lat <= 0.3 * H)) {
    const vs = []; // [lateral, z] of the band's vertices on this side
    for (let v = 0; v < nw; v++) { const y = P[3 * v + 1], l = s * (P[3 * v] - cx); if (y >= y0 && y <= y1 && l > 0) vs.push([l, P[3 * v + 2]]); }
    lat = pct(vs.map((b) => b[0]).sort((a, b) => a - b), 0.9); how = 'p90';
    z = med(vs.filter((b) => Math.abs(b[0] - lat) < 0.02 * H).map((b) => b[1]));
  }
  return { p: [cx + s * lat, lo[1] + 0.81 * H, z], how };
}

// Hand region: within 0.11*height of the extreme-|X| vertex, below the chin (90% height, not the
// shoulder: these "A-poses" can hold the hands up at shoulder height), and reached from that vertex
// over the mesh inside the sphere (keeps a nearby thigh or hip out); plus other mesh pieces lying
// mostly inside the sphere (detached fingers).
function handRegion(M, s) {
  const { P, T, H, nw, vo, vt, root, compVerts } = M;
  let e = 0;
  for (let v = 1; v < nw; v++) if (s * P[3 * v] > s * P[3 * e]) e = v;
  const R2 = (0.11 * H) ** 2, inS = new Uint8Array(nw), inCnt = new Map();
  for (let v = 0; v < nw; v++) {
    const dx = P[3 * v] - P[3 * e], dy = P[3 * v + 1] - P[3 * e + 1], dz = P[3 * v + 2] - P[3 * e + 2];
    if (P[3 * v + 1] < M.lo[1] + 0.9 * H && dx * dx + dy * dy + dz * dz < R2) { inS[v] = 1; inCnt.set(root[v], (inCnt.get(root[v]) || 0) + 1); }
  }
  const stack = [e];
  inS[e] = 2; // 2 = in the hand
  while (stack.length) {
    const v = stack.pop();
    for (let k = vo[v]; k < vo[v + 1]; k++) for (let j = 0; j < 3; j++) { const u = T[3 * vt[k] + j]; if (inS[u] === 1) { inS[u] = 2; stack.push(u); } }
  }
  for (let v = 0; v < nw; v++) if (inS[v] === 1 && root[v] !== root[e] && inCnt.get(root[v]) >= 0.5 * compVerts.get(root[v])) inS[v] = 2;
  const verts = [], tris = [];
  for (let v = 0; v < nw; v++) if (inS[v] === 2) verts.push(v);
  for (let t = 0; t < M.nt; t++) if (inS[T[3 * t]] === 2 && inS[T[3 * t + 1]] === 2 && inS[T[3 * t + 2]] === 2) tris.push(t);
  return { e, verts, tris: Int32Array.from(tris) };
}

// Hand long axis (PCA, oriented away from the shoulder), then 25 slices over its distal 70%:
// loops per slice ~ separate fingers (4–5 distinct, 1 = mitten). Loops under 0.3% height perimeter are specks.
function fingers(M, hand, sh) {
  const { P, H } = M, C = [0, 0, 0], cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of hand.verts) for (let j = 0; j < 3; j++) C[j] += P[3 * v + j] / hand.verts.length;
  for (const v of hand.verts) { const d = sub([P[3 * v], P[3 * v + 1], P[3 * v + 2]], C); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[3 * i + j] += d[i] * d[j]; }
  const armDir = unit(sub(C, sh));
  let ax = armDir;
  for (let it = 0; it < 60; it++) ax = unit([0, 1, 2].map((i) => cov[3 * i] * ax[0] + cov[3 * i + 1] * ax[1] + cov[3 * i + 2] * ax[2])); // power iteration
  if (dot(ax, armDir) < 0) ax = ax.map((v) => -v);
  const pcaOk = dot(ax, armDir) > 0.3; // PCA > 72° off the shoulder→hand line: region too round to trust, use that line
  if (!pcaOk) ax = armDir;
  let tMin = Infinity, tMax = -Infinity;
  for (const v of hand.verts) { const t = dot([P[3 * v], P[3 * v + 1], P[3 * v + 2]], ax); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
  const profile = [], at = [];
  for (let i = 0; i < 25; i++) {
    const f = 0.3 + (0.7 * (i + 0.5)) / 25;
    at.push(f);
    profile.push(slice(M, hand.tris, ax, tMin + f * (tMax - tMin)).loops.filter((L) => L.perim >= 0.003 * H).length);
  }
  let sustained = 0;
  for (let i = 0; i + 2 < profile.length; i++) sustained = Math.max(sustained, Math.min(profile[i], profile[i + 1], profile[i + 2]));
  const thumb = profile.some((c, i) => at[i] >= 0.3 && at[i] <= 0.6 && c >= 2); // a 2nd loop on the wrist side of the hand
  const wrist = [0, 0, 0], wv = hand.verts.filter((v) => dot([P[3 * v], P[3 * v + 1], P[3 * v + 2]], ax) < tMin + 0.1 * (tMax - tMin)); // region's proximal end ~ wrist (hand ~0.11*height long)
  for (const v of wv) for (let j = 0; j < 3; j++) wrist[j] += P[3 * v + j] / wv.length;
  return { centroid: C, wrist, axis: ax, pcaOk, length: tMax - tMin, verts: hand.verts.length, tris: hand.tris.length, max: Math.max(...profile), sustained, thumb, profile };
}

// Arm march (arm clearance + continuity; replaces fixed slices along a straight shoulder→hand line,
// which miss a bent elbow): cross-sections every 2% of height from the wrist toward the shoulder, each
// plane perpendicular to the direction of travel and re-centred on the arm loop (largest loop around
// the centre, else the largest whose box holds it, else the nearest). Each step also tries the plane
// turned half / fully toward the shoulder and keeps the smallest arm loop (the most square-on cut),
// preferring a closed loop found around the centre over the fallbacks (stray fragments).
// A loop over 1.7x the median so far or > 0.18*height across has joined the torso: the armpit, or a
// fused arm if that happens > 0.15*height from the shoulder. Gap = distance in the plane to loops
// outside the arm loop (torso, hip; capped at 12% = nothing near); loops nested inside it are extra shells.
function armMarch(M, sh, fg) {
  const { H } = M, step = 0.02 * H, out = [];
  let c = fg.wrist, d = fg.axis.map((v) => -v), stop = 'steps';
  const cut = (dir) => {
    const p = c.map((v, j) => v + dir[j] * step), S = slice(M, near(M, p, 0.12 * H), dir, dot(dir, p)), big = (a, b) => (b.perim > a.perim ? b : a);
    const loops = S.loops.filter((l) => l.perim >= 0.003 * H), around = loops.filter((l) => inside(S, l, p, dir));
    const boxed = loops.filter((l) => [0, 1, 2].every((j) => p[j] > l.min[j] - 0.01 * H && p[j] < l.max[j] + 0.01 * H));
    const arm = around.length ? around.reduce(big) : boxed.length ? boxed.reduce(big) : loops.filter((l) => len(sub(l.c, p)) < 0.06 * H).sort((a, b) => len(sub(a.c, p)) - len(sub(b.c, p)))[0];
    const tier = around.length ? (arm.closed ? 0 : 1) : boxed.length ? 2 : 3;
    return { S, loops, arm, dir, p, tier, wide: arm ? Math.max(...arm.max.map((v, j) => v - arm.min[j])) : 0 };
  };
  for (let k = 0; k < 40; k++) {
    const med = out.map((o) => o.perim).sort((a, b) => a - b)[out.length >> 1], toSh = unit(sub(sh, c));
    const xs = [0, 0.5, 1].map((t) => cut(unit(d.map((v, j) => (1 - t) * v + t * toSh[j])))).filter((x) => x.arm);
    if (!xs.length) { stop = 'lost'; break; }
    const x = xs.reduce((a, b) => (b.tier < a.tier || (b.tier === a.tier && b.arm.perim < a.arm.perim) ? b : a));
    if ((out.length >= 3 && x.arm.perim > 1.7 * med) || x.wide > 0.18 * H) { stop = len(sub(c, sh)) > 0.15 * H ? 'fused' : 'armpit'; break; }
    const { S, loops, arm } = x;
    let gap = 0.12 * H, extra = 0;
    for (const o of loops) if (o !== arm) { if (inside(S, arm, o.c, x.dir)) extra++; else if (len(sub(o.c, x.p)) > (1.2 * arm.perim) / (2 * Math.PI)) gap = loopDist(S, arm, o, gap); } // (closer = a piece of a broken arm loop)
    out.push({ c: arm.c, perim: arm.perim, closed: arm.closed, loops: 1 + extra, gap });
    d = unit(x.dir.map((v, j) => v + unit(sub(arm.c, c))[j]));
    c = arm.c;
    if (len(sub(c, sh)) < 0.06 * H) { stop = 'shoulder'; break; }
  }
  // clearance: smallest gap more than 0.08*height (along the path) before the march ended, i.e. not the armpit itself
  let path = 0;
  for (let i = out.length - 1; i >= 0; i--) { out[i].toEnd = path; if (i) path += len(sub(out[i].c, out[i - 1].c)); }
  const g = out.filter((o) => o.toEnd >= 0.08 * H).map((o) => o.gap), flags = [], ph = (v) => ((100 * v) / H).toFixed(1);
  out.forEach((o, k) => {
    const nb = [out[k - 1], out[k + 1]].filter(Boolean), m = nb.reduce((s, n) => s + n.perim, 0) / (nb.length || 1);
    if (o.perim < 0.5 * m) flags.push(`pinch ${ph(o.perim)}% vs ${ph(m)}% @${ph(path - o.toEnd)}`);
    if (o.loops > 1) flags.push(`${o.loops} loops @${ph(path - o.toEnd)}`);
  });
  if (stop === 'fused') flags.push(`fused to body ${ph(len(sub(c, sh)))}% from shoulder`);
  return { stop, length: path, clearance: stop === 'fused' ? 0 : g.length ? Math.min(...g) : null, flags, steps: out };
}

// Leg gap at one height: distance between the innermost loops either side of the centroid; 0 if one loop spans it.
function legGap(M, y) {
  const S = slice(M, null, [0, 1, 0], y), L = S.loops.filter((l) => l.perim >= 0.01 * M.H);
  if (L.some((l) => l.min[0] <= M.cx && l.max[0] >= M.cx)) return 0;
  const r = L.filter((l) => l.max[0] < M.cx).sort((a, b) => b.max[0] - a.max[0])[0], l = L.filter((l) => l.min[0] > M.cx).sort((a, b) => a.min[0] - b.min[0])[0];
  return r && l ? loopDist(S, r, l, 0.3 * M.H) : null;
}

function analyze(file, raw) {
  const t0 = Date.now(), M = build(raw), { H, size, cx, lo } = M, ph = (u) => (u == null ? null : (100 * u) / H);
  // symmetry: 20k mirrored samples vs a 100k-point copy of the surface; "floor" = unmirrored samples
  // (sampling noise); distances are capped at 10% of height (5 grid cells)
  const tgt = sample(M, null, 100000, 1), q = sample(M, null, 20000, 2), G = grid(tgt, 0.02 * H, lo);
  const sym = { x0: stats(mirrorDist(M, G, q, 0)), xc: stats(mirrorDist(M, G, q, cx)), floor: stats(mirrorDist(M, G, q, null)) };
  const sides = {};
  for (const [name, s] of [['R', -1], ['L', 1]]) {
    const sh = shoulder(M, s), hand = handRegion(M, s), fg = fingers(M, hand, sh.p), v = sub(fg.centroid, sh.p);
    const angle = (Math.acos(-v[1] / len(v)) * 180) / Math.PI; // vs. straight down: A-pose ~35–50°, T-pose ~90°
    sides[name] = { shoulder: sh, hand, angle, fingers: fg, arm: armMarch(M, sh.p, fg) };
  }
  // hands: 5k points per hand, mirrored onto a 40k-point copy of both hands' surfaces (distances capped at 5%)
  const both = Int32Array.from([...sides.R.hand.tris, ...sides.L.hand.tris]), ht = sample(M, both, 40000, 3), HG = grid(ht, 0.01 * H, lo);
  const hq = [sample(M, sides.R.hand.tris, 5000, 4), sample(M, sides.L.hand.tris, 5000, 5)];
  sym.hands = stats([...mirrorDist(M, HG, hq[0], cx), ...mirrorDist(M, HG, hq[1], cx)]);
  sym.handsFloor = stats([...mirrorDist(M, HG, hq[0], null), ...mirrorDist(M, HG, hq[1], null)]);
  const legs = [];
  for (let k = 0; k < 8; k++) { const f = 0.05 + (0.35 * k) / 7; legs.push({ yPct: +(100 * f).toFixed(1), gap: legGap(M, lo[1] + f * H) }); }
  const lg = legs.map((x) => x.gap).filter((x) => x != null), legGapMin = lg.length ? Math.min(...lg) : null;
  return {
    file: basename(file), path: file, seconds: (Date.now() - t0) / 1000,
    basics: { vertices: M.nv0, triangles: M.nt0, primitives: raw.prims, weldedVertices: M.nw, bbox: { min: lo, max: M.hi, size }, height: H, width: size[0], depth: size[2], widthPct: ph(size[0]), depthPct: ph(size[2]) },
    topology: { ...M.topo, largestPct: (100 * M.topo.compTris[0]) / M.nt },
    centroidX: cx, centroidXPct: ph(cx), symmetry: sym,
    sides: Object.fromEntries(Object.entries(sides).map(([k, s]) => [k, {
      shoulder: s.shoulder, handExtremeVertex: s.hand.e, armAngleDeg: s.angle, clearance: s.arm.clearance, clearancePct: ph(s.arm.clearance),
      fingers: { ...s.fingers, lengthPct: ph(s.fingers.length) },
      arm: { stop: s.arm.stop, lengthPct: ph(s.arm.length), flags: s.arm.flags, steps: s.arm.steps.map((o) => ({ c: o.c, perimPct: ph(o.perim), gapPct: ph(o.gap), loops: o.loops, closed: o.closed })) },
    }])),
    legGap: legGapMin, legGapPct: ph(legGapMin), legProfile: legs.map((x) => ({ yPct: x.yPct, pct: ph(x.gap) })),
  };
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const p = (v, d = 1) => (v == null || Number.isNaN(v) ? '-' : `${v.toFixed(d)}%`);
const u = (v) => (v == null ? '-' : v.toPrecision(3));
function report(r) {
  const b = r.basics, t = r.topology, s = r.symmetry, R = r.sides.R, L = r.sides.L;
  const fg = (x) => `max ${x.fingers.max} sustained ${x.fingers.sustained} thumb ${x.fingers.thumb ? 'yes' : 'no'} [${x.fingers.profile.map((c) => (c > 9 ? '+' : c)).join('')}]${x.fingers.pcaOk ? '' : ' (arm axis)'}`;
  const clr = (x) => (x.clearancePct >= 11.99 ? '>12%' : `${p(x.clearancePct)} (${u(x.clearance)})`);
  const arm = (x) => `${x.arm.steps.map((o) => o.perimPct.toFixed(0) + (o.closed ? '' : '~')).join(' ')} (${x.arm.stop} after ${p(x.arm.lengthPct, 0)})`;
  const flags = [...R.arm.flags.map((f) => `R ${f}`), ...L.arm.flags.map((f) => `L ${f}`)];
  return [
    `${r.file}  tris ${k(b.triangles)} verts ${k(b.vertices)} (welded ${k(b.weldedVertices)}) prims ${b.primitives}  height ${u(b.height)}  width ${u(b.width)} (${p(b.widthPct, 0)}) depth ${u(b.depth)} (${p(b.depthPct, 0)})`,
    `  topology: ${t.components} comps (largest ${p(t.largestPct)}${t.compTris.length > 1 ? `, next ${t.compTris.slice(1, 4).map(k).join('/')} tris` : ''}), boundary ${t.boundary}, nonmanifold ${t.nonmanifold}, degenerate ${t.degenerate}, aspect med ${t.aspect.med.toFixed(2)} p95 ${t.aspect.p95.toFixed(1)} >10 ${p(t.aspect.over10, 2)}`,
    `  symmetry: x=0 mean ${p(s.x0.mean, 2)} med ${p(s.x0.med, 2)} p95 ${p(s.x0.p95, 2)} | x=cx mean ${p(s.xc.mean, 2)} p95 ${p(s.xc.p95, 2)} | hands ${p(s.hands.mean, 2)}/${p(s.hands.p95, 2)} | floor ${p(s.floor.mean, 2)}/${p(s.handsFloor.mean, 2)}  centroidX ${r.centroidX >= 0 ? '+' : ''}${u(r.centroidX)} (${p(r.centroidXPct, 2)})`,
    `  arms: R ${R.armAngleDeg.toFixed(1)}° L ${L.armAngleDeg.toFixed(1)}°  clearance R ${clr(R)} L ${clr(L)}   legs gap ${p(r.legGapPct)} (${u(r.legGap)})${R.shoulder.how !== 'torso' || L.shoulder.how !== 'torso' ? `  [shoulder from ${R.shoulder.how}/${L.shoulder.how}]` : ''}`,
    `  fingers: R ${fg(R)} | L ${fg(L)}`,
    `  arm perim% wrist→shoulder (~ open): R ${arm(R)} | L ${arm(L)}`,
    `  wrist pinch: ${flags.length ? flags.join('; ') : 'none'}`,
  ].join('\n');
}

const results = [];
for (const f of args) {
  try { results.push(analyze(f, await load(f))); console.log(report(results.at(-1))); }
  catch (err) { console.error(`${f}: ${err.stack || err}`); results.push({ file: basename(f), path: f, error: String(err) }); }
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(results, null, 1)); console.log(`wrote ${jsonOut}`); }
