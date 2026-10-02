"""Contact sheet of a captured shot: python tools/sheet.py A03 [cols] [count] -> build/sheet_A03.jpg"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
shot = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4
count = int(sys.argv[3]) if len(sys.argv) > 3 else 12
files = sorted((ROOT / "frames" / shot).glob("*.jpg"))
pick = [files[round(i * (len(files) - 1) / max(1, count - 1))] for i in range(count)]
tw = 480
th = int(tw * 9 / 16)
rows = (len(pick) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tw, rows * th), (40, 40, 40))
font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 14)
for i, f in enumerate(pick):
    im = Image.open(f).convert("RGB").resize((tw, th))
    d = ImageDraw.Draw(im)
    d.text((6, 4), f"{shot} f{int(f.stem)}", font=font, fill=(255, 200, 0))
    sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
out = ROOT / "build" / f"sheet_{shot}.jpg"
sheet.save(out, quality=88)
print(out, len(files), "frames")
