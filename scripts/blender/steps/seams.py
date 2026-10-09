"""Raised seam piping on the inner arms and torso sides -> faired away.

The sleeve's underarm seam is a piping ridge (about 10 mm across at its base, 2-5 mm high, steep and
near the armpit undercut) running along the inside of each arm from the forearm to the armpit, where it
meets the side seam that runs down the torso to the waistband (a V at the armpit).

Found: its crest line is TRACED on the mesh with exact plane sections. Across a seam, a section is a
curve with a narrow bump; the bump's height is the curve's band-pass offset along the surface normal
(Gaussian low-pass at a fraction of a millimetre minus one at the ridge scale, so the limb's own
curvature cancels). The trace starts at the strongest such bump on the inner-lower side of an
upper-arm section (arm seam) and on the lateral side of horizontal torso sections (side seam), then
steps along the crest: each step cuts a section across the current direction a few millimetres ahead,
takes the bump nearest the prediction (on the surface being followed, facing the same way) and turns
gently toward it. It stops where the bump fades (cuff, waistband) or would need a sharp turn (the
armpit); the arm and side crests are joined there along the shortest path on the surface. Nothing is
classified per vertex, so folds, the belt and the elbow creases cannot be picked up: a trace only ever
follows one continuous longitudinal ridge.

Removed, inside a band whose width comes from the measured ridge (geodesic distance from the crest,
so it never jumps the armpit gap):
  1. ridge-free normals: the vertex normals heat-diffused over a fixed length (normalSigmaMm);
  2. tangential re-spacing: the flanks' crowded / undercut vertices are spread over the base by a
     screened harmonic map in the tangent planes (motion along the seam penalised), then any triangle
     still near edge-on is untangled locally, so the fill cannot fold a triangle;
  3. fill: a scalar displacement along the ridge-free normal minimising the squared difference between
     the cotangent Laplace-Beltrami of the surface (thin plate) and the curvature the band's
     surroundings have, carried across the band by harmonic interpolation (so the limb's roundness and
     the wrinkles that run into the band carry on across it instead of being flattened); all vertices
     outside the band fixed, so the fill meets the surroundings in position and slope; it may rise at
     most focalFrac of the normal field's focal distance (an offset that reaches it folds);
  4. soft mask: the fill replaces the ridge out to its base troughs and fades out over taperMm.
Where a crest ends freely (on the forearm, at the waistband's top lip) the band stops endMarginMm
inside the traced end and fades in over endTaperMm, so nothing at or beyond the end moves: whatever the
piping runs into there (sleeve wrinkles, the waistband) stays untouched.
Where the arm and side seams meet in the armpit (the V) the piping turns round the top of the armpit
slit; there the two bands overlap at a sharp turn and leave a crumpled lip, so the junction is refilled
afterwards as one 2D patch: a geodesic disc round the V's vertex, re-spaced and filled by a 3D thin
plate (uniform Laplacian) with the line fill around it fixed, then refined by the cotangent thin plate
along its normals (see _junction). The slit's own walls (beyond the piping's base) are no part of the
seam and stay fixed for both fills, so neither can span the slit.
"""
import heapq
import math

import numpy as np
from mathutils import kdtree
from mathutils.bvhtree import BVHTree

import humanoid as hu
from steps.common import log, smoothstep


def _defaults(P):
    d = {
        'minCrestMm': 0.6,  # crest height over its higher base trough to count as seam (mm)
        'sigmaSmallMm': 0.4, 'sigmaLargeMm': 4.0,  # band-pass of a section curve (mm)
        'sampleMm': 0.25,  # section curves are resampled at this spacing (mm)
        'stepMm': 3.0, 'sectionRadiusMm': 25.0, 'searchMm': 4.0,  # trace step, local section reach, peak search window
        'offSurfaceMm': 2.0, 'maxTurnDeg': 20.0, 'turnBaseline': 3, 'follow': 0.5, 'maxMisses': 3, 'maxSteps': 300,
        'endRefineMm': 0.5,  # a trace's end is located to this precision (see _trace)
        'armSeedArc': 0.62,  # arm seed station, fraction of the arm line from the fingertip to the armpit
        'torsoScanMm': [40.0, 220.0],  # torso seeds: horizontal sections this far below the arm trace's top
        'minTipDist': 0.12,  # the arm trace never comes closer to the fingertip than this x height (geodesic)
        'joinMm': 20.0,  # arm and torso crests whose ends are this close meet at the armpit
        'vBackMm': 9.0,  # the crests' arriving directions at the armpit, over this much of their length
        # The band: fully refilled from the crest out to its farther base trough + margin (clamped), then
        # the fill fades out over taperMm (soft mask), and the fill's own band reaches padMm further
        # (everything beyond is fixed).
        'fullMarginMm': 1.0, 'fullMinMm': 4.0, 'fullMaxMm': 9.0, 'taperMm': 4.0, 'padMm': 1.0,
        'coreMm': 1.5,  # vertices this close to the crest line seed the band's geodesic distance
        'normalSigmaMm': 8.0, 'normalSteps': 8,  # ridge-free normals: heat diffusion length, implicit steps
        # Tangential re-spacing before the fill (screened harmonic map; along-seam motion penalised),
        # over the fully refilled zone + respaceExtraMm, then local untangling of triangles still facing
        # within minFacing of edge-on.
        'respace': True, 'respaceReg': 0.5, 'respaceAlong': 20.0, 'respaceExtraMm': 4.0,
        'minFacing': 0.15, 'untangleRounds': 300,
        # Fill: cotangent thin plate along the ridge-free normal, operator rebuilt `reweight` times; the
        # surface may rise at most focalFrac x the normal field's focal distance (and maxOutMm), so the
        # armpit hollow where the seams meet is not filled so far that it folds (obstacle, active set).
        'cotClamp': [-2.0, 10.0], 'reweight': 3, 'maxOutMm': 6.0, 'focalFrac': 0.25, 'activeSetRounds': 6,
        'fitMm': None, 'fitEps': 1e-3, 'fitRounds': 12,
        'cgIterations': 6000, 'cgTol': 1e-9,
        # The fill's target curvature: the curvature around the band carried across it (see
        # _carried_curvature): data from curvSmoothRings + 2 rings round it, low-passed over curvSigmaMm;
        # the slit's walls and edges (within curvSlitMm of a wall vertex) are no data.
        'carryCurvature': True, 'curvSmoothRings': 3, 'curvSigmaMm': 2.0, 'curvSlitMm': 2.0, 'curvAcross': 1.0, 'curvCoreMm': None,
        # Free crest ends (forearm, waistband): nothing at or beyond the traced end moves. The band stops
        # endMarginMm inside the end (measured along the crest) and its fill fades in over endTaperMm.
        'endMarginMm': 3.0, 'endTaperMm': 4.0,
        # The armpit junction (where the arm crest is joined to the side crest) is a 2D patch: the
        # geodesic disc of apexRadiusMm around the V's vertex is refilled as a whole (see _junction;
        # on c12 the result is clean for 9-11 mm: smaller discs leave the line fill's crumple at their
        # rim, larger ones round the junction more). Within apexSlitReachMm of it, the walls of the armpit slit (a
        # ray along the normal meets the facing wall within apexSlitMm), beyond the piping's base,
        # are fixed for both fills, so neither can span the slit and pull its walls together.
        'apex': True, 'apexRadiusMm': 10.0, 'apexCotanPasses': 1, 'apexSlitMm': 5.0, 'apexSlitReachMm': 25.0,
        'apexCarry': True, 'apexFreeWallMm': 0.0, 'apexAlong': 1.0, 'apexCurvSigmaMm': 2.0, 'apexAniso': 1.0, 'apexFixAllWalls': False, 'apexRestoreWalls': False, 'apexWallFollow': False, 'wallFollow': False,
    }
    d.update({k: v for k, v in P.items() if k in d})
    return d


# ---------------------------------------------------------------- sections across the seam

def _chain(mesh, X, N, p, n, radius):
    """The plane (p, n) section curve through the surface nearest p, cut to the triangles within
    `radius` of p: ordered points and interpolated vertex normals."""
    s = (X - p) @ n
    st = s[mesh.T]
    cand = mesh.T[(st.min(axis=1) < 0) & (st.max(axis=1) > 0)]
    cand = cand[np.linalg.norm(X[cand].mean(axis=1) - p, axis=1) < radius]
    if len(cand) < 4:
        return None
    adj, pts = {}, {}
    for a, b, c in cand.tolist():
        keys = []
        for u, v in ((a, b), (b, c), (c, a)):
            if (s[u] < 0) != (s[v] < 0):
                k = (u, v) if u < v else (v, u)
                keys.append(k)
                if k not in pts:
                    t = s[u] / (s[u] - s[v])
                    pts[k] = (X[u] + (X[v] - X[u]) * t, N[u] + (N[v] - N[u]) * t)
        if len(keys) == 2:
            adj.setdefault(keys[0], []).append(keys[1])
            adj.setdefault(keys[1], []).append(keys[0])
    seen = set()
    best, bd = None, math.inf
    for k0 in [k for k, v in adj.items() if len(v) == 1] + list(adj):
        if k0 in seen:
            continue
        chain = [k0]
        seen.add(k0)
        prev, cur = None, k0
        while True:
            nxt = [k for k in adj[cur] if k != prev and k not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            chain.append(cur)
        if len(chain) > 5:
            d = float(np.linalg.norm(np.array([pts[k][0] for k in chain]) - p, axis=1).min())
            if d < bd:
                bd, best = d, chain
    if best is None:
        return None
    return np.array([pts[k][0] for k in best]), np.array([pts[k][1] for k in best])


def _gsmooth(A, sig, ds):
    """Gaussian low-pass of an open, uniformly sampled sequence (odd reflection keeps end slopes)."""
    w = max(1, int(3 * sig / ds))
    k = np.arange(-w, w + 1) * ds
    g = np.exp(-0.5 * (k / sig) ** 2)
    g /= g.sum()
    n = len(A)
    pad = min(w, n - 1)
    B = np.concatenate([2 * A[0] - A[1:pad + 1][::-1], A, 2 * A[-1] - A[-pad - 1:-1][::-1]])
    if B.ndim == 1:
        out = np.convolve(B, g, mode='same')
    else:
        out = np.stack([np.convolve(B[:, j], g, mode='same') for j in range(B.shape[1])], axis=1)
    return out[pad:pad + n]


def _profile(C, Cn, n, Q):
    """Band-pass height profile of a section curve: (arc, points, smooth normals, height)."""
    ds = Q['sampleMm'] / 1000.0
    seg = np.linalg.norm(np.diff(C, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    if s[-1] < 0.01:
        return None
    su = np.arange(0.0, s[-1], ds)
    Pu = np.stack([np.interp(su, s, C[:, j]) for j in range(3)], axis=1)
    Nu = np.stack([np.interp(su, s, Cn[:, j]) for j in range(3)], axis=1)
    sl = Q['sigmaLargeMm'] / 1000.0
    N3 = _gsmooth(Nu, sl, ds)  # the surface normal (3D), low-passed along the curve
    N3 /= np.maximum(np.linalg.norm(N3, axis=1), 1e-12)[:, None]
    Nu -= np.outer(Nu @ n, n)
    Nl = _gsmooth(Nu, sl, ds)  # its part in the section plane
    Nl /= np.maximum(np.linalg.norm(Nl, axis=1), 1e-12)[:, None]
    h = ((_gsmooth(Pu, Q['sigmaSmallMm'] / 1000.0, ds) - _gsmooth(Pu, sl, ds)) * Nl).sum(axis=1)
    return su, Pu, Nl, h, N3


def _peak(prof, q, search, Q):
    """The highest interior maximum of the profile within `search` of the curve point nearest q, with
    its height over the higher of the two base troughs and the distances to them."""
    su, Pu, Nl, h, N3 = prof
    ds = Q['sampleMm'] / 1000.0
    edge = int(2.2 * Q['sigmaLargeMm'] / 1000.0 / ds)  # the low-pass is biased near the curve's ends
    i0 = int(np.argmin(np.linalg.norm(Pu - q, axis=1)))
    lo, hi = max(edge, i0 - int(search / ds)), min(len(h) - edge, i0 + int(search / ds))
    if hi - lo < 3:
        return None
    i = lo + int(np.argmax(h[lo:hi]))
    if i in (lo, hi - 1):
        return None
    w = int(3.5 * Q['sigmaLargeMm'] / 1000.0 / ds)
    a, b = max(0, i - w), min(len(h), i + w)
    il = a + int(np.argmin(h[a:i]))
    ir = i + int(np.argmin(h[i:b]))
    return {'p': Pu[i], 'n': Nl[i], 'n3': N3[i], 'h': float(h[i]), 'hb': float(h[i] - max(h[il], h[ir])),
            'w': float(max(i - il, ir - i) * ds), 'dq': float(np.linalg.norm(Pu[i0] - q))}


def _crest_at(mesh, X, N, p, t, Q, search):
    ch = _chain(mesh, X, N, p, t, Q['sectionRadiusMm'] / 1000.0)
    if ch is None:
        return None
    prof = _profile(ch[0], ch[1], t, Q)
    return None if prof is None else _peak(prof, p, search, Q)


def _trace(mesh, X, N, start, t, Q, stop=None):
    """Follow the crest from `start` in direction t; returns the crest points (not including start)."""
    pts, hist = [], [start['p'].copy()]
    cur, misses = start['p'].copy(), 0
    last_n = start['n']
    step = Q['stepMm'] / 1000.0
    for _ in range(Q['maxSteps']):
        q = cur + t * step
        if stop is not None and stop(q):
            break
        r = _crest_at(mesh, X, N, q, t, Q, Q['searchMm'] / 1000.0)
        # A crest point must lie on the surface the trace is following: the section passes within
        # offSurfaceMm of the prediction and the surface faces the same way (near the armpit a section
        # can otherwise land on the facing torso across the gap).
        ok = (r is not None and r['hb'] > Q['minCrestMm'] / 1000.0 and r['dq'] < Q['offSurfaceMm'] / 1000.0
              and float(r['n'] @ last_n) > 0.7)
        if ok:
            d = hu._unit(r['p'] - hist[max(0, len(hist) - Q['turnBaseline'])])
            ok = len(hist) < 3 or math.degrees(math.acos(float(np.clip(d @ t, -1, 1)))) < Q['maxTurnDeg']
        if not ok:
            misses += 1
            if misses > Q['maxMisses']:
                break
            cur = q
            continue
        misses = 0
        t = hu._unit((1 - Q['follow']) * t + Q['follow'] * d)
        t = hu._unit(t - r['n3'] * (t @ r['n3']))  # in the surface's tangent plane (3D normal: r['n'] is normal to t)
        cur = r['p'].copy()
        last_n = r['n']
        hist.append(cur)
        r['t'] = t.copy()
        pts.append(r)
    # The end, to a fraction of a step: from the last crest point, probe on in endRefineMm steps while
    # the bump still counts as seam (same tests, and the crest stays within offSurfaceMm of the line
    # straight on), so where a trace ends does not depend on where its steps happened to fall.
    if pts:
        cur, t, last_n = pts[-1]['p'].copy(), pts[-1]['t'].copy(), pts[-1]['n']
        fine = Q['endRefineMm'] / 1000.0
        for _ in range(int(round(Q['stepMm'] / Q['endRefineMm']))):
            q = cur + t * fine
            if stop is not None and stop(q):
                break
            r = _crest_at(mesh, X, N, q, t, Q, Q['searchMm'] / 1000.0)
            if not (r is not None and r['hb'] > Q['minCrestMm'] / 1000.0 and r['dq'] < Q['offSurfaceMm'] / 1000.0
                    and float(r['n'] @ last_n) > 0.7 and float((r['p'] - cur) @ t) > 0):
                break
            cur, last_n = r['p'].copy(), r['n']
            r['t'] = t.copy()
            pts.append(r)
    return pts


def _end_dir(P, back):
    """Direction in which the polyline P arrives at its last point, over its last `back` of length."""
    P = np.asarray(P)
    seg = np.linalg.norm(np.diff(P[::-1], axis=0), axis=1)
    k = int(np.searchsorted(np.cumsum(seg), back)) + 1
    return hu._unit(P[-1] - P[max(0, len(P) - 1 - k)])


def _bridge(mesh, X, kd, a, b):
    """Crest points along the shortest edge path on the surface from crest point a to crest point b
    (width and normal interpolated between the two ends; each carries its vertex id 'v')."""
    va, vb = kd.find(a['p'])[1], kd.find(b['p'])[1]
    c, R = 0.5 * (a['p'] + b['p']), 0.6 * float(np.linalg.norm(a['p'] - b['p'])) + 0.01
    allowed = np.zeros(mesh.n, bool)
    for _, i, _ in kd.find_range(c, R):
        allowed[i] = True
    allowed[[va, vb]] = True
    dist = np.full(mesh.n, math.inf)
    prev = -np.ones(mesh.n, np.int64)
    dist[va] = 0.0
    heap = [(0.0, va)]
    while heap:
        d, v = heapq.heappop(heap)
        if v == vb:
            break
        if d > dist[v]:
            continue
        for k in range(mesh.indptr[v], mesh.indptr[v + 1]):
            u = int(mesh.nbr[k])
            nd = d + float(np.linalg.norm(X[u] - X[v]))
            if allowed[u] and nd < dist[u]:
                dist[u], prev[u] = nd, v
                heapq.heappush(heap, (nd, u))
    if not np.isfinite(dist[vb]):
        return [dict(b)]
    path = [vb]
    while path[-1] != va:
        path.append(int(prev[path[-1]]))
    path = path[::-1]
    L = dist[vb]
    out = []
    for i, v in enumerate(path[1:-1], 1):
        f = dist[v] / max(L, 1e-12)
        t = hu._unit(X[path[min(i + 1, len(path) - 1)]] - X[path[i - 1]])
        out.append({'p': X[v].copy(), 'n': hu._unit((1 - f) * a['n'] + f * b['n']), 'h': (1 - f) * a['h'] + f * b['h'],
                    'hb': (1 - f) * a['hb'] + f * b['hb'], 'w': (1 - f) * a['w'] + f * b['w'], 't': t, 'v': v})
    return out + [dict(b)]


def _closed_profile(mesh, X, N, sec, n, Q, kd):
    Qc = np.vstack([sec['points'], sec['points'][:1]])
    Nq = np.array([N[kd.find(v)[1]] for v in Qc])
    return _profile(Qc, Nq, n, Q)


# ---------------------------------------------------------------- the band and the fill

def _resample(C, ds):
    seg = np.linalg.norm(np.diff(C, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    su = np.arange(0.0, s[-1] + 1e-9, ds)
    return np.stack([np.interp(su, s, C[:, j]) for j in range(3)], axis=1), s, su


def _band(mesh, X, Ns, kd_mesh, crests, free, Q):
    """The band around the crest lines: vertices whose GEODESIC distance from the crest (along the
    surface, from the vertices on the crest line) is under the crest's half-width + margin. Geodesic,
    so a band never jumps a narrow gap (the armpit) to the facing surface.
    Also returns, per vertex, the distance ALONG the crest to its nearest free end (`free[k]` = whether
    crest k's start / end is free, i.e. not joined to another crest): the projection of the vertex onto
    the crest's tangent at its nearest crest sample, so it is negative beyond the end."""
    ds = 0.0005
    S, Sn, Sw, St, Se = [], [], [], [], []
    for cr, (f0, f1) in zip(crests, free):
        C = np.array([r['p'] for r in cr])
        if len(C) < 2:
            continue
        R, s, su = _resample(C, ds)
        Se.append(np.stack([su, np.full(len(su), su[-1]), np.full(len(su), float(f0)), np.full(len(su), float(f1))], axis=1))
        Tg = np.gradient(R, axis=0) if len(R) > 1 else np.zeros_like(R)
        k = 6  # tangent over +-3 mm
        Tg = np.stack([np.convolve(np.pad(Tg[:, a], k, mode='edge'), np.ones(2 * k + 1), mode='valid') for a in range(3)], axis=1)
        St.append(Tg / np.maximum(np.linalg.norm(Tg, axis=1), 1e-12)[:, None])
        Wc = np.array([r['w'] for r in cr])
        k = max(1, len(Wc) // 20)
        Wc = np.convolve(np.pad(Wc, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid')  # smooth along the crest
        Nc = np.array([r['n'] for r in cr])
        S.append(R)
        Sw.append(np.interp(su, s, Wc))
        Sn.append(np.stack([np.interp(su, s, Nc[:, j]) for j in range(3)], axis=1))
    S, Sn, Sw, St, Se = np.vstack(S), np.vstack(Sn), np.concatenate(Sw), np.vstack(St), np.vstack(Se)
    Wf = np.clip(Sw * 1000 + Q['fullMarginMm'], Q['fullMinMm'], Q['fullMaxMm']) / 1000.0
    Wb = Wf + (Q['taperMm'] + Q['padMm']) / 1000.0
    log(f"seams: crest base half-width (mm) p10 {np.percentile(Sw, 10) * 1000:.1f} p50 {np.median(Sw) * 1000:.1f} p90 {np.percentile(Sw, 90) * 1000:.1f}")
    reach = float(Wb.max()) + 0.004
    cand = set()
    for p in S[::4]:
        for _, i, _ in kd_mesh.find_range(p, reach):
            cand.add(i)
    cand = np.array(sorted(cand))
    kd_s = kdtree.KDTree(len(S))
    for i, p in enumerate(S):
        kd_s.insert(p, i)
    kd_s.balance()
    near = [kd_s.find(X[v]) for v in cand]
    j = np.array([int(a[1]) for a in near])
    dist = np.array([float(a[2]) for a in near])
    same_side = (Ns[cand] * Sn[j]).sum(axis=1) > 0.5
    core = np.zeros(mesh.n, bool)
    core[cand[same_side & (dist < Q['coreMm'] / 1000.0)]] = True
    core[[r['v'] for cr in crests for r in cr if 'v' in r]] = True  # the junction path through the armpit
    allowed = np.zeros(mesh.n, bool)
    allowed[cand] = True
    r = mesh.dijkstra(np.nonzero(core)[0], allowed, dmax=reach)
    wb = np.zeros(mesh.n)
    wb[cand] = Wb[j]
    wf = np.zeros(mesh.n)
    wf[cand] = Wf[j]
    tv = np.zeros((mesh.n, 3))
    tv[cand] = St[j]
    u = Se[j, 0] + ((X[cand] - S[j]) * St[j]).sum(axis=1)  # arc position along the crest
    e_end = np.full(mesh.n, np.inf)
    e_end[cand] = np.minimum(np.where(Se[j, 2] > 0, u, np.inf), np.where(Se[j, 3] > 0, Se[j, 1] - u, np.inf))
    U = r < wb
    return U, r, wb, wf, tv, e_end


def _stiffness(mesh, X, tri, slow=None, ratio=1.0):
    """Directed edge weights (i, j, w_ij) of the P1 finite-element stiffness matrix of the triangles
    `tri` (w_ij = -K_ij, so the Laplacian is sum_j w_ij (v_j - v_i)). Isotropic, these are the cotangent
    weights. With `slow` (a per-vertex tangent direction), conduction along it is `ratio` times weaker
    than across it: D = P - (1 - 1/ratio) t t^T in each triangle's plane (P the projector onto it, t the
    triangle's mean slow direction projected into it), so values are carried ACROSS the slow direction."""
    T = mesh.T[tri]
    P0, P1, P2 = X[T[:, 0]], X[T[:, 1]], X[T[:, 2]]
    n = np.cross(P1 - P0, P2 - P0)
    A2 = np.maximum(np.linalg.norm(n, axis=1), 1e-18)
    n = n / A2[:, None]
    G = [np.cross(n, P2 - P1) / A2[:, None], np.cross(n, P0 - P2) / A2[:, None], np.cross(n, P1 - P0) / A2[:, None]]  # grad of the hat functions
    if slow is not None and ratio != 1.0:
        t = slow[T].sum(axis=1)
        t -= n * (t * n).sum(axis=1)[:, None]
        t /= np.maximum(np.linalg.norm(t, axis=1), 1e-12)[:, None]
        f = 1.0 - 1.0 / ratio
        DG = [g - f * t * (g * t).sum(axis=1)[:, None] for g in G]
    else:
        DG = G
    area = 0.5 * A2
    I, J, W = [], [], []
    for a in range(3):
        for b in range(3):
            if a != b:
                I.append(T[:, a]); J.append(T[:, b]); W.append(-area * (G[a] * DG[b]).sum(axis=1))
    return np.concatenate(I), np.concatenate(J), np.concatenate(W)


def _cotan(mesh, X, tri, clamp):
    """Directed cotangent edge weights (i, j, w_ij) of the triangles `tri` and barycentric vertex areas."""
    T = mesh.T[tri]
    P0, P1, P2 = X[T[:, 0]], X[T[:, 1]], X[T[:, 2]]

    def cot(a, b, c):
        u, v = b - a, c - a
        return (u * v).sum(axis=1) / np.maximum(np.linalg.norm(np.cross(u, v), axis=1), 1e-14)

    c = np.clip(np.stack([cot(P0, P1, P2), cot(P1, P2, P0), cot(P2, P0, P1)], axis=1), clamp[0], clamp[1]) * 0.5
    I = np.concatenate([T[:, 1], T[:, 2], T[:, 2], T[:, 0], T[:, 0], T[:, 1]])
    J = np.concatenate([T[:, 2], T[:, 1], T[:, 0], T[:, 2], T[:, 1], T[:, 0]])
    W = np.concatenate([c[:, 0], c[:, 0], c[:, 1], c[:, 1], c[:, 2], c[:, 2]])
    area = 0.5 * np.linalg.norm(np.cross(P1 - P0, P2 - P0), axis=1)
    A = np.zeros(mesh.n)
    for k in range(3):
        np.add.at(A, T[:, k], area / 3)
    return I, J, W, A


def _focal_kmin(mesh, X, Nn, ids):
    """Smallest principal curvature of the normal FIELD Nn at the vertices ids (least-squares shape
    operator over the 1-ring in the tangent plane, symmetrised). An offset X + s Nn folds where
    1 + s kmin <= 0, so outward moves (s > 0) must stay below 1 / -kmin where kmin < 0 (a hollow)."""
    out = np.zeros(len(ids))
    ref = np.array([1.0, 0.0, 0.0])
    for k, i in enumerate(ids.tolist()):
        nb = mesh.nbr[mesh.indptr[i]:mesh.indptr[i + 1]]
        n = Nn[i]
        e1 = np.cross(n, ref if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0]))
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(n, e1)
        B = np.stack([e1, e2], axis=1)
        dx = (X[nb] - X[i]) @ B
        dn = (Nn[nb] - n) @ B
        S, *_ = np.linalg.lstsq(dx, dn, rcond=None)
        S = 0.5 * (S + S.T)
        out[k] = float(np.linalg.eigvalsh(S)[0])
    return out


def _cg_fill(mesh, X, Uu, rowm, I, J, W, A, Nn, Q, x0, Hb=None, dw=None, s0=None):
    """min sum_r A_r (n_r . Lap Y - Hb_r)^2 + sum_u dw_u (s_u - s0_u)^2 over Y = X + s Nn, s free on Uu
    (zero elsewhere), Hb the target curvature (zero if None), dw / s0 an optional data term (see _fair):
    Jacobi-preconditioned conjugate gradients on the normal equations. Returns s on Uu, iterations,
    residual."""
    uid = np.nonzero(Uu)[0]
    rows = np.nonzero(rowm)[0]
    ridx = -np.ones(mesh.n, np.int64)
    ridx[rows] = np.arange(len(rows))
    uidx = -np.ones(mesh.n, np.int64)
    uidx[uid] = np.arange(len(uid))
    nr, nu = len(rows), len(uid)
    sa = 1.0 / np.sqrt(np.maximum(A[I], 1e-14))
    c = np.bincount(ridx[I], weights=W * sa * ((X[J] - X[I]) * Nn[I]).sum(axis=1), minlength=nr)  # n_r . Lap X
    if Hb is not None:
        c -= np.sqrt(np.maximum(A[rows], 1e-14)) * Hb[rows]
    oj = uidx[J] >= 0
    oi = uidx[I] >= 0
    ri = np.concatenate([ridx[I[oj]], ridx[I[oi]]])
    ci = np.concatenate([uidx[J[oj]], uidx[I[oi]]])
    vals = np.concatenate([(W * sa)[oj] * (Nn[I[oj]] * Nn[J[oj]]).sum(axis=1), -(W * sa)[oi]])  # + w_ij (n_i.n_j) s_j - w_ij s_i

    def Am(v):
        return np.bincount(ri, weights=vals * v[ci], minlength=nr)

    def At(v):
        return np.bincount(ci, weights=vals * v[ri], minlength=nu)

    key = ri * nu + ci  # Jacobi preconditioner: column norms of the merged matrix
    uk, inv = np.unique(key, return_inverse=True)
    mv = np.bincount(inv, weights=vals)
    Dg = np.maximum(np.bincount(uk % nu, weights=mv * mv, minlength=nu), 1e-30)
    du = np.zeros(nu) if dw is None else dw[uid]
    Dg = Dg + du
    x = x0[uid].copy()
    b = -At(c)
    if dw is not None:
        b = b + du * s0[uid]
    r = b - At(Am(x)) - du * x
    z = r / Dg
    p = z.copy()
    rz = r @ z
    r0 = max(float(np.sqrt(b @ b)), 1e-30)
    it = 0
    for it in range(Q['cgIterations']):
        if np.sqrt(r @ r) / r0 < Q['cgTol']:
            break
        Ap = At(Am(p)) + du * p
        alpha = rz / max(float(p @ Ap), 1e-300)
        x += alpha * p
        r -= alpha * Ap
        z = r / Dg
        rz_new = r @ z
        p = z + (rz_new / rz) * p
        rz = rz_new
    s = np.zeros(mesh.n)
    s[uid] = x
    return s, it + 1, float(np.sqrt(r @ r) / r0)


def _harmonic(mesh, U, vals, I, J, W, Q, known=None):
    """Harmonic interpolation into U of the per-vertex values `vals` (fixed outside U) with the
    non-negative directed edge weights (I, J, W): the Laplace equation, solved by Jacobi-preconditioned
    CG. With `known`, only those vertices outside U carry data; edges from U to any other vertex are
    dropped (a natural boundary there). Returns the values on U (in vertex order) and the iterations."""
    keep = U[I] if known is None else U[I] & (U[J] | known[J])
    I, J, W = I[keep], J[keep], W[keep]
    uid = np.nonzero(U)[0]
    idx = -np.ones(mesh.n, np.int64)
    idx[uid] = np.arange(len(uid))
    nu = len(uid)
    fx = idx[J] < 0
    diag = np.maximum(np.bincount(idx[I], weights=W, minlength=nu), 1e-30)
    b = np.bincount(idx[I[fx]], weights=W[fx] * vals[J[fx]], minlength=nu)
    fi, fj, fw = idx[I[~fx]], idx[J[~fx]], W[~fx]

    def Hm(v):
        return diag * v - np.bincount(fi, weights=fw * v[fj], minlength=nu)

    x = b / diag
    r = b - Hm(x)
    z = r / diag
    p = z.copy()
    rz = r @ z
    r0 = max(float(np.sqrt(b @ b)), 1e-30)
    it = 0
    for it in range(Q['cgIterations']):
        if np.sqrt(r @ r) / r0 < Q['cgTol']:
            break
        Ap = Hm(p)
        alpha = rz / max(float(p @ Ap), 1e-300)
        x += alpha * p
        r -= alpha * Ap
        z = r / diag
        rz_new = r @ z
        p = z + (rz_new / rz) * p
        rz = rz_new
    return x, it + 1


def _mean_curvature(mesh, X, R, Nn, Q, slow=None, ratio=1.0):
    """n . Lap X / area (cotangent Laplace-Beltrami along the normal field Nn) at the vertices R
    (zero elsewhere); 1/m, positive where the surface is concave (a hollow). With `slow`, the
    anisotropic operator of _stiffness instead (curvature mostly along the other direction)."""
    tri = R[mesh.T].any(axis=1)
    I, J, W, A = _cotan(mesh, X, tri, Q['cotClamp'])
    if slow is not None:
        I, J, W = _stiffness(mesh, X, tri, slow, ratio)
    keep = R[I]
    H = np.bincount(I[keep], weights=W[keep] * ((X[J[keep]] - X[I[keep]]) * Nn[I[keep]]).sum(axis=1), minlength=mesh.n)
    return H / np.maximum(A, 1e-14), A


def _carried_curvature(mesh, X, U, Nn, Q, exclude=None, tag='band', slow=None, ratio=1.0, sigma=None, core=None, Xdata=None, measure=False):
    """The mean curvature the fill should have: the surface's own curvature (see _mean_curvature)
    around the region U, carried into U by harmonic interpolation (Laplace equation, non-negative
    cotangent weights, so it never overshoots what surrounds it).
    A thin plate that aims at zero curvature bridges every hollow it spans; this one keeps the curvature
    the region's surroundings have: the limb's roundness, the armpit hollow where the seams meet, and the
    wrinkles that cross the band fade across it instead of being cut off.
    The data are the vertices within curvSmoothRings + 2 rings of U whose own 1-ring lies outside U (so
    nothing of what is being replaced enters), low-passed over a fixed LENGTH, curvSigmaMm (a Gaussian
    over the data vertices, area-weighted; the armpit is meshed three times finer than the upper arm,
    so a number of rings would be no fixed scale). Vertices in `exclude` (the armpit slit's walls and
    edges: a narrow gap's walls curve far tighter than any cloth, and that is no curvature to carry onto
    the seam) are no data: they are interpolated like U, with a natural boundary where they meet
    nothing known.
    With `core` (a part of U: what the seam itself covers), only the core is carried over; the rest of U
    keeps its own curvature (measured on Xdata, the surface before any re-spacing), so the fill
    reproduces the surface there instead of bridging it."""
    k = Q['curvSmoothRings']
    R = mesh.grow(U, k + 2)
    H, A = _mean_curvature(mesh, X if Xdata is None else Xdata, R, Nn, Q, *((slow, ratio) if measure else (None, 1.0)))
    data = R & ~mesh.grow(U if core is None else core, 1)
    if exclude is not None:
        data &= ~exclude
    ids = np.nonzero(data)[0]
    sig = (Q['curvSigmaMm'] if sigma is None else sigma) / 1000.0
    Hs = H.copy()
    if sig > 0 and len(ids):
        kd = _kdtree(X[ids])
        for k_, i in enumerate(ids.tolist()):
            nb = np.array([j for _, j, _ in kd.find_range(X[i], 3 * sig)])
            g = np.exp(-0.5 * (np.linalg.norm(X[ids[nb]] - X[i], axis=1) / sig) ** 2) * A[ids[nb]]
            Hs[i] = float((g * H[ids[nb]]).sum() / max(g.sum(), 1e-30))
    unknown = R & ~data  # U, its first ring and the excluded vertices
    tri = mesh.grow(unknown, 1)[mesh.T].any(axis=1)
    if slow is None:
        I, J, W, _ = _cotan(mesh, X, tri, [0.0, Q['cotClamp'][1]])
    else:  # carried across the `slow` direction (see _stiffness)
        I, J, W = _stiffness(mesh, X, tri, slow, ratio)
    x, it = _harmonic(mesh, unknown, Hs, I, J, W, Q, known=data)
    Hb = Hs.copy()
    Hb[np.nonzero(unknown)[0]] = x
    Hb[~R] = 0.0
    log(f'seams: carried curvature ({tag}): {it} cg iterations; inside p5/p50/p95 {np.percentile(Hb[U], 5):.1f} / {np.median(Hb[U]):.1f} / {np.percentile(Hb[U], 95):.1f} 1/m,'
        f' data around it raw {np.percentile(H[data], 5):.1f} / {np.median(H[data]):.1f} / {np.percentile(H[data], 95):.1f}'
        f' -> low-passed {np.percentile(Hs[data], 5):.1f} / {np.median(Hs[data]):.1f} / {np.percentile(Hs[data], 95):.1f}'
        + (f', {int((R & exclude & ~U).sum())} slit vertices no data' if exclude is not None else ''))
    return Hb


def _fair(mesh, X, U, Nn, Q, Hb=None, base=None, slow=None, ratio=1.0):
    """Thin-plate fill of the band U by a scalar displacement s along the (ridge-free) normal Nn:
    Y = X + s Nn minimises sum_r A_r (n_r . Lap Y)_r^2 (cotangent Laplace-Beltrami, i.e. the squared
    mean curvature) over every vertex touching U, all vertices outside U fixed. The fill meets the
    surrounding surface in position and slope, the limb's own curvature carries across, and no vertex
    slides along the surface.
    The operator belongs to the FILLED surface, not to the ridge (whose steep flanks have very
    different cotangents), so it is rebuilt on the current fill and re-solved `reweight` times.
    The fill may not build the surface up beyond a fraction (focalFrac) of the focal distance of the
    normal field, 1 / -kmin: in a hollow the normals converge and an outward offset that reaches the
    focal distance folds the surface (that is where the arm and side seams meet in the armpit). On the
    limbs the bound is far away and only maxOutMm caps it. The bound is an obstacle constraint, solved
    by an active set: vertices that would rise higher are held at their bound, the rest re-solved.
    With Hb, the fill's mean curvature is matched to Hb instead of zero (see _carried_curvature)."""
    rowm = mesh.grow(U, 1)
    tri = rowm[mesh.T].any(axis=1)
    uid = np.nonzero(U)[0]
    km = _focal_kmin(mesh, X, Nn, uid)
    smax = np.full(mesh.n, np.inf)
    smax[uid] = Q['focalFrac'] / np.maximum(-km, 1e-9)
    E = mesh.E[rowm[mesh.E[:, 0]] | rowm[mesh.E[:, 1]]]
    for _ in range(2):  # conservative: the smallest bound over the 2-ring
        np.minimum.at(smax, E[:, 0], smax[E[:, 1]])
        np.minimum.at(smax, E[:, 1], smax[E[:, 0]])
    # No build-up: the fill rises at most maxOutMm above the SOURCE surface (`base`, measured along Nn).
    cap = Q['maxOutMm'] / 1000.0 - (((X - base) * Nn).sum(axis=1) if base is not None else 0.0)
    smax = np.minimum(smax, cap)
    F = np.zeros(mesh.n, bool)
    s = np.zeros(mesh.n)
    Y = X.copy()
    hist = []
    # The cloth under the seam (see the module doc, fill): where the fill would pass ABOVE the source
    # (s > s0, the source height along Nn), the source is cloth (a trough, a crease, a hollow) and pulls
    # the fill toward it with weight fitMm^-4 (relative to the thin plate: what is narrower than fitMm is
    # smoothed over, what is wider is followed); where the source stands proud of the fill it is the seam
    # itself and pulls with fitEps of that. Iteratively reweighted (a one-sided, asymmetric fit).
    fit = Q['fitMm'] is not None and Q['fitMm'] > 0
    s0 = -(((X - base) * Nn).sum(axis=1)) if base is not None else np.zeros(mesh.n)
    mu = (1000.0 / Q['fitMm']) ** 4 if fit else 0.0
    om = np.full(mesh.n, Q['fitEps'])
    nflip = 0
    for _ in range(max(1, Q['reweight'])):
        I, J, W, A = _cotan(mesh, Y, tri, Q['cotClamp'])
        if slow is not None:  # anisotropic thin plate (see _stiffness)
            I, J, W = _stiffness(mesh, Y, tri, slow, ratio)
        keep = rowm[I]
        I, J, W = I[keep], J[keep], W[keep]
        for _ in range(1 + (Q['fitRounds'] if fit else 0)):
            if fit:
                F = np.zeros(mesh.n, bool)  # the bound's active set is rebuilt for every weighting
            for _ in range(Q['activeSetRounds'] + 1):
                Uu = U & ~F
                Xb = X + np.where(F, smax, 0.0)[:, None] * Nn
                dw = mu * A * om if fit else None
                su, its, res = _cg_fill(mesh, Xb, Uu, rowm, I, J, W, A, Nn, Q, s, Hb, dw, s0)
                s = np.where(F, smax, su)
                viol = Uu & (s > smax + 1e-5)
                if not viol.any():
                    break
                F |= viol
            if not fit:
                break
            om_new = np.where(s > s0 + 1e-6, 1.0, Q['fitEps'])
            flip = U & (om_new != om)
            nflip = int(flip.sum())
            om = om_new
            if nflip == 0:
                break
        Y_new = X + s[:, None] * Nn
        hist.append((its, res, float(np.abs(Y_new - Y).max()), int(F.sum())))
        Y = Y_new
    log('seams: fill passes (cg iterations, residual, max change, held at the outward bound) ' +
        ', '.join(f'({a}, {b:.1e}, {c * 1000:.2f} mm, {d})' for a, b, c, d in hist) +
        (f'; one-sided fit to the cloth over {Q["fitMm"]:.1f} mm: {int((U & (om == 1.0)).sum())} vertices pull, last round flipped {nflip}' if fit else ''))
    return Y, s, hist[-1][0], hist[-1][1], hist[-1][3]


def _respace(mesh, X, U, Nn, tv, Q):
    """Tangential re-spacing of the band: the ridge's flank vertices are crowded (and, where the
    piping is undercut, in reversed order) over the base surface, so a pure normal fill would fold
    the triangles there. Each band vertex gets a displacement in its tangent plane (normal Nn) that
    minimises the tangential Dirichlet energy sum_edges |P_e (X'_i - X'_j)|^2 (P_e drops the edge's
    component along the edge normal, so the ridge's height plays no part), boundary fixed: a harmonic
    (Tutte-like) map of the band onto its base, which orders the vertices and spaces them evenly.
    Motion ALONG the seam (crest tangent tv) is penalised (respaceAlong), so vertices spread across the
    seam, where the crowding is, instead of sliding along the limb, and a small uniform screening term
    (respaceReg) keeps the motion local to where the crowding is.
    The shape is set afterwards by the fill; this only moves vertices within the surface."""
    uid = np.nonzero(U)[0]
    nu = len(uid)
    uidx = -np.ones(mesh.n, np.int64)
    uidx[uid] = np.arange(nu)
    E = mesh.E[U[mesh.E[:, 0]] | U[mesh.E[:, 1]]]
    i, j = E[:, 0], E[:, 1]
    ref = np.where(np.abs(Nn[:, 0:1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    B1 = np.cross(Nn, ref)
    B1 /= np.maximum(np.linalg.norm(B1, axis=1), 1e-12)[:, None]
    B2 = np.cross(Nn, B1)
    ne = Nn[i] + Nn[j]
    ne /= np.maximum(np.linalg.norm(ne, axis=1), 1e-12)[:, None]

    def proj(V):
        return V - ne * (V * ne).sum(axis=1)[:, None]

    c = proj(X[i] - X[j])
    Mi = np.stack([proj(B1[i]), proj(B2[i])], axis=2)  # (ne, 3, 2)
    Mj = np.stack([proj(B1[j]), proj(B2[j])], axis=2)
    ui, uj = uidx[i], uidx[j]
    oi, oj = ui >= 0, uj >= 0
    lam = Q['respaceReg']
    la = Q['respaceAlong']
    tau = np.stack([(tv[uid] * B1[uid]).sum(axis=1), (tv[uid] * B2[uid]).sum(axis=1)], axis=1)  # crest tangent in (B1, B2)

    def Am(d):  # edge residual part from d (nu, 2) -> (ne, 3)
        out = np.zeros((len(E), 3))
        out[oi] += np.einsum('ekl,el->ek', Mi[oi], d[ui[oi]])
        out[oj] -= np.einsum('ekl,el->ek', Mj[oj], d[uj[oj]])
        return out

    def At(r):
        g = np.zeros((nu, 2))
        np.add.at(g, ui[oi], np.einsum('ekl,ek->el', Mi[oi], r[oi]))
        np.add.at(g, uj[oj], -np.einsum('ekl,ek->el', Mj[oj], r[oj]))
        return g

    def H(d):
        return At(Am(d)) + lam * d + la * tau * (tau * d).sum(axis=1)[:, None]

    Dg = np.zeros((nu, 2))
    np.add.at(Dg, ui[oi], (Mi[oi] ** 2).sum(axis=1))
    np.add.at(Dg, uj[oj], (Mj[oj] ** 2).sum(axis=1))
    Dg = np.maximum(Dg + lam + la * tau ** 2, 1e-30)
    d = np.zeros((nu, 2))
    b = -At(c)
    r = b - H(d)
    z = r / Dg
    p = z.copy()
    rz = (r * z).sum()
    r0 = max(float(np.sqrt((b * b).sum())), 1e-30)
    it = 0
    for it in range(Q['cgIterations']):
        if np.sqrt((r * r).sum()) / r0 < Q['cgTol']:
            break
        Hp = H(p)
        alpha = rz / max(float((p * Hp).sum()), 1e-300)
        d += alpha * p
        r -= alpha * Hp
        z = r / Dg
        rz_new = (r * z).sum()
        p = z + (rz_new / rz) * p
        rz = rz_new
    Xr = X.copy()
    Xr[uid] += B1[uid] * d[:, :1] + B2[uid] * d[:, 1:]
    mv = np.linalg.norm(Xr - X, axis=1)
    log(f'seams: tangential re-spacing {it + 1} cg iterations, moved up to {mv.max() * 1000:.2f} mm (median {np.median(mv[uid]) * 1000:.2f} mm)')
    return Xr


def _facing(mesh, X, Nn, tris):
    """Cosine between each triangle's normal and the ridge-free normal there (< 0: the triangle lies
    reversed over the base surface, i.e. a normal fill would fold it)."""
    a, b, c = X[mesh.T[tris, 0]], X[mesh.T[tris, 1]], X[mesh.T[tris, 2]]
    fn = np.cross(b - a, c - a)
    fn /= np.maximum(np.linalg.norm(fn, axis=1), 1e-15)[:, None]
    nm = Nn[mesh.T[tris]].sum(axis=1)
    nm /= np.maximum(np.linalg.norm(nm, axis=1), 1e-15)[:, None]
    return (fn * nm).sum(axis=1)


def _untangle(mesh, X, Ur, Nn, Q):
    """Where triangles still lie reversed (or nearly edge-on) over the base after the re-spacing,
    relax only their vertices (+ two rings, inside Ur) tangentially toward their neighbours' mean
    (umbrella step with the normal component removed) until every triangle faces the right way."""
    tris = np.nonzero(Ur[mesh.T].any(axis=1))[0]
    E = mesh.E[Ur[mesh.E[:, 0]] | Ur[mesh.E[:, 1]]]  # every edge a relaxed vertex can have
    a, b = E[:, 0], E[:, 1]
    deg = np.maximum(mesh.deg, 1)[:, None]
    X = X.copy()
    rounds = 0
    for rounds in range(Q['untangleRounds']):
        f = _facing(mesh, X, Nn, tris)
        bad = tris[f < Q['minFacing']]
        if len(bad) == 0:
            break
        m = np.zeros(mesh.n, bool)
        m[mesh.T[bad].ravel()] = True
        for _ in range(2):
            g = m.copy()
            g[b[m[a]]] = True
            g[a[m[b]]] = True
            m = g
        m &= Ur
        if not m.any():
            break
        S = np.zeros_like(X)
        np.add.at(S, a, X[b])
        np.add.at(S, b, X[a])
        ids = np.nonzero(m)[0]
        d = S[ids] / deg[ids] - X[ids]
        d -= Nn[ids] * (d * Nn[ids]).sum(axis=1)[:, None]
        X[ids] += 0.5 * d
    f = _facing(mesh, X, Nn, tris)
    log(f'seams: untangle {rounds} rounds, triangles facing below {Q["minFacing"]}: {int((f < Q["minFacing"]).sum())}, reversed {int((f < 0).sum())}')
    return X


def _smooth_normals(mesh, X, N, region, Q):
    """Ridge-free normals: the vertex normals low-passed by heat diffusion over the region for a time
    t = sigma^2 / 2 (a Gaussian of normalSigmaMm, whatever the local triangle size: the armpit is
    meshed three times finer than the upper arm), in normalSteps implicit steps
    (M + dt K) N' = M N (lumped mass M, cotangent stiffness K, vertices outside the region fixed);
    several steps, because one implicit step has a sharp (log-singular) kernel that keeps the
    ridge's own normals."""
    sig = Q['normalSigmaMm'] / 1000.0
    t = 0.5 * sig * sig / Q['normalSteps']
    tri = region[mesh.T].any(axis=1)
    I, J, W, A = _cotan(mesh, X, tri, [0.0, Q['cotClamp'][1]])
    keep = region[I]
    I, J, W = I[keep], J[keep], W[keep]
    ids = np.nonzero(region)[0]
    idx = -np.ones(mesh.n, np.int64)
    idx[ids] = np.arange(len(ids))
    nu = len(ids)
    fixed = idx[J] < 0
    Ai = A[ids]
    diag = Ai + t * np.bincount(idx[I], weights=W, minlength=nu)
    bfix = t * np.stack([np.bincount(idx[I[fixed]], weights=W[fixed] * N[J[fixed], k], minlength=nu) for k in range(3)], axis=1)
    fi, fj, fw = idx[I[~fixed]], idx[J[~fixed]], W[~fixed]

    def H(v):
        return diag[:, None] * v - t * np.stack([np.bincount(fi, weights=fw * v[fj, k], minlength=nu) for k in range(3)], axis=1)

    x = N[ids].copy()
    for _ in range(Q['normalSteps']):
        b = Ai[:, None] * x + bfix
        r = b - H(x)
        z = r / diag[:, None]
        p = z.copy()
        rz = (r * z).sum(axis=0)
        r0 = np.maximum(np.sqrt((b * b).sum(axis=0)), 1e-30)
        for _ in range(Q['cgIterations']):
            if (np.sqrt((r * r).sum(axis=0)) / r0).max() < 1e-8:
                break
            Hp = H(p)
            alpha = rz / np.maximum((p * Hp).sum(axis=0), 1e-300)
            x += p * alpha
            r -= Hp * alpha
            z = r / diag[:, None]
            rz_new = (r * z).sum(axis=0)
            p = z + p * (rz_new / rz)
            rz = rz_new
    Ns = N.copy()
    Ns[ids] = x
    return Ns / np.maximum(np.linalg.norm(Ns, axis=1), 1e-12)[:, None]


def _fill3d(mesh, Y, D, Q):
    """3D thin plate over the patch D with the uniform Laplacian (the umbrella: every neighbour weighs
    the same): the positions of D's vertices (all three coordinates) minimise sum_r |Lap Y|_r^2 over
    every vertex touching D, all vertices outside D fixed (so the patch meets the surroundings in
    position and slope). Its minimiser also spaces the vertices evenly over the patch, so a crumpled,
    crowded or folded input cannot survive into the result (a Tutte-like re-spacing).
    Jacobi-preconditioned CG on the normal equations, three right-hand sides at once."""
    rowm = mesh.grow(D, 1)
    E = mesh.E[rowm[mesh.E[:, 0]] | rowm[mesh.E[:, 1]]]
    I, J = np.concatenate([E[:, 0], E[:, 1]]), np.concatenate([E[:, 1], E[:, 0]])
    keep = rowm[I]
    I, J = I[keep], J[keep]
    W = 1.0 / np.maximum(mesh.deg[I], 1)
    rows = np.nonzero(rowm)[0]
    ridx = -np.ones(mesh.n, np.int64)
    ridx[rows] = np.arange(len(rows))
    uid = np.nonzero(D)[0]
    uidx = -np.ones(mesh.n, np.int64)
    uidx[uid] = np.arange(len(uid))
    nr, nu = len(rows), len(uid)
    c = np.stack([np.bincount(ridx[I], weights=W * (Y[J, k] - Y[I, k]), minlength=nr) for k in range(3)], axis=1)
    oj, oi = uidx[J] >= 0, uidx[I] >= 0
    ri = np.concatenate([ridx[I[oj]], ridx[I[oi]]])
    ci = np.concatenate([uidx[J[oj]], uidx[I[oi]]])
    vals = np.concatenate([W[oj], -W[oi]])

    def Am(v):
        return np.stack([np.bincount(ri, weights=vals * v[ci, k], minlength=nr) for k in range(3)], axis=1)

    def At(v):
        return np.stack([np.bincount(ci, weights=vals * v[ri, k], minlength=nu) for k in range(3)], axis=1)

    key = ri * nu + ci
    uk, inv = np.unique(key, return_inverse=True)
    mv = np.bincount(inv, weights=vals)
    Dg = np.maximum(np.bincount(uk % nu, weights=mv * mv, minlength=nu), 1e-30)[:, None]
    x = np.zeros((nu, 3))
    b = -At(c)
    r = b.copy()
    z = r / Dg
    p = z.copy()
    rz = (r * z).sum(axis=0)
    r0 = np.maximum(np.sqrt((b * b).sum(axis=0)), 1e-30)
    it = 0
    for it in range(Q['cgIterations']):
        if (np.sqrt((r * r).sum(axis=0)) / r0).max() < Q['cgTol']:
            break
        Ap = At(Am(p))
        alpha = rz / np.maximum((p * Ap).sum(axis=0), 1e-300)
        x += p * alpha
        r -= Ap * alpha
        z = r / Dg
        rz_new = (r * z).sum(axis=0)
        p = z + p * (rz_new / rz)
        rz = rz_new
    Yn = Y.copy()
    Yn[uid] += x
    return Yn, it + 1, float((np.sqrt((r * r).sum(axis=0)) / r0).max())


def _dihedrals(mesh, X, tris):
    """Dihedral angles (deg) of the edges shared by two of the triangles `tris` (bool per triangle)."""
    T = mesh.T
    ids = np.nonzero(tris)[0]
    fn = np.cross(X[T[ids, 1]] - X[T[ids, 0]], X[T[ids, 2]] - X[T[ids, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1), 1e-15)[:, None]
    Ek = np.sort(np.concatenate([T[ids][:, [0, 1]], T[ids][:, [1, 2]], T[ids][:, [2, 0]]]), axis=1)
    F = np.tile(np.arange(len(ids)), 3)
    key = Ek[:, 0] * mesh.n + Ek[:, 1]
    o = np.argsort(key, kind='stable')
    key, F = key[o], F[o]
    same = np.nonzero(key[1:] == key[:-1])[0]
    return np.degrees(np.arccos(np.clip((fn[F[same]] * fn[F[same + 1]]).sum(axis=1), -1, 1)))


def _slit_walls(mesh, X, R, N, dist):
    """The vertices of R that face another part of the surface across a narrow gap: a ray from the
    vertex along its normal hits the surface within `dist` (the walls of the armpit slit, where the arm
    and the torso nearly touch)."""
    near = mesh.grow(R, 20)
    tri = np.nonzero(near[mesh.T].all(axis=1))[0]
    used, inv = np.unique(mesh.T[tri].ravel(), return_inverse=True)
    bvh = BVHTree.FromPolygons(X[used].tolist(), inv.reshape(-1, 3).tolist())
    out = np.zeros(mesh.n, bool)
    for i in np.nonzero(R)[0].tolist():
        loc = bvh.ray_cast((X[i] + N[i] * 1e-5).tolist(), N[i].tolist(), dist)[0]
        out[i] = loc is not None
    return out


def _junction(mesh, X, Y, junctions, Q, fixed=None, excl=None):
    """The armpit junction as a 2D patch. Where the arm and side seams meet, the piping turns round
    the top of the armpit slit, inside the hollow where the arm meets the torso: the two line bands
    overlap there at a sharp turn and their fills, each along its own ridge-free normal and held below
    the hollow's focal bound, leave a crumpled lip. So the junction is refilled as a whole, over the
    line fill: the geodesic disc of apexRadiusMm around the V's vertex (where the two crests, continued
    straight on from their traced ends, come closest; the piping's turn and the crumple lie inside it),
    every coordinate free, all vertices outside fixed as the line bands left them (two rings: position
    and slope) and so are the armpit slit's walls (`fixed`: a patch spanning the slit would pull its
    walls together and can fold), by
      1. a 3D thin plate with the uniform Laplacian (every neighbour weighs the same): its minimiser
         spaces the disc's vertices evenly, so no crowded, crumpled or folded triangle survives, and
         spans the fixed rings smoothly (tangential re-spacing and a first fill in one);
      2. apexCotanPasses x the cotangent thin plate along that surface's normals (the true bending
         energy; the spacing from step 1 is kept, and the outward bound applies as for the bands).
    Returns the new positions, the disc mask and per-junction statistics (dihedral angles of the disc
    in the source, after the line fill and after the patch)."""
    Dall = np.zeros(mesh.n, bool)
    stats = []
    rad = Q['apexRadiusMm'] / 1000.0
    for jn in junctions:
        g = mesh.dijkstra(jn['vvertex'], dmax=rad + 0.002)
        D = g < rad
        if fixed is not None:
            D &= ~(fixed & (g >= Q['apexFreeWallMm'] / 1000.0))
            if Q['apexRestoreWalls']:  # the slit's walls inside the disc are the source's, untouched by the line fill
                Y = np.where((fixed & (g < rad))[:, None], X, Y)
        tris = mesh.grow(D, 1)[mesh.T].all(axis=1)
        dh0 = _dihedrals(mesh, Y, tris)
        Yu, its, res = _fill3d(mesh, Y, D, Q)
        Yc = Yu
        jheld = 0
        for _ in range(Q['apexCotanPasses']):
            Nj = mesh.normals(Yc)
            slow = None
            ratio = max(Q['apexAlong'], Q['apexAniso'])
            if ratio > 1 and 'axis' in jn:  # along the armpit crease, not across it
                slow = np.cross(Nj, jn['axis'])
                slow /= np.maximum(np.linalg.norm(slow, axis=1), 1e-12)[:, None]
            aniso = slow is not None and Q['apexAniso'] > 1
            Hj = _carried_curvature(mesh, Yc, D, Nj, Q, excl, tag=f"junction {jn['side']}", slow=slow, ratio=ratio,
                                    sigma=Q['apexCurvSigmaMm'], measure=aniso) if Q['apexCarry'] else None
            Yc, _, _, _, jheld = _fair(mesh, Yc, D, Nj, Q, Hj, base=X, slow=slow if aniso else None, ratio=ratio)
        nfollow = 0
        if fixed is not None and Q['apexWallFollow']:
            # The slit's walls inside the disc hang from the surface the patch has just moved: they follow
            # it, by the patch's displacement carried into them harmonically (zero where the walls leave
            # the disc), so the slit's top end goes down with the surface round it instead of standing proud.
            Wd = fixed & (g < rad) & ~D
            if Wd.any():
                dlt = np.where(D[:, None], Yc - Y, 0.0)
                tri_w = mesh.grow(Wd, 1)[mesh.T].any(axis=1)
                Iw, Jw, Ww, _ = _cotan(mesh, Y, tri_w, [0.0, Q['cotClamp'][1]])
                wid = np.nonzero(Wd)[0]
                for k in range(3):
                    xk, _ = _harmonic(mesh, Wd, dlt[:, k], Iw, Jw, Ww, Q)
                    Yc[wid, k] = Y[wid, k] + xk
                D = D | Wd
                nfollow = int(Wd.sum())
                tris = mesh.grow(D, 1)[mesh.T].all(axis=1)
                dh0 = _dihedrals(mesh, Y, tris)
        dh1 = _dihedrals(mesh, Yc, tris)
        dhs = _dihedrals(mesh, X, tris)
        mv = np.linalg.norm(Yc - Y, axis=1)[D]
        mx = np.linalg.norm(Yc - X, axis=1)[D]
        st = {'side': jn['side'], 'vertex': np.round(jn['vp'], 5).tolist(), 'junctionMid': np.round(jn['p'], 5).tolist(),
              'radiusMm': rad * 1000, 'vertices': int(D.sum()), 'uniformCg': [its, res], 'heldAtBound': int(jheld), 'wallsFollowing': nfollow,
              'maxMoveFromBandsMm': float(mv.max() * 1000), 'maxMoveFromSourceMm': float(mx.max() * 1000),
              'dihedralOver40': [int((dhs > 40).sum()), int((dh0 > 40).sum()), int((dh1 > 40).sum())],
              'dihedralOver60': [int((dhs > 60).sum()), int((dh0 > 60).sum()), int((dh1 > 60).sum())],
              'dihedralOver90': [int((dhs > 90).sum()), int((dh0 > 90).sum()), int((dh1 > 90).sum())],
              'dihedralMax': [float(dhs.max()), float(dh0.max()), float(dh1.max())]}
        log(f"seams {jn['side']}: junction disc {rad * 1000:.1f} mm, {int(D.sum())} verts, uniform thin plate {its} cg its (res {res:.1e}),"
            f" moved up to {mv.max() * 1000:.2f} mm from the line fill ({mx.max() * 1000:.2f} mm from the source);"
            f" edges >40/60/90 deg source -> line fill -> patch {st['dihedralOver40']} / {st['dihedralOver60']} / {st['dihedralOver90']},"
            f" max {np.round(st['dihedralMax'], 1).tolist()}")
        Y = np.where(D[:, None], Yc, Y)
        Dall |= D
        stats.append(st)
    return Y, Dall, stats


def _poly_dist(Pts, L):
    """Distance of each point to the closed polyline L."""
    A, B = L, np.roll(L, -1, axis=0)
    AB = B - A
    best = np.full(len(Pts), np.inf)
    for i in range(0, len(Pts), 256):
        q = Pts[i:i + 256, None, :]
        t = np.clip(((q - A) * AB).sum(axis=2) / np.maximum((AB * AB).sum(axis=1), 1e-18), 0, 1)
        best[i:i + 256] = np.linalg.norm(q - (A + t[..., None] * AB), axis=2).min(axis=1)
    return best


def _stations(mesh, X, Y, U, kd, lines, crests, sides):
    """Silhouette check: exact sections before/after across the arm (perpendicular to the arm's centre
    line) at stations along each arm seam, and horizontal torso sections along each side seam.
    Perimeter / width / thickness before and after, and the largest distance between the two section
    curves outside the band (any change there is a change of the limb's shape) and inside it."""
    near_band = mesh.grow(U, 1)
    out = []
    up = np.array([0.0, 0.0, 1.0])
    y0 = float(np.median(X[:, 1]))
    for cr, (side, kind) in zip(crests, sides):
        C = np.array([r['p'] for r in cr])
        fr = (0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95) if kind == 'arm' else (0.2, 0.5, 0.8)
        for f in fr:
            c = C[int(round(f * (len(C) - 1)))]
            if kind == 'arm':
                P = lines[side]['points']
                j = int(np.argmin(np.linalg.norm(P - c, axis=1)))
                p, n, near, rad = P[j], hu._unit(P[min(j + 2, len(P) - 1)] - P[max(j - 2, 0)]), P[j], 0.1
            else:
                p, n, near, rad = c, up, np.array([0.0, y0, c[2]]), 0.3
            sb, sa = hu.section(mesh, p, n, near, rad, X), hu.section(mesh, p, n, near, rad, Y)
            if not (sb and sa and sb['closed'] and sa['closed']):
                continue
            Q = sb['points']
            d = _poly_dist(Q, sa['points'])
            inb = np.array([near_band[kd.find(q)[1]] for q in Q])
            out.append({'side': side, 'seam': kind, 'at': f, 'perimeterMm': [sb['perimeter'] * 1000, sa['perimeter'] * 1000],
                        'widthMm': [sb['width'] * 1000, sa['width'] * 1000], 'thickMm': [sb['thick'] * 1000, sa['thick'] * 1000],
                        'maxDevOutsideBandMm': float(d[~inb].max() * 1000) if (~inb).any() else 0.0,
                        'maxDevInBandMm': float(d[inb].max() * 1000) if inb.any() else 0.0})
    return out


# ---------------------------------------------------------------- step

def _kdtree(X):
    kd = kdtree.KDTree(len(X))
    for i, v in enumerate(X):
        kd.insert(v, i)
    kd.balance()
    return kd


def _trace_all(mesh, X, N, kd, Q):
    """The crest lines of both sides: per side the arm crest (forearm -> armpit) and the side crest
    (waistband -> armpit), joined at the armpit. Returns crests, info, arm lines, sides, free ends and
    the junctions."""
    H = mesh.height
    crests, info, lines, sides, free, junctions = [], {}, {}, [], [], []
    up_z = np.array([0.0, 0.0, 1.0])
    for side in ('R', 'L'):
        sign = hu.SIDES[side]
        line = hu.arm_line(mesh, side, X)
        lines[side] = line
        LP, arc = line['points'], line['arc']
        d_tip = line['d']
        # Arm seam seed: the strongest bump on the inner-lower side of an upper-arm section.
        j = min(max(int(np.searchsorted(arc, Q['armSeedArc'] * arc[-1])), 1), len(LP) - 1)
        tang = hu._unit(LP[min(j + 2, len(LP) - 1)] - LP[max(j - 2, 0)])  # toward the armpit
        sec = hu.section(mesh, LP[j], tang, LP[j], 0.1, X)
        su, Pu, Nl, h, _ = _closed_profile(mesh, X, N, sec, tang, Q, kd)
        inner = (Pu - sec['c']) @ np.array([-sign, 0.0, -1.0]) > 0
        seed = _crest_at(mesh, X, N, Pu[int(np.argmax(np.where(inner, h, -np.inf)))], tang, Q, 0.006)
        if seed is None or seed['hb'] < Q['minCrestMm'] / 1000.0:
            log(f'seams {side}: no arm seam found')
            info[side] = {'arm': 0, 'torso': 0}
            continue
        seed['t'] = tang

        def near_hand(q):
            k = kd.find(q)[1]
            return not np.isfinite(d_tip[k]) or d_tip[k] < Q['minTipDist'] * H

        up = _trace(mesh, X, N, seed, tang, Q)
        down = _trace(mesh, X, N, seed, -tang, Q, stop=near_hand)
        arm = down[::-1] + [seed] + up
        # Side seam seed: the strongest lateral bump of horizontal torso sections under the armpit.
        top = arm[-1]['p']
        best = None
        for dz in np.arange(Q['torsoScanMm'][0], Q['torsoScanMm'][1] + 1e-6, 10.0) / 1000.0:
            c = np.array([0.0, float(np.median(X[:, 1])), top[2] - dz])
            sec = hu.section(mesh, c, up_z, c, 0.3, X)
            if not sec:
                continue
            su, Pu, Nl, h, _ = _closed_profile(mesh, X, N, sec, up_z, Q, kd)
            lat = Nl[:, 0] * sign > 0.6
            if not lat.any():
                continue
            r = _crest_at(mesh, X, N, Pu[int(np.argmax(np.where(lat, h, -np.inf)))], up_z, Q, 0.006)
            if r and (best is None or r['hb'] > best['hb']):
                best = r
        torso = []
        if best is not None and best['hb'] > Q['minCrestMm'] / 1000.0:
            best['t'] = up_z
            torso = _trace(mesh, X, N, best, -up_z, Q)[::-1] + [best] + _trace(mesh, X, N, best, up_z, Q)
        # The two seams meet at the armpit: the traces stop short of the junction (a sharp turn), so
        # their ends are joined along the shortest path ON THE SURFACE through the armpit apex (a
        # straight segment would cut across the hollow).
        joined = bool(torso) and np.linalg.norm(torso[-1]['p'] - top) < Q['joinMm'] / 1000.0
        if joined:
            n_trace = len(torso)
            torso = torso + _bridge(mesh, X, kd, torso[-1], arm[-1])
            # The junction path: from the side crest's traced end over the bridge to the arm crest's
            # end (its midpoint is reported).
            J = np.array([r['p'] for r in torso[n_trace - 1:]])
            sJ = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(J, axis=0), axis=1))])
            pm = np.array([np.interp(0.5 * sJ[-1], sJ, J[:, k]) for k in range(3)])
            # The V's vertex: where the two crests, continued straight on from their traced ends, come
            # closest (the piping turns round a rounded corner inside it).
            pa, da = arm[-1]['p'], _end_dir([r['p'] for r in arm], Q['vBackMm'] / 1000.0)
            pt, dt = torso[n_trace - 1]['p'], _end_dir([r['p'] for r in torso[:n_trace]], Q['vBackMm'] / 1000.0)
            w0 = pa - pt
            bb, dd, ee = float(da @ dt), float(da @ w0), float(dt @ w0)
            den = max(1.0 - bb * bb, 1e-9)
            sa_, st_ = (bb * ee - dd) / den, (ee - bb * dd) / den
            lim = Q['joinMm'] / 1000.0
            vp = 0.5 * (pa + np.clip(sa_, 0, lim) * da + pt + np.clip(st_, 0, lim) * dt)
            junctions.append({'side': side, 'p': pm, 'vertex': int(kd.find(pm)[1]), 'length': float(sJ[-1]),
                              'vp': vp, 'vvertex': int(kd.find(vp)[1]),
                              # the armpit crease runs on from the V's vertex between the two crests' arriving
                              # directions (their bisector, pointing away from the slit)
                              'axis': hu._unit(da + dt)})
        crests += [arm] + ([torso] if torso else [])
        sides += [(side, 'arm')] + ([(side, 'side')] if torso else [])
        free += [(True, not joined)] + ([(True, not joined)] if torso else [])
        L_arm = float(np.linalg.norm(np.diff([r['p'] for r in arm], axis=0), axis=1).sum())
        L_torso = float(np.linalg.norm(np.diff([r['p'] for r in torso], axis=0), axis=1).sum()) if len(torso) > 1 else 0.0
        hb_arm = np.array([r['hb'] for r in arm]) * 1000
        hb_torso = np.array([r['hb'] for r in torso]) * 1000 if torso else np.zeros(1)
        info[side] = {'armLength': L_arm, 'torsoLength': L_torso, 'armEnds': [arm[0]['p'].tolist(), arm[-1]['p'].tolist()],
                      'torsoEnds': [torso[0]['p'].tolist(), torso[-1]['p'].tolist()] if torso else None,
                      'armHeightMm': [float(np.median(hb_arm)), float(hb_arm.max())],
                      'torsoHeightMm': [float(np.median(hb_torso)), float(hb_torso.max())]}
        log(f"seams {side}: arm crest {L_arm * 100:.1f} cm ({len(arm)} pts, height median {np.median(hb_arm):.1f} mm),"
            f" side crest {L_torso * 100:.1f} cm ({len(torso)} pts, {np.median(hb_torso):.1f} mm)")
    return crests, info, lines, sides, free, junctions


def step_seams(mesh, X, P, masks):
    Q = _defaults(P)
    N = mesh.normals(X)
    kd = _kdtree(X)
    crests, info, lines, sides, free, junctions = _trace_all(mesh, X, N, kd, Q)
    if not crests:
        masks['seams'] = np.zeros(mesh.n, bool)
        return X, info
    # The band, ridge-free normals, re-spacing, fill, soft mask (see the module doc).
    region = np.zeros(mesh.n, bool)
    for cr in crests:
        for rr in cr:
            for _, i, _ in kd.find_range(rr['p'], 0.03):
                region[i] = True
    Nsm = _smooth_normals(mesh, X, N, region, Q)
    U, r, wb, wf, tv, e_end = _band(mesh, X, Nsm, kd, crests, free, Q)
    # Free ends (forearm, waistband): the band stops endMarginMm inside the traced end, so whatever the
    # crest runs into there (a sleeve wrinkle, the waistband's top lip) stays as it is.
    em = Q['endMarginMm'] / 1000.0
    cut = int((U & (e_end <= em)).sum())
    U &= e_end > em
    # The armpit slit (where the arm and the torso nearly touch, below the junction) is no part of the
    # seam: its walls face each other within apexSlitMm and are left as they are, so no fill can span
    # the slit (which would pull its walls together).
    slit = np.zeros(mesh.n, bool)
    excl = None
    if Q['apexSlitMm'] > 0 and junctions:
        reach = np.zeros(mesh.n, bool)
        for jn in junctions:
            reach |= mesh.dijkstra(jn['vvertex'], dmax=Q['apexSlitReachMm'] / 1000.0 + 0.002) < Q['apexSlitReachMm'] / 1000.0
        walls = _slit_walls(mesh, X, reach, N, Q['apexSlitMm'] / 1000.0)
        slit = walls & ~(r <= wf)
        log(f"seams: armpit slit walls (facing the other wall within {Q['apexSlitMm']:.0f} mm, beyond the piping's base): {int(slit.sum())} vertices, {int((U & slit).sum())} of them in the bands, left fixed")
        U &= ~slit
        # The walls and their edges are no curvature data for the fills (see _carried_curvature).
        excl = mesh.dijkstra(np.nonzero(walls)[0], dmax=Q['curvSlitMm'] / 1000.0 + 0.001) <= Q['curvSlitMm'] / 1000.0 if walls.any() else None
    # Re-spacing where the fill replaces the surface fully, plus respaceExtraMm into the soft mask.
    Ur = U & (r <= wf + Q['respaceExtraMm'] / 1000.0)
    Xr = _respace(mesh, X, Ur, Nsm, tv, Q) if Q['respace'] else X
    Xr = _untangle(mesh, Xr, Ur, Nsm, Q)
    Hb = _carried_curvature(mesh, Xr, U, Nsm, Q, excl, slow=tv if Q['curvAcross'] > 1 else None, ratio=Q['curvAcross'],
                            core=(U & (r <= wf + Q['curvCoreMm'] / 1000.0)) if Q['curvCoreMm'] is not None else None, Xdata=X) if Q['carryCurvature'] else None
    Yf, delta, its, res, held = _fair(mesh, Xr, U, Nsm, Q, Hb, base=X)  # delta: along the (ridge-free) surface normal, - = in
    # Soft mask: the fill replaces the ridge fully out to its base troughs and fades out over taperMm,
    # so wrinkles that run into the band fade instead of ending in a cliff; at a free end it fades in
    # over endTaperMm from the band's end.
    wgt = np.where(U, 1.0 - smoothstep((r - wf) / max(Q['taperMm'] / 1000.0, 1e-9)), 0.0)
    wgt *= smoothstep((e_end - em) / max(Q['endTaperMm'] / 1000.0, 1e-9))
    log(f'seams: band ends at the free crest ends: {cut} band vertices at or beyond the ends left fixed')
    Y = X + wgt[:, None] * (Yf - X)
    delta = delta * wgt
    follow = np.zeros(mesh.n, bool)
    if Q['wallFollow'] and slit.any():
        # The slit's walls hang from the rim the fill has just lowered: they follow it, by the fill's
        # displacement carried into them harmonically (zero where the walls end), so the slit's top end
        # goes down with the surface round it instead of standing proud as a tooth.
        follow = slit & ~U
        dlt = Y - X
        tri_w = mesh.grow(follow, 1)[mesh.T].any(axis=1)
        Iw, Jw, Ww, _ = _cotan(mesh, X, tri_w, [0.0, Q['cotClamp'][1]])
        wid = np.nonzero(follow)[0]
        ext = np.zeros((len(wid), 3))
        for k in range(3):
            ext[:, k], _ = _harmonic(mesh, follow, dlt[:, k], Iw, Jw, Ww, Q)
        Y[wid] = X[wid] + ext
        log(f'seams: {len(wid)} slit wall vertices follow the fill (moved up to {np.linalg.norm(ext, axis=1).max() * 1000:.2f} mm)')
    # The armpit junctions: refilled as 2D patches over the line fill.
    disc = np.zeros(mesh.n, bool)
    info['junctions'] = []
    if Q['apex'] and junctions:
        Y, disc, info['junctions'] = _junction(mesh, X, Y, junctions, Q, (walls if Q['apexFixAllWalls'] else slit) if junctions and Q['apexSlitMm'] > 0 else slit, excl)
        delta = np.where(disc, ((Y - X) * Nsm).sum(axis=1), delta)
    masks['seams'] = U | disc | follow
    moved = Y - X
    # Re-measure the crests on the result.
    # Every third crest point is classed by where it lies: the band's interior (the seam is to be gone
    # there), a free end's fade (endMarginMm + endTaperMm: the piping is meant to run out there) or a
    # junction patch (the ridge measure there also sees the armpit slit's own edge).
    NY = mesh.normals(Y)
    after, before, worst, cls = [], [], [], []
    for cr in crests:
        for rr in cr[::3]:
            k = kd.find(rr['p'])[1]
            c = 'junction' if disc[k] else ('end' if e_end[k] < em + Q['endTaperMm'] / 1000.0 else 'band')
            a = _crest_at(mesh, Y, NY, rr['p'], rr['t'], Q, 0.003)
            after.append(a['hb'] if a else 0.0)
            before.append(rr['hb'])
            cls.append(c)
            if c == 'band':
                worst.append((after[-1], rr['p'].tolist()))
    after, before, cls = np.array(after), np.array(before), np.array(cls)
    worst.sort(key=lambda w: -w[0])
    log('seams: highest crests left inside the bands ' + ', '.join(f'{w * 1000:.2f} mm at {np.round(p, 3).tolist()}' for w, p in worst[:6]))
    for c in ('end', 'junction'):
        if (cls == c).any():
            log(f'seams: crest height at the {c}s (by design not, or not only, the piping) {np.median(before[cls == c]) * 1000:.2f} -> {np.median(after[cls == c]) * 1000:.2f} mm median, max {after[cls == c].max() * 1000:.2f} mm')
    k_out = int(np.argmax(delta))
    log(f'seams: largest outward move {delta[k_out] * 1000:.2f} mm at {np.round(X[k_out], 3).tolist()}, r {r[k_out] * 1000:.1f} mm, band {wb[k_out] * 1000:.1f} mm')
    stations = _stations(mesh, X, Y, masks['seams'], kd, lines, crests, sides)
    for st in stations:
        log(f"seams: section {st['side']} {st['seam']} {st['at']:.2f}: perimeter {st['perimeterMm'][0]:.1f} -> {st['perimeterMm'][1]:.1f} mm,"
            f" width {st['widthMm'][0]:.1f} -> {st['widthMm'][1]:.1f}, thick {st['thickMm'][0]:.1f} -> {st['thickMm'][1]:.1f},"
            f" max change outside band {st['maxDevOutsideBandMm']:.2f} mm, in band {st['maxDevInBandMm']:.2f} mm")
    info.update({'bandVertices': int(masks['seams'].sum()), 'maxInMm': float(-delta.min() * 1000), 'maxOutMm': float(delta.max() * 1000),
                 'heldAtBound': int(held),
                 'maxMoveMm': float(np.linalg.norm(moved, axis=1).max() * 1000),
                 'cgIterations': its, 'cgResidual': res,
                 'crestHeightMm': {c: {'points': int((cls == c).sum()),
                                       'before': [float(np.median(before[cls == c]) * 1000), float(np.max(before[cls == c]) * 1000)],
                                       'after': [float(np.median(after[cls == c]) * 1000), float(np.max(after[cls == c]) * 1000)]}
                                   for c in ('band', 'end', 'junction') if (cls == c).any()},
                 'stations': stations,
                 'crests': [[np.round(rr['p'], 5).tolist() for rr in cr] for cr in crests],
                 'crestNormals': [[np.round(rr['n'], 3).tolist() for rr in cr] for cr in crests]})
    log(f"seams: band {int(masks['seams'].sum())} verts, moved in up to {-delta.min() * 1000:.1f} mm / out {delta.max() * 1000:.1f} mm,"
        f" crest height inside the bands median {np.median(before[cls == 'band']) * 1000:.2f} -> {np.median(after[cls == 'band']) * 1000:.2f} mm (max {np.max(after[cls == 'band']) * 1000:.2f})")
    return Y, info
