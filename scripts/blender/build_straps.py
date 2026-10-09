"""Shoulder straps for the PMC backpack, laid on the master body and the plate carrier under them
(they fit by construction) and skinned like the carrier:

  node scripts/blender.mjs scripts/blender/build_straps.py
  -> public/assets/characters/gear/backpacks/pmc_backpack_straps.glb (+ .json; the colour
     versions' base_color.webp are written by scripts/gear-variant.py --solid)

Path, per side: from the backpack's front panel just under its top (its fit: fit_gear.json
pmc_backpack + fit_report.json), up the back, over the shoulder and down the chest to the
carrier's front - control points found by rays onto the body + carrier, a smooth curve through
them laid back onto that surface (STRAP.gap off it). A flat webbing band (STRAP.width x thick)
along it. Weights: the body's at each vertex's nearest body point on the carrier's bones
(torso_arms, UpperArm capped like the carrier's), smoothed, 4 influences. One flat webbing colour
per look, the backpack's darkened coyote by default.
"""
import bmesh
import bpy
import json
import os
import sys

import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fit_gear as fg  # noqa: E402

STRAP = {
    'width': 0.045, 'thick': 0.007,
    'gap': 0.004,             # off the surface under it
    'x_back': 0.075,          # where it leaves the backpack (m off the midline)
    'x_shoulder': 0.105,      # over the trapezius
    'x_front': 0.095,         # down the chest
    'front_z': [1.47, 1.39, 1.31],
    'samples': 36,
}
COLOUR = (112, 95, 68)  # webbing: the backpack's coyote (127, 107, 77), a shade darker
OUT = 'public/assets/characters/gear/backpacks'


def log(*a):
    print('[straps]', *a, flush=True)


def gear_surface(path):
    """A fitted gear GLB's triangles in the master's rest space (Blender coordinates)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=fg.rel(path))
    new = [o for o in bpy.data.objects if o not in before]
    Vs, Ts, n = [], [], 0
    for o in new:
        if o.type == 'MESH' and not o.name.startswith('Icosphere'):
            me = o.data
            me.calc_loop_triangles()
            M = np.array(o.matrix_world)
            V = np.array([(M @ np.array([*v.co, 1.0]))[:3] for v in me.vertices])
            T = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
            Vs.append(V)
            Ts.append(T + n)
            n += len(V)
    for o in new:
        bpy.data.objects.remove(o)
    return np.vstack(Vs), np.vstack(Ts)


def catmull_rom(P, n):
    """n points along a centripetal Catmull-Rom curve through P, evenly spaced by arc length."""
    P = np.asarray(P, float)
    Q = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    dense = []
    for i in range(1, len(Q) - 2):
        p0, p1, p2, p3 = Q[i - 1], Q[i], Q[i + 1], Q[i + 2]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        for t in np.linspace(t1, t2, 40, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            dense.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    dense.append(P[-1])
    D = np.array(dense)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(D, axis=0), axis=1))])
    return np.array([np.array([np.interp(u, s, D[:, k]) for k in range(3)]) for u in np.linspace(0, s[-1], n)])


def main():
    cfg = json.load(open(os.path.join(HERE, 'fit_gear.json')))
    m = fg.Master(cfg)
    L = m.L
    spec = cfg['items']['pmc_backpack']
    fit = json.load(open(fg.rel(os.path.join(cfg['sources'], 'fit_report.json'))))['pmc_backpack']
    top = fg.landmark_value(L, spec['top']['target'], spec['top'].get('offset', 0.0))
    panel_y = fit['panel_y']
    Vc, Tc = gear_surface('public/assets/characters/gear/vests/plate_carrier.glb')
    V = np.vstack([m.V, Vc])
    T = np.vstack([m.T, Tc + len(m.V)])
    tree = fg.make_tree(V, T)
    off = STRAP['gap'] + STRAP['thick'] / 2

    def ray(origin, direction):
        hit = tree.ray_cast(Vector(origin), Vector(direction), 3.0)
        if hit[0] is None:
            raise RuntimeError(f'strap ray missed from {origin} along {direction}')
        return np.array(hit[0][:])

    def onto(p):
        loc, nrm, _, _ = tree.find_nearest(Vector(p))
        n = np.array(nrm[:])
        # The outward side: away from the body's vertical axis (the trapezius' top: up).
        c = np.array([0.0, 0.03, p[2]])
        if n @ (np.array(loc[:]) - c) < 0 and n[2] < 0.5:
            n = -n
        return np.array(loc[:]) + n * off, n

    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    for s in (-1.0, 1.0):  # x < 0 is the right side
        P = [np.array([s * STRAP['x_back'], panel_y - off, top - 0.02])]
        P.append(ray([s * 0.09, 1.0, top + 0.02], [0, -1, 0]) + np.array([0, off, 0]))
        P.append(ray([s * STRAP['x_shoulder'], 0.035, 2.3], [0, 0, -1]) + np.array([0, 0, off]))
        for z in STRAP['front_z']:
            P.append(ray([s * STRAP['x_front'], -1.0, z], [0, 1, 0]) - np.array([0, off, 0]))
        C = catmull_rom(P, STRAP['samples'])
        # Laid back onto the surface (the first point stays at the backpack), smoothed, laid again.
        N = np.zeros_like(C)
        for _ in range(3):
            for i in range(1, len(C)):
                C[i], N[i] = onto(C[i])
            C[1:-1] = 0.5 * C[1:-1] + 0.25 * (C[:-2] + C[2:])
        for i in range(1, len(C)):
            C[i], N[i] = onto(C[i])
        N[0] = N[1]
        ring = []
        for i, p in enumerate(C):
            t = C[min(i + 1, len(C) - 1)] - C[max(i - 1, 0)]
            t /= np.linalg.norm(t)
            w = np.cross(t, N[i])
            w /= np.linalg.norm(w)
            n = np.cross(w, t)
            hw, ht = STRAP['width'] / 2, STRAP['thick'] / 2
            ring.append([bm.verts.new(tuple(p + a * w * hw + b * n * ht)) for a, b in ((1, 1), (-1, 1), (-1, -1), (1, -1))])
        last = len(ring) - 1
        for i in range(last):
            for k in range(4):
                f = bm.faces.new((ring[i][k], ring[i][(k + 1) % 4], ring[i + 1][(k + 1) % 4], ring[i + 1][k]))
                for loop, (u, v) in zip(f.loops, ((k / 4, i / last), ((k + 1) / 4, i / last), ((k + 1) / 4, (i + 1) / last), (k / 4, (i + 1) / last))):
                    loop[uv].uv = (u, v)
        for end in (ring[0], ring[-1][::-1]):
            f = bm.faces.new(end)
            for loop in f.loops:
                loop[uv].uv = (0.5, 0.5)
        log(f'side {"R" if s < 0 else "L"}: length {np.sum(np.linalg.norm(np.diff(C, axis=0), axis=1)):.3f} m, control {np.round(P, 3).tolist()}')
    bm.normal_update()
    me = bpy.data.meshes.new('pmc_backpack_straps')
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new('pmc_backpack_straps', me)
    bpy.context.scene.collection.objects.link(obj)
    # One flat webbing colour, as an 8 x 8 base colour texture (colour versions swap it): written
    # to a file first (the exporter does not see pixels set on a generated image).
    gen = bpy.data.images.new('straps_base', 8, 8, alpha=False)
    gen.pixels = [c for _ in range(64) for c in (*[x / 255 for x in COLOUR], 1.0)]  # (a byte image: sRGB values)
    src_png = fg.rel(os.path.join(cfg['sources'], 'pmc_backpack_straps_base.png'))
    gen.filepath_raw = src_png
    gen.file_format = 'PNG'
    gen.save()
    img = bpy.data.images.load(src_png)
    img.name = 'straps_base'
    mat = bpy.data.materials.new('pmc_backpack_straps')
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = img
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    me.materials.append(mat)
    g = fg.GearMesh(obj)
    Vg = g.V.copy()
    W, allowed = fg.skin_weights(m, g, Vg, 'torso_arms', caps={'UpperArm': 0.35})
    path = fg.rel(os.path.join(OUT, 'pmc_backpack_straps.glb'))
    fg.export_skinned(m, obj, g, Vg, W, allowed, np.eye(3), path)
    poses = {n: json.load(open(fg.rel(f'production/assets/src/chars/master/rig/poses/{n}.json'))) for n in cfg.get('poses', [])}
    checks = fg.pose_checks(m, obj, poses)
    fg.write_json(fg.rel(os.path.join(OUT, 'pmc_backpack_straps.json')), {
        'id': 'pmc_backpack_straps', 'kind': 'backpacks', 'model': 'pmc_backpack_straps.glb', 'attach': 'skinned',
        'variants': {'pmc_green': 'pmc_backpack_straps/pmc_green', 'pmc_grey': 'pmc_backpack_straps/pmc_grey'},
    })
    log(f'{path}: {len(me.polygons)} faces, poses {checks}')


if __name__ == '__main__':
    main()
