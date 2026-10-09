"""Test clips for MASTER_HUMANOID_RIG (validation only, not production animation).

  node scripts/blender.mjs scripts/blender/humanoid_clips.py <rig.blend> <meshy_walking.glb> <out.glb>

  walk    Meshy's bootstrap walking clip (and run, from running.glb beside it) retargeted onto the canonical skeleton: per frame, each
          mapped bone gets world rotation = meshy_world(t) * meshy_world_rest^-1 * canonical_world_rest
          (so rest-orientation differences never leak into the pose); the hips also take Meshy's
          translation offset. Fingers and twist bones stay at rest.
  idle    2 s breathing loop (spine / neck, tiny weight shift)
  crouch  hips down, knees bent, feet flat, torso slightly forward (held)
  aim     rifle stance: bladed torso, head level, knees soft (held)

Arms are left at rest in every clip: the rifle hold is IK on top (right hand owns the weapon via
RightHandWeaponSocket, left hand two-bone IK to the foregrip). Writes <out.glb> with the armature and
one glTF animation per clip.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Euler, Matrix, Quaternion, Vector  # noqa: E402

MESHY_TO_CANON = {'Hips': 'Hips', 'Spine02': 'Spine1', 'Spine01': 'Spine2', 'Spine': 'Spine3', 'neck': 'Neck', 'Head': 'Head'}
for side, word in (('R', 'Right'), ('L', 'Left')):
    for m, c in (('Shoulder', 'Clavicle'), ('Arm', 'UpperArm'), ('ForeArm', 'Forearm'), ('Hand', 'Hand'),
                 ('UpLeg', 'Thigh'), ('Leg', 'Calf'), ('Foot', 'Foot'), ('ToeBase', 'Toe')):
        MESHY_TO_CANON[word + m] = f'{c}_{side}'
FPS = 30


def log(*a):
    print('[clips]', *a, flush=True)


def new_action(arm, name):
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    return act


def key_all(arm, frame, bones=None):
    for pb in arm.pose.bones:
        if bones and pb.name not in bones:
            continue
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        if pb.name in ('Hips', 'Root'):
            pb.keyframe_insert('location', frame=frame)


def push_nla(arm, act):
    tr = arm.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, int(act.frame_range[0]), act)
    arm.animation_data.action = None


def rot(pb, axis, deg):
    """Compose a local rotation (bone space) onto the pose bone."""
    q = Quaternion(Vector(axis), math.radians(deg))
    pb.rotation_quaternion = pb.rotation_quaternion @ q


def retarget(arm, meshy_path, clip):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=meshy_path)
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == 'ARMATURE')
    act_src = src.animation_data.action if src.animation_data else None
    if act_src is None and src.animation_data and src.animation_data.nla_tracks:
        act_src = src.animation_data.nla_tracks[0].strips[0].action
        src.animation_data.action = act_src
    f0, f1 = (int(round(v)) for v in act_src.frame_range)
    act = new_action(arm, clip)
    rest_src = {b.name: src.matrix_world @ b.matrix_local for b in src.data.bones}
    rest_dst = {b.name: arm.matrix_world @ b.matrix_local for b in arm.data.bones}
    order = [b.name for b in arm.data.bones]  # parents come before children
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        world_src = {pb.name: src.matrix_world @ pb.matrix for pb in src.pose.bones}
        for name in order:
            pb = arm.pose.bones[name]
            m = next((k for k, v in MESHY_TO_CANON.items() if v == name), None)
            if m is None or m not in world_src:
                continue
            r = (world_src[m].to_quaternion() @ rest_src[m].to_quaternion().inverted() @ rest_dst[name].to_quaternion())
            loc = rest_dst[name].to_translation()
            if name == 'Hips':
                loc = loc + (world_src[m].to_translation() - rest_src[m].to_translation())
            W = Matrix.Translation(loc) @ r.to_matrix().to_4x4()
            pb.matrix = arm.matrix_world.inverted() @ W
            bpy.context.view_layer.update()
        key_all(arm, f - f0 + 1)
    for o in new:
        bpy.data.objects.remove(o)
    log(f'{clip}: retargeted {f1 - f0 + 1} frames')
    push_nla(arm, act)


def author_idle(arm):
    act = new_action(arm, 'idle')
    n = 2 * FPS
    for f in range(n + 1):
        s = math.sin(2 * math.pi * f / n)
        for pb in arm.pose.bones:
            pb.rotation_quaternion = Quaternion()
            pb.location = Vector()
        rot(arm.pose.bones['Spine2'], (1, 0, 0), -0.8 * s)
        rot(arm.pose.bones['Spine3'], (1, 0, 0), -1.2 * s)
        rot(arm.pose.bones['Neck'], (1, 0, 0), 0.9 * s)
        arm.pose.bones['Hips'].location = Vector((0.004 * s, 0, 0))
        key_all(arm, f + 1, {'Spine2', 'Spine3', 'Neck', 'Hips'})
    push_nla(arm, act)


def author_crouch(arm):
    act = new_action(arm, 'crouch')
    for f in (1, FPS):
        for pb in arm.pose.bones:
            pb.rotation_quaternion = Quaternion()
            pb.location = Vector()
        # Bone frames (canonical): legs +Y down, +Z forward, so +X turns the bone's tip forward.
        for s in ('R', 'L'):
            rot(arm.pose.bones[f'Thigh_{s}'], (1, 0, 0), 75)
            rot(arm.pose.bones[f'Calf_{s}'], (1, 0, 0), -110)
            rot(arm.pose.bones[f'Foot_{s}'], (1, 0, 0), 35)
        rot(arm.pose.bones['Spine1'], (1, 0, 0), -12)
        rot(arm.pose.bones['Neck'], (1, 0, 0), 8)
        arm.pose.bones['Hips'].location = Vector((0, -0.33, 0.04))  # bone space: -Y = down the hips' up axis
        key_all(arm, f)
    push_nla(arm, act)


def author_aim(arm):
    act = new_action(arm, 'aim')
    for f in (1, FPS):
        for pb in arm.pose.bones:
            pb.rotation_quaternion = Quaternion()
            pb.location = Vector()
        # Right-handed blade: the chest turns right (left shoulder toward the target), the head
        # turns back to look down the barrel. (+Y turned the chest left - a left-handed stance.)
        rot(arm.pose.bones['Spine1'], (0, 1, 0), -10)
        rot(arm.pose.bones['Spine2'], (0, 1, 0), -8)
        rot(arm.pose.bones['Spine3'], (0, 1, 0), -6)
        rot(arm.pose.bones['Neck'], (0, 1, 0), 12)
        rot(arm.pose.bones['Head'], (0, 1, 0), 10)
        for s in ('R', 'L'):
            rot(arm.pose.bones[f'Thigh_{s}'], (1, 0, 0), 12)
            rot(arm.pose.bones[f'Calf_{s}'], (1, 0, 0), -20)
            rot(arm.pose.bones[f'Foot_{s}'], (1, 0, 0), 8)
        arm.pose.bones['Hips'].location = Vector((0, -0.03, 0))
        key_all(arm, f)
    push_nla(arm, act)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    rig_blend, walk_glb, out = (os.path.abspath(a) for a in argv[:3])
    bpy.ops.wm.open_mainfile(filepath=rig_blend)
    bpy.context.scene.render.fps = FPS
    arm = bpy.data.objects['MASTER_HUMANOID_RIG']
    bpy.context.view_layer.objects.active = arm
    if os.path.exists(walk_glb):
        retarget(arm, walk_glb, 'walk')
    run_glb = walk_glb.replace('walking.glb', 'running.glb')
    if run_glb != walk_glb and os.path.exists(run_glb):
        retarget(arm, run_glb, 'run')
    author_idle(arm)
    author_crouch(arm)
    author_aim(arm)
    body = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent is arm)
    for o in bpy.context.scene.objects:
        o.select_set(o in (arm, body))
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format='GLB', export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='NLA_TRACKS', export_def_bones=False,
                              export_force_sampling=True, export_frame_range=False)
    log(f'wrote {out}: clips {[t.name for t in arm.animation_data.nla_tracks]}')


if __name__ == '__main__':
    main()
