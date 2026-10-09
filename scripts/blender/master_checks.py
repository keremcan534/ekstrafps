"""Gate measurements for the master humanoid, shared by the cleanup, remesh and rig steps.

measure(mesh) -> dict of the properties the master must keep (the brief's acceptance list):
five digits per hand (persistence), finger gaps and widths, wrist angles, arm angle, elbow bend,
palm/thumb orientation, arm-torso clearance, mirror symmetry, bun prominence, manifoldness.
gate(before, after, cfg) -> [(name, ok, detail)].
"""
import math

import numpy as np
from mathutils import Vector, bvhtree, kdtree

import humanoid as hu


def kd_tree(P):
    t = kdtree.KDTree(len(P))
    for i, p in enumerate(P):
        t.insert(p, i)
    t.balance()
    return t


def nearest(tree, P):
    return np.array([tree.find(p)[2] for p in P])


def symmetry(mesh, X, n=20000):
    """Mean / 95th percentile distance of mirrored vertices to the surface's vertices (% height)."""
    rng = np.random.default_rng(7)
    ids = rng.choice(mesh.n, size=min(n, mesh.n), replace=False)
    t = kd_tree(X)
    M = X[ids] * np.array([-1.0, 1.0, 1.0])
    d = nearest(t, M) / mesh.height * 100
    return {'mean': float(d.mean()), 'p95': float(np.percentile(d, 95))}


def back_profile(mesh, X):
    """Back-of-head midline profile: for each height, the rearmost point (+Y is back)."""
    H, z0 = mesh.height, mesh.floor
    mid = np.abs(X[:, 0]) < 0.008 * H / 1.9
    zs, ys = [], []
    for z in np.arange(z0 + 0.84 * H, z0 + 0.99 * H, 0.004 * H / 1.9):
        sel = mid & (np.abs(X[:, 2] - z) < 0.003 * H / 1.9)
        if sel.sum():
            zs.append(z)
            ys.append(X[sel, 1].max())
    return np.array(zs), np.array(ys)


def bun(mesh, X):
    """A bun is an extra maximum of the back-of-head profile below the occiput: a normal skull rises
    from the neck to one maximum (the occiput) and falls to the crown. Returns the largest
    prominence (m) of such a lower maximum over the dip above it (0 = clean skull) and its height."""
    zs, ys = back_profile(mesh, X)
    if len(zs) < 10:
        return {'prominence': 0.0, 'z': None}
    top = len(zs) - int(0.04 * mesh.height / (0.004 * mesh.height / 1.9))  # ignore the crown
    k_neck = int(np.argmin(ys[: top // 2]))
    maxima = [k for k in range(k_neck + 1, top - 1) if ys[k] >= ys[k - 1] and ys[k] >= ys[k + 1]]
    best = (0.0, None)
    for k in maxima:
        above = [m for m in maxima if m > k]
        if not above:
            continue  # the topmost maximum is the occiput
        occ = max(above, key=lambda m: ys[m])
        prom = float(ys[k] - ys[k:occ + 1].min())  # over the dip between it and the occiput
        if prom > best[0]:
            best = (prom, float(zs[k]))
    return {'prominence': best[0], 'z': best[1]}


def topology(mesh):
    T = mesh.T
    e = np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e[:, 0] * mesh.n + e[:, 1], return_counts=True)
    return {'boundary': int((counts == 1).sum()), 'nonManifold': int((counts > 2).sum())}


def self_intersections(mesh, X, mask):
    """Triangle pairs that intersect without sharing a vertex, among triangles touching mask."""
    tris = np.nonzero(mask[mesh.T].any(axis=1))[0]
    if len(tris) == 0:
        return 0
    polys = mesh.T[tris].tolist()
    tree = bvhtree.BVHTree.FromPolygons([Vector(p) for p in X], polys, all_triangles=True)
    count = 0
    for a, b in tree.overlap(tree):
        if a < b and not (set(polys[a]) & set(polys[b])):
            count += 1
    return count


def finger_sets(h):
    """Vertex ids of each digit past its web (+1.2 cm), to measure gaps on the same vertices later."""
    F, d = h['fingers'], h['d']
    return {n: F[n]['ids'][d[F[n]['ids']] > F[n]['web'] + 0.012] for n in F}


def finger_gaps(mesh, X, sets):
    """Smallest distance between neighbouring digits, past their webs (m)."""
    out = {}
    for a, b in (('Thumb', 'Index'), ('Index', 'Middle'), ('Middle', 'Ring'), ('Ring', 'Pinky')):
        A, Bi = sets[a], sets[b]
        if len(A) == 0 or len(Bi) == 0:
            out[f'{a}-{b}'] = 0.0
            continue
        t = kd_tree(X[Bi])
        out[f'{a}-{b}'] = float(nearest(t, X[A]).min())
    return out


def finger_widths(mesh, X, h):
    """Mean width of each digit's section at mid-length (m)."""
    out = {}
    for name, f in h['fingers'].items():
        c = f['centre']
        if len(c) < 4:
            continue
        i = len(c) // 2
        a = hu._unit(c[max(i - 1, 0)] - c[min(i + 1, len(c) - 1)])
        sec = hu.section(mesh, c[i], a, c[i], 0.02, X)
        if sec and sec['closed']:
            out[name] = float((sec['width'] + sec['thick']) / 2)
    return out


def arm_side(mesh, X, side, ref=None):
    h = hu.hand(mesh, side, X)
    sets = ref['sets'] if ref else finger_sets(h)
    line = h['arm_line']
    flex, dev = hu.wrist_angles(h)
    w, e = h['wrist'], h['elbow_est']
    P, arc = line['points'], line['arc']
    ke = int(np.argmin(np.linalg.norm(P - e, axis=1)))
    upper = P[(arc > arc[ke] + 0.03) & (arc < arc[-1] - 0.02)]
    elbow_bend = None
    arm_angle = None
    if len(upper) >= 4:
        c0, ud = hu.line_fit(upper)
        ud = hu._unit(ud if ud @ (e - c0) > 0 else -ud)  # shoulder -> elbow
        elbow_bend = hu.angle(ud, h['forearm_dir'])
        top = c0 + ud * ((P[-1] - c0) @ ud)
        arm_angle = hu.angle(w - top, [0, 0, -1])
    sign = hu.SIDES[side]
    medial = np.array([-sign, 0.0, 0.0])
    pn = h['palm_normal'] * np.array([1, 1, 0])
    th = h['thumb_dir'] * np.array([1, 1, 0])
    # Clearance: arm vertices (geodesically before the armpit) vs the rest of the body.
    d = line['d']
    cut = line['dEnd'] - 0.12 * mesh.height
    arm = np.nonzero(np.isfinite(d) & (d < cut))[0]
    rest = np.nonzero(~np.isfinite(d) | (d > line['dEnd'] + 0.1 * mesh.height))[0]
    t = kd_tree(X[rest])
    clearance = float(nearest(t, X[arm]).min())
    h['sets'] = sets
    return h, {
        'digits': len([p for p, v in h['persistence'] if p == -1 or p >= 0.015]),
        'persistence': [round(p, 4) for p, v in h['persistence'][:6]],
        'wristFlexDeg': flex,
        'wristDevDeg': dev,
        'elbowBendDeg': elbow_bend,
        'armAngleDeg': arm_angle,
        'palmMedialDeg': hu.angle(pn, medial),
        'thumbForwardDeg': hu.angle(th, hu.FWD),
        'clearance': clearance,
        'fingerGaps': finger_gaps(mesh, X, sets),
        'fingerWidths': finger_widths(mesh, X, h),
        'wrist': [float(v) for v in w],
    }


def measure(mesh, X=None, ref_hands=None):
    """ref_hands: the hands of an earlier measure() of the same topology, so finger gaps are taken on
    the same vertices."""
    X = mesh.V if X is None else X
    out = {'height': mesh.height, 'vertices': mesh.n, 'triangles': int(len(mesh.T))}
    out['topology'] = topology(mesh)
    out['symmetry'] = symmetry(mesh, X)
    out['bun'] = bun(mesh, X)
    hands = {}
    for side in ('R', 'L'):
        h, m = arm_side(mesh, X, side, ref_hands[side] if ref_hands else None)
        out[side] = m
        hands[side] = h
    return out, hands


def gate(before, after, cfg):
    """Checks of the cleaned mesh against the source (and absolute limits from cfg)."""
    res = []

    def check(name, ok, detail):
        res.append((name, bool(ok), detail))

    for side in ('R', 'L'):
        b, a = before[side], after[side]
        p5 = a['persistence'][4] if len(a['persistence']) > 4 else 0
        p6 = a['persistence'][5] if len(a['persistence']) > 5 else 0
        check(f'{side} five digits', a['digits'] == cfg['digits'] and p5 >= cfg['minDigitPersistence'] and p6 < 0.5 * p5,
              f"digits {a['digits']}, 5th {p5:.3f} m, 6th {p6:.3f} m")
        gaps_ok = all(a['fingerGaps'][k] >= 0.9 * b['fingerGaps'][k] - 1e-4 for k in b['fingerGaps'])
        check(f'{side} finger separation', gaps_ok,
              ', '.join(f"{k} {b['fingerGaps'][k] * 1000:.1f}->{a['fingerGaps'][k] * 1000:.1f} mm" for k in b['fingerGaps']))
        check(f'{side} wrist straight', abs(a['wristFlexDeg']) <= cfg['maxWristDeg'] and abs(a['wristDevDeg']) <= cfg['maxWristDeg'],
              f"flex {b['wristFlexDeg']:.1f}->{a['wristFlexDeg']:.1f}, dev {b['wristDevDeg']:.1f}->{a['wristDevDeg']:.1f} deg")
        check(f'{side} arm angle kept', abs(a['armAngleDeg'] - b['armAngleDeg']) <= cfg['maxArmAngleChangeDeg'],
              f"{b['armAngleDeg']:.1f}->{a['armAngleDeg']:.1f} deg")
        check(f'{side} elbow straight', a['elbowBendDeg'] <= cfg['maxElbowBendDeg'],
              f"{b['elbowBendDeg']:.1f}->{a['elbowBendDeg']:.1f} deg")
        check(f'{side} palm faces thigh', a['palmMedialDeg'] <= cfg['maxPalmMedialDeg'],
              f"{b['palmMedialDeg']:.1f}->{a['palmMedialDeg']:.1f} deg from medial")
        check(f'{side} thumb forward', a['thumbForwardDeg'] <= cfg['maxThumbForwardDeg'],
              f"{b['thumbForwardDeg']:.1f}->{a['thumbForwardDeg']:.1f} deg from forward")
        check(f'{side} torso clearance', a['clearance'] >= cfg['minClearanceRatio'] * b['clearance'],
              f"{b['clearance'] * 1000:.1f}->{a['clearance'] * 1000:.1f} mm")
    check('symmetry', after['symmetry']['mean'] <= before['symmetry']['mean'] + cfg['maxSymmetryIncreasePct'],
          f"mean {before['symmetry']['mean']:.3f}->{after['symmetry']['mean']:.3f} % height")
    check('no bun', after['bun']['prominence'] <= cfg['maxBunProminence'],
          f"prominence {before['bun']['prominence'] * 1000:.1f}->{after['bun']['prominence'] * 1000:.1f} mm")
    check('manifold', after['topology'] == before['topology'], f"{before['topology']} -> {after['topology']}")
    return res
