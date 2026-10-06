// Keep only some meshes of a GLB (a Sketchfab scene with the gun on a stand, spare
// magazines and rounds around it):
//   node scripts/glb-keep.mjs <source.glb> <out.glb> <node-name regex>
// Nodes whose mesh doesn't match are dropped (and whatever only they used).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const [src, out, pattern] = process.argv.slice(2);
if (!src || !out || !pattern) {
  console.error('usage: node scripts/glb-keep.mjs <source.glb> <out.glb> <node-name regex>');
  process.exit(1);
}
const keep = new RegExp(pattern);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
let kept = 0;
for (const n of doc.getRoot().listNodes()) {
  if (!n.getMesh()) continue;
  if (keep.test(n.getName())) kept++;
  else n.setMesh(null);
}
await doc.transform(prune());
await io.write(out, doc);
console.log(`${out}: kept ${kept} mesh node(s)`);
