"""Run ONE cleanup step on the source mesh, for developing and judging that step in isolation.

  node scripts/blender.mjs scripts/blender/try_step.py <step> <out.glb> [--input=x.glb] [--set=key=value ...]
                                                       [--measure] [--masks]

<step> is a name in cleanup_master.STEPS (bun, wrists, cuffs, fingers, seams). Parameters come from
scripts/blender/cleanup_master.json, overridden by --set (JSON values). Writes <out.glb>, <out>.json
(the step's info, self-intersections in its region before/after, and with --measure the full gate
measurements before/after), and with --masks <out>.masks.glb (the step's region as vertex colours).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402

import cleanup_master as cm  # noqa: E402
import humanoid as hu  # noqa: E402
import master_checks as mc  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
name, out = argv[0], os.path.abspath(argv[1])
flags = argv[2:]
cfg = json.load(open(os.path.join(os.path.dirname(__file__), 'cleanup_master.json')))
P = dict(cfg['steps'][name])
for f in flags:
    if f.startswith('--set='):
        k, v = f[6:].split('=', 1)
        P[k] = json.loads(v)
src = next((f[8:] for f in flags if f.startswith('--input=')), os.path.join(cm.ROOT, cfg['source']))
t0 = time.time()
obj = hu.import_glb(src)
mesh = hu.Mesh(obj)
fn = dict(cm.STEPS)[name]
masks = {}
before = after = None
hands = None
if '--measure' in flags:
    before, hands = mc.measure(mesh)
X, info = fn(mesh, mesh.V.copy(), P, masks)
region = np.zeros(mesh.n, bool)
for m in masks.values():
    if m.dtype == bool:
        region |= m
region = mesh.grow(region, 2)
si = [mc.self_intersections(mesh, mesh.V, region), mc.self_intersections(mesh, X, region)]
moved = np.linalg.norm(X - mesh.V, axis=1)
if '--masks' in flags:
    cm.export_masks(obj, mesh, X, masks, out.replace('.glb', '.masks.glb'))
mesh.write(obj, X)
if '--measure' in flags:
    after, _ = mc.measure(hu.Mesh(obj), ref_hands=hands)
hu.export_glb(obj, out)
rep = {'step': name, 'params': P, 'info': info, 'selfIntersections': si, 'movedVertices': int((moved > 1e-6).sum()),
       'maxMove': float(moved.max()), 'before': before, 'after': after, 'seconds': time.time() - t0}
if before:
    rep['checks'] = [{'name': n, 'ok': ok, 'detail': d} for n, ok, d in mc.gate(before, after, cfg['gate'])]
json.dump(rep, open(out.replace('.glb', '.json'), 'w'), indent=1, default=float)
print(f'[try] {name}: self-intersections in region {si[0]} -> {si[1]}, moved {rep["movedVertices"]} verts (max {rep["maxMove"] * 1000:.1f} mm),'
      f' {time.time() - t0:.0f} s -> {out}', flush=True)
for c in rep.get('checks', []):
    print(f"[try] {'PASS' if c['ok'] else 'FAIL'}  {c['name']}: {c['detail']}", flush=True)
