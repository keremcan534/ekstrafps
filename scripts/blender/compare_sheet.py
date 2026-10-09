"""Before / after comparison sheets of the master cleanup (system Python + Pillow, not Blender).

  python scripts/blender/compare_sheet.py <production/assets/src/chars/master>

Reads views/before, views/after (and views/remesh if present), all rendered by scripts/glb-views.cjs,
and writes views/compare_body.jpg, compare_hands.jpg, compare_wrists.jpg: one column per view, rows
BEFORE / AFTER (/ REMESH), labelled.
"""
import os
import sys

from PIL import Image, ImageDraw

M = sys.argv[1]
ROWS = [('BEFORE (c12 source)', 'views/before'), ('AFTER cleanup', 'views/after'), ('REMESH ~60k', 'views/remesh')]
SHEETS = {
    'compare_body': ['body_front', 'body_back', 'body_left', 'body_right', 'body_q34_front', 'joint_head_side'],
    'compare_hands': ['hand_R_outside', 'hand_R_inside', 'hand_R_tip', 'hand_L_outside', 'hand_L_inside', 'hand_L_tip'],
    'compare_wrists': ['wrist_R_front', 'wrist_R_back', 'wrist_R_inside', 'wrist_L_front', 'wrist_L_back', 'wrist_L_inside'],
}
T = 420
for name, cols in SHEETS.items():
    rows = [(label, d) for label, d in ROWS if os.path.isdir(os.path.join(M, d))]
    img = Image.new('RGB', (T * len(cols), (T + 24) * len(rows)), (28, 28, 28))
    g = ImageDraw.Draw(img)
    for r, (label, d) in enumerate(rows):
        for c, view in enumerate(cols):
            p = os.path.join(M, d, view + '.png')
            if not os.path.exists(p):
                continue
            im = Image.open(p).convert('RGB').resize((T, T))
            img.paste(im, (c * T, r * (T + 24) + 24))
            g.text((c * T + 6, r * (T + 24) + 6), f'{label} - {view}', fill=(255, 220, 0))
    out = os.path.join(M, 'views', name + '.jpg')
    img.save(out, quality=88)
    print('wrote', out)
