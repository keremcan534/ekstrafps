#!/usr/bin/env node
/**
 * MASTER_HUMANOID_RIG from the approved c12 source, end to end (Blender headless, no Meshy calls):
 *   node scripts/build-master.mjs [--from=cleanup|remesh|uv|bake|rig|lod|clips|views] [--faces=46000]
 *
 *   cleanup  scripts/blender/cleanup_master.py   c12 -> c12_clean.glb (only if every gate check passes)
 *   remesh   scripts/blender/remesh_master.py    -> master_remesh.glb (voxel + QuadriFlow, dense hands /
 *                                                    wrists / face / elbows / shoulders, ~60k polygons)
 *   uv       scripts/blender/uv_master.py        UVs (Smart UV Project on a smoothed twin) -> master_uv.glb
 *   bake     scripts/blender/bake_master.py      4K normal (from the high-res cleaned source) + AO on those UVs;
 *            scripts/blender/region_masks.py     + the hand / forearm mask scripts/make_look.py cleans skin with
 *            Looks (texture sets) are painted on these UVs once with `node scripts/meshy-master.mjs retexture`
 *            (credits): re-running uv invalidates them, so re-run the looks after it.
 *   rig      scripts/blender/build_canonical_rig.py  canonical skeleton + skin on the UV'd remesh, using the
 *                                                    Meshy auto-rig (rig/meshy/, made once with
 *                                                    `node scripts/meshy-master.mjs rig`) as the bootstrap
 *   lod      scripts/blender/lod_master.py       master_lod1/2/3.glb (~30k / 10k / 4.5k triangles, same skeleton)
 *   clips    scripts/blender/humanoid_clips.py   test clips (walk / run retargeted, idle, crouch, aim)
 *   views    scripts/glb-views.cjs              before / after renders + the comparison sheet
 *
 * Intermediate files: production/assets/src/chars/master/ (git-ignored). Published:
 *   public/assets/characters/master/master_humanoid_rigged.glb (+ master_lod1/2/3.glb), skeleton.json
 *   public/assets/characters/animations/humanoid/master_test_clips.glb
 *   production/assets/characters/master/master_humanoid_rigged.fbx (DCC interchange)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = 'production/assets/src/chars/master';
const args = process.argv.slice(2);
const from = (args.find((a) => a.startsWith('--from=')) ?? '--from=cleanup').slice(7);
const faces = (args.find((a) => a.startsWith('--faces=')) ?? '--faces=46000').slice(8);
const STAGES = ['cleanup', 'remesh', 'uv', 'bake', 'rig', 'lod', 'clips', 'views'];
const run = (stage) => STAGES.indexOf(stage) >= STAGES.indexOf(from);

const blender = (script, ...rest) =>
  execFileSync(process.execPath, [join(root, 'scripts/blender.mjs'), `scripts/blender/${script}`, ...rest], { cwd: root, stdio: 'inherit' });
const views = (glb, out, ...rest) =>
  execFileSync(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'scripts/glb-views.cjs'), glb, out, ...rest], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'ignore'],
  });

if (run('cleanup')) {
  blender('cleanup_master.py');
  if (!existsSync(join(root, M, 'c12_clean.glb'))) throw new Error('cleanup gate failed: see cleanup_report.json');
}
if (run('remesh')) blender('remesh_master.py', `${M}/c12_clean.glb`, `${M}/master_remesh.glb`, `--faces=${faces}`, '--refine=hands,face,elbows,shoulders');
if (run('uv')) blender('uv_master.py', `${M}/master_remesh.glb`, `${M}/master_uv.glb`);
if (run('bake')) {
  blender('bake_master.py', `${M}/c12_clean.glb`, `${M}/master_uv.glb`, `${M}/texture/baked`, '--size=4096');
  blender('region_masks.py', `${M}/master_uv.glb`, `${M}/texture/baked`);
}
if (run('rig'))
  blender('build_canonical_rig.py', `${M}/master_uv.glb`, `${M}/rig/meshy/master_meshy_rigged.glb`, `${M}/rig/final`, `--wrists=${M}/c12_landmarks.json`);
if (run('lod')) blender('lod_master.py', `${M}/rig/final/master_humanoid_rigged.blend`, `${M}/rig/final`);
if (run('clips')) blender('humanoid_clips.py', `${M}/rig/final/master_humanoid_rigged.blend`, `${M}/rig/meshy/walking.glb`, `${M}/rig/final/clips.glb`);
if (run('views')) {
  blender('landmarks.py', `${M}/c12_clean.glb`, `${M}/c12_clean_landmarks.json`);
  views(`${M}/candidates/c12.glb`, `${M}/views/before`, `--landmarks=${M}/c12_landmarks.json`);
  views(`${M}/c12_clean.glb`, `${M}/views/after`, `--landmarks=${M}/c12_clean_landmarks.json`);
  views(`${M}/master_remesh.glb`, `${M}/views/remesh`, `--landmarks=${M}/c12_clean_landmarks.json`);
  views(`${M}/rig/final/master_humanoid_rigged.glb`, `${M}/views/rig`, '--skeleton');
  execFileSync('python', [join(root, 'scripts/blender/compare_sheet.py'), join(root, M)], { stdio: 'inherit' });
}

// Publish.
const pub = join(root, 'public/assets/characters');
for (const d of ['master', 'animations/humanoid']) mkdirSync(join(pub, d), { recursive: true });
mkdirSync(join(root, 'production/assets/characters/master'), { recursive: true });
const final = join(root, M, 'rig/final');
if (existsSync(join(final, 'master_humanoid_rigged.glb'))) {
  copyFileSync(join(final, 'master_humanoid_rigged.glb'), join(pub, 'master/master_humanoid_rigged.glb'));
  for (const l of ['master_lod1.glb', 'master_lod2.glb', 'master_lod3.glb'])
    if (existsSync(join(final, l))) copyFileSync(join(final, l), join(pub, 'master', l));
  copyFileSync(join(final, 'skeleton.json'), join(pub, 'master/skeleton.json'));
  copyFileSync(join(final, 'master_humanoid_rigged.fbx'), join(root, 'production/assets/characters/master/master_humanoid_rigged.fbx'));
}
if (existsSync(join(final, 'clips.glb'))) copyFileSync(join(final, 'clips.glb'), join(pub, 'animations/humanoid/master_test_clips.glb'));
console.log('master built ->', pub);
