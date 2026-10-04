// Headless capture of one take camera through the trailer-capture dev server (port 5180).
//   node tools/capture.mjs <ID> [cam] [--win=a-b,c-d] [--every=N] [--keep] [--q=flag+flag] [--res=720] [--fps=60]
// Done-detection: build/events/<ID>.json becomes newer than a stamp touched before the
// page opens (the director writes it after the last frame). Frame counts are not used.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')));
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
const q = `trailer=${id}&capture&res=${res}&fps=${fps}${cam ? `&cams=${cam}` : ''}${extra}&map=site9&mode=solo`;
// Lab-stage shots (macro, robot, insertion) skip the Site-9 redirect.
const map = /^(A0|XRIG$|RB$|IN$)/.test(id) ? q.replace('&map=site9&mode=solo', '') : q;
await page.goto(`http://localhost:${process.env.PORT ?? 5180}/?${map}`);
const start = Date.now();
let lastLog = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  if (fs.existsSync(ev) && fs.statSync(ev).mtimeMs > t0) break;
  if (Date.now() - lastLog > 60000) {
    lastLog = Date.now();
    const s = await page.evaluate(() => document.body.innerText.match(/(capturing|simulating) \d+\/\d+|unknown shot.*/)?.[0] ?? 'loading').catch(() => '?');
    console.log(id, cam, s, `${((Date.now() - start) / 1000).toFixed(0)}s`);
  }
}
console.log(`${id}-${cam || 'main'} done in ${((Date.now() - start) / 1000).toFixed(0)}s`);
await browser.close();
