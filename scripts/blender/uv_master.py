"""UV-unwrap the remeshed master (one UV set for every look, LOD and baked map).

  node scripts/blender.mjs scripts/blender/uv_master.py <master_remesh.glb> <master_uv.glb>

Smart UV Project on a heavily smoothed copy of the mesh (same topology): islands then follow the
body's shape instead of splitting at every hair curl or lace (2.5k islands on the raw surface); the
UVs are copied back loop by loop and packed with rotation into one 0..1 square at a 4 px margin for
a 4K map. The geometry is untouched. Every look (Meshy retexture with enable_original_uv) and every
baked map (normal, AO) uses these UVs.

  [--angle=66] [--smooth=60]   island split angle, smoothing iterations of the unwrap copy
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402

import humanoid as hu  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
angle = float(next((a[8:] for a in argv[2:] if a.startswith('--angle=')), 66))
iters = int(next((a[9:] for a in argv[2:] if a.startswith('--smooth=')), 60))
obj = hu.import_glb(src)
n = len(obj.data.vertices)
for uv in list(obj.data.uv_layers):
    obj.data.uv_layers.remove(uv)
obj.data.uv_layers.new(name='UVMap')
# Unwrap a smoothed twin (Laplacian smoothing removes curls/laces/fold noise, keeps the limbs).
twin = obj.copy()
twin.data = obj.data.copy()
bpy.context.scene.collection.objects.link(twin)
mesh = hu.Mesh(twin)
X = mesh.V.copy()
for _ in range(iters):
    X += 0.5 * (mesh.umbrella(X) - X)
mesh.write(twin, X)
for o in bpy.context.scene.objects:
    o.select_set(o is twin)
bpy.context.view_layer.objects.active = twin
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.context.scene.tool_settings.use_uv_select_sync = True  # headless: UV selection = mesh selection (all)
r = bpy.ops.uv.pack_islands(rotate=True, rotate_method='ANY', shape_method='CONCAVE', margin_method='FRACTION', margin=4 / 4096)
print('[uv] pack', r, flush=True)
bpy.ops.object.mode_set(mode='OBJECT')
import numpy as np  # noqa: E402

uvs = np.empty(len(twin.data.loops) * 2)
twin.data.uv_layers.active.data.foreach_get('uv', uvs)
obj.data.uv_layers.active.data.foreach_set('uv', uvs)
bpy.data.objects.remove(twin)
for o in bpy.context.scene.objects:
    o.select_set(o is obj)
bpy.context.view_layer.objects.active = obj
for p in obj.data.polygons:
    p.use_smooth = True
mat = bpy.data.materials.new('Body')
obj.data.materials.clear()
obj.data.materials.append(mat)
assert len(obj.data.vertices) == n
hu.export_glb(obj, out)
islands = None
print(f'[uv] {n} verts, {len(obj.data.polygons)} faces, UVs packed -> {out}', flush=True)
