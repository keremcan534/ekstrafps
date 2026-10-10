import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bindMasterRig, type MasterRig } from './master/MasterRig';
import { capTextures } from '../core/TextureCap';
import data from './master/masterRig.json';

/**
 * The master humanoid's files for the game (src/characters/README.md is the contract), loaded
 * once and shared by every character built on it:
 *
 *   body     master/master_lod1.glb (desktop) or master_lod2.glb (phones) for near bodies, on
 *            desktop master_lod2.glb from the mid distance (MasterCharacter), master_lod3.glb past
 *            the far distance; a missing or broken LOD falls back to the next finer one, down to
 *            master_humanoid_rigged.glb (LOD0). One skeleton for all: the mid and far geometry
 *            are re-indexed onto the near body's bone order by name.
 *   looks    textures/<look>/{base_color,normal,orm}.webp (phones: base_color_1k, normal_512,
 *            orm_512) filling the body's "Body" material; a missing look falls back to "master",
 *            then to a plain material. A colour version of another look (textures/<look>/look.json
 *            {"maps": <look>}) has only its base colour and shares that look's normal / ORM maps.
 *   people   characters/<id>.json { look, gear[] }; missing: the look named like the id, no gear.
 *   gear     gear/<kind>/<id>.json + its GLB (socket or skinned); a missing one is left off. Its
 *            light versions (scripts/blender/lod_gear.py: the same mesh decimated, no materials):
 *            <id>_lod.glb from the mid distance on desktop and always on phones, <id>_far.glb past
 *            the far distance.
 *   textures desktop: look colour 2048, look maps and gear colour 1024, gear maps 512; phones:
 *            look colour 1024, gear colour 512, maps 512 / 256 (masterTextures() lists them all,
 *            for an upload before play).
 *
 * Every file is looked up by fetch at load and nothing fails hard: what is missing is listed
 * (`missing`) and the body is drawn with what there is. The game height is ONE scale for every
 * master character (masterRig.json game.height over the body's own height), never per character.
 */
const ROOT = 'assets/characters/';

export interface MasterLook {
  name: string;
  material: THREE.Material;
  /** Filled from the look's own textures (false: a fallback). */
  textured: boolean;
}

export interface MasterGear {
  id: string;
  kind: string;
  attach: 'socket' | 'skinned';
  /** Socket bone (attach "socket"). */
  socket: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  /** The GLB's scene (a template: each character clones it). */
  scene: THREE.Object3D;
  /** Look name → texture folder (gear/<kind>/<folder>/) of that look's version. */
  variants: Record<string, string>;
  /** This wearer's look's version of the item's material (its variant), if it has one. */
  material?: THREE.Material;
  /** The item's mid geometry (its one mesh; skin in the item's bone order), or null: none (phones: it is the near one). */
  lod: THREE.BufferGeometry | null;
  /** Past the far distance (null: the mid one, or the item itself). */
  far: THREE.BufferGeometry | null;
  /** Ballistic protection it gives (the hit zone's box takes it: MasterBody), or null: none. */
  armor: GearArmor | null;
}

/** A gear item's protection: the zone it covers, the surface rounds hit and its rating (plates ~40, helmets ~30). */
export interface GearArmor {
  zone: 'head' | 'thorax';
  surface: 'armor' | 'helmet';
  armor: number;
}

export interface MasterPerson {
  id: string;
  look: MasterLook;
  gear: MasterGear[];
}

/**
 * The pose the Humanoid's rest stands for (its parts all unturned): the master standing with the
 * arms and legs hanging straight down, palms to the thighs, feet flat. World rotations and joint
 * positions in the model's own space (metres, unscaled, faces +Z).
 */
export interface MasterHang {
  q: Map<string, THREE.Quaternion>;
  p: Map<string, THREE.Vector3>;
}

export interface MasterAssets {
  /** The near body, bound and checked (a template: characters clone it). */
  rig: MasterRig;
  near: THREE.BufferGeometry;
  /** From the mid distance (desktop; null: none, the near body is drawn). */
  mid: THREE.BufferGeometry | null;
  /** Past the far distance (null: none, the near body is drawn). */
  far: THREE.BufferGeometry | null;
  /** The body's own height (m, its top over the floor) and the one scale to the game's height. */
  height: number;
  scale: number;
  /** The ankle joint's height over the sole (m, unscaled; the foot flat). */
  ankleHeight: number;
  hang: MasterHang;
  people: Map<string, MasterPerson>;
  /** Files that were missing or rejected (fallbacks in use). */
  missing: string[];
}

/** The character ids of the game's master factions (masterRig.json game.people). */
export const MASTER_PEOPLE = [...new Set(Object.values(data.game.people as Record<string, string>))];

let loaded: MasterAssets | null = null;
let pending: Promise<MasterAssets | null> | null = null;

/** The loaded master assets (null: not loaded, or the body could not be used). */
export const masterAssets = (): MasterAssets | null => loaded;

/** Whether a static file is there (the dev server answers a missing one with its index page). */
async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function json<T>(url: string): Promise<T | null> {
  if (!(await exists(url))) return null;
  try {
    return (await (await fetch(url)).json()) as T;
  } catch {
    return null;
  }
}

/** Load once (later calls share the first). Never rejects: null when the body itself can't be used. */
export function loadMasterAssets(mobile: boolean): Promise<MasterAssets | null> {
  pending ??= load(mobile).catch((e) => {
    console.warn('[master] the master humanoid could not be loaded; its factions keep their old models', e);
    return null;
  });
  return pending;
}

async function load(mobile: boolean): Promise<MasterAssets | null> {
  const missing: string[] = [];
  const loader = new GLTFLoader();
  const body = async (file: string) => {
    const url = `${ROOT}master/${file}.glb`;
    if (!(await exists(url))) {
      missing.push(url);
      return null;
    }
    let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
    try {
      gltf = await loader.loadAsync(url);
    } catch (e) {
      // Half written or broken: the next file in line.
      missing.push(`${url} (${String(e)})`);
      return null;
    }
    let mesh: THREE.SkinnedMesh | null = null;
    gltf.scene.traverse((o) => {
      if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    return mesh ? { scene: gltf.scene, mesh: mesh as THREE.SkinnedMesh, url } : null;
  };
  // Near: the platform's LOD, else the next finer one. Far: LOD3.
  const nearOrder = mobile ? ['master_lod2', 'master_lod1', 'master_humanoid_rigged'] : ['master_lod1', 'master_humanoid_rigged'];
  let near: Awaited<ReturnType<typeof body>> = null;
  let rig: MasterRig | null = null;
  for (const f of nearOrder) {
    const b = await body(f);
    if (!b) continue;
    let r: MasterRig;
    try {
      r = bindMasterRig(b.scene);
    } catch (e) {
      missing.push(`${b.url} (${String(e)})`);
      continue;
    }
    const bad = wholeBody(b.mesh.geometry, r);
    if (bad) {
      missing.push(`${b.url} (${bad})`);
      continue;
    }
    near = b;
    rig = r;
    break;
  }
  if (!near || !rig) throw new Error(`no usable master body (${missing.join('; ')})`);
  for (const w of rig.report.warnings) console.warn('[master rig]', w);

  // Lighter bodies on the near one's skeleton: mid (desktop only: phones are near on LOD2) and far.
  const lighter = async (file: string) => {
    if (near!.url.endsWith(`${file}.glb`)) return null;
    const b = await body(file);
    if (!b) return null;
    const bad = wholeBody(b.mesh.geometry, rig!) ?? sameSkeleton(b.mesh, near!.mesh);
    if (bad) {
      missing.push(`${b.url} (${bad})`);
      return null;
    }
    return reindex(b.mesh, near!.mesh);
  };
  const [mid, far] = await Promise.all([mobile ? null : lighter('master_lod2'), lighter('master_lod3')]);

  near.mesh.geometry.computeBoundingBox();
  const height = near.mesh.geometry.boundingBox!.max.y;
  const scale = data.game.height / height;
  rig.model.updateMatrixWorld(true);
  const ankleHeight = new THREE.Vector3().setFromMatrixPosition(rig.bone('Foot_R').matrixWorld).y - near.mesh.geometry.boundingBox!.min.y;
  const hang = hangingPose(rig);

  const people = new Map<string, MasterPerson>();
  const looks = new Map<string, Promise<MasterLook>>();
  const look = (name: string): Promise<MasterLook> => {
    let p = looks.get(name);
    if (!p) looks.set(name, (p = loadLook(name, mobile, near!.mesh.material as THREE.Material, missing, looks)));
    return p;
  };
  // Gear is shared (one load per item); a look's variant of an item is a material of its own.
  const gearItems = new Map<string, Promise<MasterGear | null>>();
  const variants = new Map<string, Promise<THREE.Material | null>>();
  await Promise.all(
    MASTER_PEOPLE.map(async (id) => {
      const url = `${ROOT}characters/${id}.json`;
      const def = await json<{ id?: string; look?: string; gear?: string[] }>(url);
      if (!def) missing.push(url);
      const lookName = def?.look ?? id;
      const gear = await Promise.all(
        (def?.gear ?? []).map(async (ref) => {
          let p = gearItems.get(ref);
          if (!p) gearItems.set(ref, (p = loadGear(ref, loader, mobile, missing)));
          const g = await p;
          const folder = g?.variants[lookName];
          if (!g || !folder) return g;
          const key = `${ref}|${lookName}`;
          let v = variants.get(key);
          if (!v) variants.set(key, (v = loadVariant(g, folder, mobile, missing)));
          const material = await v;
          return material ? { ...g, material } : g;
        }),
      );
      people.set(id, { id, look: await look(lookName), gear: gear.filter((g): g is MasterGear => !!g) });
    }),
  );
  if (missing.length) console.info(`[master] using fallbacks for: ${missing.join(', ')}`);
  loaded = { rig, near: near.mesh.geometry, mid, far, height, scale, ankleHeight, hang, people, missing };
  return loaded;
}

/**
 * A gear item's LOD geometry (its one mesh; a skinned one re-indexed onto the item's bone order), or
 * null: no LOD file, or one that doesn't match the item (logged).
 */
async function gearLod(item: THREE.Object3D, url: string, loader: GLTFLoader, missing: string[]): Promise<THREE.BufferGeometry | null> {
  if (!(await exists(url))) return null;
  const meshes = (root: THREE.Object3D) => {
    const out: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && out.push(o as THREE.Mesh));
    return out;
  };
  try {
    const own = meshes(item);
    const [lod] = meshes((await loader.loadAsync(url)).scene);
    const near = own[0] as THREE.SkinnedMesh | undefined;
    const far = lod as THREE.SkinnedMesh | undefined;
    if (own.length !== 1 || !near || !far || !!near.isSkinnedMesh !== !!far.isSkinnedMesh) throw new Error('not the same kind of mesh');
    if (!near.isSkinnedMesh) return far.geometry;
    const bones = new Set(near.skeleton.bones.map((b) => b.name));
    const lost = far.skeleton.bones.filter((b) => !bones.has(b.name)).map((b) => b.name);
    if (lost.length) throw new Error(`bones not on the item: ${lost.join(', ')}`);
    return reindex(far, near);
  } catch (e) {
    missing.push(`${url} (${String(e)})`);
    return null;
  }
}

/** Every texture the master characters draw with (looks, gear, gear versions): upload them before play. */
export function masterTextures(): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  const add = (m: THREE.Material | THREE.Material[] | undefined) => {
    for (const mt of Array.isArray(m) ? m : m ? [m] : []) {
      const s = mt as THREE.MeshStandardMaterial;
      for (const t of [s.map, s.normalMap, s.roughnessMap, s.metalnessMap, s.aoMap, s.emissiveMap]) if (t) out.add(t);
    }
  };
  for (const p of loaded?.people.values() ?? []) {
    add(p.look.material);
    for (const g of p.gear) {
      add(g.material);
      g.scene.traverse((o) => add((o as THREE.Mesh).material));
    }
  }
  return [...out];
}

/** Why a body LOD can't stand in for the whole body (null: it can): it must reach the floor and the top of the head. */
function wholeBody(geo: THREE.BufferGeometry, rig: MasterRig): string | null {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const crown = new THREE.Vector3().setFromMatrixPosition(rig.bone('HeadSocket').matrixWorld).y;
  if (bb.min.y > 0.02 || bb.max.y < crown) return `cut off: spans y ${bb.min.y.toFixed(3)} … ${bb.max.y.toFixed(3)} m, the head's top socket is at ${crown.toFixed(3)} m`;
  return null;
}

/** Why `far` can't be drawn on `near`'s skeleton (null: it can): same bones, same bind. */
function sameSkeleton(far: THREE.SkinnedMesh, near: THREE.SkinnedMesh): string | null {
  const byName = new Map(near.skeleton.bones.map((b, i) => [b.name, i]));
  for (let i = 0; i < far.skeleton.bones.length; i++) {
    const j = byName.get(far.skeleton.bones[i].name);
    if (j === undefined) return `bone ${far.skeleton.bones[i].name} is not the body's`;
    const a = far.skeleton.boneInverses[i].elements;
    const b = near.skeleton.boneInverses[j].elements;
    for (let k = 0; k < 16; k++) if (Math.abs(a[k] - b[k]) > 1e-3) return `${far.skeleton.bones[i].name} is bound elsewhere`;
  }
  return null;
}

/** `far`'s geometry with its skin indices in `near`'s bone order (shared when they already match). */
function reindex(far: THREE.SkinnedMesh, near: THREE.SkinnedMesh): THREE.BufferGeometry {
  const byName = new Map(near.skeleton.bones.map((b, i) => [b.name, i]));
  const map = far.skeleton.bones.map((b) => byName.get(b.name)!);
  if (map.every((j, i) => j === i)) return far.geometry;
  const geo = far.geometry.clone();
  const si = geo.getAttribute('skinIndex') as THREE.BufferAttribute;
  for (let i = 0; i < si.count; i++) for (let c = 0; c < 4; c++) si.setComponent(i, c, map[si.getComponent(i, c)]);
  si.needsUpdate = true;
  return geo;
}

/**
 * The hanging pose: from the rest (A-pose), each upper arm and thigh swung (the least turn) to
 * point straight down, then each forearm and calf the same, hands keeping their rest turn on the
 * forearm and feet their rest (flat) turn in the world. Everything else stays at rest.
 */
function hangingPose(rig: MasterRig): MasterHang {
  rig.model.updateMatrixWorld(true);
  const q = new Map<string, THREE.Quaternion>();
  const p = new Map<string, THREE.Vector3>();
  const scl = new THREE.Vector3();
  const local = new Map<string, THREE.Quaternion>();
  for (const [name, r] of rig.rest) local.set(name, r.quaternion.clone());
  const down = new THREE.Vector3(0, -1, 0);
  const world = (name: string) => {
    // World rotation and position through the (edited) local rotations, root first.
    const chain: THREE.Bone[] = [];
    for (let b: THREE.Object3D | null = rig.bone(name); b && (b as THREE.Bone).isBone; b = b.parent) chain.unshift(b as THREE.Bone);
    const parentQ = new THREE.Quaternion();
    const at = new THREE.Vector3();
    rig.bone(chain[0].name).parent!.matrixWorld.decompose(at, parentQ, scl);
    for (const b of chain) {
      at.add(rig.rest.get(b.name)!.position.clone().applyQuaternion(parentQ));
      parentQ.multiply(local.get(b.name)!);
    }
    return { q: parentQ, p: at };
  };
  const swing = (bone: string, child: string) => {
    const a = world(bone);
    const dir = world(child).p.sub(a.p).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(dir, down);
    const parentQ = world(bone).q.multiply(local.get(bone)!.clone().invert());
    // New world = turn × old world; local = parent⁻¹ × new world.
    local.set(bone, parentQ.clone().invert().multiply(turn.multiply(a.q)));
  };
  for (const s of ['R', 'L']) {
    swing(`UpperArm_${s}`, `Forearm_${s}`);
    swing(`Forearm_${s}`, `Hand_${s}`);
    const footWorld = world(`Foot_${s}`).q.clone();
    swing(`Thigh_${s}`, `Calf_${s}`);
    swing(`Calf_${s}`, `Foot_${s}`);
    // The foot keeps its rest turn in the world (flat on the floor).
    const calf = world(`Calf_${s}`).q;
    local.set(`Foot_${s}`, calf.invert().multiply(footWorld));
  }
  for (const name of rig.rest.keys()) {
    const w = world(name);
    q.set(name, w.q);
    p.set(name, w.p);
  }
  return { q, p };
}

/**
 * A texture set in `dir` (base_color, normal, orm .webp; phones: their _1k / _512 files first) as a
 * PBR material like `base` (side, name), or null without a base colour. Desktop at most 2048 px
 * (a 4K hero texture would cost 64 MB a map); phones 1K colour, 512 maps.
 */
async function textureSet(dir: string, mobile: boolean, base: THREE.Material, mapsDir = dir, caps = LOOK_CAPS, side = base.side): Promise<THREE.MeshStandardMaterial | null> {
  const files = mobile
    ? [['base_color_1k.webp', 'base_color.webp'], ['normal_512.webp', 'normal.webp'], ['orm_512.webp', 'orm.webp']]
    : [['base_color.webp'], ['normal.webp'], ['orm.webp']];
  const first = async (names: string[], from = dir) => {
    for (const f of names) {
      if (!(await exists(from + f))) continue;
      try {
        return await texture(from + f);
      } catch (e) {
        // A file that won't decode (half written, corrupt) counts as missing: the next one, or the fallback.
        console.warn(`[master] ${from + f} could not be decoded`, e);
      }
    }
    return null;
  };
  const [colour, normal, orm] = await Promise.all(files.map((names, i) => (i === 0 ? first(names) : first(names, mapsDir))));
  if (!colour) return null;
  colour.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: colour, side, roughness: 1, metalness: 1 });
  m.name = base.name;
  if (normal) m.normalMap = normal;
  if (orm) {
    // glTF packing: R occlusion, G roughness, B metallic.
    m.aoMap = orm;
    m.roughnessMap = orm;
    m.metalnessMap = orm;
  } else {
    m.roughness = 0.85;
    m.metalness = 0;
  }
  capTextures([m], ...caps(mobile));
  return m;
}

/** [colour, maps] px: a look fills a body up close; gear is small on screen, its maps more so. */
const LOOK_CAPS = (mobile: boolean): [number, number] => (mobile ? [1024, 512] : [2048, 1024]);
const GEAR_CAPS = (mobile: boolean): [number, number] => (mobile ? [512, 256] : [1024, 512]);

/** A look's material: its textures if they are there, else the "master" look's, else plain. */
async function loadLook(name: string, mobile: boolean, base: THREE.Material, missing: string[], looks: Map<string, Promise<MasterLook>>): Promise<MasterLook> {
  const dir = `${ROOT}textures/${name}/`;
  const shared = (await json<{ maps?: string }>(`${dir}look.json`))?.maps;
  // The body is closed: front faces only (half the fragments, in the shadow pass too).
  const m = await textureSet(dir, mobile, base, shared ? `${ROOT}textures/${shared}/` : dir, LOOK_CAPS, THREE.FrontSide);
  if (m) return { name, material: m, textured: true };
  missing.push(`${dir}base_color.webp`);
  if (name !== 'master') {
    // Every look falls back to the master's own (the neutral underlayer).
    let fallback = looks.get('master');
    if (!fallback) looks.set('master', (fallback = loadLook('master', mobile, base, missing, looks)));
    return { name, material: (await fallback).material, textured: false };
  }
  const plain = new THREE.MeshStandardMaterial({ color: 0x3c3f43, roughness: 0.85, metalness: 0, side: base.side });
  plain.name = 'Body';
  return { name, material: plain, textured: false };
}

/** A gear item's version for a look (gear/<kind>/<folder>/ textures on the item's own material), or null: the item as it is. */
async function loadVariant(g: MasterGear, folder: string, mobile: boolean, missing: string[]): Promise<THREE.Material | null> {
  let base: THREE.Material | null = null;
  g.scene.traverse((o) => {
    if (!base && (o as THREE.Mesh).isMesh) base = (o as THREE.Mesh).material as THREE.Material;
  });
  const dir = `${ROOT}gear/${g.kind}/${folder}/`;
  const m = base ? await textureSet(dir, mobile, base, dir, GEAR_CAPS) : null;
  if (!m) missing.push(`${dir}base_color.webp`);
  // A colour-only version keeps the item's own normal / ORM maps.
  const own = base as THREE.MeshStandardMaterial | null;
  if (m && own?.isMeshStandardMaterial) {
    // The item's normal-map sign: glTF gear has no tangents, and the loader flips green for that.
    m.normalScale.copy(own.normalScale);
    if (!m.normalMap && own.normalMap) m.normalMap = own.normalMap;
    if (!m.roughnessMap && !m.metalnessMap) {
      m.aoMap = own.aoMap;
      m.roughnessMap = own.roughnessMap;
      m.metalnessMap = own.metalnessMap;
      m.roughness = own.roughness;
      m.metalness = own.metalness;
    }
  }
  return m;
}

const bitmaps = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none' });
/** One texture per URL: looks that share maps share the GPU copy. */
const textures = new Map<string, Promise<THREE.Texture>>();
function texture(url: string): Promise<THREE.Texture> {
  let t = textures.get(url);
  if (!t) textures.set(url, (t = loadTexture(url)));
  return t;
}
async function loadTexture(url: string): Promise<THREE.Texture> {
  const img = await bitmaps.loadAsync(url);
  const t = new THREE.Texture(img as ImageBitmap);
  // glTF UVs: the image's top row at v = 0.
  t.flipY = false;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

interface GearFile {
  id: string;
  kind: string;
  model: string;
  attach: 'socket' | 'skinned';
  socket?: string;
  position?: number[];
  quaternion?: number[];
  scale?: number;
  variants?: Record<string, string>;
  armor?: GearArmor;
}

/** A gear item ("<kind>/<id>"): its JSON and GLB, or null (missing: left off). */
async function loadGear(ref: string, loader: GLTFLoader, mobile: boolean, missing: string[]): Promise<MasterGear | null> {
  const [kind, id] = ref.split('/');
  const url = `${ROOT}gear/${kind}/${id}.json`;
  const def = await json<GearFile>(url);
  if (!def) {
    missing.push(url);
    return null;
  }
  const glb = `${ROOT}gear/${kind}/${def.model ?? `${id}.glb`}`;
  if (!(await exists(glb))) {
    missing.push(glb);
    return null;
  }
  try {
    const gltf = await loader.loadAsync(glb);
    // The item's own textures, capped (GEAR_CAPS).
    const mats: THREE.Material[] = [];
    gltf.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh) mats.push(...(Array.isArray(m) ? m : [m]));
    });
    capTextures(mats, ...GEAR_CAPS(mobile));
    let [lod, far] = await Promise.all([
      gearLod(gltf.scene, glb.replace(/\.glb$/, '_lod.glb'), loader, missing),
      gearLod(gltf.scene, glb.replace(/\.glb$/, '_far.glb'), loader, missing),
    ]);
    if (lod && mobile) {
      // Phones draw the mid version up close.
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry = lod!;
      });
      lod = null;
    }
    return {
      id: def.id ?? id,
      kind: def.kind ?? kind,
      attach: def.attach === 'skinned' ? 'skinned' : 'socket',
      socket: def.socket ?? 'HeadSocket',
      position: new THREE.Vector3().fromArray(def.position ?? [0, 0, 0]),
      quaternion: new THREE.Quaternion().fromArray(def.quaternion ?? [0, 0, 0, 1]).normalize(),
      scale: def.scale ?? 1,
      scene: gltf.scene,
      variants: def.variants ?? {},
      lod,
      far,
      armor: def.armor ?? null,
    };
  } catch (e) {
    missing.push(`${glb} (${String(e)})`);
    return null;
  }
}
