// Pack a weapon GLB (Meshy export or any static model) for the game:
//   node scripts/pack-weapon.mjs <source.glb> <model_key>
// writes public/guns/<key>.glb (first person on desktop: the model as made, textures up to 4K)
// and public/guns/m/<key>.glb (phones' first person and every third-person gun: ≤25k
// triangles, 2K colour, 1K normal / metal-rough maps). Orientation and scale are left
// alone: src/weapons/WeaponMeshes.ts fits the model onto the procedural rig at load time.
import { pack } from './pack-common.mjs';

const [src, name] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-weapon.mjs <source.glb> <model_key>');
  process.exit(1);
}
await pack(src, name, [
  { dir: 'public/guns', tris: Infinity, color: 4096, maps: 4096 },
  { dir: 'public/guns/m', tris: 25000, color: 2048, maps: 1024 },
]);
