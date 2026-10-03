"""Contact sheet of a multi-camera take: python tools/takesheet.py SV pov,mate,front,side,robo"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1]
take, cams = sys.argv[1], sys.argv[2].split(",")
fs0 = sorted((root / "frames" / f"{take}-{cams[0]}").glob("*.jpg"))
n = len(fs0)
picks = [i * (n - 1) // 9 for i in range(10)]
tw, th = 200, 112
sh = Image.new("RGB", (tw * len(picks), th * len(cams)))
for r, c in enumerate(cams):
    fs = sorted((root / "frames" / f"{take}-{c}").glob("*.jpg"))
    for k, i in enumerate(picks):
        if i >= len(fs):
            continue
        im = Image.open(fs[i]).resize((tw, th))
        ImageDraw.Draw(im).text((3, 2), f"{c} {i/30:.1f}", fill=(255, 200, 0))
        sh.paste(im, (k * tw, r * th))
sh.save(root / "build" / f"sheet_{take}.jpg", quality=85)
