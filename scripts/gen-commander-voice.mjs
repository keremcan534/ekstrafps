#!/usr/bin/env node
/**
 * Generates the Black Division Commander voice lines with ElevenLabs.
 * One line of scripts/voice/commander_lines.txt (FILE_ID|TEXT) = one request = one
 * public/audio/voice/<FILE_ID>.wav (22.05 kHz mono, like the other voices). Tags such as
 * [sniffs] are sent untouched (eleven_v3 performs them). Nothing is trimmed.
 * Existing .wav files are skipped. Run scripts/encode-audio.mjs afterwards for the .mp3s.
 *
 *   node scripts/gen-commander-voice.mjs              # the 3 pilot lines only
 *   node scripts/gen-commander-voice.mjs --all        # every line
 *   node scripts/gen-commander-voice.mjs id1 id2 ...  # just these
 *
 * Needs .env (copy .env.example) with ELEVENLABS_API_KEY and COMMANDER_VOICE_ID.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PILOT = ['commander_firstcontact_01', 'commander_command_03', 'commander_lowhp_01'];
const RATE = 22050;

const env = {};
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const l of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
const voice = process.env.COMMANDER_VOICE_ID || env.COMMANDER_VOICE_ID;
if (!key || key === 'PUT_YOUR_API_KEY_HERE') throw new Error('Set ELEVENLABS_API_KEY in .env (copy .env.example)');
if (!voice) throw new Error('Set COMMANDER_VOICE_ID in .env');

const lines = [];
for (const raw of readFileSync(join(root, 'scripts/voice/commander_lines.txt'), 'utf8').split(/\r?\n/)) {
  if (!raw.trim()) continue;
  const i = raw.indexOf('|');
  if (i < 0) throw new Error(`No | in line: ${raw}`);
  lines.push({ id: raw.slice(0, i).trim(), text: raw.slice(i + 1) });
}

const args = process.argv.slice(2);
const wanted = args.includes('--all') ? null : new Set(args.length ? args : PILOT);
const todo = wanted ? lines.filter((l) => wanted.has(l.id)) : lines;
if (wanted && todo.length !== wanted.size) {
  const known = new Set(lines.map((l) => l.id));
  throw new Error(`Unknown id(s): ${[...wanted].filter((id) => !known.has(id)).join(', ')}`);
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let made = 0;
let skipped = 0;
for (const { id, text } of todo) {
  const out = join(root, 'public/audio/voice', `${id}.wav`);
  if (existsSync(out)) { skipped++; continue; }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_${RATE}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
    body: JSON.stringify({ text, model_id: 'eleven_v3' }),
  });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status} ${await res.text()}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, wav(pcm));
  made++;
  console.log(`${id}  ${(pcm.length / 2 / RATE).toFixed(2)}s`);
}
console.log(`generated ${made}, skipped ${skipped} existing`);
