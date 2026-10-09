"""MASTER CLEANUP GATE: the approved c12 mesh -> a cleaned source for the production remesh.

  node scripts/blender.mjs scripts/blender/cleanup_master.py [config.json] [--debug-masks]

Every step finds its region on the mesh (scripts/blender/humanoid.py landmarks), never by vertex id,
and takes its parameters from the config (default scripts/blender/cleanup_master.json):

  bun     the rear hair bun: the back-of-head midline profile has a bump between the neck and the
          occiput; the patch around it is refilled with a thin-plate (bilaplacian) surface that keeps
          position and slope with the skull above and the neck below.
  wrists  the hand is turned about the wrist centre until wrist -> middle knuckle lines up with the
          forearm's bone line; the turn fades in across the wrist (no seam), fingers untouched.
  cuffs   the bunched glove cuff over the wrist joint becomes a smooth loft from the palm base to the
          forearm (smooth-and-project relaxation, so folds flatten instead of folding over).
  fingers each digit is thinned radially around its own centre line (length and joints kept); the
          scale fades in from the web so the palm is untouched and the gaps only widen.
  seams   raised piping ridges along the inner arms and torso sides are smoothed away (they are
          found as narrow bumps over a low-pass copy of the surface).

The source is never modified. The result is measured with scripts/blender/master_checks.py against
the source; the output GLB is written only if every gate check passes (else <output>.rejected.glb).
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402

import humanoid as hu  # noqa: E402
import master_checks as mc  # noqa: E402
from steps.bun import step_bun  # noqa: E402
from steps.common import log, smoothstep  # noqa: E402
from steps.cuffs import step_cuffs  # noqa: E402
from steps.seams import step_seams  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


# ---------------------------------------------------------------- wrists

def rotate_about(P, centre, axis, angles):
    """Rodrigues rotation of points P about the line (centre, axis) by per-point angles."""
    k = hu._unit(axis)
    v = P - centre
    c, s = np.cos(angles)[:, None], np.sin(angles)[:, None]
    kv = v @ k
    return centre + v * c + np.cross(k, v) * s + np.outer(kv, k) * (1 - c)


def step_wrists(mesh, X, P, masks):
    Y = X.copy()
    info = {}
    for side in ('R', 'L'):
        h = hu.hand(mesh, side, X)
        fa, ha, w = h['forearm_dir'], h['hand_axis'], h['wrist']
        ang = math.radians(hu.angle(ha, fa))
        flex, dev = hu.wrist_angles(h)
        if math.degrees(ang) < P['minDeg']:
            info[side] = {'flexDeg': flex, 'devDeg': dev, 'turnDeg': 0.0}
            continue
        axis = hu._unit(np.cross(ha, fa))
        region = h['region']
        ids = np.nonzero(region)[0]
        t = (X[ids] - w) @ fa  # + toward the hand
        wgt = smoothstep((t + P['blendAbove']) / (P['blendAbove'] + P['blendBelow']))
        Y[ids] = rotate_about(X[ids], w, axis, ang * wgt)
        m = np.zeros(mesh.n, bool)
        m[ids[wgt > 0]] = True
        masks[f'wrist_{side}'] = m
        info[side] = {'flexDeg': flex, 'devDeg': dev, 'turnDeg': math.degrees(ang)}
        log(f"wrist {side}: flex {flex:.1f}, dev {dev:.1f} -> turned {math.degrees(ang):.1f} deg about the wrist centre")
    return Y, info


# ---------------------------------------------------------------- fingers

def project_polyline(P, C):
    """Closest point on polyline C (tip -> base) for each point: (point, unit axis, param 0=base..1=tip)."""
    A, Bp = C[:-1], C[1:]
    seg = Bp - A
    L = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(L)])
    total = cum[-1]
    best = np.full(len(P), np.inf)
    out_c = np.zeros_like(P)
    out_a = np.zeros_like(P)
    out_u = np.zeros(len(P))
    for i in range(len(seg)):
        t = np.clip(((P - A[i]) @ seg[i]) / max(L[i] ** 2, 1e-12), 0, 1)
        c = A[i] + np.outer(t, seg[i])
        d = np.linalg.norm(P - c, axis=1)
        better = d < best
        best[better] = d[better]
        out_c[better] = c[better]
        out_a[better] = seg[i] / max(L[i], 1e-12)
        out_u[better] = 1 - (cum[i] + t[better] * L[i]) / total  # 1 at the tip (C[0]), 0 at the base
    return out_c, out_a, out_u


def step_fingers(mesh, X, P, masks):
    Y = X.copy()
    info = {}
    allm = np.zeros(mesh.n, bool)
    for side in ('R', 'L'):
        h = hu.hand(mesh, side, X)
        info[side] = {}
        for name, f in h['fingers'].items():
            ids = f['ids']
            C = f['centre']
            if len(C) < 3:
                continue
            c, a, u = project_polyline(X[ids], C)
            r = X[ids] - c
            r_ax = (r * a).sum(axis=1)[:, None] * a
            r_rad = r - r_ax
            s = 1 + (P['scale'] - 1) * smoothstep(u / P['webTaper'])
            Y[ids] = c + r_ax + r_rad * s[:, None]
            allm[ids] = True
            info[side][name] = {'vertices': int(len(ids))}
        log(f"fingers {side}: scaled {P['scale']:.2f} radially ({sum(v['vertices'] for v in info[side].values())} verts)")
    masks['fingers'] = allm
    return Y, info


# ---------------------------------------------------------------- main

STEPS = [('bun', step_bun), ('wrists', step_wrists), ('cuffs', step_cuffs), ('fingers', step_fingers), ('seams', step_seams)]


def export_masks(obj, mesh, X, masks, path):
    """Debug GLB with the step masks as vertex colours."""
    import bpy
    colours = {'bun': (1, 0.2, 0.2), 'wrist_R': (0.2, 0.6, 1), 'wrist_L': (0.2, 0.6, 1), 'cuff_R': (1, 0.8, 0.1), 'cuff_L': (1, 0.8, 0.1),
               'fingers': (0.3, 1, 0.3), 'seams': (1, 0.2, 1)}
    C = np.full((mesh.n, 4), 0.75)
    C[:, 3] = 1
    for k, m in masks.items():
        C[m, :3] = colours.get(k, (1, 1, 1))
    me = obj.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', C.ravel())
    me.color_attributes.active_color = attr
    mesh.write(obj, X)
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_vertex_color='ACTIVE')
    me.color_attributes.remove(attr)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    debug = '--debug-masks' in argv
    argv = [a for a in argv if not a.startswith('--')]
    cfg_path = argv[0] if argv else os.path.join(os.path.dirname(__file__), 'cleanup_master.json')
    cfg = json.load(open(cfg_path))
    src = os.path.join(ROOT, cfg['source'])
    t0 = time.time()
    obj = hu.import_glb(src)
    mesh = hu.Mesh(obj)
    log(f"source {cfg['source']}: {mesh.n} verts, {len(mesh.T)} tris, height {mesh.height:.3f} m")
    before, hands_before = mc.measure(mesh)
    X = mesh.V.copy()
    report = {'source': cfg['source'], 'config': cfg, 'steps': {}}
    masks = {}
    for name, fn in STEPS:
        P = cfg['steps'][name]
        if not P.get('enabled', True):
            continue
        keys = set(masks)
        X_prev = X
        X, info = fn(mesh, X, P, masks)
        step_mask = np.zeros(mesh.n, bool)
        for k in set(masks) - keys:
            step_mask |= masks[k]
        step_mask = mesh.grow(step_mask, 2)
        info['selfIntersections'] = [mc.self_intersections(mesh, X_prev, step_mask), mc.self_intersections(mesh, X, step_mask)]
        log(f"{name}: self-intersections in its region {info['selfIntersections'][0]} -> {info['selfIntersections'][1]}")
        report['steps'][name] = info
    # Self-intersections inside the edited regions, before vs after.
    edited = np.zeros(mesh.n, bool)
    for m in masks.values():
        edited |= m
    edited = mesh.grow(edited, 2)
    si_before = mc.self_intersections(mesh, mesh.V, edited)
    si_after = mc.self_intersections(mesh, X, edited)
    if debug:
        export_masks(obj, mesh, X, masks, os.path.join(ROOT, cfg['output']).replace('.glb', '.masks.glb'))
    mesh.write(obj, X)
    mesh_after = hu.Mesh(obj)
    after, _ = mc.measure(mesh_after, ref_hands=hands_before)
    checks = mc.gate(before, after, cfg['gate'])
    checks.append(('no new self-intersections', si_after - si_before <= cfg['gate']['maxNewSelfIntersections'],
                   f'{si_before} -> {si_after} in edited regions'))
    passed = all(ok for _, ok, _ in checks)
    report.update({'before': before, 'after': after, 'checks': [{'name': n, 'ok': ok, 'detail': d} for n, ok, d in checks],
                   'passed': passed, 'seconds': time.time() - t0})
    for n, ok, d in checks:
        log(f"{'PASS' if ok else 'FAIL'}  {n}: {d}")
    out = os.path.join(ROOT, cfg['output'])
    target = out if passed else out.replace('.glb', '.rejected.glb')
    hu.export_glb(obj, target)
    report['written'] = os.path.relpath(target, ROOT).replace('\\', '/')
    with open(os.path.join(ROOT, cfg['report']), 'w') as f:
        json.dump(report, f, indent=1, default=float)
    log(('GATE PASSED -> ' if passed else 'GATE FAILED (source kept) -> ') + report['written'], f'{time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
