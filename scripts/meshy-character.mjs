#!/usr/bin/env node
/**
 * Reference image (or a text prompt) → rigged, game-ready character, through the Meshy API:
 *   node scripts/meshy-character.mjs <image.(png|jpg|webp)> <name> [height_m=1.8]
 *   node scripts/meshy-character.mjs "text:<prompt>" <name> [height_m=1.8]
 *
 * 1. Image (or text) to 3D: smart topology, 15k triangles, PBR textures, A-pose.
 * 2. Auto-rigging (humanoid, Mixamo-style skeleton).
 * 3. Download to production/assets/src/chars/<name>.glb (+ <name>.json with the task ids).
 * 4. Pack for the game (scripts/pack-character.mjs → public/chars/<name>.glb, m/<name>.glb).
 *
 * Best input: full body, front view, A-pose, empty hands, plain background.
 * Needs MESHY_API_KEY in .env (see .env.example). Uses Meshy credits (about 30 + 5 a character).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const l of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const key = process.env.MESHY_API_KEY || env.MESHY_API_KEY;
if (!key || key.startsWith('PUT_')) throw new Error('Set MESHY_API_KEY in .env (copy .env.example)');

const [image, name, heightArg] = process.argv.slice(2);
if (!image || !name) {
  console.error('usage: node scripts/meshy-character.mjs <image> <name> [height_m]');
  process.exit(1);
}
const height = Number(heightArg) || 1.8;
const API = 'https://api.meshy.ai/openapi/v1';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

/** Meshy takes png / jpg data URIs: convert anything else with Python (PIL). */
function dataUri(path) {
  let file = path;
  let ext = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    file = join(root, 'production/assets/src/chars', `${name}-input.png`);
    mkdirSync(dirname(file), { recursive: true });
    execFileSync('python', ['-c', `from PIL import Image; Image.open(r"${path}").convert("RGB").save(r"${file}")`]);
    ext = '.png';
  }
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function poll(url, label) {
  for (;;) {
    const t = await call('GET', url);
    process.stdout.write(`\r${label}: ${t.status} ${t.progress ?? 0}%   `);
    if (t.status === 'SUCCEEDED') {
      process.stdout.write('\n');
      return t;
    }
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`\n${label} ${t.status}: ${JSON.stringify(t.task_error ?? t)}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
}

const out = join(root, 'production/assets/src/chars');
mkdirSync(out, { recursive: true });
const log = { name, image, height };

// 1. Image (or text) to 3D.
const TEXT = 'https://api.meshy.ai/openapi/v2/text-to-3d';
let created;
let modelUrl;
if (image.startsWith('text:')) {
  const prompt = image.slice(5);
  log.image = undefined;
  log.prompt = prompt;
  const preview = await call('POST', TEXT, {
    mode: 'preview',
    prompt,
    ai_model: 'meshy-t2', // smart topology needs a T-series model
    model_type: 'smart-topology',
    topology: 'triangle',
    target_polycount: 15000,
    pose_mode: 'a-pose',
    target_formats: ['glb'],
  });
  log.previewTask = preview.result;
  console.log(`preview task ${preview.result}`);
  await poll(`${TEXT}/${preview.result}`, 'preview');
  created = await call('POST', TEXT, { mode: 'refine', preview_task_id: preview.result, enable_pbr: true, target_formats: ['glb'] });
  console.log(`refine task ${created.result}`);
  modelUrl = `${TEXT}/${created.result}`;
} else created = await call('POST', `${API}/image-to-3d`, {
  image_url: dataUri(image),
  ai_model: 'meshy-t2', // smart topology needs a T-series model
  model_type: 'smart-topology',
  topology: 'triangle',
  target_polycount: 15000,
  should_texture: true,
  enable_pbr: true,
  pose_mode: 'a-pose',
  target_formats: ['glb'],
});
log.modelTask = created.result;
console.log(`model task ${created.result}`);
const model = await poll(modelUrl ?? `${API}/image-to-3d/${created.result}`, 'model');
log.modelCredits = model.consumed_credits;

// 2. Rig.
const rig = await call('POST', `${API}/rigging`, { input_task_id: created.result, height_meters: height });
log.rigTask = rig.result;
console.log(`rig task ${rig.result}`);
const rigged = await poll(`${API}/rigging/${rig.result}`, 'rig');
log.rigCredits = rigged.consumed_credits;

// 3. Download.
const url = rigged.result?.rigged_character_glb_url ?? rigged.rigged_character_glb_url;
if (!url) throw new Error(`no rigged GLB in ${JSON.stringify(rigged)}`);
const glb = Buffer.from(await (await fetch(url)).arrayBuffer());
const src = join(out, `${name}.glb`);
writeFileSync(src, glb);
writeFileSync(join(out, `${name}.json`), JSON.stringify(log, null, 2));
console.log(`${src}: ${(glb.length / 1e6).toFixed(2)} MB (credits: model ${log.modelCredits ?? '?'}, rig ${log.rigCredits ?? '?'})`);

// 4. Pack for the game.
execFileSync(process.execPath, [join(root, 'scripts/pack-character.mjs'), src, name], { stdio: 'inherit' });
