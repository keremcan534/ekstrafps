// Meshy's SmartRig exports name every bone Bone_000, Bone_001, ...; the game reads what a
// bone is from its name (src/targets/ModelBody.ts). This names them Mixamo-style from the
// skeleton's shape alone:
//   hips   the joint with a spine going up and two legs going down
//   legs   UpLeg → Leg → Foot → ToeBase → Toe_End down each side
//   spine  Spine, Spine1, ... up to the joint that branches into neck and two shoulders
//   neck   Neck → Head → HeadTop_End
//   arms   Shoulder → Arm → ForeArm → Hand → HandTip on each side
// Sides by position: glTF characters face +Z, so their left is +X.

const y = (n) => n.getWorldTranslation()[1];
const x = (n) => n.getWorldTranslation()[0];

/** True when the skin's bones carry no names worth reading. */
export function needsNames(doc) {
  const joints = doc.getRoot().listSkins()[0]?.listJoints() ?? [];
  return joints.length > 0 && joints.every((j) => /^Bone_\d+$/.test(j.getName()));
}

/** Rename the bones in place; throws if the skeleton isn't a plain humanoid. */
export function nameBones(doc) {
  const joints = new Set(doc.getRoot().listSkins()[0].listJoints());
  const kids = (n) => n.listChildren().filter((c) => joints.has(c));
  const all = [...joints];
  const hips = all.find((j) => {
    const k = kids(j);
    return k.length === 3 && k.filter((c) => y(c) < y(j)).length === 2;
  });
  if (!hips) throw new Error('no hips (a joint with a spine and two legs)');
  const named = new Map();
  const chain = (start, names) => {
    let n = start;
    for (const name of names) {
      if (!n) throw new Error(`chain ended before ${name}`);
      named.set(n, name);
      n = kids(n)[0];
    }
  };
  // Anything above the hips (a root bone) keeps out of the hips' way.
  for (let p = hips.getParentNode(); p && joints.has(p); p = p.getParentNode()) named.set(p, 'Root');
  named.set(hips, 'Hips');
  const hk = kids(hips);
  const legs = hk.filter((c) => y(c) < y(hips));
  for (const leg of legs) {
    const s = x(leg) > x(hips) ? 'Left' : 'Right';
    chain(leg, [`${s}UpLeg`, `${s}Leg`, `${s}Foot`, `${s}ToeBase`, `${s}Toe_End`]);
  }
  let n = hk.find((c) => !legs.includes(c));
  let i = 0;
  while (n && kids(n).length === 1) {
    named.set(n, i ? `Spine${i}` : 'Spine');
    i++;
    n = kids(n)[0];
  }
  if (!n || kids(n).length !== 3) throw new Error('no chest (a joint with a neck and two shoulders)');
  named.set(n, `Spine${i}`);
  const top = kids(n);
  const neck = top.reduce((a, b) => (Math.abs(x(a)) < Math.abs(x(b)) ? a : b));
  chain(neck, ['Neck', 'Head', 'HeadTop_End']);
  for (const sh of top.filter((c) => c !== neck)) {
    const s = x(kids(sh)[0] ?? sh) > x(n) ? 'Left' : 'Right';
    chain(sh, [`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`, `${s}HandTip`]);
  }
  for (const [node, name] of named) node.setName(name);
  return named.size;
}
