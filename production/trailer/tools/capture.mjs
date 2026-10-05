// Capture of one take camera through the trailer-capture dev server (port 5180).
//   node tools/capture.mjs <ID> [cam] [--win=a-b,c-d] [--every=N] [--keep] [--q=flag+flag] [--res=720] [--fps=60]
// Done-detection: build/events/<ID>.json becomes newer than a stamp touched before the
// page opens (the director writes it after the last frame). Frame counts are not used.
//
// Two ways to run it:
//   cloud (no GPU): headless Playwright Chromium on SwiftShader (software WebGL, ~3 s a frame)
//   local (GPU):    your installed Chrome / Edge, opened on the capture URL with the GPU on
//                   (milliseconds a frame); no extra packages. Picked automatically when the
//                   cloud browser isn't there, or with --local. CHROME=<path> picks the browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLOUD_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.split('=')[1] ?? '']));
const [id, cam = ''] = pos;
const res = opt.res ?? '720';
const fps = opt.fps ?? '60';
const extra = `${opt.win ? `&win=${opt.win}` : ''}${opt.every ? `&every=${opt.every}` : ''}${'keep' in opt ? '&keep' : ''}${opt.q ? `&${opt.q.split('+').join('&')}` : ''}`;
if (!id) throw new Error('usage: node tools/capture.mjs <ID> [cam] [res] [fps]');
const ev = path.join(ROOT, 'build', 'events', `${id}.json`);
const stamp = path.join(ROOT, 'build', 'events', `.stamp-${id}-${cam || 'main'}`);
fs.mkdirSync(path.dirname(ev), { recursive: true });
fs.writeFileSync(stamp, String(Date.now()));
const t0 = fs.statSync(stamp).mtimeMs;

const q = `trailer=${id}&capture&res=${res}&fps=${fps}${cam ? `&cams=${cam}` : ''}${extra}&map=site9&mode=solo`;
// Lab-stage shots (macro, robot, insertion) skip the Site-9 redirect.
const map = /^(A0|XRIG$|RB$|IN$)/.test(id) ? q.replace('&map=site9&mode=solo', '') : q;
const url = `http://localhost:${process.env.PORT ?? 5180}/?${map}`;
const local = 'local' in opt || (!process.env.CHROME && !fs.existsSync(CLOUD_CHROME));

/** Installed Chrome / Edge / Chromium (local GPU mode). */
function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  const pf = process.env.PROGRAMFILES ?? 'C:/Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
  const la = process.env.LOCALAPPDATA ?? '';
  const c = [
    `${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${la}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('no Chrome / Edge found: set CHROME=<path to the browser>');
  return hit;
}

let browser = null;
let page = null;
let proc = null;
if (local) {
  // One window per job (its own profile), GPU on, never throttled when it is not in front.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `trailer-${id}-${cam || 'main'}-`));
  proc = spawn(findBrowser(), [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', '--window-size=1320,820',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', url,
  ], { stdio: 'ignore' });
} else {
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? CLOUD_CHROME,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(url);
}
const start = Date.now();
let lastLog = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  if (fs.existsSync(ev) && fs.statSync(ev).mtimeMs > t0) break;
  if (Date.now() - lastLog > 60000) {
    lastLog = Date.now();
    const s = page ? await page.evaluate(() => document.body.innerText.match(/(capturing|simulating) \d+\/\d+|unknown shot.*/)?.[0] ?? 'loading').catch(() => '?') : 'running';
    console.log(id, cam, s, `${((Date.now() - start) / 1000).toFixed(0)}s`);
  }
}
console.log(`${id}-${cam || 'main'} done in ${((Date.now() - start) / 1000).toFixed(0)}s`);
if (browser) await browser.close();
if (proc) {
  proc.kill();
  if (process.platform === 'win32') try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
}
