import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Viewmodel } from '../weapons/Viewmodel';
import { FINGER_NAMES, gripQuaternion, gripRotation, rotationOfGrip, type FingerName, type FingerPose, type HandGripDef, type HandPose, type WeaponHands } from '../weapons/HandPose';
import { handConfig } from '../weapons/FirstPersonHands';
import { FINGER_BONES, SIDES, boneName, fingerBoneIndex, type Side } from '../weapons/hands/ArmRig';
import { TRIGGER_POSES, formatPoseLibrary, gripPose, gripPoseNames, jointAngles, jointQuaternion, poseChanged, poseLibrary, toQ4, type Q4 } from '../weapons/hands/GripPoses';
import { BIG_CORRECTION_DEG, isV2, migrateHands, modelToWeaponPoint, modelToWeaponQuat, poseDegrees, weaponToModelPoint, weaponToModelQuat, type AnyWeaponHands, type PartHandDef, type WeaponHandsV2 } from '../weapons/hands/HandProfile';
import { orientationMatrix, viewProfile } from '../weapons/ViewProfile';
import { WeaponSurface, fingerGaps, fitFingers, gloveInside } from './handChecks';

type V3 = [number, number, number];

/**
 * The calibration page's hands (weapon-calibration.html → "Eller (kavrama)"). For a weapon on
 * the hand system (schema 2) the work is:
 *   1. RightHandTarget / LeftHandTarget: each wrist's place (mm, weapon space) and turn (deg
 *      from flat on top of the weapon; turning keeps the palm's centre in place by default),
 *      shown live with the debug axes;
 *   2. a grip pose per hand from the library, the trigger finger's three poses;
 *   3. optional small corrections, one finger bone at a time (warned past 20°);
 *   4. the support hand on the magazine / charging handle for reloads (scrub the animation);
 *   5. save (the weapon's view profile, or gunhands.json for a procedural gun).
 * Library poses can be edited here too (every weapon using one changes) and saved to
 * src/config/gripposes.json. A schema-1 weapon keeps its old editor, with a button that moves
 * it to schema 2.
 */
export interface HandEditorHost {
  vm: Viewmodel;
  /** The hands being edited (a view profile's, or a procedural gun's); null: none yet. */
  hands: () => AnyWeaponHands | null;
  /** Replace them (migrating). */
  setHands: (h: AnyWeaponHands) => void;
  /** Definition space (a model file's own, or the rig's) → weapon space. */
  toWeapon: () => THREE.Matrix4;
  /** Library poses for this weapon's kind (migrating, seeding). */
  defaultPoses: () => { right: string; left: string };
  /** Give the weapon hands to start from. */
  seed: () => void;
  /** Show the edited hands on the weapon. */
  apply: () => void;
  /** Rebuild the page's controls (after a change of schema). */
  rebuild: () => void;
  save: () => Promise<void>;
  /** Where saving writes (shown on the button). */
  target: string;
  toast: (text: string, bad?: boolean) => void;
}

/** What the page shows: a hand state held still, the weapon's own animation scrubbed, IK weights held. */
export const handView = {
  state: 'auto' as 'auto' | 'safe' | 'ready' | 'pull' | 'open',
  /** Scrub an animation: magazine (tactical / empty), bolt cycle, shell reload phases. */
  scrub: 'none' as 'none' | 'tactical' | 'empty' | 'bolt' | 'shellStart' | 'shellInsert' | 'shellEnd',
  t: 0.3,
  /** IK weights: as the game sets them, or held at these. */
  ik: 'auto' as 'auto' | 'manual',
  ikRight: 1,
  ikLeft: 1,
  /** Turning a target: about the palm's centre (the grip stays put) or about the wrist. */
  pivot: 'palm' as 'palm' | 'wrist',
};

/** Tuple slots as lil-gui property names. */
const IDX = ['0', '1', '2'] as const;
const ROT = ['eğim (pitch)', 'sapma (yaw)', 'yatma (roll)'];
const FINGER_LABELS: Record<string, FingerName> = { 'Başparmak': 'thumb', 'İşaret': 'index', 'Orta': 'middle', 'Yüzük': 'ring', 'Serçe': 'pinky' };
const round = (v: number, d = 1) => +v.toFixed(d) + 0;
/** The glove's palm centre in hand space (the pivot for turning a target about the palm). */
const palmCentre = () => new THREE.Vector3(...handConfig().legacy.palmGrip);

function applyPreview(vm: Viewmodel): void {
  const s = handView.state;
  const p: Viewmodel['arms']['preview'] =
    s === 'auto' ? {} : s === 'open' ? { action: 'open', instant: true } : { action: 'grip', trigger: s === 'safe' ? 0 : 1, pull: s === 'pull' ? 1 : 0, instant: true };
  if (handView.ik === 'manual') p.ik = { right: handView.ikRight, left: handView.ikLeft };
  vm.arms.preview = p;
}

/** The reference weapon's hand turns (weapon space): the AK-47's when it is on schema 2. */
function referenceTurns(): { right: THREE.Quaternion; left: THREE.Quaternion } | null {
  const ak = viewProfile('ak47');
  if (!ak?.hands || !isV2(ak.hands)) return null;
  const O = orientationMatrix(ak, new THREE.Matrix4());
  const t = ak.hands.handTargets;
  return { right: modelToWeaponQuat(t.rightQuaternion, O, new THREE.Quaternion()), left: modelToWeaponQuat(t.leftQuaternion, O, new THREE.Quaternion()) };
}

/**
 * Hands for a weapon that has none (schema 2): the palms at `at` (weapon space; default about
 * where a rifle's are), the wrists turned like the reference weapon's (else a generic rifle
 * hold), the library poses for its kind. Then place the targets, check, save.
 */
export function seedHands(toWeapon: THREE.Matrix4, poses: { right: string; left: string }, at?: { right: THREE.Vector3; left: THREE.Vector3 }): WeaponHandsV2 {
  const ref = referenceTurns();
  const qr = ref?.right ?? gripQuaternion(gripRotation(new THREE.Vector3(0, -0.36, -0.93), new THREE.Vector3(-1, 0, 0)), new THREE.Quaternion());
  const ql = ref?.left ?? gripQuaternion(gripRotation(new THREE.Vector3(1, 0.15, 0), new THREE.Vector3(0, 1, 0)), new THREE.Quaternion());
  const palm = palmCentre();
  const wrist = (p: THREE.Vector3, q: THREE.Quaternion) => p.clone().sub(palm.clone().applyQuaternion(q));
  const r = wrist(at?.right ?? new THREE.Vector3(0, -0.05, 0.02), qr);
  const l = wrist(at?.left ?? new THREE.Vector3(0, -0.02, -0.3), ql);
  return {
    handTargets: {
      rightPosition: weaponToModelPoint(r, toWeapon),
      rightQuaternion: weaponToModelQuat(qr, toWeapon),
      leftPosition: weaponToModelPoint(l, toWeapon),
      leftQuaternion: weaponToModelQuat(ql, toWeapon),
    },
    gripPoses: { ...poses },
  };
}

export function handFolder(gui: GUI, host: HandEditorHost): void {
  const root = gui.addFolder('Eller (kavrama)').close();
  const h = host.hands();
  if (!h) {
    root.add({ seed: () => (host.seed(), host.toast('Eller eklendi: hedefleri yerleştir, pozları seç, kaydet')) }, 'seed').name('Bu silaha eller ekle');
    return;
  }
  const vm = host.vm;
  root
    .add(handView, 'state', { 'Oyundaki gibi': 'auto', 'Kabzada, tetik güvenli': 'safe', 'Kabzada, tetik hazır': 'ready', 'Tetik basılı': 'pull', 'Açık el': 'open' })
    .name('El durumu')
    .onChange(() => applyPreview(vm));
  root
    .add(handView, 'scrub', { 'Yok': 'none', 'Şarjör (taktik)': 'tactical', 'Şarjör (boş)': 'empty', 'Sürgü çekme': 'bolt', 'Mermi: sürgü açılır': 'shellStart', 'Mermi: sürme': 'shellInsert', 'Mermi: sürgü kapanır': 'shellEnd' })
    .name('Animasyonu durdur');
  root.add(handView, 't', 0, 1, 0.005).name('animasyon anı');
  const ik = root.addFolder('IK ağırlığı (önizleme)').close();
  ik.add(handView, 'ik', { 'Oyundaki gibi': 'auto', 'Elle': 'manual' }).name('kaynak').onChange(() => applyPreview(vm));
  ik.add(handView, 'ikRight', 0, 1, 0.01).name('sağ el (1: silahta)').onChange(() => applyPreview(vm));
  ik.add(handView, 'ikLeft', 0, 1, 0.01).name('sol el (1: silahta)').onChange(() => applyPreview(vm));
  const dbg = root.addFolder('Yardımcı çizimler').close();
  const d = vm.arms.debug;
  dbg.add(d, 'enabled').name('açık');
  dbg.add(d, 'targets').name('hedef eksenleri (X kırmızı, Y yeşil: parmaklar, Z mavi: avuç)');
  dbg.add(d, 'elbows').name('dirsek yönleri (turuncu tercih, mor çözüm)');
  dbg.add(d, 'directions').name('el yönleri (camgöbeği ileri, sarı el sırtı)');
  dbg.add(d, 'skeleton').name('iskelet');
  applyPreview(vm);
  if (isV2(h)) v2Controls(root, host, h);
  else v1Controls(root, host, h);
}

// --- Schema 2 --------------------------------------------------------------------------------

interface WristDef {
  position: V3;
  quaternion: Q4;
}

/** A wrist target's controls: mm in weapon space, turn in degrees from flat on top of the weapon. */
function wristFolder(parent: GUI, label: string, host: HandEditorHost, get: () => WristDef, set: (d: WristDef) => void): GUI {
  const f = parent.addFolder(label).close();
  const O = () => host.toWeapon();
  const o = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  const load = () => {
    const d = get();
    const w = modelToWeaponPoint(d.position, O(), new THREE.Vector3());
    const r = rotationOfGrip(modelToWeaponQuat(d.quaternion, O(), new THREE.Quaternion()));
    o.x = round(w.x * 1000);
    o.y = round(w.y * 1000);
    o.z = round(w.z * 1000);
    [o.pitch, o.yaw, o.roll] = r.map((v) => round(v, 2));
  };
  load();
  const move = () => {
    set({ position: weaponToModelPoint(new THREE.Vector3(o.x, o.y, o.z).multiplyScalar(0.001), O()), quaternion: get().quaternion });
    host.apply();
  };
  const turn = () => {
    const d = get();
    const qOld = modelToWeaponQuat(d.quaternion, O(), new THREE.Quaternion());
    const qNew = gripQuaternion([o.pitch, o.yaw, o.roll], new THREE.Quaternion());
    const w = modelToWeaponPoint(d.position, O(), new THREE.Vector3());
    if (handView.pivot === 'palm') {
      // The palm's centre stays where it was: the wrist swings round it.
      const palm = palmCentre();
      w.add(palm.clone().applyQuaternion(qOld)).sub(palm.applyQuaternion(qNew));
      o.x = round(w.x * 1000);
      o.y = round(w.y * 1000);
      o.z = round(w.z * 1000);
      f.controllersRecursive().forEach((c) => c.updateDisplay());
    }
    set({ position: weaponToModelPoint(w, O()), quaternion: weaponToModelQuat(qNew, O()) });
    host.apply();
  };
  for (const a of ['x', 'y', 'z'] as const) f.add(o, a, -800, 800, 0.5).name(`${a} (mm, silah)`).onChange(move);
  (['pitch', 'yaw', 'roll'] as const).forEach((k, i) => f.add(o, k, -180, 180, 0.5).name(`${ROT[i]} °`).onChange(turn));
  return f;
}

function v2Controls(root: GUI, host: HandEditorHost, h: WeaponHandsV2): void {
  const t = h.handTargets;
  root.add(handView, 'pivot', { 'avucun ortası (kavrama yerinde kalır)': 'palm', 'bilek': 'wrist' }).name('hedef dönüş merkezi');
  wristFolder(root, 'Sağ el hedefi — RightHandTarget (bilek)', host, () => ({ position: t.rightPosition, quaternion: t.rightQuaternion }), (d) => ((t.rightPosition = d.position), (t.rightQuaternion = d.quaternion)));
  wristFolder(root, 'Sol el hedefi — LeftHandTarget (bilek)', host, () => ({ position: t.leftPosition, quaternion: t.leftQuaternion }), (d) => ((t.leftPosition = d.position), (t.leftQuaternion = d.quaternion)));

  const names = gripPoseNames();
  const poses = root.addFolder('Kavrama pozları (kütüphaneden)');
  poses.add(h.gripPoses, 'right', names).name('sağ el').onChange(host.apply);
  poses.add(h.gripPoses, 'left', names).name('sol el').onChange(host.apply);
  const tp = { ...(h.triggerPose ?? TRIGGER_POSES) };
  const setTrigger = () => {
    if (tp.safe === TRIGGER_POSES.safe && tp.ready === TRIGGER_POSES.ready && tp.press === TRIGGER_POSES.press) delete h.triggerPose;
    else h.triggerPose = { ...tp };
    host.apply();
  };
  poses.add(tp, 'safe', names).name('tetik: güvenli (SAFE)').onChange(setTrigger);
  poses.add(tp, 'ready', names).name('tetik: hazır (READY)').onChange(setTrigger);
  poses.add(tp, 'press', names).name('tetik: basılı (PRESS)').onChange(setTrigger);

  correctionsFolder(root, host, h);
  partFolder(root, host, h, 'magazine', 'Şarjör tutuşu — LeftHandMagazineTarget (şarjöre göre)', 'MagazineHold');
  partFolder(root, host, h, 'chargingHandle', 'Kurma kolu — LeftHandChargingHandleTarget (sürgüye göre)', 'ChargingHandle');
  libraryFolder(root, host, h);
  root.add({ save: () => host.save() }, 'save').name(`El ayarını kaydet (${host.target})`);
}

/** Small per-bone corrections on top of the grip poses. */
function correctionsFolder(root: GUI, host: HandEditorHost, h: WeaponHandsV2): void {
  const f = root.addFolder('Küçük düzeltmeler (parmak kemiği başına)').close();
  const keys = SIDES.flatMap((s) => FINGER_BONES.map((k) => boneName(s, k)));
  const sel = { bone: Object.keys(h.gripCorrections ?? {})[0] ?? 'RightThumb01' };
  const o = { curl: 0, spread: 0, twist: 0 };
  const info = { list: '' };
  const summary = () => {
    const c = h.gripCorrections ?? {};
    info.list =
      Object.entries(c)
        .map(([k, q]) => {
          const deg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q[3]))));
          return `${k} ${deg.toFixed(0)}°${deg > BIG_CORRECTION_DEG ? ' (çok büyük: pozu ya da hedefi değiştir)' : ''}`;
        })
        .join(', ') || 'yok';
  };
  const load = () => {
    const q4 = h.gripCorrections?.[sel.bone];
    [o.curl, o.spread, o.twist] = q4 ? jointAngles(new THREE.Quaternion(...q4)).map((v) => round(v, 1)) : [0, 0, 0];
    summary();
    f.controllersRecursive().forEach((c) => c.updateDisplay());
  };
  const commit = () => {
    const c = (h.gripCorrections ??= {});
    if (Math.abs(o.curl) + Math.abs(o.spread) + Math.abs(o.twist) < 0.05) delete c[sel.bone];
    else c[sel.bone] = toQ4(jointQuaternion(o.curl, o.spread, o.twist, new THREE.Quaternion()));
    if (!Object.keys(c).length) delete h.gripCorrections;
    summary();
    f.controllersRecursive().forEach((ct) => ct.updateDisplay());
    host.apply();
  };
  f.add(sel, 'bone', keys).name('kemik').onChange(load);
  f.add(o, 'curl', -30, 30, 0.5).name('kıvrılma °').onChange(commit);
  f.add(o, 'spread', -30, 30, 0.5).name('yana açılma °').onChange(commit);
  f.add(o, 'twist', -30, 30, 0.5).name('dönme °').onChange(commit);
  f.add({ clear: () => ((o.curl = o.spread = o.twist = 0), commit()) }, 'clear').name('Bu kemiğin düzeltmesini sil');
  f.add(info, 'list').name('düzeltmeler').disable();
  load();
}

/** The support hand on a moving part during reloads (a wrist target riding on it). */
function partFolder(root: GUI, host: HandEditorHost, h: WeaponHandsV2, key: 'magazine' | 'chargingHandle', label: string, pose: string): void {
  const f = root.addFolder(label).close();
  const def = h.reload?.[key];
  if (!def) {
    f.add({ add: () => addPartTarget(host, key) }, 'add').name('Ekle (eski tutuşun yerinden başlat)');
    return;
  }
  wristFolder(f, 'bilek (parça dururken)', host, () => def, (d) => ((def.position = d.position), (def.quaternion = d.quaternion)));
  const o = { pose: def.pose ?? pose };
  f.add(o, 'pose', gripPoseNames())
    .name('parmak pozu')
    .onChange((v: string) => {
      if (v === pose) delete def.pose;
      else def.pose = v;
      host.apply();
    });
  f.add({ remove: () => (delete h.reload![key], !Object.keys(h.reload!).length && delete h.reload, host.apply(), host.rebuild()) }, 'remove').name('Kaldır (eski el yoluna dön)');
}

/**
 * A part target from where the old hand path put the hand (the palm under the magazine / on
 * the charging handle, the old fixed turn), as a wrist relative to the part at rest.
 */
function startPart(host: HandEditorHost, h: WeaponHandsV2, key: 'magazine' | 'chargingHandle', pose: string): void {
  const rig = host.vm.activeRig!;
  const part = key === 'magazine' ? rig.mag : rig.bolt;
  if (!part) return host.toast('Bu silahta o parça yok', true);
  // The part's rest place (weapon space): a profiled rig's piece pivot, else where it is.
  const piece = rig.view?.pieces.find((p) => p.node === part);
  const O = host.toWeapon();
  const rest = piece && rig.view ? piece.pivot.clone().applyMatrix4(orientationMatrix(rig.view.profile, new THREE.Matrix4())) : part.position.clone();
  const c = handConfig().legacy;
  const palmAt = key === 'magazine' ? rest.clone().add(new THREE.Vector3(0, -0.07, -0.01)) : rest.clone().add(new THREE.Vector3(0.01, 0.03, 0));
  const q = gripQuaternion(key === 'magazine' ? c.reloadRotation : c.interactionRotation, new THREE.Quaternion());
  const wrist = palmAt.sub(palmCentre().applyQuaternion(q));
  const d: PartHandDef = { position: weaponToModelPoint(wrist, O), quaternion: weaponToModelQuat(q, O) };
  if (pose !== (key === 'magazine' ? 'MagazineHold' : 'ChargingHandle')) d.pose = pose;
  (h.reload ??= {})[key] = d;
}

/** Edit library poses (every weapon using a pose changes) and save gripposes.json. */
function libraryFolder(root: GUI, host: HandEditorHost, h: WeaponHandsV2): void {
  const f = root.addFolder('Poz kütüphanesi — gripposes.json (TÜM silahları etkiler)').close();
  const sel = { pose: h.gripPoses.left, finger: 'middle' as FingerName };
  const note = { text: '' };
  let joints: GUI | null = null;
  const rebuild = () => {
    joints?.destroy();
    const data = poseLibrary().poses[sel.pose];
    note.text = data?.note ?? '';
    joints = f.addFolder('Eklemler (kıvrılma / yana açılma / dönme °)');
    if (!data) return;
    gripPose(sel.pose); // resolved once, so edits reach the rigs using it
    const names = ['kök', 'orta', 'uç'];
    for (let j = 0; j < 3; j++) {
      const key = FINGER_BONES[fingerBoneIndex(sel.finger, j)];
      const q4 = data.bones[key];
      const o = { curl: 0, spread: 0, twist: 0 };
      [o.curl, o.spread, o.twist] = q4 ? jointAngles(new THREE.Quaternion(...q4)).map((v) => round(v, 1)) : [0, 0, 0];
      const commit = () => {
        data.bones[key] = toQ4(jointQuaternion(o.curl, o.spread, o.twist, new THREE.Quaternion()));
        poseChanged(sel.pose);
      };
      joints.add(o, 'curl', -40, 120, 0.5).name(`${names[j]}: kıvrılma`).onChange(commit);
      joints.add(o, 'spread', -45, 45, 0.5).name(`${names[j]}: yana açılma`).onChange(commit);
      joints.add(o, 'twist', -60, 60, 0.5).name(`${names[j]}: dönme`).onChange(commit);
    }
    f.controllersRecursive().forEach((c) => c.updateDisplay());
  };
  f.add(sel, 'pose', gripPoseNames()).name('poz').onChange(rebuild);
  f.add(sel, 'finger', FINGER_LABELS).name('parmak').onChange(rebuild);
  f.add(note, 'text').name('ne için').disable();
  f.add({ save: () => saveLibrary(host) }, 'save').name('Kütüphaneyi kaydet (src/config/gripposes.json)');
  rebuild();
}

export async function saveLibrary(host: Pick<HandEditorHost, 'toast'>): Promise<boolean> {
  const res = await fetch('/__tuning/save', { method: 'POST', body: JSON.stringify({ file: 'gripposes', text: formatPoseLibrary() }) });
  const j = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as { ok: boolean; file?: string; error?: string };
  host.toast(j.ok ? `Kaydedildi: ${j.file}` : `KAYDEDİLEMEDİ: ${j.error}`, !j.ok);
  return j.ok;
}

// --- Schema 1 (weapons not moved over yet) ----------------------------------------------------

type PoseKey = 'rightPose' | 'leftPose' | 'safe' | 'ready' | 'pull' | 'reload' | 'interaction';
const POSE_LABELS: Record<string, PoseKey> = {
  'Sağ el — kabza': 'rightPose',
  'Sol el — kundak': 'leftPose',
  'Tetik parmağı — güvenli': 'safe',
  'Tetik parmağı — hazır': 'ready',
  'Tetik parmağı — basılı': 'pull',
  'Sol el — şarjörde': 'reload',
  'Sağ el — sürgüde': 'interaction',
};

/** The schema-1 hands as drawn (the grips where the rig has them: after widthAlong), for migrating. */
export function placedHands(host: HandEditorHost, h: WeaponHands): WeaponHands {
  const rig = host.vm.activeRig;
  if (!rig?.hands) return h;
  rig.root.updateMatrixWorld(true);
  const inv = rig.root.matrixWorld.clone().invert();
  const at = (n: THREE.Object3D) => weaponToModelPoint(n.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv), host.toWeapon());
  return { ...h, rightGrip: { ...h.rightGrip, position: at(rig.hands.right) }, leftGrip: { ...h.leftGrip, position: at(rig.hands.left) } };
}

/**
 * Move a schema-1 weapon to schema 2: the wrists stay where the old palms put them, the fingers
 * go onto the library poses for its kind (its own per-weapon poses are dropped).
 */
export function migrateToSchema2(host: HandEditorHost): boolean {
  const h = host.hands();
  if (!h || isV2(h)) return false;
  host.setHands(migrateHands(placedHands(host, h), host.toWeapon(), host.defaultPoses()));
  host.apply();
  host.rebuild();
  host.toast('Yeni sisteme taşındı: bilekler aynı yerde, parmaklar kütüphane pozlarında. Kontrol et, kaydet.');
  return true;
}

/** Give a schema-2 weapon its support hand on the magazine / charging handle (from the old path). */
export function addPartTarget(host: HandEditorHost, key: 'magazine' | 'chargingHandle'): boolean {
  const h = host.hands();
  if (!h || !isV2(h)) return false;
  startPart(host, h, key, key === 'magazine' ? 'MagazineHold' : 'ChargingHandle');
  host.apply();
  host.rebuild();
  return !!h.reload?.[key];
}

function v1Controls(root: GUI, host: HandEditorHost, h: WeaponHands): void {
  const vm = host.vm;
  root.add({ migrate: () => migrateToSchema2(host) }, 'migrate').name('Yeni sisteme taşı (bilek hedefleri + poz kütüphanesi)');
  const O = () => host.toWeapon();
  const gripFolder = (label: string, def: HandGripDef) => {
    const f = root.addFolder(label).close();
    const w = new THREE.Vector3(...def.position).applyMatrix4(O());
    const o = { x: +(w.x * 1000).toFixed(1), y: +(w.y * 1000).toFixed(1), z: +(w.z * 1000).toFixed(1) };
    const set = () => {
      const m = new THREE.Vector3(o.x / 1000, o.y / 1000, o.z / 1000).applyMatrix4(O().invert());
      def.position = m.toArray().map((v) => +v.toFixed(4)) as V3;
      host.apply();
    };
    for (const a of ['x', 'y', 'z'] as const) f.add(o, a, -800, 800, 0.5).name(`${a} (mm, silah)`).onChange(set);
    for (let i = 0; i < 3; i++) f.add(def.rotation, IDX[i], -180, 180, 0.5).name(`${ROT[i]} °`).onChange(host.apply);
  };
  gripFolder('Sağ el — RightHandTarget (avuç)', h.rightGrip);
  gripFolder('Sol el — LeftHandTarget (avuç)', h.leftGrip);
  const turnFolder = (label: string, key: 'reload' | 'interaction') => {
    const f = root.addFolder(label).close();
    const d = h[key];
    if (!d) {
      const c = handConfig().legacy;
      const pose = gripPose(key === 'reload' ? 'MagazineHold' : 'ChargingHandle');
      f.add({ add: () => ((h[key] = { rotation: [...(key === 'reload' ? c.reloadRotation : c.interactionRotation)] as V3, pose: pose ? poseDegrees(pose) : poseDegreesOpen() }), rebuild()) }, 'add').name('Bu silaha özel yap (varsayılandan)');
      return;
    }
    for (let i = 0; i < 3; i++) f.add(d.rotation, IDX[i], -180, 180, 0.5).name(`el dönüşü ${ROT[i]} °`).onChange(host.apply);
  };
  turnFolder('Sol el şarjörde (dönüş)', 'reload');
  turnFolder('Sağ el sürgüde (dönüş)', 'interaction');

  // --- Fingers ---
  const sel = { pose: 'rightPose' as PoseKey, finger: 'middle' as FingerName };
  const fingers = root.addFolder('Parmaklar');
  const poseOf = (k: PoseKey): { side: Side; pose: HandPose | null; finger?: FingerPose } => {
    switch (k) {
      case 'rightPose':
        return { side: 'right', pose: h.rightPose };
      case 'leftPose':
        return { side: 'left', pose: h.leftPose };
      case 'reload':
        return { side: 'left', pose: h.reload?.pose ?? null };
      case 'interaction':
        return { side: 'right', pose: h.interaction?.pose ?? null };
      default:
        return { side: 'right', pose: null, finger: h.trigger[k] };
    }
  };
  let joints: GUI | null = null;
  const rebuild = () => {
    joints?.destroy();
    joints = fingers.addFolder('Eklemler (kıvrılma / yana açılma / dönme °)');
    const { pose, finger } = poseOf(sel.pose);
    // A trigger pose is the index finger alone; show it on the hand.
    if (finger) {
      handView.state = sel.pose === 'safe' ? 'safe' : sel.pose === 'ready' ? 'ready' : 'pull';
      applyPreview(vm);
    }
    const fp = finger ?? pose?.[sel.finger];
    if (!fp) {
      joints.add({ none: () => {} }, 'none').name('Bu poz bu silahta yok (üstten ekle)');
      return;
    }
    const names = ['kök', 'orta', 'uç'];
    for (let j = 0; j < 3; j++) {
      joints.add(fp[j], IDX[0], -40, 120, 0.5).name(`${names[j]}: kıvrılma`).onChange(host.apply);
      joints.add(fp[j], IDX[1], -45, 45, 0.5).name(`${names[j]}: yana açılma`).onChange(host.apply);
      joints.add(fp[j], IDX[2], -60, 60, 0.5).name(`${names[j]}: dönme`).onChange(host.apply);
    }
  };
  fingers.add(sel, 'pose', POSE_LABELS).name('Poz').onChange(rebuild);
  fingers.add(sel, 'finger', FINGER_LABELS).name('Parmak (tetik pozlarında: işaret)').onChange(rebuild);
  const fit = (all: boolean) => {
    const { side, pose, finger } = poseOf(sel.pose);
    const surf = new WeaponSurface(vm);
    if (finger) {
      // The trigger finger alone, its base as set: the rest closes onto the trigger.
      const tmp = structuredClone(h.rightPose);
      tmp.index = finger;
      fitFingers(vm, 'right', tmp, ['index'], surf, true);
    } else if (pose) {
      const list = all ? FINGER_NAMES.filter((f) => !(side === 'right' && f === 'index' && sel.pose === 'rightPose')) : [sel.finger];
      fitFingers(vm, side, pose, list, surf);
    }
    host.apply();
    rebuild();
    root.controllersRecursive().forEach((c) => c.updateDisplay());
    host.toast('Parmaklar silaha değene kadar büküldü');
  };
  fingers.add({ one: () => fit(false) }, 'one').name('Bu parmağı silaha oturt');
  fingers.add({ all: () => fit(true) }, 'all').name('Tüm parmakları silaha oturt');
  rebuild();

  root.add({ save: () => host.save() }, 'save').name(`El pozunu kaydet (${host.target})`);
}

const poseDegreesOpen = (): HandPose => {
  const open = gripPose('OpenHand');
  if (open) return poseDegrees(open);
  const f = (): FingerPose => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  return { thumb: f(), index: f(), middle: f(), ring: f(), pinky: f() };
};

// --- Readout ---------------------------------------------------------------------------------

/** One line per hand for the info panel: wrist, target, IK, fingers' gaps, glove inside the weapon. */
export function handReport(vm: Viewmodel): string[] {
  if (!vm.arms.group.visible) return [];
  const surf = new WeaponSurface(vm);
  const out: string[] = [];
  for (const side of SIDES) {
    const s = vm.arms.stats[side];
    const g = fingerGaps(vm, side, surf);
    const inside = gloveInside(vm, side, surf, 6);
    const gap = (f: FingerName) => Math.min(...g[f]) * 1000;
    const fingers = FINGER_NAMES.map((f) => `${f[0].toUpperCase()}${gap(f) < -2 ? '!' : ''}${gap(f).toFixed(0)}`).join(' ');
    const target = s.targetErrMm >= 0 ? `hedefe ${s.targetErrMm.toFixed(2)} mm ${s.targetErrDeg.toFixed(2)}°` : 'animasyonda';
    out.push(
      `${side === 'right' ? 'Sağ el' : 'Sol el'}  bilek ${s.wristBendDeg.toFixed(0)}° bükük, IK ${s.ik.toFixed(2)} (${s.action}${side === 'right' ? `, ${s.trigger}` : ''}), ${target}${s.reachM > 0.001 ? `, kol yetişmiyor: üst kol ${(s.reachM * 100).toFixed(0)} cm uzadı` : ''}  ` +
        `parmak–silah mm: ${fingers}  silahın içinde ${inside.count}/${inside.checked} nokta, en derin ${inside.maxMm.toFixed(1)} mm`,
    );
  }
  return out;
}
