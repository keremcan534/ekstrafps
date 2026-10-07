// Shrink the textures inside packed GLBs, in place (the mesh is left alone):
//   node scripts/shrink-textures.mjs <colour px> <maps px> <file.glb>...
// The base colour map goes to at most <colour>, every other map (normal, metal/rough,
// occlusion, emission) to <maps>; never enlarges, re-encodes as WebP. For the phone tiers
// (public/chars/m, public/props/m): a character there is under ~200 px tall on screen, and
// a 2K colour + two 1K maps is ~33 MB of GPU memory per model once decoded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [colour, maps, ...files] = process.argv.slice(2);
if (!colour || !maps || !files.length) {
  console.error('usage: node scripts/shrink-textures.mjs <colour px> <maps px> <file.glb>...');
  process.exit(1);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const tmp = join(tmpdir(), 'site9-shrink');
mkdirSync(tmp, { recursive: true });

/** Shrink one texture to at most `size` px with Pillow (WebP, quality 90). Returns true if it changed. */
function shrink(tex, size) {
  const img = tex.getImage();
  if (!img) return false;
  const a = join(tmp, 'in.img');
  const b = join(tmp, 'out.webp');
  writeFileSync(a, img);
  const out = execFileSync('python', [
    '-c',
    `from PIL import Image\nim=Image.open(r"${a}")\nw,h=im.size\nif max(w,h)<=${size}: print("keep")\nelse:\n  im.thumbnail((${size},${size}),Image.LANCZOS)\n  im.save(r"${b}","WEBP",quality=90,method=6)\n  print(f"{w}x{h}->{im.size[0]}x{im.size[1]}")`,
  ]).toString().trim();
  if (out === 'keep') return false;
  tex.setImage(readFileSync(b));
  tex.setMimeType('image/webp');
  return out;
}

for (const file of files) {
  const before = statSync(file).size;
  const doc = await io.read(file);
  const colourMaps = new Set(doc.getRoot().listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean));
  const changes = [];
  for (const tex of doc.getRoot().listTextures()) {
    const r = shrink(tex, colourMaps.has(tex) ? Number(colour) : Number(maps));
    if (r) changes.push(r);
  }
  if (changes.length) await io.write(file, doc);
  console.log(`${file}: ${changes.join(', ') || 'already small'}  ${(before / 1e6).toFixed(2)} → ${(statSync(file).size / 1e6).toFixed(2)} MB`);
}
rmSync(tmp, { recursive: true, force: true });
