import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HumanoidSkin, PartDef, PartName } from './Humanoid';

/**
 * Real character models on the Humanoid body.
 *
 * Any rigged humanoid GLB (Mixamo / Meshy / Tripo / UE-style bone names) is turned into
 * what Humanoid expects: ONE skinned geometry in the body's rest pose (arms and legs
 * hanging straight down, facing +Z, feet on y = 0), weighted to the body's 11 part bones
 * plus the two ankle bones. The model's own fine skeleton (spine segments, clavicles,
 * fingers, toes) folds into those, and the body's joint positions come from the model,
 * so walking, IK, hitboxes and the ragdoll all fit the character's real proportions.
 *
 * Done once per model at load (tens of milliseconds), shared by every body wearing it.
 */

type V3 = [number, number, number];
type Slot = PartName | 'footL' | 'footR';

/** Joint positions in the rest pose, root space (metres). */
interface Joints {
  hips: THREE.Vector3;
  spine: THREE.Vector3;
  neck: THREE.Vector3;
  shoulderL: THREE.Vector3;
  shoulderR: THREE.Vector3;
  elbowL: THREE.Vector3;
  elbowR: THREE.Vector3;
  wristL: THREE.Vector3;
  wristR: THREE.Vector3;
  hipL: THREE.Vector3;
  hipR: THREE.Vector3;
  kneeL: THREE.Vector3;
  kneeR: THREE.Vector3;
  ankleL: THREE.Vector3;
  ankleR: THREE.Vector3;
}

export interface ModelBody {
  /** Rest-pose geometry; skinWeight over `slots` (index = position in this list). */
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  slots: Slot[];
  joints: Joints;
  height: number;
}

type Kind = 'hips' | 'spine' | 'neck' | 'head' | 'clavicle' | 'upperArm' | 'foreArm' | 'hand' | 'thigh' | 'shin' | 'foot' | 'other';

/** What a bone is, from its name (prefixes like mixamorig: / bip01 / DEF- stripped). */
function kindOf(raw: string): Kind {
  const n = raw.toLowerCase().replace(/^(mixamorig\d*[:_]?|bip0?1[ _]?|def[-_]|armature[|_]|cc_base_)/, '');
  if (/hip|pelvis/.test(n) && !/up_?leg|thigh/.test(n)) return 'hips';
  if (/neck/.test(n)) return 'neck';
  if (/head/.test(n)) return 'head';
  if (/eye|jaw|tongue|teeth/.test(n)) return 'head';
  if (/shoulder|clavicle/.test(n)) return 'clavicle';
  if (/hand|finger|thumb|index|middle|ring|pinky|wrist|palm/.test(n)) return 'hand';
  if (/fore_?arm|lower_?arm|elbow/.test(n)) return 'foreArm';
  if (/arm/.test(n)) return 'upperArm';
  if (/up_?leg|thigh|upper_?leg/.test(n)) return 'thigh';
  if (/foot|toe|ankle|ball/.test(n)) return 'foot';
  if (/leg|calf|shin|knee|lower_?leg/.test(n)) return 'shin';
  if (/spine|chest|torso|abdomen/.test(n)) return 'spine';
  return 'other';
}

const v = () => new THREE.Vector3();

/** Width × depth (× limb depth) scale for a model that came out too slight. */
export type Girth = [number, number] | [number, number, number];

/**
 * Load a rigged character and convert it.
 * @param height standing height to scale it to (metres).
 * @param girth extra width (x) and depth (z) for a model that came out too slight; an
 *              optional third value gives the arms and legs their own depth.
 * @param rigid every vertex on one part only: a machine's plates turn at the joints
 *              instead of bending like rubber (auto-rigs blend weights across every joint).
 */
export async function loadModelBody(url: string, height = 1.78, girth: Girth = [1, 1], rigid = false): Promise<ModelBody> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && meshes.push(o as THREE.SkinnedMesh));
  if (!meshes.length) throw new Error(`${url}: no skinned mesh`);
  const skeleton = meshes[0].skeleton;
  const bones = skeleton.bones;
  const kind = new Map<THREE.Bone, Kind>(bones.map((b) => [b, kindOf(b.name)]));
  // Inherit a kind from the nearest named ancestor ('other' bones: twist/helper bones).
  const kindUp = (b: THREE.Object3D | null): Kind => {
    for (let o = b; o; o = o.parent) {
      const k = kind.get(o as THREE.Bone);
      if (k && k !== 'other') return k;
    }
    return 'other';
  };
  const first = (k: Kind, side = 0): THREE.Bone | undefined => {
    const list = bones.filter((b) => kind.get(b) === k);
    if (!side) return list.sort((a, b) => depth(a) - depth(b))[0];
    // The chain root of that kind on the given side (shallowest).
    return list.filter((b) => sideOf(b) === side).sort((a, b) => depth(a) - depth(b))[0];
  };
  const depth = (b: THREE.Object3D) => {
    let d = 0;
    for (let o = b.parent; o; o = o.parent) d++;
    return d;
  };
  const wpos = (o: THREE.Object3D) => o.getWorldPosition(v());
  const hipsBone = first('hips') ?? bones[0];

  // Facing: toes ahead of the ankles. glTF characters face +Z; turn round if not.
  const anyFoot = bones.find((b) => kind.get(b) === 'foot' && b.children.some((c) => kind.get(c as THREE.Bone) === 'foot'));
  if (anyFoot) {
    const toe = anyFoot.children.find((c) => kind.get(c as THREE.Bone) === 'foot')!;
    if (wpos(toe).z < wpos(anyFoot).z) {
      scene.rotation.y += Math.PI;
      scene.updateMatrixWorld(true);
    }
  }
  // Sides by position (after facing +Z): +X is the body's "R" (Humanoid side 1).
  const hipsX = wpos(hipsBone).x;
  const sideCache = new Map<THREE.Bone, number>();
  function sideOf(b: THREE.Bone): number {
    let s = sideCache.get(b);
    if (s === undefined) {
      const x = wpos(b).x - hipsX;
      s = Math.abs(x) < 0.02 * scaleGuess ? 0 : Math.sign(x);
      sideCache.set(b, s);
    }
    return s;
  }
  const box = new THREE.Box3().setFromObject(scene);
  const scaleGuess = box.max.y - box.min.y || 1;

  // ---- Hands: fingers curled into a grip (T/A-pose models come with flat open hands). ----
  // Palm normal from the finger direction and the index → pinky line (index ahead of the
  // pinky on a +Z-facing body); each finger joint turns towards the palm.
  for (const hand of bones.filter((b) => kind.get(b) === 'hand' && b.children.length > 0)) {
    const fingers = hand.children.filter((c) => kind.get(c as THREE.Bone) === 'hand') as THREE.Bone[];
    if (fingers.length < 3) continue;
    const named = (re: RegExp) => fingers.find((f) => re.test(f.name.toLowerCase()));
    const index = named(/index/);
    const pinky = named(/pinky|little/);
    const middle = named(/middle/) ?? fingers[0];
    if (!index || !pinky || !middle.children.length) continue;
    const hp = wpos(hand);
    const fdir = wpos(middle).sub(hp).normalize();
    const across = wpos(pinky).sub(wpos(index)).normalize();
    const palm = new THREE.Vector3().crossVectors(fdir, across).normalize().multiplyScalar(hp.x - hipsX > 0 ? -1 : 1);
    for (const base of fingers) {
      const thumb = /thumb/.test(base.name.toLowerCase());
      const angles = thumb ? [0.15, 0.25, 0.2] : [0.85, 1.0, 0.7];
      let bone: THREE.Bone | undefined = base;
      for (let j = 0; bone && j < angles.length; j++) {
        const tip = bone.children[0];
        if (!tip) break;
        scene.updateMatrixWorld(true);
        const dir = wpos(tip).sub(wpos(bone)).normalize();
        const axis = new THREE.Vector3().crossVectors(dir, palm);
        if (axis.lengthSq() < 1e-6) break;
        const q = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angles[j]);
        const world = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(q);
        const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
        bone.quaternion.copy(parentQ.invert().multiply(world));
        bone = tip as THREE.Bone;
      }
    }
  }

  // ---- Rest pose: limbs straight down. ----
  const down = new THREE.Vector3(0, -1, 0);
  const aim = (bone: THREE.Bone | undefined, tip: THREE.Object3D | undefined) => {
    if (!bone || !tip) return;
    scene.updateMatrixWorld(true);
    const dir = wpos(tip).sub(wpos(bone));
    if (dir.lengthSq() < 1e-10) return;
    const q = new THREE.Quaternion().setFromUnitVectors(dir.normalize(), down);
    const world = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(q);
    const parentQ = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    bone.quaternion.copy(parentQ.invert().multiply(world));
    bone.updateMatrixWorld(true);
  };
  const childOf = (b: THREE.Bone | undefined, k: Kind) => b?.children.find((c) => kind.get(c as THREE.Bone) === k) as THREE.Bone | undefined;
  const limb: Record<string, THREE.Bone | undefined> = {};
  for (const s of [-1, 1]) {
    const up = first('upperArm', s);
    const fore = childOf(up, 'foreArm') ?? first('foreArm', s);
    const hand = childOf(fore, 'hand') ?? first('hand', s);
    const thigh = first('thigh', s);
    const shin = childOf(thigh, 'shin') ?? first('shin', s);
    const foot = childOf(shin, 'foot') ?? first('foot', s);
    const k = s > 0 ? 'R' : 'L';
    Object.assign(limb, { [`up${k}`]: up, [`fore${k}`]: fore, [`hand${k}`]: hand, [`thigh${k}`]: thigh, [`shin${k}`]: shin, [`foot${k}`]: foot });
    aim(up, fore);
    aim(fore, hand);
    aim(thigh, shin);
    aim(shin, foot);
  }
  scene.updateMatrixWorld(true);
  for (const m of meshes) m.skeleton.update();

  // ---- Bake the posed, skinned vertices into world space. ----
  const slots: Slot[] = ['pelvis', 'torso', 'head', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'];
  const slotOf = (b: THREE.Bone): number => {
    const k = kindUp(b);
    const s = sideOf(b) > 0 ? 'R' : 'L';
    switch (k) {
      case 'hips':
        return 0;
      case 'spine':
      case 'clavicle':
      case 'neck':
        return 1;
      case 'head':
        return 2;
      case 'upperArm':
        return slots.indexOf(`upperArm${s}`);
      case 'foreArm':
      case 'hand':
        return slots.indexOf(`foreArm${s}`);
      case 'thigh':
        return slots.indexOf(`thigh${s}`);
      case 'shin':
        return slots.indexOf(`shin${s}`);
      case 'foot':
        return slots.indexOf(`foot${s}`);
      default:
        return 0;
    }
  };
  const parts: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const M = new THREE.Matrix4();
  const B = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const p = v();
  const n = v();
  for (const mesh of meshes) {
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    const si = src.getAttribute('skinIndex');
    const sw = src.getAttribute('skinWeight');
    const count = pos.count;
    const outP = new Float32Array(count * 3);
    const outN = new Float32Array(count * 3);
    const outI = new Uint16Array(count * 4);
    const outW = new Float32Array(count * 4);
    const boneSlot = mesh.skeleton.bones.map(slotOf);
    const boneMats = mesh.skeleton.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i]));
    const toWorld = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
    const acc = new Float32Array(slots.length);
    for (let i = 0; i < count; i++) {
      B.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      acc.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        const bi = si.getComponent(i, k);
        tmp.copy(boneMats[bi]).multiplyScalar(w);
        for (let e = 0; e < 16; e++) B.elements[e] += tmp.elements[e];
        acc[boneSlot[bi]] += w;
      }
      M.multiplyMatrices(toWorld, B).multiply(mesh.bindMatrix);
      p.fromBufferAttribute(pos, i).applyMatrix4(M);
      outP.set([p.x, p.y, p.z], i * 3);
      if (nor) {
        n.fromBufferAttribute(nor, i).transformDirection(M);
        outN.set([n.x, n.y, n.z], i * 3);
      }
      // Top four slots by weight.
      const order = [...acc.keys()].filter((s) => acc[s] > 0).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
      const total = order.reduce((t, s) => t + acc[s], 0) || 1;
      order.forEach((s, k) => {
        outI[i * 4 + k] = s;
        outW[i * 4 + k] = acc[s] / total;
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(outP, 3));
    if (nor) g.setAttribute('normal', new THREE.BufferAttribute(outN, 3));
    const uv = src.getAttribute('uv');
    if (uv) g.setAttribute('uv', uv.clone());
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outW, 4));
    if (src.index) g.setIndex(src.index.clone());
    if (!nor) g.computeVertexNormals();
    // Keep the source's material groups as separate merge entries.
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (src.groups.length && Array.isArray(mesh.material)) {
      for (const grp of src.groups) {
        const part = g.clone();
        part.setIndex(Array.from((g.index?.array ?? []) as ArrayLike<number>).slice(grp.start, grp.start + grp.count));
        parts.push(part);
        mats.push(list[grp.materialIndex ?? 0]);
      }
    } else {
      parts.push(g);
      mats.push(list[0]);
    }
  }
  const geometry = mergeGeometries(
    parts.map((g) => (g.index ? g : g)),
    true,
  )!;
  if (!geometry) throw new Error(`${url}: could not merge parts`);

  // ---- Scale to height, feet on the floor, centred over the hips. ----
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const k = height / (bb.max.y - bb.min.y);
  const hipW = wpos(hipsBone);
  const fix = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-hipW.x, -bb.min.y, -hipW.z));
  geometry.applyMatrix4(fix);
  const J = (o: THREE.Object3D | undefined, fallback: THREE.Vector3) => (o ? wpos(o).applyMatrix4(fix) : fallback.clone());
  const hips = J(hipsBone, new THREE.Vector3(0, height * 0.53, 0));
  const spineBone = first('spine');
  const neckBone = first('neck') ?? first('head');
  const joints: Joints = {
    hips,
    spine: J(spineBone, hips.clone().setY(hips.y + 0.05)),
    neck: J(neckBone, new THREE.Vector3(0, height * 0.85, 0)),
    shoulderL: J(limb.upL, new THREE.Vector3(-0.2, height * 0.8, 0)),
    shoulderR: J(limb.upR, new THREE.Vector3(0.2, height * 0.8, 0)),
    elbowL: J(limb.foreL, new THREE.Vector3(-0.2, height * 0.63, 0)),
    elbowR: J(limb.foreR, new THREE.Vector3(0.2, height * 0.63, 0)),
    wristL: J(limb.handL, new THREE.Vector3(-0.2, height * 0.47, 0)),
    wristR: J(limb.handR, new THREE.Vector3(0.2, height * 0.47, 0)),
    hipL: J(limb.thighL, new THREE.Vector3(-0.1, height * 0.5, 0)),
    hipR: J(limb.thighR, new THREE.Vector3(0.1, height * 0.5, 0)),
    kneeL: J(limb.shinL, new THREE.Vector3(-0.1, height * 0.27, 0)),
    kneeR: J(limb.shinR, new THREE.Vector3(0.1, height * 0.27, 0)),
    ankleL: J(limb.footL, new THREE.Vector3(-0.1, height * 0.05, 0)),
    ankleR: J(limb.footR, new THREE.Vector3(0.1, height * 0.05, 0)),
  };
  const [gx, gz, limbZ = gz] = girth;
  if (gx !== 1 || gz !== 1 || limbZ !== 1) {
    // Around the body's centre line (the hips sit on x = z = 0): joints move with it.
    // Depth per vertex by its weights: the core (pelvis, torso, head) takes `gz`, arms and
    // legs `limbZ`, blending across the shoulders and hips.
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const si = geometry.getAttribute('skinIndex');
    const sw = geometry.getAttribute('skinWeight');
    const slotZ = slots.map((s) => (s === 'pelvis' || s === 'torso' || s === 'head' ? gz : limbZ));
    for (let i = 0; i < pos.count; i++) {
      let z = 0;
      for (let c = 0; c < 4; c++) z += sw.getComponent(i, c) * slotZ[si.getComponent(i, c)];
      pos.setXYZ(i, pos.getX(i) * gx, pos.getY(i), pos.getZ(i) * z);
      // Normals take the inverse scale (a stretched face turns towards the short axis).
      n.set(nor.getX(i) / gx, nor.getY(i), nor.getZ(i) / z).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    pos.needsUpdate = nor.needsUpdate = true;
    const core: (keyof Joints)[] = ['hips', 'spine', 'neck'];
    for (const [name, j] of Object.entries(joints)) j.set(j.x * gx, j.y, j.z * (core.includes(name as keyof Joints) ? gz : limbZ));
  }
  if (rigid) {
    // After the girth (which blends by the smooth weights, so the body stays in one piece).
    // A knee pad wrapping the joint is split between thigh and shin and shears as the knee
    // bends: the thigh's last few centimetres above the knee go to the shin, pad and all
    // (the thigh's bottom edge it takes along sits inside the pad). Boots stay on the shin
    // too, as the procedural robot's did: a fused mesh has no edge loop at the ankle, so a
    // separate foot would skew the whole shin.
    const pos = geometry.getAttribute('position');
    const si = geometry.getAttribute('skinIndex');
    const sw = geometry.getAttribute('skinWeight');
    const shinL = slots.indexOf('shinL');
    const shinR = slots.indexOf('shinR');
    const thighL = slots.indexOf('thighL');
    const thighR = slots.indexOf('thighR');
    const footL = slots.indexOf('footL');
    const footR = slots.indexOf('footR');
    for (let i = 0; i < si.count; i++) {
      let best = 0;
      for (let c = 1; c < 4; c++) if (sw.getComponent(i, c) > sw.getComponent(i, best)) best = c;
      let slot = si.getComponent(i, best);
      const y = pos.getY(i);
      if ((slot === thighL && y < joints.kneeL.y + 0.042) || slot === footL) slot = shinL;
      else if ((slot === thighR && y < joints.kneeR.y + 0.042) || slot === footR) slot = shinR;
      si.setXYZW(i, slot, 0, 0, 0);
      sw.setXYZW(i, 1, 0, 0, 0);
    }
    si.needsUpdate = sw.needsUpdate = true;
  }
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3.5);
  for (const m of mats) {
    const s = m as THREE.MeshStandardMaterial;
    s.vertexColors = false;
  }
  return { geometry, materials: mats, slots, joints, height };
}

/**
 * A HumanoidSkin for a converted model: joint positions from the model, hitboxes from
 * `base` (the procedural skin of the same faction: health, armour, damage zones) scaled
 * to the model's limb lengths. The parts build no geometry; the body mesh comes whole.
 */
export function skinFromModel(body: ModelBody, base: HumanoidSkin): HumanoidSkin {
  const J = body.joints;
  const rel = (a: THREE.Vector3, b: THREE.Vector3): V3 => [a.x - b.x, a.y - b.y, a.z - b.z];
  const len = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b);
  const baseDef = new Map(base.parts.map((p) => [p.name, p]));
  // Pivots: pelvis at the hips; torso just above (where the spine bends); head at the neck.
  const torsoAt = J.hips.clone().lerp(J.spine, 0.5).setX(0);
  const pivot: Record<PartName, V3> = {
    pelvis: [0, J.hips.y, J.hips.z],
    torso: rel(torsoAt, J.hips),
    head: rel(J.neck, torsoAt),
    upperArmL: rel(J.shoulderL, torsoAt),
    upperArmR: rel(J.shoulderR, torsoAt),
    foreArmL: rel(J.elbowL, J.shoulderL),
    foreArmR: rel(J.elbowR, J.shoulderR),
    thighL: rel(J.hipL, J.hips),
    thighR: rel(J.hipR, J.hips),
    shinL: rel(J.kneeL, J.hipL),
    shinR: rel(J.kneeR, J.hipR),
  };
  // Scale for each part's hitboxes: limb length ratio, or overall height for the core.
  const oldLen = (name: PartName, child: PartName) => Math.hypot(...(baseDef.get(child)?.pos ?? [0, 1, 0]));
  const heightK = body.height / 1.76;
  const scaleOf: Record<PartName, number> = {
    pelvis: heightK,
    torso: heightK,
    head: heightK,
    upperArmL: len(J.shoulderL, J.elbowL) / oldLen('upperArmL', 'foreArmL'),
    upperArmR: len(J.shoulderR, J.elbowR) / oldLen('upperArmR', 'foreArmR'),
    foreArmL: len(J.elbowL, J.wristL) / 0.27,
    foreArmR: len(J.elbowR, J.wristR) / 0.27,
    thighL: len(J.hipL, J.kneeL) / oldLen('thighL', 'shinL'),
    thighR: len(J.hipR, J.kneeR) / oldLen('thighR', 'shinR'),
    shinL: len(J.kneeL, J.ankleL) / (base.shinLength * 0.8),
    shinR: len(J.kneeR, J.ankleR) / (base.shinLength * 0.8),
  };
  const parts: PartDef[] = base.parts.map((p) => {
    const s = scaleOf[p.name] ?? 1;
    return {
      ...p,
      pos: pivot[p.name],
      build: () => {},
      colliders: p.colliders.map((c) => ({
        ...c,
        half: [c.half[0] * Math.sqrt(s), c.half[1] * s, c.half[2] * Math.sqrt(s)] as V3,
        center: [c.center[0] * s, c.center[1] * s, c.center[2] * s] as V3,
      })),
    };
  });
  const shin = (J.kneeL.y + J.kneeR.y) / 2; // knee height = knee → sole
  const forearm = (len(J.elbowL, J.wristL) + len(J.elbowR, J.wristR)) / 2;
  return {
    ...base,
    parts,
    shinLength: shin,
    handGrip: [0, -(forearm + 0.07), 0],
    body: { geometry: body.geometry, materials: body.materials, slots: body.slots },
  };
}
