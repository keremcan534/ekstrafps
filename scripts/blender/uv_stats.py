"""UV layout stats of a GLB: island count, coverage and overlap (texels covered by more than one triangle).

  node scripts/blender.mjs scripts/blender/uv_stats.py <model.glb> [--res=1024]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import numpy as np  # noqa: E402

import humanoid as hu  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
res = int(next((a[6:] for a in argv[1:] if a.startswith('--res=')), 1024))
obj = hu.import_glb(os.path.abspath(argv[0]))
bm = bmesh.new()
bm.from_mesh(obj.data)
uv = bm.loops.layers.uv.active
tris = []
for f in bm.faces:
    ls = f.loops
    for i in range(1, len(ls) - 1):
        tris.append([tuple(ls[0][uv].uv), tuple(ls[i][uv].uv), tuple(ls[i + 1][uv].uv)])
T = np.array(tris)  # (n, 3, 2)
# Islands: faces connected through UV-continuous edges.
seen = set()
islands = 0
for f in bm.faces:
    if f.index in seen:
        continue
    islands += 1
    stack = [f]
    seen.add(f.index)
    while stack:
        g = stack.pop()
        for e in g.edges:
            if e.seam:
                continue
            for h in e.link_faces:
                if h.index in seen:
                    continue
                # UV-continuous: the shared edge's two UVs match on both faces.
                a = {l.vert.index: tuple(round(c, 6) for c in l[uv].uv) for l in g.loops if l.vert in e.verts}
                b = {l.vert.index: tuple(round(c, 6) for c in l[uv].uv) for l in h.loops if l.vert in e.verts}
                if a == b:
                    seen.add(h.index)
                    stack.append(h)
# Overlap by rasterising triangle centres + vertices at res (coarse but honest).
grid = np.zeros((res, res), np.int32)
for t in T:
    mn = np.floor(t.min(0) * res).astype(int).clip(0, res - 1)
    mx = np.ceil(t.max(0) * res).astype(int).clip(0, res - 1)
    xs, ys = np.meshgrid(np.arange(mn[0], mx[0] + 1), np.arange(mn[1], mx[1] + 1))
    P = np.stack([(xs + 0.5) / res, (ys + 0.5) / res], -1).reshape(-1, 2)
    a, b, c = t
    v0, v1, v2 = b - a, c - a, P - a
    d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
    den = d00 * d11 - d01 * d01
    if abs(den) < 1e-18:
        continue
    d20, d21 = v2 @ v0, v2 @ v1
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    inside = (v >= 0) & (w >= 0) & (v + w <= 1)
    q = P[inside]
    gx = (q[:, 0] * res).astype(int).clip(0, res - 1)
    gy = (q[:, 1] * res).astype(int).clip(0, res - 1)
    np.add.at(grid, (gy, gx), 1)
covered = (grid > 0).mean()
overlap = (grid > 1).sum() / max((grid > 0).sum(), 1)
out_of_range = ((T < 0) | (T > 1)).any(axis=(1, 2)).mean()
print(f'[uv_stats] faces {len(bm.faces)}, islands {islands}, coverage {covered * 100:.1f}%, overlapping texels {overlap * 100:.2f}% of covered, tris outside 0..1 {out_of_range * 100:.2f}%', flush=True)
