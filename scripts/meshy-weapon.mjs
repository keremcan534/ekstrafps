#!/usr/bin/env node
/**
 * Text prompt → textured weapon model, through the Meshy API:
 *   node scripts/meshy-weapon.mjs <model_key|all> [prompt]
 *
 * 1. Text to 3D preview (remeshed triangles), 2. refine with PBR textures,
 * 3. download to production/assets/src/guns/<key>.glb (+ <key>.json with the task ids),
 * 4. pack for the game (scripts/pack-weapon.mjs → public/guns/<key>.glb, m/<key>.glb).
 * The game fits the model onto the procedural rig itself (src/weapons/WeaponMeshes.ts),
 * so orientation and scale don't matter. Uses Meshy credits (about 30 a weapon).
 * Without a prompt the one below is used; `all` makes every weapon that has no source yet.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLE = 'realistic game-ready firearm, single object, no hands, no strap, plain neutral background';
/** Optics stay procedural (the reticle has to sit on the sight line): ask for bare rails. */
export const PROMPTS = {
  ak47: 'AK-47 assault rifle, worn stamped steel receiver, orange-brown wooden stock and handguard, curved steel 30-round magazine, iron sights, slant muzzle brake',
  mk47: 'CMMG MK47 Mutant rifle, AR-15 style upper and lower receiver in flat dark earth, AK steel magazine, M-LOK handguard, flat top picatinny rail without optic, large muzzle brake, collapsible stock',
  asval: 'AS VAL integrally suppressed rifle, thick long suppressor barrel, skeletal folding steel stock, black polymer pistol grip, short 20-round magazine, iron sights',
  m4a1: 'M4A1 carbine, black anodized aluminium, quad picatinny rail handguard, flat top upper receiver without optic, collapsible stock, 30-round STANAG magazine, front sight post',
  ppsh: 'WW2 Soviet PPSh-41 submachine gun, large round drum magazine under the receiver in front of the trigger guard, full wooden rifle stock, short barrel inside a perforated steel cooling jacket with round holes, blued steel, no optic',
  mosin: 'Mosin-Nagant M91/30 bolt action rifle, long orange shellac wooden stock, round receiver, straight bolt handle, hooded front sight, no bayonet',
  kar98: 'Mauser Kar98k bolt action rifle, dark walnut wooden stock, turned down bolt handle, blued steel barrel, hooded front sight',
  pistol: 'modern 9mm semi-automatic pistol, black polymer frame, gunmetal steel slide with serrations, three-dot sights',
  shotgun: 'pump action shotgun, wooden stock and wooden pump forend, gunmetal receiver, long barrel with tube magazine underneath, bead front sight',
  mp5: 'Heckler & Koch MP5 9mm submachine gun, slim black stamped steel receiver with a cocking tube above the barrel, narrow curved magazine, thin round black handguard, retractable metal stock, round diopter drum rear sight and hooded front post, no optic, no rail',
  glock: 'Glock 18C machine pistol, black polymer frame, ported slide, extended 33-round magazine',
  saiga: 'Saiga-12K shotgun, AK-pattern receiver, black polymer furniture, wide box magazine, folding stock',
  svd: 'SVD Dragunov sniper rifle, skeleton thumbhole wooden stock, slotted wooden handguard, long barrel with slotted flash hider, 10-round magazine, no scope',
  m249: 'M249 SAW light machine gun, box receiver with feed cover, carry handle, folded bipod, 100-round soft ammo pouch, black',
  scarh: 'FN SCAR-H battle rifle, flat dark earth monolithic upper receiver with full-length top rail without optic, folding stock, 20-round magazine, black barrel',
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

const [which, promptArg] = process.argv.slice(2);
if (!which) {
  console.error('usage: node scripts/meshy-weapon.mjs <model_key|all> [prompt]');
  process.exit(1);
}
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const out = join(root, 'production/assets/src/guns');
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

async function make(name, prompt) {
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
  const refine = await call('POST', API, {
    mode: 'refine',
    preview_task_id: preview.result,
    enable_pbr: true,
    texture_prompt: prompt,
    target_formats: ['glb'],
  });
  log.refineTask = refine.result;
  const r = await poll(refine.result, `${name} refine`);
  log.refineCredits = r.consumed_credits;
  log.thumbnail = r.thumbnail_url;
  const glb = Buffer.from(await (await fetch(r.model_urls.glb)).arrayBuffer());
  const src = join(out, `${name}.glb`);
  writeFileSync(src, glb);
  writeFileSync(join(out, `${name}.json`), JSON.stringify(log, null, 2));
  if (r.thumbnail_url) writeFileSync(join(out, `${name}.png`), Buffer.from(await (await fetch(r.thumbnail_url)).arrayBuffer()));
  console.log(`${src}: ${(glb.length / 1e6).toFixed(2)} MB (credits ${log.previewCredits ?? '?'} + ${log.refineCredits ?? '?'})`);
  execFileSync(process.execPath, [join(root, 'scripts/pack-weapon.mjs'), src, name], { stdio: 'inherit' });
}

const jobs = which === 'all'
  ? Object.keys(PROMPTS).filter((k) => !existsSync(join(out, `${k}.glb`)))
  : [which];
// A few at a time: Meshy queues the rest anyway.
const queue = [...jobs];
const failed = [];
await Promise.all(
  Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let k; (k = queue.shift()); ) {
      try {
        await make(k, which === 'all' ? PROMPTS[k] : (promptArg ?? PROMPTS[k]));
      } catch (e) {
        console.error(`${k} failed: ${e.message}`);
        failed.push(k);
      }
    }
  }),
);
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
