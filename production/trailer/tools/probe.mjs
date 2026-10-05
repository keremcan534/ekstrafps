// Framing check without a full capture: simulate a take in preview mode and grab
// single frames of one camera at the given take times.
//   node tools/probe.mjs <ID> <cam> <t1,t2,...>   ->  build/probe/<ID>-<cam>-<t>.jpg
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
const [id, cam, times] = process.argv.slice(2);
const out = path.join(ROOT, 'build', 'probe');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://localhost:${process.env.PORT ?? 5180}/?trailer=${id}&res=720&fps=60&cam=${cam}&at=-9&map=site9&mode=solo${process.env.EXTRA ?? ''}`);
await page.waitForFunction(() => typeof (window).__trailerSeek === 'function', null, { timeout: 600000 });
for (const t of times.split(',').map(Number)) {
  // Seek (renders the frame) and read the canvas in the same task, before the buffer clears.
  const b64 = await page.evaluate((tt) => {
    (window).__trailerSeek(tt);
    return document.querySelector('canvas').toDataURL('image/jpeg', 0.85).split(',')[1];
  }, t);
  const f = path.join(out, `${id}-${cam}-${t.toFixed(2)}.jpg`);
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  console.log(f);
  const info = await page.evaluate(() => JSON.stringify((window).__probeInfo ?? null));
  if (info !== 'null') console.log('info', t, info);
}
await browser.close();
