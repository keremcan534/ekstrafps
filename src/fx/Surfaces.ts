import * as THREE from 'three';
import { applyGrime } from './WorldGrime';
import { foldEnabled, setLumaHook, swapOnce } from '../world/MaterialFold';

/**
 * Real surfaces: CC0 PBR texture sets from Poly Haven (polyhaven.com), converted to WebP
 * under public/tex (1K) and public/tex/m (512, phones). Each set is a colour map, a
 * normal map (OpenGL) and an ARM map (AO / roughness / metalness in R / G / B, which is
 * exactly how three reads aoMap, roughnessMap and metalnessMap).
 *
 * World geometry has world-projected UVs (1 unit = 1 m, MeshBuilder), so a set tiles at
 * its real size. Phones: 512 maps, no normal map (GPU memory and one fewer fetch).
 * Every surface also gets the world grime (fx/WorldGrime) on top, which breaks up the tiling.
 */

export type SurfaceId =
  | 'garage_floor'
  | 'hangar_concrete_floor'
  | 'concrete_wall_004'
  | 'plastered_wall_04'
  | 'peeling_painted_wall'
  | 'dirty_tiles'
  | 'rusty_painted_metal'
  | 'metal_plate'
  | 'rusty_corrugated_iron'
  | 'asphalt_02'
  | 'ceiling_interior';

/** Metres covered by one repeat of each set. */
const TILE: Record<SurfaceId, number> = {
  garage_floor: 3,
  hangar_concrete_floor: 4,
  concrete_wall_004: 3,
  plastered_wall_04: 2.5,
  peeling_painted_wall: 2.5,
  dirty_tiles: 2,
  rusty_painted_metal: 2,
  metal_plate: 2,
  rusty_corrugated_iron: 2.5,
  asphalt_02: 4,
  ceiling_interior: 2.5,
};

/** Mean linear luminance of each colour map (measured from the 1K sets). */
const MEAN_LUM: Record<SurfaceId, number> = {
  asphalt_02: 0.11,
  ceiling_interior: 0.165,
  concrete_wall_004: 0.17,
  dirty_tiles: 0.025,
  garage_floor: 0.16,
  hangar_concrete_floor: 0.03,
  metal_plate: 0.036,
  peeling_painted_wall: 0.18,
  plastered_wall_04: 0.255,
  rusty_corrugated_iron: 0.04,
  rusty_painted_metal: 0.069,
};

const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();
let anisotropy = 4;

/** Anisotropic filtering for the sets made from now on (phones: low). */
export function setSurfaceAnisotropy(a: number): void {
  anisotropy = a;
}

function tex(id: SurfaceId, kind: 'diff' | 'nor_gl' | 'arm', mobile: boolean): THREE.Texture {
  const key = `${id}:${kind}:${mobile}`;
  let t = textures.get(key);
  if (!t) {
    // Relative to the page (the desktop and Android builds load from a file / app origin).
    t = loader.load(`${mobile ? 'tex/m' : 'tex'}/${id}_${kind}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.setScalar(1 / TILE[id]);
    t.anisotropy = anisotropy;
    if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace;
    textures.set(key, t);
  }
  return t;
}

export interface SurfaceOptions {
  /** Mean colour the surface should have (linear). Default: the photo's own. */
  albedo?: THREE.Color;
  /**
   * 'luma' (default): only the photo's light and dark (stains, joints, cracks) over
   * `albedo`, so one set serves rooms of any colour. 'photo': the photo's own colours
   * (rust, paint chips), brightness matched to `albedo`.
   */
  mode?: 'luma' | 'photo';
  /** Scales the map's roughness (1 = as scanned). */
  roughness?: number;
  /** Scales the map's metalness (1 = as scanned; 0 for paint-over-anything). */
  metalness?: number;
  /** Normal map strength (desktop). */
  bump?: number;
}

const lumOf = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
/** Rough PBR sets drink more light than the old flat paint did: give some of it back. */
const BRIGHT = 1.3;

/**
 * The luma map stage. The fold engine (world/MaterialFold) knows it by this exact text and
 * swaps it whole for one that reads each folded material's own normaliser.
 */
const LUMA_MAP = `#ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D(map, vMapUv);
            float lumaD = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * lumaNorm;
            diffuseColor.rgb *= mix(1.0, clamp(lumaD, 0.15, 2.2), 0.85);
          #endif`;
setLumaHook(LUMA_MAP);

/**
 * One ARM fetch per pixel. The set's ARM map is the aoMap, the roughnessMap and the
 * metalnessMap at once, and three samples it three times at the very same UV (same texture,
 * same sampler, identical UV expressions): read it once and take R, G and B from that texel.
 * The same texel, so the same picture; two fetches and two texture units fewer per pixel.
 * Roughness and metalness maps come off the material (USE_AOMAP stays, the fetch uses its UV).
 */
function armOnce(m: THREE.MeshStandardMaterial): void {
  m.roughnessMap = null;
  m.metalnessMap = null;
  m.userData.arm1 = true;
  const prev = m.onBeforeCompile;
  const key = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    let fs = shader.fragmentShader;
    fs = swapOnce(fs, '#include <roughnessmap_fragment>', 'float roughnessFactor = roughness;\nvec4 texelARM = texture2D( aoMap, vAoMapUv );\nroughnessFactor *= texelARM.g;', 'ARM: roughness');
    fs = swapOnce(fs, '#include <metalnessmap_fragment>', 'float metalnessFactor = metalness;\nmetalnessFactor *= texelARM.b;', 'ARM: metalness');
    const ao = swapOnce(THREE.ShaderChunk.aomap_fragment, 'texture2D( aoMap, vAoMapUv ).r', 'texelARM.r', 'ARM: occlusion');
    shader.fragmentShader = swapOnce(fs, '#include <aomap_fragment>', ao, 'ARM: occlusion include');
  };
  m.customProgramCacheKey = () => key.call(m) + '|arm1';
}

/** A lit, grimed material from a PBR set. */
export function surface(id: SurfaceId, mobile: boolean, o: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const arm = tex(id, 'arm', mobile);
  const mode = o.mode ?? 'luma';
  const mean = MEAN_LUM[id];
  // Photo mode: a grey gain on the photo's colours; luma mode: the target colour itself.
  const color = !o.albedo ? new THREE.Color(1, 1, 1) : mode === 'photo' ? new THREE.Color(1, 1, 1).multiplyScalar(Math.min(4, (lumOf(o.albedo) * BRIGHT) / mean)) : o.albedo.clone().multiplyScalar(BRIGHT);
  const m = new THREE.MeshStandardMaterial({
    map: tex(id, 'diff', mobile),
    color,
    aoMap: arm,
    aoMapIntensity: 0.55,
    roughnessMap: arm,
    roughness: o.roughness ?? 1,
    metalnessMap: arm,
    metalness: o.metalness ?? 1,
  });
  if (!mobile) {
    m.normalMap = tex(id, 'nor_gl', mobile);
    const b = o.bump ?? 1;
    m.normalScale.set(b, b);
  }
  applyGrime(m, mobile);
  if (mode === 'luma' && o.albedo) {
    // The map contributes its luminance only, normalised so the mean stays at `albedo`
    // (contrast kept within reason: very dark photos would otherwise blow up their noise).
    const grime = m.onBeforeCompile;
    const norm = 1 / mean;
    m.userData.lumaNorm = norm;
    m.onBeforeCompile = (shader, renderer) => {
      grime.call(m, shader, renderer);
      shader.uniforms.lumaNorm = { value: norm };
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float lumaNorm;').replace('#include <map_fragment>', LUMA_MAP);
    };
    const key = m.customProgramCacheKey;
    m.customProgramCacheKey = () => key.call(m) + '|luma';
  }
  if (foldEnabled()) armOnce(m);
  return m;
}

/**
 * Weathered version of a spec-sheet colour (linear): greyer, darker, a little browner.
 * Fresh paint and clean tile read as a graybox.
 */
export function weathered(hex: string | number): THREE.Color {
  const c = new THREE.Color(hex);
  const l = lumOf(c);
  return c.lerp(new THREE.Color(l, l, l), 0.35).multiplyScalar(0.52).lerp(new THREE.Color(0.11, 0.095, 0.075), 0.12);
}
