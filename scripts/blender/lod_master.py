"""Level-of-detail meshes of the rigged master (same skeleton, same UVs, same material).

  node scripts/blender.mjs scripts/blender/lod_master.py <master_humanoid_rigged.blend> <out_dir>

master_lod1.glb ~30k triangles (gameplay near), master_lod2.glb ~10k (mid, phone main), master_lod3.glb
~4.5k (far). Blender's collapse decimation interpolates UVs and skin weights; the hands (Hand + finger
groups) are protected so the five digits survive at LOD1 and LOD2. Every LOD is re-limited to 4
influences per vertex and normalised, and exported with the full canonical armature.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402

LODS = [('master_lod1.glb', 30000, 2.0), ('master_lod2.glb', 10000, 0.0), ('master_lod3.glb', 4500, 0.0)]  # the refined hands alone are ~12k triangles: protect them only at LOD1
HAND_KEYS = ('Hand_', 'Thumb', 'Index', 'Middle', 'Ring', 'Pinky')


def tris(o):
    o.data.calc_loop_triangles()
    return len(o.data.loop_triangles)


def shape(o):
    """(surface area, bounding box size) - a collapsed LOD loses area or extent."""
    me = o.data
    area = sum(p.area for p in me.polygons)
    xs = [v.co for v in me.vertices]
    size = [max(c[i] for c in xs) - min(c[i] for c in xs) for i in range(3)]
    return area, size


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    blend, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=blend)
    arm = bpy.data.objects['MASTER_HUMANOID_RIG']
    body = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent is arm)
    n0 = tris(body)
    a0, sz0 = shape(body)
    hand_groups = [g.index for g in body.vertex_groups if g.name.startswith(HAND_KEYS)]
    for name, target, protect in LODS:
        lod = body.copy()
        lod.data = body.data.copy()
        lod.name = name.split('.')[0]
        bpy.context.scene.collection.objects.link(lod)
        # 'keep' = how much each vertex belongs to a hand (protects the digits from collapsing).
        keep = lod.vertex_groups.new(name='keep')
        for v in lod.data.vertices:
            w = sum(g.weight for g in v.groups if g.group in hand_groups)
            if w > 0:
                keep.add([v.index], min(1.0, w), 'REPLACE')
        dec = lod.modifiers.new('Decimate', 'DECIMATE')
        dec.decimate_type = 'COLLAPSE'
        dec.ratio = target / n0
        dec.use_collapse_triangulate = True
        if protect > 0:
            dec.vertex_group = 'keep'
            dec.invert_vertex_group = True
            dec.vertex_group_factor = protect
        # Decimate must run before the armature: move it to the top, then apply it.
        bpy.context.view_layer.objects.active = lod
        while lod.modifiers[0].name != 'Decimate':
            bpy.ops.object.modifier_move_up(modifier='Decimate')
        bpy.ops.object.modifier_apply(modifier='Decimate')
        lod.vertex_groups.remove(lod.vertex_groups['keep'])
        for o in bpy.context.scene.objects:
            o.select_set(o is lod)
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
        for o in bpy.context.scene.objects:
            o.select_set(o in (lod, arm))
        bpy.context.view_layer.objects.active = arm
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, name), use_selection=True, export_format='GLB', export_yup=True,
                                  export_skins=True, export_animations=False, export_def_bones=False, export_tangents=True)
        a, sz = shape(lod)
        ok = a > 0.93 * a0 and all(abs(x - y) < 0.01 * max(y, 1e-6) + 0.004 for x, y in zip(sz, sz0))
        print(f'[lod] {name}: {tris(lod)} triangles (from {n0}), area {a / a0 * 100:.1f}%, extent ok {ok}', flush=True)
        if not ok:
            raise RuntimeError(f'{name}: the decimation collapsed the body (area {a / a0 * 100:.1f}%, size {sz} vs {sz0})')
        bpy.data.objects.remove(lod)


if __name__ == '__main__':
    main()
