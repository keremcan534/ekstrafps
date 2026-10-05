// Trailer v4 on your own machine, start to finish, with the GPU:
//
//   npm run trailer:v4 -- --music "C:/path/Abandoned_Complex.mp3"   (first time: decodes the music)
//   npm run trailer:v4                                                (music/abandoned.wav already there)
//
//   --jobs=N        cameras captured at once (default: by CPU count, 2..6; never two of one take)
//   --skip-capture  only render (frames already captured)
//   --dry           print the capture jobs and stop
//
// What it does: checks the Python packages, decodes the music to music/abandoned.wav (never
// committed), starts the trailer-capture dev server on 5180 (HMR off), computes the frame
// windows the v4 cut needs (python tools/flow4.py --windows), captures every camera window
// through your installed Chrome / Edge with the GPU (tools/capture.mjs --local), renders
// build/trailer_v4.mp4 (python tools/flow4.py) and a copy under 30 MB (build/trailer_v4_hq.mp4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const GAME = path.resolve(ROOT, '..', '..');
const WIN = process.platform === 'win32';
const PY = process.env.PYTHON ?? (WIN ? 'python' : 'python3');
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.slice(2).split('=').slice(1).join('=') || true]));
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) if (args[i] === '--music' && args[i + 1]) opt.music = args[i + 1];
const JOBS = Number(opt.jobs) || Math.max(2, Math.min(6, Math.floor(os.cpus().length / 3)));
const log = (...m) => console.log(`[${new Date().toLocaleTimeString()}]`, ...m);

function run(cmd, a, o = {}) {
  const r = spawnSync(cmd, a, { stdio: 'inherit', cwd: o.cwd ?? ROOT, shell: o.shell ?? false });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed (${r.status})`);
}

// 1) Python packages.
const chk = spawnSync(PY, ['-c', 'import numpy, scipy, soundfile, PIL, imageio_ffmpeg'], { cwd: ROOT });
if (chk.status !== 0) {
  log('installing Python packages (numpy scipy soundfile pillow imageio-ffmpeg)');
  run(PY, ['-m', 'pip', 'install', '--user', 'numpy', 'scipy', 'soundfile', 'pillow', 'imageio-ffmpeg']);
}

// 2) Music.
const wav = path.join(ROOT, 'music', 'abandoned.wav');
if (!fs.existsSync(wav)) {
  if (!opt.music || opt.music === true) throw new Error('music/abandoned.wav is missing: pass --music "<path to Abandoned_Complex.mp3>"');
  fs.mkdirSync(path.dirname(wav), { recursive: true });
  log('decoding the music ->', wav);
  run(PY, ['-c', 'import sys, subprocess, imageio_ffmpeg; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", sys.argv[1], "-ar", "48000", "-ac", "2", sys.argv[2]], check=True)', String(opt.music), wav]);
}

// 3) Dev server (trailer-capture: port 5180, HMR off).
async function up() {
  try {
    return (await fetch('http://localhost:5180/')).ok;
  } catch {
    return false;
  }
}
let vite = null;
if (!(await up())) {
  log('starting the dev server on 5180');
  vite = spawn('npx', ['vite', '--port', '5180', '--strictPort'], { cwd: GAME, shell: WIN, stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) throw new Error('the dev server did not come up on 5180');
}
const stop = () => {
  if (!vite) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite.kill();
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

try {
  if (!opt['skip-capture']) {
    // 4) The windows the cut needs.
    run(PY, ['tools/flow4.py', '--windows']);
    const lines = fs.readFileSync(path.join(ROOT, 'build', 'flow4_queue.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    // Macro shots are captured whole; the cut's lines carry their own windows.
    const jobs = ['A02', 'A03', 'A04', 'A05', ...lines.filter((l) => !/^A0\d\b/.test(l))].map((l) => l.split(/\s+/));
    // 5) Capture, JOBS at a time, never two cameras of one take together (they share its event log).
    log(`capturing ${jobs.length} camera windows, ${JOBS} at a time`);
    if (opt.dry) {
      for (const j of jobs) console.log('  node tools/capture.mjs', j.join(' '), '--local');
      process.exit(0);
    }
    const busy = new Set();
    let next = 0;
    let failed = 0;
    const t0 = Date.now();
    await new Promise((resolve) => {
      let running = 0;
      const pump = () => {
        while (running < JOBS) {
          const i = jobs.findIndex((j, k) => k >= next && j && !busy.has(j[0]));
          if (i < 0) break;
          const job = jobs[i];
          jobs[i] = null;
          while (next < jobs.length && jobs[next] === null) next++;
          busy.add(job[0]);
          running++;
          const p = spawn(process.execPath, [path.join(TOOLS, 'capture.mjs'), ...job, '--local'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (out += d));
          p.on('exit', (code) => {
            busy.delete(job[0]);
            running--;
            if (code !== 0) {
              failed++;
              log('FAILED', job.join(' '), '\n', out.slice(-800));
            } else log('done', job.slice(0, 2).join('-'), out.trim().split('\n').pop());
            if (running === 0 && jobs.every((j) => j === null)) resolve();
            else pump();
          });
        }
      };
      pump();
    });
    log(`capture finished in ${((Date.now() - t0) / 60000).toFixed(1)} min${failed ? `, ${failed} FAILED` : ''}`);
    if (failed) throw new Error('some captures failed (see above); rerun to retry');
  }
  stop();
  vite = null;
  // 6) Render, then a copy under 30 MB for sending.
  run(PY, ['tools/flow4.py']);
  run(PY, ['-c', [
    'import subprocess, os, imageio_ffmpeg',
    'e = imageio_ffmpeg.get_ffmpeg_exe()',
    'for p in (1, 2):',
    '    a = [e, "-y", "-loglevel", "error", "-i", "build/trailer_v4.mp4", "-c:v", "libx264", "-preset", "slow", "-b:v", "1600k", "-pass", str(p), "-passlogfile", "build/_x264v4", "-pix_fmt", "yuv420p"]',
    '    a += (["-an", "-f", "mp4", os.devnull] if p == 1 else ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "build/trailer_v4_hq.mp4"])',
    '    subprocess.run(a, check=True)',
  ].join('\n')]);
  log('wrote', path.join(ROOT, 'build', 'trailer_v4.mp4'), 'and trailer_v4_hq.mp4 (under 30 MB)');
} finally {
  stop();
}
