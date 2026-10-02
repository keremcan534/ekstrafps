// Desktop build perf check over CDP: Site-9, PLAY, sample fps / draw calls, screenshot.
import fs from 'node:fs';

const port = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((p) => p.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pend = {};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d.result); delete pend[d.id]; } };
await new Promise((r) => (ws.onopen = r));
const ev = async (e) => {
  const res = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return res.exceptionDetails ? 'EXC ' + (res.exceptionDetails.exception?.description ?? '') : res.result.value;
};
await ev(`location.href = 'app://game/index.html?map=site9&mouse'; 1`);
await sleep(15000);
await ev(`window.__errs = []; window.addEventListener('error', (e) => __errs.push(String(e.message))); document.querySelector('.menu .gbtn.primary').click(); 1`);
await sleep(6000);
for (let i = 0; i < 3; i++) {
  console.log(await ev(`JSON.stringify({ fps: Math.round(window.__lab.fps), ms: window.__lab.frameMs.toFixed(1), calls: window.__lab.renderer.info.render.calls, tris: window.__lab.renderer.info.render.triangles, pr: window.__lab.renderer.getPixelRatio(), errs: __errs })`));
  await sleep(2000);
}
const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
fs.writeFileSync('C:/Users/Kerem/Documents/ekstrafps/trailer/build/perf_site9.jpg', Buffer.from(r.data, 'base64'));
process.exit(0);
