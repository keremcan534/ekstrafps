import * as THREE from 'three';

/**
 * Muzzle fire, drawn from noise rather than shapes: a hot white core that cools through
 * yellow and orange to dull red where the gas thins (a blackbody ramp), its edges torn by
 * turbulence. Each variant has its own seed, so no two shots look alike. Generated once
 * (a few hundred milliseconds on a phone), kept for the session.
 */

/** Seeded 2-D value noise and its fractal sum (fBm), 0…1. */
function noiseField(seed: number): (x: number, y: number, octaves?: number) => number {
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = Float32Array.from({ length: 256 }, rnd);
  const v = (x: number, y: number) => vals[perm[(x & 255) + perm[y & 255]]];
  const n = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const w = yf * yf * (3 - 2 * yf);
    const a = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * u;
    const b = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * u;
    return a + (b - a) * w;
  };
  return (x, y, octaves = 4) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += n(x, y) * amp;
      norm += amp;
      amp *= 0.5;
      x = x * 2.03 + 17.1;
      y = y * 2.03 + 9.7;
    }
    return sum / norm;
  };
}

/** Fire colour for a heat 0…1+ (white → yellow → orange → red), alpha by heat. */
function fire(heat: number, out: Uint8ClampedArray, o: number): void {
  const t = Math.max(0, heat);
  const stops: [number, number, number, number][] = [
    [0.0, 90, 14, 4],
    [0.18, 190, 52, 10],
    [0.38, 255, 120, 26],
    [0.6, 255, 196, 80],
    [0.8, 255, 236, 170],
    [1.0, 255, 252, 236],
  ];
  let k = 1;
  while (k < stops.length - 1 && t > stops[k][0]) k++;
  const [t0, r0, g0, b0] = stops[k - 1];
  const [t1, r1, g1, b1] = stops[k];
  const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  out[o] = r0 + (r1 - r0) * f;
  out[o + 1] = g0 + (g1 - g0) * f;
  out[o + 2] = b0 + (b1 - b0) * f;
  // Thin gas barely shows; the core is opaque.
  const a = Math.min(1, Math.max(0, (t - 0.04) / 0.3));
  out[o + 3] = 255 * a * a * (3 - 2 * a);
}

function pixelTexture(w: number, h: number, paint: (img: ImageData) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  paint(img);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const cache = new Map<string, THREE.Texture>();
const cached = (key: string, make: () => THREE.Texture) => {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
};

/**
 * The flash seen from the front (down the bore): a white core and 4–7 ragged petals of fire
 * thrown out sideways by the expanding gas, broken up by turbulence.
 */
export const fireStarTexture = (variant: number): THREE.Texture =>
  cached(`star${variant}`, () => {
    const N = 192;
    const fbm = noiseField(1013 + variant * 7919);
    let s = (variant + 1) * 2654435761;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const count = 4 + ((rnd() * 4) | 0);
    const petals = Array.from({ length: count }, (_, k) => ({
      a: (k / count) * Math.PI * 2 + (rnd() - 0.5) * 0.7,
      len: 0.55 + rnd() * 0.45,
      w: 0.16 + rnd() * 0.18,
    }));
    return pixelTexture(N, N, (img) => {
      const d = img.data;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const u = (x + 0.5) / N * 2 - 1;
          const v = (y + 0.5) / N * 2 - 1;
          const r = Math.hypot(u, v);
          const th = Math.atan2(v, u);
          // Turbulence, sampled in the plane (no seam in angle).
          const turb = fbm(u * 3.2 + 5, v * 3.2 + 5);
          const fine = fbm(u * 9 + 11, v * 9 + 3, 3);
          let ray = 0;
          for (const p of petals) {
            let da = Math.abs(th - p.a);
            if (da > Math.PI) da = Math.PI * 2 - da;
            const across = da / (p.w * (1 + r * 0.8));
            const along = r / p.len;
            ray = Math.max(ray, Math.exp(-across * across) * Math.max(0, 1 - along * along));
          }
          const core = Math.exp(-((r / 0.15) ** 2)) * 1.2;
          const heat = core + ray * (0.25 + 1.05 * turb * turb * 1.6) * (0.7 + 0.6 * fine) - r * 0.3;
          fire(heat, d, (y * N + x) * 4);
        }
      }
    });
  });

/**
 * The flash from the side: a jet out of the muzzle (texture bottom) that balloons into a
 * fireball a third of the way out and tears into tongues toward the tip.
 */
export const fireSideTexture = (variant: number): THREE.Texture =>
  cached(`side${variant}`, () => {
    const W = 96;
    const H = 192;
    const fbm = noiseField(7717 + variant * 104729);
    return pixelTexture(W, H, (img) => {
      const d = img.data;
      for (let y = 0; y < H; y++) {
        // v: 0 at the muzzle (bottom row) … 1 at the tip.
        const v = 1 - (y + 0.5) / H;
        // Width: a narrow jet, a ball at ~0.35, tapering to the tip.
        const width = 0.1 + 0.62 * Math.sin(Math.PI * Math.min(1, v / 0.8)) ** 0.9;
        const along = Math.min(1, v / 0.05) * (1 - smoothstep(0.45, 1, v)) + 0.9 * Math.exp(-v / 0.09);
        for (let x = 0; x < W; x++) {
          const u0 = (x + 0.5) / W * 2 - 1;
          // Domain warp: the gas swirls sideways as it goes.
          const u = u0 + 0.45 * (fbm(v * 3.5 + 2, u0 * 1.5 + 7) - 0.5) * v;
          const across = u / Math.max(0.02, width);
          const turb = fbm(u0 * 2.5 + 3, v * 6 - 1);
          const fine = fbm(u0 * 7 + 1, v * 16 + 5, 3);
          // Torn into tongues: the noise eats the edges and the outer half far more than the core.
          const body = Math.exp(-across * across * 2.6);
          const torn = Math.max(0, turb * 1.6 - 0.35 - 0.5 * Math.abs(across) * v);
          const heat = body * along * (0.25 + 0.95 * torn) * (0.7 + 0.6 * fine);
          fire(heat * (0.95 - 0.35 * v), d, (y * W + x) * 4);
        }
      }
    });
  });

/** Warm bloom behind the flash. */
export const fireGlowTexture = (): THREE.Texture =>
  cached('glow', () => {
    const N = 64;
    return pixelTexture(N, N, (img) => {
      const d = img.data;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const r = Math.hypot((x + 0.5) / N * 2 - 1, (y + 0.5) / N * 2 - 1);
          const k = Math.max(0, 1 - r);
          const o = (y * N + x) * 4;
          d[o] = 255;
          d[o + 1] = 150 + 70 * k;
          d[o + 2] = 60 + 60 * k * k;
          d[o + 3] = 255 * k * k * k;
        }
      }
    });
  });

/** A soft, torn puff of grey powder smoke. */
export const smokePuffTexture = (): THREE.Texture =>
  cached('smoke', () => {
    const N = 96;
    const fbm = noiseField(4242);
    return pixelTexture(N, N, (img) => {
      const d = img.data;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const u = (x + 0.5) / N * 2 - 1;
          const v = (y + 0.5) / N * 2 - 1;
          const r = Math.hypot(u, v);
          const n = fbm(u * 2.4 + 3, v * 2.4 + 8);
          const k = Math.max(0, 1 - r * (1.15 - 0.5 * n)) * (0.4 + 0.9 * n);
          const o = (y * N + x) * 4;
          const g = 150 + 60 * n;
          d[o] = g;
          d[o + 1] = g;
          d[o + 2] = g + 6;
          d[o + 3] = 255 * Math.min(1, k * k * 1.6);
        }
      }
    });
  });

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
