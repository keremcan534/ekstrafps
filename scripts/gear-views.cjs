// Offscreen inspection renders of a gear (or any small) GLB: textured and clay, orthographic, from
// the front (+Z), back, both sides, top, bottom and two three-quarter views, tiled into sheet.png:
//   node_modules/electron/dist/electron.exe scripts/gear-views.cjs <model.glb> <outdir> [--size=512]
//       [--markers=points.json]   ([{p:[x,y,z], color, r} | {line:[[..],[..]], color}], glTF space)
// views.json gets the bounding box, triangle count and texture sizes.
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const [model, outdir] = argv.filter((a) => !a.startsWith('--'));
if (!model || !outdir) {
  console.error('usage: electron scripts/gear-views.cjs <model.glb> <outdir> [--size=512] [--markers=file.json]');
  process.exit(1);
}
const size = Number(flags.size ?? 512);
const markers = flags.markers ? JSON.parse(fs.readFileSync(flags.markers, 'utf8')) : null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'glbview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"glbview://root/node_modules/three/build/three.module.js","three/addons/":"glbview://root/node_modules/three/examples/jsm/"}}</script>
</head><body style="margin:0">
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
window.__run = async (cfg) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(cfg.size, cfg.size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x505058, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0), fill = new THREE.DirectionalLight(0xc8d8ff, 0.7);
  scene.add(key, fill, key.target, fill.target);
  const gltf = await new GLTFLoader().loadAsync(cfg.url);
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) { meshes.push(o); o.frustumCulled = false; o.userData.orig = o.material; } });
  const clay = new THREE.MeshStandardMaterial({ color: 0xc8c4bc, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let tris = 0;
  const texSizes = new Set();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    tris += (m.geometry.index ? m.geometry.index.count : pos.count) / 3;
    for (let i = 0; i < pos.count; i++) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      box.expandByPoint(v.applyMatrix4(m.matrixWorld));
    }
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const t = m.material[k];
      if (t?.image) texSizes.add(k + ' ' + t.image.width + 'x' + t.image.height);
    }
  }
  if (cfg.markers) for (const mk of cfg.markers) {
    if (mk.line) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(mk.line.map((q) => new THREE.Vector3(...q))), new THREE.LineBasicMaterial({ color: mk.color ?? '#ff00ff', depthTest: false }));
      l.renderOrder = 10; scene.add(l);
    } else {
      const b = new THREE.Mesh(new THREE.SphereGeometry(mk.r ?? 0.004, 10, 8), new THREE.MeshBasicMaterial({ color: mk.color ?? '#ff00ff', depthTest: false }));
      b.position.set(...mk.p); b.renderOrder = 10; scene.add(b);
    }
  }
  const cam = new THREE.OrthographicCamera();
  const c = box.getCenter(new THREE.Vector3());
  const R = box.getSize(new THREE.Vector3()).length() / 2 + 1e-3;
  function shot(dir, mode) {
    const d = new THREE.Vector3(...dir).normalize();
    cam.position.copy(c).addScaledVector(d, R * 4);
    cam.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.95) cam.up.set(0, 0, -Math.sign(d.y));
    cam.lookAt(c);
    cam.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const half = Math.max(x1 - x0, y1 - y0) / 2 * 1.08, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    Object.assign(cam, { left: cx - half, right: cx + half, top: cy + half, bottom: cy - half, near: 0.001, far: R * 10 });
    cam.updateProjectionMatrix();
    key.position.copy(c).add(d.clone().add(new THREE.Vector3(0.4, 0.9, 0.3)).multiplyScalar(R * 4)); key.target.position.copy(c);
    fill.position.copy(c).add(d.clone().add(new THREE.Vector3(-0.7, -0.2, -0.2)).multiplyScalar(R * 4)); fill.target.position.copy(c);
    for (const m of meshes) m.material = mode === 'clay' ? clay : m.userData.orig;
    renderer.setClearColor(0xa3a8ad);
    renderer.render(scene, cam);
    return renderer.domElement.toDataURL('image/png');
  }
  const DIRS = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], q34_front: [-1, 0.35, 1.3], q34_back: [1, 0.35, -1.3] };
  const out = {};
  for (const [n, d] of Object.entries(DIRS)) out[n] = shot(d, 'tex');
  for (const n of ['front', 'right', 'top', 'q34_front']) out['clay_' + n] = shot(DIRS[n], 'clay');
  const names = Object.keys(out), cols = 6, t = cfg.size / 2;
  const cv = document.createElement('canvas'); cv.width = cols * t; cv.height = Math.ceil(names.length / cols) * t;
  const g = cv.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < names.length; i++) {
    const im = new Image(); im.src = out[names[i]]; await im.decode();
    const x = (i % cols) * t, y = Math.floor(i / cols) * t;
    g.drawImage(im, x, y, t, t);
    g.font = 'bold 14px sans-serif'; g.fillStyle = '#000a'; g.fillRect(x, y, g.measureText(names[i]).width + 10, 20);
    g.fillStyle = '#fff'; g.fillText(names[i], x + 5, y + 15);
  }
  out.sheet = cv.toDataURL('image/png');
  const r = (p) => [p.x, p.y, p.z].map((n) => +n.toFixed(4));
  return { shots: out, info: { box: [r(box.min), r(box.max)], size: r(box.getSize(new THREE.Vector3())), tris, meshes: meshes.length, textures: [...texSizes] } };
};
window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  protocol.handle('glbview', (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__page.html') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = new BrowserWindow({ width: size, height: size, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  const timer = setTimeout(() => { console.error('gear-views: timed out'); app.exit(2); }, 90000);
  try {
    await win.loadURL('glbview://root/__page.html');
    const relp = path.relative(ROOT, path.resolve(model)).split(path.sep).join('/');
    for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.__ready')); i++) await new Promise((r) => setTimeout(r, 100));
    const res = await win.webContents.executeJavaScript(`window.__run(${JSON.stringify({ url: `glbview://root/${relp}`, size, markers })})`);
    fs.mkdirSync(outdir, { recursive: true });
    for (const [name, data] of Object.entries(res.shots)) fs.writeFileSync(path.join(outdir, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(outdir, 'views.json'), JSON.stringify(res.info, null, 2));
    console.log(`${model}: ${JSON.stringify(res.info)}`);
    clearTimeout(timer);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
