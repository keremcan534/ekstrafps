import * as THREE from 'three';

/**
 * Procedurally generated textures, so the lab needs zero art assets.
 *
 * Every texture keeps its canvas (texture.image): a lost WebGL context is
 * restored by re-uploading them, so the canvases are never freed.
 */

/** Anisotropic filtering cap (Graphics settings / phones); each texture uses min(its own level, this). */
let anisoCap = Infinity;

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true, aniso = 4): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.aniso = aniso;
  tex.anisotropy = Math.max(1, Math.min(aniso, anisoCap));
  return tex;
}

const cache: Record<string, THREE.Texture> = {};
const cached = (key: string, make: () => THREE.Texture): THREE.Texture => (cache[key] ??= make());

/**
 * Cap anisotropic filtering (1 = off). Applies to the textures made from now on
 * and to the cached ones (re-uploaded only when their level actually changes).
 */
export function setTextureAnisotropy(n: number): void {
  anisoCap = Math.max(1, n);
  for (const t of Object.values(cache)) {
    const want = Math.max(1, Math.min((t.userData.aniso as number | undefined) ?? 4, anisoCap));
    if (t.anisotropy === want) continue;
    t.anisotropy = want;
    t.needsUpdate = true;
  }
}

/** Front-facing muzzle flash star. */
export const flashStarTexture = (): THREE.Texture =>
  cached('flashStar', () =>
    canvasTexture(128, (ctx, s) => {
      const c = s / 2;
      ctx.translate(c, c);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
      g.addColorStop(0, 'rgba(255,255,240,1)');
      g.addColorStop(0.18, 'rgba(255,220,140,0.95)');
      g.addColorStop(0.45, 'rgba(255,140,40,0.35)');
      g.addColorStop(1, 'rgba(255,90,0,0)');
      ctx.fillStyle = g;
      const spikes = 7;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? c * (0.85 + Math.random() * 0.15) : c * 0.28;
        const a = (i / (spikes * 2)) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, c * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }),
  );

/** Side-view flame (elongated along +Y of the texture). */
export const flashSideTexture = (): THREE.Texture =>
  cached('flashSide', () =>
    canvasTexture(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s * 0.85, 0, s / 2, s * 0.6, s * 0.6);
      g.addColorStop(0, 'rgba(255,250,230,1)');
      g.addColorStop(0.3, 'rgba(255,190,90,0.8)');
      g.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(s / 2, 0);
      ctx.quadraticCurveTo(s * 0.85, s * 0.6, s / 2, s);
      ctx.quadraticCurveTo(s * 0.15, s * 0.6, s / 2, 0);
      ctx.fill();
    }),
  );

export const bulletHoleTexture = (): THREE.Texture =>
  cached('bulletHole', () =>
    canvasTexture(64, (ctx, s) => {
      const c = s / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, 'rgba(5,5,5,1)');
      g.addColorStop(0.22, 'rgba(15,15,15,0.95)');
      g.addColorStop(0.4, 'rgba(40,38,36,0.6)');
      g.addColorStop(1, 'rgba(60,58,55,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(20,20,20,0.5)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * 6, c + Math.sin(a) * 6);
        ctx.lineTo(c + Math.cos(a) * (12 + Math.random() * 14), c + Math.sin(a) * (12 + Math.random() * 14));
        ctx.stroke();
      }
    }),
  );

export const metalDentTexture = (): THREE.Texture =>
  cached('metalDent', () =>
    canvasTexture(64, (ctx, s) => {
      const c = s / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, 'rgba(20,20,22,1)');
      g.addColorStop(0.18, 'rgba(70,70,75,1)');
      g.addColorStop(0.32, 'rgba(210,210,215,0.9)');
      g.addColorStop(0.5, 'rgba(150,150,155,0.35)');
      g.addColorStop(1, 'rgba(120,120,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }),
  );

/**
 * Worn panel grid: 1 tile = 1 metre (helps read speed and distance). The texture
 * holds 2×2 slightly different tiles (spans 2 m) with grime blotches, scuffs and
 * speckle, so large surfaces don't read as clean plastic.
 */
export const gridTexture = (base: string, line: string, accent: string): THREE.Texture => cached(`grid_${base}_${line}`, () => makeGrid(512, base, line, accent));

/**
 * Neutral grey panel grid (the same pattern as gridTexture), tinted per surface
 * with material.color = gridTint(base): one texture for every room instead of
 * one per colour. `size` 256 on phones (drawn at 512 scale, scaled down).
 */
export const neutralGridTexture = (size = 512): THREE.Texture => cached(`grid_neutral_${size}`, () => makeGrid(size, NEUTRAL, NEUTRAL_LINE, NEUTRAL_ACCENT));

const NEUTRAL = '#a8a8a8';
/** Seam and accent lines: the per-colour grids use about 86 % / 94 % of the base. */
const NEUTRAL_LINE = '#919191';
const NEUTRAL_ACCENT = '#9e9e9e';
let neutralLinear = 0;

/** Material colour that turns the neutral grid into a `base`-coloured one (linear: may exceed 1). */
export function gridTint(base: string): THREE.Color {
  neutralLinear ||= new THREE.Color(NEUTRAL).r;
  return new THREE.Color(base).multiplyScalar(1 / neutralLinear);
}

function makeGrid(size: number, base: string, line: string, accent: string): THREE.Texture {
  const t = canvasTexture(size, (ctx, sz) => {
    // Drawn in 512 units whatever the size (same pattern at 256).
    ctx.scale(sz / 512, sz / 512);
    const s = 512;
    const h = s / 2;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    // Per-tile tone shift.
    for (let i = 0; i < 4; i++) {
      const v = (Math.random() - 0.5) * 14;
      ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v / 255})` : `rgba(0,0,0,${-v / 255})`;
      ctx.fillRect((i % 2) * h, Math.floor(i / 2) * h, h, h);
    }
    // Low-frequency grime blotches.
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      const r = 20 + Math.random() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.03 + Math.random() * 0.06;
      g.addColorStop(0, `rgba(40,34,28,${a})`);
      g.addColorStop(1, 'rgba(40,34,28,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Speckle.
    for (let i = 0; i < 5200; i++) {
      const v = Math.random() * 26 - 13;
      ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v / 255})` : `rgba(0,0,0,${-v / 255})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    // Scuffs and scratches.
    ctx.lineCap = 'round';
    for (let i = 0; i < 34; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      const a = Math.random() * Math.PI;
      const l = 8 + Math.random() * 46;
      ctx.strokeStyle = Math.random() < 0.7 ? `rgba(0,0,0,${0.05 + Math.random() * 0.08})` : `rgba(255,255,255,${0.04 + Math.random() * 0.06})`;
      ctx.lineWidth = 1 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }
    // Panel seams: dark line + a thin highlight (reads as a bevel).
    for (const o of [0, h]) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(o + 1, 0);
      ctx.lineTo(o + 1, s);
      ctx.moveTo(0, o + 1);
      ctx.lineTo(s, o + 1);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(o + 3.5, 0);
      ctx.lineTo(o + 3.5, s);
      ctx.moveTo(0, o + 3.5);
      ctx.lineTo(s, o + 3.5);
      ctx.stroke();
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const o of [h / 2, h * 1.5]) {
      ctx.moveTo(o, 0);
      ctx.lineTo(o, s);
      ctx.moveTo(0, o);
      ctx.lineTo(s, o);
    }
    ctx.stroke();
  }, true, 8);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.5, 0.5);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Roughness variation (spans 4 m): smudges and wear break up uniform specular highlights. */
export const grimeRoughness = (): THREE.Texture =>
  cached('grimeRough', () => {
    const t = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = '#c8c8c8';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 70; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const r = 8 + Math.random() * 50;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const v = Math.random() < 0.5 ? 255 : 120;
        g.addColorStop(0, `rgba(${v},${v},${v},${0.15 + Math.random() * 0.25})`);
        g.addColorStop(1, `rgba(${v},${v},${v},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < 3000; i++) {
        const v = 150 + Math.random() * 105;
        ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
      }
    }, false);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.25, 0.25);
    return t;
  });

/** Text label texture (distance markers). */
export function labelTexture(text: string, color = '#ffb020', bg = 'rgba(15,16,18,0.92)'): THREE.Texture {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, s * 0.2, s, s * 0.6);
    ctx.fillStyle = color;
    ctx.fillRect(0, s * 0.2, s, 10);
    ctx.fillRect(0, s * 0.8 - 10, s, 10);
    ctx.font = `bold ${s * 0.34}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, s / 2, s / 2 + 4);
  });
}

// ---------------------------------------------------------------- weapon surfaces

function weaponCanvas(key: string, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.Texture {
  return cached(key, () => {
    const t = canvasTexture(256, draw, srgb);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Worn metal: speckle, fine brushing and light edge scratches. Neutral, tinted by material colour. */
export const metalTexture = (): THREE.Texture =>
  weaponCanvas('wpn_metal', (ctx, s) => {
    ctx.fillStyle = '#d6d6d6';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = rnd(150, 255) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
    }
    for (let i = 0; i < 70; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${rnd(0.05, 0.12)})`;
      const y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y + rnd(-3, 3));
      ctx.stroke();
    }
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${rnd(0.25, 0.5)})`;
      ctx.lineWidth = rnd(0.5, 1.2);
      const x = Math.random() * s;
      const y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rnd(-25, 25), y + rnd(-8, 8));
      ctx.stroke();
    }
  });

/** Roughness for metal: polished scratches are smoother than the matte finish. */
export const metalRoughness = (): THREE.Texture =>
  weaponCanvas(
    'wpn_metal_rough',
    (ctx, s) => {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 1800; i++) {
        const v = rnd(110, 190) | 0;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
      for (let i = 0; i < 40; i++) {
        ctx.strokeStyle = 'rgba(40,40,40,0.6)';
        const x = Math.random() * s;
        const y = Math.random() * s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + rnd(-30, 30), y + rnd(-6, 6));
        ctx.stroke();
      }
    },
    false,
  );

/** Wood grain running along U (the long axis of stocks). Tinted per wood type. */
export const woodTexture = (): THREE.Texture =>
  weaponCanvas('wpn_wood', (ctx, s) => {
    ctx.fillStyle = '#e9d2b4';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const y0 = Math.random() * s;
      const amp = rnd(1, 6);
      const freq = rnd(0.01, 0.04);
      const ph = Math.random() * 10;
      ctx.strokeStyle = `rgba(${rnd(90, 140) | 0},${rnd(50, 80) | 0},${rnd(20, 40) | 0},${rnd(0.12, 0.35)})`;
      ctx.lineWidth = rnd(0.6, 2.5);
      ctx.beginPath();
      for (let x = 0; x <= s; x += 4) {
        const y = y0 + Math.sin(x * freq + ph) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // a couple of knots
    for (let i = 0; i < 2; i++) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
      g.addColorStop(0, 'rgba(70,35,15,0.5)');
      g.addColorStop(1, 'rgba(70,35,15,0)');
      ctx.save();
      ctx.translate(Math.random() * s, Math.random() * s);
      ctx.scale(2.5, 1);
      ctx.fillStyle = g;
      ctx.fillRect(-12, -12, 24, 24);
      ctx.restore();
    }
  });

/** Polymer stipple. */
export const polymerTexture = (): THREE.Texture =>
  weaponCanvas('wpn_polymer', (ctx, s) => {
    ctx.fillStyle = '#d0d0d0';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 6000; i++) {
      const v = rnd(150, 255) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
    }
  });

/** Muzzle flash star with a random spike pattern (several variants are generated). */
export const flashVariant = (i: number): THREE.Texture =>
  cached(`flash_v${i}`, () =>
    canvasTexture(128, (ctx, s) => {
      const c = s / 2;
      ctx.translate(c, c);
      ctx.globalCompositeOperation = 'lighter';
      const spikes = 5 + ((Math.random() * 5) | 0);
      for (let k = 0; k < spikes; k++) {
        const a = (k / spikes) * Math.PI * 2 + rnd(-0.25, 0.25);
        const len = c * rnd(0.55, 1.0);
        const w = rnd(4, 9);
        const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
        g.addColorStop(0, 'rgba(255,250,225,0.95)');
        g.addColorStop(0.35, 'rgba(255,190,90,0.7)');
        g.addColorStop(1, 'rgba(255,90,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.lineTo(Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w);
        ctx.fill();
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.45);
      core.addColorStop(0, 'rgba(255,255,245,1)');
      core.addColorStop(0.4, 'rgba(255,215,140,0.85)');
      core.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = core;
      ctx.fillRect(-c, -c, s, s);
    }),
  );

/** Soft round glow (muzzle bloom). */
export const glowTexture = (): THREE.Texture =>
  cached('glow', () =>
    canvasTexture(64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,230,180,1)');
      g.addColorStop(0.3, 'rgba(255,170,80,0.45)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }),
  );

/** Corrugated steel (shipping containers): vertical ribs, rust streaks, grime. 1 tile = 1 m. */
export const corrugatedTexture = (base: string): THREE.Texture =>
  cached(`corr_${base}`, () => {
    const t = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);
      const ribs = 4;
      for (let i = 0; i < ribs; i++) {
        const x = (i / ribs) * s;
        const g = ctx.createLinearGradient(x, 0, x + s / ribs, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.35)');
        g.addColorStop(0.3, 'rgba(255,255,255,0.10)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.02)');
        g.addColorStop(0.8, 'rgba(0,0,0,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0.35)');
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, s / ribs, s);
      }
      for (let i = 0; i < 9; i++) {
        ctx.fillStyle = `rgba(${90 + Math.random() * 40},${40 + Math.random() * 20},20,${0.08 + Math.random() * 0.12})`;
        ctx.fillRect(Math.random() * s, Math.random() * s * 0.4, 2 + Math.random() * 4, s * (0.3 + Math.random() * 0.6));
      }
      for (let i = 0; i < 900; i++) {
        const v = Math.random() * 22 - 11;
        ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v / 255})` : `rgba(0,0,0,${-v / 255})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
