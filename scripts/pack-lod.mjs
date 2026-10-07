// Far-away versions of the character models: public/chars/lod/<name>.glb, simplified to
// ~4.5k triangles (same skeleton and weights, so the body swaps geometry only; the
// near model's materials stay, the LOD file's own tiny textures are never used).
//   node scripts/pack-lod.mjs [name ...]   (default: every public/chars/<name>.glb)
import { readdirSync } from 'node:fs';
import { pack } from './pack-common.mjs';

const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('public/chars').filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));
for (const name of names) await pack(`public/chars/${name}.glb`, name, [{ dir: 'public/chars/lod', tris: 4500, color: 128, maps: 64, error: 0.01 }]);
