import * as THREE from 'three';
import type { HumanoidSkin, PartDef, PartName } from './Humanoid';
import { masterAssets } from '../characters/MasterAssets';
import { MasterCharacter } from '../characters/MasterCharacter';
import data from '../characters/master/masterRig.json';

type V3 = [number, number, number];

/** The master character id a soldier palette wears (masterRig.json game.people), or null. */
export function masterPerson(palette: string): string | null {
  return (data.game.people as Record<string, string | undefined>)[palette] ?? null;
}

/**
 * A Humanoid skin on the master humanoid (characters/MasterCharacter draws it): the parts' joints
 * are the master's own, in the pose the Humanoid's rest stands for (MasterAssets hang: arms and
 * legs straight down) at the game's height, with the master's anatomical sides ("R" is its right
 * arm, −X; Humanoid takes the side signs from these joints). Hitboxes come from the faction's
 * procedural skin `base` (zones, armour, masses): limbs scaled to the master's limb lengths, the
 * core by its height, the torso's boxes at the same heights over the pelvis as on `base` (the
 * master's torso turns about Spine1, higher than the procedural pivot). Null when the master isn't
 * loaded or the palette has no master character.
 */
export function masterSkin(palette: string, base: HumanoidSkin): HumanoidSkin | null {
  const a = masterAssets();
  const id = masterPerson(palette);
  const person = a && id ? a.people.get(id) : undefined;
  if (!a || !person) return null;
  const k = a.scale;
  const J = (n: string) => a.hang.p.get(n)!.clone().multiplyScalar(k);
  const hips = J('Hips');
  const spine = J('Spine1');
  const neck = J('Neck');
  const side = (s: 'L' | 'R') => ({
    shoulder: J(`UpperArm_${s}`),
    elbow: J(`Forearm_${s}`),
    wrist: J(`Hand_${s}`),
    hip: J(`Thigh_${s}`),
    knee: J(`Calf_${s}`),
    ankle: J(`Foot_${s}`),
  });
  const L = side('L');
  const R = side('R');
  const rel = (p: THREE.Vector3, q: THREE.Vector3): V3 => [p.x - q.x, p.y - q.y, p.z - q.z];
  const pivot: Record<PartName, V3> = {
    pelvis: [0, hips.y, hips.z],
    torso: [0, spine.y - hips.y, spine.z - hips.z],
    head: [0, neck.y - spine.y, neck.z - spine.z],
    upperArmL: rel(L.shoulder, spine),
    upperArmR: rel(R.shoulder, spine),
    foreArmL: rel(L.elbow, L.shoulder),
    foreArmR: rel(R.elbow, R.shoulder),
    thighL: rel(L.hip, hips),
    thighR: rel(R.hip, hips),
    shinL: rel(L.knee, L.hip),
    shinR: rel(R.knee, R.hip),
  };
  const sideOf: Record<PartName, -1 | 0 | 1> = {
    pelvis: 0, torso: 0, head: 0, upperArmL: -1, upperArmR: 1, foreArmL: -1, foreArmR: 1, thighL: -1, thighR: 1, shinL: -1, shinR: 1,
  };
  const baseDef = new Map(base.parts.map((p) => [p.name, p]));
  const len = (v: V3 | undefined) => (v ? Math.hypot(...v) : 1);
  const forearm = (L.elbow.distanceTo(L.wrist) + R.elbow.distanceTo(R.wrist)) / 2;
  const shin = (L.knee.distanceTo(L.ankle) + R.knee.distanceTo(R.ankle)) / 2;
  const heightK = data.game.height / 1.76;
  const scaleOf: Record<PartName, number> = {
    pelvis: heightK,
    torso: heightK,
    head: heightK,
    upperArmL: L.shoulder.distanceTo(L.elbow) / len(baseDef.get('foreArmL')?.pos),
    upperArmR: R.shoulder.distanceTo(R.elbow) / len(baseDef.get('foreArmR')?.pos),
    foreArmL: forearm / 0.27,
    foreArmR: forearm / 0.27,
    thighL: L.hip.distanceTo(L.knee) / len(baseDef.get('shinL')?.pos),
    thighR: R.hip.distanceTo(R.knee) / len(baseDef.get('shinR')?.pos),
    shinL: shin / (base.shinLength * 0.8),
    shinR: shin / (base.shinLength * 0.8),
  };
  // The torso's boxes keep their height over the pelvis: shift them by how much higher the
  // master's torso pivot sits over its pelvis than the procedural one.
  const torsoDrop = (baseDef.get('torso')?.pos[1] ?? 0) * heightK - pivot.torso[1];
  const parts: PartDef[] = base.parts.map((p) => {
    const s = scaleOf[p.name] ?? 1;
    const dy = p.name === 'torso' ? torsoDrop : 0;
    return {
      ...p,
      pos: pivot[p.name],
      side: sideOf[p.name],
      build: () => {},
      colliders: p.colliders.map((c) => ({
        ...c,
        half: [c.half[0] * Math.sqrt(s), c.half[1] * s, c.half[2] * Math.sqrt(s)] as V3,
        center: [c.center[0] * s, c.center[1] * s + dy, c.center[2] * s] as V3,
      })),
    };
  });
  // Knee → sole: the knee to the ankle, then the ankle's height over the flat foot.
  const shinLength = shin + a.ankleHeight * k;
  const hand = data.sockets.RightHandWeaponSocket.position[1] * k;
  const { body: _body, merge: _merge, ...rest } = base;
  void _body;
  void _merge;
  return {
    ...rest,
    parts,
    shinLength,
    handGrip: [0, -(forearm + hand), 0],
    visual: (h) => new MasterCharacter(a, person, h),
  };
}
