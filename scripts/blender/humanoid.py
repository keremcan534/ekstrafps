"""Mesh analysis shared by the master-humanoid Blender scripts (bpy + numpy, no other deps).

Coordinates are Blender's after a glTF import: Z up, the character faces -Y, its RIGHT side is -X.
Lengths are metres. Everything is found on the mesh itself (no hand-picked vertex ids), so the same
code measures the source, the cleaned mesh and the remeshed one:

  arm(mesh, side)     cross-sections marched from the hand to the armpit: centreline, radii, axis
  hand(mesh, side)    the digits by geodesic persistence (distance from a ring across the forearm
                      peaks at the fingertips; each digit is its own region until it meets the palm
                      at its web), finger centrelines, knuckles, wrist pivot, palm frame
"""
import heapq
import math

import bmesh
import bpy
import numpy as np

UP = np.array([0.0, 0.0, 1.0])
FWD = np.array([0.0, -1.0, 0.0])  # the character faces -Y
SIDES = {'R': -1.0, 'L': 1.0}  # sign of X on that side
DIGITS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')


# ---------------------------------------------------------------- scene / io

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    """Import a GLB and join its meshes into one object with applied transforms."""
    clear_scene()
    # merge_vertices: glTF stores a vertex per UV / normal seam; welding them back keeps the surface
    # one connected manifold (geodesics, sections and landmarks need that) while the UVs stay on the loops.
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in bpy.context.scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in list(bpy.context.scene.objects):
        if o is not obj and o.type != 'MESH':
            bpy.data.objects.remove(o)
    return obj


def export_glb(obj, path):
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_apply=True, export_yup=True)


# ---------------------------------------------------------------- mesh arrays

class Mesh:
    """Vertex / triangle / edge arrays of a Blender mesh plus a CSR adjacency with edge lengths."""

    def __init__(self, obj):
        me = obj.data
        n = len(me.vertices)
        V = np.empty(n * 3)
        me.vertices.foreach_get('co', V)
        self.V = V.reshape(n, 3)
        me.calc_loop_triangles()
        T = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get('vertices', T)
        self.T = T.reshape(-1, 3)
        E = np.empty(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get('vertices', E)
        self.E = E.reshape(-1, 2)
        self.n = n
        self._csr()

    def _csr(self):
        a, b = self.E[:, 0], self.E[:, 1]
        src = np.concatenate([a, b])
        dst = np.concatenate([b, a])
        order = np.argsort(src, kind='stable')
        self.nbr = dst[order]
        self.indptr = np.concatenate([[0], np.cumsum(np.bincount(src, minlength=self.n))])
        self.w = np.linalg.norm(self.V[self.nbr] - self.V[src[order]], axis=1)
        self.deg = np.diff(self.indptr)

    @property
    def height(self):
        return float(self.V[:, 2].max() - self.V[:, 2].min())

    @property
    def floor(self):
        return float(self.V[:, 2].min())

    def write(self, obj, V=None):
        V = self.V if V is None else V
        obj.data.vertices.foreach_set('co', np.ascontiguousarray(V, dtype=np.float64).ravel())
        obj.data.update()

    def umbrella(self, X):
        """Mean of each vertex's neighbours (uniform Laplacian target)."""
        a, b = self.E[:, 0], self.E[:, 1]
        S = np.zeros_like(X)
        np.add.at(S, a, X[b])
        np.add.at(S, b, X[a])
        return S / np.maximum(self.deg, 1)[:, None]

    def taubin(self, X, mask, iterations, lam=0.5, mu=-0.53):
        """Taubin lambda|mu smoothing of the vertices weighted by mask (0..1): a low-pass filter
        that removes ridges and folds without the shrinkage of plain Laplacian smoothing."""
        X = X.copy()
        m = mask[:, None]
        for _ in range(iterations):
            X += lam * m * (self.umbrella(X) - X)
            X += mu * m * (self.umbrella(X) - X)
        return X

    def normals(self, X=None):
        X = self.V if X is None else X
        a, b, c = X[self.T[:, 0]], X[self.T[:, 1]], X[self.T[:, 2]]
        fn = np.cross(b - a, c - a)
        N = np.zeros_like(X)
        for k in range(3):
            np.add.at(N, self.T[:, k], fn)
        return N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]

    def grow(self, mask, steps=1):
        """Dilate a boolean vertex mask along mesh edges."""
        m = mask.copy()
        a, b = self.E[:, 0], self.E[:, 1]
        for _ in range(steps):
            g = m.copy()
            g[b[m[a]]] = True
            g[a[m[b]]] = True
            m = g
        return m

    def component(self, seed, allowed):
        """Vertices reachable from seed through allowed vertices."""
        seen = np.zeros(self.n, bool)
        seen[seed] = True
        a, b = self.E[:, 0], self.E[:, 1]
        ok = allowed[a] & allowed[b]
        a, b = a[ok], b[ok]
        while True:
            new = np.zeros(self.n, bool)
            new[b[seen[a]]] = True
            new[a[seen[b]]] = True
            new &= ~seen
            if not new.any():
                return seen
            seen |= new

    def dijkstra(self, sources, allowed=None, dmax=math.inf):
        """Geodesic (edge-path) distance from a set of source vertices."""
        dist = np.full(self.n, math.inf)
        indptr, nbr, w = self.indptr, self.nbr, self.w
        ok = np.ones(self.n, bool) if allowed is None else allowed
        heap = []
        for s in np.atleast_1d(sources):
            s = int(s)
            dist[s] = 0.0
            heap.append((0.0, s))
        heapq.heapify(heap)
        done = np.zeros(self.n, bool)
        while heap:
            d, v = heapq.heappop(heap)
            if done[v]:
                continue
            done[v] = True
            if d > dmax:
                break
            for k in range(indptr[v], indptr[v + 1]):
                u = nbr[k]
                if not ok[u]:
                    continue
                nd = d + w[k]
                if nd < dist[u]:
                    dist[u] = nd
                    heapq.heappush(heap, (nd, u))
        return dist


# ---------------------------------------------------------------- arms

def _unit(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


def slab(mesh, p, n, half, near, radius, X=None):
    """Vertex ids within `half` of the plane (p, n) and within `radius` of `near` in that plane."""
    X = mesh.V if X is None else X
    rel = X - p
    s = rel @ n
    inplane = (X - near) - np.outer((X - near) @ n, n)
    ok = (np.abs(s) < half) & (np.linalg.norm(inplane, axis=1) < radius)
    return np.nonzero(ok)[0]


def arm(mesh, side, X=None):
    """March cross-sections from the hand's extreme vertex up the arm to the armpit.

    Returns stations (hand -> shoulder), each with the centroid, the local axis (pointing toward the
    hand), the cross-section's principal radii and point count. The march stops where the section
    spreads into the torso."""
    X = mesh.V if X is None else X
    H = mesh.height
    z0 = mesh.floor
    sign = SIDES[side]
    low = X[:, 2] < z0 + 0.8 * H
    tip = int(np.argmax(np.where(low, sign * X[:, 0], -np.inf)))
    shoulder_guess = np.array([sign * 0.11 * H, float(np.median(X[:, 1])), z0 + 0.82 * H])
    axis = _unit(X[tip] - shoulder_guess)  # toward the hand
    step = 0.006 * H
    stations = []
    c = X[tip] - axis * 0.004 * H
    for _ in range(400):
        ids = slab(mesh, c, axis, 0.0025 * H, c, 0.075 * H, X)
        if len(ids) < 12:
            c = c - axis * step
            continue
        P = X[ids]
        cen = P.mean(axis=0)
        Q = P - cen
        Q -= np.outer(Q @ axis, axis)
        ev, evec = np.linalg.eigh(Q.T @ Q / len(P))
        r_major, r_minor = math.sqrt(max(ev[2], 0)) * math.sqrt(2), math.sqrt(max(ev[1], 0)) * math.sqrt(2)
        far = float(np.linalg.norm(Q, axis=1).max())
        stations.append({'c': cen, 'axis': axis.copy(), 'rmaj': r_major, 'rmin': r_minor, 'far': far,
                         'major': evec[:, 2], 'count': len(ids)})
        # Re-fit the axis on the last few centroids once past the hand.
        if len(stations) >= 8:
            C = np.array([s['c'] for s in stations[-8:]])
            d = _unit(C[0] - C[-1])
            if d @ axis > 0.8:
                axis = _unit(0.7 * axis + 0.3 * d)
        c = cen - axis * step
        # Stop at the armpit: the section suddenly spreads (torso joins) or we pass shoulder height.
        if len(stations) > 30 and far > 2.2 * np.median([s['far'] for s in stations[-12:-2]]):
            stations.pop()
            break
        if cen[2] > z0 + 0.8 * H:
            break
    return {'side': side, 'tip': tip, 'stations': stations}


def section(mesh, p, n, near, radius, X=None):
    """Exact cross-section: intersect the triangles with the plane (p, n), chain the segments into
    closed loops and return the loop nearest `near` (within `radius`) as a dict with its area
    centroid, area, perimeter, principal widths and points - independent of vertex density."""
    X = mesh.V if X is None else X
    n = _unit(n)
    s = (X - p) @ n
    T = mesh.T
    st = s[T]
    cross = (st.min(axis=1) < 0) & (st.max(axis=1) > 0)
    cand = np.nonzero(cross)[0]
    if len(cand) == 0:
        return None
    cen = X[T[cand]].mean(axis=1)
    rel = cen - near
    rel -= np.outer(rel @ n, n)
    cand = cand[np.linalg.norm(rel, axis=1) < radius]
    if len(cand) == 0:
        return None
    # Each crossing triangle gives one segment between two crossing edges; key points by edge.
    def edge_point(a, b):
        t = s[a] / (s[a] - s[b])
        return X[a] + (X[b] - X[a]) * t

    adj = {}
    pts = {}
    for f in cand:
        a, b, c = (int(v) for v in T[f])
        keys = []
        for u, v in ((a, b), (b, c), (c, a)):
            if (s[u] < 0) != (s[v] < 0):
                k = (u, v) if u < v else (v, u)
                keys.append(k)
                if k not in pts:
                    pts[k] = edge_point(u, v)
        if len(keys) == 2:
            adj.setdefault(keys[0], []).append(keys[1])
            adj.setdefault(keys[1], []).append(keys[0])
    loops = []
    seen = set()
    # Open chains first from their ends (degree 1), then closed loops from anywhere.
    starts = [k for k, v in adj.items() if len(v) == 1] + list(adj)
    for start in starts:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nxt = [k for k in adj[cur] if k != prev and k not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        closed = start in adj[cur] and len(loop) > 2
        loops.append((np.array([pts[k] for k in loop]), closed))
    # Plane basis for 2D area centroids.
    e1 = _unit(np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0]))
    e2 = np.cross(n, e1)
    best = None
    for P, closed in loops:
        if len(P) < 3:
            continue
        q = np.stack([(P - p) @ e1, (P - p) @ e2], axis=1)
        q2 = np.roll(q, -1, axis=0)
        cr = q[:, 0] * q2[:, 1] - q2[:, 0] * q[:, 1]
        A = cr.sum() / 2
        if abs(A) < 1e-9:
            continue
        cx = ((q[:, 0] + q2[:, 0]) * cr).sum() / (6 * A)
        cy = ((q[:, 1] + q2[:, 1]) * cr).sum() / (6 * A)
        c3 = p + e1 * cx + e2 * cy
        dist = np.linalg.norm((c3 - near) - n * ((c3 - near) @ n))
        if dist < radius and (best is None or dist < best['dist']):
            seg = np.linalg.norm(np.roll(P, -1, axis=0) - P, axis=1)
            Q = P - c3
            Wt = seg[:, None]
            cov = (Q * Wt).T @ Q / seg.sum()
            ev = np.linalg.eigvalsh(cov - np.outer(n, n) * (n @ cov @ n))
            best = {'c': c3, 'area': abs(A), 'perimeter': float(seg.sum()), 'closed': closed, 'points': P,
                    'width': 2 * math.sqrt(2 * max(ev[2], 0)), 'thick': 2 * math.sqrt(2 * max(ev[1], 0)), 'dist': dist,
                    'loops': len(loops)}
    return best


def forearm_line(mesh, elbow, wrist_guess, X=None, iterations=2):
    """The forearm's bone line through exact section centroids between the cuff and the elbow.
    Returns (point on line, unit direction toward the hand)."""
    d = _unit(wrist_guess - elbow)
    L = float(np.linalg.norm(wrist_guess - elbow))
    for _ in range(iterations):
        C = []
        for f in np.linspace(0.18, 0.72, 10):
            p = elbow + d * (f * L)
            sec = section(mesh, p, d, p, 0.11, X)
            if sec and sec['closed']:
                C.append(sec['c'])
        if len(C) < 5:
            break
        c0, nd = line_fit(np.array(C))
        d = _unit(nd if nd @ d > 0 else -nd)
        elbow = c0 + d * ((elbow - c0) @ d)
    return elbow, d


FOREARM_OF_H = 0.146  # elbow -> wrist as a fraction of body height (Drillis & Contini)
UPPER_ARM_OF_H = 0.186  # shoulder -> elbow


def arm_line(mesh, side, X=None):
    """Centre line of the whole arm from geodesic rings around the hand's extreme vertex.

    Far from the source, equal-distance rings are cross-sections of the limb, so their centroids
    trace the bone line without any axis estimate. Returns points from the hand to the armpit (the
    line stops where a ring spreads into the torso) and their arc lengths."""
    X = mesh.V if X is None else X
    H = mesh.height
    sign = SIDES[side]
    low = X[:, 2] < mesh.floor + 0.8 * H
    tip = int(np.argmax(np.where(low, sign * X[:, 0], -np.inf)))
    d = mesh.dijkstra(tip, dmax=0.45 * H)
    step = 0.005 * H
    pts, spread = [], []
    last_i = 0
    ok = np.isfinite(d)
    ids_all = np.nonzero(ok)[0]
    db = d[ids_all]
    for i in range(int(0.45 * H / step)):
        sel = ids_all[(db >= i * step) & (db < (i + 1) * step)]
        if len(sel) < 12:
            continue
        P = X[sel]
        c = P.mean(axis=0)
        sp = float(np.percentile(np.linalg.norm(P - c, axis=1), 90))
        if len(spread) > 20 and sp > 1.7 * float(np.median(spread[-10:])):
            break
        pts.append(c)
        spread.append(sp)
        last_i = i
    P = _smooth_line(np.array(pts), 2)
    arc = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    return {'tip': tip, 'points': P, 'arc': arc, 'spread': np.array(spread), 'd': d, 'dEnd': (last_i + 1) * step}


def point_on_line(line, start_pt, dist):
    """Point `dist` along the line (toward the shoulder) from the line point nearest start_pt."""
    P, arc = line['points'], line['arc']
    k = int(np.argmin(np.linalg.norm(P - start_pt, axis=1)))
    target = arc[k] + dist
    if target >= arc[-1]:
        return P[-1], False
    j = int(np.searchsorted(arc, target))
    t = (target - arc[j - 1]) / max(arc[j] - arc[j - 1], 1e-12)
    return P[j - 1] + (P[j] - P[j - 1]) * t, True


def line_fit(P):
    """Least-squares line through points: (centroid, unit direction)."""
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c)
    return c, vt[0]


# ---------------------------------------------------------------- hands

def persistence_maxima(mesh, d, region):
    """Local maxima of d over the region with their persistence (elder rule merge tree).

    Returns (maxima list [(vertex, birth, death)], merge events [(level, elder, younger)])."""
    ids = np.nonzero(region)[0]
    order = ids[np.argsort(-d[ids], kind='stable')]
    parent = {}
    birth = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    deaths = {}
    merges = []
    indptr, nbr = mesh.indptr, mesh.nbr
    for v in order:
        v = int(v)
        roots = set()
        for k in range(indptr[v], indptr[v + 1]):
            u = int(nbr[k])
            if u in parent:
                roots.add(find(u))
        if not roots:
            parent[v] = v
            birth[v] = d[v]
            continue
        roots = sorted(roots, key=lambda r: -birth[r])
        elder = roots[0]
        parent[v] = elder
        for r in roots[1:]:
            parent[r] = elder
            deaths[r] = d[v]
            merges.append((float(d[v]), elder, r))
    maxima = [(r, float(birth[r]), float(deaths.get(r, -math.inf))) for r in birth]
    return maxima, merges


def hand(mesh, side, X=None, ring_offset=None):
    """Find the digits of one hand. See the module doc. All positions in mesh space."""
    X = mesh.V if X is None else X
    H = mesh.height
    a = arm(mesh, side, X)
    st = a['stations']
    tip = a['tip']
    # Coarse wrist: walking up from the fingertips, the palm is the widest flat section; the wrist
    # is where the section becomes round and narrow again.
    widths = np.array([s['rmaj'] for s in st])
    flat = np.array([s['rmaj'] / max(s['rmin'], 1e-6) for s in st])
    k_palm = int(np.argmax(widths[: max(10, len(st) // 3)]))
    k_wrist = k_palm
    for k in range(k_palm, len(st)):
        if flat[k] < 1.45 and widths[k] < 0.75 * widths[k_palm]:
            k_wrist = k
            break
    forearm_axis = _unit(st[min(k_wrist + 4, len(st) - 1)]['axis'])
    # Ring across the forearm, well up from the wrist; the hand region is everything past it.
    off = (ring_offset or 0.055) * H
    k_ring = min(len(st) - 1, k_wrist + int(round(off / (0.006 * H))))
    ring_c, ring_n = st[k_ring]['c'], _unit(st[k_ring]['axis'])
    side_s = (X - ring_c) @ ring_n
    region = mesh.component(tip, side_s > 0)
    ring = slab(mesh, ring_c, ring_n, 0.003 * H, ring_c, 0.06 * H, X)
    ring = ring[region[ring] | (np.abs(side_s[ring]) < 0.003 * H)]
    allowed = region.copy()
    allowed[ring] = True
    d = mesh.dijkstra(ring, allowed)
    d[~region] = 0.0
    maxima, merges = persistence_maxima(mesh, d, region)
    INF_P = 10.0
    pers = sorted(((b - de if de > -math.inf else INF_P), v, b) for v, b, de in maxima)[::-1]
    digits = [v for p, v, b in pers[:5]]
    sig = set(digits)
    # Web level of each digit: the highest level where its component meets another digit's.
    comp_of = {v: v for v in sig}
    web = {v: -math.inf for v in sig}
    uf = {}

    def find(x):
        while uf.get(x, x) != x:
            x = uf[x]
        return x

    for level, elder, younger in merges:  # merges are in descending level order
        e, y = find(elder), find(younger)
        if e in sig and y in sig:
            web[e] = max(web[e], level)
            web[y] = max(web[y], level)
        # Insignificant components fold into whichever survives.
        uf[y] = e
    for v in sig:
        if web[v] == -math.inf:
            web[v] = 0.0
    info = {'side': side, 'height': H, 'tip': int(tip), 'arm': a, 'k_wrist': k_wrist, 'ring': ring,
            'region': region, 'd': d, 'forearm_axis': forearm_axis,
            'persistence': [(float(p if p < INF_P else -1), int(v)) for p, v, b in pers[:8]]}
    fingers = []
    for v in digits:
        reg = mesh.component(v, region & (d > web[v] + 1e-6))
        ids = np.nonzero(reg)[0]
        # Centreline: centroids of equal-distance rings, tip to base.
        lo, hi = web[v], d[v]
        nb = max(4, int((hi - lo) / (0.0025 * H)))
        edges = np.linspace(lo, hi, nb + 1)
        pts = []
        for i in range(nb - 1, -1, -1):
            sel = ids[(d[ids] >= edges[i]) & (d[ids] < edges[i + 1])]
            if len(sel) >= 3:
                pts.append(X[sel].mean(axis=0))
        fingers.append({'tip': int(v), 'tipPos': X[v].copy(), 'web': float(web[v]), 'length': float(hi - lo),
                        'ids': ids, 'centre': np.array(pts)})
    # Thumb: the digit that leaves the palm closest to the wrist (lowest web level).
    fingers.sort(key=lambda f: f['web'])
    thumb, rest = fingers[0], fingers[1:]
    base = lambda f: f['centre'][-1] if len(f['centre']) else f['tipPos']
    rest.sort(key=lambda f: np.linalg.norm(base(f) - base(thumb)))
    for name, f in zip(DIGITS, [thumb] + rest):
        f['name'] = name
    info['fingers'] = {f['name']: f for f in [thumb] + rest}
    # Trunk line (palm + forearm without the digits): centroids of equal-distance rings from the
    # forearm ring up to the end of the palm.
    in_finger = np.zeros(mesh.n, bool)
    for f in fingers:
        in_finger[f['ids']] = True
    trunk = np.nonzero(region & ~in_finger)[0]
    step = 0.004 * H / 1.9
    nb = int(d[trunk].max() / step)
    line, aspect = [], []
    for i in range(nb):
        sel = trunk[(d[trunk] >= i * step) & (d[trunk] < (i + 1) * step)]
        if len(sel) >= 8:
            P = X[sel]
            c = P.mean(axis=0)
            Q = P - c
            Q -= np.outer(Q @ forearm_axis, forearm_axis)
            ev = np.linalg.eigvalsh(Q.T @ Q / len(P))
            line.append(c)
            aspect.append(math.sqrt(ev[2] / max(ev[1], 1e-12)))
    info['trunk'] = _smooth_line(np.array(line), 2)  # forearm ring -> palm
    info['trunk_aspect'] = np.convolve(np.pad(aspect, 1, mode='edge'), np.ones(3) / 3, mode='valid')
    _hand_frame(mesh, info, X)
    return info


# Joint proportions shared with the first-person glove rig (scripts/rig-arms.mjs), so both rigs put
# knuckles and wrists in the same places relative to the fingers.
MCP_BELOW_WEB = 0.19  # x free length (web -> tip): the web sits a third up the proximal phalanx
PIP, DIP = 0.48, 0.75  # along knuckle -> tip
THUMB_IP = 0.52  # along the thumb's free length
THUMB_CMC = 0.30  # wrist -> thumb MCP
WRIST_BELOW_MCP = 0.92  # x middle finger length: the glove rig's palm (fallback only, short for a real hand)
WRIST_ASPECT = 1.8  # palm sections are flat (width/thickness 2.2-3.1), forearm ones round (1.1-1.5)
FOREARM_SPAN = (0.06, 0.18)  # [0] = cuff clearance above the wrist  # m above the wrist: the forearm axis is fitted there


def _smooth_line(P, k=2):
    if len(P) < 2 * k + 1:
        return P
    Q = P.copy()
    for i in range(len(P)):
        Q[i] = P[max(0, i - k): i + k + 1].mean(axis=0)
    return Q


def _along(P, start, dist):
    """Point `dist` along polyline P (from P[0]) starting at `start` (a point on/near P[0])."""
    pts = np.vstack([start, P])
    for i in range(len(pts) - 1):
        seg = np.linalg.norm(pts[i + 1] - pts[i])
        if dist <= seg:
            return pts[i] + (pts[i + 1] - pts[i]) * (dist / max(seg, 1e-12))
        dist -= seg
    return pts[-1]


def _hand_frame(mesh, info, X):
    """Joints of every digit, wrist pivot, hand axis, palm normal and thumb direction."""
    F = info['fingers']
    joints = {}
    mcp = {}
    for name, f in F.items():
        c = _smooth_line(f['centre']) if len(f['centre']) else np.array([f['tipPos']])
        f['centre'] = c
        n = len(c)
        if n >= 4:
            base_dir = _unit(c[int(0.35 * n): max(int(0.6 * n), int(0.35 * n) + 1)].mean(axis=0) - c[: max(1, n // 4)].mean(axis=0))
        else:
            base_dir = _unit(c[-1] - f['tipPos'])
        web_pt = c[-1]
        Lw = f['length']
        toward_tip = c[::-1]  # base -> tip
        if name == 'Thumb':
            m = web_pt
            ip = _along(toward_tip, m, THUMB_IP * Lw)
            joints[name] = {'mcp': m, 'ip': ip, 'tip': f['tipPos']}
        else:
            m = web_pt + base_dir * MCP_BELOW_WEB * Lw
            L = (1 + MCP_BELOW_WEB) * Lw
            joints[name] = {'mcp': m, 'pip': _along(toward_tip, m, PIP * L), 'dip': _along(toward_tip, m, DIP * L),
                            'tip': f['tipPos'], 'length': L}
        mcp[name] = m
    knuckles = np.array([mcp[k] for k in ('Index', 'Middle', 'Ring', 'Pinky')])
    fa = info['forearm_axis']
    C = info['trunk'][::-1]  # palm end -> forearm ring
    A = info['trunk_aspect'][::-1]
    dist = np.linalg.norm(C - mcp['Middle'], axis=1)
    # Wrist pivot: walking the trunk line up from the knuckles, where the flat palm section
    # (width/thickness > 2) turns round (< WRIST_ASPECT) - the wrist crease. Fallback: the glove
    # rig's palm length (0.92 x middle finger), which is short for a real hand.
    k = None
    for i in range(1, len(C)):
        if dist[i] > 0.6 * joints['Middle']['length'] and A[i - 1] >= WRIST_ASPECT > A[i]:
            k = i
            break
    if k is not None:
        t = (A[k - 1] - WRIST_ASPECT) / max(A[k - 1] - A[k], 1e-9)
        wrist = C[k - 1] + (C[k] - C[k - 1]) * t
        info['wrist_by'] = 'palm section turns round'
    else:
        palm_len = WRIST_BELOW_MCP * joints['Middle']['length']
        k = int(np.argmax(dist >= palm_len)) if (dist >= palm_len).any() else len(C) - 1
        wrist = C[k]
        info['wrist_by'] = 'glove ratio fallback'
    palm_len = float(np.linalg.norm(wrist - mcp['Middle']))
    joints['Thumb']['cmc'] = wrist + (mcp['Thumb'] - wrist) * THUMB_CMC
    info['joints'] = joints
    hand_axis = _unit(mcp['Middle'] - wrist)
    # Forearm axis: wrist -> elbow over one anatomical forearm length on the arm's geodesic centre
    # line (a long baseline: 5 mm of centroid noise is under 1 degree).
    line = arm_line(mesh, info['side'], X)
    elbow, ok = point_on_line(line, wrist, FOREARM_OF_H * info['height'])
    info['arm_line'] = line
    info['elbow_est'] = elbow
    fdir = _unit(wrist - elbow) if ok else fa
    # The wrist joint sits on the forearm's bone line. Fit that line through exact section centroids
    # between the cuff and the elbow, then take the exact section across it at the palm transition's
    # level: its centroid is the wrist centre (the trunk rings near the wrist ride on cuff folds).
    if ok:
        e2, fdir = forearm_line(mesh, elbow, wrist, X)
        t_w = (wrist - e2) @ fdir
        on_line = e2 + fdir * t_w
        sec = section(mesh, on_line, fdir, on_line, 0.11, X)
        if sec and sec['closed']:
            wrist = sec['c']
            info['wrist_section'] = {k: sec[k] for k in ('area', 'perimeter', 'width', 'thick')}
        info['elbow_est'] = elbow = e2
        joints['Thumb']['cmc'] = wrist + (mcp['Thumb'] - wrist) * THUMB_CMC
        hand_axis = _unit(mcp['Middle'] - wrist)
        palm_len = float(np.linalg.norm(wrist - mcp['Middle']))
    # Palm normal: across the knuckle row and the hand axis; it points to the palm side, which is
    # the side the fingertips curl toward.
    across = _unit(knuckles[-1] - knuckles[0])
    pn = _unit(np.cross(hand_axis, across))
    tips_mean = np.array([F[k]['tipPos'] for k in ('Index', 'Middle', 'Ring', 'Pinky')]).mean(axis=0)
    straight = wrist + hand_axis * (np.linalg.norm(tips_mean - wrist))
    if (tips_mean - straight) @ pn < 0:
        pn = -pn
    thumb_dir = _unit(mcp['Thumb'] - wrist - hand_axis * ((mcp['Thumb'] - wrist) @ hand_axis))
    info.update({'mcp': mcp, 'wrist': wrist, 'k_wrist_pivot': k, 'hand_axis': hand_axis, 'forearm_dir': fdir,
                 'palm_normal': pn, 'thumb_dir': thumb_dir, 'across': across, 'palm_len': palm_len})


def angle(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, float(_unit(a) @ _unit(b))))))


def forearm_frame(info):
    """Orthonormal frame on the forearm: (axis toward the hand, palm-side normal, thumb-side)."""
    fa = _unit(info['forearm_dir'])
    pn = info['palm_normal'] - fa * (info['palm_normal'] @ fa)
    pn = _unit(pn)
    th = _unit(np.cross(fa, pn))
    if th @ info['thumb_dir'] < 0:
        th = -th
    return fa, pn, th


def wrist_angles(info):
    """Flexion (+ toward the palm) and deviation (+ toward the thumb) of the hand axis measured in
    the forearm's frame (the palm normal and thumb side made perpendicular to the forearm)."""
    fa, pn, th = forearm_frame(info)
    ha = info['hand_axis']
    flex = math.degrees(math.atan2(ha @ pn, ha @ fa))
    dev = math.degrees(math.atan2(ha @ th, ha @ fa))
    return flex, dev
