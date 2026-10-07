#!/usr/bin/env node
/**
 * Generates the main menu's Warden sounds with ElevenLabs sound effects: his respirator
 * breathing (a seamless loop) and the low sting under his return from the empty field.
 * Writes public/audio/menu/<id>.wav (44.1 kHz mono). Existing files are skipped; pass
 * ids to remake just those, or --force for all.
 *
 *   node scripts/gen-menu-sfx.mjs [--force] [id ...]
 *
 * Needs ELEVENLABS_API_KEY in .env (see scripts/gen-commander-voice.mjs).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 44100; // the sound-effects endpoint answers pcm_44100 whatever is asked

const SFX = [
  {
    id: 'warden_breath',
    seconds: 9,
    loop: true,
    text: 'Slow heavy breathing through a rubber gas mask respirator, filter valve clicking on each inhale, muffled, close microphone, calm and steady, no music',
  },
  {
    id: 'warden_return',
    seconds: 3,
    loop: false,
    text: 'Low deep sub-bass horror impact with a distant metallic creak and a short cold wind swell, dark, ominous, no music',
  },
];

const env = {};
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const l of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
if (!key || key === 'PUT_YOUR_API_KEY_HERE') throw new Error('Set ELEVENLABS_API_KEY in .env (copy .env.example)');

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));
const todo = ids.length ? SFX.filter((s) => ids.includes(s.id)) : SFX;

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

mkdirSync(join(root, 'public/audio/menu'), { recursive: true });
for (const s of todo) {
  const out = join(root, 'public/audio/menu', `${s.id}.wav`);
  if (existsSync(out) && !force && !ids.length) {
    console.log(`${s.id}  exists, skipped`);
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_${RATE}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: s.text, duration_seconds: s.seconds, prompt_influence: 0.5, loop: s.loop, model_id: 'eleven_text_to_sound_v2' }),
  });
  if (!res.ok) throw new Error(`${s.id}: HTTP ${res.status} ${await res.text()}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, wav(pcm));
  console.log(`${s.id}  ${(pcm.length / 2 / RATE).toFixed(2)}s`);
}
