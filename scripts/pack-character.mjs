// Pack a rigged character GLB (Meshy / Tripo / Mixamo export) for the game:
//   node scripts/pack-character.mjs <source.glb> <name>
// writes public/chars/<name>.glb (desktop: the model as made, textures up to 4K) and
// public/chars/m/<name>.glb (phones: same mesh and 2K colour, 1K normal / metal-rough
// maps). Animations are dropped (the game poses the body itself); the skeleton and skin
// weights are kept. See src/targets/CharacterModels.ts for which faction wears which name.
import { pack } from './pack-common.mjs';

const [src, name] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-character.mjs <source.glb> <name>');
  process.exit(1);
}
await pack(src, name, [
  { dir: 'public/chars', tris: Infinity, color: 4096, maps: 4096 },
  { dir: 'public/chars/m', tris: Infinity, color: 2048, maps: 1024 },
]);
