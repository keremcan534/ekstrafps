"""Bake the master's maps onto its UVs (Cycles, CPU): detail the remesh lost comes back as a normal map.

  node scripts/blender.mjs scripts/blender/bake_master.py <high.glb> <low_uv.glb> <out_dir> [--size=4096]

  normal.png  tangent space (OpenGL +Y, MikkTSpace - what glTF / three.js expect), selected-to-active
              from the high-res cleaned source (c12_clean, ~563k triangles) onto the UV'd remesh
  ao.png      ambient occlusion of the low mesh (the R channel of the looks' ORM maps)
Both meshes come from the same pipeline, so they share one coordinate frame.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402

import humanoid as hu  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
high_p, low_p, out = (os.path.abspath(a) for a in argv[:3])
size = int(next((a[7:] for a in argv[3:] if a.startswith('--size=')), 4096))
os.makedirs(out, exist_ok=True)

low = hu.import_glb(low_p)
low.name = 'Low'
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=high_p, merge_vertices=True)
high = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
high.name = 'High'
for o in (low, high):
    for p in o.data.polygons:
        p.use_smooth = True

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
bake = scene.render.bake


def target(name, res, colorspace):
    img = bpy.data.images.new(name, res, res, alpha=False, float_buffer=False)
    img.colorspace_settings.name = colorspace
    mat = low.data.materials[0] if low.data.materials else bpy.data.materials.new('Body')
    if not low.data.materials:
        low.data.materials.append(mat)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in [n for n in nt.nodes if n.type == 'TEX_IMAGE']:
        nt.nodes.remove(n)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    return img


def select(active, *others):
    for o in bpy.context.scene.objects:
        o.select_set(o is active or o in others)
    bpy.context.view_layer.objects.active = active


# Normal: high -> low.
img = target('normal', size, 'Non-Color')
select(low, high)
bake.use_selected_to_active = True
bake.use_cage = False
bake.cage_extrusion = 0.008
bake.max_ray_distance = 0.03
bake.normal_space = 'TANGENT'
bake.margin = 8
bpy.ops.object.bake(type='NORMAL')
img.filepath_raw = os.path.join(out, 'normal.png')
img.file_format = 'PNG'
img.save()
print(f'[bake] normal {size}px -> {img.filepath_raw}', flush=True)

# Ambient occlusion of the low mesh itself.
high.hide_render = True
scene.cycles.samples = 64
img = target('ao', size // 2, 'Non-Color')
select(low)
bake.use_selected_to_active = False
bpy.ops.object.bake(type='AO')
img.filepath_raw = os.path.join(out, 'ao.png')
img.file_format = 'PNG'
img.save()
print(f'[bake] ao {size // 2}px -> {img.filepath_raw}', flush=True)
