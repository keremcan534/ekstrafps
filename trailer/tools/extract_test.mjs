// Drives the desktop build over CDP: Site-9, PLAY, force extraction, walk into the
// helicopter zone, and screenshot every stage. node extract_test.mjs <port>
import fs from 'node:fs';

const port = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = 'C:/Users/Kerem/Documents/ekstrafps/trailer/build';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((p) => p.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pend = {};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d.result); delete pend[d.id]; } };
await new Promise((r) => (ws.onopen = r));
const ev = async (e) => {
  const res = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return res.exceptionDetails ? 'EXC ' + (res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)) : res.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  fs.writeFileSync(`${out}/ex_${name}.jpg`, Buffer.from(r.data, 'base64'));
};

await ev(`location.href = 'app://game/index.html?map=site9&mouse'; 1`);
await sleep(15000);
await ev(`window.__errs = []; window.addEventListener('error', (e) => __errs.push(String(e.message))); 1`);
await ev(`document.querySelector('.menu .gbtn.primary').click(); 1`);
await sleep(1500);
console.log('force', await ev(`window.__lab.match.forceExtraction(); 'ok'`));
await sleep(6000);
await shot('approach');
await sleep(9000);
console.log('landed?', await ev(`(() => { const h = window.__lab.match.sites[0]; return JSON.stringify({ ready: h.ready, y: h.group.position.y.toFixed(2), errs: __errs }); })()`));
await shot('landed');
console.log(await ev(`(() => { const g = window.__lab; const h = g.match.sites[0]; const back = h.pos.clone().sub(h.lz).setY(0).normalize(); g.player.teleport(h.pos.clone().addScaledVector(back, 1).setY(0.2), Math.atan2(back.x, back.z)); return 'tp'; })()`));
await sleep(2500);
await shot('countdown');
console.log('count', await ev(`document.querySelector('.ex-count').className + ' ' + document.querySelector('.ex-digits').textContent`));
await sleep(3500);
await shot('cine1');
await sleep(3000);
await shot('cine2');
await sleep(5500);
await shot('extracted');
console.log('end', await ev(`JSON.stringify({ screen: document.querySelector('.ex-screen').className, title: document.querySelector('.ex-title')?.textContent, errs: __errs })`));
process.exit(0);
