#!/usr/bin/env node
/**
 * MASTER HUMAN pipeline through the Meshy API: one body, one skeleton, every humanoid derives from it.
 *   node scripts/meshy-master.mjs candidates [n=4] [prompt=v1]   Phase 1: n untextured text-to-3D previews to choose from
 *   node scripts/meshy-master.mjs refs [n=4] [model,model...]    A-pose multi-view reference images (text-to-image)
 *   node scripts/meshy-master.mjs fromrefs r1 r3:2,1,3 ...       candidates from chosen references (multi-image-to-3D,
 *                                                                 untextured; :order lists the views, front first)
 *   node scripts/meshy-master.mjs rig <textured.glb> [height_m]  Phase 4 bootstrap: Meshy auto-rig of the cleaned,
 *                                                                 remeshed master (scripts/blender/rig_input.py makes
 *                                                                 the textured input). Only a bootstrap: the canonical
 *                                                                 skeleton is built from it in Blender.
 *   node scripts/meshy-master.mjs status             what the state file holds
 *
 * Everything lands in production/assets/src/chars/master/ (git-ignored source art):
 *   master.json                 task ids, settings and credits of every step (the pipeline's state)
 *   candidates/cN.glb / cN.png  each preview's mesh and Meshy's thumbnail
 *   refs/rN_K.png               reference image K of text-to-image task rN
 *   rig/meshy/                  the auto-rig result: rigged GLB + FBX, walking / running clips
 *
 * Phase 1 settings come from the brief: ai_model latest, pose_mode a-pose, should_remesh false, glb.
 * Prompts: v1 is the brief's MASTER prompt word for word. Its meshy-7.1 previews all came back in a
 * "presenting" pose (arms forward, elbows bent, palms up), so v2 spells the A-pose out and drops the
 * phrases that read as a gesture ("hands clearly visible", "weapon-holding"). Its previews held their arms out
 * to the sides but grew the very gear it named ("no holster" → holsters): Meshy reads every named object as
 * wanted. The REF prompt therefore names only what should be there, and goes through text-to-image first,
 * so the pose (palms facing the thighs) can be checked on a 9-credit image before a 3D task is paid for.
 * Needs MESHY_API_KEY in .env (see .env.example).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const TEXT = 'https://api.meshy.ai/openapi/v2/text-to-3d';
const IMAGE = 'https://api.meshy.ai/openapi/v1/text-to-image';
const MULTI = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d';
const RIG = 'https://api.meshy.ai/openapi/v1/rigging';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const out = join(root, 'production/assets/src/chars/master');
const statePath = join(out, 'master.json');

const PROMPTS = {};
PROMPTS.v1 =
  'Realistic game-ready adult male tactical operator base character. Neutral athletic human proportions. ' +
  'Full body. Clean symmetrical anatomy. Neutral A-pose. Arms clearly separated from torso. Legs clearly separated. ' +
  'Hands anatomically correct and clearly visible. Five distinct fingers per hand. Straight wrists. Natural elbows. ' +
  'Clean shoulder joints. No weapon. No object in hands. No backpack. No cape. No coat. No loose fabric. ' +
  'No oversized armor. Black fitted tactical underlayer clothing, simple combat trousers, simple tactical boots, ' +
  'thin gloves. Designed specifically as a master humanoid character for skeletal animation and realistic rifle ' +
  'weapon-holding animations. Animation-friendly geometry.';
PROMPTS.v2 =
  'Realistic game-ready adult male tactical operator base character, full body, standing in a neutral A-pose. ' +
  'Arms straight, hanging down and out to the sides at 45 degrees, in line with the torso, not reaching forward, ' +
  'clearly separated from the torso. Palms facing the thighs, fingers straight and relaxed, five distinct fingers ' +
  'per hand. Straight wrists, natural elbows, clean shoulder joints. Legs straight, slightly apart. Neutral athletic ' +
  'proportions, clean symmetrical anatomy, bare head, no mask. Empty hands, no weapon, no holster, no pouches, ' +
  'no backpack, no armor, no vest, no coat, no loose fabric. Black fitted tactical underlayer shirt, simple combat ' +
  'trousers, simple tactical boots, thin gloves. Animation-friendly base mesh for skeletal rigging.';
// Reference images: positive wording only (see above).
const REF_PROMPT =
  'Full body character reference of a realistic adult male tactical operator base character standing in a relaxed ' +
  'A-pose. Athletic neutral proportions, symmetrical anatomy. Both arms straight, angled down and away from the ' +
  'torso at 45 degrees with a clear gap between arm and body, elbows straight, wrists straight. Hands open and ' +
  'relaxed with the palms facing the thighs and the thumbs pointing forward, fingers straight and slightly apart, ' +
  'five fingers on each hand. Legs straight, feet shoulder-width apart. Plain black long-sleeve fitted compression ' +
  'shirt, plain black slim combat trousers, black lace-up tactical boots, thin black gloves. Short dark hair, calm ' +
  'neutral face. Plain light grey background, even flat studio lighting, sharp detail.';

async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function poll(url, label) {
  for (;;) {
    const t = await call('GET', url);
    console.log(`${label}: ${t.status} ${t.progress ?? 0}%`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${label} ${t.status}: ${JSON.stringify(t.task_error ?? t)}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  return buf.length;
}

const loadState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { candidates: [] });
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));

/** Download a finished 3D task's mesh and thumbnail as candidate `entry.id`. */
async function finishCandidate(entry, t) {
  const dir = join(out, 'candidates');
  entry.credits = t.consumed_credits;
  entry.aiModel = t.ai_model;
  const glb = await download(t.model_urls.glb, join(dir, `${entry.id}.glb`));
  await download(t.alpha_thumbnail_url ?? t.thumbnail_url, join(dir, `${entry.id}.png`));
  entry.glb = `candidates/${entry.id}.glb`;
  entry.bytes = glb;
  console.log(`${entry.id}: ${(glb / 1e6).toFixed(2)} MB, ${t.consumed_credits} credits`);
}

async function candidates(n, variant) {
  const prompt = PROMPTS[variant];
  if (!prompt) throw new Error(`unknown prompt ${variant} (${Object.keys(PROMPTS)})`);
  if (prompt.length > 800) throw new Error(`prompt ${variant} is ${prompt.length} chars (Meshy max 800)`);
  const dir = join(out, 'candidates');
  mkdirSync(dir, { recursive: true });
  const state = loadState();
  const settings = {
    mode: 'preview',
    prompt,
    ai_model: 'latest',
    pose_mode: 'a-pose',
    should_remesh: false,
    target_formats: ['glb'],
    alpha_thumbnail: true,
  };
  state.prompts = PROMPTS;
  const first = state.candidates.length + 1;
  // Submit all first, then poll together: Meshy runs them in parallel.
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const id = `c${first + i}`;
    const task = await call('POST', TEXT, settings);
    console.log(`${id}: preview task ${task.result}`);
    const entry = { id, prompt: variant, settings: { ...settings, prompt: undefined }, previewTask: task.result };
    state.candidates.push(entry);
    jobs.push(entry);
  }
  saveState(state);
  await Promise.all(
    jobs.map(async (entry) => {
      await finishCandidate(entry, await poll(`${TEXT}/${entry.previewTask}`, entry.id));
      saveState(state);
    }),
  );
  saveState(state);
}

async function refs(n, models) {
  const dir = join(out, 'refs');
  mkdirSync(dir, { recursive: true });
  const state = loadState();
  state.refs ??= [];
  state.refPrompt = REF_PROMPT;
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const id = `r${state.refs.length + 1}`;
    const settings = { ai_model: models[i % models.length], prompt: REF_PROMPT, generate_multi_view: true, pose_mode: 'a-pose' };
    const task = await call('POST', IMAGE, settings);
    console.log(`${id}: ${settings.ai_model} image task ${task.result}`);
    const entry = { id, settings: { ...settings, prompt: undefined }, task: task.result };
    state.refs.push(entry);
    jobs.push(entry);
  }
  saveState(state);
  await Promise.all(
    jobs.map(async (entry) => {
      const t = await poll(`${IMAGE}/${entry.task}`, entry.id);
      entry.credits = t.consumed_credits;
      entry.images = [];
      for (const [k, url] of (t.image_urls ?? []).entries()) {
        const file = `refs/${entry.id}_${k + 1}.png`;
        await download(url, join(out, file));
        entry.images.push(file);
      }
      console.log(`${entry.id}: ${entry.images.length} images, ${t.consumed_credits} credits`);
      saveState(state);
    }),
  );
}

async function fromRefs(specs) {
  mkdirSync(join(out, 'candidates'), { recursive: true });
  const state = loadState();
  const jobs = [];
  for (const spec of specs) {
    const [refId, order] = spec.split(':');
    const ref = state.refs?.find((r) => r.id === refId);
    if (!ref?.images?.length) throw new Error(`no reference images for ${refId}`);
    const images = order ? order.split(',').map((k) => ref.images[Number(k) - 1]) : ref.images;
    const id = `c${state.candidates.length + 1}`;
    const settings = { ai_model: 'latest', pose_mode: 'a-pose', should_remesh: false, should_texture: false, target_formats: ['glb'] };
    const image_urls = images.map((f) => `data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}`);
    const task = await call('POST', MULTI, { ...settings, image_urls });
    console.log(`${id}: from ${refId} [${images.join(' ')}] task ${task.result}`);
    const entry = { id, prompt: 'ref', ref: refId, images, settings, task: task.result };
    state.candidates.push(entry);
    jobs.push(entry);
  }
  saveState(state);
  await Promise.all(
    jobs.map(async (entry) => {
      await finishCandidate(entry, await poll(`${MULTI}/${entry.task}`, entry.id));
      saveState(state);
    }),
  );
}

async function rig(file, height) {
  const dir = join(out, 'rig', 'meshy');
  mkdirSync(dir, { recursive: true });
  const state = loadState();
  const glb = readFileSync(file);
  const body = { model_url: `data:model/gltf-binary;base64,${glb.toString('base64')}`, height_meters: height };
  const task = await call('POST', RIG, body);
  console.log(`rig task ${task.result} (${(glb.length / 1e6).toFixed(1)} MB input)`);
  state.rig = { task: task.result, input: file, height };
  saveState(state);
  const t = await poll(`${RIG}/${task.result}`, 'rig');
  state.rig.credits = t.consumed_credits;
  const r = t.result ?? {};
  const files = {
    'master_meshy_rigged.glb': r.rigged_character_glb_url,
    'master_meshy_rigged.fbx': r.rigged_character_fbx_url,
    'walking.glb': r.basic_animations?.walking_glb_url,
    'walking_armature.glb': r.basic_animations?.walking_armature_glb_url,
    'running.glb': r.basic_animations?.running_glb_url,
    'running_armature.glb': r.basic_animations?.running_armature_glb_url,
  };
  state.rig.files = {};
  for (const [name, url] of Object.entries(files)) {
    if (!url) continue;
    const bytes = await download(url, join(dir, name));
    state.rig.files[name] = `rig/meshy/${name}`;
    console.log(`  ${name}: ${(bytes / 1e6).toFixed(2)} MB`);
  }
  saveState(state);
  console.log(`rig: ${t.consumed_credits} credits`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'candidates') await candidates(Number(arg) || 4, process.argv[4] ?? 'v1');
else if (cmd === 'refs') await refs(Number(arg) || 4, (process.argv[4] ?? 'gpt-image-2,nano-banana-pro').split(','));
else if (cmd === 'fromrefs') await fromRefs(process.argv.slice(3));
else if (cmd === 'rig') await rig(arg, Number(process.argv[4]) || 1.9);
else if (cmd === 'status') console.log(JSON.stringify(loadState(), null, 2));
else {
  console.error('usage: node scripts/meshy-master.mjs candidates [n=4] [prompt=v1|v2] | refs [n=4] [models] | fromrefs <rN[:order]>... | rig <textured.glb> [height_m] | status');
  process.exit(1);
}
