// Pack a rigged character GLB (Meshy / Tripo / Mixamo export) for the game:
//   node scripts/pack-character.mjs <source.glb> <name> [tris]
// writes public/chars/<name>.glb (desktop: the model as made, textures up to 4K) and
// public/chars/m/<name>.glb (phones: same mesh and 2K colour, 1K normal / metal-rough
// maps). Animations are dropped (the game poses the body itself); the skeleton and skin
// weights are kept. See src/targets/CharacterModels.ts for which faction wears which name.
// `tris` caps the desktop mesh (phones get half): for crowd characters that come out
// far denser than the rest (a 125k-triangle robot in a horde of twenty).
// Meshy SmartRig skeletons (bones all named Bone_###) get named first (smartrig-names.mjs).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { pack } from './pack-common.mjs';
import { nameBones, needsNames } from './smartrig-names.mjs';

const [src, name, cap] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-character.mjs <source.glb> <name> [tris]');
  process.exit(1);
}
const tris = cap ? Number(cap) : Infinity;
let from = src;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
if (needsNames(doc)) {
  console.log(`named ${nameBones(doc)} SmartRig bones`);
  from = join(tmpdir(), `site9-named-${name}.glb`);
  await io.write(from, doc);
}
await pack(from, name, [
  { dir: 'public/chars', tris, color: 4096, maps: 4096 },
  { dir: 'public/chars/m', tris: tris / 2, color: 2048, maps: 1024 },
]);
