"""Contact rows for picking usable moments: one row per take camera, a thumbnail every
`step` seconds of take time, each tagged with its time and flagged when it is unusable:

  DARK   under 3% of the frame above luma 40 (nothing reads)
  BLOWN  a bright frame with a big hot area (mean > 55 and over 6% above 200, or over 12%
         above 235): a flashlight / rifle beam flooding the lens. A single blown sample
         between clean ones is a muzzle flash, not a flag ("flash").

python tools/rows.py FC-pov SB-warden ... [--step 0.5] [--out name]
  -> build/rows_<name>.jpg  and  build/rows/<take-cam>.json  (per-frame stats, every
     captured frame, so the edit can refuse a window that is dark or blown).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
args = [a for a in sys.argv[1:] if not a.startswith("--")]
opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
step = float(opts.get("step", 0.5))
name = opts.get("out", args[0] if len(args) == 1 else "multi")


def font(size):
    for f in [ROOT / "build" / "fonts" / "Barlow-Medium.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/consola.ttf"]:
        try:
            return ImageFont.truetype(str(f), size)
        except OSError:
            pass
    return ImageFont.load_default()


def stats(path):
    g = np.asarray(Image.open(path).convert("L").resize((160, 90)), np.float32)
    mean = float(g.mean())
    lit = float((g > 40).mean())
    h200 = float((g > 200).mean())
    h235 = float((g > 235).mean())
    flag = "DARK" if lit < 0.03 else "BLOWN" if (mean > 55 and h200 > 0.06) or h235 > 0.12 else ""
    return {"mean": round(mean, 1), "lit": round(lit, 3), "h200": round(h200, 3), "h235": round(h235, 3), "flag": flag}


def analyse(src):
    d = ROOT / "frames" / src
    take = src.split("-")[0]
    meta = json.loads((ROOT / "build" / "events" / f"{take}.json").read_text())
    fps, hd = meta["fps"], meta["handles"]
    out = {}
    for f in sorted(d.glob("*.jpg")):
        out[int(f.stem)] = {"t": round(int(f.stem) / fps - hd, 3), **stats(f)}
    ks = sorted(out)
    for i, k in enumerate(ks):
        nb = [out[ks[j]]["flag"] for j in (i - 1, i + 1) if 0 <= j < len(ks)]
        if out[k]["flag"] == "BLOWN" and "BLOWN" not in nb:
            out[k]["flag"] = ""
            out[k]["note"] = "flash"
    (ROOT / "build" / "rows").mkdir(parents=True, exist_ok=True)
    (ROOT / "build" / "rows" / f"{src}.json").write_text(json.dumps(out))
    return out, fps, hd


TW, TH = 192, 108
rows = []
for src in args:
    st, fps, hd = analyse(src)
    keys = sorted(st)
    if not keys:
        continue
    t_end = keys[-1] / fps - hd
    cells = []
    t = round(keys[0] / fps - hd, 3)
    while t <= t_end + 1e-6:
        k = min(keys, key=lambda q: abs(q - (t + hd) * fps))
        cells.append((t, k))
        t += step
    rows.append((src, cells, st))

cols = max(len(c) for _, c, _ in rows)
LW = 120
sheet = Image.new("RGB", (LW + cols * TW, len(rows) * (TH + 4)), (24, 24, 26))
d = ImageDraw.Draw(sheet)
f1, f2 = font(15), font(12)
for r, (src, cells, st) in enumerate(rows):
    y = r * (TH + 4)
    d.text((8, y + TH // 2 - 9), src, font=f1, fill=(255, 200, 0))
    for c, (t, k) in enumerate(cells):
        im = Image.open(ROOT / "frames" / src / f"{k:05d}.jpg").convert("RGB").resize((TW, TH))
        di = ImageDraw.Draw(im)
        s = st[k]
        di.text((4, 2), f"{t:.2f}", font=f2, fill=(255, 220, 80))
        if s["flag"]:
            di.rectangle([0, 0, TW - 1, TH - 1], outline=(255, 40, 40), width=3)
            di.text((4, TH - 16), s["flag"], font=f2, fill=(255, 60, 60))
        sheet.paste(im, (LW + c * TW, y))
out = ROOT / "build" / f"rows_{name}.jpg"
sheet.save(out, quality=86)
print(out)
for src, cells, st in rows:
    bad = [st[k]["t"] for k in sorted(st) if st[k]["flag"]]
    print(f"{src}: {len(st)} frames, flagged {len(bad)}" + (f" ({bad[0]:.2f}..{bad[-1]:.2f})" if bad else ""))
