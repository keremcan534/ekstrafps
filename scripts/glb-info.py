# Print a GLB's asset credits (Sketchfab writes author / license / source) and size.
import json, struct, sys
for f in sys.argv[1:]:
    b = open(f, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    ex = (j.get('asset') or {}).get('extras') or {}
    tris = 0
    for m in j.get('meshes', []):
        for p in m['primitives']:
            a = j['accessors'][p['indices']] if 'indices' in p else j['accessors'][p['attributes']['POSITION']]
            tris += a['count'] // 3
    print(f"{f}: {tris} tris, {len(j.get('images', []))} images, skins {len(j.get('skins', []))}")
    for k in ('title', 'author', 'license', 'source'):
        print(f"  {k}: {ex.get(k)}")
