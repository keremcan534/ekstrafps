"""Game textures of one look from its Meshy maps + the master's baked maps (system Python: Pillow + numpy).

  python scripts/make_look.py <look> [<look> ...]

In:  production/assets/src/chars/master/texture/<look>/   base_color.png, roughness.png, metallic.png,
                                                          normal.png (Meshy, on the master's UVs)
     production/assets/src/chars/master/texture/baked/   normal.png (geometric, from the high-res
                                                          source), ao.png
Out: public/assets/characters/textures/<look>/
     base_color.webp 2048 + base_color_1k.webp      (sRGB)
     normal.webp 2048 + normal_512.webp             the baked geometric normal with the look's
                                                    fabric normal on top (whiteout blend)
     orm.webp 1024 + orm_512.webp                   R occlusion (baked), G roughness, B metallic
Phones get 1K colour / 512 maps (the phone texture budget).
Cleanup rule: no skin on the hands or forearms (texture/baked/mask_arms.png, scripts/blender/region_masks.py):
every look is gloved and long-sleeved, but Meshy paints a "glove gap" or a rolled sleeve from the
reference image; skin-coloured texels there are repainted in the look's own glove / sleeve colour.
Palettes (LOOKS below): one cloth colour of a look (its chromaticity) repainted in another, keeping
the painted shading; the head and neck are never touched. A look with `from` is a colour version
of another look: it gets only its own base colour, plus look.json {"maps": <from>} - the runtime
shares that look's normal / ORM maps (one download, one GPU copy).
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.join(ROOT, 'production/assets/src/chars/master/texture')
LUMA = np.array([0.299, 0.587, 0.114], np.float32)
TAN, GREEN = (0.428, 0.331), (0.343, 0.389)  # chromaticity (r, g over r+g+b) of the PMC shirt / sleeves + trousers
LOOKS = {
    # Meshy's PMC shirt is a peach tan that reads as bare skin under the vest: khaki instead.
    'pmc': {'palette': [(TAN, (178, 160, 122))]},
    # The three rival PMC teams (bravo / charlie / delta) must be told apart: tan, green, grey.
    'pmc_green': {'from': 'pmc', 'palette': [(TAN, (112, 116, 80))]},
    'pmc_grey': {'from': 'pmc', 'palette': [(TAN, (150, 152, 150)), (GREEN, (72, 76, 80))]},
    # Salvagers (the old kit's palette): faded denim shirt, workwear-brown trousers.
    'salvage': {'from': 'pmc', 'palette': [(TAN, (76, 90, 107)), (GREEN, (91, 74, 54))]},
}


def load(path, size, mode='RGB'):
    im = Image.open(path).convert(mode)
    return im.resize((size, size), Image.LANCZOS) if im.size != (size, size) else im


def unpack(im):
    a = np.asarray(im).astype(np.float32) / 255.0
    return a * 2 - 1


def whiteout(base, detail):
    """Whiteout blend of two tangent-space normal maps (detail on top of base)."""
    n = np.stack([base[..., 0] + detail[..., 0], base[..., 1] + detail[..., 1], base[..., 2] * detail[..., 2]], -1)
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)


T_LO, T_HI = -0.25, 0.30  # metres along the forearm in mask_arms.png G (scripts/blender/region_masks.py)
CUFF = -0.015  # glove below this (m from the wrist centre), sleeve above
SLEEVE_REF = (0.12, 0.23)  # where the sleeve colour is sampled


def blur(x, radius):
    im = Image.fromarray((np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255.0


def no_skin(rgb, arms):
    """Skin-coloured texels on the hands and forearms -> the look's glove / sleeve colour.

    Each zone is repainted with the median colour of its own non-skin texels (glove: the hand; sleeve:
    the upper forearm), modulated by the painted shading (blurred luminance), with a soft 2 px rim so no
    skin-tinted outline is left behind."""
    a = rgb.astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    arm = arms[..., 0] > 0.5
    t = arms[..., 1] * (T_HI - T_LO) + T_LO
    skin = (r > g * 1.04) & (g > b * 0.85) & (sat > 0.10) & (mx > 0.14) & arm  # warm skin tones, incl. shaded ones
    if not skin.any():
        return rgb, 0
    lum = blur(a @ np.array([0.299, 0.587, 0.114], np.float32), 3)
    new = np.zeros_like(a)
    done = np.zeros(arm.shape, bool)
    for zone, ref in ((arm & (t < CUFF), arm & (t < CUFF)),
                      (arm & (t >= CUFF), arm & (t > SLEEVE_REF[0]) & (t < SLEEVE_REF[1]))):
        pick = ref & ~skin
        if pick.sum() < 200 or not (skin & zone).any():
            continue
        colour = np.median(a[pick], axis=0)
        k = np.clip(lum / max(float(np.median(lum[skin & zone])), 1e-3), 0.85, 1.15)
        new[zone] = colour * k[zone][:, None]
        done |= zone
    grown = np.asarray(Image.fromarray(skin.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    alpha = blur((grown & done).astype(np.float32), 1.0)[..., None] * done[..., None]
    out = a * (1 - alpha) + new * alpha
    return (out * 255 + 0.5).clip(0, 255).astype(np.uint8), int(skin.sum())


def recolour(a, centre, target, keep=None, sigma=0.022):
    """Texels of one cloth colour (chromaticity `centre`) -> the sRGB `target`, keeping their shading.

    a: float RGB 0..1. Membership is a Gaussian in chromaticity, faded out for greys (no hue to
    match); `keep` texels are never changed. Returns (new a, texels mostly repainted)."""
    s = a.sum(-1) + 1e-6
    cr, cg = a[..., 0] / s, a[..., 1] / s
    mx, mn = a.max(-1), a.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    m = np.exp(-((cr - centre[0]) ** 2 + (cg - centre[1]) ** 2) / (2 * sigma ** 2)) * np.clip((sat - 0.06) / 0.12, 0, 1)
    if keep is not None:
        m = m * ~keep
    lum = a @ LUMA
    sel = m > 0.5
    if not sel.any():
        return a, 0
    k = np.clip(lum / float(np.median(lum[sel])), 0.3, 1.8)
    new = np.clip(np.array(target, np.float32)[None, None, :] / 255.0 * k[..., None], 0, 1)
    return a * (1 - m[..., None]) + new * m[..., None], int(sel.sum())


def save(arr_or_im, path, size=None, quality=90):
    im = arr_or_im if isinstance(arr_or_im, Image.Image) else Image.fromarray(arr_or_im)
    if size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(path, 'WEBP', quality=quality, method=6)


def main(look):
    spec = LOOKS.get(look, {})
    src = os.path.join(SRC, spec.get('from', look))
    out = os.path.join(ROOT, 'public/assets/characters/textures', look)
    os.makedirs(out, exist_ok=True)
    base = load(os.path.join(src, 'base_color.png'), 2048)
    mask_p = os.path.join(SRC, 'baked', 'mask_arms.png')
    if os.path.exists(mask_p):
        arms = np.asarray(Image.open(mask_p).convert('RGB').resize((2048, 2048), Image.NEAREST)).astype(np.float32) / 255.0
        fixed, n = no_skin(np.asarray(base), arms)
        base = Image.fromarray(fixed)
        print(f'[look] {look}: {n} skin texels repainted on the hands / forearms')
    if spec.get('palette'):
        head = np.asarray(Image.open(os.path.join(SRC, 'baked', 'mask_body.png')).convert('RGB').resize((2048, 2048), Image.NEAREST))[..., 0] > 127
        a = np.asarray(base).astype(np.float32) / 255.0
        for centre, target in spec['palette']:
            a, n = recolour(a, centre, target, keep=head)
            print(f'[look] {look}: {n} texels of {centre} -> {target}')
        base = Image.fromarray((a * 255 + 0.5).clip(0, 255).astype(np.uint8))
    save(base, os.path.join(out, 'base_color.webp'))
    save(base, os.path.join(out, 'base_color_1k.webp'), 1024)
    if 'from' in spec:
        # A colour version: the source look's normal / ORM maps are shared at runtime.
        for f in ('normal.webp', 'normal_512.webp', 'orm.webp', 'orm_512.webp'):
            if os.path.exists(os.path.join(out, f)):
                os.remove(os.path.join(out, f))
        with open(os.path.join(out, 'look.json'), 'w') as fh:
            json.dump({'maps': spec['from']}, fh)
        print(f'[look] {look}: colour version of {spec["from"]} -> {os.path.relpath(out, ROOT)}')
        return
    geo = unpack(load(os.path.join(SRC, 'baked', 'normal.png'), 2048))
    fab_p = os.path.join(src, 'normal.png')
    n = whiteout(geo, unpack(load(fab_p, 2048))) if os.path.exists(fab_p) else geo
    nimg = ((n * 0.5 + 0.5) * 255 + 0.5).clip(0, 255).astype(np.uint8)
    save(nimg, os.path.join(out, 'normal.webp'), quality=95)
    save(nimg, os.path.join(out, 'normal_512.webp'), 512, quality=95)
    ao = np.asarray(load(os.path.join(SRC, 'baked', 'ao.png'), 1024, 'L'))
    rough_p, metal_p = os.path.join(src, 'roughness.png'), os.path.join(src, 'metallic.png')
    rough = np.asarray(load(rough_p, 1024, 'L')) if os.path.exists(rough_p) else np.full((1024, 1024), 200, np.uint8)
    metal = np.asarray(load(metal_p, 1024, 'L')) if os.path.exists(metal_p) else np.zeros((1024, 1024), np.uint8)
    orm = np.stack([ao, rough, metal], -1)
    save(orm, os.path.join(out, 'orm.webp'), quality=92)
    save(orm, os.path.join(out, 'orm_512.webp'), 512, quality=92)
    print(f'[look] {look}: textures -> {os.path.relpath(out, ROOT)}')


if __name__ == '__main__':
    for name in sys.argv[1:]:
        main(name)
