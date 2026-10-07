import * as THREE from 'three';

/**
 * Surface detail for the gun models in hand. They are low-poly with one flat palette colour
 * per face, so up close they read as smooth plastic. This shader patch gives each surface
 * what its colour says it is:
 *
 *   wood     (warm, saturated)   grain running along the gun, pores, a satin oil finish
 *   steel    (mid greys)          darkened to gunmetal, a fine brushed texture, worn lighter
 *                                and smoother in patches, partly metallic
 *   coating  (dark greys, black)  polymer / anodised: a stipple, matte
 *
 * and over all of it the field wear of a gun carried at Site-9: grime, dust and frost rime on
 * the faces that look up (model +Y), worn-through scratches,
 * plus a small bump from the same noise, so light breaks up on every face. The noise is 3-D,
 * in the model's own space and scaled to metres (whatever units the file uses), so it stays
 * on the gun as it moves and no face shows a seam. Light colours (sight dots, markings)
 * are left alone.
 */

const COMMON = /* glsl */ `
varying vec3 vGunPos;
varying vec3 vGunNrm;
uniform vec3 uGunGrain;
float gunHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gunNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(gunHash(i), gunHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(gunHash(i + vec3(0.0, 1.0, 0.0)), gunHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(gunHash(i + vec3(0.0, 0.0, 1.0)), gunHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(gunHash(i + vec3(0.0, 1.0, 1.0)), gunHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float gunFbm(vec3 p) {
  return 0.5 * gunNoise(p) + 0.3 * gunNoise(p * 2.07 + 3.1) + 0.2 * gunNoise(p * 4.13 + 7.7);
}
`;

const VERTEX = /* glsl */ `
#include <begin_vertex>
// Model space, in metres: the model matrix's scale turns file units into metres.
vGunPos = position * length(vec3(modelMatrix[0]));
vGunNrm = normal;
`;

/** After the colour map: classify, tint, and leave roughness / metalness / height for later. */
const COLOUR = /* glsl */ `
#include <map_fragment>
vec3 gunC = diffuseColor.rgb;
float gunMax = max(gunC.r, max(gunC.g, gunC.b));
float gunSat = (gunMax - min(gunC.r, min(gunC.g, gunC.b))) / max(gunMax, 1e-4);
float gunLum = dot(gunC, vec3(0.2126, 0.7152, 0.0722));
float gunMark = smoothstep(0.35, 0.6, gunLum);
float gunWood = smoothstep(0.3, 0.45, gunSat) * step(gunC.b + 0.005, gunC.r) * (1.0 - gunMark);
float gunSteel = (1.0 - gunWood) * smoothstep(0.035, 0.07, gunLum) * (1.0 - gunMark);
float gunCoat = (1.0 - gunWood) * (1.0 - gunSteel) * (1.0 - gunMark);
vec3 gp = vGunPos;
// Each face is one palette colour, so these branches are coherent: a surface pays only
// for its own kind of detail.
vec3 gunTint = vec3(1.0);
float gunRough = 0.0;
float gunMetal = 0.0;
float gunHeight = 0.0;
float gunBlotch = gunFbm(gp * 60.0);
if (gunWood > 0.001) {
  // Fibres along the gun (noise stretched along uGunGrain), warped; darker late-wood streaks; pores.
  float gunAlong = dot(gp, uGunGrain);
  float gunAcrossS = dot(gp - gunAlong * uGunGrain, vec3(1.0));
  float gunWarp = gunFbm(vec3(gunAlong * 3.0, gunAcrossS * 25.0, 0.5));
  float gunRing = gunNoise(vec3(gunAlong * 5.0, (gunAcrossS + gunWarp * 0.012) * 260.0, 1.7));
  float gunGrain = smoothstep(0.25, 0.85, gunNoise(vec3(gunAlong * 14.0, (gunAcrossS + gunWarp * 0.01) * 450.0, 4.3)));
  float gunPore = gunNoise(gp * 500.0);
  gunTint = mix(gunTint, vec3(0.86 + 0.14 * gunGrain - 0.18 * smoothstep(0.55, 0.9, gunRing)) * (0.95 + 0.1 * gunPore), gunWood);
  gunRough += gunWood * (0.62 - 0.12 * gunGrain + 0.1 * gunPore);
  gunHeight += gunWood * (gunRing * 0.6 + gunGrain * 0.4);
}
if (gunSteel > 0.001) {
  // Fine brushing along the gun, broad wear (lighter, smoother).
  float gunAlong = dot(gp, uGunGrain);
  vec3 gunAcross = gp - gunAlong * uGunGrain;
  float gunBrush = gunNoise(vec3(gunAlong * 40.0, gunAcross.x * 700.0, (gunAcross.y + gunAcross.z) * 700.0));
  float gunWear = smoothstep(0.62, 0.8, gunFbm(gp * 28.0));
  gunTint = mix(gunTint, vec3(0.46 + 0.14 * gunBlotch + 0.28 * gunWear) * (0.95 + 0.1 * gunBrush), gunSteel);
  gunRough += gunSteel * (0.52 + 0.18 * gunBlotch - 0.22 * gunWear + 0.08 * gunBrush);
  gunMetal += gunSteel * (0.65 + 0.2 * gunWear);
  gunHeight += gunSteel * (gunBlotch * 0.7 + gunWear * 0.3);
}
if (gunCoat > 0.001) {
  // Polymer / anodised: a stipple, matte.
  float gunStip = gunNoise(gp * 600.0);
  gunTint = mix(gunTint, vec3(0.9 + 0.2 * gunBlotch) * (0.96 + 0.08 * gunStip), gunCoat);
  gunRough += gunCoat * (0.72 + 0.12 * gunStip + 0.08 * gunBlotch);
  gunMetal += gunCoat * 0.15;
  gunHeight += gunCoat * (gunBlotch * 0.6 + gunStip * 0.4);
}
diffuseColor.rgb *= gunTint;
// Height for the bump: only what is a few pixels wide even at the hip (no shimmer).
float gunApply = 1.0 - gunMark;
// Field wear (Site-9, -30 C): greasy grime in broad patches, dust and frost rime settled on
// the faces that look up, ice crystals glinting in the rime, bright scratches where a
// coating or bluing is worn through. Model space, so it stays on the gun.
float gunUp = normalize(vGunNrm).y;
float gunTop = smoothstep(0.3, 0.95, gunUp);
float gunUnder = smoothstep(0.2, 0.9, -gunUp);
// Fine grain, not blobs: a film with specks reads as dirt, big patches read as camouflage.
float gunFine = gunNoise(gp * 220.0 + 17.0);
float gunMid = gunFbm(gp * 30.0 + 31.0);
float gunDust = gunTop * (0.35 + 0.65 * smoothstep(0.4, 0.8, gunMid)) * (0.75 + 0.25 * gunFine);
// Dirt toward a dark earth brown: on black it reads as dried grime, on wood as dark stains.
float gunDirt = 0.25 * smoothstep(0.35, 0.85, gunFbm(gp * 9.0 + 3.0)) + 0.35 * gunUnder + 0.2 * smoothstep(0.7, 0.95, gunFine);
float gunFrost = gunTop * smoothstep(0.55, 0.85, gunMid);
float gunIce = step(0.93, gunNoise(gp * 1500.0)) * gunTop * (0.2 + 0.8 * gunFrost);
float gunScratch = smoothstep(0.93, 0.985, gunNoise(vec3(dot(gp, vec3(0.8, 0.3, 0.52)) * 900.0, dot(gp, vec3(-0.3, 0.9, 0.2)) * 14.0, 3.3))) * (gunSteel + gunCoat);
vec3 gunWorn = mix(diffuseColor.rgb, vec3(0.16, 0.14, 0.11), gunDirt * 0.4);
gunWorn = mix(gunWorn, vec3(0.27, 0.26, 0.245), gunDust * 0.16);
gunWorn = mix(gunWorn, vec3(0.7, 0.76, 0.83), gunFrost * 0.11);
gunWorn += vec3(0.18, 0.2, 0.23) * gunIce;
gunWorn = mix(gunWorn, gunWorn * 1.7 + 0.04, gunScratch * 0.65);
diffuseColor.rgb = mix(diffuseColor.rgb, gunWorn, gunApply);
gunRough += 0.12 * gunDirt + 0.15 * gunDust + 0.2 * gunFrost - 0.25 * gunScratch;
gunMetal += 0.4 * gunScratch * gunCoat - 0.35 * gunFrost - 0.15 * gunDust;
gunHeight += 0.4 * gunFrost + 0.2 * gunDirt;
`;

const ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, clamp(gunRough, 0.0, 1.0), gunApply);
`;

const METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, clamp(gunMetal, 0.0, 1.0), gunApply);
`;

/** A bump from the height (screen-space derivatives), small: light breaks up, nothing shimmers. */
const BUMP = /* glsl */ `
#include <normal_fragment_maps>
{
  vec2 dH = vec2(dFdx(gunHeight), dFdy(gunHeight)) * 0.35 * gunApply;
  vec3 vSigmaX = normalize(dFdx(-vViewPosition));
  vec3 vSigmaY = normalize(dFdy(-vViewPosition));
  vec3 R1 = cross(vSigmaY, normal);
  vec3 R2 = cross(normal, vSigmaX);
  float fDet = dot(vSigmaX, R1);
  vec3 vGrad = sign(fDet) * (dH.x * R1 + dH.y * R2);
  normal = normalize(abs(fDet) * normal - vGrad);
}
`;

/**
 * Give a gun material the surface detail. `grain`: the gun's length axis in the model's own
 * space (wood grain runs along it). Idempotent.
 */
export function dressGunMaterial(material: THREE.Material, grain: THREE.Vector3): void {
  const m = material as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.userData.gunSurface) return;
  m.userData.gunSurface = true;
  const g = grain.clone().normalize();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGunGrain = { value: g };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vGunPos;\nvarying vec3 vGunNrm;`).replace('#include <begin_vertex>', VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}`)
      .replace('#include <map_fragment>', COLOUR)
      .replace('#include <roughnessmap_fragment>', ROUGH)
      .replace('#include <metalnessmap_fragment>', METAL)
      .replace('#include <normal_fragment_maps>', BUMP);
  };
  // A distinct program from undressed materials with the same settings.
  m.customProgramCacheKey = () => 'gunSurface';
  m.needsUpdate = true;
}
