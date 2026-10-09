// Offline preview of a character built on MASTER_HUMANOID_RIG: master body + look textures + gear,
// assembled exactly as src/characters/README.md describes (socket gear under its socket bone with
// the gear JSON's transform; skinned gear rebound to the body's bones by name; texture variants by
// look). Electron + three, offscreen; never shown on screen:
//   node_modules/electron/dist/electron.exe scripts/character-preview.cjs <character id|json> <outdir>
//       [--body=public/assets/characters/master/master_humanoid_rigged.glb] [--size=640]
//       [--poses=rest,legs,raise] [--views=front,back,right,q34_front,q34_back] [--gear=kind/id,...]
//       [--look=<look>] [--bones] [--focus=full|head|torso|hips]
// Poses: 'rest' or a file name in production/assets/src/chars/master/rig/poses/ (local rotations on
// top of the rest pose, {"Thigh_R": [xDeg, yDeg, zDeg] | [qx, qy, qz, qw]}).
// Writes <outdir>/<pose>_<view>.png, sheet.png (rows = poses, columns = views) and preview.json
// (what was attached where, missing files). Missing look textures fall back to a flat colour per
// look, so the gear can be judged before the looks exist.
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.length ? v.join('=') : true];
}));
const [charArg, outdir] = argv.filter((a) => !a.startsWith('--'));
if (!charArg || !outdir) {
  console.error('usage: electron scripts/character-preview.cjs <character id|json> <outdir> [--body=] [--poses=] [--views=] [--size=]');
  process.exit(1);
}
const rel = (p) => path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join('/');
const charFile = charArg.endsWith('.json') ? charArg : `public/assets/characters/characters/${charArg}.json`;
const character = JSON.parse(fs.readFileSync(path.resolve(ROOT, charFile), 'utf8'));
if (flags.gear) character.gear = String(flags.gear).split(',').filter(Boolean);
if (flags.look) character.look = flags.look;
const poseNames = String(flags.poses ?? 'rest,legs,raise').split(',');
const poses = poseNames.map((n) => (n === 'rest' ? { name: n, bones: {} } : { name: n, bones: JSON.parse(fs.readFileSync(path.join(ROOT, 'production/assets/src/chars/master/rig/poses', `${n}.json`), 'utf8')) }));
const cfg = {
  body: `glbview://root/${rel(flags.body ?? 'public/assets/characters/master/master_humanoid_rigged.glb')}`,
  base: 'glbview://root/public/assets/characters',
  character,
  poses,
  views: String(flags.views ?? 'front,back,right,q34_front,q34_back').split(','),
  size: Number(flags.size ?? 640),
  bones: !!flags.bones,
  focus: flags.focus ?? 'full',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'glbview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"glbview://root/node_modules/three/build/three.module.js","three/addons/":"glbview://root/node_modules/three/examples/jsm/"}}</script>
</head><body style="margin:0;background:#888">
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Flat stand-in colours while a look's textures do not exist yet.
const LOOK_COLOURS = { master: 0x2a2a2c, vanta: 0x3d4a5c, black_division: 0x1d1e21, pmc: 0x8a7a5a, warden: 0x26272b };

window.__run = async (cfg) => {
  const log = { attached: [], missing: [], warnings: [] };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(cfg.size, cfg.size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50505a, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0), fill = new THREE.DirectionalLight(0xc8d8ff, 0.7);
  scene.add(key, fill, key.target, fill.target);
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const exists = async (url) => { try { const r = await fetch(url); return r.ok; } catch { return false; } };
  const loadTex = async (url, srgb) => {
    if (!(await exists(url))) return null;
    const t = await texLoader.loadAsync(url);
    t.flipY = false;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  // Body + look.
  const body = (await loader.loadAsync(cfg.body)).scene;
  scene.add(body);
  const bones = {};
  body.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const look = cfg.character.look;
  const lookDir = cfg.base + '/textures/' + look;
  const [bc, nm, orm] = await Promise.all([loadTex(lookDir + '/base_color.webp', true), loadTex(lookDir + '/normal.webp'), loadTex(lookDir + '/orm.webp')]);
  let bodyUV = false;
  body.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    bodyUV ||= !!o.geometry.attributes.uv;
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
    if (bc && o.geometry.attributes.uv) {
      m.map = bc;
      if (nm) m.normalMap = nm;
      if (orm) { m.aoMap = orm; m.roughnessMap = orm; m.metalnessMap = orm; m.roughness = 1; m.metalness = 1; }
    } else m.color.setHex(LOOK_COLOURS[look] ?? 0x777777);
    o.material = m;
  });
  if (!bc) log.missing.push('look ' + look + ' (flat colour used)');
  else if (!bodyUV) log.warnings.push('body GLB has no UVs: look textures cannot apply');

  // Gear, by the contract.
  for (const ref of cfg.character.gear) {
    const jsonUrl = cfg.base + '/gear/' + ref + '.json';
    if (!(await exists(jsonUrl))) { log.missing.push('gear ' + ref); continue; }
    const g = await (await fetch(jsonUrl)).json();
    const dir = jsonUrl.slice(0, jsonUrl.lastIndexOf('/') + 1);
    const gscene = (await loader.loadAsync(dir + g.model)).scene;
    // Texture variant for this look.
    const v = g.variants?.[look];
    if (v) {
      const vd = dir + v;
      const [vb, vn, vo] = await Promise.all([loadTex(vd + '/base_color.webp', true), loadTex(vd + '/normal.webp'), loadTex(vd + '/orm.webp')]);
      gscene.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material.clone();
        if (vb) m.map = vb;
        if (vn) m.normalMap = vn;
        if (vo) { m.roughnessMap = vo; m.metalnessMap = vo; m.aoMap = vo; }
        o.material = m;
      });
      log.attached.push(ref + ' variant ' + v);
    }
    gscene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    if (g.attach === 'socket') {
      const bone = bones[g.socket];
      if (!bone) { log.warnings.push(ref + ': no socket ' + g.socket); continue; }
      gscene.position.fromArray(g.position ?? [0, 0, 0]);
      gscene.quaternion.fromArray(g.quaternion ?? [0, 0, 0, 1]);
      gscene.scale.setScalar(g.scale ?? 1);
      bone.add(gscene);
      log.attached.push(ref + ' on ' + g.socket);
    } else if (g.attach === 'skinned') {
      gscene.updateMatrixWorld(true);
      const skinned = [];
      gscene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
      for (const m of skinned) {
        const list = m.skeleton.bones.map((b) => bones[b.name]);
        const lost = m.skeleton.bones.filter((b, i) => !list[i]).map((b) => b.name);
        if (lost.length) { log.warnings.push(ref + ': body has no bones ' + lost.join(',')); continue; }
        const skel = new THREE.Skeleton(list, m.skeleton.boneInverses.map((x) => x.clone()));
        const bind = m.bindMatrix.clone();
        body.add(m); // the gear's armature and its own bones are dropped
        m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
        m.bind(skel, bind);
      }
      log.attached.push(ref + ' skinned (' + skinned.length + ' meshes)');
    } else log.warnings.push(ref + ': unknown attach ' + g.attach);
  }
  body.updateMatrixWorld(true);

  // Framing: the rest pose's box (all meshes), shared by every pose so poses compare.
  const rest = {};
  for (const [n, b] of Object.entries(bones)) rest[n] = b.quaternion.clone();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  function measure() {
    box.makeEmpty();
    body.updateMatrixWorld(true);
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        if (m.isSkinnedMesh) m.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
        v.applyMatrix4(m.matrixWorld);
        box.expandByPoint(v);
      }
    }
    return box.clone();
  }
  const frame = measure();
  const H = frame.max.y - frame.min.y;
  frame.expandByScalar(0.03 * H);
  frame.min.y = 0 - 0.03 * H;
  // Close-ups: a cube around a bone (head / torso / hips), same for every pose.
  const FOCUS = { head: ['Head', 0.1, 0.19], torso: ['Spine2', 0.0, 0.42], hips: ['Hips', -0.1, 0.42] };
  if (FOCUS[cfg.focus]) {
    const [bn, up, r] = FOCUS[cfg.focus];
    const c = bones[bn].getWorldPosition(new THREE.Vector3()); c.y += up;
    frame.set(c.clone().subScalar(r), c.clone().addScalar(r));
  }

  const cam = new THREE.OrthographicCamera();
  const DIRS = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], q34_front: [-1, 0.2, 1.4], q34_back: [1, 0.2, -1.4], top: [0, 1, 0.001] };
  function shot(dirName) {
    const d = new THREE.Vector3(...DIRS[dirName]).normalize();
    const c = frame.getCenter(new THREE.Vector3());
    const s = frame.getSize(new THREE.Vector3());
    const R = s.length();
    cam.position.copy(c).addScaledVector(d, R * 3);
    cam.up.set(0, 1, 0);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? frame.max.x : frame.min.x, i & 2 ? frame.max.y : frame.min.y, i & 4 ? frame.max.z : frame.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const half = Math.max(x1 - x0, y1 - y0) / 2, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    Object.assign(cam, { left: cx - half, right: cx + half, top: cy + half, bottom: cy - half, near: 0.01, far: R * 8 });
    cam.updateProjectionMatrix();
    key.position.copy(c).add(d.clone().add(new THREE.Vector3(0.4, 0.9, 0.3)).multiplyScalar(4)); key.target.position.copy(c);
    fill.position.copy(c).add(d.clone().add(new THREE.Vector3(-0.7, -0.1, -0.2)).multiplyScalar(4)); fill.target.position.copy(c);
    renderer.setClearColor(0xa3a8ad);
    renderer.render(scene, cam);
    return renderer.domElement.toDataURL('image/png');
  }
  let helper = null;
  const out = {};
  for (const p of cfg.poses) {
    for (const [n, b] of Object.entries(bones)) b.quaternion.copy(rest[n]);
    for (const [n, r] of Object.entries(p.bones)) {
      const b = bones[n];
      if (!b) { log.warnings.push('pose ' + p.name + ': no bone ' + n); continue; }
      const q = r.length === 4 ? new THREE.Quaternion(...r) : new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.map((d) => THREE.MathUtils.degToRad(d)), 'XYZ'));
      b.quaternion.multiply(q);
    }
    body.updateMatrixWorld(true);
    if (cfg.bones) { if (helper) scene.remove(helper); helper = new THREE.SkeletonHelper(body); helper.material.depthTest = false; scene.add(helper); }
    for (const view of cfg.views) out[p.name + '_' + view] = shot(view);
  }
  // Sheet: rows = poses, columns = views.
  const t = cfg.size / 2, cols = cfg.views.length, rows = cfg.poses.length;
  const cv = document.createElement('canvas'); cv.width = cols * t; cv.height = rows * t + 34;
  const g = cv.getContext('2d'); g.fillStyle = '#1c1c1e'; g.fillRect(0, 0, cv.width, cv.height);
  g.font = 'bold 20px sans-serif'; g.fillStyle = '#fff';
  g.fillText(cfg.character.id + '  (look ' + look + ')  ' + cfg.character.gear.join('  '), 10, 24);
  let i = 0;
  for (const p of cfg.poses) for (const view of cfg.views) {
    const im = new Image(); im.src = out[p.name + '_' + view]; await im.decode();
    const x = (i % cols) * t, y = 34 + Math.floor(i / cols) * t;
    g.drawImage(im, x, y, t, t);
    g.font = 'bold 15px sans-serif'; const label = p.name + ' ' + view;
    g.fillStyle = '#000a'; g.fillRect(x, y, g.measureText(label).width + 10, 22); g.fillStyle = '#fff'; g.fillText(label, x + 5, y + 16);
    i++;
  }
  out.sheet = cv.toDataURL('image/png');
  return { shots: out, log };
};
window.__ready = true;
</script></body></html>`;

app.whenReady().then(async () => {
  protocol.handle('glbview', (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__page.html') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('missing', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = new BrowserWindow({ width: cfg.size, height: cfg.size, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL('glbview://root/__page.html');
    for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.__ready')); i++) await new Promise((r) => setTimeout(r, 100));
    const res = await win.webContents.executeJavaScript(`window.__run(${JSON.stringify(cfg)})`);
    fs.mkdirSync(outdir, { recursive: true });
    for (const [name, data] of Object.entries(res.shots)) fs.writeFileSync(path.join(outdir, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(outdir, 'preview.json'), JSON.stringify({ character, ...res.log }, null, 2));
    console.log(`${character.id}: ${Object.keys(res.shots).length} images -> ${outdir}`, JSON.stringify(res.log));
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
