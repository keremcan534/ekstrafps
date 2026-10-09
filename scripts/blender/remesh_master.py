"""Production remesh of the cleaned master (~60k polygons, dense where the body bends or is seen close).

  node scripts/blender.mjs scripts/blender/remesh_master.py <in.glb> <out.glb> [--method=voxelquad|quadriflow|decimate]
                                                         [--faces=60000] [--symmetry] [--voxel=0.0015]
                                                         [--refine=hands,face,elbows,shoulders]

  voxelquad   voxel pre-pass (clean manifold surface, no slivers) then QuadriFlow - the default, because
              QuadriFlow refuses the raw marching-cubes surface (sub-0.1 mm edges).
  quadriflow  Blender's QuadriFlow directly: clean, evenly sized quads (optionally mirror-symmetric).
  decimate    density-weighted edge collapse (Decimate modifier with a vertex group that keeps the
              hands, wrists, elbows, shoulders and face dense), then triangles joined into quads.

--refine splits every quad of those regions into four after the base remesh and shrinkwraps the
refined vertices back onto the input surface: dense where the body bends or is seen close, ~--faces
elsewhere (pick --faces so the total lands near the budget).

Every result is measured against the input: surface deviation both ways (mean / 95th pct / max, and
over the hands alone), the five digits by geodesic persistence, finger gaps, quad ratio. Writes
<out.glb> and <out>.json.
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector, bvhtree  # noqa: E402

import humanoid as hu  # noqa: E402
import master_checks as mc  # noqa: E402


def density_weights(mesh, X):
    """0..1 per vertex: 1 = keep dense (hands, wrists, elbows, shoulders, face), 0 = free to reduce."""
    H = mesh.height
    w = np.zeros(mesh.n)
    pts = []
    for side in ('R', 'L'):
        h = hu.hand(mesh, side, X)
        w[h['region']] = 1.0  # hand + wrist + forearm part
        line = h['arm_line']
        pts += [(h['elbow_est'], 0.07), (line['points'][-1], 0.10)]  # elbow, armpit/shoulder
    head = X[:, 2] > mesh.floor + 0.87 * H
    face = head & (X[:, 1] < np.median(X[head, 1]))  # front half of the head (the character faces -Y)
    w[face] = 1.0
    for p, r in pts:
        d = np.linalg.norm(X - p, axis=1)
        w = np.maximum(w, np.clip(1.5 - d / r, 0, 1))
    return w


def prepare(obj):
    """Weld coincident vertices, make face normals consistent (outward) and drop the importer's custom
    split normals - QuadriFlow refuses meshes whose face winding is inconsistent."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    # QuadriFlow's precheck also rejects any edge shorter than 0.1 mm per axis; marching-cubes output
    # has such slivers. Merge vertices within 0.2 mm (finger gaps are >= 5 mm) and drop degenerates.
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-7)
    for _ in range(3):
        short = [e for e in bm.edges if e.calc_length() < 2e-4]
        if not short:
            break
        bmesh.ops.collapse(bm, edges=short, uvs=False)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    if me.has_custom_normals:
        bpy.context.view_layer.objects.active = obj
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    short = sum(1 for e in bm.edges if e.calc_length() < 1.8e-4)
    bad = sum(1 for e in bm.edges if not e.is_manifold) + sum(1 for v in bm.verts if not v.is_manifold)
    bm.free()
    print(f'[remesh] prepared: {len(me.polygons)} faces, {short} edges < 0.18 mm, {bad} non-manifold elements', flush=True)


def refine_masks(mesh, X, regions):
    """Per-vertex masks of the regions that stay dense: hands (+6 cm of wrist), face, elbows, shoulders."""
    H = mesh.height
    m = np.zeros(mesh.n, bool)
    for side in ('R', 'L'):
        h = hu.hand(mesh, side, X)
        up = -h['forearm_dir']
        if 'hands' in regions:
            m |= h['region'] & (((X - h['wrist']) @ up) < 0.06)
        if 'elbows' in regions:
            m |= np.linalg.norm(X - h['elbow_est'], axis=1) < 0.075
        if 'shoulders' in regions:
            m |= np.linalg.norm(X - h['arm_line']['points'][-1], axis=1) < 0.10
    if 'face' in regions:
        head = X[:, 2] > mesh.floor + 0.87 * H
        m |= head & (X[:, 1] < np.median(X[head, 1]))
    return m


def refine(obj, source, regions):
    """Split every quad of the dense regions into four, then put the refined vertices back on the
    source surface (Shrinkwrap, nearest surface point) so the extra density carries real shape."""
    mesh = hu.Mesh(obj)
    mask = refine_masks(mesh, mesh.V, regions)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    faces = [f for f in bm.faces if all(mask[v.index] for v in f.verts)]
    edges = list({e for f in faces for e in f.edges})
    before_v = len(bm.verts)
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    # Faces on the border got an extra vertex on one or two sides: split those n-gons cleanly.
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    n = len(obj.data.vertices)
    grow = np.zeros(n, bool)
    grow[before_v:] = True  # new vertices
    grow[:before_v] = mask
    vg = obj.vertex_groups.new(name='refined')
    vg.add(np.nonzero(grow)[0].tolist(), 1.0, 'REPLACE')
    mod = obj.modifiers.new('wrap', 'SHRINKWRAP')
    mod.target = source
    mod.wrap_method = 'NEAREST_SURFACEPOINT'
    mod.vertex_group = 'refined'
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    print(f"[remesh] refined {len(faces)} quads in {', '.join(regions)}: {before_v} -> {n} verts", flush=True)


def deviation(src_V, src_T, dst_V, dst_T, sample=None):
    """Distances from src vertices to the dst surface."""
    tree = bvhtree.BVHTree.FromPolygons([Vector(v) for v in dst_V], dst_T.tolist(), all_triangles=True)
    ids = np.arange(len(src_V)) if sample is None else sample
    d = np.empty(len(ids))
    for k, i in enumerate(ids):
        r = tree.find_nearest(Vector(src_V[i]))
        d[k] = r[3] if r[0] is not None else np.inf
    return d


def stats(d):
    return {'mean': float(d.mean() * 1000), 'p95': float(np.percentile(d, 95) * 1000), 'max': float(d.max() * 1000)}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    flags = argv[2:]
    method = next((f[9:] for f in flags if f.startswith('--method=')), 'voxelquad')
    faces = int(next((f[8:] for f in flags if f.startswith('--faces=')), 60000))
    sym = '--symmetry' in flags
    t0 = time.time()
    obj = hu.import_glb(src)
    mesh = hu.Mesh(obj)
    V0, T0 = mesh.V.copy(), mesh.T.copy()
    before, hands0 = mc.measure(mesh)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    prepare(obj)
    source = obj.copy()
    source.data = obj.data.copy()
    bpy.context.scene.collection.objects.link(source)
    source.hide_set(True)
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    if method == 'voxelquad':
        # A voxel pre-pass rebuilds a guaranteed manifold, sliver-free surface (OpenVDB); surfaces
        # closer than ~2 voxels merge, so the voxel stays well under the narrowest finger gap.
        voxel = float(next((f[8:] for f in flags if f.startswith('--voxel=')), 0.0015))
        obj.data.remesh_voxel_size = voxel
        obj.data.remesh_voxel_adaptivity = 0.0
        obj.data.use_remesh_fix_poles = True
        print('[remesh] voxel', voxel, bpy.ops.object.voxel_remesh(), len(obj.data.polygons), 'faces', flush=True)
        method_qf = True
    else:
        method_qf = method == 'quadriflow'
    if method_qf:
        r = bpy.ops.object.quadriflow_remesh(use_mesh_symmetry=sym, use_preserve_sharp=False, use_preserve_boundary=False,
                                             preserve_attributes=False, smooth_normals=False, mode='FACES',
                                             target_faces=faces, seed=0)
        print('[remesh] quadriflow', r, len(obj.data.polygons), 'faces', flush=True)
    else:
        w = density_weights(mesh, V0)
        vg = obj.vertex_groups.new(name='dense')
        for i in np.nonzero(w > 0)[0]:
            vg.add([int(i)], float(w[i]), 'REPLACE')
        # Target triangles ~ 1.8 x the polygon budget (joined quads are 2 triangles each).
        ratio = min(1.0, 1.8 * faces / len(T0))
        mod = obj.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.vertex_group = 'dense'
        mod.invert_vertex_group = True  # high weight = protected
        mod.vertex_group_factor = 10.0
        mod.use_symmetry = sym
        mod.symmetry_axis = 'X'
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.join_triangles(bm, faces=bm.faces[:], angle_face_threshold=math.radians(40),
                                 angle_shape_threshold=math.radians(40), cmp_seam=False, cmp_sharp=False, cmp_uvs=False,
                                 cmp_vcols=False, cmp_materials=False)
        bm.to_mesh(obj.data)
        bm.free()
    regions = next((f[9:] for f in flags if f.startswith('--refine=')), '')
    if regions:
        refine(obj, source, regions.split(','))
    bpy.data.objects.remove(source)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    me = obj.data
    nquad = sum(1 for p in me.polygons if len(p.vertices) == 4)
    npoly = len(me.polygons)
    mesh2 = hu.Mesh(obj)
    after, _ = mc.measure(mesh2)
    hand_ids = np.nonzero(hands0['R']['region'] | hands0['L']['region'])[0]
    rng = np.random.default_rng(3)
    samp = rng.choice(len(V0), size=60000, replace=False)
    d_src = deviation(V0, T0, mesh2.V, mesh2.T, samp)
    d_hand = deviation(V0, T0, mesh2.V, mesh2.T, hand_ids)
    d_dst = deviation(mesh2.V, mesh2.T, V0, T0)
    rep = {'input': src, 'method': method, 'symmetry': sym, 'targetFaces': faces, 'polygons': npoly, 'quads': nquad,
           'quadRatio': nquad / max(npoly, 1), 'triangles': len(mesh2.T), 'vertices': mesh2.n,
           'deviationSrcToRemeshMm': stats(d_src), 'deviationHandsMm': stats(d_hand), 'deviationRemeshToSrcMm': stats(d_dst),
           'before': before, 'after': after, 'seconds': time.time() - t0}
    for side in ('R', 'L'):
        print(f"[remesh] {side}: digits {after[side]['digits']} persistence {after[side]['persistence'][:6]} gaps "
              + ', '.join(f"{k} {v * 1000:.1f}" for k, v in after[side]['fingerGaps'].items()), flush=True)
    print(f"[remesh] {method}{' sym' if sym else ''}: {npoly} polys ({nquad / max(npoly, 1) * 100:.0f}% quads), {len(mesh2.T)} tris;"
          f" deviation mean {rep['deviationSrcToRemeshMm']['mean']:.2f} p95 {rep['deviationSrcToRemeshMm']['p95']:.2f}"
          f" max {rep['deviationSrcToRemeshMm']['max']:.1f} mm; hands p95 {rep['deviationHandsMm']['p95']:.2f} max"
          f" {rep['deviationHandsMm']['max']:.1f} mm; topology {after['topology']}; {time.time() - t0:.0f} s", flush=True)
    hu.export_glb(obj, out)
    json.dump(rep, open(out.replace('.glb', '.json'), 'w'), indent=1, default=float)


if __name__ == '__main__':
    main()
