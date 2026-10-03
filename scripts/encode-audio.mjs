#!/usr/bin/env node
/**
 * Encodes an .mp3 next to every .wav in public/audio/guns and public/audio/voice
 * (the game fetches the .mp3; see compressedUrl() in src/audio/SoundBank.ts).
 * The .wav files stay: generators keep writing them and the trailer tools read them.
 * public/audio/amb (seamless loops: MP3 adds gaps) and public/audio/music are left alone.
 *
 *   node scripts/encode-audio.mjs          # only missing / out-of-date .mp3
 *   node scripts/encode-audio.mjs --force  # re-encode everything
 *
 * ffmpeg: $FFMPEG, else `ffmpeg` on PATH, else the binary from the python package
 * imageio-ffmpeg (pip install imageio-ffmpeg).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

/** Folder -> encoder settings per file. Mono everywhere except the helicopter (stereo field). */
const FOLDERS = {
  'public/audio/guns': (f) => (f.startsWith('heli_') ? { ch: 2, kbps: 128 } : { ch: 1, kbps: 96 }),
  'public/audio/voice': () => ({ ch: 1, kbps: 64 }),
};

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  for (const py of ['python', 'python3', 'py']) {
    try {
      const exe = execFileSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (exe && existsSync(exe)) return exe;
    } catch {
      // try the next interpreter
    }
  }
  throw new Error('ffmpeg not found: set FFMPEG, put ffmpeg on PATH, or pip install imageio-ffmpeg');
}

const ffmpeg = findFfmpeg();
let wavBytes = 0;
let mp3Bytes = 0;
let encoded = 0;
for (const [folder, settings] of Object.entries(FOLDERS)) {
  const dir = join(root, folder);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.wav')).sort()) {
    const wav = join(dir, f);
    const mp3 = wav.replace(/\.wav$/, '.mp3');
    if (force || !existsSync(mp3) || statSync(mp3).mtimeMs < statSync(wav).mtimeMs) {
      const { ch, kbps } = settings(f);
      // Sample rate is kept (48 kHz guns, 22.05 kHz voices). The LAME header ffmpeg writes
      // carries the encoder delay / padding, so decoders trim the silence MP3 adds.
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-map_metadata', '-1', '-ac', String(ch), '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, mp3], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`ffmpeg failed on ${folder}/${f}`);
      encoded++;
    }
    wavBytes += statSync(wav).size;
    mp3Bytes += statSync(mp3).size;
  }
}
const mb = (n) => (n / 1048576).toFixed(2);
console.log(`encoded ${encoded} file(s); guns+voice: ${mb(wavBytes)} MB wav -> ${mb(mp3Bytes)} MB mp3`);
