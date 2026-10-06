// Pack a rigged character GLB (Meshy / Tripo / Mixamo export) for the game:
//   node scripts/pack-character.mjs <source.glb> <name>
// writes public/chars/<name>.glb (desktop: ≤12k triangles, 1K WebP textures) and
// public/chars/m/<name>.glb (phones: ≤5k triangles, 512 WebP). Animations are dropped
// (the game poses the body itself); the skeleton and skin weights are kept.
// See src/targets/CharacterModels.ts for which faction wears which name.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const [src, name] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-character.mjs <source.glb> <name>');
  process.exit(1);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
for (const a of doc.getRoot().listAnimations()) a.dispose();
await doc.transform(prune());
let tris = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
}
const clean = join(tmpdir(), `site9-${name}-clean.glb`);
await io.write(clean, doc);
console.log(`${name}: ${Math.round(tris)} triangles in the source`);

const cli = (args) => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@gltf-transform/cli', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const [dir, target, size] of [
  ['public/chars', 12000, 1024],
  ['public/chars/m', 5000, 512],
]) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.glb`);
  const ratio = Math.min(1, target / Math.max(1, tris));
  cli([
    'optimize', clean, out,
    '--compress', 'quantize',
    '--texture-compress', 'webp',
    '--texture-size', String(size),
    ...(ratio < 1 ? ['--simplify', 'true', '--simplify-ratio', ratio.toFixed(4), '--simplify-error', '0.01'] : ['--simplify', 'false']),
  ]);
  console.log(`${out}: ${(statSync(out).size / 1e6).toFixed(2)} MB`);
}
rmSync(clean);
