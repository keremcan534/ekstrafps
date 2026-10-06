// Pack a static prop GLB (Meshy export, Poly Haven...) for the maps:
//   node scripts/pack-prop.mjs <source.glb> <file_name>
// writes public/props/<name>.glb (desktop: as made, base on the floor, centred) and
// public/props/m/<name>.glb (phones: ≤40k triangles, 2K colour, 1K maps). Add it to
// PROPS in src/world/Props.ts with its size.
import { pack } from './pack-common.mjs';

const [src, name] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/pack-prop.mjs <source.glb> <file_name>');
  process.exit(1);
}
await pack(
  src,
  name,
  [
    { dir: 'public/props', tris: Infinity, color: 4096, maps: 4096 },
    { dir: 'public/props/m', tris: 40000, color: 2048, maps: 1024 },
  ],
  { pivot: 'below' },
);
