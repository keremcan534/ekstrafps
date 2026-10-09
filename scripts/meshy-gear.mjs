#!/usr/bin/env node
/**
 * Faction GEAR for the master humanoid through the Meshy API (the controllable route that worked for
 * the body): a text-to-image product shot (gpt-image-2, plain background, positive wording only -
 * every object a prompt names, even after "no", tends to appear) -> image-to-3D of that image
 * (input_task_id, textured PBR 2K, remeshed to a gear-sized triangle budget).
 *
 *   node scripts/meshy-gear.mjs image <item...>        reference image(s), 9 credits each
 *   node scripts/meshy-gear.mjs model <item...>        image-to-3D of each item's newest reference, 30 credits each
 *   node scripts/meshy-gear.mjs retexture <item> <variant>   texture variant on the SAME UVs (enable_original_uv), 10 credits
 *   node scripts/meshy-gear.mjs retexture-file <name> <file.glb> "<prompt>"|--image=style.png
 *                                                       texture a local GLB keeping its UVs (the Blender-built coat), 10 credits
 *   node scripts/meshy-gear.mjs choose <item> <attempt>  mark the attempt the fit uses
 *   node scripts/meshy-gear.mjs status | balance
 *
 * State: production/assets/src/chars/master/gear/gear.json (git-ignored source art, like master.json):
 * every task id, prompt, setting and credit spent, with a running total. BUDGET caps this task's
 * spend; every paid call checks it first (and the live balance), and at most MAX_ATTEMPTS
 * image+model attempts are allowed per item.
 * Sources: production/assets/src/chars/master/gear/<item>/aN_ref.png, aN.glb, aN_<view>.png.
 * Fitting to the master body: scripts/blender/fit_gear.py (+ fit_gear.json); texture variants:
 * python scripts/gear-variant.py <variant.glb> public/assets/characters/gear/<kind>/<id>/<look>;
 * the Warden's coat: scripts/blender/build_coat.py. The faction looks (body textures) are made with
 * `node scripts/meshy-master.mjs retexture <look>` and their spend is recorded here too (looks{}).
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

const API = 'https://api.meshy.ai/openapi/v1';
const IMAGE = `${API}/text-to-image`;
const I23D = `${API}/image-to-3d`;
const RETEX = `${API}/retexture`;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const out = join(root, 'production/assets/src/chars/master/gear');
const statePath = join(out, 'gear.json');

const BUDGET = 700; // credits for the whole faction-asset task (gear, variants, coat, looks)
const MAX_ATTEMPTS = 2;
const COST = { image: 9, model: 30, retexture: 10 };

// Everything is shot the same way: one object, centred, plain background, even light, so
// image-to-3D sees clean silhouettes and the base colour carries no baked lighting.
const SHOT =
  ' Isolated product shot on a plain light grey studio background, soft even diffuse lighting, realistic materials, ' +
  'sharp detail, the whole object in frame and centred.';

/** kind = folder under public/assets/characters/gear; tris = remesh target (gear-sized). */
const ITEMS = {
  vanta_helmet: {
    kind: 'helmets', tris: 5000,
    prompt: 'Product photo of one modern mid-cut ballistic security helmet seen from a three-quarter front view. Smooth ' +
      'rounded shell covering the top, sides and back of the head, matte blue-grey paint with a fine texture, slim black ' +
      'accessory rails along both sides, a flat black mounting plate at the front centre, a small light blue triangle ' +
      'emblem on the front, a thin black rubber edge trim around the rim.',
  },
  vanta_vest: {
    kind: 'vests', tris: 10000,
    prompt: 'Product photo of one low-profile security vest displayed on an invisible ghost mannequin as if worn by a ' +
      'person, three-quarter front view. Slim soft armour vest: a front panel and a back panel joined by wide side ' +
      'straps and padded shoulder straps, matte blue-grey nylon, a row of three flat closed pouches across the lower ' +
      'front, a small radio pouch on the upper left chest, a blank rectangular patch panel on the upper right chest, ' +
      'neat stitching. The neck opening and the arm openings are clearly visible.',
  },
  bd_helmet: {
    kind: 'helmets', tris: 5000,
    prompt: 'Product photo of one black high-cut tactical ballistic helmet seen from a three-quarter front view. The shell ' +
      'is cut high above the ears, matte black textured finish, side accessory rails, a night vision shroud mounting ' +
      'plate at the front centre, hook-and-loop panels on the top and sides, a small counterweight pouch at the back, ' +
      'black interior padding visible at the rim.',
  },
  nvg: {
    kind: 'nvg', tris: 5000,
    prompt: 'Product photo of one set of quad-tube night vision goggles on a helmet mount, three-quarter front view. Four ' +
      'short cylindrical black objective tubes side by side in a compact black housing, the two outer tubes angled ' +
      'slightly outward, a black flip-up mount arm rising from the top of the housing to a small dovetail mounting ' +
      'shoe, matte black anodised metal, rubber eyecups at the back.',
  },
  bd_mask: {
    kind: 'masks', tris: 4000,
    prompt: 'Product photo of one black tactical half-face mask shown as if worn on an invisible head, three-quarter ' +
      'front view. A close-fitting moulded mask covering the nose, mouth, cheeks and chin and wrapping back toward the ' +
      'ears, matte black neoprene with hard black plastic panels, a fine mesh breathing panel in front of the mouth, ' +
      'subtle stitched seams.',
  },
  plate_carrier: {
    kind: 'vests', tris: 11000,
    prompt: 'Product photo of one modern plate carrier vest displayed on an invisible ghost mannequin as if worn by a ' +
      'person, three-quarter front view. Front and back armour plate panels joined by a wide cummerbund around the sides ' +
      'and padded shoulder straps, rows of MOLLE webbing, three rifle magazine pouches in a row across the lower front, ' +
      'a flat admin pouch above them, a grab handle at the top of the back panel, coyote brown nylon fabric with black ' +
      'buckles. The neck opening and the arm openings are clearly visible.',
    variants: {
      black_division: 'Matte black nylon plate carrier: black fabric, black webbing, black pouches, black plastic buckles, ' +
        'dark grey stitching, subtle wear on the edges, realistic military gear.',
    },
  },
  pmc_cap: {
    kind: 'hats', tris: 4000,
    prompt: 'Product photo of one tan baseball cap worn together with an olive green tactical communications headset, ' +
      'shown as if worn on an invisible head, three-quarter front view. Curved cap brim, a blank hook-and-loop patch on ' +
      'the front of the cap, the headset band going over the top of the cap, two large rounded over-ear cups at the ' +
      'sides, a small boom microphone on the right cup.',
  },
  pmc_backpack: {
    kind: 'backpacks', tris: 4000,
    prompt: 'Product photo of one compact military assault backpack of about 25 litres standing upright, three-quarter ' +
      'front view of its outer front panel. Coyote brown nylon, rows of MOLLE webbing on the front panel, two side ' +
      'compression straps, a top grab handle, rounded zip openings, black plastic buckles.',
  },
  pouches: {
    kind: 'pouches', tris: 5000,
    prompt: 'Product photo of one padded tactical battle belt displayed as a closed upright loop as if worn around an ' +
      'invisible waist, three-quarter front view. A wide padded belt sleeve with a metal cobra buckle at the front ' +
      'centre, two rifle magazine pouches and one pistol magazine pouch on the left side, a rolled dump pouch on the ' +
      'back right, a small medical pouch at the back, matte black nylon with dark grey webbing.',
  },
  radio: {
    kind: 'radios', tris: 3000,
    prompt: 'Product photo of one compact military handheld tactical radio in a black nylon carrying pouch, ' +
      'three-quarter front view. Rectangular radio body with a short black stubby antenna on top, a volume knob and a ' +
      'channel selector knob on top, the pouch with a top flap and side webbing straps, matte black and dark grey.',
  },
  warden_hat: {
    kind: 'hats', tris: 4000,
    prompt: "Product photo of one black military officer's peaked cap, three-quarter front view. A stiff high-front " +
      'crown of black wool, a black band around it, a glossy black leather visor at the front, a small plain round ' +
      'dark silver badge with a simple raised triangle on the front of the crown, a thin black leather chin cord above ' +
      'the visor.',
    // a1 showed a national eagle seal as the badge: a2 asks for the triangle (Vanta's mark) instead.
  },
  warden_mask: {
    kind: 'masks', tris: 5000,
    prompt: 'Product photo of one black rubber full-face gas mask shown as if worn on an invisible head, three-quarter ' +
      'front view. Two large round glass eyepieces in dark metal rims, a small round speech diaphragm in front of the ' +
      'mouth, two round filter canisters attached low on the left and right cheeks pointing down and outward, smooth ' +
      'matte black rubber body.',
  },
};

async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function poll(url, label) {
  let last = '';
  for (;;) {
    const t = await call('GET', url);
    const line = `${label}: ${t.status} ${t.progress ?? 0}%`;
    if (line !== last) console.log(line);
    last = line;
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${label} ${t.status}: ${JSON.stringify(t.task_error ?? t)}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return buf.length;
}

const balance = async () => (await call('GET', `${API}/balance`)).balance;

function loadState() {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8'));
  return { budget: BUDGET, spent: 0, spend: [], items: {}, variants: {}, files: {} };
}
/** Every change re-reads the file and writes it back synchronously, so several runs of this script
 * (and several tasks inside one run) never overwrite each other's records. Returns fn's result. */
function mutate(fn) {
  const s = loadState();
  const r = fn(s);
  mkdirSync(out, { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  return r;
}

/** Refuse a paid call that would break the budget (spent + calls in flight in this run). */
let reserved = 0;
async function guard(cost, what) {
  const { spent, budget } = loadState();
  if (spent + reserved + cost > budget) throw new Error(`${what}: ${cost} credits would exceed the budget (${spent}/${budget} spent, ${reserved} in flight)`);
  reserved += cost;
  const b = await balance();
  mutate((s) => (s.startBalance ??= b));
  if (b < cost) throw new Error(`${what}: balance ${b} < ${cost}`);
  return b;
}
function logSpend(item, step, task, credits, cost) {
  reserved -= cost;
  const total = mutate((s) => {
    s.spent += credits;
    s.spend.push({ at: new Date().toISOString(), item, step, task, credits, total: s.spent });
    return s.spent;
  });
  console.log(`  spent ${credits} on ${item} ${step} (task total ${total}/${BUDGET})`);
}

function spec(id) {
  if (!ITEMS[id]) throw new Error(`unknown item ${id} (${Object.keys(ITEMS).join(' ')})`);
  return ITEMS[id];
}
const item = (s, id) => (s.items[id] ??= { kind: spec(id).kind, tris: spec(id).tris, attempts: [] });
const attempt = (s, id, n) => item(s, id).attempts.find((a) => a.n === n);

async function image(id) {
  spec(id);
  const used = loadState().items[id]?.attempts.length ?? 0;
  if (used >= MAX_ATTEMPTS) throw new Error(`${id}: already ${used} attempts (max ${MAX_ATTEMPTS})`);
  const prompt = ITEMS[id].prompt + SHOT;
  await guard(COST.image, `${id} image`);
  const settings = { ai_model: 'gpt-image-2', aspect_ratio: '1:1' };
  const task = await call('POST', IMAGE, { ...settings, prompt });
  const n = mutate((s) => {
    const it = item(s, id);
    const k = it.attempts.length + 1;
    it.attempts.push({ n: k, image: { task: task.result, settings, prompt } });
    return k;
  });
  console.log(`${id} a${n}: image task ${task.result}`);
  const t = await poll(`${IMAGE}/${task.result}`, `${id} a${n} image`);
  logSpend(id, `a${n} image`, task.result, t.consumed_credits ?? COST.image, COST.image);
  const file = `${id}/a${n}_ref.png`;
  await download(t.image_urls[0], join(out, file));
  mutate((s) => Object.assign(attempt(s, id, n).image, { credits: t.consumed_credits, file }));
  console.log(`${id} a${n}: ${file}`);
}

async function model(id) {
  spec(id);
  const a = loadState().items[id]?.attempts.at(-1);
  if (!a?.image?.file) throw new Error(`${id}: no reference image yet`);
  if (a.model?.task) throw new Error(`${id} a${a.n}: already modelled (${a.model.task})`);
  const n = a.n;
  await guard(COST.model, `${id} model`);
  const settings = {
    ai_model: 'latest', should_texture: true, enable_pbr: true, texture_resolution: '2k', remove_lighting: true,
    should_remesh: true, topology: 'triangle', target_polycount: ITEMS[id].tris,
    target_formats: ['glb'], alpha_thumbnail: true, multi_view_thumbnails: true,
  };
  // A reference retouched by hand (aN_ref_edit.png: e.g. a brand name painted out) goes up as a
  // data URI; otherwise the text-to-image task feeds the 3D task directly.
  const edit = `${id}/a${n}_ref_edit.png`;
  const source = existsSync(join(out, edit))
    ? { image_url: `data:image/png;base64,${readFileSync(join(out, edit)).toString('base64')}` }
    : { input_task_id: a.image.task };
  const task = await call('POST', I23D, { ...source, ...settings });
  mutate((s) => (attempt(s, id, n).model = { task: task.result, settings, from: source.image_url ? edit : a.image.task }));
  console.log(`${id} a${n}: image-to-3d task ${task.result}`);
  const t = await poll(`${I23D}/${task.result}`, `${id} a${n} model`);
  logSpend(id, `a${n} model`, task.result, t.consumed_credits ?? COST.model, COST.model);
  const glb = `${id}/a${n}.glb`;
  const bytes = await download(t.model_urls.glb, join(out, glb));
  const thumbs = {};
  for (const [view, url] of Object.entries(t.thumbnail_urls ?? {})) {
    thumbs[view] = `${id}/a${n}_${view}.png`;
    await download(url, join(out, thumbs[view]));
  }
  mutate((s) => {
    Object.assign(attempt(s, id, n).model, { credits: t.consumed_credits, glb, bytes, thumbs });
    item(s, id).chosen ??= n;
  });
  console.log(`${id} a${n}: ${glb} ${(bytes / 1e6).toFixed(2)} MB`);
}

async function retexture(id, variant) {
  const prompt = spec(id).variants?.[variant];
  if (!prompt) throw new Error(`${id}: no variant ${variant}`);
  const st = loadState();
  const it = st.items[id];
  const a = it?.attempts.find((x) => x.n === it.chosen);
  if (!a?.model?.task) throw new Error(`${id}: no chosen model`);
  if (st.variants[id]?.[variant]?.glb) throw new Error(`${id}/${variant}: already made`);
  await guard(COST.retexture, `${id}/${variant} retexture`);
  const settings = { ai_model: 'meshy-6', enable_original_uv: true, enable_pbr: true, texture_resolution: '2k', remove_lighting: true, target_formats: ['glb'] };
  const task = await call('POST', RETEX, { input_task_id: a.model.task, text_style_prompt: prompt, ...settings });
  mutate((s) => ((s.variants[id] ??= {})[variant] = { from: a.model.task, task: task.result, settings, prompt }));
  const t = await poll(`${RETEX}/${task.result}`, `${id}/${variant} retexture`);
  logSpend(id, `variant ${variant}`, task.result, t.consumed_credits ?? COST.retexture, COST.retexture);
  const glb = `${id}/variant_${variant}.glb`;
  await download(t.model_urls.glb, join(out, glb));
  mutate((s) => Object.assign(s.variants[id][variant], { credits: t.consumed_credits, glb }));
  console.log(`${id}/${variant}: ${glb}`);
}

/** Texture a local, already UV-mapped GLB (the coat built in Blender) without touching its UVs. */
async function retextureFile(name, file, prompt) {
  await guard(COST.retexture, `${name} retexture`);
  const glb = readFileSync(file);
  const settings = { ai_model: 'meshy-6', enable_original_uv: true, enable_pbr: true, texture_resolution: '2k', remove_lighting: true, target_formats: ['glb'] };
  // A style given as an image (--image=path.png) instead of words.
  const style = prompt.startsWith('--image=')
    ? { image_style_url: `data:image/png;base64,${readFileSync(prompt.slice(8)).toString('base64')}` }
    : { text_style_prompt: prompt };
  const task = await call('POST', RETEX, { model_url: `data:application/octet-stream;base64,${glb.toString('base64')}`, ...style, ...settings });
  const n = mutate((s) => {
    const list = (s.files[name] ??= []);
    list.push({ n: list.length + 1, input: file, task: task.result, settings, prompt });
    return list.length;
  });
  const t = await poll(`${RETEX}/${task.result}`, `${name} retexture`);
  logSpend(name, `retexture r${n}`, task.result, t.consumed_credits ?? COST.retexture, COST.retexture);
  const rel = `${name}/r${n}_textured.glb`;
  await download(t.model_urls.glb, join(out, rel));
  mutate((s) => Object.assign(s.files[name].find((e) => e.n === n), { credits: t.consumed_credits, glb: rel }));
  console.log(`${name}: ${rel}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'image') await Promise.all(args.map((id) => image(id).catch((e) => console.error(`${id}: ${e.message}`))));
else if (cmd === 'model') await Promise.all(args.map((id) => model(id).catch((e) => console.error(`${id}: ${e.message}`))));
else if (cmd === 'retexture') await retexture(args[0], args[1]);
else if (cmd === 'retexture-file') await retextureFile(args[0], args[1], args[2]);
else if (cmd === 'choose') mutate((s) => (item(s, args[0]).chosen = Number(args[1])));
else if (cmd === 'balance') console.log(`balance ${await balance()}, task spend ${loadState().spent}/${BUDGET}`);
else if (cmd === 'status') {
  const state = loadState();
  for (const [id, it] of Object.entries(state.items)) {
    console.log(`${id} (${it.kind}, chosen a${it.chosen ?? '-'}): ` + it.attempts.map((a) => `a${a.n} image ${a.image.credits ?? '?'} / model ${a.model?.credits ?? '-'}`).join(', '));
  }
  console.log(`spent ${state.spent}/${state.budget}`);
} else {
  console.error('usage: node scripts/meshy-gear.mjs image|model <item...> | retexture <item> <variant> | retexture-file <name> <glb> "<prompt>" | choose <item> <n> | status | balance');
  process.exit(1);
}
