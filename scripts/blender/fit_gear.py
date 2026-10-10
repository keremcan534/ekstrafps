"""Fit the Meshy-made faction gear to the master humanoid and export it per src/characters/README.md.

  node scripts/blender.mjs scripts/blender/fit_gear.py [item ...] [--no-poses] [--debug] [--set=key=json]

Every fit is landmark-driven and data-driven (scripts/blender/fit_gear.json): one fit per item,
shared by every character that wears it; nothing here knows about factions or characters. Items
run in the JSON's order; an item worn over another (`over`: the NVG on the BD helmet, the pack and
the radio on the plate carrier) uses that item's fitted surface (gear/fit/<id>_world.npz).

  head    helmets, hats   skull top / brow / occiput landmarks + clearance: the smallest gear (scale,
                          bounded width / depth ratios; with `top_gap` the height comes from the rim
                          and the crown) whose outer surface keeps every head vertex it covers at least
                          `clearance` inside it (rays from the head centre), rim pinned to a landmark.
  face    masks           eyepieces on the eyes (or the top edge on the nose bridge); for each scale /
                          vertical slide the mask moves back until it touches; the tightest wins;
                          what is left closer than `clearance` is fixed by a local inflation.
  nvg     night vision    real width, eyecups `gap` in front of the eyes, reports the mount shoe's
                          distance to the helmet it hangs on.
  back    backpacks       turned round, real height, leaned like the back, slid forward until its
                          panel is `clearance` from the vest it goes over (or the body).
  chest   radios          at a chest point, slid back until it is `clearance` from the vest.
  torso   vests           skinned: anisotropic fit of the inner surface to the torso sections, then
                          an inner-surface offset field (inner shell at `clearance` from the body,
                          thickness kept), weights from the body collapsed to the allowed bones
                          (ALLOWED, `caps`), smoothed, 4 influences.
  belt    pouches         skinned: the same at the trouser waistband.

Sources stay as Meshy made them for the export (glTF vertex splits, UVs, normals); the analysis runs
on a welded view (GearMesh). Normals: the imported ones turned by the fit's linear part (welding or
recomputing them broke Meshy's tangent-space normal maps into visible triangles).
Rigid items: GLB in their own frame (glTF: Y up, +Z front, origin at the item's anchor), JSON
socket transform relative to the socket bone of the published master GLB (re-run after a socket
moves). Skinned items: GLB with the master armature (69 bones, rest pose) + the SkinnedMesh.
Checks (gear/fit_report.json): clearance in the rest pose and, for skinned items, gear vertices
inside the posed body under production/assets/src/chars/master/rig/poses/ legs, raise, elbows
(count, deepest, where). The Warden's coat: scripts/blender/build_coat.py.
"""
import bmesh
import bpy
import json
import math
import os
import struct
import sys
import time

import numpy as np
from mathutils import Matrix, Quaternion, Vector, bvhtree, kdtree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import humanoid as hu  # noqa: E402

UP = np.array([0.0, 0.0, 1.0])
# Blender (x, y, z) -> glTF (x, z, -y): the exporter's Y-up conversion.
B2G = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])


def log(*a):
    print('[fit_gear]', *a, flush=True)


def rel(p):
    return os.path.join(ROOT, p)


def unit(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


# ---------------------------------------------------------------- master

class Master:
    """The master body in its rest pose: arrays, BVH, normals, weights, landmarks, socket frames."""

    def __init__(self, cfg):
        bpy.ops.wm.open_mainfile(filepath=rel(cfg['master']['blend']))
        self.arm = bpy.data.objects['MASTER_HUMANOID_RIG']
        self.body = bpy.data.objects['MasterBody']
        self.arm.data.pose_position = 'REST'
        self.mesh = hu.Mesh(self.body)
        self.V = self.mesh.V
        self.T = self.mesh.T
        self.N = self.mesh.normals()
        self.tree = bvhtree.BVHTree.FromPolygons([Vector(v) for v in self.V], self.T.tolist(), all_triangles=True)
        self.groups = [g.name for g in self.body.vertex_groups]
        W = np.zeros((self.mesh.n, len(self.groups)))
        for v in self.body.data.vertices:
            for g in v.groups:
                W[v.index, g.group] = g.weight
        self.W = W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
        self.bones = {b.name: b for b in self.arm.data.bones}
        self.sockets = gltf_world(rel(cfg['master']['glb']))
        self.L = landmarks(self)
        log('master:', self.mesh.n, 'verts,', len(self.groups), 'weighted bones; landmarks',
            {k: (np.round(v, 4).tolist() if isinstance(v, np.ndarray) else round(v, 4)) for k, v in self.L.items() if not isinstance(v, dict)})

    def section(self, z, near=None, radius=0.35, n=UP):
        near = np.array([0.0, 0.02, z]) if near is None else near
        return hu.section(self.mesh, np.array([0.0, 0.0, z]), n, near, radius)

    def nearest(self, P):
        """Nearest body surface point, face index and signed distance (+ outside) of each point."""
        out_p = np.zeros((len(P), 3))
        out_f = np.zeros(len(P), dtype=np.int64)
        sd = np.zeros(len(P))
        for i, p in enumerate(P):
            loc, nrm, fi, d = self.tree.find_nearest(Vector(p))
            out_p[i] = loc
            out_f[i] = fi
            sd[i] = d if (np.asarray(p) - np.asarray(loc)) @ np.asarray(nrm) >= 0 else -d
        return out_p, out_f, sd

    def bary_weights(self, P, faces, locs):
        """Body skin weights interpolated at surface points (barycentric on the nearest face)."""
        out = np.zeros((len(P), self.W.shape[1]))
        for i, (fi, l) in enumerate(zip(faces, locs)):
            a, b, c = self.T[fi]
            A, B, C = self.V[a], self.V[b], self.V[c]
            v0, v1, v2 = B - A, C - A, l - A
            d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
            den = d00 * d11 - d01 * d01
            if abs(den) < 1e-20:
                bw = np.array([1.0, 0, 0])
            else:
                v_ = (d11 * d20 - d01 * d21) / den
                w_ = (d00 * d21 - d01 * d20) / den
                bw = np.clip([1 - v_ - w_, v_, w_], 0, 1)
                bw /= max(bw.sum(), 1e-9)
            out[i] = bw[0] * self.W[a] + bw[1] * self.W[b] + bw[2] * self.W[c]
        return out


def gltf_world(path):
    """World matrices (glTF space) of every node of a GLB, by name."""
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    nodes = j['nodes']
    parent = {c: i for i, nd in enumerate(nodes) for c in nd.get('children', [])}

    def local(nd):
        if 'matrix' in nd:
            return np.array(nd['matrix']).reshape(4, 4).T
        x, y, z, w = nd.get('rotation', [0, 0, 0, 1])
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4)
        M[:3, :3] = R @ np.diag(nd.get('scale', [1, 1, 1]))
        M[:3, 3] = nd.get('translation', [0, 0, 0])
        return M

    W = {}

    def world(i):
        if i not in W:
            W[i] = (world(parent[i]) if i in parent else np.eye(4)) @ local(nodes[i])
        return W[i]

    return {nd.get('name', str(i)): world(i) for i, nd in enumerate(nodes)}


def landmarks(m):
    """Head, face and torso landmarks of the master, measured on the mesh (Blender space)."""
    V = m.V
    L = {}
    L['skull_top'] = float(V[:, 2].max())
    mid = np.abs(V[:, 0]) < 0.004

    def profile(z0, z1, step=0.0025):
        zs, ys = [], []
        for z in np.arange(z0, z1, step):
            sel = mid & (np.abs(V[:, 2] - z) < step) & (V[:, 1] < 0.02)
            if sel.sum():
                zs.append(z)
                ys.append(V[sel, 1].min())
        return np.array(zs), np.array(ys)

    zs, ys = profile(1.60, 1.86)
    ys = np.convolve(np.pad(ys, 1, mode='edge'), np.ones(3) / 3, mode='valid')  # 7.5 mm low-pass
    face = (zs > 1.70) & (zs < 1.765)
    k_nose = np.nonzero(face)[0][np.argmin(ys[face])]
    L['nose_tip'] = np.array([0.0, ys[k_nose], zs[k_nose]])
    # Walking up from the nose tip the profile recedes to the nasion (first local maximum of y),
    # then comes forward again to the brow ridge (next local minimum).
    k = k_nose
    while k + 1 < len(zs) and ys[k + 1] >= ys[k] - 0.0002:
        k += 1
    L['nasion'] = np.array([0.0, ys[k], zs[k]])
    while k + 1 < len(zs) and ys[k + 1] <= ys[k] + 0.0002:
        k += 1
    L['brow'] = np.array([0.0, ys[k], zs[k]])
    below = (zs > 1.62) & (zs < zs[k_nose] - 0.05)
    k_chin = np.nonzero(below)[0][np.argmin(ys[below])]
    L['chin'] = np.array([0.0, ys[k_chin], zs[k_chin]])
    # Chin bottom: below the chin's front, where the profile falls back toward the neck by 2 cm.
    k = k_chin
    while k > 0 and ys[k] < ys[k_chin] + 0.02:
        k -= 1
    L['chin_bottom'] = np.array([0.0, ys[k], zs[k]])
    # Eyes: 3.2 cm either side of the midline at the nasion's height, on the front surface.
    eye_z = L['nasion'][2] - 0.004
    eyes = []
    for sx in (-1.0, 1.0):
        sel = (np.abs(V[:, 0] - sx * 0.032) < 0.006) & (np.abs(V[:, 2] - eye_z) < 0.006) & (V[:, 1] < 0)
        eyes.append(np.array([sx * 0.032, V[sel, 1].min(), eye_z]))
    L['eye_R'], L['eye_L'] = eyes
    # Back of the head: the occiput (rearmost midline point above the ears).
    sel = mid & (V[:, 2] > 1.72) & (V[:, 2] < 1.88)
    k = np.argmax(np.where(sel, V[:, 1], -np.inf))
    L['occiput'] = V[k].copy()
    # Head centre: centroid of the skull section a little above the eyes.
    s = m.section(L['nasion'][2] + 0.02, near=np.array([0.0, 0.0, L['nasion'][2] + 0.02]), radius=0.15)
    L['head_c'] = np.array([0.0, s['c'][1], L['nasion'][2] - 0.01])
    # Ears: where the head section widens past the skull below the brow.
    widths = []
    for z in np.arange(1.70, 1.82, 0.005):
        s = m.section(z, near=np.array([0.0, 0.0, z]), radius=0.15)
        if s is not None:
            widths.append((z, float(s['points'][:, 0].max() - s['points'][:, 0].min())))
    widths = np.array(widths)
    skull_w = float(np.median(widths[widths[:, 0] > L['brow'][2] + 0.01, 1]))
    ear = widths[widths[:, 1] > skull_w + 0.012, 0]
    L['ear_z'] = np.array([ear.min(), ear.max()]) if len(ear) else np.array([1.72, 1.79])
    L['skull_w'] = skull_w
    # Torso: shoulder tops (trapezius 10 cm off the midline), the trouser waistband (5 cm over the
    # hip joint line of the skeleton), chest and waist levels.
    sel = (np.abs(np.abs(V[:, 0]) - 0.10) < 0.012) & (np.abs(V[:, 1] - 0.03) < 0.07) & (V[:, 2] > 1.45) & (V[:, 2] < 1.66)
    L['shoulder_top'] = float(V[sel, 2].max())
    hips = m.arm.data.bones['Hips'].head_local
    L['belt'] = float(hips.z + 0.05)
    L['spine3'] = np.array(m.arm.data.bones['Spine3'].head_local[:])
    L['neck_base'] = np.array(m.arm.data.bones['Neck'].head_local[:])
    per = []
    for z in np.arange(1.05, 1.32, 0.01):
        s = m.section(z)
        if s is not None and s['closed']:
            per.append((z, s['perimeter']))
    per = np.array(per)
    L['waist'] = float(per[np.argmin(per[:, 1]), 0])
    return L


def landmark_value(L, name, offset=0.0, axis=2):
    v = L[name]
    return float((v[axis] if isinstance(v, np.ndarray) else v) + offset)


# ---------------------------------------------------------------- gear source

def import_gear(path, name):
    """Import a Meshy GLB as one mesh object in Blender space, untouched (glTF vertex splits at UV
    seams kept, so its UVs and normals export exactly as Meshy baked them). The imported corner
    normals are saved as the corner attribute `src_normal`: the export writes them back, turned by
    the fit's linear part, as custom normals."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        M = o.matrix_world.copy()
        o.parent = None
        o.data.transform(M)
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    obj = meshes[0]
    if len(meshes) > 1:
        for o in bpy.context.scene.objects:
            o.select_set(o in meshes)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.join()
    obj.name = name
    obj.data.name = name
    me = obj.data
    N = np.empty(len(me.loops) * 3)
    me.corner_normals.foreach_get('vector', N)
    a = me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
    a.data.foreach_set('vector', N)
    for i, mat in enumerate(me.materials):
        if mat:
            mat.name = name if i == 0 else f'{name}_{i}'
    return obj


class GearMesh:
    """Welded view of a gear object for the analysis (glTF splits every UV seam, so the imported
    mesh is a heap of islands): vertices merged by position, triangles and edges over them.
    write(V) puts welded positions back onto the object's own (split) vertices."""

    def __init__(self, obj):
        self.obj = obj
        me = obj.data
        n = len(me.vertices)
        Vo = np.empty(n * 3)
        me.vertices.foreach_get('co', Vo)
        Vo = Vo.reshape(n, 3)
        size = float(np.abs(Vo).max()) or 1.0
        key = np.round(Vo / (size * 1e-5)).astype(np.int64)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        self.weld = np.asarray(inv).ravel()
        self.V = Vo[first]
        self.n = len(self.V)
        me.calc_loop_triangles()
        T = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get('vertices', T)
        P = np.empty(len(me.loop_triangles), dtype=np.int64)
        me.loop_triangles.foreach_get('polygon_index', P)
        self.poly = P
        self.T = self.weld[T.reshape(-1, 3)]
        e = np.sort(np.concatenate([self.T[:, [0, 1]], self.T[:, [1, 2]], self.T[:, [2, 0]]]), axis=1)
        e = e[e[:, 0] != e[:, 1]]
        self.E = np.unique(e, axis=0)

    def normals(self, X=None):
        X = self.V if X is None else X
        a, b, c = X[self.T[:, 0]], X[self.T[:, 1]], X[self.T[:, 2]]
        fn = np.cross(b - a, c - a)
        N = np.zeros_like(X)
        for k in range(3):
            np.add.at(N, self.T[:, k], fn)
        return N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]

    def write(self, V):
        me = self.obj.data
        me.vertices.foreach_set('co', np.ascontiguousarray(V[self.weld], dtype=np.float64).ravel())
        me.update()

    def components(self):
        parent = np.arange(self.n)

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for a, b in self.E:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
        return np.array([find(i) for i in range(self.n)])


def delete_faces(obj, polys):
    """Delete polygons (and vertices left without faces) from the object, nothing else touched."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    kill = sorted(set(int(p) for p in polys))
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in kill], context='FACES_ONLY')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(kill)


def cleanup(obj, spec):
    """Data-driven source cleanup, decided on the welded view and applied to the object's faces:
    plane cuts in fractions of the source's box (harness straps under a helmet, a gas mask's head
    straps), shell interiors (`interior`), connected pieces under `drop` vertices. Returns the
    number of faces removed."""
    removed = 0
    g = GearMesh(obj)
    lo0, hi0 = g.V.min(axis=0), g.V.max(axis=0)
    cuts = list(spec.get('cuts', []))
    if spec.get('cut') is not None:
        cuts.append({'axis': 'z', 'below': spec['cut']})
    # z below / above, y front / behind (Blender: the front is -y, so 'behind' is +y). A triangle
    # goes when any of its vertices is past the plane.
    kill_v = np.zeros(g.n, bool)
    for c in cuts:
        k = 'xyz'.index(c['axis'])
        for side, sign in (('below', -1), ('above', 1), ('front', -1), ('behind', 1)):
            if side in c:
                lim = lo0[k] + c[side] * (hi0[k] - lo0[k])
                kill_v |= sign * (g.V[:, k] - lim) > 0
    if kill_v.any():
        removed += delete_faces(obj, np.unique(g.poly[kill_v[g.T].any(axis=1)]))
        g = GearMesh(obj)
    if spec.get('interior'):
        # Pads, harness cradles and straps inside a shell: faces much closer to the shell's centre
        # than the shell itself in the same direction (azimuth x elevation bins).
        lo, hi = g.V.min(axis=0), g.V.max(axis=0)
        c = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + spec.get('interior_centre', 0.35) * (hi[2] - lo[2])])
        F = g.V[g.T].mean(axis=1) - c
        r = np.linalg.norm(F, axis=1)
        az = ((np.arctan2(F[:, 1], F[:, 0]) + math.pi) / (2 * math.pi) * 48).astype(int) % 48
        el = np.clip(((np.arcsin(np.clip(F[:, 2] / np.maximum(r, 1e-9), -1, 1)) + math.pi / 2) / math.pi * 24).astype(int), 0, 23)
        rmax = np.zeros((48, 24))
        np.maximum.at(rmax, (az, el), r)
        shell = np.zeros_like(rmax)
        # Up to 3 bins (22 deg) upward too: a cradle hanging under the rim is measured against the
        # shell above it. (np.roll along elevation wraps; the wrapped rows are the poles, harmless.)
        for da in (-1, 0, 1):
            for de in (-1, 0, 1, 2, 3):
                shell = np.maximum(shell, np.roll(np.roll(rmax, da, axis=0), -de, axis=1))
        inner = r < spec['interior'] * shell[az, el]
        if inner.any():
            removed += delete_faces(obj, np.unique(g.poly[inner]))
            g = GearMesh(obj)
    if spec.get('drop'):
        comp = g.components()
        roots, counts = np.unique(comp, return_counts=True)
        small = np.isin(comp, roots[counts < spec['drop']])
        if small.any():
            removed += delete_faces(obj, np.unique(g.poly[small[g.T].any(axis=1)]))
    return removed


def finish_normals(obj, A):
    """Custom normals from the imported ones, turned by the fit's linear part (inverse transpose)."""
    me = obj.data
    a = me.attributes.get('src_normal')
    if a is None:
        return
    N = np.empty(len(me.loops) * 3)
    a.data.foreach_get('vector', N)
    N = N.reshape(-1, 3) @ np.linalg.inv(np.asarray(A, float))
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    me.attributes.remove(a)
    me.normals_split_custom_set([tuple(n) for n in N])
    me.update()


def make_tree(V, T):
    return bvhtree.BVHTree.FromPolygons([Vector(v) for v in V], T.tolist(), all_triangles=True)


def farthest_hits(tree, origin, dirs, maxd):
    """Distance of the farthest hit of each ray (origin + t * dir, t < maxd); nan = no hit."""
    out = np.full(len(dirs), np.nan)
    o0 = Vector(origin)
    for i, d in enumerate(dirs):
        dv = Vector(d)
        o = o0
        far = None
        t_acc = 0.0
        for _ in range(12):
            loc, nrm, fi, dist = tree.ray_cast(o, dv, maxd - t_acc)
            if loc is None:
                break
            t_acc += dist + 1e-4
            far = t_acc
            o = loc + dv * 1e-4
        if far is not None:
            out[i] = far
    return out


def sphere_dirs(n):
    """n roughly uniform unit directions (Fibonacci sphere)."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = math.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], axis=1)


def outer_faces(V, T, min_elev=-0.2, min_front=-1.0, n_dirs=64):
    """Faces of the gear seen from outside: a ray from the face centre escapes in at least one
    allowed direction (elevation >= min_elev, forwardness -y >= min_front). Pads, straps and the
    inner side of shells stay hidden behind the shell and are left out of the clearance test."""
    tree = make_tree(V, T)
    A, B, C = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    cen = (A + B + C) / 3
    D = sphere_dirs(n_dirs)
    D = D[(D[:, 2] >= min_elev) & (-D[:, 1] >= min_front)]
    far = float(np.linalg.norm(V.max(axis=0) - V.min(axis=0))) * 2
    eps = far * 1e-5
    vis = np.zeros(len(T), bool)
    Dv = [Vector(d) for d in D]
    for f in range(len(T)):
        c = Vector(cen[f])
        for dv in Dv:
            if tree.ray_cast(c + dv * eps, dv, far)[0] is None:
                vis[f] = True
                break
    return vis


# ---------------------------------------------------------------- head / face fits

def rim_height(V, at, frac=0.12):
    """Lowest point of the gear's rim at the front, back or sides (source arrays)."""
    lo, hi = V.min(axis=0), V.max(axis=0)
    c = (lo + hi) / 2
    w, d = hi[0] - lo[0], hi[1] - lo[1]
    if at == 'front':
        sel = (np.abs(V[:, 0] - c[0]) < frac * w) & (V[:, 1] < c[1] - 0.3 * d)
    elif at == 'back':
        sel = (np.abs(V[:, 0] - c[0]) < frac * w) & (V[:, 1] > c[1] + 0.3 * d)
    else:
        sel = (np.abs(V[:, 0] - c[0]) > 0.35 * w) & (np.abs(V[:, 1] - c[1]) < frac * d)
    return float(V[sel, 2].min())


def head_points(m, z_min, step=2):
    sel = (m.V[:, 2] > z_min) & (np.abs(m.V[:, 0]) < 0.14) & (np.abs(m.V[:, 1] - 0.01) < 0.16)
    ids = np.nonzero(sel)[0][::step]
    return ids


def fit_shell(m, obj, spec, centre, cover_ids, pin, sz_rule=None):
    """Search the scales (sx, sy, sz) of the smallest gear whose outer surface keeps every covered
    body vertex `clearance` inside it (rays from `centre`); `pin(V) -> (dz, dy)` places the scaled
    source. Uniform mode: s with width / depth ratios within `aniso`. With `sz_rule(V0) -> sz` the
    height is fixed (e.g. by the rim and a top gap) and only the width and depth are searched."""
    g = GearMesh(obj)
    V0 = g.V.copy()
    lo, hi = V0.min(axis=0), V0.max(axis=0)
    c0 = (lo + hi) / 2
    V0 = V0 - np.array([c0[0], c0[1], hi[2]])  # x / y centred, top at z = 0
    P = m.V[cover_ids]
    D = P - centre
    dist = np.linalg.norm(D, axis=1)
    dirs = D / dist[:, None]
    clearance = spec['clearance']
    aniso = spec.get('aniso', 0.0)
    vis = outer_faces(V0, g.T, spec.get('min_elev', -0.2), spec.get('min_front', -1.0))
    T = g.T[vis]
    log(f'  outer faces: {vis.sum()} of {len(vis)}')

    def evaluate(sx, sy, sz):
        V = V0 * np.array([sx, sy, sz])
        dz, dy = pin(V)
        V = V + np.array([0.0, dy, dz])
        far = farthest_hits(make_tree(V, T), centre, dirs, 0.4)
        cov = ~np.isnan(far)
        clr = far[cov] - dist[cov]
        return V, cov, clr

    def bisect(make, lo_, hi_):
        for _ in range(14):
            x = (lo_ + hi_) / 2
            _, cov, clr = evaluate(*make(x))
            if cov.sum() > 20 and clr.min() >= clearance:
                hi_ = x
            else:
                lo_ = x
        return hi_

    width = hi[0] - lo[0]
    s_guess = (m.L['skull_w'] + 0.05) / width
    sz_fixed = sz_rule(V0) if sz_rule else None
    best = None
    candidates = []
    if sz_fixed is None:
        ks = np.linspace(-aniso, aniso, 5) if aniso > 0 else [0.0]
        for ax in ks:
            for ay in ks:
                make = (lambda kx, ky: lambda s_: (s_ * kx, s_ * ky, s_))(1 + ax, 1 + ay)
                candidates.append((make, bisect(make, 0.5 * s_guess, 2.0 * s_guess), abs(ax) + abs(ay)))
    else:
        for r in np.linspace(1 - aniso, 1 + aniso, 7):
            make = (lambda r_: lambda sx: (sx, sx * r_, sz_fixed))(r)
            candidates.append((make, bisect(make, 0.5 * sz_fixed, 2.0 * sz_fixed), abs(r - 1)))
    for make, x, penalty in candidates:
        sc = make(x)
        V, cov, clr = evaluate(*sc)
        # The tightest fit wins (mean clearance over the covered head), with a small penalty for
        # leaving the source's proportions.
        score = float(clr.mean()) + 0.02 * penalty
        if best is None or score < best['score']:
            worst = np.argsort(clr)[:5]
            cov_ids = np.asarray(cover_ids)[cov]
            best = {'score': score, 'scale': [float(v) for v in sc], 'V': V, 'covered': int(cov.sum()),
                    'clr_min': float(clr.min()), 'clr_mean': float(clr.mean()),
                    'worst': [(np.round(m.V[cov_ids[w]], 4).tolist(), round(float(clr[w]), 4)) for w in worst]}
    sx, sy, sz = best['scale']
    log(f"  shell fit: scale x {sx:.4f} y {sy:.4f} z {sz:.4f} (y/x {sy / sx:.3f}, z/x {sz / sx:.3f}) covered={best['covered']} "
        f"clearance min {best['clr_min'] * 1000:.1f} mm mean {best['clr_mean'] * 1000:.1f} mm; tightest {best['worst'][:3]}")
    return best


def fit_head(m, obj, spec, fitted=None):
    L = m.L
    rim = spec['rim']
    target = landmark_value(L, rim['target'], rim.get('offset', 0.0))

    def pin(V):
        r = rim_height(V, rim['at'])
        # Front-back: centre the gear's mid-height section on the skull's.
        zmid = V[:, 2].max() * 0.5 + r * 0.5
        band = np.abs(V[:, 2] - zmid) < 0.01
        gy = (V[band, 1].min() + V[band, 1].max()) / 2 if band.sum() > 10 else (V[:, 1].min() + V[:, 1].max()) / 2
        return target - r, L['head_c'][1] - gy

    sz_rule = None
    if spec.get('top_gap') is not None:
        # Height from two landmarks: the rim on its target and the crown `top_gap` over the skull.
        def sz_rule(V0):
            return (L['skull_top'] + spec['top_gap'] - target) / -rim_height(V0, rim['at'])

    cover = head_points(m, L['ear_z'][0] - 0.01)
    best = fit_shell(m, obj, spec, L['head_c'], cover, pin, sz_rule)
    V = best['V']
    anchor = np.array([0.0, L['head_c'][1], target])
    info = {k: best[k] for k in ('scale', 'covered', 'clr_min', 'clr_mean')}
    info['A'] = np.diag(best['scale'])
    info['top_gap'] = float(V[:, 2].max() - L['skull_top'])
    info['rim_' + rim['at']] = target
    return V, anchor, info


def inflate(V, T_all, vis, centre, dirs, dist, target, sigma=0.015, iterations=8):
    """Local, smooth push of a rigid gear's outer surface where a covered body point is closer than
    `target` to it: the outermost hit of each violating ray moves out along the ray by the missing
    clearance, spread over the gear's vertices with a Gaussian of `sigma` (both sides of a shell
    move together, so it keeps its thickness). Returns the new vertices and the pushes made."""
    T = T_all[vis]
    pushed = 0.0
    for it in range(iterations):
        far = farthest_hits(make_tree(V, T), centre, dirs, 0.4)
        cov = ~np.isnan(far)
        clr = np.where(cov, far - dist, np.inf)
        bad = np.nonzero(clr < target)[0]
        if len(bad) == 0:
            break
        H = centre + dirs[bad] * far[bad, None]
        need = (target - clr[bad]) * 1.15 + 0.0005
        kd = kdtree.KDTree(len(H))
        for i, h in enumerate(H):
            kd.insert(h, i)
        kd.balance()
        D = np.zeros_like(V)
        for i, p in enumerate(V):
            hits = kd.find_range(Vector(p), 3 * sigma)
            if not hits:
                continue
            best, acc = 0.0, np.zeros(3)
            for co, j, d in hits:
                w = math.exp(-0.5 * (d / sigma) ** 2)
                best = max(best, w * need[j])
                acc += w * dirs[bad[j]]
            D[i] = best * acc / max(np.linalg.norm(acc), 1e-9)
        V = V + D
        pushed = max(pushed, float(need.max()))
    return V, pushed


def fit_face(m, obj, spec, fitted):
    """Masks: x centred, height from the eyepieces (spec.eyes: source glTF x, y of one eyepiece
    centre) or from the top edge (spec.rim), scale searched for the closest fit in front of the face:
    for each scale the mask moves back toward the face until a covered face vertex is `clearance`
    from its outer surface; the scale with the smallest mean clearance wins."""
    L = m.L
    g = GearMesh(obj)
    V0 = g.V.copy()
    lo, hi = V0.min(axis=0), V0.max(axis=0)
    V0 = V0 - np.array([(lo[0] + hi[0]) / 2, 0.0, 0.0])
    vis = outer_faces(V0, g.T, spec.get('min_elev', -0.6), spec.get('min_front', -0.2))
    T = g.T[vis]
    log(f'  outer faces: {vis.sum()} of {len(vis)}')
    centre = np.array([0.0, L['head_c'][1] - 0.02, spec.get('centre_z', (L['nose_tip'][2] + L['chin'][2]) / 2)])
    cover = head_points(m, L['chin_bottom'][2] - 0.015)
    P = m.V[cover]
    D = P - centre
    dist = np.linalg.norm(D, axis=1)
    dirs = D / dist[:, None]
    eye_z = L['eye_R'][2]
    if spec.get('eyes'):
        ex, ey = spec['eyes']  # source glTF: x of the right... either eyepiece, y up
        s_ref = (L['eye_L'][0] - L['eye_R'][0]) / (2 * abs(ex))
    else:
        s_ref = None
    rim = spec.get('rim')

    def place(s, ty, dz_extra):
        V = V0 * s
        if spec.get('eyes'):
            dz = eye_z - spec['eyes'][1] * s
        else:
            front = np.abs(V[:, 0]) < 0.12 * (V[:, 0].max() - V[:, 0].min())
            dz = landmark_value(L, rim['target'], rim.get('offset', 0.0)) - V[front, 2].max()
        dy = ty - V[:, 1].min()
        return V + np.array([0.0, dy, dz + dz_extra])

    def evaluate(s, ty, dz):
        V = place(s, ty, dz)
        far = farthest_hits(make_tree(V, T), centre, dirs, 0.4)
        cov = ~np.isnan(far)
        return V, cov, far[cov] - dist[cov]

    # The rigid placement may leave up to `rigid_clearance` (negative = poke-through) that the local
    # inflation below then fixes; the result must hold `clearance` everywhere.
    rigid_c = spec.get('rigid_clearance', spec['clearance'])

    def ok(s, ty, dz):
        _, cov, clr = evaluate(s, ty, dz)
        return cov.sum() > 20 and clr.min() >= rigid_c

    def closest(s, dz):
        # Move the mask back toward the face from well in front of it until the first contact
        # (5 mm steps, then bisection inside the last step): coverage changes as it moves, so the
        # feasible set is not an interval and a plain bisection could stop at a later contact.
        ty = L['nose_tip'][1] - 0.12
        while ty < L['nose_tip'][1] + 0.02 and ok(s, ty + 0.005, dz):
            ty += 0.005
        a, b = ty, ty + 0.005
        for _ in range(8):
            mid = (a + b) / 2
            if ok(s, mid, dz):
                a = mid
            else:
                b = mid
        return a

    s0 = s_ref if s_ref else (0.16 / (hi[0] - lo[0]))
    best = None
    # Scale (k x the eyepiece / width scale) and a vertical slide off the pinned height (dz): a
    # mask's chin cup and the face's chin rarely agree to the centimetre. The closest, tightest
    # placement wins, with small penalties for leaving the pins.
    dzs = spec.get('dz', [-0.03, -0.02, -0.01, 0.0, 0.01])
    for k in np.linspace(spec.get('k_min', 0.9), spec.get('k_max', 1.3), spec.get('k_steps', 7)):
        for dz in dzs:
            s = s0 * k
            ty = closest(s, dz)
            V, cov, clr = evaluate(s, ty, dz)
            score = float(clr.mean()) + (0.03 * abs(k - 1) if s_ref else 0.0) + 0.5 * abs(dz)
            if best is None or score < best['score']:
                best = {'score': score, 's': s, 'k': k, 'dz': dz, 'ty': ty, 'V': V, 'covered': int(cov.sum()),
                        'clr_min': float(clr.min()), 'clr_mean': float(clr.mean())}
    V = best['V']
    log(f"  face fit: s={best['s']:.4f} (x{best['k']:.2f} of the reference scale) dz {best['dz'] * 1000:.0f} mm, front at y={best['ty']:.4f} "
        f"covered={best['covered']} clearance min {best['clr_min'] * 1000:.1f} mm mean {best['clr_mean'] * 1000:.1f} mm")
    if best['clr_min'] < spec['clearance']:
        V, pushed = inflate(V, g.T, vis, centre, dirs, dist, spec['clearance'], spec.get('inflate_sigma', 0.015))
        far = farthest_hits(make_tree(V, T), centre, dirs, 0.4)
        cov = ~np.isnan(far)
        clr = far[cov] - dist[cov]
        best.update({'inflated_mm': round(pushed * 1000, 1), 'clr_min': float(clr.min()), 'clr_mean': float(clr.mean())})
        log(f"  inflated up to {pushed * 1000:.1f} mm: clearance min {clr.min() * 1000:.1f} mm mean {clr.mean() * 1000:.1f} mm")
    anchor = np.array([0.0, float(V[:, 1].min()), float((V[:, 2].min() + V[:, 2].max()) / 2)])
    info = {k: best.get(k) for k in ('s', 'k', 'dz', 'covered', 'clr_min', 'clr_mean', 'inflated_mm')}
    info['A'] = np.eye(3) * best['s']
    info['front_y'] = best['ty']
    return V, anchor, info


def rot(axis, deg):
    return np.array(Matrix.Rotation(math.radians(deg), 3, axis))


def fit_nvg(m, obj, spec, fitted):
    """Night vision: real width, the housing's eyecups `gap` in front of the eyes at eye height,
    pitched by spec.pitch about the tube axis; reports where the mount shoe lands on the helmet."""
    L = m.L
    V = GearMesh(obj).V.copy()
    lo, hi = V.min(axis=0), V.max(axis=0)
    s = spec['width'] / (hi[0] - lo[0])
    V = (V - (lo + hi) / 2) * s
    h = V[:, 2].max() - V[:, 2].min()
    housing = V[:, 2] < V[:, 2].min() + spec.get('housing', 0.55) * h
    hc = np.array([0.0, (V[housing, 1].min() + V[housing, 1].max()) / 2, (V[housing, 2].min() + V[housing, 2].max()) / 2])
    V = (V - hc) @ rot('X', spec.get('pitch', 0.0)).T
    rear = V[housing, 1].max()
    eye_front = min(L['eye_R'][1], L['eye_L'][1])
    V = V + np.array([0.0, eye_front - spec['gap'] - rear, L['eye_R'][2] + spec.get('dz', 0.0)])
    info = {'s': s, 'A': rot('X', spec.get('pitch', 0.0)) * s}
    shoe = V[:, 2] > V[:, 2].max() - 0.12 * h
    info['shoe'] = np.round(V[shoe].mean(axis=0), 4).tolist()
    if spec.get('over') in fitted:
        Vh, Th = fitted[spec['over']]
        tree = make_tree(Vh, Th)
        d = [tree.find_nearest(Vector(p))[3] for p in V[shoe]]
        info['shoe_to_helmet_mm'] = round(float(np.min(d)) * 1000, 1)
        # Does the NVG cut into the helmet? Signed: vertices inside the helmet's outer surface.
    anchor = hc * 0 + np.array([0.0, float(V[:, 1].max()), float(L['eye_R'][2])])
    log(f"  nvg: scale {s:.4f}, shoe at {info['shoe']}, {info.get('shoe_to_helmet_mm')} mm from the helmet")
    return V, anchor, info


def contact_shift(V, tree, direction, clearance):
    """How far V can move along `direction` before a vertex comes within `clearance` of the
    surface in `tree` (rays from every vertex; vertices whose ray misses do not limit)."""
    d = Vector(direction)
    best = math.inf
    for p in V:
        hit = tree.ray_cast(Vector(p), d, 2.0)
        if hit[0] is not None:
            best = min(best, hit[3])
    return best - clearance


def under_tree(m, spec, fitted):
    """BVH of the body plus the gear this item is worn over (spec.over)."""
    Vs, Ts = [m.V], [m.T]
    n = len(m.V)
    for o in ([spec['over']] if isinstance(spec.get('over'), str) else spec.get('over', [])):
        if o in fitted:
            Vo, To = fitted[o]
            Vs.append(Vo)
            Ts.append(To + n)
            n += len(Vo)
    return make_tree(np.vstack(Vs), np.vstack(Ts))


def fit_back(m, obj, spec, fitted):
    """Backpacks: turned to face backward, real height, top at spec.top (landmark), leaned like the
    back, then moved forward until its back panel is `clearance` from the body / the vest under it."""
    L = m.L
    V = GearMesh(obj).V.copy()
    lo, hi = V.min(axis=0), V.max(axis=0)
    s = spec['height'] / (hi[2] - lo[2])
    V = (V - (lo + hi) / 2) * s
    V = V @ rot('Z', 180.0).T @ rot('X', -spec.get('lean', 0.0)).T
    top = landmark_value(L, spec['top']['target'], spec['top'].get('offset', 0.0))
    V = V + np.array([0.0, 0.5 - V[:, 1].min(), top - V[:, 2].max()])
    shift = contact_shift(V, under_tree(m, spec, fitted), (0.0, -1.0, 0.0), spec['clearance'])
    V = V + np.array([0.0, -shift, 0.0])
    anchor = np.array([0.0, float(V[:, 1].min()), float((V[:, 2].min() + V[:, 2].max()) / 2)])
    log(f'  back: scale {s:.4f}, panel at y={V[:, 1].min():.4f}, z {V[:, 2].min():.3f}..{V[:, 2].max():.3f}')
    return V, anchor, {'s': s, 'panel_y': float(V[:, 1].min()), 'A': rot('X', -spec.get('lean', 0.0)) @ rot('Z', 180.0) * s}


def fit_chest(m, obj, spec, fitted):
    """Front-mounted items (radio): real height, upright, at spec.at = [x, z], turned by spec.yaw,
    moved back until its back is `clearance` from the vest / body under it."""
    V = GearMesh(obj).V.copy()
    lo, hi = V.min(axis=0), V.max(axis=0)
    s = spec['height'] / (hi[2] - lo[2])
    V = (V - (lo + hi) / 2) * s
    V = V @ rot('Z', spec.get('yaw', 0.0)).T
    x, z = spec['at']
    V = V + np.array([x, -0.6 - V[:, 1].max(), z])
    shift = contact_shift(V, under_tree(m, spec, fitted), (0.0, 1.0, 0.0), spec['clearance'])
    V = V + np.array([0.0, shift, 0.0])
    anchor = np.array([x, float(V[:, 1].max()), z])
    log(f'  chest: scale {s:.4f}, back at y={V[:, 1].max():.4f}')
    return V, anchor, {'s': s, 'back_y': float(V[:, 1].max()), 'A': rot('Z', spec.get('yaw', 0.0)) * s}


# ---------------------------------------------------------------- skinned (vests, belts)

# Bones a skinned item may follow; every other body bone hands its weight to the nearest allowed
# ancestor (arms to the clavicle for a vest, the head to the neck, the legs to the hips ...).
ALLOWED = {
    'torso': ['Hips', 'Spine1', 'Spine2', 'Spine3', 'Neck', 'Clavicle_R', 'Clavicle_L'],
    'torso_arms': ['Hips', 'Spine1', 'Spine2', 'Spine3', 'Neck', 'Clavicle_R', 'Clavicle_L', 'UpperArm_R', 'UpperArm_L'],
    'belt': ['Hips', 'Spine1', 'Thigh_R', 'Thigh_L'],
    'coat': ['Hips', 'Spine1', 'Spine2', 'Spine3', 'Neck', 'Clavicle_R', 'Clavicle_L', 'UpperArm_R', 'UpperArm_L',
             'UpperArmTwist_R', 'UpperArmTwist_L', 'Forearm_R', 'Forearm_L', 'ForearmTwist_R', 'ForearmTwist_L',
             'ForearmTwist2_R', 'ForearmTwist2_L', 'Hand_R', 'Hand_L', 'Thigh_R', 'Thigh_L', 'Calf_R', 'Calf_L'],
}


def collapse_weights(m, W, allowed):
    """Body weights (n, groups) -> (n, allowed): each group to itself or its nearest allowed ancestor."""
    out = np.zeros((len(W), len(allowed)))
    for j, gname in enumerate(m.groups):
        b = m.arm.data.bones.get(gname)
        while b is not None and b.name not in allowed:
            b = b.parent
        if b is None:
            continue
        out[:, allowed.index(b.name)] += W[:, j]
    return out / np.maximum(out.sum(axis=1, keepdims=True), 1e-9)


def gear_graph(g):
    """Edge list of the welded gear mesh."""
    return g.E[:, 0], g.E[:, 1]


def smooth_weights(g, W, iterations=8, lam=0.5):
    a, b = gear_graph(g)
    deg = np.bincount(np.concatenate([a, b]), minlength=len(W)).astype(float)
    for _ in range(iterations):
        S = np.zeros_like(W)
        np.add.at(S, a, W[b])
        np.add.at(S, b, W[a])
        W = (1 - lam) * W + lam * S / np.maximum(deg, 1)[:, None]
    return W


def limit_influences(W, k=4, floor=0.01):
    idx = np.argsort(-W, axis=1)[:, k:]
    W = W.copy()
    np.put_along_axis(W, idx, 0.0, axis=1)
    W[W < floor] = 0.0
    return W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9)


def inner_extents(V, T, c, z):
    """Distances from (c, z) to the gear's inner surface along +x, -x, +y, -y (nan where open)."""
    tree = make_tree(V, T)
    o = Vector((c[0], c[1], z))
    out = []
    for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)):
        hit = tree.ray_cast(o, Vector(d), 3.0)
        out.append(hit[3] if hit[0] is not None else np.nan)
    return np.array(out)


def offset_field(m, g, V, clearance, iterations=4, sigma=0.025, max_pull=0.02):
    """Inner-surface offset field: every gear vertex facing the body is pushed out (or pulled in, at
    most max_pull) so it sits `clearance` from the body; the displacements are spread over the gear
    with a Gaussian of `sigma` m, so the shell keeps its thickness and pouches move with it."""
    for it in range(iterations):
        N = g.normals(V)
        loc, _, sd = m.nearest(V)
        nb = V - loc
        nb /= np.maximum(np.linalg.norm(nb, axis=1, keepdims=True), 1e-9)
        nb[sd < 0] *= -1  # inside: the outward body direction points the other way
        facing = np.einsum('ij,ij->i', N, nb) < 0  # gear normal against the body: inner side
        want = clearance - sd
        want = np.where(want < 0, np.maximum(want, -max_pull), want)
        src = np.nonzero(facing)[0]
        kd = kdtree.KDTree(len(src))
        for i, k in enumerate(src):
            kd.insert(V[k], i)
        kd.balance()
        D = np.zeros_like(V)
        for i, p in enumerate(V):
            acc = np.zeros(3)
            wsum = 0.0
            for (co, j, d) in kd.find_range(Vector(p), 3 * sigma):
                w = math.exp(-0.5 * (d / sigma) ** 2)
                k = src[j]
                acc += w * want[k] * nb[k]
                wsum += w
            if wsum > 0:
                D[i] = acc / wsum
        V = V + D
        log(f'    offset field {it + 1}: inner verts {len(src)}, push max {np.abs(want[src]).max() * 1000:.1f} mm, '
            f'inside before {int((sd < 0).sum())}')
    # Guarantee: nothing left inside the body (local pushes to the full clearance, smoothed over
    # the mesh graph, until no vertex is closer than half of it).
    for _ in range(4):
        loc, _, sd = m.nearest(V)
        bad = sd < clearance * 0.5
        if not bad.any():
            break
        nb = V - loc
        nb /= np.maximum(np.linalg.norm(nb, axis=1, keepdims=True), 1e-9)
        nb[sd < 0] *= -1
        push = np.where(bad, clearance - sd, 0.0)[:, None] * nb
        push = smooth_weights(g, push, iterations=2, lam=0.5)
        V = V + push
    return V


def fit_wrap(m, obj, spec, fitted):
    """Vests and belts: anisotropic fit of the inner surface to the body's sections, then the
    inner-surface offset field. Returns world-space vertices (skinned items have no anchor)."""
    L = m.L
    g = GearMesh(obj)
    V = g.V.copy()
    lo, hi = V.min(axis=0), V.max(axis=0)
    c = (lo + hi) / 2
    if spec['fit'] == 'torso':
        top = L['shoulder_top'] + spec.get('top_clear', 0.012)
        bottom = landmark_value(L, spec['bottom']['target'], spec['bottom'].get('offset', 0.0))
        sz = (top - bottom) / (hi[2] - lo[2])
        zmap = lambda z: (z - lo[2]) * sz + bottom  # noqa: E731
        ref = [L['spine3'][2] - f for f in spec.get('ref', (0.08, 0.14, 0.2))]
    else:
        centre = landmark_value(L, spec['centre']['target'], spec['centre'].get('offset', 0.0))
        sz = None
        ref = [centre + f for f in spec.get('ref', (-0.01, 0.0, 0.01))]
    # Inner half-sizes of the source at the reference levels vs the body's sections there.
    sxs, sys_, cxs, cys = [], [], [], []
    for i, zt in enumerate(ref):
        sec = m.section(zt)
        P = sec['points']
        bx = (P[:, 0].max() - P[:, 0].min()) / 2
        by = (P[:, 1].max() - P[:, 1].min()) / 2
        bc = np.array([(P[:, 0].max() + P[:, 0].min()) / 2, (P[:, 1].max() + P[:, 1].min()) / 2])
        # Source level: mapped back through the height fit (vests) or the band's own levels (belts).
        zs = (zt - bottom) / sz + lo[2] if sz else c[2] + spec.get('src_ref', (-0.05, 0.0, 0.05))[i] * (hi[2] - lo[2])
        e = inner_extents(V, g.T, c, zs)
        if not np.isnan(e[:2]).any():
            sxs.append((bx + spec['clearance']) / ((e[0] + e[1]) / 2))
            cxs.append((bc[0], c[0] + (e[0] - e[1]) / 2))
        if not np.isnan(e[2:]).any():
            sys_.append((by + spec['clearance']) / ((e[2] + e[3]) / 2))
            cys.append((bc[1], c[1] + (e[2] - e[3]) / 2))
    sx = float(np.median(sxs)) if sxs else float(np.median(sys_))
    sy = float(np.median(sys_)) if sys_ else sx
    if sz is None:
        sz = (sx + sy) / 2
        zmap = lambda z: (z - c[2]) * sz + centre  # noqa: E731
    bx_c = np.median([a for a, _ in cxs]) if cxs else 0.0
    gx_c = np.median([b for _, b in cxs]) if cxs else c[0]
    by_c = np.median([a for a, _ in cys]) if cys else 0.0
    gy_c = np.median([b for _, b in cys]) if cys else c[1]
    V = np.stack([(V[:, 0] - gx_c) * sx + bx_c, (V[:, 1] - gy_c) * sy + by_c, zmap(V[:, 2])], axis=1)
    log(f'  wrap affine: scale x {sx:.4f} y {sy:.4f} z {sz:.4f} (levels {len(sxs)}/{len(sys_)} measured)')
    V = offset_field(m, g, V, spec['clearance'], iterations=spec.get('iterations', 4), sigma=spec.get('sigma', 0.025),
                     max_pull=spec.get('max_pull', 0.02))
    loc, _, sd = m.nearest(V)
    info = {'scale': [sx, sy, sz], 'A': np.diag([sx, sy, sz]), 'inside': int((sd < 0).sum()), 'sd_min_mm': round(float(sd.min()) * 1000, 2),
            'sd_median_mm': round(float(np.median(sd)) * 1000, 1)}
    log(f"  wrap: { {k: v for k, v in info.items() if k != 'A'} }")
    return V, None, info


def skin_weights(m, g, V, allowed_key, caps=None):
    """Body weights at each gear vertex's nearest body point, collapsed to the allowed bones; `caps`
    ({bone base name: max}) limits a bone's share on both sides, the excess goes to its parent (a
    vest's armholes may follow the upper arm a little, never like a sleeve). Smoothed, 4 influences."""
    allowed = ALLOWED[allowed_key]
    loc, faces, _ = m.nearest(V)
    W = collapse_weights(m, m.bary_weights(V, faces, loc), allowed)
    for base, cap in (caps or {}).items():
        for name in (f'{base}_R', f'{base}_L'):
            if name in allowed:
                j = allowed.index(name)
                parent = m.arm.data.bones[name].parent.name
                k = allowed.index(parent)
                excess = np.maximum(W[:, j] - cap, 0.0)
                W[:, j] -= excess
                W[:, k] += excess
    W = smooth_weights(g, W, iterations=10, lam=0.5)
    return limit_influences(W), allowed


# ---------------------------------------------------------------- poses

def three_euler_quat(r):
    """three.js Euler 'XYZ' (degrees) -> Blender Quaternion (w, x, y, z): q = qx * qy * qz."""
    if len(r) == 4:
        return Quaternion((r[3], r[0], r[1], r[2]))
    x, y, z = (math.radians(a) / 2 for a in r)
    c1, c2, c3 = math.cos(x), math.cos(y), math.cos(z)
    s1, s2, s3 = math.sin(x), math.sin(y), math.sin(z)
    return Quaternion((c1 * c2 * c3 - s1 * s2 * s3, s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3))


def set_pose(arm, pose):
    arm.data.pose_position = 'POSE'
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    for name, r in (pose or {}).items():
        if name in arm.pose.bones:
            arm.pose.bones[name].rotation_quaternion = three_euler_quat(r)
    bpy.context.view_layer.update()


def evaluated(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    eo = obj.evaluated_get(deps)
    me = eo.to_mesh()
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', V)
    eo.to_mesh_clear()
    return V.reshape(-1, 3) @ np.array(obj.matrix_world)[:3, :3].T + np.array(obj.matrix_world)[:3, 3]


def pose_checks(m, obj, poses):
    """Skinned gear under the test poses: gear vertices inside the posed body (count, depth)."""
    out = {}
    set_pose(m.arm, None)
    m.arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    rest = evaluated(obj)
    for name, pose in poses.items():
        set_pose(m.arm, pose)
        Vb = evaluated(m.body)
        tree = make_tree(Vb, m.T)
        Vg = evaluated(obj)
        depth = np.zeros(len(Vg))
        for i, p in enumerate(Vg):
            loc, nrm, fi, d = tree.find_nearest(Vector(p))
            if (Vector(p) - loc).dot(nrm) < 0:
                depth[i] = d
        k = int(np.argmax(depth))
        # where (rest position of the deepest gear vertex) tells which body part comes through
        out[name] = {'inside': int((depth > 0.002).sum()), 'deepest_mm': round(float(depth[k]) * 1000, 1), 'of': len(Vg),
                     'where': [round(float(x), 3) for x in rest[k]] if depth[k] > 0 else None}
    set_pose(m.arm, None)
    m.arm.data.pose_position = 'REST'
    return out


# ---------------------------------------------------------------- export

def shrink_textures(obj, size):
    done = []
    for mat in obj.data.materials:
        if not mat or not mat.use_nodes:
            continue
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image and n.image not in done:
                im = n.image
                if max(im.size) > size:
                    im.scale(size, size)
                done.append(im)
    return [(im.name, tuple(im.size)) for im in done]


def export_rigid(obj, g, V_world, anchor, A, path):
    """The fitted mesh in its own frame (origin at the anchor), glTF Y-up, textures inside."""
    g.write(V_world - anchor)
    finish_normals(obj, A)
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True,
                              export_apply=False, export_animations=False, export_skins=False,
                              export_image_format='WEBP', export_image_quality=90)


def socket_transform(m, socket, anchor_blender):
    """Local transform under the socket bone that puts the gear frame (glTF axes) at the anchor."""
    S = m.sockets[socket]
    Rs = S[:3, :3]
    ps = S[:3, 3]
    a = B2G @ anchor_blender
    pos = Rs.T @ (a - ps)
    q = Quaternion(Matrix(Rs.T.tolist()).to_quaternion())
    q.normalize()
    return [round(float(x), 5) + 0.0 for x in pos], [round(float(x), 6) + 0.0 for x in (q.x, q.y, q.z, q.w)]  # + 0.0: no -0.0


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


# ---------------------------------------------------------------- main

DEBUG = '--debug' in sys.argv


def debug_glb(obj, path):
    """The object as it is (world space, glTF Y-up), untextured, for inspection renders."""
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True,
                              export_materials='NONE', export_skins=False, export_animations=False)


FITS = {'head': fit_head, 'face': fit_face, 'nvg': fit_nvg, 'back': fit_back, 'chest': fit_chest,
        'torso': fit_wrap, 'belt': fit_wrap}


def export_skinned(m, obj, g, V, W, allowed, A, path):
    """SkinnedMesh bound to the master armature (rest pose), bones named as the canonical skeleton."""
    g.write(V)
    finish_normals(obj, A)
    # Every vertex must be weighted (the exporter would add a 'neutral_bone' the body does not have):
    # an unweighted vertex takes the weights of its nearest weighted one.
    empty = W.sum(axis=1) < 0.5
    if empty.any():
        ok = np.nonzero(~empty)[0]
        kd = kdtree.KDTree(len(ok))
        for i, k in enumerate(ok):
            kd.insert(V[k], i)
        kd.balance()
        for i in np.nonzero(empty)[0]:
            W[i] = W[ok[kd.find(V[i])[1]]]
        log(f'  {int(empty.sum())} unweighted vertices took their nearest neighbour\'s weights')
    W = W[g.weld]  # welded -> the object's own vertices
    obj.vertex_groups.clear()
    for j, name in enumerate(allowed):
        ids = np.nonzero(W[:, j] > 0)[0]
        if len(ids) == 0:
            continue
        vg = obj.vertex_groups.new(name=name)
        for i in ids:
            vg.add([int(i)], float(W[i, j]), 'REPLACE')
    obj.parent = m.arm
    obj.matrix_parent_inverse = Matrix.Identity(4)
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = m.arm
    m.arm.data.pose_position = 'REST'
    for o in bpy.context.scene.objects:
        o.select_set(o in (obj, m.arm))
    bpy.context.view_layer.objects.active = m.arm
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True,
                              export_skins=True, export_def_bones=False, export_animations=False, export_apply=False,
                              export_image_format='WEBP', export_image_quality=90)


def run_item(m, cfg, item_id, spec, report, fitted, poses):
    t0 = time.time()
    src = os.path.join(rel(cfg['sources']), spec['src'])
    obj = import_gear(src, item_id)
    removed = cleanup(obj, spec)
    log(f'{item_id}: {len(obj.data.vertices)} verts after cleanup ({removed} removed)')
    if DEBUG:
        debug_glb(obj, os.path.join(rel(cfg['sources']), 'fit', f'{item_id}_clean.glb'))
    g = GearMesh(obj)
    V, anchor, info = FITS[spec['fit']](m, obj, spec, fitted)
    A = info.pop('A', np.eye(3))
    if DEBUG:
        g.write(V)
        debug_glb(obj, os.path.join(rel(cfg['sources']), 'fit', f'{item_id}_world.glb'))
        g.write(g.V)
    fitted[item_id] = (V.copy(), g.T.copy())
    np.savez(os.path.join(rel(cfg['sources']), 'fit', f'{item_id}_world.npz'), V=V, T=g.T)
    out_dir = os.path.join(rel(cfg['out']), spec['kind'])
    glb = os.path.join(out_dir, f'{item_id}.glb')
    textures = shrink_textures(obj, cfg.get('texture', 1024))
    if spec.get('socket'):
        export_rigid(obj, g, V, anchor, A, glb)
        pos, quat = socket_transform(m, spec['socket'], anchor)
        data = {'id': item_id, 'kind': spec['kind'], 'model': f'{item_id}.glb', 'attach': 'socket', 'socket': spec['socket'],
                'position': pos, 'quaternion': quat, 'scale': 1}
    else:
        W, allowed = skin_weights(m, g, V, spec.get('bones', spec['fit']), spec.get('caps'))
        info['bones'] = {b: round(float(W[:, j].sum() / len(W)), 3) for j, b in enumerate(allowed) if W[:, j].sum() > 0}
        export_skinned(m, obj, g, V, W, allowed, A, glb)
        if poses:
            info['poses'] = pose_checks(m, obj, poses)
            log(f"  poses: {info['poses']}")
        data = {'id': item_id, 'kind': spec['kind'], 'model': f'{item_id}.glb', 'attach': 'skinned'}
    # Data the fit doesn't make, kept in fit_gear.json so a re-run writes it back: covered body
    # regions, look versions (gear-variant.py folders) and ballistic protection.
    for key in ('hides', 'variants', 'armor'):
        if spec.get(key):
            data[key] = spec[key]
    write_json(os.path.join(out_dir, f'{item_id}.json'), data)
    info.update({'glb': os.path.relpath(glb, ROOT).replace(os.sep, '/'), 'bytes': os.path.getsize(glb),
                 'tris': len(obj.data.polygons), 'textures': textures, 'seconds': round(time.time() - t0, 1)})
    report[item_id] = info
    log(f'{item_id}: wrote {glb} ({info["bytes"] / 1e6:.2f} MB) {json.dumps({k: v for k, v in info.items() if k not in ("textures", "bones")}, default=float)}')
    obj.parent = None
    bpy.data.objects.remove(obj)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    items = [a for a in argv if not a.startswith('--')]
    cfg = json.load(open(os.path.join(HERE, 'fit_gear.json')))
    m = Master(cfg)
    report_path = os.path.join(rel(cfg['sources']), 'fit_report.json')
    report = json.load(open(report_path)) if os.path.exists(report_path) else {}
    report['landmarks'] = {k: (np.round(v, 4).tolist() if isinstance(v, np.ndarray) else v) for k, v in m.L.items()}
    # --set=key=json overrides a fit parameter of the items run (experiments; the JSON stays the truth)
    sets = [a[6:].split('=', 1) for a in argv if a.startswith('--set=')]
    os.makedirs(os.path.join(rel(cfg['sources']), 'fit'), exist_ok=True)
    # Gear fitted earlier (items worn over other items find them here).
    fitted = {}
    for k in cfg['items']:
        f = os.path.join(rel(cfg['sources']), 'fit', f'{k}_world.npz')
        if os.path.exists(f):
            z = np.load(f)
            fitted[k] = (z['V'], z['T'])
    poses = {}
    if '--no-poses' not in argv:
        pdir = rel('production/assets/src/chars/master/rig/poses')
        for n in cfg.get('poses', ['legs', 'raise', 'elbows']):
            poses[n] = json.load(open(os.path.join(pdir, f'{n}.json')))
    for item_id in items or list(cfg['items']):
        spec = dict(cfg['items'][item_id])
        for k, v in sets:
            spec[k] = json.loads(v)
        run_item(m, cfg, item_id, spec, report, fitted, poses)
        with open(report_path, 'w') as f:
            json.dump(report, f, indent=1, default=float)


if __name__ == '__main__':
    main()
