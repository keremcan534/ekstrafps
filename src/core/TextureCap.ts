import * as THREE from 'three';

const SLOTS = ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;

/**
 * Shrink a loaded model's textures in place, before they reach the GPU: the base colour map
 * to at most `colour` px, every other map to `maps`. For files shared with the desktop (the
 * third-person guns) that would cost a phone ~33 MB of GPU memory each at full size; files
 * only phones load are shrunk on disk instead (scripts/shrink-textures.mjs).
 */
export function capTextures(materials: THREE.Material[], colour: number, maps: number): void {
  const done = new Set<THREE.Texture>();
  for (const m of materials) {
    const mat = m as THREE.MeshStandardMaterial;
    if (mat.map) shrink(mat.map, colour, done);
    for (const k of SLOTS) {
      const t = mat[k];
      if (t) shrink(t, maps, done);
    }
  }
}

function shrink(tex: THREE.Texture, size: number, done: Set<THREE.Texture>): void {
  if (done.has(tex)) return;
  done.add(tex);
  const img = tex.image as (ImageBitmap | HTMLImageElement | HTMLCanvasElement) & { close?: () => void };
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h || Math.max(w, h) <= size) return;
  const k = size / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d');
  if (!g) return;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  tex.image = c;
  tex.needsUpdate = true;
}
