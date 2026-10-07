import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildWeaponModel, builderKey } from '../weapons/WeaponModels';
import { gunSource, legacyFit, loadWeaponMeshes, movingBoxes } from '../weapons/WeaponMeshes';
import { createWeaponDefs } from '../weapons/WeaponData';
import { SPRINT_POSE, Viewmodel, type ViewmodelPlayer } from '../weapons/Viewmodel';
import { Weapon } from '../weapons/Weapon';
import { computeHandling, type Handling } from '../weapons/Handling';
import { getAmmo } from '../weapons/AmmoData';
import { FOCUS_DEFAULTS, aimMode, orientationMatrix, poseQuaternion, viewProfile, type AimMode, type AimSettings, type Axis, type ViewProfile } from '../weapons/ViewProfile';
import { playerConfig } from '../player/PlayerConfig';
import { feel } from '../config/Feel';
import { DEG, hfovToVfov } from '../core/math';
import { handConfig } from '../weapons/FirstPersonHands';
import { LIMITS, coverage, runStateChecks, sightLine, sightPicture, type StateRow } from './viewChecks';
import { handFolder, handReport, handView, seedHands, type HandEditorHost } from './handEditor';
import gunHandsFile from '../config/gunhands.json';
import { gripRotation, type WeaponHands } from '../weapons/HandPose';
import { WeaponSurface, fingerGaps, fitFingers, gloveInside } from './handChecks';

/**
 * Weapon calibration (dev server: /weapon-calibration.html). Pick a weapon and set its view
 * profile: OrientationRoot, ADSPoint (rear + front sight), hip and sprint poses, reference
 * points, motion taste, and the hands (grips, finger poses: handEditor.ts). "Kaydet" writes src/config/viewprofiles/<id>.json, the one place
 * it lives. The game's own Viewmodel draws and measures everything here.
 *
 * Gizmos: camera aim ray (cyan), sight line through the ADSPoint (green; rear and front sight
 * as dots), muzzle ray (red), hand IK points (yellow), butt (magenta), eject port (orange);
 * the hands' grips (forward blue, up green) have their own switch.
 * Aimed and still, green lies on cyan.
 */

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
type PointKey = keyof ViewProfile['points'];
/** Tuple slots as lil-gui property names. */
const IDX = ['0', '1', '2'] as const;
type Mode = 'hip' | 'ads' | 'sprint';

await loadWeaponMeshes();
const defs = createWeaponDefs();
const vm = new Viewmodel(innerWidth / innerHeight, defs);
const swayScale = feel.swayScale;

// --- Rendering: a range (targets on the aim axis), then the weapon pass, like the game ---
const host = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
host.appendChild(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer);
vm.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
vm.scene.environmentIntensity = 0.6;

const world = new THREE.Scene();
world.background = new THREE.Color(0x9fb4c8);
world.fog = new THREE.Fog(0x9fb4c8, 60, 260);
world.add(new THREE.HemisphereLight(0xdfe8ff, 0x5a5348, 1.6));
const sun = new THREE.DirectionalLight(0xfff2e0, 1.6);
sun.position.set(30, 60, 20);
world.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x6d7357, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
world.add(ground);
const grid = new THREE.GridHelper(600, 120, 0x3d4231, 0x555b44);
grid.position.y = 0.01;
world.add(grid);
for (const d of [10, 25, 50, 100]) {
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.5 + d * 0.01, 0.5 + d * 0.01), new THREE.MeshBasicMaterial({ color: 0xf2f2ee }));
  board.position.set(0, 1.6, -d);
  const s = 0.03 + d * 0.0008;
  const bar = (w: number, h: number) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  const h = bar(s * 6, s * 0.6);
  const v = bar(s * 0.6, s * 6);
  h.position.z = v.position.z = 0.001;
  board.add(h, v);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
  post.position.set(0, 0.8, -d - 0.05);
  world.add(board, post);
}
const mainCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.03, 400);
mainCam.position.set(0, 1.6, 0);
const sideCam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.005, 20);
sideCam.position.set(0.9, 0.15, 0.1);
const orbit = new OrbitControls(sideCam, renderer.domElement);
orbit.target.set(0.05, -0.05, -0.35);
orbit.update();
const eyeDot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
vm.scene.add(eyeDot);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  mainCam.aspect = sideCam.aspect = innerWidth / innerHeight;
  mainCam.updateProjectionMatrix();
  sideCam.updateProjectionMatrix();
  vm.setAspect(innerWidth / innerHeight);
});

// --- State ---
const st = {
  id: defs.find((d) => viewProfile(d.id))?.id ?? defs[0].id,
  mode: 'ads' as Mode,
  view: 'fp' as 'fp' | 'side',
  motion: false,
  gizmos: false,
  leftShoulder: false,
  pick: '' as '' | PointKey,
};
/** Working copies (edits land here until saved). */
const working = new Map<string, ViewProfile>();
for (const d of defs) {
  const p = viewProfile(d.id);
  if (p) working.set(d.id, structuredClone(p) as ViewProfile);
}
let data = defs[0];
let weapon: Weapon;
let handling: Handling;
const listener = { onShot: () => {}, onDryFire: () => {}, onSound: () => {} };
const player: ViewmodelPlayer = { yaw: 0, velocity: V(), crouching: false, sprinting: false, grounded: true, bobPhase: 0 };
const profile = (): ViewProfile | null => working.get(st.id) ?? null;

function motionMode(): void {
  feel.swayScale = st.motion ? swayScale : 0;
  handling = computeHandling(data, getAmmo(data.ammo));
  vm.refresh(handling);
}

function select(id: string): void {
  st.id = id;
  data = defs.find((d) => d.id === id)!;
  weapon = new Weapon(data, listener);
  weapon.state = 'ready';
  handling = computeHandling(data, getAmmo(data.ammo));
  vm.setWeapon(weapon, handling);
  const p = profile();
  if (p) vm.setViewProfile(data, p);
  motionMode();
  attachGizmos();
  buildGui();
}

/** Rebuild the weapon from the working profile (after any edit). */
function apply(): void {
  const p = profile();
  if (!p) return;
  vm.setViewProfile(data, p);
  attachGizmos();
  refreshProxies();
}

// --- Gizmos ---
let gizmos: THREE.Object3D[] = [];
const gizmoMat = (color: number) => ({ color, depthTest: false, transparent: true });
function line(a: THREE.Vector3, b: THREE.Vector3, color: number): THREE.Line {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial(gizmoMat(color)));
  l.renderOrder = 999;
  l.frustumCulled = false;
  return l;
}
function dot(color: number, r = 0.0025): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial(gizmoMat(color)));
  m.renderOrder = 999;
  m.frustumCulled = false;
  m.userData.gizmo = true;
  return m;
}
function attachGizmos(): void {
  for (const g of gizmos) g.removeFromParent();
  gizmos = [];
  const add = (parent: THREE.Object3D, o: THREE.Object3D, at?: THREE.Vector3) => {
    if (at) o.position.copy(at);
    parent.add(o);
    gizmos.push(o);
  };
  const rig = vm.activeRig!;
  add(vm.aimReference, line(V(0, 0, -0.02), V(0, 0, -4), 0x2ad4ff));
  add(rig.sight, line(V(0, 0, 0.45), V(0, 0, -1.4), 0x48ff7a));
  add(rig.sight, dot(0x48ff7a));
  const p = profile();
  if (p && rig.view) {
    // The front sight in the ADSPoint's own frame (both in weapon space).
    const f = V(...p.points.sightFront).applyMatrix4(orientationMatrix(p, new THREE.Matrix4()));
    add(rig.sight, dot(0xb6ffc8), f.sub(rig.sight.position).applyQuaternion(rig.sight.quaternion.clone().invert()));
  }
  add(rig.muzzle, line(V(), V(0, 0, -1.6), 0xff4040));
  add(rig.muzzle, dot(0xff4040));
  add(rig.root, dot(0xffe14a, 0.006), rig.leftHandRest);
  add(rig.root, dot(0xffe14a, 0.006), rig.rightHandRest);
  add(rig.root, dot(0xff4dff, 0.006), rig.butt);
  add(rig.ejectPort, dot(0xff9a3a, 0.004));
}

// --- Picking a reference point on the model ---
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (e) => {
  const key = st.pick;
  const p = profile();
  const rig = vm.activeRig;
  if (!key || !p || !rig?.view) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, st.view === 'fp' ? vm.camera : sideCam);
  const meshes: THREE.Mesh[] = [];
  rig.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.gizmo) meshes.push(o as THREE.Mesh);
  });
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return;
  const local = hit.point.clone().applyMatrix4(rig.view.orientation.matrixWorld.clone().invert());
  p.points[key] = local.toArray().map((v) => round(v, 3)) as [number, number, number];
  st.pick = '';
  apply();
  toast(`${key} = ${p.points[key].join(', ')}`);
});

// --- GUI ---
let gui: GUI | null = null;
const proxies: { key: PointKey; o: { x: number; y: number; z: number } }[] = [];
const round = (v: number, d: number) => +v.toFixed(d);

function refreshProxies(): void {
  const p = profile();
  if (!p) return;
  const O = orientationMatrix(p, new THREE.Matrix4());
  for (const { key, o } of proxies) {
    const w = V(...p.points[key]).applyMatrix4(O);
    o.x = round(w.x * 1000, 2);
    o.y = round(w.y * 1000, 2);
    o.z = round(w.z * 1000, 2);
  }
  gui?.controllersRecursive().forEach((c) => c.updateDisplay());
}

function pointFolder(parent: GUI, key: PointKey, label: string): void {
  const p = profile()!;
  const o = { x: 0, y: 0, z: 0 };
  proxies.push({ key, o });
  const f = parent.addFolder(label).close();
  const set = () => {
    const m = V(o.x / 1000, o.y / 1000, o.z / 1000).applyMatrix4(orientationMatrix(p, new THREE.Matrix4()).invert());
    p.points[key] = m.toArray().map((v) => round(v, 3)) as [number, number, number];
    apply();
  };
  for (const a of ['x', 'y', 'z'] as const) f.add(o, a, -800, 800, 0.05).name(`${a} (mm, silah)`).onChange(set);
  f.add({ pick: () => ((st.pick = key), toast(`${label}: modelin üstüne tıkla`)) }, 'pick').name('Modelde tıklayarak koy');
}

/**
 * Aim mode: TrueADS (the ADSPoint lined up) or FocusAim (FOV narrows, the gun comes in, no
 * sight alignment), with FocusAim's values; the hip FOV and aimed look sensitivity either way.
 */
function aimFolder(parent: GUI, p: ViewProfile): void {
  const f = parent.addFolder('Nişan modu (TrueADS / FocusAim)').close();
  const st = { mode: aimMode(p), hipFov: p.aim?.hipFOV ?? 0 };
  const ensure = () => (p.aim ??= { ...structuredClone(FOCUS_DEFAULTS) as AimSettings, mode: st.mode });
  f.add(st, 'mode', { 'TrueADS (gez–arpacık hizası)': 'TrueADS', 'FocusAim (zoom, hizasız)': 'FocusAim' })
    .name('Mod')
    .onChange((m: AimMode) => {
      ensure().mode = m;
      apply();
      buildGui();
    });
  if (st.mode === 'FocusAim') {
    const a = ensure();
    f.add(a, 'aimFOV', 30, 90, 0.5).name('nişan FOV (yatay °)').onChange(apply);
    const names = ['x (ortaya, m)', 'y (yukarı, m)', 'z (geri, m)'];
    for (let i = 0; i < 3; i++) f.add(a.aimWeaponPositionOffset, IDX[i], -0.15, 0.15, 0.0005).name(`konum ${names[i]}`).onChange(apply);
    const rot = ['eğim', 'sapma', 'yatma'];
    for (let i = 0; i < 3; i++) f.add(a.aimWeaponRotationOffset, IDX[i], -20, 20, 0.1).name(`dönüş ${rot[i]} °`).onChange(apply);
    f.add(a, 'aimSwayMultiplier', 0, 1, 0.01).name('sallanma kalan').onChange(apply);
    f.add(a, 'aimBobMultiplier', 0, 1, 0.01).name('adım sarsıntısı kalan').onChange(apply);
    f.add(a, 'aimInertiaMultiplier', 0, 1, 0.01).name('atalet kalan').onChange(apply);
  }
  if (p.aim) {
    f.add(p.aim, 'aimSensitivityMultiplier', 0.5, 1, 0.01).name('nişanda hassasiyet');
    f.add(st, 'hipFov', 0, 110, 1)
      .name('bel FOV (0: oyuncu ayarı)')
      .onChange((v: number) => {
        if (v > 0) p.aim!.hipFOV = v;
        else delete p.aim!.hipFOV;
      });
  }
}

function poseFolder(parent: GUI, label: string, pose: ViewProfile['hip']): void {
  const f = parent.addFolder(label).close();
  const names = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) f.add(pose.position, IDX[i], -0.8, 0.8, 0.0005).name(`konum ${names[i]} (m)`).onChange(apply);
  const rot = ['eğim (pitch)', 'sapma (yaw)', 'yatma (roll)'];
  for (let i = 0; i < 3; i++) f.add(pose.rotation, IDX[i], -90, 90, 0.01).name(`${rot[i]} °`).onChange(apply);
}

function buildGui(): void {
  gui?.destroy();
  proxies.length = 0;
  gui = new GUI({ title: 'Silah kalibrasyonu', width: 340 });
  const top = gui.addFolder('Silah ve görünüm');
  const options: Record<string, string> = {};
  for (const d of defs) options[`${working.has(d.id) ? '' : '(eski) '}${d.name}`] = d.id;
  top.add(st, 'id', options).name('Silah').onChange((id: string) => select(id));
  top.add(st, 'mode', { 'Bel (hip)': 'hip', 'Nişan (ADS)': 'ads', 'Koşu (sprint)': 'sprint' }).name('Duruş');
  top.add(st, 'view', { 'Birinci şahıs': 'fp', 'Yandan (gizmolar)': 'side' }).name('Kamera');
  top.add(st, 'gizmos').name('Gizmolar (birinci şahısta)');
  top.add(st, 'motion').name('Hareket (sway) açık').onChange(motionMode);
  top.add(st, 'leftShoulder').name('Sol omuz');
  const p = profile();
  if (!p || !vm.activeRig?.view) {
    // A procedural gun (no profile, or the model files are off): its hands
    // (src/config/gunhands.json, by builder), and the way to a profile.
    handFolder(gui, proceduralHandsHost());
    if (!p && gunSource(data.model)) top.add({ seed: () => seedFromLegacy() }, 'seed').name('Bu silaha profil oluştur');
    return;
  }
  const o = p.model.orientation;
  const ori = gui.addFolder('OrientationRoot (model yönü)').close();
  const axes: Axis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
  ori.add(o, 'forward', axes).name('namluya bakan eksen').onChange(apply);
  ori.add(o, 'up', axes).name('yukarı bakan eksen').onChange(apply);
  const rot = ['eğim (pitch)', 'sapma (yaw)', 'yatma (roll)'];
  for (let i = 0; i < 3; i++) ori.add(o.rotation, IDX[i], -15, 15, 0.01).name(`ince ${rot[i]} °`).onChange(apply);
  ori.add(o, 'scale', 0, 0.02, 0.000001).name('ölçek').onChange(apply);
  const wd = { width: o.width ?? 1 };
  ori.add(wd, 'width', 0.6, 2, 0.01)
    .name('genişlik (yanlara, ×)')
    .onChange((v: number) => {
      if (Math.abs(v - 1) < 1e-3) delete o.width;
      else o.width = v;
      apply();
    });
  for (let i = 0; i < 3; i++) ori.add(o.position, IDX[i], -0.5, 0.5, 0.0001).name(`konum ${'xyz'[i]} (m)`).onChange(apply);

  const ads = gui.addFolder('ADSPoint (nişan hattı)');
  pointFolder(ads, 'sightRear', 'Gez (çentik üstü / delik merkezi)');
  pointFolder(ads, 'sightFront', 'Arpacık tepesi / retikül');
  ads.add(p.ads, 'eyeRelief', 0.03, 0.7, 0.001).name('göz – gez mesafesi (m)').onChange(apply);
  ads.add(p.ads, 'fov', 30, 110, 0.5).name('nişan FOV (yatay °)').onChange(apply);
  const off = ads.addFolder('Bilerek kaydırma (normalde 0)').close();
  for (let i = 0; i < 3; i++) off.add(p.ads.offset, IDX[i], -0.02, 0.02, 0.0001).name(`${'xyz'[i]} (m)`).onChange(apply);
  off.add(p.ads, 'roll', -10, 10, 0.01).name('yatma °').onChange(apply);

  aimFolder(gui, p);
  poseFolder(gui, 'Bel pozu (hip)', p.hip);
  poseFolder(gui, 'Koşu pozu (sprint)', p.sprint);

  const pts = gui.addFolder('Referans noktaları').close();
  pointFolder(pts, 'muzzle', 'Namlu ağzı (MuzzlePoint)');
  pointFolder(pts, 'boreRear', 'Namlu ekseninde arka nokta');
  pointFolder(pts, 'eject', 'Kartuş çıkışı');
  pointFolder(pts, 'butt', 'Dipçik omuz noktası');

  handFolder(gui, {
    vm,
    hands: () => p.hands ?? null,
    toWeapon: () => orientationMatrix(p, new THREE.Matrix4()),
    seed: () => {
      p.hands = seedHands(orientationMatrix(p, new THREE.Matrix4()).invert(), viewProfile('ak47')?.hands ?? procHands.ak47);
      apply();
      buildGui();
    },
    apply,
    save,
    target: 'profil',
    toast,
  });

  const mo = gui.addFolder('Hareket çarpanları').close();
  for (const k of ['sway', 'inertia', 'bob', 'recoil'] as const) mo.add(p.motion, k, 0, 2, 0.01).name(k);

  const act = gui.addFolder('İşlemler');
  act.add({ save }, 'save').name('Kaydet (src/config/viewprofiles)');
  act.add({ revert }, 'revert').name('Dosyadakine geri dön');
  act.add({ copy: () => navigator.clipboard?.writeText(format(p)).then(() => toast('JSON kopyalandı')) }, 'copy').name('JSON kopyala');
  act.add({ check: () => checkStates() }, 'check').name('15 durumu test et');
  refreshProxies();
}

// --- A procedural gun's hands (src/config/gunhands.json, one entry per builder) ---
const procHands = structuredClone(gunHandsFile) as unknown as Record<string, WeaponHands>;

function proceduralHandsHost(): HandEditorHost {
  const key = builderKey(data.model);
  return {
    vm,
    hands: () => procHands[key] ?? null,
    toWeapon: () => new THREE.Matrix4(),
    seed: () => {
      const rig = vm.activeRig!;
      procHands[key] = seedHands(new THREE.Matrix4(), procHands.ak47 ?? viewProfile('ak47')?.hands, rig.rightHandRest, rig.leftHandRest);
      vm.setHands(procHands[key]);
      buildGui();
    },
    apply: () => vm.setHands(procHands[key]),
    save: async () => {
      const text = JSON.stringify(procHands, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`) + '\n';
      const res = await fetch('/__tuning/save', { method: 'POST', body: JSON.stringify({ file: 'gunhands', text }) });
      const j = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as { ok: boolean; file?: string; error?: string };
      toast(j.ok ? `Kaydedildi: ${j.file} (${key})` : `KAYDEDİLEMEDİ: ${j.error}`, !j.ok);
    },
    target: `gunhands.json: ${key}`,
    toast,
  };
}

// --- Save / revert / seed ---
/** The profile as a file: two-space JSON, number and name lists on one line. */
function format(p: ViewProfile): string {
  return JSON.stringify(p, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`) + '\n';
}

async function save(): Promise<void> {
  const p = profile();
  if (!p) return;
  const res = await fetch('/__tuning/save', { method: 'POST', body: JSON.stringify({ file: `viewprofiles/${p.id}`, text: format(p) }) });
  const j = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as { ok: boolean; file?: string; error?: string };
  toast(j.ok ? `Kaydedildi: ${j.file}` : `KAYDEDİLEMEDİ: ${j.error}`, !j.ok);
}

function revert(): void {
  const p = viewProfile(st.id);
  if (!p) return;
  working.set(st.id, structuredClone(p) as ViewProfile);
  select(st.id);
  toast('Dosyadaki değerler geri yüklendi');
}

/**
 * A first profile for a weapon on the old automatic placement: its fitted orientation made
 * square (the model's own axes), its points and poses carried over so it looks the same.
 * Then set the sights properly by clicking on them and save.
 */
function seedFromLegacy(): void {
  const d = data;
  const src = gunSource(d.model);
  const legacy = buildWeaponModel(d.model, false, false, d.sight.sightDistance);
  const fit = legacyFit(d.model);
  if (!src || !fit || !d.viewmodel) return toast('Bu silahın birinci şahıs modeli yok', true);
  const fp = V();
  const fq = new THREE.Quaternion();
  const fs = V();
  fit.decompose(fp, fq, fs);
  const R = new THREE.Matrix4().makeRotationFromQuaternion(fq);
  const cols = [0, 1, 2].map((i) => V().setFromMatrixColumn(R, i));
  const nearest = (target: THREE.Vector3): Axis => {
    let best: Axis = '+x';
    let most = -2;
    cols.forEach((c, i) => {
      for (const s of [1, -1]) {
        const along = c.clone().multiplyScalar(s).dot(target);
        if (along > most) [most, best] = [along, `${s > 0 ? '+' : '-'}${'xyz'[i]}` as Axis];
      }
    });
    return best;
  };
  const p: ViewProfile = {
    id: d.id,
    model: { key: d.model, orientation: { forward: nearest(V(0, 0, -1)), up: nearest(V(0, 1, 0)), rotation: [0, 0, 0], scale: round(fs.x, 8), position: [0, 0, 0] }, parts: {} },
    points: { sightRear: [0, 0, 0], sightFront: [0, 0, 0], muzzle: [0, 0, 0], boreRear: [0, 0, 0], eject: [0, 0, 0], butt: [0, 0, 0] },
    ads: { eyeRelief: round(legacy.eyeRelief ?? d.sight.sightDistance! - (legacy.sightShift ?? 0), 3), fov: d.sight.adsFov!, offset: [0, 0, 0], roll: 0 },
    hip: { position: [...d.viewmodel.hipPosition] as [number, number, number], rotation: [0, 0, 0] },
    sprint: { position: [0, 0, 0], rotation: [0, 0, 0] },
    motion: { sway: 1, inertia: 1, bob: 1, recoil: 1 },
  };
  // Keep the old weapon origin (the grip) where it was: only the stray turn goes.
  const origin = V().applyMatrix4(fit.clone().invert()).applyMatrix4(orientationMatrix(p, new THREE.Matrix4()));
  p.model.orientation.position = origin.negate().toArray().map((v) => round(v, 6)) as [number, number, number];
  const O = orientationMatrix(p, new THREE.Matrix4());
  const turn = new THREE.Quaternion().setFromRotationMatrix(fit.clone().multiply(O.clone().invert()));
  const toModel = (w: THREE.Vector3) => w.clone().applyMatrix4(fit.clone().invert()).toArray().map((v) => round(v, 3)) as [number, number, number];
  const s = legacy.sight.position;
  const tilt = legacy.sightTilt ?? 0;
  p.points.sightRear = toModel(s);
  p.points.sightFront = toModel(s.clone().add(V(0, -Math.sin(tilt), -Math.cos(tilt)).multiplyScalar(0.3)));
  p.points.muzzle = toModel(legacy.muzzle.position);
  p.points.boreRear = toModel(legacy.muzzle.position.clone().add(V(0, 0, 0.3)));
  p.points.eject = toModel(legacy.ejectPort.position);
  p.hands = seedHands(fit.clone().invert(), viewProfile('ak47')?.hands ?? procHands.ak47, legacy.rightHandRest, legacy.leftHandRest);
  p.points.butt = toModel(legacy.butt);
  // The same look at the hip and sprinting: old pose · the stray turn.
  const deg = (q: THREE.Quaternion) => {
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return [e.x, e.y, e.z].map((v) => round(v / DEG, 3)) as [number, number, number];
  };
  const hipQ = poseQuaternion(d.viewmodel.hipRotation ?? [0, 0, 6.88], new THREE.Quaternion());
  p.hip.rotation = deg(hipQ.multiply(turn));
  const sp = SPRINT_POSE[d.animSet];
  p.sprint.position = d.viewmodel.hipPosition.map((v, i) => round(v + sp.pos[i], 4)) as [number, number, number];
  p.sprint.rotation = deg(poseQuaternion([sp.rot[0] / DEG, sp.rot[1] / DEG, sp.rot[2] / DEG], new THREE.Quaternion()).multiply(turn));
  // Moving parts by name when the model's skeleton names them (the magazine with its rounds;
  // the bolt with its charging handle, a pistol's slide), else where the old placement cut
  // them out of the mesh (a box, model space).
  const names = src.parts.map((x) => x.name);
  const mag = names.filter((n) => /^_?mag_?\d*$|^bullets?_?\d*$/i.test(n));
  const bolt = names.filter((n) => /^(bolt(arm)?|slide|charg\w*|charge_?handle)_?\d*$/i.test(n));
  const boxes = movingBoxes(legacy);
  const inv = fit.clone().invert();
  const toModelBox = (b: THREE.Box3): [[number, number, number], [number, number, number]] => {
    const m = new THREE.Box3();
    for (let i = 0; i < 8; i++) m.expandByPoint(V(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv));
    return [m.min.toArray().map((v) => round(v, 4)) as [number, number, number], m.max.toArray().map((v) => round(v, 4)) as [number, number, number]];
  };
  if (mag.some((n) => /mag/i.test(n))) p.model.parts.mag = { names: mag };
  else if (!boxes.mag.isEmpty()) p.model.parts.mag = { box: toModelBox(boxes.mag) };
  if (bolt.length) p.model.parts.bolt = { names: bolt };
  else if (!boxes.bolt.isEmpty()) p.model.parts.bolt = { box: toModelBox(boxes.bolt) };
  working.set(d.id, p);
  select(d.id);
  toast('Profil oluşturuldu: gez ve arpacığı modelde tıklayarak ayarla, sonra Kaydet');
}

// --- State checks ---
function checkStates(): void {
  const other = defs.find((d) => d.id !== st.id)!;
  feel.swayScale = swayScale;
  const t0 = performance.now();
  const rows = runStateChecks({ vm, data, other, camera: mainCam });
  const ms = performance.now() - t0;
  select(st.id);
  (window as unknown as { __calib: unknown }).__calib = { rows, ms };
  const el = document.getElementById('report')!;
  const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const head = 'DURUM              SONUÇ  merkez°  ayrılma°  yatma°  en yakın  ekran%  merkez%  bilek°  parmak  eldiven  oturunca';
  const lines = rows.map(
    (r: StateRow) =>
      `${r.state.padEnd(19)}${(r.ok ? 'OK' : 'HATA').padEnd(7)}${f(r.offDeg).padStart(7)}  ${f(r.splitDeg, 3).padStart(8)}  ${f(r.rollDeg).padStart(6)}  ${(f(r.nearestM * 100, 1) + ' cm').padStart(8)}  ${f(r.screenPct, 1).padStart(6)}  ${f(r.centrePct, 1).padStart(7)}  ${f(r.wristDeg, 0).padStart(6)}  ${(f(r.fingerGapMm, 0) + ' mm').padStart(6)}  ${(f(r.gloveInMm, 0) + ' mm').padStart(7)}  ${f(r.settleDeg, 4)}° ${f(r.settleMm, 2)} mm` +
      (r.notes.length ? `\n${''.padEnd(19)}↳ ${r.notes.join('; ')}` : ''),
  );
  const bad = rows.filter((r) => !r.ok).length;
  el.innerHTML = `${head}\n${lines.map((l, i) => `<span class="${rows[i].ok ? '' : 'bad'}">${l}</span>`).join('\n')}\n\n<span class="${bad ? 'bad' : 'ok'}">${rows.length - bad}/${rows.length} durum geçti</span>  (${(ms / 1000).toFixed(1)} s)`;
  el.style.display = 'block';
}

// --- Info ---
let toastText = '';
let toastBad = false;
let toastUntil = 0;
function toast(text: string, bad = false): void {
  toastText = text;
  toastBad = bad;
  toastUntil = performance.now() + 4000;
}

let infoAt = 0;
let handsAt = 0;
let hands: string[] = [];
let pictureAt = 0;
let picture: ReturnType<typeof sightPicture> | null = null;
function info(now: number): void {
  if (now < infoAt) return;
  infoAt = now + 200;
  const a = vm.adsCheck;
  const px = (deg: number) => Math.round((deg * 1080) / vm.camera.fov);
  const out: string[] = [];
  const bad = (s: string) => `<span class="bad">${s}</span>`;
  out.push(`${data.name} (${data.id})  ${a.profiled ? 'PROFİL' : bad('ESKİ YERLEŞİM (profili yok)')}  ADS %${Math.round(vm.adsAmount * 100)}  ${st.motion ? 'hareket açık' : 'hareket dondurulmuş'}`);
  if (a.profiled && a.aimed && a.focus) {
    const f = profile()?.aim;
    out.push(`FocusAim     nişan FOV ${f?.aimFOV}°, gez hizası aranmaz; mermi kamera merkezine gider`);
  } else if (a.profiled && a.aimed) {
    const solveBad = a.solveMm > 0.05 || a.solveDeg > 0.005;
    out.push(`ADS hizası   çözüm ${a.solveMm.toFixed(3)} mm ${a.solveDeg.toFixed(4)}°${solveBad ? bad('  ← ÇÖZÜM HATALI') : ''}`);
    out.push(`             şu an ${a.liveDeg.toFixed(3)}° ${a.liveMm.toFixed(2)} mm, yatma ${a.liveRollDeg.toFixed(3)}°   oturunca ${a.restDeg.toFixed(4)}°`);
  }
  const sl = a.focus ? null : sightLine(vm);
  if (sl && vm.adsAmount > 0.99) {
    const s = `Gez–arpacık ayrılma ${sl.split.toFixed(3)}°, arpacık merkezden ${sl.off.toFixed(3)}° (${px(sl.off)} px @1080p)`;
    out.push(sl.split > LIMITS.splitDeg || sl.off > LIMITS.stillDeg ? bad(s) : s);
  }
  if (!a.focus && vm.adsAmount > 0.999 && !st.motion && now > pictureAt) {
    pictureAt = now + 600;
    picture = sightPicture(vm);
  } else if (vm.adsAmount < 0.99) picture = null;
  if (picture) {
    const t = picture.postTopDeg;
    const s = `Nişan resmi  arpacık tepesi ${t === null ? 'BULUNAMADI' : `${t.toFixed(2)}° (${px(t)} px)`}, üstü ${picture.clearAboveDeg ?? 0}° açık`;
    out.push(t === null || Math.abs(t) > 0.1 ? bad(s) : s);
    out.push(`<span class="dim">             ${picture.runs}</span>`);
  }
  const c = coverage(vm, vm.camera);
  const near = vm.camera.near;
  const s = `Ekran        %${c.screenPct.toFixed(1)} kaplıyor, merkez bölge %${c.centrePct.toFixed(1)}, en yakın ${(c.nearestM * 100).toFixed(1)} cm (near ${(near * 100).toFixed(1)} cm)`;
  const hipBad = vm.adsAmount < 0.05 && (c.centrePct > LIMITS.hipCentrePct || c.screenPct > LIMITS.hipScreenPct);
  out.push(hipBad || c.nearestM < near + LIMITS.nearMargin ? bad(s) : s);
  if (now > handsAt) {
    handsAt = now + 500;
    hands = handReport(vm);
  }
  out.push(...hands);
  if (st.pick) out.push(`<span class="ok">Nokta seçimi: ${st.pick} — modelin üstüne tıkla</span>`);
  if (now < toastUntil) out.push(toastBad ? bad(toastText) : `<span class="ok">${toastText}</span>`);
  out.push(`<span class="dim">camgöbeği: kamera ekseni · yeşil: gez→arpacık · kırmızı: namlu · sarı: eller · mor: dipçik · turuncu: kartuş</span>`);
  document.getElementById('info')!.innerHTML = out.join('\n');
}

// --- Frame loop ---
const SIDE_BACKGROUND = new THREE.Color(0x30343a);
const aimPoint = V();
let last = performance.now();
function tick(now: number): void {
  step(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw();
  info(now);
  requestAnimationFrame(tick);
}

/** The hands' animation scrub (handEditor): the weapon held at that moment of it. */
function scrub(): void {
  const w = weapon;
  const s = handView.scrub;
  const mag = data.reload.kind === 'magazine';
  if (s === 'none' || (mag && s.startsWith('shell')) || (!mag && (s === 'tactical' || s === 'empty'))) {
    if (w.state === 'reloading') w.state = 'ready';
    w.pumpTime = 99;
    return;
  }
  if (s === 'bolt') {
    w.state = 'ready';
    w.pumpTime = handView.t * w.cycleDuration;
    return;
  }
  w.state = 'reloading';
  if (mag) {
    w.reloadEmpty = s === 'empty';
    w.reloadDuration = w.reloadEmpty ? data.reload.emptyTime : data.reload.time;
    w.stateTime = handView.t * w.reloadDuration;
  } else {
    w.reloadEmpty = false;
    w.shellPhase = s === 'shellStart' ? 'start' : s === 'shellInsert' ? 'insert' : 'end';
    w.shellPhaseTime = handView.t * w.shellPhaseDuration;
  }
}

/** One simulation step of the weapon in the chosen stance. */
function step(dt: number): void {
  scrub();
  player.sprinting = st.mode === 'sprint';
  const ads = vm.adsAmount;
  aimPoint.set(0, 0, -(data.aim.hipConvergence + (data.aim.zeroDistance - data.aim.hipConvergence) * ads));
  mainCam.fov = hfovToVfov(playerConfig.baseFov + (vm.adsFov - playerConfig.baseFov) * ads);
  mainCam.updateProjectionMatrix();
  vm.update(dt, { player, lookYaw: 0, lookPitch: 0, adsTarget: st.mode === 'ads' ? 1 : 0, aimPoint, dropAngle: 0, mainCamera: mainCam, stamina: 1, wallTarget: 0, shoulder: st.leftShoulder ? -1 : 1 });
}

function draw(): void {
  const side = st.view === 'side';
  for (const g of gizmos) g.visible = side || st.gizmos;
  eyeDot.visible = side;
  renderer.clear();
  if (side) {
    vm.scene.background = SIDE_BACKGROUND;
    renderer.render(vm.scene, sideCam);
    vm.scene.background = null;
  } else {
    renderer.render(world, mainCam);
    renderer.clearDepth();
    renderer.render(vm.scene, vm.camera);
  }
  document.getElementById('centre')!.style.display = side ? 'none' : '';
}

select(st.id);
requestAnimationFrame(tick);
// Scripting hooks (screenshots, checks and measuring from the console).
Object.assign(window as object, {
  __calibVm: vm,
  __calibState: st,
  __calibSelect: select,
  __calibProfile: profile,
  __calibApply: apply,
  __calibSave: save,
  __calibSeed: seedFromLegacy,
  __calibLib: { THREE, gunSource, orientationMatrix, handConfig },
  __calibHands: { view: handView, WeaponSurface, fingerGaps, fitFingers, gloveInside, gripRotation, report: () => handReport(vm) },
  __calibSideCam: sideCam,
  // Background tabs get no animation frames: `steps` advances the weapon first (1/60 s each).
  __calibShot: (steps = 0): string => {
    for (let i = 0; i < steps; i++) step(1 / 60);
    draw();
    return renderer.domElement.toDataURL('image/jpeg', 0.92);
  },
});
