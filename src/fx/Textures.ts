import * as THREE from 'three';

/** Procedurally generated textures, so the lab needs zero art assets. */

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const cache: Record<string, THREE.Texture> = {};
const cached = (key: string, make: () => THREE.Texture): THREE.Texture => (cache[key] ??= make());

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

/** Graybox grid: 1 texture repeat = 1 metre. Helps read speed and distance. */
export const gridTexture = (base: string, line: string, accent: string): THREE.Texture =>
  cached(`grid_${base}_${line}`, () => {
    const t = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);
      // subtle noise so surfaces aren't flat
      for (let i = 0; i < 1400; i++) {
        const v = Math.random() * 18 - 9;
        ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v / 255})` : `rgba(0,0,0,${-v / 255})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, s - 2, s - 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s / 2, 0);
      ctx.lineTo(s / 2, s);
      ctx.moveTo(0, s / 2);
      ctx.lineTo(s, s / 2);
      ctx.stroke();
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
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
