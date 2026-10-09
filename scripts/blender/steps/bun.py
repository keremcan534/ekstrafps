"""Rear hair bun removal: thin-plate refill of the bun's footprint, found on the mesh itself.

1. Detect: master_checks.bun() finds the bump on the back-of-head midline profile; its apex is the
   rearmost midline vertex at that height.
2. Skull estimate: a geodesic disc around the apex is refilled with a thin-plate (bilaplacian)
   surface whose boundary rings keep position and slope. The disc grows until the refilled midline
   profile stops changing (the boundary then lies on bump-free skull and neck, not on the bun's skirt).
3. Footprint: the bun is the connected set of vertices standing more than `footprintMm` proud of that
   skull estimate (heights low-passed first, so single hair curls do not count).
4. Refill: the patch is the footprint grown by a geodesic margin; it is refilled again (on a lightly
   low-passed copy of the surface, so hair noise in the boundary rings does not ripple into the fill)
   and blended in with a smooth weight that is 1 over the footprint and its first `fullMargin` and fades
   to 0 at the patch edge, so the hair texture outside fades out instead of ending at a seam.
5. Verify: if the midline profile still shows a bump above `targetProminence`, the margin grows.

Everything is a smooth, monotone deformation of the existing vertices (no projection, no topology
change); the bun's surplus vertices are spread over the footprint by the thin-plate solve.
"""
import numpy as np

import master_checks as mc
from steps.common import log, smoothstep


# ---------------------------------------------------------------- thin-plate solve

class Fair:
    """Thin-plate fill of the `unknown` vertices: minimise sum |L X|^2 over every Laplacian row that
    touches an unknown vertex (uniform umbrella L), the other vertices fixed. The rows of the first
    ring outside reach the second ring, so the fill keeps position and slope (C1) at its boundary.
    Solved exactly (dense Cholesky of the normal equations) up to `dense_max` unknowns, else by
    Jacobi-preconditioned conjugate gradients."""

    def __init__(self, mesh, unknown):
        self.mesh = mesh
        U = np.nonzero(unknown)[0]
        rows = np.nonzero(mesh.grow(unknown, 1))[0]
        uidx = -np.ones(mesh.n, np.int64)
        uidx[U] = np.arange(len(U))
        cnt = mesh.deg[rows]
        k = np.repeat(np.arange(len(rows)), cnt)
        start = np.repeat(mesh.indptr[rows], cnt)
        off = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        j = mesh.nbr[start + off]
        w = 1.0 / cnt[k]
        # entries (row, vertex, weight): neighbours with 1/deg, the centre with -1
        self.k = np.concatenate([k, np.arange(len(rows))])
        self.j = np.concatenate([j, rows])
        self.w = np.concatenate([w, -np.ones(len(rows))])
        self.U, self.rows, self.uidx = U, rows, uidx
        isu = uidx[self.j] >= 0
        self.ku, self.cu, self.wu = self.k[isu], uidx[self.j[isu]], self.w[isu]
        self.kk, self.jk, self.wk = self.k[~isu], self.j[~isu], self.w[~isu]

    def _const(self, X):
        c = np.zeros((len(self.rows), 3))
        for d in range(3):
            c[:, d] = np.bincount(self.kk, self.wk * X[self.jk, d], minlength=len(self.rows))
        return c

    def solve(self, X, dense_max=9000, tol=1e-9, max_iter=20000):
        nU, nR = len(self.U), len(self.rows)
        c = self._const(X)
        ku, cu, wu = self.ku, self.cu, self.wu
        # b = -A^T c
        b = np.zeros((nU, 3))
        for d in range(3):
            b[:, d] = -np.bincount(cu, wu * c[ku, d], minlength=nU)
        Y = X.copy()
        if nU <= dense_max:
            # Normal matrix A^T A from the rows' outer products.
            order = np.argsort(ku, kind='stable')
            ks, cs, ws = ku[order], cu[order], wu[order]
            starts = np.searchsorted(ks, np.arange(nR))
            ends = np.searchsorted(ks, np.arange(nR), side='right')
            M = np.zeros((nU, nU))
            Mf = M.ravel()
            lens = ends - starts
            for m in np.unique(lens):
                if m == 0:
                    continue
                rs = np.nonzero(lens == m)[0]
                idx = starts[rs][:, None] + np.arange(m)[None, :]
                C, W = cs[idx], ws[idx]
                pi = (C[:, :, None] * nU + C[:, None, :]).ravel()
                pv = (W[:, :, None] * W[:, None, :]).ravel()
                np.add.at(Mf, pi, pv)
            Lc = np.linalg.cholesky(M)
            z = np.linalg.solve(Lc, b)
            Y[self.U] = np.linalg.solve(Lc.T, z)
            self.iterations = 0
            return Y

        def A(x):
            return np.stack([np.bincount(ku, wu * x[cu, d], minlength=nR) for d in range(3)], axis=1)

        def At(y):
            return np.stack([np.bincount(cu, wu * y[ku, d], minlength=nU) for d in range(3)], axis=1)

        diag = np.bincount(cu, wu * wu, minlength=nU)[:, None]
        x = X[self.U].copy()
        r = b - At(A(x))
        zr = r / diag
        p = zr.copy()
        rz = (r * zr).sum(axis=0)
        bn = np.linalg.norm(b, axis=0) + 1e-30
        it = 0
        for it in range(max_iter):
            Ap = At(A(p))
            alpha = rz / np.maximum((p * Ap).sum(axis=0), 1e-30)
            x += p * alpha
            r -= Ap * alpha
            if (np.linalg.norm(r, axis=0) / bn).max() < tol:
                break
            zr = r / diag
            rz_new = (r * zr).sum(axis=0)
            p = zr + p * (rz_new / np.maximum(rz, 1e-30))
            rz = rz_new
        self.iterations = it + 1
        Y[self.U] = x
        return Y


def fill(mesh, X, unknown, P):
    return Fair(mesh, unknown).solve(X, dense_max=P.get('denseMax', 9000))


# ---------------------------------------------------------------- helpers

def profile_on(mesh, X, z_lo, z_hi):
    zs, ys = mc.back_profile(mesh, X)
    sel = (zs >= z_lo) & (zs <= z_hi)
    return zs[sel], ys[sel]


def lowpass(mesh, X, region, iterations):
    """Taubin low-pass of the region (soft-edged so nothing outside moves)."""
    if iterations <= 0:
        return X.copy()
    m = region.astype(float)
    for _ in range(3):
        m = np.maximum(m, mesh.umbrella(m[:, None])[:, 0])
    return mesh.taubin(X, m, iterations)


def smooth_scalar(mesh, f, region, iterations):
    f = f.copy()
    for _ in range(iterations):
        f = np.where(region, mesh.umbrella(f[:, None])[:, 0], f)
    return f


# ---------------------------------------------------------------- step

def step_bun(mesh, X, P, masks):
    b = mc.bun(mesh, X)
    if b['prominence'] < P['minProminence']:
        log(f"bun: none (prominence {b['prominence'] * 1000:.1f} mm)")
        return X, {'found': False, 'prominence': b['prominence']}
    zp = b['z']
    H = mesh.height
    mid = (np.abs(X[:, 0]) < 0.008 * H / 1.9) & (np.abs(X[:, 2] - zp) < 0.003 * H / 1.9)
    apex = int(np.argmax(np.where(mid, X[:, 1], -np.inf)))
    # Work region: the head and neck around the bun (bounds every distance / smoothing below).
    work = np.linalg.norm(X - X[apex], axis=1) < P.get('workRadius', 0.16)
    geo = mesh.dijkstra(apex, allowed=work, dmax=P.get('maxDiscRadius', 0.11) + 0.01)
    zwin = (zp - 0.10, zp + 0.10)

    # 2. Skull estimate: grow a geodesic disc until the refilled midline profile settles.
    Xs = lowpass(mesh, X, work, P.get('lowpassIterations', 8))
    r = P.get('discStart', 0.045)
    prev, est, trace = None, None, []
    while True:
        disc = geo < r
        Y = fill(mesh, Xs, disc, P)
        zs, ys = profile_on(mesh, Y, *zwin)
        change = None if prev is None else float(np.abs(np.interp(zs, prev[0], prev[1]) - ys).max())
        trace.append({'radius': r, 'vertices': int(disc.sum()), 'prominence': mc.bun(mesh, Y)['prominence'], 'change': change})
        log(f"bun: skull disc r {r * 100:.1f} cm ({int(disc.sum())} verts): profile change "
            f"{'-' if change is None else f'{change * 1000:.2f} mm'}, prominence {trace[-1]['prominence'] * 1000:.1f} mm")
        est = Y
        if change is not None and change < P.get('settleMm', 1.0) / 1000:
            break
        if r >= P.get('maxDiscRadius', 0.11) - 1e-9:
            break
        prev = (zs, ys)
        r = min(r + P.get('discStep', 0.01), P.get('maxDiscRadius', 0.11))

    # 3. Footprint: vertices standing proud of the skull estimate.
    N = mesh.normals(est)
    h = ((X - est) * N).sum(axis=1)
    h = np.where(disc, h, 0.0)
    h = smooth_scalar(mesh, h, disc, P.get('heightSmooth', 6))
    proud = disc & (h > P.get('footprintMm', 2.0) / 1000)
    foot = mesh.component(apex, proud) if proud[apex] else proud

    # 4./5. Refill footprint + margin, blend, grow the margin until the profile is clean.
    full, blend = P.get('fullMargin', 0.008), P.get('blendMargin', 0.012)
    target = P.get('targetProminence', 0.0015)
    out = None
    for attempt in range(P.get('maxAttempts', 4)):
        dist = mesh.dijkstra(np.nonzero(foot)[0], allowed=work, dmax=full + blend + 0.005)
        patch = dist < full + blend
        Yf = fill(mesh, Xs, patch, P)
        s = 1.0 - smoothstep((dist - full) / blend)
        s = np.where(patch, s, 0.0)
        Z = X + s[:, None] * (Yf - X)
        pr = mc.bun(mesh, Z)['prominence']
        log(f"bun: footprint {int(foot.sum())} verts + margin {full * 100:.1f}+{blend * 100:.1f} cm -> patch {int(patch.sum())} verts,"
            f" prominence {pr * 1000:.2f} mm")
        out = (Z, patch, s, full, blend, pr)
        if pr <= target:
            break
        full += P.get('marginStep', 0.004)
    Z, patch, s, full, blend, pr = out
    masks['bun'] = patch
    moved = np.linalg.norm(Z - X, axis=1)
    info = {'found': True, 'prominence': b['prominence'], 'z': zp, 'apex': [float(v) for v in X[apex]],
            'skullDisc': trace, 'footprintVertices': int(foot.sum()), 'footprintMaxHeightMm': float(h[foot].max() * 1000) if foot.any() else 0.0,
            'fullMargin': full, 'blendMargin': blend, 'patchVertices': int(patch.sum()),
            'maxMove': float(moved.max()), 'prominenceAfter': pr}
    log(f"bun: {b['prominence'] * 1000:.1f} mm at z {zp:.3f} -> {pr * 1000:.2f} mm; patch {int(patch.sum())} verts,"
        f" max move {moved.max() * 1000:.1f} mm")
    return Z, info
