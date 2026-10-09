import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MASTER_BONES, SIDES, loadMasterRig, mirrorName, type Side } from '../characters/master/MasterRig';
import { RifleHold, type StanceName, type WeaponHoldDef } from '../characters/master/RifleHold';
import data from '../characters/master/masterRig.json';
import ak47Profile from '../config/viewprofiles/ak47.json';
import { GunSurface, makeProbes, measure, runChecks, type CheckHost, type CheckReport, type ModeSpec } from './masterChecks';
import { applyFit, fitHand, fitThumb, type FitOptions } from './masterFit';

/**
 * The MASTER_HUMANOID_RIG validation lab (master-lab.html): the canonical skeleton playing its
 * clips, holding the AK-47 through RifleHold, with skeleton / per-bone axes / IK markers, slow
 * motion, a 360° turn, and the acceptance checks (masterChecks.ts) over every mode and yaw.
 *
 * Query: ?rig=<glb> (default: the proto_heat rig) &clips=<glb> &gun=ak47 &mode=rifle-aim.
 * window.__ml: set(mode), view(name, dist), step(n), shot() → data URL, sheet(specs, cols) →
 * data URL (a contact sheet), post(dataUrl, i) (→ production/trailer/frames/master_lab/),
 * checks() → report, derive() → the socket / grip numbers from the first-person AK hold, state().
 */
const q = new URLSearchParams(location.search);
const RIG_URL = q.get('rig') ?? '/assets/characters/master/master_humanoid_rigged.glb';
const CLIPS_URL = q.get('clips') ?? '/assets/characters/animations/humanoid/master_test_clips.glb';
const GUN_ID = (q.get('gun') ?? 'ak47') as keyof typeof data.weapons;

interface ModeDef {
  clip: string;
  stance: StanceName | null;
  turn?: boolean;
}
const MODES: Record<string, ModeDef> = {
  idle: { clip: 'idle', stance: null },
  walk: { clip: 'walk', stance: null },
  crouch: { clip: 'crouch', stance: null },
  aim: { clip: 'aim', stance: null },
  run: { clip: 'run', stance: null },
  'rifle-idle': { clip: 'idle', stance: 'low' },
  'rifle-aim': { clip: 'aim', stance: 'aim' },
  'aim-mirrored': { clip: 'aim-mirrored', stance: null },
  'rifle-aim-mirrored': { clip: 'aim-mirrored', stance: 'aim' },
  'rifle-walk': { clip: 'walk', stance: 'low' },
  'rifle-walk-aim': { clip: 'walk', stance: 'aim' },
  'rifle-crouch': { clip: 'crouch', stance: 'low' },
  'rifle-crouch-aim': { clip: 'crouch', stance: 'aim' },
  'turn-360': { clip: 'idle', stance: 'aim', turn: true },
};
const TURN_SPEED = THREE.MathUtils.degToRad(60);

// --- Scene -------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2d31);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 5);
scene.add(sun, new THREE.HemisphereLight(0xdfe8f0, 0x404040, 1.1));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor, new THREE.GridHelper(40, 80, 0x666666, 0x555555));
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.02, 100);
camera.position.set(0, 1.5, 3.2);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.2, 0);
const hud = document.getElementById('hud')!;
const reportEl = document.getElementById('report')!;

// --- Assets ------------------------------------------------------------------------------------
const rig = await loadMasterRig(RIG_URL);
const character = new THREE.Group();
character.name = 'Character';
character.add(rig.model);
scene.add(character);
for (const w of rig.report.warnings) console.warn('[master rig]', w);
for (const i of rig.report.info) console.info('[master rig]', i);

/** The gun's skinned pieces baked into static meshes in its model space (it never animates here). */
async function loadGun(url: string): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const out = new THREE.Group();
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.geometry;
    const pos = src.getAttribute('position');
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      arr[i * 3] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const uv = src.getAttribute('uv');
    if (uv) g.setAttribute('uv', uv);
    if (src.index) g.setIndex(src.index);
    g.computeVertexNormals();
    out.add(new THREE.Mesh(g, m.material));
  });
  return out;
}
const weaponDef: WeaponHoldDef = data.weapons[GUN_ID];
const gun = await loadGun(`/${weaponDef.model}`);
const hold = new RifleHold(rig, gun, weaponDef);
const gunSurface = new GunSurface(gun);

// Clips: the same skeleton's animations; socket tracks dropped (sockets are canonical data).
const clipsGltf = await new GLTFLoader().loadAsync(CLIPS_URL);
const socketNames = new Set(MASTER_BONES.filter((b) => b.socket).map((b) => b.name));
const clips = new Map<string, THREE.AnimationClip>();
for (const c of clipsGltf.animations) {
  c.tracks = c.tracks.filter((t) => !socketNames.has(t.name.split('.')[0]) && !t.name.endsWith('.scale'));
  clips.set(c.name, c);
}
/**
 * A clip mirrored left ↔ right (lab preview of a clip fix): every track moves to its twin bone,
 * local rotations (x, y, z, w) → (x, −y, −z, w), local positions (x, y, z) → (−x, y, z).
 */
function mirrorClip(c: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const tracks = c.tracks.map((t) => {
    const dot = t.name.lastIndexOf('.');
    const prop = t.name.slice(dot + 1);
    const values = t.values.slice();
    if (prop === 'quaternion') for (let i = 0; i < values.length; i += 4) [values[i + 1], values[i + 2]] = [-values[i + 1], -values[i + 2]];
    if (prop === 'position') for (let i = 0; i < values.length; i += 3) values[i] = -values[i];
    const Track = t.constructor as new (n: string, times: ArrayLike<number>, values: ArrayLike<number>) => THREE.KeyframeTrack;
    return new Track(`${mirrorName(t.name.slice(0, dot))}.${prop}`, t.times.slice(), values);
  });
  return new THREE.AnimationClip(name, c.duration, tracks);
}
if (clips.has('aim')) clips.set('aim-mirrored', mirrorClip(clips.get('aim')!, 'aim-mirrored'));
const mixer = new THREE.AnimationMixer(rig.model);
const actions = new Map([...clips].map(([n, c]) => [n, mixer.clipAction(c)]));
let active: THREE.AnimationAction | null = null;

// Probes for the checks: chosen on the rest pose, before anything moves.
const probes = makeProbes(rig);

// --- Helpers -----------------------------------------------------------------------------------
const skeletonHelper = new THREE.SkeletonHelper(rig.model);
(skeletonHelper.material as THREE.LineBasicMaterial).depthTest = false;
skeletonHelper.renderOrder = 10;
skeletonHelper.visible = false;
scene.add(skeletonHelper);
const HIGHLIGHT = /^(Hand|Forearm|UpperArm)_[RL]$/;
const axes: THREE.AxesHelper[] = [];
for (const b of MASTER_BONES) {
  const bone = rig.bone(b.name);
  const big = HIGHLIGHT.test(b.name);
  const a = new THREE.AxesHelper(big ? 0.09 : 0.025);
  (a.material as THREE.LineBasicMaterial).depthTest = false;
  a.renderOrder = 11;
  a.visible = false;
  a.userData.big = big;
  bone.add(a);
  axes.push(a);
}
const markers = new THREE.Group();
markers.visible = false;
scene.add(markers);
const dot = (color: number, r = 0.012) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.renderOrder = 12;
  markers.add(m);
  return m;
};
const lineObj = (color: number, n: number) => {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
  l.renderOrder = 12;
  l.frustumCulled = false;
  markers.add(l);
  return l;
};
const mk = Object.fromEntries(
  SIDES.map((s) => [s, { pole: dot(0xffd040), elbow: dot(0xff6040, 0.01), target: dot(0x40ff80, 0.008), chain: lineObj(0xffffff, 3), poleLine: lineObj(0xffd040, 2) }]),
) as unknown as Record<Side, { pole: THREE.Mesh; elbow: THREE.Mesh; target: THREE.Mesh; chain: THREE.Line; poleLine: THREE.Line }>;
const desiredAxes = new THREE.AxesHelper(0.15);
(desiredAxes.material as THREE.LineBasicMaterial).depthTest = false;
desiredAxes.matrixAutoUpdate = false;
markers.add(desiredAxes);
const gripAxes = new THREE.AxesHelper(0.06);
(gripAxes.material as THREE.LineBasicMaterial).depthTest = false;
hold.leftGrip.add(gripAxes);
gripAxes.visible = false;
const socketAxes = new THREE.AxesHelper(0.06);
(socketAxes.material as THREE.LineBasicMaterial).depthTest = false;
rig.arms.R.socket.add(socketAxes);
socketAxes.visible = false;

function updateMarkers(): void {
  if (!markers.visible) return;
  const st = MODES[state.mode].stance;
  for (const s of SIDES) {
    const m = mk[s];
    const ik = hold.ik[s];
    m.pole.visible = m.elbow.visible = m.target.visible = m.chain.visible = m.poleLine.visible = !!st;
    if (!st) continue;
    m.pole.position.copy(hold.poles[s]);
    m.elbow.position.copy(ik.elbow);
    m.target.position.setFromMatrixPosition(hold.targets[s]);
    const p = m.chain.geometry.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, ik.shoulder.x, ik.shoulder.y, ik.shoulder.z);
    p.setXYZ(1, ik.elbow.x, ik.elbow.y, ik.elbow.z);
    p.setXYZ(2, ik.wrist.x, ik.wrist.y, ik.wrist.z);
    p.needsUpdate = true;
    const pl = m.poleLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    pl.setXYZ(0, ik.elbow.x, ik.elbow.y, ik.elbow.z);
    pl.setXYZ(1, hold.poles[s].x, hold.poles[s].y, hold.poles[s].z);
    pl.needsUpdate = true;
  }
  desiredAxes.matrix.copy(hold.desired);
  desiredAxes.visible = !!st;
}

// --- Posing ------------------------------------------------------------------------------------
const state = {
  mode: q.get('mode') && MODES[q.get('mode')!] ? q.get('mode')! : 'rifle-aim',
  time: 0,
  yawDeg: 0,
  timeScale: 1,
  paused: false,
  skeleton: false,
  axes: false,
  markers: false,
  gun: true,
  bodyOpacity: 1,
  wireframe: false,
  aimPitch: 0,
};

/** Pose `name` at clip time `t` (s) and world yaw `yaw` (rad): animation, then the hold. */
function pose(name: string, t: number, yaw: number): void {
  const def = MODES[name];
  const action = actions.get(def.clip);
  if (!action) throw new Error(`no clip ${def.clip} (clips: ${[...clips.keys()].join(', ')})`);
  if (active !== action) {
    mixer.stopAllAction();
    action.play();
    active = action;
  }
  character.rotation.y = yaw;
  // The hold's turns undone first: the mixer only writes keys whose value changed.
  hold.restore();
  mixer.setTime(t);
  character.updateMatrixWorld(true);
  hold.weapon.visible = !!def.stance && state.gun;
  if (def.stance) {
    hold.stance = def.stance;
    hold.aimPitch = state.aimPitch;
    hold.update();
  }
  scene.updateMatrixWorld(true);
}

const host: CheckHost = { rig, hold, pose, character };

// --- Views, shots ------------------------------------------------------------------------------
const VIEW_ANGLE: Record<string, number> = { front: 0, three: -45, right: -90, rback: -135, back: 180, lback: 135, left: 90, threeL: 45 };
/** Camera at `name` around the character (its facing), `dist` m from the chest / the hands. */
function view(name = 'three', dist = 2.6): void {
  const chest = new THREE.Vector3().setFromMatrixPosition(rig.bone('Spine3').matrixWorld);
  const yaw = character.rotation.y;
  if (name === 'hands' || name === 'handsL' || name === 'handsUnder') {
    // Close up on the weapon's grip area.
    const at = new THREE.Vector3().setFromMatrixPosition(hold.weapon.visible ? hold.leftGrip.matrixWorld : rig.arms.R.hand.matrixWorld);
    const grip = new THREE.Vector3().setFromMatrixPosition(rig.arms.R.hand.matrixWorld);
    at.lerp(grip, 0.5);
    const a = THREE.MathUtils.degToRad(name === 'hands' ? -70 : name === 'handsL' ? 60 : -20) + yaw;
    orbit.target.copy(at);
    camera.position.set(at.x + Math.sin(a) * dist, at.y + (name === 'handsUnder' ? -dist * 0.6 : dist * 0.25), at.z + Math.cos(a) * dist);
  } else if (name === 'top') {
    orbit.target.copy(chest);
    camera.position.set(chest.x + Math.sin(yaw) * 0.01, chest.y + dist, chest.z + Math.cos(yaw) * 0.01);
  } else {
    const a = THREE.MathUtils.degToRad(VIEW_ANGLE[name] ?? 0) + yaw;
    orbit.target.set(chest.x, chest.y - 0.15, chest.z);
    camera.position.set(chest.x + Math.sin(a) * dist, chest.y + 0.05, chest.z + Math.cos(a) * dist);
  }
  camera.lookAt(orbit.target);
  orbit.update();
  render();
}

function render(): void {
  updateMarkers();
  renderer.render(scene, camera);
}

function shot(type = 'image/jpeg'): string {
  render();
  return renderer.domElement.toDataURL(type, 0.9);
}

interface SheetSpec {
  mode?: string;
  view?: string;
  dist?: number;
  t?: number;
  yaw?: number;
  label?: string;
}
/** Several views / modes tiled into one image (data URL). */
function sheet(specs: SheetSpec[], cols = 3, w = 640, h = 480): string {
  const rows = Math.ceil(specs.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * w;
  c.height = rows * h;
  const ctx = c.getContext('2d')!;
  const keep = { w: renderer.domElement.width, h: renderer.domElement.height, mode: state.mode, aspect: camera.aspect };
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  specs.forEach((s, i) => {
    if (s.mode) state.mode = s.mode;
    pose(state.mode, s.t ?? state.time, THREE.MathUtils.degToRad(s.yaw ?? state.yawDeg));
    view(s.view ?? 'three', s.dist ?? 2.6);
    ctx.drawImage(renderer.domElement, (i % cols) * w, Math.floor(i / cols) * h);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect((i % cols) * w, Math.floor(i / cols) * h, w, 20);
    ctx.fillStyle = '#fff';
    ctx.font = '13px monospace';
    ctx.fillText(s.label ?? `${state.mode} · ${s.view ?? 'three'} · yaw ${s.yaw ?? state.yawDeg}`, (i % cols) * w + 6, Math.floor(i / cols) * h + 14);
  });
  renderer.setSize(keep.w, keep.h, false);
  camera.aspect = keep.aspect;
  camera.updateProjectionMatrix();
  state.mode = keep.mode;
  pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
  return c.toDataURL('image/jpeg', 0.88);
}

/** POST a data URL to the dev server's frame sink (production/trailer/frames/<shot>/<i>.jpg). */
async function post(dataUrl: string, i: number, shotName = 'master_lab'): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const r = await fetch(`/__trailer/frame?shot=${shotName}&i=${i}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  return `${r.status} production/trailer/frames/${shotName}/${String(i).padStart(5, '0')}.${blob.type.includes('png') ? 'png' : 'jpg'}`;
}

/**
 * Six close-ups of one hand on the weapon (from its right, left, front, below, above, back-right),
 * tiled 3 × 2 into one data URL.
 */
async function closeups(side: Side = 'R', dist = 0.3): Promise<string> {
  const arm = rig.arms[side];
  const h = new THREE.Vector3().setFromMatrixPosition(arm.hand.matrixWorld).lerp(new THREE.Vector3().setFromMatrixPosition(arm.fingers[7].matrixWorld), 0.6);
  const yaw = character.rotation.y;
  const dirs = [[-1, 0.17, 0], [1, 0.17, 0], [0, 0.17, 1], [0, -1, 0.17], [0, 1, -0.17], [-0.7, 0, -0.7]];
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 720;
  const ctx = c.getContext('2d')!;
  for (let k = 0; k < dirs.length; k++) {
    const v = new THREE.Vector3(...dirs[k]).normalize().multiplyScalar(dist).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    orbit.target.copy(h);
    camera.position.copy(h).add(v);
    camera.lookAt(h);
    orbit.update();
    render();
    ctx.drawImage(renderer.domElement, (k % 3) * 640, Math.floor(k / 3) * 360, 640, 360);
  }
  return c.toDataURL('image/jpeg', 0.9);
}

// --- Checks ------------------------------------------------------------------------------------
const walkDur = clips.get('walk')?.duration ?? 1;
const CHECK_MODES: ModeSpec[] = [
  { name: 'rifle-idle', times: [0, 0.5, 1.0, 1.5] },
  { name: 'rifle-aim', times: [0] },
  {
    name: 'rifle-walk',
    times: Array.from({ length: 8 }, (_, i) => (i * walkDur) / 8),
    sequence: Array.from({ length: 65 }, (_, i) => ({ t: (i * walkDur) / 64, yaw: 0 })),
  },
  { name: 'rifle-crouch', times: [0] },
  {
    name: 'rifle-walk-aim',
    times: Array.from({ length: 4 }, (_, i) => (i * walkDur) / 4),
    sequence: Array.from({ length: 65 }, (_, i) => ({ t: (i * walkDur) / 64, yaw: 0 })),
  },
  { name: 'rifle-crouch-aim', times: [0] },
  {
    name: 'turn-360',
    times: [0],
    sequence: Array.from({ length: 181 }, (_, i) => ({ t: i / 60, yaw: THREE.MathUtils.degToRad(i * 2) })),
  },
];
let lastReport: CheckReport | null = null;

function checks(modes: string[] | null = null): CheckReport {
  const list = modes ? modes.map((n) => CHECK_MODES.find((m) => m.name === n) ?? { name: n, times: [0] }) : CHECK_MODES;
  const keep = { ...state };
  lastReport = runChecks(host, probes, gunSurface, list);
  Object.assign(state, keep);
  pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
  showReport(lastReport);
  return lastReport;
}

function showReport(r: CheckReport): void {
  const lines = r.rows.map((x) => `<span class="${x.pass ? 'ok' : 'bad'}">${x.pass ? 'PASS' : 'FAIL'}</span> ${x.check.padEnd(32)} worst ${String(x.worst).padStart(9)} ${x.unit.padEnd(5)} (${x.limit})  ${x.where}`);
  reportEl.innerHTML = `checks: ${r.samples} samples, ${r.ms} ms\n${lines.join('\n')}`;
  reportEl.style.display = 'block';
}

/** The numbers measured on one pose (the current one). */
function measureNow() {
  return measure(host, probes, gunSurface);
}

// --- Deriving the canonical socket / grip numbers --------------------------------------------
/**
 * RightHandWeaponSocket and LeftHandGripTarget from the first-person AK hold
 * (src/config/viewprofiles/ak47.json hands.handTargets: the glove's wrist frames in AK model space):
 *   - the master's hand frame = the glove's, moved along the hand so the master's knuckles land
 *     where the glove's are (the master's palm is longer: its wrist sits further back);
 *   - the first-person gun is drawn widened (x1.2 at the grip, x1.6 at the handguard): the right
 *     palm moves in by the grip's widening (2 mm), the left wrist's sideways offset is divided by 1.6;
 *   - socketLocal = (master hand frame)⁻¹ × (the pistol grip's frame), both in AK model space in metres.
 */
const GLOVE_KNUCKLES: Record<Side, Record<string, number[]>> = {
  R: { Index: [0.0342, 0.0755, 0.0052], Middle: [0, 0.0718, 0], Ring: [-0.0285, 0.0676, 0.0057], Pinky: [-0.0541, 0.0565, 0.0052] },
  L: { Index: [-0.0333, 0.0868, 0.0076], Middle: [0, 0.0755, 0], Ring: [0.0324, 0.0822, 0.0039], Pinky: [0.0558, 0.0608, 0.0076] },
};
function derive() {
  const S = weaponDef.scale;
  const h = ak47Profile.hands.handTargets;
  const r4 = (a: number[], d = 5) => a.map((x) => +x.toFixed(d));
  const frames = {} as Record<Side, THREE.Matrix4>;
  const out: Record<string, unknown> = {};
  for (const s of SIDES) {
    const knuckle = new THREE.Vector3();
    for (const k of Object.keys(GLOVE_KNUCKLES[s])) {
      const m = rig.bone(`${k}1_${s}`).position;
      knuckle.add(new THREE.Vector3().fromArray(GLOVE_KNUCKLES[s][k]).sub(m));
    }
    knuckle.multiplyScalar(1 / 4);
    const p = new THREE.Vector3().fromArray(s === 'R' ? h.rightPosition : h.leftPosition).multiplyScalar(S);
    if (s === 'R') p.z -= 0.002;
    else p.z /= 1.6;
    const qq = new THREE.Quaternion().fromArray(s === 'R' ? h.rightQuaternion : h.leftQuaternion).normalize();
    frames[s] = new THREE.Matrix4().compose(p, qq, new THREE.Vector3(1, 1, 1)).multiply(new THREE.Matrix4().makeTranslation(knuckle));
    out[`knuckleShift_${s}`] = r4(knuckle.toArray(), 4);
  }
  const grip = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(weaponDef.rightGrip.position).multiplyScalar(S), new THREE.Quaternion().fromArray(weaponDef.rightGrip.quaternion).normalize(), new THREE.Vector3(1, 1, 1));
  const sock = frames.R.clone().invert().multiply(grip);
  const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
  sock.decompose(sp, sq, ss);
  out.RightHandWeaponSocket = { position: r4(sp.toArray(), 4), quaternion: r4(sq.toArray()) };
  frames.L.decompose(sp, sq, ss);
  out.leftGrip = { position: r4(sp.divideScalar(S).toArray(), 2), quaternion: r4(sq.toArray()) };
  return out;
}

// --- Tuning helpers (stance data is live: edit __ml.data, then look) --------------------------
/** The IK numbers of `mode` at yaw 0, t (after `patch` is merged into its stance's data). */
function ikAt(mode: string, patch: Record<string, unknown> = {}, t = 0) {
  const st = MODES[mode].stance;
  if (st) Object.assign(data.stances[st], patch);
  pose(mode, t, 0);
  const f = (s: Side) => {
    const x = hold.ik[s].stats;
    return { reach: +x.reach.toFixed(3), flex: +x.flexDeg.toFixed(1), bend: +x.wristBendDeg.toFixed(1), twist: +x.handTwistDeg.toFixed(1), clav: +x.clavicleDeg.toFixed(1), short: +(x.shortM * 1000).toFixed(0) };
  };
  return { R: f('R'), L: f('L') };
}

/**
 * Sweep one elbow's pole round the shoulder → wrist line (`step` deg; 0 = straight down): wrist
 * bend, hand roll and the elbow (relative to the shoulder, character space) for each; the stance's
 * pole is left as it was. `poleAt` gives the chest-space pole point for an angle.
 */
function poleSweep(mode: string, side: Side, step = 15, t = 0) {
  const stName = MODES[mode].stance!;
  const st = data.stances[stName];
  const key = side === 'R' ? 'right' : 'left';
  const keep = st.poles[key].slice();
  const at = (deg: number): number[] => {
    pose(mode, t, 0);
    const ik = hold.ik[side];
    const S = ik.shoulder.clone();
    const dir = ik.wrist.clone().sub(S).normalize();
    const u = new THREE.Vector3(0, -1, 0).addScaledVector(dir, dir.y).normalize();
    const v = new THREE.Vector3().crossVectors(dir, u);
    const r = THREE.MathUtils.degToRad(deg);
    const P = S.addScaledVector(u, 0.5 * Math.cos(r)).addScaledVector(v, 0.5 * Math.sin(r)).addScaledVector(dir, 0.15);
    return P.applyMatrix4(new THREE.Matrix4().copy(rig.bone('Spine3').matrixWorld).invert()).toArray().map((x) => +x.toFixed(3));
  };
  const rows: { deg: number; bend: number; twist: number; elbow: number[]; pole: number[] }[] = [];
  for (let d = 0; d < 360; d += step) {
    const pole = at(d);
    st.poles[key] = pole;
    pose(mode, t, 0);
    const x = hold.ik[side].stats;
    const inv = new THREE.Matrix4().copy(character.matrixWorld).invert();
    const E = hold.ik[side].elbow.clone().applyMatrix4(inv).sub(hold.ik[side].shoulder.clone().applyMatrix4(inv));
    rows.push({ deg: d, bend: +x.wristBendDeg.toFixed(1), twist: +x.handTwistDeg.toFixed(1), elbow: E.toArray().map((v) => +v.toFixed(2)), pole });
  }
  st.poles[key] = keep;
  pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
  return rows;
}

// --- GUI, loop ---------------------------------------------------------------------------------
const gui = new GUI({ title: 'Master rig lab' });
gui.add(state, 'mode', Object.keys(MODES)).onChange(() => (state.time = 0));
gui.add(state, 'yawDeg', 0, 360, 1).name('world yaw (deg)').listen();
gui.add(state, 'timeScale', 0.02, 1, 0.01).name('slow motion');
gui.add(state, 'paused');
gui.add(state, 'aimPitch', -45, 45, 1).name('aim pitch (deg)');
gui.add(state, 'skeleton').onChange((v: boolean) => (skeletonHelper.visible = v));
gui.add(state, 'axes').name('bone axes').onChange((v: boolean) => {
  for (const a of axes) a.visible = v;
  gripAxes.visible = socketAxes.visible = v;
});
gui.add(state, 'markers').name('IK markers').onChange((v: boolean) => (markers.visible = v));
gui.add(state, 'gun');
gui.add(state, 'bodyOpacity', 0.15, 1, 0.05).name('body opacity').onChange(setBodyLook);
gui.add(state, 'wireframe').onChange(setBodyLook);
gui.add({ run: () => checks() }, 'run').name('run checks');
gui.add({ hide: () => (reportEl.style.display = 'none') }, 'hide').name('hide report');
for (const v of ['front', 'three', 'right', 'back', 'left', 'hands', 'handsL']) gui.add({ [v]: () => view(v, v.startsWith('hands') ? 0.6 : 2.6) }, v).name(`view ${v}`);

function setBodyLook(): void {
  for (const m of ([] as THREE.Material[]).concat(rig.mesh.material)) {
    const mt = m as THREE.MeshStandardMaterial;
    mt.transparent = state.bodyOpacity < 1;
    mt.opacity = state.bodyOpacity;
    mt.depthWrite = state.bodyOpacity >= 1;
    mt.wireframe = state.wireframe;
    mt.needsUpdate = true;
  }
}

function step(n = 1, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) advance(dt);
  render();
}

function advance(dt: number): void {
  const def = MODES[state.mode];
  state.time += dt * state.timeScale;
  if (def.turn) state.yawDeg = (state.yawDeg + THREE.MathUtils.radToDeg(TURN_SPEED * dt * state.timeScale)) % 360;
  pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
}

const timer = new THREE.Timer();
renderer.setAnimationLoop((now: number) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (!state.paused) advance(dt);
  orbit.update();
  render();
  const st = MODES[state.mode].stance;
  const ik = (s: Side) => {
    const x = hold.ik[s].stats;
    const tw = hold.twist.stats[s];
    return `${s}: reach ${(x.reach * 100).toFixed(0)}% short ${(x.shortM * 1000).toFixed(0)} mm, clavicle ${x.clavicleDeg.toFixed(0)}°, elbow ${x.flexDeg.toFixed(0)}°, wrist ${x.wristBendDeg.toFixed(0)}°, roll ${tw.handTwistDeg.toFixed(0)}° (twist bone ${tw.foreTwistDeg.toFixed(0)}°), upper roll ${tw.upperTwistDeg.toFixed(0)}°`;
  };
  hud.textContent = `${state.mode}  t=${state.time.toFixed(2)}  yaw=${state.yawDeg.toFixed(0)}°  x${state.timeScale}\n` + (st ? `${ik('R')}\n${ik('L')}` : '(no rifle: the clip as authored)');
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

pose(state.mode, 0, 0);
view('three');

declare global {
  interface Window {
    __ml: unknown;
  }
}
window.__ml = {
  set: (mode: string, opts: { t?: number; yaw?: number; paused?: boolean } = {}) => {
    if (!MODES[mode]) throw new Error(`modes: ${Object.keys(MODES).join(', ')}`);
    state.mode = mode;
    state.time = opts.t ?? 0;
    if (opts.yaw !== undefined) state.yawDeg = opts.yaw;
    if (opts.paused !== undefined) state.paused = opts.paused;
    pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
    render();
    return state;
  },
  view,
  step,
  shot,
  sheet,
  post,
  checks,
  derive,
  measure: measureNow,
  state: () => ({ ...state, ik: { R: { ...hold.ik.R.stats }, L: { ...hold.ik.L.stats } }, twist: hold.twist.stats, report: rig.report }),
  toggle: (what: 'skeleton' | 'axes' | 'markers' | 'gun', v: boolean) => {
    state[what] = v;
    if (what === 'skeleton') skeletonHelper.visible = v;
    if (what === 'axes') {
      for (const a of axes) a.visible = v;
      gripAxes.visible = socketAxes.visible = v;
    }
    if (what === 'markers') markers.visible = v;
    pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
    render();
  },
  opacity: (v: number) => {
    state.bodyOpacity = v;
    setBodyLook();
    render();
  },
  last: () => lastReport,
  ik: ikAt,
  closeups,
  /** Fit a thumb's correction onto the weapon (live data; copy the printed numbers into masterRig.json). */
  fitThumb: (side: Side, iterations = 300) => {
    const poseName = side === 'R' ? weaponDef.fingers.right : weaponDef.fingers.left;
    const r = fitThumb(rig, hold, gunSurface, side, poseName, () => pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg)), iterations);
    render();
    return r;
  },
  poleSweep,
  /** Fit a hand on the weapon (pose a rifle mode first); `apply` writes the result into the live data. */
  fit: (side: Side, opts: FitOptions & { armModes?: string[]; twistMax?: number; bendMax?: number; armWeight?: number } = {}, apply = true) => {
    pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
    // The left hand's frame also shapes its arm: judge the forearm's roll and the wrist in these modes.
    if (side === 'L' && opts.armModes?.length) {
      const keep = { position: hold.def.leftGrip.position.slice(), quaternion: hold.def.leftGrip.quaternion.slice() };
      const p = new THREE.Vector3(), qq = new THREE.Quaternion(), sc = new THREE.Vector3();
      const twistMax = opts.twistMax ?? 80;
      const bendMax = opts.bendMax ?? 35;
      opts.extra = (H, terms) => {
        H.decompose(p, qq, sc);
        hold.def.leftGrip.position = p.clone().divideScalar(hold.def.scale).toArray();
        hold.def.leftGrip.quaternion = qq.toArray();
        hold.refresh();
        let c = 0;
        for (const m of opts.armModes!) {
          pose(m, 0, 0);
          const st = hold.ik.L.stats;
          terms[`twist.${m}`] = st.handTwistDeg;
          terms[`bend.${m}`] = st.wristBendDeg;
          const w = opts.armWeight ?? 0.05;
          c += w * Math.max(0, Math.abs(st.handTwistDeg) - twistMax) ** 2 + w * Math.max(0, st.wristBendDeg - bendMax) ** 2 + 2e7 * st.shortM ** 2;
        }
        hold.def.leftGrip.position = keep.position;
        hold.def.leftGrip.quaternion = keep.quaternion;
        hold.refresh();
        pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
        return c;
      };
    }
    const r = fitHand(rig, hold, probes, gunSurface, side, opts);
    if (apply) applyFit(rig, hold, r);
    pose(state.mode, state.time, THREE.MathUtils.degToRad(state.yawDeg));
    render();
    return r;
  },
  /** The canonical data object (live: edit, then set() again to see it; save by hand into masterRig.json). */
  data,
  rig,
  hold,
  scene,
  camera,
  renderer,
  orbit,
  THREE,
};
