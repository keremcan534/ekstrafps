"""Build MASTER_HUMANOID_RIG: the canonical skeleton + skin of the master humanoid.

  node scripts/blender.mjs scripts/blender/build_canonical_rig.py <master.glb> <meshy_rigged.glb> <out_dir>
                                                                [--weights=heat|blend|meshy]
Body weights: heat (default) = Blender bone heat on the canonical skeleton, Meshy's transferred weights
where heat leaves a vertex empty - Meshy's own binds torso-side skin under the armpit to the upper arm
(flaps when the arm lifts); blend = heat around the shoulders only; meshy = transferred only.

<master.glb>        the cleaned, remeshed master mesh (our topology; the skin goes on this)
<meshy_rigged.glb>  Meshy's auto-rig of the same mesh: a 24-joint bootstrap (body joint positions and
                    body skin weights), no fingers, no twist bones
<out_dir>           master_humanoid_rigged.glb / .fbx / .blend, skeleton.json, rig_report.json

Skeleton (scripts/blender/canonical_skeleton.json, right side + centre; the left side is mirrored):
  body joints from Meshy, wrist centres and finger joints from our landmarks (humanoid.hand), all
  symmetrised (right = average of right and mirrored left; left = its mirror image), so the skeleton
  is exactly symmetric and left/right poses mirror as (x, -y, -z, w). Bone frames: +Y toward the
  child, +Z palm side (arms, hands, fingers; thumb toward its pad) or forward (spine, legs) or up
  (feet), X = Y x Z.
Skin:
  1. Body: Blender bone heat on the canonical skeleton (Meshy's weights, transferred by nearest-surface
     barycentric interpolation and renamed canonical, fill any vertex heat leaves empty).
  2. Hands re-weighted from the digits' own regions (fingers never pull each other; rig-arms rules:
     inverse distance^5 to the bone segments, the Hand to its palm plate), blended into the
     transferred forearm weights between 4 and 8 cm above the wrist.
  3. Twist splits: Forearm -> ForearmTwist -> ForearmTwist2 in thirds toward the wrist, UpperArm -> UpperArmTwist
     ramps up toward the shoulder.
  4. At most 4 influences per vertex, normalised.
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Quaternion, Vector, bvhtree  # noqa: E402

import humanoid as hu  # noqa: E402

HERE = os.path.dirname(__file__)
MIRROR = np.array([-1.0, 1.0, 1.0])
FINGERS = ('Index', 'Middle', 'Ring', 'Pinky')
POWER = 5.0


def log(*a):
    print('[rig]', *a, flush=True)


def unit(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


def side_name(name, side):
    """Canonical right-side name -> that side's name."""
    if side == 'R':
        return name
    if name == 'RightHandWeaponSocket':
        return 'LeftHandWeaponSocket'
    return name[:-2] + '_L' if name.endswith('_R') else name


# ---------------------------------------------------------------- inputs

def load_meshy(path):
    """Meshy's armature joint heads (world, Blender coords) and its skinned mesh's weights."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    meshes = [o for o in new if o.type == 'MESH']
    heads = {b.name: np.array(arm.matrix_world @ b.head_local) for b in arm.data.bones}
    tails = {b.name: np.array(arm.matrix_world @ b.tail_local) for b in arm.data.bones}
    # Skinned mesh in world space (bind pose) + per-vertex weights.
    src = meshes[0]
    dg = bpy.context.evaluated_depsgraph_get()
    me = src.data
    V = np.array([src.matrix_world @ v.co for v in me.vertices])
    me.calc_loop_triangles()
    T = np.array([t.vertices[:] for t in me.loop_triangles])
    names = [g.name for g in src.vertex_groups]
    W = np.zeros((len(V), len(names)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    for o in new:
        bpy.data.objects.remove(o)
    return {'heads': heads, 'tails': tails, 'V': V, 'T': T, 'names': names, 'W': W}


def transfer_weights(dst_V, src):
    """Barycentric interpolation of src weights at the nearest src surface point of each dst vertex."""
    V, T, W = src['V'], src['T'], src['W']
    tree = bvhtree.BVHTree.FromPolygons([Vector(v) for v in V], T.tolist(), all_triangles=True)
    out = np.zeros((len(dst_V), W.shape[1]))
    for i, p in enumerate(dst_V):
        loc, _, fi, _ = tree.find_nearest(Vector(p))
        a, b, c = T[fi]
        A, B, C = V[a], V[b], V[c]
        l = np.array(loc)
        v0, v1, v2 = B - A, C - A, l - A
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-20:
            bw = np.array([1.0, 0, 0])
        else:
            v_ = (d11 * d20 - d01 * d21) / den
            w_ = (d00 * d21 - d01 * d20) / den
            bw = np.clip([1 - v_ - w_, v_, w_], 0, 1)
            bw /= max(bw.sum(), 1e-9)
        out[i] = bw[0] * W[a] + bw[1] * W[b] + bw[2] * W[c]
    return out


# ---------------------------------------------------------------- joints

def symmetric(pr, pl):
    """Average a right point with the mirrored left one: (right, left) exactly mirror-symmetric."""
    r = (np.asarray(pr) + np.asarray(pl) * MIRROR) / 2
    return r, r * MIRROR


def centre(p):
    p = np.array(p, float)
    p[0] = 0.0
    return p


def hand_joints(mesh):
    """Finger / thumb / wrist joints and palm frame per side from the master mesh's own landmarks."""
    out = {}
    for side in ('R', 'L'):
        h = hu.hand(mesh, side)
        J = h['joints']
        radial = unit(h['mcp']['Index'] - h['mcp']['Pinky'])
        out[side] = {
            'wrist': h['wrist'], 'palm': h['palm_normal'], 'radial': radial, 'hand_info': h,
            'Thumb': [J['Thumb']['cmc'], J['Thumb']['mcp'], J['Thumb']['ip'], J['Thumb']['tip']],
            **{f: [J[f]['mcp'], J[f]['pip'], J[f]['dip'], J[f]['tip']] for f in FINGERS},
        }
    return out


def plan_skeleton(spec, meshy, hands, mesh):
    """World heads/tails and roll targets for every canonical bone (right side computed, left mirrored)."""
    H = mesh.height
    z0 = mesh.floor
    mh = meshy['heads']
    FWD, UP = np.array([0.0, -1.0, 0.0]), np.array([0.0, 0.0, 1.0])

    def meshy_pair(name_r):
        return symmetric(mh[name_r], mh[name_r.replace('Right', 'Left')])

    P = {}  # name -> dict(head, tail, z)
    # Centre chain.
    hips = centre(mh['Hips'])
    sp1, sp2, sp3 = centre(mh['Spine02']), centre(mh['Spine01']), centre(mh['Spine'])
    neck, head = centre(mh['neck']), centre(mh['Head'])
    head_top = np.array([0.0, head[1], z0 + H])
    P['Root'] = (np.array([0.0, 0.0, z0]), np.array([0.0, 0.0, z0 + 0.15]), FWD)
    P['Hips'] = (hips, sp1, FWD)
    P['Spine1'] = (sp1, sp2, FWD)
    P['Spine2'] = (sp2, sp3, FWD)
    P['Spine3'] = (sp3, neck, FWD)
    P['Neck'] = (neck, head, FWD)
    P['Head'] = (head, head + (head_top - head) * 0.75, FWD)
    # Arms (right side; the left is mirrored later).
    clav, _ = meshy_pair('RightShoulder')
    shoulder, _ = meshy_pair('RightArm')
    elbow, _ = meshy_pair('RightForeArm')
    wrist, _ = symmetric(hands['R']['wrist'], hands['L']['wrist'])
    palm, _ = symmetric(hands['R']['palm'], hands['L']['palm'])
    radial, _ = symmetric(hands['R']['radial'], hands['L']['radial'])
    P['Clavicle_R'] = (clav, shoulder, FWD)
    P['UpperArm_R'] = (shoulder, elbow, palm)
    P['UpperArmTwist_R'] = (shoulder + (elbow - shoulder) * 0.25, shoulder + (elbow - shoulder) * 0.6, palm)
    P['Forearm_R'] = (elbow, wrist, palm)
    P['ForearmTwist_R'] = (elbow + (wrist - elbow) * 0.33, elbow + (wrist - elbow) * 0.5, palm)
    P['ForearmTwist2_R'] = (elbow + (wrist - elbow) * 0.66, elbow + (wrist - elbow) * 0.9, palm)
    mid_mcp, _ = symmetric(hands['R']['Middle'][0], hands['L']['Middle'][0])
    P['Hand_R'] = (wrist, mid_mcp, palm)
    pad = unit(0.7 * palm - 0.7 * radial)
    for f in ('Thumb',) + FINGERS:
        pts = [symmetric(a, b)[0] for a, b in zip(hands['R'][f], hands['L'][f])]
        z = pad if f == 'Thumb' else palm
        for k in range(3):
            P[f'{f}{k + 1}_R'] = (pts[k], pts[k + 1], z)
    # Legs.
    thigh, _ = meshy_pair('RightUpLeg')
    knee, _ = meshy_pair('RightLeg')
    ankle, _ = meshy_pair('RightFoot')
    ball, _ = meshy_pair('RightToeBase')
    toe_end = ball + unit((ball - ankle) * np.array([1, 1, 0])) * 0.06
    toe_end[2] = ball[2]
    P['Thigh_R'] = (thigh, knee, FWD)
    P['Calf_R'] = (knee, ankle, FWD)
    P['Foot_R'] = (ankle, ball, UP)
    P['Toe_R'] = (ball, toe_end, UP)
    # Sockets (canonical defaults; the weapon socket is refined by the AK-47 validation).
    # Weapon socket: its validated local transform under Hand_R comes from the AK-47 lab fit
    # (src/characters/master/masterRig.json, the one place that canonical value lives).
    rig_data = json.load(open(os.path.join(HERE, '..', '..', 'src', 'characters', 'master', 'masterRig.json')))
    sock = rig_data['sockets']['RightHandWeaponSocket']
    hy = unit(mid_mcp - wrist)
    hz = unit(palm - hy * (palm @ hy))
    hx = np.cross(hy, hz)
    R = np.stack([hx, hy, hz], axis=1)  # Hand_R's bone frame (columns X, Y, Z) at rest
    qx, qy, qz, qw = sock['quaternion']
    Rs = np.array(Quaternion((qw, qx, qy, qz)).to_matrix())
    pos = wrist + R @ np.array(sock['position'])
    S = R @ Rs
    P['RightHandWeaponSocket'] = (pos, pos + S[:, 1] * 0.05, S[:, 2])
    # Gear sockets ON the body surface (a ray from inside the body to its own surface), so a gear
    # item's offset reads as "this far off the crown / face / sternum / back / hip / thigh". Their
    # frames keep the canonical axes; only the origin is placed by the ray.
    tree = bvhtree.BVHTree.FromPolygons([Vector(v) for v in mesh.V], mesh.T.tolist(), all_triangles=True)

    def surface(origin, direction):
        hit = tree.ray_cast(Vector(origin), Vector(unit(direction)))
        if hit[0] is None:
            raise RuntimeError(f'socket ray from {origin} along {direction} missed the body')
        return np.array(hit[0])

    def socket(head_pt, tail_dir, zvec):
        return (head_pt, head_pt + unit(tail_dir) * 0.08, zvec)

    eye_z = z0 + 0.9355 * H  # eye line (Drillis & Contini)
    crown = surface([0.0, head[1], head[2]], UP)
    brow = surface([0.0, head[1], eye_z], FWD)
    sternum = surface([0.0, sp3[1], sp3[2]], FWD)
    back = surface([0.0, sp3[1], sp3[2]], -FWD)
    hip = surface([0.0, hips[1], hips[2] + 0.05], [-1.0, 0.0, 0.0])  # at the trouser waistband
    tpt = thigh + (knee - thigh) * 0.35
    outer_thigh = surface(tpt, [-1.0, 0.0, 0.0])
    P['HeadSocket'] = socket(crown, UP, FWD)
    P['FaceSocket'] = socket(brow, FWD, UP)
    P['ChestSocket'] = socket(sternum, UP, FWD)
    P['BackSocket'] = socket(back, UP, FWD)
    P['BeltSocket_R'] = socket(hip, UP, FWD)
    P['ThighSocket_R'] = socket(outer_thigh, UP, FWD)
    # Mirror every right-side bone to the left.
    for b in spec['bones']:
        n = b['name']
        if n in P and (n.endswith('_R') or n == 'RightHandWeaponSocket'):
            h_, t_, z_ = P[n]
            P[side_name(n, 'L')] = (h_ * MIRROR, t_ * MIRROR, z_ * MIRROR)
    return P


def build_armature(spec, P):
    arm_data = bpy.data.armatures.new('MASTER_HUMANOID_RIG')
    arm = bpy.data.objects.new('MASTER_HUMANOID_RIG', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    order = []
    for b in spec['bones']:
        sides = ['R', 'L'] if (b['name'].endswith('_R') or b['name'] == 'RightHandWeaponSocket') else [None]
        for s in sides:
            n = side_name(b['name'], s) if s else b['name']
            parent = side_name(b['parent'], s) if (s and b['parent']) else b['parent']
            order.append((n, parent, b.get('deform', True)))
    for n, parent, deform in order:
        h, t, z = P[n]
        e = eb.new(n)
        e.head, e.tail = Vector(h), Vector(t)
        e.align_roll(Vector(z))
        e.use_deform = deform
        e.use_connect = False
    for n, parent, deform in order:
        if parent:
            eb[n].parent = eb[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm, [n for n, _, _ in order]


# ---------------------------------------------------------------- weights

def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + np.outer(t, ab)), axis=1)


def plate_dist(P, quad):
    """Distance to the palm plate (two triangles of a quad)."""
    from mathutils.geometry import closest_point_on_tri
    out = np.empty(len(P))
    A, B, C, D = (Vector(q) for q in quad)
    for i, p in enumerate(P):
        v = Vector(p)
        out[i] = min((closest_point_on_tri(v, A, B, C) - v).length, (closest_point_on_tri(v, A, C, D) - v).length)
    return out


def hand_weights(mesh, X, side, P):
    """Weights inside the hand region: {bone: array} for the region's vertices (rig-arms rules)."""
    h = hu.hand(mesh, side, X)
    region = np.nonzero(h['region'])[0]
    s = '_' + side
    fingers_of = {}
    for name, f in h['fingers'].items():
        for v in f['ids']:
            fingers_of[int(v)] = name
    wrist = P['Hand' + s][0]
    mcp = {f: P[f'{f}1{s}'][0] for f in FINGERS}
    radial = unit(mcp['Index'] - mcp['Pinky'])
    half = np.linalg.norm(mcp['Index'] - mcp['Pinky']) / 2
    plate = [wrist - radial * half * 0.75, mcp['Pinky'], mcp['Index'], wrist + radial * half * 0.75]
    seg = {n: (P[n][0], P[n][1]) for n in P if n.endswith(s)}
    W = {}
    Xr = X[region]
    finger_mask = np.array([int(v) in fingers_of for v in region])
    # Trunk (palm + wrist + forearm part): ForearmTwist2 (the distal forearm), Hand (plate), the five base bones.
    trunk_bones = ['ForearmTwist2' + s, 'Hand' + s, 'Thumb1' + s] + [f'{f}1{s}' for f in FINGERS]
    tid = np.nonzero(~finger_mask)[0]
    D = []
    for b in trunk_bones:
        if b == 'Hand' + s:
            d = plate_dist(Xr[tid], plate)
        else:
            a, c = seg[b] if b != 'ForearmTwist2' + s else (P['Forearm' + s][0], P['Forearm' + s][1])
            d = seg_dist(Xr[tid], a, c)
        if b == 'Thumb1' + s:
            d = d / 1.5  # THUMB_BALL: the thenar follows the thumb's metacarpal
        D.append(d)
    D = np.array(D)
    inv = 1.0 / np.maximum(D, 1e-4) ** POWER
    for k, b in enumerate(trunk_bones):
        W.setdefault(b, np.zeros(len(region)))[tid] = inv[k]
    # Digits: their own three bones and the Hand only.
    for name in ('Thumb',) + FINGERS:
        ids = np.array([i for i, v in enumerate(region) if fingers_of.get(int(v)) == name])
        if len(ids) == 0:
            continue
        bones = [f'{name}{k}{s}' for k in (1, 2, 3)] + ['Hand' + s]
        D = []
        for b in bones:
            D.append(plate_dist(Xr[ids], plate) if b == 'Hand' + s else seg_dist(Xr[ids], *seg[b]))
        inv = 1.0 / np.maximum(np.array(D), 1e-4) ** POWER
        for k, b in enumerate(bones):
            W.setdefault(b, np.zeros(len(region)))[ids] = inv[k]
    tot = sum(W.values())
    for b in W:
        W[b] = W[b] / np.maximum(tot, 1e-12)
    up = -h['forearm_dir']
    t_up = (Xr - h['wrist']) @ up
    return region, W, t_up


HEAT_BONES_SKIP = ('Twist', 'Thumb', 'Index', 'Middle', 'Ring', 'Pinky')


def heat_weights(obj, arm, names):
    """Blender's bone-heat automatic weights for the body bones (twist and finger bones excluded:
    they get their own splits / hand weights). Returns (verts x bones) over `names`."""
    saved = {}
    for b in arm.data.bones:
        saved[b.name] = b.use_deform
        if any(k in b.name for k in HEAT_BONES_SKIP) or not b.use_deform:
            b.use_deform = False
    for o in bpy.context.scene.objects:
        o.select_set(o in (obj, arm))
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    W = np.zeros((len(obj.data.vertices), len(names)))
    gi = {g.index: g.name for g in obj.vertex_groups}
    idx = {n: i for i, n in enumerate(names)}
    for v in obj.data.vertices:
        for g in v.groups:
            n = gi[g.group]
            if n in idx:
                W[v.index, idx[n]] = g.weight
    # Undo: remove groups, modifier and parent so the caller builds the final skin cleanly.
    obj.vertex_groups.clear()
    for m in list(obj.modifiers):
        obj.modifiers.remove(m)
    mw = obj.matrix_world.copy()
    obj.parent = None
    obj.matrix_world = mw
    for b in arm.data.bones:
        b.use_deform = saved[b.name]
    s = W.sum(axis=1)
    log(f'heat weights: {int((s < 0.5).sum())} verts with little weight')
    return W


def build_weights(mesh, X, meshy, names, P, source='meshy', heat=None):
    """Final weight matrix (verts x bones) over the canonical bone names."""
    idx = {n: i for i, n in enumerate(names)}
    W = np.zeros((len(X), len(names)))
    # 1. Transferred Meshy weights, renamed.
    rename = {'Hips': 'Hips', 'Spine02': 'Spine1', 'Spine01': 'Spine2', 'Spine': 'Spine3', 'neck': 'Neck', 'Head': 'Head',
              'head_end': 'Head', 'headfront': 'Head'}
    for s, word in (('R', 'Right'), ('L', 'Left')):
        for m, c in (('Shoulder', 'Clavicle'), ('Arm', 'UpperArm'), ('ForeArm', 'Forearm'), ('Hand', 'Hand'),
                     ('UpLeg', 'Thigh'), ('Leg', 'Calf'), ('Foot', 'Foot'), ('ToeBase', 'Toe')):
            rename[word + m] = f'{c}_{s}'
    Wm = transfer_weights(X, meshy)
    unknown = []
    for k, g in enumerate(meshy['names']):
        c = rename.get(g)
        if c is None:
            unknown.append(g)
            c = 'Hips'
        W[:, idx[c]] += Wm[:, k]
    if unknown:
        log('unmapped Meshy groups (folded into Hips):', unknown)
    if source == 'heat' and heat is not None:
        # Bone heat everywhere it reached; Meshy's transferred weights only where it did not.
        weak = heat.sum(axis=1) < 0.5
        W = np.where(weak[:, None], W, heat)
    elif source == 'blend' and heat is not None:
        # Heat weights around the shoulders / armpits (where Meshy binds torso-side skin to the
        # arm), Meshy's elsewhere; smooth 12 -> 20 cm falloff from each shoulder joint.
        k = np.zeros(len(X))
        for s_ in ('R', 'L'):
            d = np.linalg.norm(X - P['UpperArm_' + s_][0], axis=1)
            k = np.maximum(k, 1 - np.clip((d - 0.12) / 0.08, 0, 1))
        k = k * k * (3 - 2 * k)
        W = W * (1 - k[:, None]) + heat * k[:, None]
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-12)
    # 2. Twist splits along the bones.
    for s in ('R', 'L'):
        sh, el = P['UpperArm_' + s][0], P['UpperArm_' + s][1]
        wr = P['Forearm_' + s][1]
        t = np.clip(((X - el) @ (wr - el)) / max((wr - el) @ (wr - el), 1e-12), 0, 1)
        # Forearm skin in thirds: Forearm (no roll) near the elbow, ForearmTwist (1/3 of the hand's roll)
        # through the middle, ForearmTwist2 (2/3) toward the wrist; smooth ramps, a partition of unity.
        r1 = np.clip((t - 0.10) / 0.40, 0, 1)
        r1 = r1 * r1 * (3 - 2 * r1)  # 0 at 10 %, 1 at 50 % of the forearm
        r2 = np.clip((t - 0.45) / 0.40, 0, 1)
        r2 = r2 * r2 * (3 - 2 * r2)  # 0 at 45 %, 1 at 85 %
        a, b, c = idx['Forearm_' + s], idx['ForearmTwist_' + s], idx['ForearmTwist2_' + s]
        w = W[:, a].copy()
        W[:, a] = w * (1 - r1)
        W[:, b] += w * r1 * (1 - r2)
        W[:, c] += w * r1 * r2
        u = np.clip(((X - sh) @ (el - sh)) / max((el - sh) @ (el - sh), 1e-12), 0, 1)
        g = 1 - np.clip((u - 0.1) / 0.5, 0, 1)
        g = g * g * (3 - 2 * g)
        a, b = idx['UpperArm_' + s], idx['UpperArmTwist_' + s]
        W[:, b] += W[:, a] * g * 0.5  # the twist bone shares the shoulder half, it does not own it
        W[:, a] *= (1 - g * 0.5)
    # 3. Hands from the digits' regions, blended into the forearm 4-8 cm above the wrist.
    mesh_tmp = mesh
    for s in ('R', 'L'):
        region, Wh, t_up = hand_weights(mesh_tmp, X, s, P)
        blend = 1 - np.clip((t_up - 0.04) / 0.04, 0, 1)
        old = W[region].copy()
        new = np.zeros_like(old)
        for b, w in Wh.items():
            new[:, idx[b]] = w
        W[region] = old * (1 - blend[:, None]) + new * blend[:, None]
    # 4. At most 4 influences, normalised; drop tiny weights.
    W[W < 0.005] = 0
    keep = np.argsort(-W, axis=1)[:, :4]
    mask = np.zeros_like(W, bool)
    np.put_along_axis(mask, keep, True, axis=1)
    W[~mask] = 0
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-12)
    return W


# ---------------------------------------------------------------- export

def skeleton_json(arm, spec):
    bones = []
    for b in arm.data.bones:
        rest = b.matrix_local  # armature space (Blender Z-up)
        loc = b.parent.matrix_local.inverted() @ rest if b.parent else rest
        q = loc.to_quaternion()
        t = loc.to_translation()
        bones.append({'name': b.name, 'parent': b.parent.name if b.parent else None, 'deform': b.use_deform,
                      'restLocalBlender': {'t': list(t), 'q': [q.x, q.y, q.z, q.w]},
                      'headBlender': list(b.head_local), 'tailBlender': list(b.tail_local),
                      'bindMatrixBlender': [list(r) for r in rest]})
    return {'name': spec['name'], 'version': spec['version'], 'notes': spec['notes'],
            'space': 'Blender armature space (Z up, character faces -Y); the GLB is the runtime truth (glTF Y up, faces +Z)',
            'bones': bones}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    master_path, meshy_path, out_dir = (os.path.abspath(a) for a in argv[:3])
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    spec = json.load(open(os.path.join(HERE, 'canonical_skeleton.json')))
    obj = hu.import_glb(master_path)
    obj.name = 'MasterBody'
    # Origin on the floor between the feet (game convention): feet at z = 0, x centred.
    V0 = hu.Mesh(obj).V
    shift = np.array([-(V0[:, 0].min() + V0[:, 0].max()) / 2, 0.0, -V0[:, 2].min()])
    obj.data.transform(Matrix.Translation(Vector(shift)))
    obj.data.update()
    mesh = hu.Mesh(obj)
    X = mesh.V.copy()
    meshy = load_meshy(meshy_path)
    # Meshy re-centres its result: align its data to ours by the bounding boxes (x/y centre, floor).
    mv = meshy['V']
    off = np.array([(X[:, 0].min() + X[:, 0].max() - mv[:, 0].min() - mv[:, 0].max()) / 2,
                    (X[:, 1].min() + X[:, 1].max() - mv[:, 1].min() - mv[:, 1].max()) / 2,
                    X[:, 2].min() - mv[:, 2].min()])
    meshy['V'] = mv + off
    meshy['heads'] = {k: v + off for k, v in meshy['heads'].items()}
    meshy['tails'] = {k: v + off for k, v in meshy['tails'].items()}
    log(f'aligned Meshy data by {np.round(off * 1000, 1)} mm')
    log(f"Meshy: {len(meshy['heads'])} joints {sorted(meshy['heads'])}")
    hands = hand_joints(mesh)
    # Wrist centres from the SOURCE mesh's landmarks when given: the anatomical wrist does not move
    # in the cleanup, but slimming the glove cuff moves where the palm section turns round (the
    # detector's cue) toward the knuckles.
    wl = next((a[9:] for a in argv[3:] if a.startswith('--wrists=')), None)
    if wl:
        L = json.load(open(os.path.abspath(wl)))
        for s_ in ('R', 'L'):
            g = L['sides'][s_]['wrist']  # glTF (x, y, z) of the source -> Blender (x, -z, y) + our shift
            hands[s_]['wrist'] = np.array([g[0], -g[2], g[1]]) + shift
        log('wrist centres from', wl)
    P = plan_skeleton(spec, meshy, hands, mesh)
    arm, names = build_armature(spec, P)
    log(f'canonical skeleton: {len(names)} bones')
    source = next((a[10:] for a in argv[3:] if a.startswith('--weights=')), 'heat')
    heat = heat_weights(obj, arm, names) if source in ('heat', 'blend') else None
    W = build_weights(mesh, X, meshy, names, P, source, heat)
    log(f'body weights: {source}')
    deform = [n for n in names if arm.data.bones[n].use_deform]
    for n in deform:
        vg = obj.vertex_groups.new(name=n)
        col = W[:, names.index(n)]
        for i in np.nonzero(col > 0)[0]:
            vg.add([int(i)], float(col[i]), 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    rep = {'bones': len(names), 'deformBones': len(deform), 'vertices': mesh.n,
           'maxInfluences': int((W > 0).sum(axis=1).max()), 'meanInfluences': float((W > 0).sum(axis=1).mean()),
           'unweighted': int((W.sum(axis=1) < 0.99).sum()), 'seconds': time.time() - t0}
    log(f"skin: max {rep['maxInfluences']} / mean {rep['meanInfluences']:.2f} influences, {rep['unweighted']} unweighted verts")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, 'master_humanoid_rigged.blend'))
    for o in bpy.context.scene.objects:
        o.select_set(o in (obj, arm))
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, 'master_humanoid_rigged.glb'), use_selection=True,
                              export_format='GLB', export_yup=True, export_skins=True, export_animations=False,
                              export_def_bones=False, export_tangents=True)
    bpy.ops.export_scene.fbx(filepath=os.path.join(out_dir, 'master_humanoid_rigged.fbx'), use_selection=True,
                             add_leaf_bones=False, bake_anim=False, axis_forward='-Z', axis_up='Y')
    json.dump(skeleton_json(arm, spec), open(os.path.join(out_dir, 'skeleton.json'), 'w'), indent=1)
    json.dump(rep, open(os.path.join(out_dir, 'rig_report.json'), 'w'), indent=1)
    log(f'wrote {out_dir} in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
