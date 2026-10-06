// Shared GLB packing for characters and weapons (scripts/pack-character.mjs, pack-weapon.mjs).
// Each tier: triangle budget, base colour size, size of the other maps (normal, metal/rough,
// occlusion, emission). The colour map carries most of a Meshy model's detail, so it keeps
// the most pixels; the rest go smaller to save memory.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const cli = (args) =>
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@gltf-transform/cli', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });

/** Shrink a texture's image to at most `size` px (Python + Pillow; never enlarges). */
function shrinkImage(tex, size, tmp) {
  const img = tex.getImage();
  if (!img) return;
  const ext = (tex.getMimeType() || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  const a = join(tmp, `in.${ext}`);
  const b = join(tmp, `out.${ext}`);
  writeFileSync(a, img);
  execFileSync('python', ['-c', `from PIL import Image\nim=Image.open(r"${a}")\nim.thumbnail((${size},${size}),Image.LANCZOS)\nim.save(r"${b}",quality=95)`]);
  tex.setImage(readFileSync(b));
}

/**
 * Pack `src` into each tier's `dir/<name>.glb`.
 * @param tiers [{ dir, tris, color, maps }]
 */
export async function pack(src, name, tiers, { keepAnimations = false } = {}) {
  const tmp = join(tmpdir(), `site9-pack-${name}`);
  mkdirSync(tmp, { recursive: true });
  for (const { dir, tris: target, color, maps } of tiers) {
    const doc = await io.read(src);
    if (!keepAnimations) for (const a of doc.getRoot().listAnimations()) a.dispose();
    await doc.transform(prune());
    let tris = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const idx = p.getIndices();
        tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
      }
    }
    // Every map but the colour goes down to `maps` first; optimize then caps all at `color`.
    const colour = new Set(doc.getRoot().listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean));
    for (const tex of doc.getRoot().listTextures()) if (!colour.has(tex)) shrinkImage(tex, maps, tmp);
    const clean = join(tmp, 'clean.glb');
    await io.write(clean, doc);
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${name}.glb`);
    const ratio = Math.min(1, target / Math.max(1, tris));
    cli([
      'optimize', clean, out,
      '--compress', 'quantize',
      '--texture-compress', 'webp',
      '--texture-size', String(color),
      ...(ratio < 1 ? ['--simplify', 'true', '--simplify-ratio', ratio.toFixed(4), '--simplify-error', '0.002'] : ['--simplify', 'false']),
    ]);
    console.log(`${out}: ${Math.round(tris)} → ≤${target} triangles, ${color}px colour / ${maps}px maps, ${(statSync(out).size / 1e6).toFixed(2)} MB`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
