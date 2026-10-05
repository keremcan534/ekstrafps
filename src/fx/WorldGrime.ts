import * as THREE from 'three';

/**
 * Wear on the world, in the shader (no art assets, no extra geometry, no extra draw calls):
 * every grimed material samples one small tiling noise texture in world space and gets
 * - large stains and damp blotches (≈16 m scale),
 * - long vertical run-off streaks on walls,
 * - dirt rising up from the floor along wall bases,
 * - fine scuffs (desktop),
 * - wet sheen in some floor patches (low roughness: the light pools and IBL catch it),
 * - ceiling water stains.
 * Dirt darkens and browns the albedo and roughens it. All grimed materials share one
 * program (same cache key, same uniforms), so this adds no shader variants per surface.
 */

const SIZE = 256;

/** Tileable value noise: lattice of `period` cells over SIZE pixels, smooth-interpolated. */
function noiseLayer(period: number, seed: number): Float32Array {
  const lat = new Float32Array(period * period);
  let s = seed;
  for (let i = 0; i < lat.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    lat[i] = s / 4294967296;
  }
  const out = new Float32Array(SIZE * SIZE);
  const cell = SIZE / period;
  for (let y = 0; y < SIZE; y++) {
    const gy = y / cell;
    const y0 = Math.floor(gy) % period;
    const y1 = (y0 + 1) % period;
    let ty = gy - Math.floor(gy);
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < SIZE; x++) {
      const gx = x / cell;
      const x0 = Math.floor(gx) % period;
      const x1 = (x0 + 1) % period;
      let tx = gx - Math.floor(gx);
      tx = tx * tx * (3 - 2 * tx);
      const a = lat[y0 * period + x0] + (lat[y0 * period + x1] - lat[y0 * period + x0]) * tx;
      const b = lat[y1 * period + x0] + (lat[y1 * period + x1] - lat[y1 * period + x0]) * tx;
      out[y * SIZE + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fbm(periods: number[], seed: number): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  let amp = 1;
  let total = 0;
  periods.forEach((p, k) => {
    const l = noiseLayer(p, seed + k * 7919);
    for (let i = 0; i < out.length; i++) out[i] += l[i] * amp;
    total += amp;
    amp *= 0.5;
  });
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

let texture: THREE.DataTexture | null = null;

/** R: stains, G: streaks / wet patches, B: fine scuffs. Built once (~10 ms). */
function grimeTexture(): THREE.DataTexture {
  if (texture) return texture;
  const r = fbm([4, 8, 16, 32], 11);
  const g = fbm([8, 16, 32, 64], 23);
  const b = fbm([32, 64, 128], 37);
  const data = new Uint8Array(SIZE * SIZE * 4);
  // Stretch each channel's contrast around its mean (fbm bunches up near 0.5).
  const norm = (v: number) => Math.max(0, Math.min(255, Math.round(((v - 0.5) * 2.2 + 0.5) * 255)));
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = norm(r[i]);
    data[i * 4 + 1] = norm(g[i]);
    data[i * 4 + 2] = norm(b[i]);
    data[i * 4 + 3] = 255;
  }
  texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Shared by every grimed material (one tweak moves them all). */
export const grimeUniforms = {
  grimeMap: { value: null as THREE.Texture | null },
  /** Overall dirt strength. */
  grimeAmount: { value: 1 },
  /** Floor height (wall-base dirt rises from here). */
  grimeFloor: { value: 0 },
  /** Wet floor patches (0 = none). */
  grimeWet: { value: 1 },
};

/**
 * Add world-space grime to a lit material. `lite` (phones): two texture reads instead of
 * three (no fine scuffs). Safe to call more than once on the same material.
 */
export function applyGrime(mat: THREE.Material, lite = false): void {
  const m = mat as THREE.MeshStandardMaterial & { userData: { grime?: boolean } };
  if (m.userData.grime || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  m.userData.grime = true;
  grimeUniforms.grimeMap.value ??= grimeTexture();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grimeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrimeP;\nvarying vec3 vGrimeN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGrimeP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGrimeN = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGrimeP;
        varying vec3 vGrimeN;
        uniform sampler2D grimeMap;
        uniform float grimeAmount;
        uniform float grimeFloor;
        uniform float grimeWet;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 gN = normalize(vGrimeN);
        vec3 gA = abs(gN);
        // Planar projection by the dominant axis (floors/ceilings XZ, walls ZY or XY).
        vec2 gUv = gA.y > 0.6 ? vGrimeP.xz : (gA.x > gA.z ? vGrimeP.zy : vGrimeP.xy);
        float gWall = 1.0 - smoothstep(0.35, 0.6, gA.y);
        vec3 gBig = texture2D(grimeMap, gUv * 0.06).rgb;
        float dirt = smoothstep(0.45, 0.9, gBig.r) * 0.7;
        // Run-off streaks: the streak channel stretched 30x along the height.
        float gStreak = texture2D(grimeMap, vec2(gUv.x * 0.5, vGrimeP.y * 0.016)).g;
        dirt += gWall * smoothstep(0.6, 0.92, gStreak) * 0.5;
        // Dirt up from the floor along the base of walls.
        dirt += gWall * (1.0 - smoothstep(0.0, 1.1, vGrimeP.y - grimeFloor)) * 0.42;
        #ifndef GRIME_LITE
          dirt += (texture2D(grimeMap, gUv * 0.41 + 0.37).b - 0.5) * 0.3;
        #endif
        // Ceilings: water stains (the stain channel, browner).
        float gCeil = smoothstep(0.6, 0.9, -gN.y);
        dirt = clamp(dirt * grimeAmount, 0.0, 1.0);
        diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.6, 0.57, 0.52), vec3(0.55, 0.47, 0.36), gCeil), dirt);
        // Wet patches on floors: darker, and glossy below.
        float gWetK = grimeWet * smoothstep(0.6, 0.9, gN.y) * smoothstep(0.74, 0.86, gBig.g);
        diffuseColor.rgb *= 1.0 - 0.28 * gWetK;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(clamp(roughnessFactor + dirt * 0.22, 0.0, 1.0), 0.14, gWetK);`,
      );
    if (lite) shader.fragmentShader = '#define GRIME_LITE\n' + shader.fragmentShader;
  };
  m.customProgramCacheKey = () => (lite ? 'grime-lite' : 'grime');
  m.needsUpdate = true;
}
