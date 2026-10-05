"""Post effects on captured game frames (trailer v4). Pure numpy on HxWx3 float32 arrays
(0..255), deterministic (noise is seeded by frame number).

  grade(img, look)        lift / gamma / gain, a cool-shadow / warm-highlight split, contrast
  grain(img, f, amt)      animated luma grain
  vignette(img, amt)      soft corner falloff (the heartbeat pulses this)
  shake(img, dx, dy, rot) camera kick, image-space (reframes inside the drift crop)
  aberrate(img, px)       lateral chromatic aberration (R out, B in), for gunshot pulses
  nvg(img, f)             SABLE night vision: green phosphor, bloom, noise, scanlines, fisheye-ish vignette
  glitch(img, f, amt)     digital tear: RGB split, displaced slices, block noise (radio / NVG cuts)
  whip(a, b, k, axis)     whip-pan transition between two frames (directional smear)
"""
import numpy as np
from PIL import Image, ImageFilter

LOOKS = {
    # name: (lift, gamma, gain, shadow tint, highlight tint, saturation, contrast)
    "neutral": (0.0, 1.0, 1.0, (0, 0, 0), (0, 0, 0), 1.0, 1.0),
    # Cold open / insertion: steel blue shadows, a little warmth up top.
    "steel": (2.0, 1.02, 1.04, (-2, 1, 6), (6, 2, -4), 0.85, 1.06),
    # Site-9 gameplay: deep blacks, teal shadows, warm practicals.
    "site9": (0.0, 1.04, 1.06, (-3, 2, 5), (8, 2, -6), 0.92, 1.10),
    # SABLE: colder, harder, desaturated except the reds.
    "sable": (0.0, 1.08, 1.05, (-4, 1, 7), (4, 0, -3), 0.78, 1.16),
    # The ending: almost monochrome, crushed.
    "end": (0.0, 1.12, 1.02, (-2, 0, 3), (2, 0, -2), 0.55, 1.18),
}


def grade(a, look="site9"):
    lift, gamma, gain, sh, hi, sat, con = LOOKS[look]
    x = np.clip(a / 255.0, 0, 1)
    x = x * gain + lift / 255.0 * (1 - x)
    x = np.power(np.clip(x, 0, 1), 1.0 / gamma)
    lum = (x * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(-1, keepdims=True)
    # Saturation (reds kept: SABLE's light stays red while the rest goes grey).
    red = np.clip((x[..., :1] - np.maximum(x[..., 1:2], x[..., 2:3])) * 3, 0, 1)
    s = sat + (1 - sat) * red * 0.8
    x = lum + (x - lum) * s
    # Split tone by luminance.
    w = lum
    x = x + (np.array(sh, np.float32) / 255.0) * (1 - w) + (np.array(hi, np.float32) / 255.0) * w
    # Contrast S-curve around mid grey.
    x = np.clip(x, 0, 1)
    x = 0.5 + (x - 0.5) * con
    x = x + (x - 0.5) * (1 - np.abs(2 * x - 1)) * 0.08 * (con - 1) * 10
    return np.clip(x, 0, 1) * 255.0


_noise = {}


def grain(a, f, amt=5.0):
    h, w = a.shape[:2]
    key = (h, w)
    if key not in _noise:
        r = np.random.default_rng(1234)
        _noise[key] = r.standard_normal((8, h // 2 + 1, w // 2 + 1)).astype(np.float32)
    n = _noise[key][f % 8]
    # Shift the tile per frame so the 8 noise fields never visibly repeat.
    sy, sx = (f * 37) % n.shape[0], (f * 91) % n.shape[1]
    n = np.roll(np.roll(n, sy, 0), sx, 1)
    n = np.repeat(np.repeat(n, 2, 0), 2, 1)[:h, :w]
    lum = a.mean(-1, keepdims=True) / 255.0
    # Grain shows most in the mids, least in pure black and highlights.
    k = amt * (0.35 + 1.3 * lum * (1 - lum) * 4) / 2
    return a + n[..., None] * k


_vig = {}


def vignette(a, amt=0.35):
    h, w = a.shape[:2]
    if (h, w) not in _vig:
        ys = np.linspace(-1, 1, h)[:, None]
        xs = np.linspace(-1, 1, w)[None, :]
        r = np.sqrt((xs * 0.9) ** 2 + (ys * 1.15) ** 2)
        _vig[(h, w)] = np.clip(r - 0.45, 0, 1) ** 1.6
    return a * (1 - amt * _vig[(h, w)])[..., None]


def shake(a, dx, dy, rot=0.0, zoom=1.0):
    if abs(dx) < 0.25 and abs(dy) < 0.25 and abs(rot) < 1e-4 and abs(zoom - 1) < 1e-4:
        return a
    h, w = a.shape[:2]
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    # Affine about the centre; scale up a touch so the frame edge never shows.
    z = zoom * (1 + (abs(dx) + abs(dy)) / w * 2.2 + abs(rot) * 0.6)
    c, s = np.cos(rot), np.sin(rot)
    cx, cy = w / 2, h / 2
    ia, ib = c / z, s / z
    id_, ie = -s / z, c / z
    ic = cx - ia * (cx + dx) - ib * (cy + dy)
    if_ = cy - id_ * (cx + dx) - ie * (cy + dy)
    out = im.transform((w, h), Image.AFFINE, (ia, ib, ic, id_, ie, if_), Image.BILINEAR)
    return np.asarray(out, np.float32)


def aberrate(a, px):
    if px < 0.4:
        return a
    h, w = a.shape[:2]
    out = a.copy()
    # Radial: scale R up and B down about the centre by `px` pixels at the frame edge.
    for ch, sgn in ((0, 1), (2, -1)):
        z = 1 + sgn * px / (w / 2)
        im = Image.fromarray(np.clip(a[..., ch], 0, 255).astype(np.uint8))
        cx, cy = w / 2, h / 2
        coef = (1 / z, 0, cx - cx / z, 0, 1 / z, cy - cy / z)
        out[..., ch] = np.asarray(im.transform((w, h), Image.AFFINE, coef, Image.BILINEAR), np.float32)
    return out


def nvg(a, f, gain=1.6):
    """Night vision: luminance through a green phosphor, blooming highlights, sensor noise,
    scanlines and a round eyepiece falloff."""
    h, w = a.shape[:2]
    lum = a.mean(-1) / 255.0
    lum = np.clip(np.power(lum, 0.7) * gain, 0, 1.4)
    im = Image.fromarray(np.clip(lum * 180, 0, 255).astype(np.uint8))
    glow = np.asarray(im.filter(ImageFilter.GaussianBlur(9)), np.float32) / 180.0
    lum = lum + glow * 0.45
    r = np.random.default_rng(f)
    lum = lum + r.standard_normal((h // 2, w // 2)).repeat(2, 0).repeat(2, 1)[:h, :w] * 0.06
    lum[::3, :] *= 0.86
    ys = np.linspace(-1, 1, h)[:, None]
    xs = np.linspace(-1, 1, w)[None, :] * (w / h) * 0.62
    lum *= np.clip(1.25 - np.sqrt(xs ** 2 + ys ** 2) * 0.62, 0, 1) ** 1.3
    lum = np.clip(lum, 0, 1.2)
    return np.stack([lum * 70, lum * 255, lum * 120], -1)


def glitch(a, f, amt=1.0):
    """Digital tear for a few frames: slices displaced sideways, RGB split, block noise."""
    if amt <= 0:
        return a
    h, w = a.shape[:2]
    r = np.random.default_rng(1000 + f)
    out = a.copy()
    k = int(4 + 10 * amt)
    for _ in range(k):
        y0 = int(r.integers(0, h - 8))
        hh = int(r.integers(4, max(6, int(h * 0.08 * amt))))
        sh = int(r.normal(0, 40 * amt))
        out[y0:y0 + hh] = np.roll(out[y0:y0 + hh], sh, axis=1)
    s = int(3 + 9 * amt)
    out[..., 0] = np.roll(out[..., 0], s, axis=1)
    out[..., 2] = np.roll(out[..., 2], -s, axis=1)
    for _ in range(int(6 * amt)):
        by, bx = int(r.integers(0, h - 24)), int(r.integers(0, w - 48))
        out[by:by + 16, bx:bx + 40] = r.integers(0, 255) * np.array([0.9, 1.0, 0.95])
    return out


def whip(a, b, k, axis=1):
    """Whip pan from frame a to frame b (k 0..1): both smear along `axis` and slide out/in."""
    h, w = a.shape[:2]
    n = w if axis == 1 else h
    ease = k * k * (3 - 2 * k)
    blur = int(6 + 60 * np.sin(np.pi * k))
    src = a if k < 0.5 else b
    off = int((ease if k < 0.5 else ease - 1) * n * 0.6)
    x = np.roll(src, -off, axis=axis)
    # Box smear along the axis.
    c = np.cumsum(x, axis=axis)
    pad = np.take(c, [0], axis=axis) * 0
    c = np.concatenate([pad, c], axis=axis)
    i1 = np.clip(np.arange(n) + blur // 2 + 1, 0, n)
    i0 = np.clip(np.arange(n) - blur // 2, 0, n)
    sm = (np.take(c, i1, axis=axis) - np.take(c, i0, axis=axis)) / np.maximum(1, (i1 - i0)).reshape((1, -1, 1) if axis == 1 else (-1, 1, 1))
    return sm


def thermal(a, f):
    """White-hot thermal sight: luminance (the capture pass made bodies hot), a soft blur,
    sensor noise and banding, a faint cool tint in the shadows."""
    lum = a.mean(-1) / 255.0
    im = Image.fromarray(np.clip(lum * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6))
    lum = np.asarray(im, np.float32) / 255.0
    # Lift the cold world into faint grey structure; bodies stay white-hot.
    lum = 0.07 + 0.93 * np.clip(lum * 1.7, 0, 1) ** 0.62
    r = np.random.default_rng(5000 + f)
    h, w = lum.shape
    lum = lum + r.standard_normal((h // 2, w // 2)).repeat(2, 0).repeat(2, 1)[:h, :w] * 0.035
    lum = lum + (np.sin(np.arange(h) * 0.9 + f * 0.7)[:, None] * 0.012)
    lum = np.clip(lum, 0, 1)
    return np.stack([lum * 235 + 6, lum * 238 + 8, lum * 230 + 14], -1)


def cctv(a, f):
    """Security camera: grey, contrasty, low-res, barrel vignette, rolling scan line."""
    h, w = a.shape[:2]
    lum = a.mean(-1)
    im = Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8)).resize((w // 2, h // 2), Image.BILINEAR).resize((w, h), Image.NEAREST)
    lum = np.asarray(im, np.float32)
    lum = np.clip((lum - 8) * 1.45, 0, 255)
    lum[::2, :] *= 0.9
    y = (f * 6) % h
    lum[max(0, y - 6):y + 6, :] *= 1.18
    r = np.random.default_rng(7000 + f)
    lum = lum + r.standard_normal((h, w)) * 5
    return np.stack([lum * 0.96, lum, lum * 0.98], -1)
