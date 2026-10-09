"""Prepare the remeshed master for Meshy's auto-rig bootstrap (it only rigs textured humanoids).

  node scripts/blender.mjs scripts/blender/rig_input.py <remeshed.glb> <out.glb> [--size=1024]

No Meshy texturing credits: Blender unwraps the mesh (Smart UV Project) and bakes ambient occlusion
(Cycles, CPU) into a neutral grey base colour, so the rig model still sees the face, fingers and
folds as shading. The mesh itself is untouched (same vertices, same order).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402

import humanoid as hu  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
size = int(next((a[7:] for a in argv[2:] if a.startswith('--size=')), 1024))

obj = hu.import_glb(src)
n_before = len(obj.data.vertices)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.003)
bpy.ops.object.mode_set(mode='OBJECT')

img = bpy.data.images.new('master_ao', size, size, alpha=False)
img.generated_color = (1.0, 1.0, 1.0, 1.0)  # texels the bake misses (tiny islands) stay light, not black
mat = bpy.data.materials.new('master_bootstrap')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes['Principled BSDF']
tex = nt.nodes.new('ShaderNodeTexImage')
tex.image = img
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.8
obj.data.materials.clear()
obj.data.materials.append(mat)
nt.nodes.active = tex

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 48
scene.render.bake.margin = 16
bpy.ops.object.bake(type='AO')
# Lift the AO into a mid grey (0.35 .. 0.75) so the model reads as a clay figure, not black creases.
import numpy as np  # noqa: E402

px = np.empty(size * size * 4, np.float32)
img.pixels.foreach_get(px)
px = px.reshape(-1, 4)
px[:, :3] = 0.35 + 0.4 * px[:, :3]
img.pixels.foreach_set(px.ravel())
img.file_format = 'PNG'
img.pack()
assert len(obj.data.vertices) == n_before
hu.export_glb(obj, out)
print(f'[rig_input] {n_before} verts, UVs + {size}px AO texture -> {out}', flush=True)
