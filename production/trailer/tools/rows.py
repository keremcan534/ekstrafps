"""Rows contact sheet: python tools/rows.py OUT cam1 cam2 ... -> build/sheet_OUT.jpg (8 samples per cam, labelled in take seconds)."""
import sys
out_name, cams = sys.argv[1], sys.argv[2:]
sys.argv = [sys.argv[0], "1280", "720"]
import assemble as A  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

tw, th, n = 320, 180, 8
sheet = Image.new("RGB", (tw * n, th * len(cams)))
for r, cam in enumerate(cams):
    src = A.Source.get(cam)
    dur = src.meta.get("duration", 10)
    for i in range(n):
        t = 0.3 + i * (dur - 0.6) / (n - 1)
        im = src.frame(t).resize((tw, th))
        ImageDraw.Draw(im).text((4, 3), f"{cam} {t:.1f}", font=A.font(14), fill=(255, 200, 0))
        sheet.paste(im, (i * tw, r * th))
sheet.save(A.ROOT / "build" / f"sheet_{out_name}.jpg", quality=85)
