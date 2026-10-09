"""UV-space masks of body regions, for texture cleanup rules (scripts/make_look.py).

  node scripts/blender.mjs scripts/blender/region_masks.py <master_uv.glb> <out_dir> [--size=2048]

mask_arms.png  R  1 on both hands and forearms (fingertips up to just below the elbow), 0 elsewhere
               G  distance along the forearm from the wrist centre: t = G * (T_HI - T_LO) + T_LO metres
                  (negative = hand / glove, positive = forearm / sleeve)
               No skin may show there - every look is gloved and long-sleeved (Site-9 is -30 C), but
               Meshy paints a "glove gap" or a rolled sleeve from the reference image otherwise.
mask_body.png  R  1 on the head and neck above the collar: the only place skin may show (palettes in
                  scripts/make_look.py never touch it; bled 16 px past the islands like the colour maps)
               G  height over the soles / 2 m
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import humanoid as hu  # noqa: E402

T_LO, T_HI = -0.25, 0.30  # metres along the forearm encoded in G
CUT = 0.24  # the arm mask stops here, just below the elbow
COLLAR_Z, NECK_R = 1.555, 0.10  # head + neck zone: above the collar (m over the soles), near the neck's axis

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
size = int(next((a[7:] for a in argv[2:] if a.startswith('--size=')), 2048))
os.makedirs(out, exist_ok=True)
obj = hu.import_glb(src)
mesh = hu.Mesh(obj)
X = mesh.V
w = np.zeros(mesh.n)
tt = np.full(mesh.n, CUT)  # outside the arms: the cut value, so G stays continuous across the cut
for side in ('R', 'L'):
    h = hu.hand(mesh, side, X)
    tip = hu.arm(mesh, side, X)['tip']
    t = (X - h['wrist']) @ -h['forearm_dir']
    reg = mesh.component(tip, t < CUT)  # hand + forearm: connected to the fingertip, below the cut plane
    w[reg] = 1.0
    tt[reg] = t[reg]
z = X[:, 2] - X[:, 2].min()  # the source mesh is centred; heights from the soles
axis = np.array([0.0, float(np.median(X[z > 1.6, 1]))])
head = (z > COLLAR_Z) & (np.linalg.norm(X[:, :2] - axis, axis=1) < NECK_R)


def bake(name, rgb, margin):
    """Vertex colours (n x 3) -> emission bake in UV space -> <out>/<name>.png."""
    me = obj.data
    attr = me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
    C = np.ones((mesh.n, 4))
    C[:, :3] = rgb
    attr.data.foreach_set('color', C.ravel())
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    outn = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = name
    nt.links.new(vc.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], outn.inputs['Surface'])
    img = bpy.data.images.new(name, size, size, alpha=False)
    img.colorspace_settings.name = 'Non-Color'
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    me.materials.clear()
    me.materials.append(mat)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.render.bake.margin = margin
    for o in scene.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='EMIT')
    img.filepath_raw = os.path.join(out, name + '.png')
    img.file_format = 'PNG'
    img.save()
    return img.filepath_raw


g = np.clip((tt - T_LO) / (T_HI - T_LO), 0.0, 1.0)
print(f'[masks] arms: {int(w.sum())} verts -> {bake("mask_arms", np.stack([w, g, 0 * w], 1), 16)}', flush=True)
print(f'[masks] head: {int(head.sum())} verts -> {bake("mask_body", np.stack([head.astype(float), np.clip(z / 2, 0, 1), 0 * w], 1), 16)}', flush=True)
