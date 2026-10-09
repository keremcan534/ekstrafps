"""Find and dump the hand/arm landmarks of a humanoid GLB (debug + validation input).

  node scripts/blender.mjs scripts/blender/landmarks.py <in.glb> <out.json> [markers.json]

out.json: per side the digits (persistence, web level, joints), wrist pivot, forearm/hand axes, palm
normal, thumb direction and wrist angles. markers.json (optional): the same points in glTF space for
scripts/glb-views.cjs --markers=.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402

import humanoid as hu  # noqa: E402


def to_gltf(p):
    """Blender Z-up (x, y, z) -> glTF Y-up (x, z, -y)."""
    return [float(p[0]), float(p[2]), float(-p[1])]


def analyse(mesh):
    out = {'height': mesh.height, 'sides': {}}
    markers = []
    colours = {'Thumb': '#ff4040', 'Index': '#ffa020', 'Middle': '#f0f040', 'Ring': '#40d040', 'Pinky': '#40a0ff'}
    for side in ('R', 'L'):
        h = hu.hand(mesh, side)
        flex, dev = hu.wrist_angles(h)
        J = h['joints']
        s = {
            'persistence': h['persistence'],
            'digits': {n: {'web': f['web'], 'length': f['length'], 'tip': to_gltf(f['tipPos']), 'vertices': int(len(f['ids']))}
                       for n, f in h['fingers'].items()},
            'joints': {n: {k: to_gltf(v) for k, v in j.items() if k != 'length'} for n, j in J.items()},
            'wrist': to_gltf(h['wrist']),
            'forearmDir': to_gltf(h['forearm_dir']),
            'handAxis': to_gltf(h['hand_axis']),
            'palmNormal': to_gltf(h['palm_normal']),
            'thumbDir': to_gltf(h['thumb_dir']),
            'wristFlexDeg': flex,
            'wristDevDeg': dev,
            'elbow': to_gltf(h['elbow_est']),
            'palmLength': h['palm_len'],
            'wristBy': h['wrist_by'],
        }
        out['sides'][side] = s
        markers.append({'p': to_gltf(h['wrist']), 'color': '#ffffff', 'r': 0.012})
        for n, j in J.items():
            for k, v in j.items():
                if k != 'length':
                    markers.append({'p': to_gltf(v), 'color': colours[n], 'r': 0.006})
        for q in h['arm_line']['points'][::2]:
            markers.append({'p': to_gltf(q), 'color': '#a0a0a0', 'r': 0.004})
        markers.append({'p': to_gltf(h['elbow_est']), 'color': '#ff00ff', 'r': 0.012})
        markers.append({'line': [to_gltf(h['elbow_est']), to_gltf(h['wrist'] + h['forearm_dir'] * 0.1)], 'color': '#ff00ff'})
        markers.append({'line': [to_gltf(h['wrist']), to_gltf(h['mcp']['Middle'])], 'color': '#ffff00'})
        markers.append({'line': [to_gltf(h['wrist']), to_gltf(h['wrist'] + h['palm_normal'] * 0.08)], 'color': '#0080ff'})
        markers.append({'line': [to_gltf(h['wrist']), to_gltf(h['wrist'] + h['forearm_dir'] * 0.12)], 'color': '#00ff00'})
        markers.append({'line': [to_gltf(h['wrist']), to_gltf(h['wrist'] + h['thumb_dir'] * 0.06)], 'color': '#ff0000'})
    return out, markers


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    obj = hu.import_glb(os.path.abspath(argv[0]))
    mesh = hu.Mesh(obj)
    out, markers = analyse(mesh)
    with open(argv[1], 'w') as f:
        json.dump(out, f, indent=1)
    if len(argv) > 2:
        with open(argv[2], 'w') as f:
            json.dump(markers, f)
    for side, s in out['sides'].items():
        print(side, 'digits', {n: round(d['length'], 3) for n, d in s['digits'].items()},
              'persistence', [round(p, 3) for p, v in s['persistence']],
              'flex %.1f dev %.1f' % (s['wristFlexDeg'], s['wristDevDeg']))
