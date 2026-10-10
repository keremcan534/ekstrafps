"""The Warden's greatcoat, built from the master body itself, so it fits by construction:

  node scripts/blender.mjs scripts/blender/build_coat.py build     -> gear/warden_coat/coat_base.glb (UV'd, for texturing)
  node scripts/meshy-gear.mjs retexture-file warden_coat <coat_base.glb> "<prompt>"   (Meshy paints it on these UVs)
  node scripts/blender.mjs scripts/blender/build_coat.py finish [<textured.glb>]
                                    -> public/assets/characters/gear/coats/warden_coat.glb + .json
                                       (the painted coat: COAT['texture'] unless given)

Shape (all numbers in COAT below, landmarks from the skeleton and the mesh):
  shell   the body's torso and arms (a decimated copy of the rest mesh) cut at the neck, the wrists
          and the hips, pushed out along the normals by the cloth thickness
  skirt   rings from the hip cut down to mid-calf: in every direction the farther of the hip ring
          (flared toward the hem) and the convex hull of both legs' section plus the thickness, so
          it hangs as one skirt around both legs (no tube per leg)
  collar  a standing band on the neck cut, higher at the back
Weights: the shell takes the body's weights at its nearest body point (bones of the coat set: the
fingers hand theirs to the hand, the head to the neck). The skirt hangs: its back and sides from the
hips (Hips share 1 at the hip cut, COAT.hem_hips at the hem - a long skirt on the thighs swings out
like a lever when they lift - the back a little less, so a leg stepping back takes it along); its front lies on the legs down to the knees - there it takes the
body's own weights, moving exactly as the trousers under it, so no knee comes through - and below
them is half thigh, half calf, so in a crouch it falls straight down from the knee instead of
ballooning forward or following the shin back under the thigh. Left/right is a smooth split, so it
never tears between the legs. Smoothed over the coat, 4 influences. Test poses: rig/poses/crouch.json (the game's crouch)
and stride.json.
The same skeleton as the body (MASTER_HUMANOID_RIG, rest pose); no Warden skeleton.
"""
import bmesh
import bpy
import json
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fit_gear as fg  # noqa: E402

COAT = {
    'decimate': 0.22,        # of the 116k-triangle rest body
    'thickness': 0.016,      # cloth over the uniform (torso)
    'sleeve': 0.012,         # cloth over the uniform (arms)
    'neck_gap': 0.03,        # the collar opening: neck half-width + this
    'drape': 80,             # Taubin iterations that turn the body's offset into cloth
    'wrist_cut': 0.035,      # m up the forearm from the Hand bone head
    'skirt_top': 1.0,        # z of the hip cut where the skirt starts
    'hem': 0.38,             # z of the hem (mid-calf)
    'rings': 18,
    'flare': 0.24,           # the hem is this much wider than the hip ring
    'hem_hips': 0.85,        # Hips share of the skirt's sides at the hem
    'hem_hips_back': 0.3,    # ... and straight behind (a leg stepping back takes the back panel along)
    'knee_calf': 0.5,        # calf share of the front panel's leg weights below the knee
    'belt_z': 1.17,          # the coat's belt (natural waist)
    'collar_back': 0.065, 'collar_front': 0.03, 'collar_out': 0.012,
    # The painted coat (a Meshy retexture of coat_base.glb on its own UVs; gear.json warden_coat r2).
    'texture': 'production/assets/src/chars/master/gear/warden_coat/r2_textured.glb',
}
OUT_SRC = 'production/assets/src/chars/master/gear/warden_coat'
OUT = 'public/assets/characters/gear/coats'


def log(*a):
    print('[coat]', *a, flush=True)


def hull2d(P):
    """Convex hull (counter-clockwise) of 2D points (monotone chain)."""
    P = sorted(map(tuple, P))
    if len(P) < 3:
        return np.array(P)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in P:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(P):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def ray_hull(H, c, d):
    """Distance from c along unit d to the boundary of convex polygon H (c inside)."""
    best = np.inf
    for i in range(len(H)):
        a, b = H[i], H[(i + 1) % len(H)]
        e = b - a
        den = d[0] * e[1] - d[1] * e[0]
        if abs(den) < 1e-12:
            continue
        t = ((a[0] - c[0]) * e[1] - (a[1] - c[1]) * e[0]) / den
        u = ((a[0] - c[0]) * d[1] - (a[1] - c[1]) * d[0]) / den
        if t > 0 and -1e-9 <= u <= 1 + 1e-9:
            best = min(best, t)
    return best


def build(m):
    arm = m.arm
    bones = arm.data.bones
    # Decimated copy of the rest body.
    src = m.body
    obj = src.copy()
    obj.data = src.data.copy()
    obj.name = obj.data.name = 'warden_coat'
    obj.modifiers.clear()
    obj.vertex_groups.clear()
    obj.parent = None
    bpy.context.scene.collection.objects.link(obj)
    dec = obj.modifiers.new('Decimate', 'DECIMATE')
    dec.ratio = COAT['decimate']
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=dec.name)
    # Cut: keep the torso and arms between the neck, the wrists and the hip line. The neck hole is a
    # cylinder round the neck (a level cut would also take the tops of the shoulders), the wrists and
    # the hips are planes (bisected, so the cuffs and the hip line are clean loops).
    sec = m.section(1.645, near=np.array([0.0, 0.02, 1.645]), radius=0.12)  # the neck alone, above the trapezius
    neck_c = np.array([0.0, float(sec['c'][1])])
    neck_r = float((sec['points'][:, 0].max() - sec['points'][:, 0].min()) / 2) + COAT['neck_gap']
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                           plane_co=(0, 0, COAT['skirt_top']), plane_no=(0, 0, -1), clear_outer=True)
    for s_ in ('R', 'L'):
        hand = np.array(bones[f'Hand_{s_}'].head_local[:])
        fore = np.array(bones[f'Forearm_{s_}'].head_local[:])
        axis = (hand - fore) / np.linalg.norm(hand - fore)
        co = hand - axis * COAT['wrist_cut']
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                               plane_co=tuple(co), plane_no=tuple(axis), clear_outer=True)
    kill = [v for v in bm.verts if v.co.z > 1.5 and math.hypot(v.co.x - neck_c[0], v.co.y - neck_c[1]) < neck_r]
    kill += [v for v in bm.verts if v.co.z > 1.66]
    bmesh.ops.delete(bm, geom=list(set(kill)), context='VERTS')
    # Keep the biggest piece (the cuts can leave crumbs).
    bm.verts.ensure_lookup_table()
    seen, comps = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        comp, stack = [v], [v]
        seen.add(v)
        while stack:
            a = stack.pop()
            for e in a.link_edges:
                b = e.other_vert(a)
                if b not in seen:
                    seen.add(b)
                    comp.append(b)
                    stack.append(b)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    for c in comps[1:]:
        bmesh.ops.delete(bm, geom=c, context='VERTS')
    # Offset along the normals: cloth thickness, thinner on the sleeves.
    bm.normal_update()
    for v in bm.verts:
        arm_side = abs(v.co.x) > 0.21 and v.co.z < 1.52
        v.co += v.normal * (COAT['sleeve'] if arm_side else COAT['thickness'])
    # Small holes the cuts left (a few vertices) get filled; then the boundary loops are the hip line
    # (lowest), the neck opening (the big loop round the neck axis) and the two cuffs.
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=10)
    bm.edges.ensure_lookup_table()
    boundary = [e for e in bm.edges if e.is_boundary]
    loops = [L for L in edge_loops(boundary) if len(L) > 10]
    loops.sort(key=lambda L: np.mean([v.co.z for v in L]))
    hip = loops[0]
    neck = min((L for L in loops if np.mean([v.co.z for v in L]) > 1.45),
               key=lambda L: np.mean([math.hypot(v.co.x - neck_c[0], v.co.y - neck_c[1]) for v in L]))
    log(f'shell: {len(bm.verts)} verts, boundary loops {[len(L) for L in loops]} (hip {len(hip)}, neck {len(neck)})')
    # Both openings are star-shaped round the body axis: order them by angle (a walk along the
    # boundary can wander where two cut holes touch).
    neck = sorted(neck, key=lambda v: math.atan2(v.co.y - neck_c[1], v.co.x - neck_c[0]))
    hc = np.mean([v.co[:] for v in hip], axis=0)
    hip = sorted(hip, key=lambda v: math.atan2(v.co.y - hc[1], v.co.x - hc[0]))
    smooth_loop(neck, 6)
    skirt(m, bm, hip)
    collar(bm, neck)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    drape(m, bm)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def smooth_loop(loop, iterations):
    """Laplacian smoothing of a closed vertex loop along itself (a ragged cut becomes a clean edge)."""
    n = len(loop)
    P = np.array([v.co[:] for v in loop])
    for _ in range(iterations):
        P = 0.5 * P + 0.25 * (np.roll(P, 1, axis=0) + np.roll(P, -1, axis=0))
    for v, p in zip(loop, P):
        v.co = p


def drape(m, bm):
    """Wool, not a second skin: Taubin-smooth the whole coat (muscles, seams and the waistband ridge
    of the body under it go away), then push anything closer to the body than the cloth thickness
    back out along the body's outward direction; twice."""
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    V = np.array([v.co[:] for v in bm.verts])
    E = np.array([[e.verts[0].index, e.verts[1].index] for e in bm.edges])
    deg = np.bincount(E.ravel(), minlength=len(V)).astype(float)

    def umbrella(X):
        S = np.zeros_like(X)
        np.add.at(S, E[:, 0], X[E[:, 1]])
        np.add.at(S, E[:, 1], X[E[:, 0]])
        return S / np.maximum(deg, 1)[:, None]
    sleeve = (np.abs(V[:, 0]) > 0.21) & (V[:, 2] < 1.52) & (V[:, 2] > COAT['skirt_top'])
    want = np.where(sleeve, COAT['sleeve'], COAT['thickness'])
    for rnd, its in enumerate((COAT['drape'], 6)):
        for _ in range(its):
            V = V + 0.5 * (umbrella(V) - V)
            V = V - 0.53 * (umbrella(V) - V)
        loc, _, sd = m.nearest(V)
        nb = V - loc
        nb /= np.maximum(np.linalg.norm(nb, axis=1, keepdims=True), 1e-9)
        nb[sd < 0] *= -1
        low = sd < want
        V[low] += nb[low] * (want[low] - sd[low])[:, None]
        log(f'drape {rnd + 1}: pushed {int(low.sum())} verts back out')
    for v, p in zip(bm.verts, V):
        v.co = p


def edge_loops(edges):
    """Chain boundary edges into closed vertex loops."""
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, loops = set(), []
    for start in adj:
        if start in seen:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nxt = [x for x in adj[cur] if x is not prev and x not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append(loop)
    return loops


def skirt(m, bm, hip):
    """Rings from the hip loop down to the hem, bridged with quads."""
    P0 = np.array([v.co[:] for v in hip])
    c = np.array([0.0, float(np.median(P0[:, 1]))])
    ang = np.arctan2(P0[:, 1] - c[1], P0[:, 0] - c[0])
    r0 = np.hypot(P0[:, 0] - c[0], P0[:, 1] - c[1])
    z0 = float(P0[:, 2].mean())
    prev = list(hip)
    zs = np.linspace(z0, COAT['hem'], COAT['rings'] + 1)[1:]
    for k, z in enumerate(zs):
        t = (z0 - z) / (z0 - COAT['hem'])
        sec_pts = []
        for s in (-1, 1):  # each leg's section at z (or the hips above the crotch)
            sec = m.section(z, near=np.array([s * 0.12, 0.02, z]), radius=0.2)
            if sec is not None:
                sec_pts.append(sec['points'][:, :2])
        H = hull2d(np.vstack(sec_pts)) if sec_pts else None
        ring = []
        for i, a in enumerate(ang):
            d = np.array([math.cos(a), math.sin(a)])
            r = r0[i] * (1 + COAT['flare'] * t)
            if H is not None and len(H) >= 3:
                r = max(r, ray_hull(H, c, d) + COAT['thickness'] + 0.01 * t)
            p = c + d * r
            ring.append(bm.verts.new((p[0], p[1], z)))
        n = len(ring)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((prev[i], prev[j], ring[j], ring[i]))
        prev = ring
    bm.normal_update()


def collar(bm, neck):
    P = np.array([v.co[:] for v in neck])
    c = np.array([0.0, float(P[:, 1].mean())])
    prev = list(neck)
    for k, t in enumerate((0.35, 0.7, 1.0)):
        ring = []
        for v in neck:
            p = np.array(v.co[:])
            d = p[:2] - c
            r = np.linalg.norm(d)
            d = d / max(r, 1e-9)
            back = max(0.0, d[1])  # +y is the back
            h = COAT['collar_front'] + (COAT['collar_back'] - COAT['collar_front']) * back
            q = c + d * (r + COAT['collar_out'] * t)
            ring.append(bm.verts.new((q[0], q[1], p[2] + h * t)))
        n = len(ring)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((prev[i], prev[j], ring[j], ring[i]))
        prev = ring
    bm.normal_update()


def coat_weights(m, g, V):
    """Shell: the body's weights at the nearest body point; skirt: Hips blended into the thigh of
    its side. Both then smoothed together over the coat."""
    allowed = fg.ALLOWED['coat']
    loc, faces, _ = m.nearest(V)
    W = fg.collapse_weights(m, m.bary_weights(V, faces, loc), allowed)
    z0 = COAT['skirt_top']
    skirt = V[:, 2] < z0 - 0.005
    t = np.clip((z0 - V[:, 2]) / (z0 - COAT['hem']), 0, 1)
    cy = float(np.median(V[skirt, 1])) if skirt.any() else 0.0
    ang = np.arctan2(V[:, 1] - cy, V[:, 0])
    front = np.clip(-np.sin(ang), 0, 1)  # 1 straight ahead (-y), 0 at the sides and the back
    # Back and sides hang from the hips; the front hands over to the thighs fast (it lies on them).
    back = np.clip(np.sin(ang), 0, 1)
    hem_hips = (COAT['hem_hips'] + (COAT['hem_hips_back'] - COAT['hem_hips']) * back) * (1 - front)
    hips = 1 - (1 - hem_hips) * t ** (0.5 - 0.3 * front)
    # Below the knee the front is half thigh, half calf: it hangs straight down from the knee.
    knee = np.mean([m.arm.data.bones[f'Calf_{s}'].head_local.z for s in 'RL'])
    calf = COAT['knee_calf'] * front * np.clip((knee - 0.04 - V[:, 2]) / 0.14, 0, 1)
    right = 0.5 - 0.5 * np.tanh(V[:, 0] / 0.05)  # x < 0 is the right side
    S = np.zeros_like(W)
    S[:, allowed.index('Hips')] = hips
    for side, share in (('R', right), ('L', 1 - right)):
        S[:, allowed.index(f'Thigh_{side}')] = (1 - hips) * (1 - calf) * share
        S[:, allowed.index(f'Calf_{side}')] = (1 - hips) * calf * share
    # Over the legs, down to the knee: the trousers' own weights.
    fw = (np.clip(1.6 * front - 0.3, 0, 1) * np.clip((V[:, 2] - (knee - 0.12)) / 0.1, 0, 1))[:, None]
    S = fw * W + (1 - fw) * S
    W[skirt] = S[skirt]
    W = fg.smooth_weights(g, W, iterations=12, lam=0.5)
    return fg.limit_influences(W), allowed


def material_images(mat):
    """(base colour image, metallic-roughness image) of a glTF-imported Principled material."""
    base = mr = None
    for n in mat.node_tree.nodes:
        if n.type != 'TEX_IMAGE' or not n.image:
            continue
        for link in n.outputs['Color'].links:
            to = link.to_node
            if link.to_socket.name == 'Base Color':
                base = n.image
            elif to.type in ('SEPARATE_COLOR', 'SEPRGB', 'SEPARATE_RGB'):
                mr = n.image
    return base, mr


def paint_details(obj, mat):
    """The Warden's coat details the texturing does not draw, painted in texture space from 3D
    position: a leather belt at the natural waist with a metal buckle, and two rows of three
    gunmetal buttons (double-breasted front). Every texel of every triangle is located in 3D by
    its barycentric coordinates, so the UV layout does not matter."""
    base, mr = material_images(mat)
    if base is None:
        return 0
    me = obj.data
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data
    W, H = base.size
    C = np.array(base.pixels[:]).reshape(H, W, 4)
    R = np.array(mr.pixels[:]).reshape(mr.size[1], mr.size[0], 4) if mr is not None else None
    sy = (R.shape[0] / H) if R is not None else 1
    V = np.array([v.co[:] for v in me.vertices])
    front_y = -0.05
    belt_z, belt_h = COAT['belt_z'], 0.022
    buttons = [(sx * 0.068, z) for sx in (-1, 1) for z in (1.24, 1.33, 1.42)]
    painted = 0
    for t in me.loop_triangles:
        P = V[list(t.vertices)]
        if P[:, 2].max() < belt_z - 0.05 or P[:, 2].min() > 1.47 or abs(P[:, 0]).min() > 0.26:
            continue
        T = np.array([uv[li].uv[:] for li in t.loops]) * np.array([W, H])
        x0, y0 = np.floor(T.min(axis=0)).astype(int)
        x1, y1 = np.ceil(T.max(axis=0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1 + 1, W)), np.arange(max(y0, 0), min(y1 + 1, H)))
        Q = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], axis=1)
        a, b, c = T
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (Q[:, 0] - c[0]) + (c[0] - b[0]) * (Q[:, 1] - c[1])) / den
        l2 = ((c[1] - a[1]) * (Q[:, 0] - c[0]) + (a[0] - c[0]) * (Q[:, 1] - c[1])) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.01) & (l2 >= -0.01) & (l3 >= -0.01)
        if not inside.any():
            continue
        Q, l1, l2, l3 = Q[inside], l1[inside], l2[inside], l3[inside]
        X = l1[:, None] * P[0] + l2[:, None] * P[1] + l3[:, None] * P[2]
        px, py = Q[:, 0].astype(int), Q[:, 1].astype(int)
        belt = (np.abs(X[:, 2] - belt_z) < belt_h) & (np.abs(X[:, 0]) < 0.25)
        buckle = belt & (X[:, 1] < front_y) & (np.abs(X[:, 0]) < 0.03) & (np.abs(X[:, 2] - belt_z) < belt_h + 0.008)
        ring = buckle & ((np.abs(X[:, 0]) > 0.019) | (np.abs(X[:, 2] - belt_z) > belt_h - 0.006))
        btn = np.zeros(len(X), bool)
        for bx, bz in buttons:
            btn |= (X[:, 1] < front_y) & (np.hypot(X[:, 0] - bx, X[:, 2] - bz) < 0.011)
        for mask, col, rough, metal in ((belt & ~buckle, (0.035, 0.03, 0.028), 0.45, 0.0),
                                        (buckle & ~ring, (0.03, 0.028, 0.026), 0.45, 0.0),
                                        (ring, (0.30, 0.30, 0.31), 0.3, 0.9),
                                        (btn, (0.22, 0.22, 0.235), 0.3, 0.9)):
            if mask.any():
                C[py[mask], px[mask], :3] = col
                painted += int(mask.sum())
                if R is not None:
                    ry = np.clip((py[mask] * sy).astype(int), 0, R.shape[0] - 1)
                    rx = np.clip((px[mask] * R.shape[1] / W).astype(int), 0, R.shape[1] - 1)
                    R[ry, rx, 1] = rough
                    R[ry, rx, 2] = metal
    base.pixels.foreach_set(C.astype(np.float32).ravel())
    base.update()
    if R is not None:
        mr.pixels.foreach_set(R.astype(np.float32).ravel())
        mr.update()
    return painted


def main():
    stage = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'build'
    cfg = json.load(open(os.path.join(HERE, 'fit_gear.json')))
    os.makedirs(fg.rel(OUT_SRC), exist_ok=True)
    if stage == 'build':
        m = fg.Master(cfg)
        obj = build(m)
        # UVs for texturing: Smart UV Project on the whole coat.
        for o in bpy.context.scene.objects:
            o.select_set(o is obj)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
        bpy.ops.object.mode_set(mode='OBJECT')
        mat = bpy.data.materials.new('warden_coat')
        mat.use_backface_culling = False
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        path = fg.rel(os.path.join(OUT_SRC, 'coat_base.glb'))
        bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True,
                                  export_skins=False, export_animations=False)
        bpy.ops.wm.save_as_mainfile(filepath=fg.rel(os.path.join(OUT_SRC, 'coat_base.blend')))
        log(f'coat base: {len(obj.data.vertices)} verts, {tris} tris -> {path}')
    else:
        # finish: our coat (geometry, UVs) + the textures Meshy painted on those UVs, skinned.
        rest = sys.argv[sys.argv.index('--') + 2:]
        textured = rest[0] if rest else COAT['texture']
        # The saved build scene: the master (armature + body) and the coat.
        m = fg.Master(dict(cfg, master=dict(cfg['master'], blend=OUT_SRC + '/coat_base.blend')))
        obj = bpy.data.objects['warden_coat']
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=fg.rel(textured))
        new = [o for o in bpy.data.objects if o not in before]
        tm = next(o for o in new if o.type == 'MESH').data.materials[0]
        tm.name = 'warden_coat'
        tm.use_backface_culling = False
        obj.data.materials.clear()
        obj.data.materials.append(tm)
        for o in new:
            bpy.data.objects.remove(o)
        # Meshy-6 adds an emission map; for wool it is black: drop it (one 1K map less in the GLB).
        bsdf = next(n for n in tm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        for name in ('Emission Color', 'Emission'):
            if name in bsdf.inputs:
                for link in list(bsdf.inputs[name].links):
                    tm.node_tree.links.remove(link)
                bsdf.inputs[name].default_value = (0, 0, 0, 1)
        fg.shrink_textures(obj, cfg.get('texture', 1024))
        log(f'painted {paint_details(obj, tm)} detail texels (belt, buckle, buttons)')
        g = fg.GearMesh(obj)
        V = g.V.copy()
        W, allowed = coat_weights(m, g, V)
        path = fg.rel(os.path.join(OUT, 'warden_coat.glb'))
        fg.export_skinned(m, obj, g, V, W, allowed, np.eye(3), path)
        poses = {n: json.load(open(fg.rel(f'production/assets/src/chars/master/rig/poses/{n}.json'))) for n in cfg.get('poses', [])}
        checks = fg.pose_checks(m, obj, poses)
        # Plates under the coat (the old commander's heavier kit): the thorax takes them.
        data = {'id': 'warden_coat', 'kind': 'coats', 'model': 'warden_coat.glb', 'attach': 'skinned',
                'hides': ['torso', 'upper_arms', 'forearms', 'thighs'],
                'armor': {'zone': 'thorax', 'surface': 'armor', 'armor': 60}}
        fg.write_json(fg.rel(os.path.join(OUT, 'warden_coat.json')), data)
        rep_path = fg.rel(os.path.join(cfg['sources'], 'fit_report.json'))
        rep = json.load(open(rep_path)) if os.path.exists(rep_path) else {}
        rep['warden_coat'] = {'glb': os.path.relpath(path, fg.ROOT).replace(os.sep, '/'), 'bytes': os.path.getsize(path),
                              'tris': sum(len(p.vertices) - 2 for p in obj.data.polygons), 'poses': checks,
                              'bones': {b: round(float(W[:, j].mean()), 3) for j, b in enumerate(allowed) if W[:, j].sum() > 0},
                              'params': COAT}
        json.dump(rep, open(rep_path, 'w'), indent=1, default=float)
        log(f'coat: {path} ({os.path.getsize(path) / 1e6:.2f} MB), poses {checks}')


if __name__ == '__main__':
    main()
