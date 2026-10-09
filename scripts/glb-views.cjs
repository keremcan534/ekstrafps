// Offscreen inspection renders of a humanoid GLB (Electron + three, never shown on screen):
//   node_modules/electron/dist/electron.exe scripts/glb-views.cjs <model.glb> <outdir> [--size=1024] [--textured]
//       [--markers=points.json] [--landmarks=landmarks.json] [--vcolors]
//       [--skeleton] [--weights=BoneName] [--pose=pose.json] [--look=public/assets/characters/textures/<look>]
// Rig inspection: --skeleton draws the bones and each bone's axes (X red, Y green, Z blue);
// --weights= colours the skin by one bone's weight (blue 0 .. red 1); --pose= applies local rotations
// on top of the rest pose before rendering: {"Forearm_R": [xDeg, yDeg, zDeg] | [qx, qy, qz, qw], ...}.
//
// Orthographic clay renders (no perspective distortion, so left/right can be compared):
//   body_*.png    front, back, left, right, three-quarter front and back
//   hand_<R|L>_*  front, back, outside, inside (torso clipped away), from the fingertips, wireframe
//   joint_*       shoulders and elbows front/back, head front/side
//   wrist_<R|L>_*  front, back, outside, inside close-ups at the wrist pivot (needs --landmarks=, the
//                  JSON of scripts/blender/landmarks.py; it also frames the hands on the found digits)
//   sheet_body.png, sheet_hands.png, sheet_joints.png (+ sheet_wrists.png)   the same views tiled, labelled
// --markers= draws debug points/lines over everything: [{p:[x,y,z], color, r} | {line:[[..],[..]], color}].
// The model faces +Z (glTF), so its RIGHT hand is at -X. Hands are found as the extreme-|X| vertices.
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') || a.includes('='));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [model, outdir] = args.filter((a) => !a.startsWith('--'));
if (!model || !outdir) {
  console.error('usage: electron scripts/glb-views.cjs <model.glb> <outdir> [--size=1024] [--textured]');
  process.exit(1);
}
const size = Number((flags.find((f) => f.startsWith('--size=')) ?? '--size=1024').slice(7));
const textured = flags.includes('--textured');
const vcolors = flags.includes('--vcolors');
const skeleton = flags.includes('--skeleton');
const weights = (flags.find((f) => f.startsWith('--weights=')) ?? '').slice(10) || null;
// --look=<dir>: a look's textures (base_color.webp, normal.webp, orm.webp) on the material named "Body".
const lookDir = (flags.find((f) => f.startsWith('--look=')) ?? '').slice(7) || null;
const look = lookDir ? path.relative(ROOT, path.resolve(lookDir)).split(path.sep).join('/') : null;
// A colour version of another look (look.json {"maps": <look>}) shares that look's normal / ORM maps.
const lookJson = lookDir && fs.existsSync(path.join(lookDir, 'look.json')) ? JSON.parse(fs.readFileSync(path.join(lookDir, 'look.json'), 'utf8')) : null;
const lookMaps = lookJson?.maps ? path.posix.join(path.posix.dirname(look), lookJson.maps) : look;
const readFlag = (name) => {
  const f = flags.find((x) => x.startsWith(`--${name}=`));
  return f ? JSON.parse(fs.readFileSync(f.slice(name.length + 3), 'utf8')) : null;
};
const markers = readFlag('markers');
const pose = readFlag('pose');
const landmarks = readFlag('landmarks');

protocol.registerSchemesAsPrivileged([
  { scheme: 'glbview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"glbview://root/node_modules/three/build/three.module.js","three/addons/":"glbview://root/node_modules/three/examples/jsm/"}}</script>
</head><body style="margin:0;background:#888">
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

window.__run = async (cfg) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(cfg.size, cfg.size);
  renderer.setClearColor(0x9aa0a6);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
  const gltf = await new GLTFLoader().loadAsync(cfg.url);
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  const clay = new THREE.MeshStandardMaterial({ color: 0xc8c4bc, roughness: 0.75, metalness: 0 });
  const wire = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, wireframe: true });
  const meshes = [];
  const vclay = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
  root.traverse((o) => { if (o.isMesh) { meshes.push(o); o.userData.orig = cfg.vcolors && o.geometry.attributes.color ? vclay : o.material; if (!cfg.textured) o.material = o.userData.orig === vclay ? vclay : clay; o.frustumCulled = false; } });

  // Rig inspection: a pose (local rotations on top of rest), weight heat maps, skeleton + bone axes.
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  if (cfg.pose) {
    for (const [name, r] of Object.entries(cfg.pose)) {
      const b = bones[name];
      if (!b) { console.warn('pose: no bone', name); continue; }
      const q = r.length === 4 ? new THREE.Quaternion(...r)
        : new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.map((d) => THREE.MathUtils.degToRad(d)), 'XYZ'));
      b.quaternion.multiply(q);
    }
    root.updateMatrixWorld(true);
  }
  if (cfg.look) {
    const tl = new THREE.TextureLoader();
    const load = (dir, n, srgb) => tl.loadAsync(\`glbview://root/\${dir}/\${n}\`).then((t) => { t.flipY = false; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; });
    const [map, normalMap, orm] = await Promise.all([load(cfg.look, 'base_color.webp', true), load(cfg.lookMaps, 'normal.webp', false), load(cfg.lookMaps, 'orm.webp', false)]);
    const body = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap: orm, metalnessMap: orm, aoMap: orm, metalness: 1, roughness: 1 });
    for (const m of meshes) if (m.userData.orig?.name === 'Body') { m.userData.orig = body; m.material = body; }
    cfg.textured = true;
  }
  if (cfg.weights) {
    for (const m of meshes) {
      if (!m.isSkinnedMesh) continue;
      const bi = m.skeleton.bones.findIndex((b) => b.name === cfg.weights);
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      const col = new Float32Array(si.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < si.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
        c.setHSL(0.66 * (1 - w), 0.85, w > 0 ? 0.5 : 0.75);
        col.set([c.r, c.g, c.b], i * 3);
      }
      m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      m.userData.orig = vclay;
      m.material = vclay;
    }
  }
  if (cfg.skeleton) {
    const sh = new THREE.SkeletonHelper(root);
    sh.material.depthTest = false; sh.material.linewidth = 2; sh.renderOrder = 11;
    scene.add(sh);
    for (const b of Object.values(bones)) {
      const ax = new THREE.AxesHelper(cfg.skeleton === true ? 0.03 : cfg.skeleton);
      ax.material.depthTest = false; ax.renderOrder = 12;
      b.add(ax);
    }
    root.updateMatrixWorld(true);
  }

  if (cfg.markers) {
    for (const m of cfg.markers) {
      const mat = new THREE.MeshBasicMaterial({ color: m.color ?? '#ff00ff', depthTest: false });
      if (m.line) {
        const g = new THREE.BufferGeometry().setFromPoints(m.line.map((q) => new THREE.Vector3(...q)));
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: m.color ?? '#ff00ff', depthTest: false }));
        l.renderOrder = 10; scene.add(l);
      } else {
        const b = new THREE.Mesh(new THREE.SphereGeometry(m.r ?? 0.005, 10, 8), mat);
        b.position.set(...m.p); b.renderOrder = 10; scene.add(b);
      }
    }
  }
  // World-space vertices (skinned meshes in their bind pose).
  const pts = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(m.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  }
  const P = new Float32Array(pts);
  const box = new THREE.Box3();
  for (let i = 0; i < P.length; i += 3) box.expandByPoint(v.set(P[i], P[i + 1], P[i + 2]));
  const H = box.max.y - box.min.y;
  const at = (f) => box.min.y + f * H;

  // Region boxes: hands = vertices near the extreme-|X| vertex, below the shoulders.
  function extreme(sign) {
    let best = -Infinity, k = 0;
    for (let i = 0; i < P.length; i += 3) if (P[i + 1] < at(0.8) && sign * P[i] > best) { best = sign * P[i]; k = i; }
    return new THREE.Vector3(P[k], P[k + 1], P[k + 2]);
  }
  function regionBox(c, r, maxY = Infinity) {
    const b = new THREE.Box3();
    for (let i = 0; i < P.length; i += 3) {
      const dx = P[i] - c.x, dy = P[i + 1] - c.y, dz = P[i + 2] - c.z;
      if (dx * dx + dy * dy + dz * dz < r * r && P[i + 1] < maxY) b.expandByPoint(v.set(P[i], P[i + 1], P[i + 2]));
    }
    return b;
  }
  // Shoulder: the lateral-most point of the 79-83 % height band on each side.
  function shoulder(sign) {
    const xs = [];
    for (let i = 0; i < P.length; i += 3) if (P[i + 1] > at(0.79) && P[i + 1] < at(0.83) && sign * P[i] > 0) xs.push(sign * P[i]);
    xs.sort((a, b) => a - b);
    return new THREE.Vector3(sign * xs[Math.floor(xs.length * 0.9)], at(0.81), (box.min.z + box.max.z) / 2);
  }
  const R = extreme(-1), L = extreme(1);
  const handR = regionBox(R, 0.11 * H, at(0.8)), handL = regionBox(L, 0.11 * H, at(0.8));
  const shR = shoulder(-1), shL = shoulder(1);
  const hcR = handR.getCenter(new THREE.Vector3()), hcL = handL.getCenter(new THREE.Vector3());
  const elR = shR.clone().lerp(hcR, 0.5), elL = shL.clone().lerp(hcL, 0.5);
  const cube = (c, r) => new THREE.Box3(c.clone().subScalar(r), c.clone().addScalar(r));
  const headBox = new THREE.Box3(new THREE.Vector3(-0.09 * H, at(0.86), box.min.z), new THREE.Vector3(0.09 * H, box.max.y + 0.01 * H, box.max.z));

  // Orthographic shot of a region from a direction; near/far hug the region so other parts are clipped.
  const cam = new THREE.OrthographicCamera();
  const key = new THREE.DirectionalLight(0xffffff, 2.2), fill = new THREE.DirectionalLight(0xbfd4ff, 0.8);
  scene.add(key, fill, key.target, fill.target);
  function shot(region, dir, opts = {}) {
    const c = region.getCenter(new THREE.Vector3());
    const s = region.getSize(new THREE.Vector3());
    const d = dir.clone().normalize();
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const radius = s.length() / 2;
    cam.position.copy(c).addScaledVector(d, radius * 4);
    cam.up.copy(up);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    // Frame by projecting the region's corners into camera space.
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? region.max.x : region.min.x, i & 2 ? region.max.y : region.min.y, i & 4 ? region.max.z : region.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
    }
    const half = Math.max(x1 - x0, y1 - y0) / 2 * 1.08, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    Object.assign(cam, { left: cx - half, right: cx + half, top: cy + half, bottom: cy - half });
    const clip = opts.clip ?? false;
    cam.near = clip ? -z1 - 0.002 * H : 0.001; cam.far = clip ? -z0 + 0.002 * H : radius * 8 + 10 * H;
    cam.updateProjectionMatrix();
    key.position.copy(c).add(d.clone().add(new THREE.Vector3(0.4, 0.8, 0.3)).multiplyScalar(H)); key.target.position.copy(c);
    fill.position.copy(c).add(d.clone().add(new THREE.Vector3(-0.6, -0.2, -0.2)).multiplyScalar(H)); fill.target.position.copy(c);
    for (const m of meshes) m.material = opts.wire ? wire : cfg.textured || m.userData.orig === vclay ? m.userData.orig : clay;
    renderer.setClearColor(opts.wire ? 0xf2f2f2 : 0x9aa0a6);
    renderer.render(scene, cam);
    return renderer.domElement.toDataURL('image/png');
  }

  const F = new THREE.Vector3(0, 0, 1), B = new THREE.Vector3(0, 0, -1), Xp = new THREE.Vector3(1, 0, 0), Xn = new THREE.Vector3(-1, 0, 0);
  const pad = box.clone().expandByScalar(0.02 * H);
  const out = {};
  out.body_front = shot(pad, F); out.body_back = shot(pad, B);
  out.body_left = shot(pad, Xp); out.body_right = shot(pad, Xn);
  out.body_q34_front = shot(pad, new THREE.Vector3(-1, 0.25, 1.4)); out.body_q34_back = shot(pad, new THREE.Vector3(1, 0.25, -1.4));
  for (const [side, hb, out_, in_, tip] of [['R', handR, Xn, Xp, R], ['L', handL, Xp, Xn, L]]) {
    const hp = hb.clone().expandByScalar(0.01 * H);
    const c = hp.getCenter(new THREE.Vector3());
    const tipDir = tip.clone().sub(c).normalize();
    out[\`hand_\${side}_front\`] = shot(hp, F, { clip: true });
    out[\`hand_\${side}_back\`] = shot(hp, B, { clip: true });
    out[\`hand_\${side}_outside\`] = shot(hp, out_, { clip: true });
    out[\`hand_\${side}_inside\`] = shot(hp, in_, { clip: true });
    out[\`hand_\${side}_tip\`] = shot(hp, tipDir, { clip: true });
    out[\`hand_\${side}_wire\`] = shot(hp, F, { clip: true, wire: true });
  }
  const jr = 0.075 * H;
  out.joint_shoulder_R_front = shot(cube(shR, jr), F); out.joint_shoulder_R_back = shot(cube(shR, jr), B);
  out.joint_shoulder_L_front = shot(cube(shL, jr), F); out.joint_shoulder_L_back = shot(cube(shL, jr), B);
  out.joint_elbow_R_front = shot(cube(elR, jr), F, { clip: true }); out.joint_elbow_R_back = shot(cube(elR, jr), B, { clip: true });
  out.joint_elbow_L_front = shot(cube(elL, jr), F, { clip: true }); out.joint_elbow_L_back = shot(cube(elL, jr), B, { clip: true });
  out.joint_head_front = shot(headBox, F); out.joint_head_side = shot(headBox, Xn);
  if (cfg.landmarks) {
    for (const [side, out_, in_] of [['R', Xn, Xp], ['L', Xp, Xn]]) {
      const w = new THREE.Vector3(...cfg.landmarks.sides[side].wrist);
      const wb = cube(w, 0.07);
      out[\`wrist_\${side}_front\`] = shot(wb, F, { clip: true });
      out[\`wrist_\${side}_back\`] = shot(wb, B, { clip: true });
      out[\`wrist_\${side}_outside\`] = shot(wb, out_, { clip: true });
      out[\`wrist_\${side}_inside\`] = shot(wb, in_, { clip: true });
    }
  }

  // Labelled contact sheets.
  async function sheet(names, cols) {
    const t = cfg.size / 2, rows = Math.ceil(names.length / cols);
    const cv = document.createElement('canvas'); cv.width = cols * t; cv.height = rows * t;
    const g = cv.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < names.length; i++) {
      const im = new Image(); im.src = out[names[i]]; await im.decode();
      const x = (i % cols) * t, y = Math.floor(i / cols) * t;
      g.drawImage(im, x, y, t, t);
      g.font = 'bold 18px sans-serif'; g.fillStyle = '#000a'; g.fillRect(x, y, g.measureText(names[i]).width + 12, 26);
      g.fillStyle = '#fff'; g.fillText(names[i], x + 6, y + 19);
      g.strokeStyle = '#222'; g.strokeRect(x, y, t, t);
    }
    return cv.toDataURL('image/png');
  }
  const ks = Object.keys(out);
  out.sheet_body = await sheet(ks.filter((k) => k.startsWith('body_')), 3);
  out.sheet_hands = await sheet(ks.filter((k) => k.startsWith('hand_')), 6);
  out.sheet_joints = await sheet(ks.filter((k) => k.startsWith('joint_')), 5);
  if (cfg.landmarks) out.sheet_wrists = await sheet(ks.filter((k) => k.startsWith('wrist_')), 4);
  const r3 = (p) => [p.x, p.y, p.z].map((n) => +n.toFixed(4));
  return { shots: out, info: { height: H, box: [r3(box.min), r3(box.max)], verts: P.length / 3, handR: r3(hcR), handL: r3(hcL), shoulderR: r3(shR), shoulderL: r3(shL) } };
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
  try {
    await win.loadURL('glbview://root/__page.html');
    const rel = path.relative(ROOT, path.resolve(model)).split(path.sep).join('/');
    for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.__ready')); i++) await new Promise((r) => setTimeout(r, 100));
    const res = await win.webContents.executeJavaScript(`window.__run(${JSON.stringify({ url: `glbview://root/${rel}`, size, textured, vcolors, markers, landmarks, pose, skeleton, weights, look, lookMaps })})`);
    fs.mkdirSync(outdir, { recursive: true });
    for (const [name, data] of Object.entries(res.shots)) fs.writeFileSync(path.join(outdir, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(outdir, 'views.json'), JSON.stringify(res.info, null, 2));
    console.log(`${model}: ${Object.keys(res.shots).length} views → ${outdir}`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
