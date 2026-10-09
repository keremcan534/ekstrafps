"""Glove cuff over the wrist joint -> a simple, snug, animation-friendly cuff.

c12's glove ends in a flared gauntlet: from the wrist pivot up to ~5.5 cm the sections widen to
11-13 cm (the forearm sleeve is ~7.7 cm), carry bunched folds (wavelength 1-3 cm, relief ~1.6 mm
over a 3 cm low-pass) and a stepped rim over the sleeve. A skinned wrist bends and twists inside
exactly that zone, so the bulk and the folds are what tear and collapse in aiming / reload poses.

Smooth deformations only - no projection onto a target surface (projection collapses every vertex
of a fold onto one radius and makes flaps). Everything is found on the mesh (hu.hand: wrist centre
on the forearm bone line, forearm frame, digits); t is the level along the bone line above the
wrist pivot, theta the direction around the forearm in the forearm frame (0 = palm side, +90 = thumb
side on both arms, so the two arms share one anatomical angle).

  0. The sleeve hem (hem_lines()). The sleeve ends ~7 cm above the wrist in a ledge over the glove
     (the surface steps outward going up the arm), and that ledge, the band above it and the seam
     that ends on it are garment detail to keep. Per direction theta the ledge is where the
     section radius about the forearm axis rises fastest with t. The slope field dr/dt(t, theta)
     is smoothed around the arm first (hemAngSmooth), which keeps the near-level ledge and averages
     out the glove's oblique folds, whose slopes are as strong as the ledge's. The hem is then the
     closed line through the field with the largest summed slope and a bending penalty (dynamic
     programming around the circle). It is found jointly for both arms first (mirror prior: one
     garment, one hem course), then refined per arm within +-hemBand of the shared course, so a
     weak ledge on one arm cannot be traded for a fold ridge. Below the ledge line, per direction,
     the ledge's foot is where the ledge's own outward step ends: the first level where the slope
     reaches 0 (the bottom of the groove under the sleeve's edge) or starts rising again (a glove
     fold whose flank runs into the ledge from below). The fade-out line t_end(theta) lies hemFootFrac of
     the way from the foot up to the ledge line (eroded and smoothed around the arm): every vertex
     at or above it is fixed (moves exactly 0), and the low-pass and slimming fade in just below
     it along the hem's own course. There the fixed surface already rises into the ledge, so the
     glove's top fold under the hem is faired away too and the faired glove meets the ledge with
     a concave turn - a clean crease under the sleeve's edge, no leftover roll (a line on the
     fold's falling flank would make the C1 fairing ride over it as a bump).

A soft weight m is 0 from 1.5 cm below the wrist (palm, thenar, thumb, fingers are never moved),
ramps to 1 just above the wrist, stays 1 over the gauntlet and fades to 0 over hemTaper below
t_end(theta); a geodesic guard keeps it 0 around the thumb.

  1. Low-pass (lowpass()): a screened thin-plate filter, min |D X|^2 + a(m) |X - X0|^2, whose
     cut-off wavelength (8 cm at m = 1) fades smoothly to nothing with the weight. It removes the
     folds (H = 1 / (1 + (8/lambda)^4): a 2 cm fold keeps 0.4 %) and keeps the tube. Solved three
     times: (a) isotropic screen, uniform umbrella; (b) screen along the smoothed normals of (a)
     only, so the surplus vertices of the fold walls spread over the surface instead of staying
     compressed into thin pleats; (c) a geometric polish of (b) with cotangent weights (linear
     precision: no tangential drift, no bumps from the source's irregular connectivity).
  2. Slimming. In every plane across the bone line the low-passed section is scaled radially about
     its own area centroid by s(t, theta) and moved toward the glove top's centre:
        q' = c(t) + gamma(t) (c_f - c(t)) + s(t, theta) (q - c(t))
        s  = 1 - beta(t, theta) + beta(t, theta) k(t, theta) R_f(theta) / R(t, theta)
     R(t, theta) is the low-passed section's polar envelope and R_f(theta) the glove's own top ring
     where it tucks under the hem (the envelope along t_end(theta), smoothed around the arm), so
     the cuff is that ring carried down to the wrist; c_f is the centre at the lowest fade-out
     level. k is the slim-wrist factor (waistRatio at the end of the fillet, 1 at t_end), beta a C2
     ramp (0 at the wrist pivot, 1 over the cuff, 0 again slimTaper below t_end(theta)) and gamma
     the same ramp in t alone, ending below the lowest t_end. A vertex keeps its level t and each
     plane map is a translation plus a positive scale of every ray from c(t), smooth in t and
     theta, so the map is a bijection of space: it cannot fold or make the surface pass through
     itself.

The wrist section (t <= start) is never scaled and the low-pass weight is 0 below -maskBelow, so
the hand itself is untouched; nothing at or above t_end(theta) moves, so the hem, the sleeve and
its seam are untouched. The step reports the hem lines, the width profile along t, the fold relief
before / after and the largest move at and above the fade-out line.
"""
import math

import numpy as np

import humanoid as hu
from steps.common import log, smoothstep


def smootherstep(x):
    """C2 ramp 0..1 (zero slope and curvature at both ends), so blended radii have no curvature seam."""
    x = np.clip(x, 0.0, 1.0)
    return x * x * x * (x * (6 * x - 15) + 10)

DEFAULTS = {
    # zone along the forearm bone line, metres above the wrist pivot (+ = toward the elbow)
    'maskBelow': 0.015,  # low-pass weight 0 this far below the wrist (the palm / thenar are never touched) ...
    'maskRamp': 0.020,  # ... reaching 1 this much higher
    'radius': 0.10,  # in-plane distance from the bone line that bounds the zone
    # sleeve hem (the fade-out line follows it)
    'hemSearch': [0.045, 0.095],  # levels searched for the hem ledge
    'hemBins': 72,  # directions around the arm
    'hemDt': 0.001,  # level spacing of the hem search
    'hemAngSmooth': 12.0,  # deg: slope field smoothed around the arm (keeps the level ledge, averages oblique folds)
    'hemStiffness': 3.2e5,  # bending penalty kappa (dt/dtheta)^2 of the hem line, t in m, theta in deg
    'hemMirror': True,  # shared course for both arms first (mirror prior), then per-arm refinement
    'hemBand': 0.005,  # per-arm refinement window around the shared course
    'hemLineSmooth': 6.0,  # deg: smoothing of the found ledge and foot lines around the arm
    'footAngSmooth': 5.0,  # deg: slope field smoothing used for the foot search
    'footSearch': 0.012,  # the ledge's foot is searched this far below the ledge line
    'hemFootFrac': 0.5,  # fade-out line this fraction of the way from the ledge's foot (groove bottom) up to the ledge line
    'hemErode': 6.0,  # deg: the fade-out line takes the lowest level within this angle (conservative where the hem steps)
    'hemGap': 0.0,  # extra offset of the fade-out line downward
    'hemTaper': 0.006,  # low-pass weight fades from 1 to 0 over this below the fade-out line
    'hemFallback': 0.060,  # fade-out level if no hem is found
    'refSmooth': 15.0,  # deg: smoothing of the glove top ring R_f around the arm
    'thumbGuard': 0.015,  # geodesic fade-in from the thumb (m)
    # low-pass (screened thin-plate filter)
    'cutoff': 0.08,  # wavelength (m) where the filter passes half: folds (1-3 cm) go, the tube stays
    'pinRatio': 1.0e4,  # screening at weight 0 relative to weight 1 (cut-off / 10 at the mask's edge)
    'cgTol': 1.0e-6,  # CG residual reduction
    'cgMaxIter': 30000,
    'uniformWeights': True,  # umbrella weights of solves (a)/(b): uniform (spreads the fold walls' vertices) or 1/edge
    'tanScreen': 0.001,  # tangential screening relative to the normal one at weight 1 (< 1: normal-only solves follow)
    'normalPasses': 1,  # normal-only solves (b) after the isotropic one (a)
    'normalSmooth': 30,  # umbrella iterations on the normal field used by a normal-only solve
    'polishCutoff': 0.03,  # cut-off of the final cotangent-weight polish (c) of the relaxed surface (0 = off)
    # slimming
    'slim': True,  # False: low-pass only (debugging)
    'start': 0.0,  # sections at or below this level are never scaled (the wrist pivot)
    'fillet': 0.040,  # hand -> slim cuff transition length
    'waistRatio': 0.92,  # slim-wrist factor on the glove top ring at the end of the fillet
    'centreShift': 0.5,  # how far the cuff's section centres move onto the glove top's centre (0..1)
    'slimTaper': 0.008,  # slimming fades out over this below the fade-out line
    'scaleMin': 0.35,
    'scaleMax': 1.08,
    'bins': 96,  # angular bins of the polar envelope
    'dt': 0.002,  # level spacing of the envelope grid
    'envDensify': 6,  # points per section edge for the envelope (1 = crossing points only)
    'envSmoothT': 0.004,  # envelope smoothing along t (m, Gaussian sigma)
    'envSmoothDeg': 5.6,  # envelope smoothing around the arm (deg, Gaussian sigma)
}


def _par(P):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in P.items() if k in DEFAULTS})
    return out


# ---------------------------------------------------------------- screened thin-plate low-pass

def lowpass(mesh, X, ids, m, cutoff, pin_ratio, tol=1e-10, max_iter=20000, uniform=True, normals=None, tan_screen=1.0, x_init=None,
            cotan=False):
    """Low-pass filter of the vertices `ids` with soft weights m (0..1]; all other vertices fixed.

    Minimises   sum_r |D_r X|^2  +  sum_i a_i |X_i - X0_i|^2
    over the positions of `ids`, with D a metric Laplace-Beltrami estimate in 1/m on every row that
    touches a free vertex - the first fixed ring included, so the result keeps position and slope
    where it meets the untouched surface. D is the umbrella operator (uniform or 1/edge weights)
    scaled by 4 / h^2 (h^2 the vertex's mean squared edge length), or with cotan=True the cotangent
    operator over the barycentric area. On a surface patch this is the linear filter
    H(lambda) = 1 / (1 + (lambda_c / lambda)^4) of the surface's wavelengths lambda with the cut-off
    lambda_c = 2 pi a^(-1/4): folds well below the cut-off are removed, the tube (whose curvature
    term is ~1/R^3) keeps its size. The screening a_i blends log-linearly from a_in =
    (2 pi / cutoff)^4 at weight 1 to pin_ratio * a_in at weight 0, so the cut-off itself fades out
    smoothly over the mask's ramps (no seam). Jacobi-preconditioned conjugate gradients on the
    displacement, stopped when the residual fell by `tol`.

    With `normals` (unit, per id) the screening acts on the displacement along those normals, and
    on the tangential part scaled by tan_screen^m (full screening at weight 0): the folds' relief is
    filtered the same way, but the surplus vertices of the fold walls are free to spread over the
    surface instead of staying compressed into thin pleats (uniform umbrella weights pull them apart).
    Returns (new positions of ids, CG iterations, final relative residual)."""
    n = len(ids)
    loc = -np.ones(mesh.n, np.int64)
    loc[ids] = np.arange(n)
    rowmask = np.zeros(mesh.n, bool)
    rowmask[ids] = True
    r_ids = np.nonzero(mesh.grow(rowmask, 1))[0]
    nr = len(r_ids)
    deg = mesh.deg[r_ids]
    rr = np.repeat(np.arange(nr), deg)
    k = np.repeat(mesh.indptr[r_ids], deg) + np.arange(int(deg.sum())) - np.repeat(np.cumsum(deg) - deg, deg)
    cc = mesh.nbr[k]
    el = np.maximum(np.linalg.norm(X[cc] - X[r_ids[rr]], axis=1), 1e-6)
    if cotan:
        wgt, area = _cotan_weights(mesh, X, r_ids, k)
        wsum = np.bincount(rr, wgt, minlength=nr)
        rows = np.concatenate([rr, np.arange(nr)])
        cols = np.concatenate([cc, r_ids])
        vals = np.concatenate([wgt / area[rr], -wsum / area])
    else:
        wgt = np.ones_like(el) if uniform else 1.0 / el
        wsum = np.bincount(rr, wgt, minlength=nr)
        h2 = np.bincount(rr, el ** 2, minlength=nr) / deg
        sc = 4.0 / h2
        rows = np.concatenate([rr, np.arange(nr)])
        cols = np.concatenate([cc, r_ids])
        vals = np.concatenate([sc[rr] * wgt / wsum[rr], -sc])
    free = loc[cols] >= 0
    Rv, Cv, Vv = rows[free], loc[cols[free]], vals[free]
    Rf, Cf, Vf = rows[~free], cols[~free], vals[~free]

    def D(v):
        return np.stack([np.bincount(Rv, Vv * v[Cv, d], minlength=nr) for d in range(3)], axis=1)

    def DT(u):
        return np.stack([np.bincount(Cv, Vv * u[Rv, d], minlength=n) for d in range(3)], axis=1)

    a_in = (2 * math.pi / cutoff) ** 4
    a = a_in * pin_ratio ** (1.0 - np.clip(m, 0.0, 1.0))
    X0 = X[ids]
    fixed = np.stack([np.bincount(Rf, Vf * X[Cf, d], minlength=nr) for d in range(3)], axis=1)
    dd = np.bincount(Cv, Vv ** 2, minlength=n)
    if normals is None:
        b = a[:, None] * X0 - DT(fixed)
        pre = (1.0 / (dd + a))[:, None]

        def A(v):
            return DT(D(v)) + a[:, None] * v
    else:
        N = normals
        at = a * tan_screen ** np.clip(m, 0.0, 1.0)  # tangential freedom fades out with the weight too
        b = (a * (N * X0).sum(axis=1))[:, None] * N + at[:, None] * X0 - DT(fixed)
        pre = 1.0 / (dd[:, None] + a[:, None] * N ** 2 + at[:, None])

        def A(v):
            return DT(D(v)) + (a * (N * v).sum(axis=1))[:, None] * N + at[:, None] * v

    # One CG on the stacked 3n system (the normal screen couples x, y, z), for the displacement from
    # the start point, stopped when the residual fell by `tol`.
    x = X0.copy() if x_init is None else x_init.copy()
    r = b - A(x)
    r0 = float(np.linalg.norm(r)) + 1e-300
    u = np.zeros_like(x)
    z = pre * r
    p = z.copy()
    rz = float((r * z).sum())
    it = 0
    res = 1.0
    while it < max_iter and res > tol:
        Ap = A(p)
        alpha = rz / max(float((p * Ap).sum()), 1e-300)
        u += alpha * p
        r -= alpha * Ap
        z = pre * r
        rz_new = float((r * z).sum())
        p = z + (rz_new / max(rz, 1e-300)) * p
        rz = rz_new
        it += 1
        if it % 25 == 0:
            res = float(np.linalg.norm(r)) / r0
    x += u
    res = float(np.linalg.norm(b - A(x))) / r0
    return x, it, res


def _cotan_weights(mesh, X, r_ids, k):
    """Cotangent weights (cot a + cot b) / 2 of the CSR entries k (edges from the vertices r_ids, in
    CSR order) and the barycentric area of each r_ids vertex. Negative cotangents (obtuse angles)
    are clamped to 0, so the operator stays a positive averaging one on poor triangles."""
    n = mesh.n
    sel = np.zeros(n, bool)
    sel[r_ids] = True
    T = mesh.T[sel[mesh.T].any(axis=1)]
    src = np.repeat(r_ids, mesh.deg[r_ids])
    keys = src * n + mesh.nbr[k]
    order = np.argsort(keys)
    skeys = keys[order]
    w = np.zeros(len(keys))
    area = np.zeros(n)
    P = X[T]
    tri_area = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
    for c in range(3):
        np.add.at(area, T[:, c], tri_area / 3)
    for c in range(3):
        a_, b_ = (c + 1) % 3, (c + 2) % 3  # edge (a, b) opposite corner c
        u = P[:, a_] - P[:, c]
        v = P[:, b_] - P[:, c]
        cot = (u * v).sum(axis=1) / np.maximum(np.linalg.norm(np.cross(u, v), axis=1), 1e-20)
        cot = 0.5 * np.maximum(cot, 0.0)
        for x, y in ((T[:, a_], T[:, b_]), (T[:, b_], T[:, a_])):
            kk = x * n + y
            pos = np.searchsorted(skeys, kk)
            pos = np.minimum(pos, len(skeys) - 1)
            hit = skeys[pos] == kk
            np.add.at(w, order[pos[hit]], cot[hit])
    return np.maximum(w, 1e-12), np.maximum(area[r_ids], 1e-12)


def _smooth_normals(mesh, Z, ids, iterations):
    """Vertex normals of Z at ids, averaged over neighbours `iterations` times (unit)."""
    N = mesh.normals(Z)
    if iterations > 0:
        sel = np.zeros(mesh.n, bool)
        sel[ids] = True
        sel = mesh.grow(sel, 2)
        for _ in range(iterations):
            U = mesh.umbrella(N)
            N[sel] = U[sel]
            N[sel] /= np.maximum(np.linalg.norm(N[sel], axis=1), 1e-12)[:, None]
    return N[ids]


def relief(mesh, X, ids, core, wavelength=0.03):
    """Fold relief of the surface: the normal component of X minus its low-pass at `wavelength`
    over ids (1/edge weights, so the vertices barely slide), measured on the vertices ids[core].
    Returns [rms, p95, max] in mm."""
    Z, _, _ = lowpass(mesh, X, ids, np.ones(len(ids)), wavelength, 1.0, 1e-6, 20000, uniform=False)
    N = mesh.normals(X)[ids]
    h = np.abs(((X[ids] - Z) * N).sum(axis=1))[core] * 1000
    return [round(float(np.sqrt((h ** 2).mean())), 3), round(float(np.percentile(h, 95)), 3), round(float(h.max()), 3)]


# ---------------------------------------------------------------- sections in the bone-line frame

def _polar(Q, bins):
    """Outer radius per angle bin of a closed 2D section about the origin (gaps interpolated)."""
    th = np.arctan2(Q[:, 1], Q[:, 0])
    r = np.hypot(Q[:, 0], Q[:, 1])
    b = np.floor((th + math.pi) / (2 * math.pi) * bins).astype(int) % bins
    out = np.full(bins, -1.0)
    np.maximum.at(out, b, r)
    good = np.nonzero(out > 0)[0]
    if len(good) < bins:
        out = np.interp(np.arange(bins), good, out[good], period=bins)
    return out


def _circ_smooth(a, sigma):
    """Gaussian smoothing along the last axis, periodic."""
    if sigma <= 0:
        return a
    k = np.arange(-int(3 * sigma) - 1, int(3 * sigma) + 2)
    g = np.exp(-0.5 * (k / sigma) ** 2)
    g /= g.sum()
    out = np.zeros_like(a)
    for j, gj in zip(k, g):
        out += gj * np.roll(a, j, axis=-1)
    return out


def _line_smooth(a, sigma):
    """Gaussian smoothing along axis 0 with edge padding."""
    if sigma <= 0 or len(a) < 3:
        return a
    k = np.arange(-int(3 * sigma) - 1, int(3 * sigma) + 2)
    g = np.exp(-0.5 * (k / sigma) ** 2)
    g /= g.sum()
    pad = len(k) // 2
    A = np.concatenate([np.repeat(a[:1], pad, axis=0), a, np.repeat(a[-1:], pad, axis=0)])
    out = np.zeros_like(a)
    for i, gi in enumerate(g):
        out += gi * A[i:i + len(a)]
    return out


def _sections(mesh, X, w, fa, e1, e2, ts, bins, densify=1):
    """Exact sections across the bone line at levels ts: 2D centroids (e1, e2) and polar envelopes.
    densify > 1 samples the loop's edges (densify points each) instead of only its crossing points:
    the outer radius of a bin is then the loop's own, not whichever crossing point fell into it."""
    up = -fa
    C = np.full((len(ts), 2), np.nan)
    R = np.full((len(ts), bins), np.nan)
    for i, t in enumerate(ts):
        c = w + up * t
        s = hu.section(mesh, c, fa, c, 0.09, X)
        if not (s and s['closed']):
            continue
        cc = np.array([(s['c'] - c) @ e1, (s['c'] - c) @ e2])
        Q = np.stack([(s['points'] - c) @ e1, (s['points'] - c) @ e2], axis=1) - cc
        if densify > 1:  # points along the loop's edges too, so every angle bin sees the true outer radius
            Q = np.concatenate([Q + (np.roll(Q, -1, axis=0) - Q) * f for f in np.linspace(0, 1, densify, endpoint=False)])
        C[i] = cc
        R[i] = _polar(Q, bins)
    ok = ~np.isnan(C[:, 0])
    if ok.sum() < 3:
        return None, None, ok
    idx = np.arange(len(ts))
    for k in range(2):
        C[:, k] = np.interp(idx, idx[ok], C[ok, k])
    for j in range(bins):
        R[:, j] = np.interp(idx, idx[ok], R[ok, j])
    return C, R, ok


def profile(mesh, X, w, fa, e1, e2, ts):
    """Width / thickness / area of the exact sections at levels ts (for the report)."""
    up = -fa
    out = []
    for t in ts:
        c = w + up * t
        s = hu.section(mesh, c, fa, c, 0.09, X)
        if s and s['closed']:
            out.append([round(float(t), 4), round(s['width'] * 100, 2), round(s['thick'] * 100, 2), round(s['area'] * 1e4, 1)])
        else:
            out.append([round(float(t), 4), None, None, None])
    return out


def _cr_weights(f):
    """Catmull-Rom weights of the samples -1, 0, 1, 2 at fraction f (C1 interpolation)."""
    f2, f3 = f * f, f * f * f
    return np.stack([(-f3 + 2 * f2 - f) / 2, (3 * f3 - 5 * f2 + 2) / 2, (-3 * f3 + 4 * f2 + f) / 2, (f3 - f2) / 2])


def _cubic1d(v, x, periodic=False):
    """C1 (Catmull-Rom) interpolation of samples v at fractional indices x (clamped, or periodic)."""
    n = len(v)
    x = np.asarray(x, float)
    if not periodic:
        x = np.clip(x, 0, n - 1)
    i0 = np.floor(x).astype(int)
    W = _cr_weights(x - i0)
    out = np.zeros(x.shape)
    for k in range(4):
        idx = i0 + k - 1
        idx = idx % n if periodic else np.clip(idx, 0, n - 1)
        out += W[k] * v[idx]
    return out


def _bicubic(G, ti, aj):
    """C1 (Catmull-Rom) interpolation of grid G[t, angle] at fractional indices (clamped in t,
    periodic in angle). Bilinear interpolation would make the slimming's scale field kinked along
    every grid line, which shows as broken-up highlights on the slimmed cuff."""
    nt, nb = G.shape
    ti = np.clip(np.asarray(ti, float), 0, nt - 1)
    aj = np.asarray(aj, float)
    i0 = np.floor(ti).astype(int)
    j0 = np.floor(aj).astype(int)
    Wt, Wa = _cr_weights(ti - i0), _cr_weights(aj - j0)
    out = np.zeros(ti.shape)
    for a in range(4):
        ii = np.clip(i0 + a - 1, 0, nt - 1)
        for b in range(4):
            out += Wt[a] * Wa[b] * G[ii, (j0 + b - 1) % nb]
    return out


# ---------------------------------------------------------------- the sleeve hem

def _axis_offsets(mesh, X, w, fa, e1, e2, lo, hi, step=0.005):
    """Straight forearm axis through the exact sections' centroids at levels lo..hi, as the in-plane
    offset (e1, e2) from the bone line linear in t: rows [a, b] with offset = a + b t."""
    up = -fa
    rows = []
    for t in np.arange(lo, hi + 1e-9, step):
        c = w + up * t
        s = hu.section(mesh, c, fa, c, 0.09, X)
        if s and s['closed']:
            rows.append([t, (s['c'] - c) @ e1, (s['c'] - c) @ e2])
    if len(rows) < 3:
        return None
    A = np.array(rows)
    M = np.stack([np.ones(len(A)), A[:, 0]], axis=1)
    return np.stack([np.linalg.lstsq(M, A[:, k], rcond=None)[0] for k in (1, 2)])


def _axis_point(w, up, e1, e2, ax, t):
    return w + up * t + e1 * (ax[0, 0] + ax[0, 1] * t) + e2 * (ax[1, 0] + ax[1, 1] * t)


def _polar_about_axis(mesh, X, w, fa, e1, e2, ax, ts, bins):
    """Outer radius per direction (theta = atan2(e2, e1), bins from -180 deg) of the exact sections at
    levels ts about the straight axis ax; rows without a closed section are NaN."""
    up = -fa
    R = np.full((len(ts), bins), np.nan)
    for i, t in enumerate(ts):
        c = _axis_point(w, up, e1, e2, ax, t)
        s = hu.section(mesh, c, fa, c, 0.09, X)
        if not (s and s['closed']):
            continue
        P = s['points'] - c
        q = np.stack([P @ e1, P @ e2], axis=1)
        q = np.concatenate([q + (np.roll(q, -1, axis=0) - q) * f for f in np.linspace(0, 1, 6, endpoint=False)])
        R[i] = _polar(q, bins)
    return R


def _dp_circular(score, ts, lam):
    """Closed line through score[level, direction] (direction periodic) with the largest summed score
    minus lam * (level step)^2 between neighbouring directions. Dynamic programming over three laps
    of the circle, the middle lap kept, so the starting direction does not matter. Returns level
    indices per direction."""
    nt, nb = score.shape
    pen = lam * (ts[:, None] - ts[None, :]) ** 2
    D = np.zeros(nt)
    back = []
    for _ in range(3):
        for k in range(nb):
            M = D[None, :] - pen
            j = np.argmax(M, axis=1)
            back.append(j)
            D = M[np.arange(nt), j] + score[:, k]
    i = int(np.argmax(D))
    path = []
    for b in back[::-1]:
        path.append(i)
        i = b[i]
    return np.array(path[::-1][nb:2 * nb])


def _circ_erode(a, half):
    """Minimum over +-half samples, periodic."""
    out = a.copy()
    for k in range(1, int(half) + 1):
        out = np.minimum(out, np.minimum(np.roll(a, k), np.roll(a, -k)))
    return out


def hem_lines(mesh, X, frames, Q):
    """Sleeve hem ledge line of each arm (module doc, 0.). frames: side -> (w, fa, e1, e2).
    Returns side -> {'axis', 'theta' (deg, bin centres), 'ledge' (level per direction), 'end' (the
    fade-out line t_end), 'slope' (dr/dt on the ledge line), 'shared' (the joint course)}."""
    lo, hi = Q['hemSearch']
    dt = float(Q['hemDt'])
    bins = int(Q['hemBins'])
    deg = 360.0 / bins
    ts = np.arange(lo, hi + 1e-9, dt)
    theta = -180.0 + (np.arange(bins) + 0.5) * deg
    lam = Q['hemStiffness'] / deg ** 2  # penalty kappa (dt/dtheta)^2 per degree, discretised
    score, out = {}, {}
    for side, (w, fa, e1, e2) in frames.items():
        ax = _axis_offsets(mesh, X, w, fa, e1, e2, lo, hi + 0.03)
        if ax is None:
            continue
        R = _polar_about_axis(mesh, X, w, fa, e1, e2, ax, ts, bins)
        ok = ~np.isnan(R).any(axis=1)
        if ok.sum() < len(ts) // 2:
            continue
        idx = np.arange(len(ts))
        for j in range(bins):
            R[:, j] = np.interp(idx, idx[ok], R[ok, j])
        R = _circ_smooth(_line_smooth(R, 1.0), 1.0)
        S0 = _line_smooth(np.gradient(R, dt, axis=0), 2.0)  # + = the surface steps outward going up the arm
        S = _circ_smooth(S0, Q['hemAngSmooth'] / deg)  # keeps the level ledge, averages the oblique folds
        score[side] = np.clip(S, 0.0, None)
        out[side] = {'axis': ax, 'theta': theta, 'slopeField': S, 'slopeFine': _circ_smooth(S0, Q['footAngSmooth'] / deg)}
    if not out:
        return out
    shared = None
    if Q['hemMirror'] and len(score) == 2:
        shared = ts[_dp_circular(score['R'] + score['L'], ts, lam)]
    for side, o in out.items():
        sc = score[side]
        if shared is not None:
            sc = np.where(np.abs(ts[:, None] - shared[None, :]) <= Q['hemBand'] + 1e-9, sc, -10.0)
        path = _dp_circular(sc, ts, lam)
        ledge = ts[path]
        line = _circ_smooth(ledge[None, :], Q['hemLineSmooth'] / deg)[0]
        # foot of the ledge: walking down from the ledge line, the first level where the surface no
        # longer steps outward (the bottom of the groove under the sleeve's edge)
        Sf = o['slopeFine']
        foot = np.empty(bins)
        for k in range(bins):
            i = int(np.argmin(np.abs(ts - line[k])))
            while i > 0 and Sf[i - 1, k] > Sf[i, k] and ts[i] > line[k] - 0.003:  # the ledge's own steepest level
                i -= 1
            # down the ledge while its slope falls: a glove fold whose flank runs into the ledge from
            # below makes the slope rise again, and the foot is where that happens (or where it is 0)
            while i > 0 and Sf[i, k] > 0.0 and Sf[i - 1, k] <= Sf[i, k] + 1e-3 and ts[i] > line[k] - Q['footSearch']:
                i -= 1
            foot[k] = ts[i]
        # fade-out on the ledge's lower part, between the groove bottom and the ledge line: the
        # surface there rises into the ledge, so the faired glove below meets it with a concave
        # turn (a clean crease under the sleeve's edge) instead of riding over a leftover fold flank
        end = foot + Q['hemFootFrac'] * (line - foot)
        end = _circ_smooth(_circ_erode(end, round(Q['hemErode'] / deg))[None, :], Q['hemLineSmooth'] / deg)[0] - Q['hemGap']
        foot = _circ_smooth(foot[None, :], Q['hemLineSmooth'] / deg)[0]
        o.update({'ledge': ledge, 'line': line, 'foot': foot, 'end': end, 'slope': o['slopeField'][path, np.arange(bins)], 'shared': shared})
    return out


def _lookup(theta_deg, line_theta, line):
    """C1 periodic interpolation of a per-direction line (samples at the bin centres line_theta, uniform
    from -180 deg) at angles theta_deg."""
    deg = 360.0 / len(line)
    return _cubic1d(np.asarray(line, float), (np.asarray(theta_deg, float) + 180.0) / deg - 0.5, periodic=True)


# ---------------------------------------------------------------- the step

def step_cuffs(mesh, X, P, masks):
    Q = _par(P)
    Y = X.copy()
    info = {'params': Q}
    bins = int(Q['bins'])
    hands, frames = {}, {}
    for side in ('R', 'L'):
        h = hu.hand(mesh, side, X)
        hands[side] = h
        fa, e1, e2 = hu.forearm_frame(h)  # toward the hand, palm-side normal, thumb side
        frames[side] = (h['wrist'], fa, e1, e2)
    # ---- the sleeve hem of both arms (shared course, per-arm refinement) -> fade-out lines
    hems = hem_lines(mesh, X, frames, Q)
    for side in ('R', 'L'):
        h = hands[side]
        w, fa, e1, e2 = frames[side]
        up = -fa
        t_all = (X - w) @ up
        hem = hems.get(side)
        if hem is None:
            log(f'cuff {side}: no hem found, fade-out at the constant level {Q["hemFallback"]}')
            hem_theta = np.array([-180.0, 0.0])
            t_end_line = np.full(2, Q['hemFallback'])
            ax = np.zeros((2, 2))
        else:
            hem_theta, t_end_line, ax = hem['theta'], hem['end'], hem['axis']
        # direction of every vertex about the straight forearm axis, and its fade-out level
        rel_ax = X - w - np.outer(t_all, up) - np.outer(ax[0, 0] + ax[0, 1] * t_all, e1) - np.outer(ax[1, 0] + ax[1, 1] * t_all, e2)
        th_all = np.degrees(np.arctan2(rel_ax @ e2, rel_ax @ e1))
        # ---- zone: the arm's own surface in the slab around the cuff, near the bone line
        lo, hi = -Q['maskBelow'] - 0.004, float(t_end_line.max()) + 0.004
        rel = X - w - np.outer(t_all, up)
        near = (t_all > lo) & (t_all < hi) & (np.linalg.norm(rel, axis=1) < Q['radius'])
        seed = int(np.argmin(np.where(near, np.abs(t_all - 0.03) + np.linalg.norm(rel, axis=1), np.inf)))
        zone = mesh.component(seed, near)
        ids = np.nonzero(zone)[0]
        tz = t_all[ids]
        u_end = _lookup(th_all[ids], hem_theta, t_end_line) - tz  # distance below the fade-out line along t
        # ---- low-pass weight: palm side ramp, gauntlet plateau, fade below the hem, thumb guard
        m = smoothstep((tz + Q['maskBelow']) / Q['maskRamp']) * smoothstep(u_end / Q['hemTaper'])
        thumb_ids = h['fingers']['Thumb']['ids']
        if Q['thumbGuard'] > 0:
            dth = mesh.dijkstra(thumb_ids, dmax=Q['thumbGuard'] * 1.5)
            m *= smoothstep(dth[ids] / Q['thumbGuard'])
        for name in hu.DIGITS:  # never move a digit
            m[np.isin(ids, h['fingers'][name]['ids'])] = 0.0
        act = m > 1e-6
        a_ids, a_m = ids[act], m[act]
        # (a) isotropic screen, (b) normal-only screen (fold walls' vertices spread), (c) cotangent polish
        Z = Y.copy()
        Z[a_ids], it, res = lowpass(mesh, Y, a_ids, a_m, Q['cutoff'], Q['pinRatio'], Q['cgTol'], int(Q['cgMaxIter']),
                                    Q['uniformWeights'])
        cg = [[it, res]]
        for _ in range(int(Q['normalPasses']) if Q['tanScreen'] < 1.0 else 0):
            Nz = _smooth_normals(mesh, Z, a_ids, int(Q['normalSmooth']))
            Z[a_ids], it, res = lowpass(mesh, Y, a_ids, a_m, Q['cutoff'], Q['pinRatio'], Q['cgTol'], int(Q['cgMaxIter']),
                                        Q['uniformWeights'], normals=Nz, tan_screen=Q['tanScreen'], x_init=Z[a_ids])
            cg.append([it, res])
        if Q['polishCutoff'] > 0:
            Z[a_ids], it, res = lowpass(mesh, Z, a_ids, a_m, Q['polishCutoff'], Q['pinRatio'], Q['cgTol'], int(Q['cgMaxIter']), cotan=True)
            cg.append([it, res])
        log(f'cuff {side}: low-pass {len(a_ids)} verts, CG iterations/residual {[[i, float(f"{r:.1e}")] for i, r in cg]},'
            f' max move {np.linalg.norm(Z[a_ids] - Y[a_ids], axis=1).max() * 1000:.1f} mm')
        tp = np.round(np.arange(-0.01, 0.1001, 0.005), 4)
        hem_info = {}
        if hem is not None:
            dirs = list(range(-180, 180, 45))
            pick = [int(np.argmin(np.abs(((hem_theta - a) + 180) % 360 - 180))) for a in dirs]
            hem_info = {'theta_deg': dirs,
                        'ledge_cm': [round(float(hem['line'][k]) * 100, 2) for k in pick],
                        'foot_cm': [round(float(hem['foot'][k]) * 100, 2) for k in pick],
                        'fadeOut_cm': [round(float(t_end_line[k]) * 100, 2) for k in pick],
                        'slope': [round(float(hem['slope'][k]), 2) for k in pick],
                        'shared_cm': None if hem['shared'] is None else [round(float(hem['shared'][k]) * 100, 2) for k in pick],
                        'fadeOutRange_cm': [round(float(t_end_line.min()) * 100, 2), round(float(t_end_line.max()) * 100, 2)],
                        'line_theta_deg': [float(v) for v in hem_theta], 'ledge_m': [float(v) for v in hem['line']],
                        'foot_m': [float(v) for v in hem['foot']], 'fadeOut_m': [float(v) for v in t_end_line], 'axis': ax.tolist(),
                        'frame': [np.asarray(v, float).tolist() for v in (w, fa, e1, e2)]}
        if not Q['slim']:
            Y[a_ids] = Z[a_ids]
            mask = np.zeros(mesh.n, bool)
            mask[a_ids] = True
            masks[f'cuff_{side}'] = mask
            info[side] = {'lowpassVertices': int(len(a_ids)), 'cg': cg, 'hem': hem_info,
                          'profile_t_width_thick_area': {'before': profile(mesh, X, w, fa, e1, e2, tp), 'after': profile(mesh, Y, w, fa, e1, e2, tp)}}
            continue
        # ---- slimming: radial scale about the low-passed sections' centroids toward the glove top ring
        dt = Q['dt']
        ts = np.arange(Q['start'] - dt, float(t_end_line.max()) + 2 * dt, dt)
        C, R, ok = _sections(mesh, Z, w, fa, e1, e2, ts, bins, int(Q['envDensify']))
        if C is None:
            log(f'cuff {side}: no closed sections, low-pass only')
            Y[a_ids] = Z[a_ids]
            mask = np.zeros(mesh.n, bool)
            mask[a_ids] = True
            masks[f'cuff_{side}'] = mask
            info[side] = {'skipped': 'no sections', 'hem': hem_info}
            continue
        C = _line_smooth(C, 2.0)
        R = _circ_smooth(_line_smooth(R, Q['envSmoothT'] / dt), Q['envSmoothDeg'] / (360.0 / bins))
        bin_theta = -180.0 + (np.arange(bins) + 0.5) * 360.0 / bins  # _polar's bin centres (deg)
        # fade-out level per slimming direction (about the section centroids; near the hem they sit on the axis)
        t_end_b = _lookup(bin_theta, hem_theta, t_end_line)
        R_f = _bicubic(R, (t_end_b - ts[0]) / dt, np.arange(bins, dtype=float))  # the glove's top ring
        R_f = _circ_smooth(R_f[None, :], Q['refSmooth'] / (360.0 / bins))[0]
        t_c = float(t_end_line.min())
        c_f = np.array([_cubic1d(C[:, k], (t_c - ts[0]) / dt) for k in range(2)])
        tq = (Z[ids] - w) @ up
        relq = Z[ids] - w - np.outer(tq, up)
        q2 = np.stack([relq @ e1, relq @ e2], axis=1)
        ti = (tq - ts[0]) / dt
        cq = np.stack([_cubic1d(C[:, k], ti) for k in range(2)], axis=1)
        d2 = q2 - cq
        ang = np.arctan2(d2[:, 1], d2[:, 0])
        aj = (ang + math.pi) / (2 * math.pi) * bins - 0.5
        Rq = _bicubic(R, ti, aj)
        Rf = _cubic1d(R_f, aj, periodic=True)
        t_endq = _cubic1d(t_end_b, aj, periodic=True)
        t_fil = Q['start'] + Q['fillet']
        ramp_in = smootherstep((tq - Q['start']) / Q['fillet'])
        beta = ramp_in * smootherstep((t_endq - tq) / Q['slimTaper'])
        gamma = ramp_in * smootherstep((t_c - tq) / Q['slimTaper'])
        kq = Q['waistRatio'] + (1 - Q['waistRatio']) * smootherstep((tq - t_fil) / np.maximum(t_endq - t_fil, 1e-3))
        s = 1 - beta + beta * kq * Rf / np.maximum(Rq, 1e-4)
        s = np.clip(s, Q['scaleMin'], Q['scaleMax'])
        new2 = cq + (Q['centreShift'] * gamma)[:, None] * (c_f - cq) + s[:, None] * d2
        Ynew = w + np.outer(tq, up) + np.outer(new2[:, 0], e1) + np.outer(new2[:, 1], e2) + (relq - np.outer(q2[:, 0], e1) - np.outer(q2[:, 1], e2))
        # vertices the low-pass left in place and the slimming does not touch keep their exact position
        still = (np.linalg.norm(Z[ids] - X[ids], axis=1) == 0) & (beta == 0) & (gamma == 0)
        Y[ids] = np.where(still[:, None], X[ids], Ynew)
        moved = np.linalg.norm(Y[ids] - X[ids], axis=1) > 1e-7
        mask = np.zeros(mesh.n, bool)
        mask[ids[moved]] = True
        masks[f'cuff_{side}'] = mask
        # ---- report: hem, width profile along the bone line, fold relief, moves at / above the fade-out line
        before = profile(mesh, X, w, fa, e1, e2, tp)
        after = profile(mesh, Y, w, fa, e1, e2, tp)
        core = a_m > 0.99
        rel_b, rel_a = relief(mesh, X, a_ids, core), relief(mesh, Y, a_ids, core)
        mv = np.linalg.norm(Y - X, axis=1)
        digits = np.zeros(mesh.n, bool)
        for name in hu.DIGITS:
            digits[h['fingers'][name]['ids']] = True
        hand = h['region'] & (t_all < -Q['maskBelow'])
        arm_near = np.linalg.norm(rel, axis=1) < Q['radius']
        u_all = _lookup(th_all, hem_theta, t_end_line) - t_all
        kept = arm_near & (u_all <= 0) & (t_all < 0.15)
        bands = {f'{a}-{a + 1}cm': round(float(mv[arm_near & (t_all >= a / 100) & (t_all < (a + 1) / 100)].max(initial=0) * 1000), 2)
                 for a in range(4, 10)}
        bands_rel = {f'{a}..{a + 5}mm below fade-out': round(float(mv[arm_near & (u_all > a / 1000) & (u_all <= (a + 5) / 1000)].max(initial=0) * 1000), 2)
                     for a in (0, 5, 10, 15)}
        info[side] = {'vertices': int(mask.sum()), 'lowpassVertices': int(len(a_ids)), 'cg': cg, 'hem': hem_info,
                      'untouched_maxMove_mm': {'hand below -maskBelow': float(mv[hand].max() * 1000) if hand.any() else 0.0,
                                               'digits': float(mv[digits].max() * 1000),
                                               'at/above fade-out line (hem, sleeve)': float(mv[kept].max(initial=0) * 1000)},
                      'maxMove_mm_by_level': bands, 'maxMove_mm_below_fadeout': bands_rel,
                      'gloveTop': {'t_c': t_c, 'centre_cm': [round(float(v) * 100, 2) for v in c_f],
                                   'width_cm': round(float((R_f[0] + R_f[bins // 2]) * 100), 2)},
                      'scaleRange': [float(s[beta > 0.01].min()) if (beta > 0.01).any() else 1.0, float(s.max())],
                      'maxMove_mm': float(np.linalg.norm(Y[ids] - X[ids], axis=1).max() * 1000),
                      'relief_rms_p95_max_mm': {'before': rel_b, 'after': rel_a},
                      'profile_t_width_thick_area': {'before': before, 'after': after}}

        def at(prof, lo_, hi_, k):
            v = [p[k] for p in prof if p[k] is not None and lo_ - 1e-9 <= p[0] <= hi_ + 1e-9]
            return (min(v), max(v)) if v else (float('nan'), float('nan'))
        sel_t = (.02, .03, .04, .05, .06)
        log(f"cuff {side}: {int(mask.sum())} verts, hem ledge {hem_info.get('ledge_cm')} cm, fade-out {hem_info.get('fadeOutRange_cm')} cm,"
            f" width t=1-5 cm {at(before, .01, .05, 1)[1]:.1f}->{at(after, .01, .05, 1)[1]:.1f} max,"
            f" t=2/3/4/5/6 cm {[p[1] for p in before if p[0] in sel_t]}->{[p[1] for p in after if p[0] in sel_t]},"
            f" relief rms/p95/max {rel_b}->{rel_a} mm, max move {info[side]['maxMove_mm']:.1f} mm,"
            f" at/above fade-out {info[side]['untouched_maxMove_mm']['at/above fade-out line (hem, sleeve)']:.3f} mm")
    return Y, info
