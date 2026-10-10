"""Far / phone versions of the gear items: the same mesh decimated, same UVs and skin, no materials
(the runtime draws a LOD with the item's own material and its look variants).

  node scripts/blender.mjs scripts/blender/lod_gear.py [<gear dir>]

gear/<kind>/<id>.glb -> two light versions, each at the first of its ratios of the triangles (at least
its minimum) that keeps the shape: collapse decimation interpolates UVs and skin weights; the skin is
re-limited to 4 influences and normalised.
  <id>_lod.glb  LODS['_lod']: desktop from the mid distance, phones up close; refused past 8 % of the
                surface lost or 4 mm + 2 % of the extent
  <id>_far.glb  LODS['_far']: past the far distance (14 m+, a few dozen pixels): looser, 15 % / 1 cm + 4 %
Past the last ratio an item gets no such version (src/characters/MasterAssets.ts falls back to the
lighter one it has, or the item). Re-run after any gear item changes (scripts/build-gear.mjs).
"""
import glob
import os
import sys

import bpy

# suffix: (ratios tried in order, minimum triangles, kept surface share, extent slack: (m, share))
LODS = {
    '_lod': ((0.3, 0.45, 0.6), 800, 0.92, (0.004, 0.02)),
    '_far': ((0.12, 0.2, 0.3), 250, 0.85, (0.01, 0.04)),
}


def tris(o):
    o.data.calc_loop_triangles()
    return len(o.data.loop_triangles)


def shape(o):
    """(surface area, bounding box size) in the mesh's own space."""
    me = o.data
    xs = [v.co for v in me.vertices]
    return sum(p.area for p in me.polygons), [max(c[i] for c in xs) - min(c[i] for c in xs) for i in range(3)]


def decimated(path, ratio, min_tris, keep, slack):
    """The item's one mesh (and its armature) decimated to ratio, or (None, reason)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
    # (The importer adds an "Icosphere" to draw bones with: not the item's.)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('Icosphere')]
    if len(meshes) != 1:
        return None, None, f'{len(meshes)} meshes'
    o = meshes[0]
    n0 = tris(o)
    a0, sz0 = shape(o)
    target = max(min_tris, int(n0 * ratio))
    if target > 0.8 * n0:
        return None, None, f'{n0} triangles, already light'
    dec = o.modifiers.new('Decimate', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'
    dec.ratio = target / n0
    dec.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = o
    for x in bpy.context.scene.objects:
        x.select_set(x is o)
    # Decimate before the armature (skinned items): move it to the top, then apply it.
    while o.modifiers[0].name != 'Decimate':
        bpy.ops.object.modifier_move_up(modifier='Decimate')
    bpy.ops.object.modifier_apply(modifier='Decimate')
    arm = o.find_armature()
    if arm:
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    a, sz = shape(o)
    if not (a > keep * a0 and all(abs(x - y) < slack[1] * max(y, 1e-6) + slack[0] for x, y in zip(sz, sz0))):
        return None, None, f'{ratio}: area {a / a0 * 100:.1f}%, size {[round(x, 3) for x in sz]} vs {[round(y, 3) for y in sz0]}'
    return o, arm, f'{n0} -> {tris(o)} triangles ({ratio}), area {a / a0 * 100:.1f}%'


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    root = os.path.abspath(next((a for a in argv if not a.startswith('--')), 'public/assets/characters/gear'))
    items = [p for p in sorted(glob.glob(os.path.join(root, '*', '*.glb'))) if not p.endswith(tuple(f'{k}.glb' for k in LODS))]
    for path in items:
        name = os.path.relpath(path, root).replace(os.sep, '/')
        for suffix, (ratios, min_tris, keep, slack) in LODS.items():
            out = path[:-4] + suffix + '.glb'
            why = []
            for ratio in ratios:
                o, arm, msg = decimated(path, ratio, min_tris, keep, slack)
                if o:
                    break
                why.append(msg)
                if 'meshes' in msg or 'light' in msg:
                    break
            if not o:
                if os.path.exists(out):
                    os.remove(out)
                print(f'[gear lod] {name}: no {suffix} ({"; ".join(why)})', flush=True)
                continue
            for x in bpy.context.scene.objects:
                x.select_set(x is o or x is arm)
            bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format='GLB', export_yup=True,
                                      export_skins=bool(arm), export_animations=False, export_materials='NONE',
                                      export_def_bones=False)
            print(f'[gear lod] {name}: {msg} -> {os.path.basename(out)}', flush=True)


if __name__ == '__main__':
    main()
