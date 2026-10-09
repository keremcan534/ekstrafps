"""Texture-variant folder of a gear item from a Meshy retexture of it (same UVs: enable_original_uv),
or a local colour version of the item itself:

  python scripts/gear-variant.py <retextured.glb> <out_dir> [--size=1024]
  python scripts/gear-variant.py <item.glb> <out_dir> --recolour=R,G,B   (its main cloth colour -> R,G,B,
                                                    shading kept; writes only the base colour: the runtime
                                                    keeps the item's own normal / ORM maps)
  python scripts/gear-variant.py <item.glb> <out_dir> --solid=R,G,B      (a flat-coloured item, e.g. the
                                                    backpack straps: an 8 x 8 base colour of R,G,B)

Writes <out_dir>/base_color.webp (sRGB), normal.webp (tangent space, OpenGL +Y as glTF) and
orm.webp (R occlusion, 255 where the source has none; G roughness; B metallic: glTF order), plus
the phone copies base_color_1k / normal_512 / orm_512 - the same names as a look
(src/characters/README.md). The gear JSON points at the folder from
`variants`: {"<look>": "<folder relative to the gear JSON>"}; the runtime swaps the maps of the
gear's material when the character's look matches.
"""
import io
import json
import os
import struct
import sys

from PIL import Image


def glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    off = 20 + n
    bin_len = struct.unpack('<I', b[off:off + 4])[0]
    return j, b[off + 8:off + 8 + bin_len]


def image(j, blob, tex_index):
    tex = j['textures'][tex_index]
    src = tex['source'] if 'source' in tex else tex['extensions']['EXT_texture_webp']['source']
    im = j['images'][src]
    bv = j['bufferViews'][im['bufferView']]
    start = bv.get('byteOffset', 0)
    return Image.open(io.BytesIO(blob[start:start + bv['byteLength']]))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    size = int(next((a[7:] for a in sys.argv[1:] if a.startswith('--size=')), 1024))
    recol = next((a[11:] for a in sys.argv[1:] if a.startswith('--recolour=')), None)
    solid = next((a[8:] for a in sys.argv[1:] if a.startswith('--solid=')), None)
    src, out = args
    if solid:
        os.makedirs(out, exist_ok=True)
        im = Image.new('RGB', (8, 8), tuple(int(c) for c in solid.split(',')))
        for name in ('base_color.webp', 'base_color_1k.webp'):
            im.save(os.path.join(out, name), quality=95)
        print(f'{src} -> {out}: solid {solid}')
        return
    j, blob = glb(src)
    mat = j['materials'][0]
    pbr = mat.get('pbrMetallicRoughness', {})
    os.makedirs(out, exist_ok=True)

    def fit(im):
        im = im.copy()
        im.thumbnail((size, size), Image.LANCZOS)
        return im
    def save(im, name, q, phone):
        im.save(os.path.join(out, f'{name}.webp'), quality=q, method=6)
        # Phone copies under the look names (1K colour / 512 maps: the phone texture budget).
        p = im.copy()
        p.thumbnail((phone, phone), Image.LANCZOS)
        p.save(os.path.join(out, f'{name}_{"1k" if phone == 1024 else phone}.webp'), quality=q, method=6)
    bc = fit(image(j, blob, pbr['baseColorTexture']['index']).convert('RGB'))
    if recol:
        import numpy as np
        from make_look import recolour
        a = np.asarray(bc).astype(np.float32) / 255.0
        s = a.sum(-1) + 1e-6
        mx, mn = a.max(-1), a.min(-1)
        cloth = (mx - mn) / np.maximum(mx, 1e-6) > 0.15  # the main cloth colour: median hue of the coloured texels
        centre = (float(np.median((a[..., 0] / s)[cloth])), float(np.median((a[..., 1] / s)[cloth])))
        a, n = recolour(a, centre, [int(c) for c in recol.split(',')], sigma=0.03)
        bc = Image.fromarray((a * 255 + 0.5).clip(0, 255).astype(np.uint8))
        save(bc, 'base_color', 90, 1024)
        print(f'{src} -> {out}: {n} texels of {tuple(round(c, 3) for c in centre)} -> {recol}')
        return
    save(bc, 'base_color', 90, 1024)
    if 'normalTexture' in mat:
        nm = fit(image(j, blob, mat['normalTexture']['index']).convert('RGB'))
        save(nm, 'normal', 92, 512)
    if 'metallicRoughnessTexture' in pbr:
        mr = fit(image(j, blob, pbr['metallicRoughnessTexture']['index']).convert('RGB'))
        r, g, b = mr.split()
        if 'occlusionTexture' in mat:
            occ = fit(image(j, blob, mat['occlusionTexture']['index']).convert('RGB')).split()[0].resize(mr.size)
        else:
            occ = Image.new('L', mr.size, 255)
        save(Image.merge('RGB', (occ, g, b)), 'orm', 92, 512)
    print(f'{src} -> {out}: ' + ', '.join(sorted(os.listdir(out))))


if __name__ == '__main__':
    main()
