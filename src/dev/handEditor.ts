import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Viewmodel } from '../weapons/Viewmodel';
import { FINGER_NAMES, copyPose, flatPose, gripRotation, type FingerName, type FingerPose, type HandGripDef, type HandPose, type WeaponHands } from '../weapons/HandPose';
import { handConfig } from '../weapons/FirstPersonHands';
import { WeaponSurface, fingerGaps, fitFingers, gloveInside } from './handChecks';

/**
 * The calibration page's hands: where each hand holds the weapon (RightHandGrip /
 * LeftHandGrip: position and rotation), every finger joint of every pose (grip, trigger
 * safe / ready / pull, magazine, bolt), previews of each hand state, fitting the fingers to
 * the weapon, and saving it all: into the weapon's view profile, or for a procedural gun
 * into src/config/gunhands.json. Every change shows at once.
 */
export interface HandEditorHost {
  vm: Viewmodel;
  /** The hands being edited (a view profile's, or a procedural gun's); null: none yet. */
  hands: () => WeaponHands | null;
  /** Definition space (a model file's own, or the rig's) → weapon space. */
  toWeapon: () => THREE.Matrix4;
  /** Give the weapon hands to start from. */
  seed: () => void;
  /** Show the edited hands on the weapon. */
  apply: () => void;
  save: () => Promise<void>;
  /** Where saving writes (shown on the button). */
  target: string;
  toast: (text: string, bad?: boolean) => void;
}

/** What the page shows: a hand state held still, or the weapon's own animation scrubbed. */
export const handView = {
  state: 'auto' as 'auto' | 'safe' | 'ready' | 'pull' | 'open',
  /** Scrub an animation: magazine (tactical / empty), bolt cycle, shell reload phases. */
  scrub: 'none' as 'none' | 'tactical' | 'empty' | 'bolt' | 'shellStart' | 'shellInsert' | 'shellEnd',
  t: 0.3,
};

/** Tuple slots as lil-gui property names. */
const IDX = ['0', '1', '2'] as const;

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
const FINGER_LABELS: Record<string, FingerName> = { 'Başparmak': 'thumb', 'İşaret': 'index', 'Orta': 'middle', 'Yüzük': 'ring', 'Serçe': 'pinky' };

/**
 * Default hands for a weapon that has none: the grips at `right` / `left` (definition space;
 * default: about where a rifle's are, through `toDef` from weapon space); the turns, finger
 * poses and trigger finger of a weapon that has hands (`template`, e.g. the AK-47's), else
 * open fingers. Then place the grips, fit the fingers, save.
 */
export function seedHands(toDef: THREE.Matrix4, template?: Readonly<WeaponHands>, right?: THREE.Vector3, left?: THREE.Vector3): WeaponHands {
  const c = handConfig();
  const pose = () => copyPose(c.open, flatPose());
  const finger = (): FingerPose => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const def = (v: THREE.Vector3) => v.clone().applyMatrix4(toDef).toArray().map((x) => +x.toFixed(4)) as [number, number, number];
  const hands: WeaponHands = {
    rightGrip: { position: def(right ?? new THREE.Vector3(0, -0.05, 0.02)), rotation: gripRotation(new THREE.Vector3(0, -0.36, -0.93), new THREE.Vector3(-1, 0, 0)) },
    leftGrip: { position: def(left ?? new THREE.Vector3(0, -0.02, -0.3)), rotation: gripRotation(new THREE.Vector3(1, 0.15, 0), new THREE.Vector3(0, 1, 0)) },
    rightPose: pose(),
    leftPose: pose(),
    trigger: { safe: finger(), ready: finger(), pull: finger() },
  };
  if (template) {
    const t = structuredClone(template) as WeaponHands;
    hands.rightGrip.rotation = t.rightGrip.rotation;
    hands.leftGrip.rotation = t.leftGrip.rotation;
    hands.rightPose = t.rightPose;
    hands.leftPose = t.leftPose;
    hands.trigger = t.trigger;
  }
  return hands;
}

export function handFolder(gui: GUI, host: HandEditorHost): void {
  const root = gui.addFolder('Eller (kavrama)').close();
  const h = host.hands();
  if (!h) {
    root.add({ seed: () => (host.seed(), host.toast('Eller eklendi: kabzaları yerleştir, parmakları oturt, kaydet')) }, 'seed').name('Bu silaha eller ekle');
    return;
  }
  const vm = host.vm;
  const preview = () => {
    const s = handView.state;
    vm.arms.preview =
      s === 'auto' ? {} : s === 'open' ? { action: 'open', instant: true } : { action: 'grip', trigger: s === 'safe' ? 0 : 1, pull: s === 'pull' ? 1 : 0, instant: true };
  };
  root
    .add(handView, 'state', { 'Oyundaki gibi': 'auto', 'Kabzada, tetik güvenli': 'safe', 'Kabzada, tetik hazır': 'ready', 'Tetik basılı': 'pull', 'Açık el': 'open' })
    .name('El durumu')
    .onChange(preview);
  root
    .add(handView, 'scrub', { 'Yok': 'none', 'Şarjör (taktik)': 'tactical', 'Şarjör (boş)': 'empty', 'Sürgü çekme': 'bolt', 'Mermi: sürgü açılır': 'shellStart', 'Mermi: sürme': 'shellInsert', 'Mermi: sürgü kapanır': 'shellEnd' })
    .name('Animasyonu durdur');
  root.add(handView, 't', 0, 1, 0.005).name('animasyon anı');
  root.add(vm.arms, 'showGizmos').name('Kabza gizmoları (mavi ileri, yeşil yukarı)');
  preview();

  const O = () => host.toWeapon();
  const gripFolder = (label: string, def: HandGripDef) => {
    const f = root.addFolder(label).close();
    const w = new THREE.Vector3(...def.position).applyMatrix4(O());
    const o = { x: +(w.x * 1000).toFixed(1), y: +(w.y * 1000).toFixed(1), z: +(w.z * 1000).toFixed(1) };
    const set = () => {
      const m = new THREE.Vector3(o.x / 1000, o.y / 1000, o.z / 1000).applyMatrix4(O().invert());
      def.position = m.toArray().map((v) => +v.toFixed(4)) as [number, number, number];
      host.apply();
    };
    for (const a of ['x', 'y', 'z'] as const) f.add(o, a, -800, 800, 0.5).name(`${a} (mm, silah)`).onChange(set);
    const rot = ['eğim (pitch)', 'sapma (yaw)', 'yatma (roll)'];
    for (let i = 0; i < 3; i++) f.add(def.rotation, IDX[i], -180, 180, 0.5).name(`${rot[i]} °`).onChange(host.apply);
  };
  gripFolder('Sağ el — RightHandGrip', h.rightGrip);
  gripFolder('Sol el — LeftHandGrip', h.leftGrip);
  const turnFolder = (label: string, key: 'reload' | 'interaction') => {
    const f = root.addFolder(label).close();
    const d = h[key];
    if (!d) {
      f.add({ add: () => ((h[key] = structuredClone(handConfig()[key])), rebuild()) }, 'add').name('Bu silaha özel yap (varsayılandan)');
      return;
    }
    const rot = ['eğim (pitch)', 'sapma (yaw)', 'yatma (roll)'];
    for (let i = 0; i < 3; i++) f.add(d.rotation, IDX[i], -180, 180, 0.5).name(`el dönüşü ${rot[i]} °`);
  };
  turnFolder('Sol el şarjörde (dönüş)', 'reload');
  turnFolder('Sağ el sürgüde (dönüş)', 'interaction');

  // --- Fingers ---
  const sel = { pose: 'rightPose' as PoseKey, finger: 'middle' as FingerName };
  const fingers = root.addFolder('Parmaklar');
  const poseOf = (k: PoseKey): { side: 'right' | 'left'; pose: HandPose | null; finger?: FingerPose } => {
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
      preview();
    }
    const fp = finger ?? pose?.[sel.finger];
    if (!fp) {
      joints.add({ none: () => {} }, 'none').name('Bu poz bu silahta yok (üstten ekle)');
      return;
    }
    const names = ['kök', 'orta', 'uç'];
    for (let j = 0; j < 3; j++) {
      joints.add(fp[j], IDX[0], -40, 120, 0.5).name(`${names[j]}: kıvrılma`);
      joints.add(fp[j], IDX[1], -45, 45, 0.5).name(`${names[j]}: yana açılma`);
      joints.add(fp[j], IDX[2], -60, 60, 0.5).name(`${names[j]}: dönme`);
    }
  };
  fingers.add(sel, 'pose', POSE_LABELS).name('Poz').onChange(rebuild);
  fingers.add(sel, 'finger', FINGER_LABELS).name('Parmak (tetik pozlarında: işaret)').onChange(rebuild);
  const fit = (all: boolean) => {
    const { side, pose, finger } = poseOf(sel.pose);
    const surf = new WeaponSurface(vm);
    if (finger) {
      // The trigger finger alone, its base as set: the rest closes onto the trigger.
      const tmp = copyPose(h.rightPose, flatPose());
      tmp.index = finger;
      fitFingers(vm, 'right', tmp, ['index'], surf, true);
    } else if (pose) {
      const list = all ? FINGER_NAMES.filter((f) => !(side === 'right' && f === 'index' && sel.pose === 'rightPose')) : [sel.finger];
      fitFingers(vm, side, pose, list, surf);
    }
    rebuild();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    host.toast('Parmaklar silaha değene kadar büküldü');
  };
  fingers.add({ one: () => fit(false) }, 'one').name('Bu parmağı silaha oturt');
  fingers.add({ all: () => fit(true) }, 'all').name('Tüm parmakları silaha oturt');
  rebuild();

  root.add({ save: () => host.save() }, 'save').name(`El pozunu kaydet (${host.target})`);
}

/** One line per hand for the info panel: wrist, grip weight, fingers' gaps, glove inside the weapon. */
export function handReport(vm: Viewmodel): string[] {
  if (!vm.arms.group.visible) return [];
  const surf = new WeaponSurface(vm);
  const out: string[] = [];
  for (const side of ['right', 'left'] as const) {
    const s = vm.arms.stats[side];
    const g = fingerGaps(vm, side, surf);
    const inside = gloveInside(vm, side, surf, 6);
    const gap = (f: FingerName) => Math.min(...g[f]) * 1000;
    const fingers = FINGER_NAMES.map((f) => `${f[0].toUpperCase()}${gap(f) < -2 ? '!' : ''}${gap(f).toFixed(0)}`).join(' ');
    out.push(
      `${side === 'right' ? 'Sağ' : 'Sol'} el  bilek ${s.wristBendDeg.toFixed(0)}° bükük, ${s.wristTwistDeg.toFixed(1)}° burulma, IK ${s.ik.toFixed(2)} (${s.action})${s.reachM > 0.001 ? `, kol yetişmiyor: üst kol ${(s.reachM * 100).toFixed(0)} cm uzadı` : ''}  ` +
        `parmak–silah mm: ${fingers}  silahın içinde ${inside.count}/${inside.checked} nokta, en derin ${inside.maxMm.toFixed(1)} mm`,
    );
  }
  return out;
}
