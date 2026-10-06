// Pack a weapon GLB for the game:
//   node scripts/pack-weapon.mjs <source.glb> <model_key>        third person (Meshy...)
//   node scripts/pack-weapon.mjs <source.glb> <model_key> --fp   the gun in your hands
// Third person: public/guns/m/<key>.glb (≤25k triangles, 2K colour, 1K maps), worn by
// every soldier and hung on the wall buys. First person: public/guns/fp/<key>.glb, the
// model as made (a hand-made model: AI meshes melt up close); credit its author in
// public/guns/fp/CREDITS.txt. Orientation and scale are left alone:
// src/weapons/WeaponMeshes.ts fits the model onto the procedural rig at load time.
import { pack } from './pack-common.mjs';

const [src, name, flag] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-weapon.mjs <source.glb> <model_key> [--fp]');
  process.exit(1);
}
await pack(src, name, [
  flag === '--fp'
    ? { dir: 'public/guns/fp', tris: Infinity, color: 4096, maps: 4096 }
    : { dir: 'public/guns/m', tris: 25000, color: 2048, maps: 1024 },
]);
