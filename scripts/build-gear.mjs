#!/usr/bin/env node
/**
 * The master humanoid's looks and gear, rebuilt from their sources (no Meshy calls, no credits):
 *   node scripts/build-gear.mjs [--from=looks|fit|coat|straps|variants|lod] [--only=<stage>]
 *
 *   looks     scripts/make_look.py for every look a character wears (characters/*.json) + "master":
 *             the Meshy maps on the master's UVs -> game sizes, the no-skin rule, palettes,
 *             colour versions (needs texture/baked/: `node scripts/build-master.mjs --from=bake`)
 *   fit       scripts/blender/fit_gear.py: every item of scripts/blender/fit_gear.json onto the body
 *             (writes its JSON with the hides / variants / armor kept in fit_gear.json)
 *   coat      scripts/blender/build_coat.py finish: the Warden's greatcoat (its painted texture
 *             is COAT['texture'] in that script)
 *   straps    scripts/blender/build_straps.py: the PMC backpack's shoulder straps (after fit)
 *   variants  scripts/gear-variant.py for every folder in scripts/gear_variants.json
 *   lod       scripts/blender/lod_gear.py: every item's far / phone version
 *
 * Re-run from `looks` after the body's UVs change (build-master uv); from `fit` after the rig does.
 * Then check: soldier-lab.html (__slm.checks()) and scripts/character-preview.cjs.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const STAGES = ['looks', 'fit', 'coat', 'straps', 'variants', 'lod'];
const from = (args.find((a) => a.startsWith('--from=')) ?? '--from=looks').slice(7);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
for (const s of [from, only]) if (s && !STAGES.includes(s)) throw new Error(`unknown stage ${s} (${STAGES.join(', ')})`);
const run = (stage) => (only ? stage === only : STAGES.indexOf(stage) >= STAGES.indexOf(from));
const sh = (cmd, ...rest) => {
  console.log(`[build-gear] ${cmd} ${rest.join(' ')}`);
  execFileSync(cmd, rest, { cwd: root, stdio: 'inherit' });
};
const blender = (script, ...rest) => sh(process.execPath, join(root, 'scripts/blender.mjs'), `scripts/blender/${script}`, ...rest);
const GEAR = 'public/assets/characters/gear';

if (run('looks')) {
  const dir = join(root, 'public/assets/characters/characters');
  const looks = new Set(['master']);
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) looks.add(JSON.parse(readFileSync(join(dir, f), 'utf8')).look);
  sh('python', 'scripts/make_look.py', ...looks);
}
if (run('fit')) blender('fit_gear.py');
if (run('coat')) blender('build_coat.py', 'finish');
if (run('straps')) blender('build_straps.py');
if (run('variants')) {
  const table = JSON.parse(readFileSync(join(root, 'scripts/gear_variants.json'), 'utf8'));
  for (const [folder, how] of Object.entries(table)) {
    if (folder === 'notes') continue;
    const [kind, item] = folder.split('/');
    const glb = `${GEAR}/${kind}/${item}.glb`;
    const out = `${GEAR}/${folder}`;
    if (how.retexture) sh('python', 'scripts/gear-variant.py', `production/assets/src/chars/master/gear/${how.retexture}`, out);
    else if (how.recolour) sh('python', 'scripts/gear-variant.py', glb, out, `--recolour=${how.recolour.join(',')}`);
    else if (how.solid) sh('python', 'scripts/gear-variant.py', glb, out, `--solid=${how.solid.join(',')}`);
    else throw new Error(`${folder}: no recipe`);
  }
}
if (run('lod')) blender('lod_gear.py');
