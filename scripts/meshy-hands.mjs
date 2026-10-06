#!/usr/bin/env node
/**
 * First-person glove, through the Meshy API (text → textured model):
 *   node scripts/meshy-hands.mjs glove
 *
 * One gloved hand with its cuff, fingers half curled (it holds a grip or a handguard); the
 * game mirrors it for the other hand (src/config/hands.json). 1. Text to 3D preview, 2. refine
 * with PBR textures, 3. download to production/assets/src/hands/<name>.glb (+ <name>.json with
 * the task ids), 4. pack at full quality: public/hands/<name>.glb. Every weapon's view profile
 * carries the hand IK points it sits on (src/weapons/FirstPersonHands.ts). Meshy chooses the
 * hand: the one in the game came out a left hand; hands.json sets which is mirrored.
 * Uses Meshy credits (about 30). Needs MESHY_API_KEY in .env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from './pack-common.mjs';

const STYLE = 'realistic game-ready first person shooter viewmodel arm, single object, only the arm and hand, no weapon, no body, plain neutral background';
export const PROMPTS = {
  glove:
    "a soldier's forearm and hand in a black and dark olive tactical shooting glove with knuckle padding, the hand closed in a firm grip as if holding a rifle pistol grip, index finger straight along the side, the forearm in a dark grey combat shirt sleeve",
};

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

const which = process.argv[2];
if (!which) {
  console.error('usage: node scripts/meshy-hands.mjs <glove|all>');
  process.exit(1);
}
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const out = join(root, 'production/assets/src/hands');
mkdirSync(out, { recursive: true });

async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function poll(id, label) {
  for (;;) {
    const t = await call('GET', `${API}/${id}`);
    console.log(`${label}: ${t.status} ${t.progress ?? 0}%`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${label} ${t.status}: ${JSON.stringify(t.task_error ?? t)}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}

async function make(name) {
  const prompt = PROMPTS[name];
  const log = { name, prompt };
  const preview = await call('POST', API, {
    mode: 'preview',
    prompt: `${prompt}, ${STYLE}`,
    ai_model: 'latest',
    topology: 'triangle',
    should_remesh: true,
    target_polycount: 30000,
    target_formats: ['glb'],
  });
  log.previewTask = preview.result;
  const p = await poll(preview.result, `${name} preview`);
  log.previewCredits = p.consumed_credits;
  const refine = await call('POST', API, { mode: 'refine', preview_task_id: preview.result, enable_pbr: true, texture_prompt: prompt, target_formats: ['glb'] });
  log.refineTask = refine.result;
  const r = await poll(refine.result, `${name} refine`);
  log.refineCredits = r.consumed_credits;
  const glb = Buffer.from(await (await fetch(r.model_urls.glb)).arrayBuffer());
  const src = join(out, `${name}.glb`);
  writeFileSync(src, glb);
  writeFileSync(join(out, `${name}.json`), JSON.stringify(log, null, 2));
  if (r.thumbnail_url) writeFileSync(join(out, `${name}.png`), Buffer.from(await (await fetch(r.thumbnail_url)).arrayBuffer()));
  console.log(`${src}: ${(glb.length / 1e6).toFixed(2)} MB (credits ${log.previewCredits ?? '?'} + ${log.refineCredits ?? '?'})`);
  // Right in front of the eye: full geometry, the colour map kept large.
  await pack(src, name, [{ dir: join(root, 'public/hands'), tris: Infinity, color: 2048, maps: 1024 }]);
}

const jobs = which === 'all' ? Object.keys(PROMPTS) : [which];
const results = await Promise.allSettled(jobs.map((n) => make(n)));
const failed = jobs.filter((_, i) => results[i].status === 'rejected');
for (const [i, r] of results.entries()) if (r.status === 'rejected') console.error(`${jobs[i]} failed: ${r.reason?.message ?? r.reason}`);
if (failed.length) process.exit(1);
