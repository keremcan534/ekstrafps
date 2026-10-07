import * as THREE from 'three';
import { MOBILE_ANISOTROPY } from '../config/Graphics';

/**
 * Every printed thing on Site-9 in one canvas texture: wall signs, posters, boards,
 * lit status panels and the alpha decals (cracks, scorch, oil, frost, graffiti, floor
 * stencils). One texture, a few materials over it, so a room's signs and decals
 * cost one draw call per material however many there are.
 *
 * Cells are on a 112 px grid (18 × 30 on the 2048 × 3360 desktop sheet, drawn at half
 * size on phones). Opaque entries are drawn edge to edge; decals keep a transparent
 * background and are faded at their borders.
 */

const SHEET = 2048;
const UNIT = 112;
const COLS = 18;
const ROWS = 30;
const SHEET_H = ROWS * UNIT;
/** Texels kept clear around each cell (mip bleed). */
const GUTTER = 4;

type Draw = (g: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => void;

interface Entry {
  id: string;
  w: number;
  h: number;
  draw: Draw;
}

const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';
const STENCIL = '"Arial Black", "Segoe UI Black", Impact, sans-serif';

/** Set a font that makes `text` fit `maxW` (shrinks from `size`). */
function fit(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 700, family = FONT): void {
  let s = size;
  for (;;) {
    g.font = `${weight} ${s}px ${family}`;
    if (g.measureText(text).width <= maxW || s <= 8) return;
    s -= 2;
  }
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number, size: number, color: string, weight = 700, align: CanvasTextAlign = 'left', family = FONT): void {
  fit(g, s, maxW, size, weight, family);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

/** Print wear: specks, scuffs and a darkened rim. */
function age(g: CanvasRenderingContext2D, w: number, h: number, rnd: () => number, k = 1): void {
  for (let i = 0; i < 260 * k * ((w * h) / (UNIT * UNIT * 4)); i++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(40,32,24,${0.05 + rnd() * 0.12})` : `rgba(255,255,255,${0.04 + rnd() * 0.08})`;
    const s = 1 + rnd() * 3;
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }
  for (let i = 0; i < 6 * k; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.08 + rnd() * 0.1})`;
    g.lineWidth = 1;
    g.beginPath();
    const x = rnd() * w;
    const y = rnd() * h;
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 60, y + (rnd() - 0.5) * 20);
    g.stroke();
  }
  const rim = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  rim.addColorStop(0, 'rgba(30,24,16,0)');
  rim.addColorStop(1, `rgba(30,24,16,${0.28 * k})`);
  g.fillStyle = rim;
  g.fillRect(0, 0, w, h);
}

function stripes(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a = '#e0a51c', b = '#151515', step = 28): void {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = a;
  g.fillRect(x, y, w, h);
  g.fillStyle = b;
  for (let i = -h; i < w + h; i += step * 2) {
    g.beginPath();
    g.moveTo(x + i, y + h);
    g.lineTo(x + i + step, y + h);
    g.lineTo(x + i + step + h, y);
    g.lineTo(x + i + h, y);
    g.fill();
  }
  g.restore();
}

function triangle(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, stroke: string): void {
  g.beginPath();
  g.moveTo(cx, cy - r);
  g.lineTo(cx + r * 0.95, cy + r * 0.72);
  g.lineTo(cx - r * 0.95, cy + r * 0.72);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = r * 0.12;
  g.lineJoin = 'round';
  g.strokeStyle = stroke;
  g.stroke();
}

/** The Vanta mark: a double chevron, `s` = half width. */
export function vLogo(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string): void {
  g.fillStyle = color;
  const poly = (pts: [number, number][]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(cx + x * s, cy + y * s) : g.moveTo(cx + x * s, cy + y * s)));
    g.closePath();
    g.fill();
  };
  poly([[-1, -0.75], [-0.62, -0.75], [0, 0.42], [0.62, -0.75], [1, -0.75], [0, 0.95]]);
  poly([[-0.42, -0.75], [-0.18, -0.75], [0, -0.38], [0.18, -0.75], [0.42, -0.75], [0, 0.05]]);
}

/** Irregular blob path (decals). */
function blob(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, rnd: () => number, lumps = 14): void {
  g.beginPath();
  const k = [...Array(lumps)].map(() => 0.65 + rnd() * 0.45);
  for (let i = 0; i <= lumps * 4; i++) {
    const a = (i / (lumps * 4)) * Math.PI * 2;
    const f = a / (Math.PI * 2) * lumps;
    const i0 = Math.floor(f) % lumps;
    const i1 = (i0 + 1) % lumps;
    const t = f - Math.floor(f);
    const rr = r * (k[i0] * (1 - t) + k[i1] * t);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** Sprayed text: soft overspray, a hard core, drips. */
function spray(g: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number, size: number, color: string, rnd: () => number): void {
  fit(g, s, maxW, size, 900, STENCIL);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.save();
  g.shadowColor = color;
  g.shadowBlur = size * 0.25;
  g.globalAlpha = 0.55;
  g.fillStyle = color;
  g.fillText(s, x, y);
  g.restore();
  g.save();
  g.globalAlpha = 0.85;
  g.fillStyle = color;
  g.fillText(s, x + (rnd() - 0.5) * 2, y + (rnd() - 0.5) * 2);
  g.restore();
  const tw = g.measureText(s).width;
  g.strokeStyle = color;
  g.globalAlpha = 0.6;
  for (let i = 0; i < Math.max(3, s.length / 2); i++) {
    const dx = x + rnd() * tw;
    g.lineWidth = 1.5 + rnd() * 2;
    g.beginPath();
    g.moveTo(dx, y + size * 0.3);
    g.lineTo(dx, y + size * 0.3 + 8 + rnd() * size * 0.6);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** Fade a decal cell out towards its border (no hard square edges). */
function vignette(g: CanvasRenderingContext2D, w: number, h: number, inner = 0.55): void {
  g.save();
  g.globalCompositeOperation = 'destination-in';
  const r = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * inner * 0.5, w / 2, h / 2, Math.min(w, h) * 0.5);
  r.addColorStop(0, 'rgba(0,0,0,1)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, w, h);
  g.restore();
}

function crack(g: CanvasRenderingContext2D, w: number, h: number, rnd: () => number): void {
  g.strokeStyle = 'rgba(12,10,8,0.85)';
  g.lineCap = 'round';
  const branch = (x: number, y: number, a: number, len: number, wd: number, depth: number) => {
    let cx = x;
    let cy = y;
    for (let i = 0; i < 6; i++) {
      a += (rnd() - 0.5) * 0.9;
      const nx = cx + Math.cos(a) * (len / 6);
      const ny = cy + Math.sin(a) * (len / 6);
      g.lineWidth = wd * (1 - i / 7);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(nx, ny);
      g.stroke();
      if (depth > 0 && rnd() < 0.3) branch(nx, ny, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd()), len * 0.45, wd * 0.6, depth - 1);
      cx = nx;
      cy = ny;
    }
  };
  for (let i = 0, n = 3 + Math.floor(rnd() * 3); i < n; i++) branch(w / 2, h / 2, rnd() * Math.PI * 2, Math.min(w, h) * (0.3 + rnd() * 0.2), 3.5, 2);
  vignette(g, w, h, 0.7);
}

/** Every entry, in no particular order (packed tallest first). */
function entries(rooms: { id: string; rect: [number, number, number, number]; name?: string; zone?: string }[]): Entry[] {
  const E: Entry[] = [];
  const add = (id: string, w: number, h: number, draw: Draw) => E.push({ id, w, h, draw });

  // ------------------------------------------------------------ signs (opaque)
  add('authorized', 4, 1, (g, w, h, rnd) => {
    g.fillStyle = '#e6e2d9';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#a3171a';
    g.fillRect(0, 0, h, h);
    text(g, '!', h / 2, h / 2 + 4, h, 78, '#f4f1ea', 900, 'center');
    text(g, 'AUTHORIZED PERSONNEL ONLY', h + 18, h * 0.42, w - h - 34, 40, '#1d1f22', 800);
    text(g, 'SITE-9 · ACCESS LEVEL 3 AND ABOVE', h + 18, h * 0.78, w - h - 34, 20, '#5a5e64', 600);
    age(g, w, h, rnd);
  });
  add('voltage', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f0ede6';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#b3141a';
    g.fillRect(0, 0, w, h * 0.2);
    text(g, 'DANGER', w / 2, h * 0.1, w - 20, 38, '#fff', 900, 'center');
    triangle(g, w / 2, h * 0.5, h * 0.21, '#e9b322', '#151515');
    g.fillStyle = '#151515';
    g.beginPath();
    const cx = w / 2;
    const cy = h * 0.52;
    g.moveTo(cx + 6, cy - 34);
    g.lineTo(cx - 14, cy + 4);
    g.lineTo(cx - 1, cy + 4);
    g.lineTo(cx - 8, cy + 30);
    g.lineTo(cx + 16, cy - 8);
    g.lineTo(cx + 2, cy - 8);
    g.closePath();
    g.fill();
    text(g, 'HIGH VOLTAGE', w / 2, h * 0.8, w - 24, 30, '#151515', 900, 'center');
    text(g, 'Keep out · Authorized staff only', w / 2, h * 0.91, w - 24, 15, '#444', 600, 'center');
    age(g, w, h, rnd);
  });
  add('robots', 4, 2, (g, w, h, rnd) => {
    stripes(g, 0, 0, w, h);
    g.fillStyle = '#f0ede6';
    g.fillRect(18, 18, w - 36, h - 36);
    text(g, 'CAUTION', w / 2, h * 0.3, w - 80, 70, '#151515', 900, 'center');
    text(g, 'AUTONOMOUS ROBOTS IN OPERATION', w / 2, h * 0.58, w - 80, 30, '#151515', 800, 'center');
    text(g, 'Stay behind the yellow line. Units may move without warning.', w / 2, h * 0.76, w - 80, 18, '#505050', 600, 'center');
    age(g, w, h, rnd);
  });
  const mandatory = (id: string, title: string, sub: string, icon: (g: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void) =>
    add(id, 2, 2, (g, w, h, rnd) => {
      g.fillStyle = '#f0ede6';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#1d4f9e';
      g.beginPath();
      g.arc(w / 2, h * 0.4, h * 0.28, 0, Math.PI * 2);
      g.fill();
      icon(g, w / 2, h * 0.4, h * 0.28);
      text(g, title, w / 2, h * 0.8, w - 20, 30, '#151515', 900, 'center');
      text(g, sub, w / 2, h * 0.91, w - 20, 15, '#555', 600, 'center');
      age(g, w, h, rnd);
    });
  mandatory('hardhat', 'HARD HAT AREA', 'Helmets beyond this point', (g, cx, cy, r) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(cx, cy + r * 0.15, r * 0.55, Math.PI, 0);
    g.fill();
    g.fillRect(cx - r * 0.72, cy + r * 0.12, r * 1.44, r * 0.14);
    g.fillRect(cx - r * 0.06, cy - r * 0.42, r * 0.12, r * 0.3);
  });
  mandatory('goggles', 'EYE PROTECTION', 'Required in the test area', (g, cx, cy, r) => {
    g.strokeStyle = '#fff';
    g.lineWidth = r * 0.12;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * r * 0.3, cy, r * 0.24, r * 0.18, 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - r * 0.06, cy);
    g.lineTo(cx + r * 0.06, cy);
    g.stroke();
  });
  add('flame', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f0ede6';
    g.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.4;
    const r = h * 0.28;
    g.fillStyle = '#151515';
    g.beginPath();
    g.moveTo(cx, cy - r * 0.55);
    g.quadraticCurveTo(cx + r * 0.45, cy, cx + r * 0.2, cy + r * 0.45);
    g.quadraticCurveTo(cx, cy + r * 0.55, cx - r * 0.2, cy + r * 0.45);
    g.quadraticCurveTo(cx - r * 0.45, cy, cx, cy - r * 0.55);
    g.fill();
    g.strokeStyle = '#b3141a';
    g.lineWidth = r * 0.16;
    g.beginPath();
    g.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - r * 0.6, cy - r * 0.6);
    g.lineTo(cx + r * 0.6, cy + r * 0.6);
    g.stroke();
    text(g, 'NO OPEN FLAME', w / 2, h * 0.8, w - 20, 30, '#151515', 900, 'center');
    text(g, 'Coolant and fuel lines', w / 2, h * 0.91, w - 20, 15, '#555', 600, 'center');
    age(g, w, h, rnd);
  });
  add('bio', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#e9b322';
    g.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.42;
    const r = h * 0.2;
    g.fillStyle = '#151515';
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      g.beginPath();
      g.arc(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62, r * 0.62, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#e9b322';
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      g.beginPath();
      g.arc(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85, r * 0.4, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
    g.fill();
    text(g, 'BIOHAZARD', w / 2, h * 0.8, w - 20, 34, '#151515', 900, 'center');
    text(g, 'Clinical waste only', w / 2, h * 0.91, w - 20, 15, '#3a2a00', 600, 'center');
    age(g, w, h, rnd);
  });
  add('gown', 4, 2, (g, w, h, rnd) => {
    g.fillStyle = '#eef1f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1d4f9e';
    g.fillRect(0, 0, w, h * 0.28);
    text(g, 'CLEAN ROOM · ISO 5', 24, h * 0.14, w - 48, 40, '#fff', 800);
    text(g, 'Gown, hood, overshoes and two pairs of gloves', 24, h * 0.42, w - 48, 24, '#1d1f22', 600);
    text(g, 'before you pass this point. Air shower: 30 s.', 24, h * 0.56, w - 48, 24, '#1d1f22', 600);
    text(g, 'NO ENTRY WITHOUT A SUIT', 24, h * 0.8, w - 48, 38, '#b3141a', 900);
    age(g, w, h, rnd, 0.7);
  });
  add('exit', 2, 1, (g, w, h) => {
    g.fillStyle = '#0d7a3a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#eafff0';
    // Running figure.
    const x = 34;
    const y = h / 2;
    g.beginPath();
    g.arc(x + 10, y - 26, 8, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 8;
    g.lineCap = 'round';
    g.strokeStyle = '#eafff0';
    g.beginPath();
    g.moveTo(x + 6, y - 14);
    g.lineTo(x, y + 8);
    g.lineTo(x + 14, y + 30);
    g.moveTo(x, y + 8);
    g.lineTo(x - 14, y + 24);
    g.moveTo(x + 4, y - 8);
    g.lineTo(x + 20, y);
    g.moveTo(x + 4, y - 8);
    g.lineTo(x - 12, y - 2);
    g.stroke();
    text(g, 'EXIT', w * 0.58, h / 2 + 2, w * 0.4, 52, '#eafff0', 900, 'center');
    g.beginPath();
    g.moveTo(w - 26, h / 2);
    g.lineTo(w - 44, h / 2 - 16);
    g.lineTo(w - 44, h / 2 + 16);
    g.fill();
  });
  add('evac', 3, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f2f0ea';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0d7a3a';
    g.fillRect(0, 0, w, 34);
    text(g, 'EVACUATION PLAN · LEVEL 0', 12, 17, w - 24, 22, '#fff', 800);
    // The real floor plan.
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const r of rooms) {
      x0 = Math.min(x0, r.rect[0]);
      z0 = Math.min(z0, r.rect[1]);
      x1 = Math.max(x1, r.rect[2]);
      z1 = Math.max(z1, r.rect[3]);
    }
    const s = Math.min((w - 30) / (x1 - x0), (h - 60) / (z1 - z0));
    const ox = (w - (x1 - x0) * s) / 2;
    const oz = 44;
    g.lineWidth = 2;
    for (const r of rooms) {
      g.fillStyle = '#dcd8cf';
      g.strokeStyle = '#3a3d42';
      const rx = ox + (r.rect[0] - x0) * s;
      const rz = oz + (r.rect[1] - z0) * s;
      g.fillRect(rx, rz, (r.rect[2] - r.rect[0]) * s, (r.rect[3] - r.rect[1]) * s);
      g.strokeRect(rx, rz, (r.rect[2] - r.rect[0]) * s, (r.rect[3] - r.rect[1]) * s);
    }
    g.strokeStyle = '#0d9a48';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(ox + (0 - x0) * s, oz + (20 - z0) * s);
    g.lineTo(ox + (0 - x0) * s, oz + (60 - z0) * s);
    g.moveTo(ox + (-60 - x0) * s, oz + (-20 - z0) * s);
    g.lineTo(ox + (-10 - x0) * s, oz + (-20 - z0) * s);
    g.lineTo(ox + (-10 - x0) * s, oz + (10 - z0) * s);
    g.stroke();
    g.fillStyle = '#c4161c';
    g.beginPath();
    g.arc(ox + (rnd() * 120 - 60 - x0) * s, oz + (rnd() * 80 - 40 - z0) * s, 6, 0, Math.PI * 2);
    g.fill();
    text(g, '● YOU ARE HERE', 12, h - 12, w / 2, 14, '#c4161c', 700);
    age(g, w, h, rnd, 0.6);
  });
  add('incident', 3, 2, (g, w, h, rnd) => {
    g.fillStyle = '#1f4a33';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#d8d2c2';
    g.lineWidth = 4;
    g.strokeRect(8, 8, w - 16, h - 16);
    text(g, 'THIS SITE HAS WORKED', w / 2, 38, w - 40, 22, '#e9e4d6', 800, 'center');
    g.fillStyle = '#f2efe6';
    g.fillRect(w / 2 - 50, 58, 100, 96);
    text(g, '0', w / 2, 108, 90, 92, '#151515', 900, 'center');
    text(g, 'DAYS WITHOUT A RECORDED INCIDENT', w / 2, 178, w - 40, 18, '#e9e4d6', 800, 'center');
    age(g, w, h, rnd);
  });
  add('wash', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f0f3f3';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1d6fa0';
    g.fillRect(0, 0, w, h * 0.22);
    text(g, 'WASH HANDS', w / 2, h * 0.11, w - 20, 34, '#fff', 900, 'center');
    g.fillStyle = '#1d6fa0';
    for (let i = 0; i < 3; i++) {
      const cx = w * (0.3 + i * 0.2);
      const cy = h * 0.5;
      g.beginPath();
      g.moveTo(cx, cy - 22);
      g.quadraticCurveTo(cx + 16, cy + 4, cx, cy + 12);
      g.quadraticCurveTo(cx - 16, cy + 4, cx, cy - 22);
      g.fill();
    }
    text(g, 'Soap · 20 seconds · dry', w / 2, h * 0.75, w - 20, 20, '#1d1f22', 700, 'center');
    text(g, 'Medical Bay staff and visitors', w / 2, h * 0.87, w - 20, 14, '#555', 600, 'center');
    age(g, w, h, rnd, 0.6);
  });
  add('menu', 4, 2, (g, w, h, rnd) => {
    g.fillStyle = '#1d231f';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#6b4a2c';
    g.lineWidth = 12;
    g.strokeRect(6, 6, w - 12, h - 12);
    const chalk = 'rgba(236,232,220,0.9)';
    text(g, 'CANTEEN · TODAY', w / 2, 40, w - 60, 34, chalk, 800, 'center');
    const items: [string, string][] = [['Borscht, sour cream', '3.20'], ['Pelmeni (12)', '4.50'], ['Buckwheat kasha', '2.10'], ['Black tea', '0.80'], ['Coffee, real', '1.90']];
    items.forEach(([a, b], i) => {
      const y = 82 + i * 26;
      text(g, a, 34, y, w * 0.6, 20, chalk, 500);
      text(g, b, w - 34, y, 80, 20, chalk, 600, 'right');
      g.fillStyle = 'rgba(236,232,220,0.35)';
      for (let x = w * 0.55; x < w - 100; x += 10) g.fillRect(x, y + 4, 3, 2);
    });
    // Chalk dust.
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(236,232,220,${rnd() * 0.06})`;
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 1 + rnd() * 3);
    }
  });
  add('quiet', 4, 1, (g, w, h, rnd) => {
    g.fillStyle = '#cfe6df';
    g.fillRect(0, 0, w, h);
    text(g, 'QUIET PLEASE', 24, h * 0.38, w - 48, 40, '#1b4b40', 800);
    text(g, 'PATIENTS RESTING · KEEP THE BAY CURTAINS CLOSED', 24, h * 0.76, w - 48, 18, '#2c5c50', 600);
    age(g, w, h, rnd, 0.5);
  });
  const robotSilhouette = (g: CanvasRenderingContext2D, cx: number, top: number, s: number, color: string) => {
    g.fillStyle = color;
    g.fillRect(cx - 0.18 * s, top, 0.36 * s, 0.3 * s); // head
    g.fillRect(cx - 0.42 * s, top + 0.38 * s, 0.84 * s, 0.7 * s); // torso
    g.fillRect(cx - 0.62 * s, top + 0.42 * s, 0.16 * s, 0.75 * s); // arms
    g.fillRect(cx + 0.46 * s, top + 0.42 * s, 0.16 * s, 0.75 * s);
    g.fillRect(cx - 0.34 * s, top + 1.14 * s, 0.24 * s, 0.86 * s); // legs
    g.fillRect(cx + 0.1 * s, top + 1.14 * s, 0.24 * s, 0.86 * s);
  };
  add('poster1', 2, 3, (g, w, h, rnd) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#7d1013');
    bg.addColorStop(1, '#2a0607');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    robotSilhouette(g, w / 2, h * 0.12, w * 0.32, 'rgba(10,6,6,0.9)');
    g.fillStyle = '#7fc2ff';
    g.fillRect(w / 2 - w * 0.04, h * 0.12 + w * 0.1, w * 0.08, w * 0.03);
    text(g, 'BUILD THE', w / 2, h * 0.8, w - 30, 34, '#f4ece6', 900, 'center');
    text(g, 'FUTURE.', w / 2, h * 0.87, w - 30, 40, '#f4ece6', 900, 'center');
    text(g, 'VANTA DYNAMICS', w / 2, h * 0.95, w - 30, 14, '#d29a8c', 700, 'center');
    age(g, w, h, rnd);
  });
  add('poster2', 2, 3, (g, w, h, rnd) => {
    g.fillStyle = '#26323d';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e0a51c';
    g.fillRect(0, h * 0.7, w, 6);
    // K-series: a squat carrier on tracks.
    g.fillStyle = '#c9ccd0';
    g.fillRect(w * 0.22, h * 0.36, w * 0.56, h * 0.22);
    g.fillStyle = '#e0a51c';
    g.fillRect(w * 0.22, h * 0.36, w * 0.56, h * 0.04);
    g.fillStyle = '#111';
    g.fillRect(w * 0.18, h * 0.58, w * 0.64, h * 0.07);
    g.fillStyle = '#ffd25a';
    g.beginPath();
    g.arc(w * 0.68, h * 0.44, w * 0.05, 0, Math.PI * 2);
    g.fill();
    text(g, 'K-SERIES', w / 2, h * 0.17, w - 30, 40, '#f2f3f4', 900, 'center');
    text(g, 'ALWAYS ON SHIFT', w / 2, h * 0.79, w - 30, 24, '#e0a51c', 900, 'center');
    text(g, 'Haulage · maintenance · night patrol', w / 2, h * 0.87, w - 30, 13, '#9aa6b2', 600, 'center');
    age(g, w, h, rnd);
  });
  add('poster3', 2, 3, (g, w, h, rnd) => {
    g.fillStyle = '#efece4';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e0a51c';
    g.fillRect(0, 0, w, 16);
    text(g, 'SEEN', 18, h * 0.12, w - 36, 54, '#151515', 900);
    text(g, 'SOMETHING', 18, h * 0.21, w - 36, 54, '#151515', 900);
    text(g, 'ODD?', 18, h * 0.3, w - 36, 54, '#b3141a', 900);
    const lines = ['A unit off its task table.', 'A door that opens before', 'you reach it. A headcount', 'that does not add up.'];
    lines.forEach((l, i) => text(g, l, 18, h * (0.45 + i * 0.06), w - 36, 17, '#333', 600));
    text(g, 'Report it to WARDEN · ext. 30', 18, h * 0.8, w - 36, 17, '#151515', 800);
    text(g, 'Do not approach the unit.', 18, h * 0.86, w - 36, 15, '#555', 600);
    age(g, w, h, rnd);
  });
  add('notice', 3, 2, (g, w, h, rnd) => {
    g.fillStyle = '#9a7248';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(60,40,20,0.25)' : 'rgba(200,160,110,0.2)';
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    g.strokeStyle = '#4a3020';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
    for (let i = 0; i < 6; i++) {
      const pw = 60 + rnd() * 40;
      const ph = 70 + rnd() * 40;
      const x = 20 + rnd() * (w - pw - 40);
      const y = 20 + rnd() * (h - ph - 40);
      g.save();
      g.translate(x + pw / 2, y + ph / 2);
      g.rotate((rnd() - 0.5) * 0.25);
      g.fillStyle = ['#f2efe6', '#fff7c2', '#e8f0f8', '#f2efe6'][i % 4];
      g.fillRect(-pw / 2, -ph / 2, pw, ph);
      g.fillStyle = 'rgba(40,40,40,0.55)';
      for (let l = -ph / 2 + 14; l < ph / 2 - 8; l += 8) g.fillRect(-pw / 2 + 8, l, (pw - 16) * (0.5 + rnd() * 0.5), 2);
      g.fillStyle = ['#c4161c', '#1d4f9e', '#0d7a3a'][i % 3];
      g.beginPath();
      g.arc(0, -ph / 2 + 6, 4, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
  add('whiteboard', 4, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f4f5f4';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#9aa0a6';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
    // Ghosts of old writing.
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `rgba(80,90,120,${0.03 + rnd() * 0.04})`;
      g.fillRect(rnd() * w, rnd() * h, 30 + rnd() * 120, 3 + rnd() * 5);
    }
    const ink = '#1d3f8a';
    text(g, 'COLD FORECAST v4', 26, 34, w * 0.5, 28, ink, 700, 'left', '"Segoe Print", "Comic Sans MS", cursive');
    text(g, 'DO NOT ERASE', w - 26, 34, w * 0.3, 20, '#c4161c', 700, 'right', '"Segoe Print", "Comic Sans MS", cursive');
    // Temperature vs. lead time.
    const gx = 40;
    const gy = 70;
    const gw = w * 0.5;
    const gh = h - 100;
    g.strokeStyle = '#222';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(gx, gy);
    g.lineTo(gx, gy + gh);
    g.lineTo(gx + gw, gy + gh);
    g.stroke();
    g.strokeStyle = '#c4161c';
    g.setLineDash([10, 8]);
    g.beginPath();
    g.moveTo(gx, gy + gh * 0.55);
    g.lineTo(gx + gw, gy + gh * 0.55);
    g.stroke();
    g.setLineDash([]);
    text(g, '-30', gx + gw + 6, gy + gh * 0.55, 60, 18, '#c4161c', 700);
    g.strokeStyle = ink;
    g.lineWidth = 3;
    g.beginPath();
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const y = gy + gh * (0.1 + t * 0.6 + Math.sin(t * 9) * 0.04 + (t > 0.7 ? (t - 0.7) * 1.2 : 0));
      if (i === 0) g.moveTo(gx + t * gw, y);
      else g.lineTo(gx + t * gw, y);
    }
    g.stroke();
    text(g, 'lead time ↑ ?', gx + gw * 0.6, gy + 14, 160, 18, ink, 600, 'left', '"Segoe Print", "Comic Sans MS", cursive');
    const notes = ['26 badged in', '27 tracked', 'sensor fault? NO', 'ask Ivy re: K-07'];
    notes.forEach((n, i) => text(g, n, w * 0.66, 90 + i * 30, w * 0.3, 20, i === 1 ? '#c4161c' : ink, 600, 'left', '"Segoe Print", "Comic Sans MS", cursive'));
    g.strokeStyle = '#c4161c';
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(w * 0.66 + 58, 120, 72, 16, -0.05, 0, Math.PI * 2);
    g.stroke();
  });
  add('liftOut', 2, 1, (g, w, h, rnd) => {
    stripes(g, 0, 0, w, h, '#e0a51c', '#151515', 18);
    g.fillStyle = '#f0ede6';
    g.fillRect(10, 12, w - 20, h - 24);
    text(g, 'OUT OF SERVICE', w / 2, h / 2 - 8, w - 40, 30, '#151515', 900, 'center');
    text(g, 'Do not call · do not wait here', w / 2, h / 2 + 20, w - 40, 14, '#555', 600, 'center');
    age(g, w, h, rnd, 0.5);
  });
  const band = (id: string, a: string, b: string, bg: string, fg: string, accent: string) =>
    add(id, 4, 1, (g, w, h, rnd) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = accent;
      g.fillRect(0, 0, 14, h);
      text(g, a, 32, h * 0.4, w - 50, 38, fg, 900);
      text(g, b, 32, h * 0.78, w - 50, 18, fg, 600);
      age(g, w, h, rnd, 0.6);
    });
  band('reactor', 'REACTOR HALL', 'DOSIMETER REQUIRED · HEARING PROTECTION', '#e0a51c', '#151515', '#151515');
  band('armory', 'ARMORY', 'SIGN OUT EVERY WEAPON · SIGN IT BACK IN', '#2a2f35', '#e9e6df', '#a3171a');
  band('lightsOut', 'LIGHTS OUT 22:00', 'REVEILLE 06:00 · BUNKS MADE BY 06:15', '#3a4038', '#e9e6df', '#e0a51c');
  band('stitch', 'STITCH RAIL 2', 'OVERHEAD MAINTENANCE UNIT · DO NOT STAND UNDER', '#e0a51c', '#151515', '#a3171a');
  add('forklift', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f0ede6';
    g.fillRect(0, 0, w, h);
    triangle(g, w / 2, h * 0.42, h * 0.3, '#e9b322', '#151515');
    g.fillStyle = '#151515';
    const cx = w / 2;
    const cy = h * 0.5;
    g.fillRect(cx - 26, cy - 14, 34, 20);
    g.fillRect(cx - 18, cy - 30, 4, 16);
    g.fillRect(cx + 10, cy - 34, 4, 40);
    g.fillRect(cx + 10, cy + 2, 22, 4);
    g.beginPath();
    g.arc(cx - 18, cy + 10, 6, 0, Math.PI * 2);
    g.arc(cx + 2, cy + 10, 6, 0, Math.PI * 2);
    g.fill();
    text(g, 'FORKLIFT TRAFFIC', w / 2, h * 0.84, w - 20, 26, '#151515', 900, 'center');
    age(g, w, h, rnd);
  });
  const label = (id: string, s: string, bg: string, fg: string, edge?: string) =>
    add(id, 2, 1, (g, w, h, rnd) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      if (edge) {
        g.fillStyle = edge;
        g.fillRect(0, h - 12, w, 12);
      }
      text(g, s, w / 2, h / 2 - (edge ? 4 : 0), w - 24, 58, fg, 900, 'center', STENCIL);
      age(g, w, h, rnd, 0.7);
    });
  for (const n of [1, 2, 3, 4]) label(`bay${n}`, `BAY ${n}`, '#22262b', '#e0a51c', '#e0a51c');
  for (const n of ['A', 'B', 'C']) label(`line${n}`, `LINE ${n}`, '#e0a51c', '#151515');
  label('coldAisle', 'COLD AISLE', '#1d4f9e', '#e8f2ff');
  label('hotAisle', 'HOT AISLE', '#9e1d1d', '#ffe8e8');
  label('coolant', 'COOLANT →', '#0d7a3a', '#eafff0');
  label('chilled', 'CHILLED →', '#1d6fa0', '#e8f6ff');
  label('vanta', 'VANTA', '#f2f3f4', '#1b1d20', '#a3171a');
  add('muster', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#0d7a3a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#eafff0';
    const cx = w / 2;
    const cy = h * 0.4;
    for (let i = 0; i < 4; i++) {
      g.save();
      g.translate(cx, cy);
      g.rotate((i * Math.PI) / 2);
      g.beginPath();
      g.moveTo(0, -12);
      g.lineTo(-14, -34);
      g.lineTo(14, -34);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.beginPath();
    g.arc(cx, cy, 10, 0, Math.PI * 2);
    g.fill();
    text(g, 'MUSTER POINT', w / 2, h * 0.78, w - 20, 30, '#eafff0', 900, 'center');
    text(g, 'Headcount by your shift lead', w / 2, h * 0.9, w - 20, 14, '#bfe8cc', 600, 'center');
    age(g, w, h, rnd, 0.6);
  });
  add('schedule', 3, 2, (g, w, h, rnd) => {
    g.fillStyle = '#f2f0ea';
    g.fillRect(0, 0, w, h);
    text(g, 'NIGHT ROSTER · WEEK 41', 14, 22, w - 28, 22, '#1d1f22', 800);
    const cols = ['', 'MON', 'TUE', 'WED', 'THU', 'FRI'];
    const names = ['Orlov', 'Glass', 'Petrenko', 'Hale', 'Sato', 'Kuzmin', 'Brandt'];
    const cw = (w - 28) / cols.length;
    g.strokeStyle = '#8a8f96';
    g.lineWidth = 1;
    cols.forEach((c, i) => text(g, c, 14 + i * cw + cw / 2, 50, cw, 13, '#333', 700, 'center'));
    names.forEach((n, r) => {
      const y = 62 + r * 20;
      g.beginPath();
      g.moveTo(14, y);
      g.lineTo(w - 14, y);
      g.stroke();
      text(g, n, 18, y + 10, cw - 6, 12, '#222', 600);
      for (let c = 1; c < cols.length; c++) {
        if (rnd() < 0.55) text(g, rnd() < 0.5 ? 'N' : 'L', 14 + c * cw + cw / 2, y + 10, cw, 12, '#1d3f8a', 700, 'center');
        else if (rnd() < 0.15) text(g, '✕', 14 + c * cw + cw / 2, y + 10, cw, 14, '#c4161c', 700, 'center');
      }
    });
    age(g, w, h, rnd, 0.6);
  });
  add('target', 2, 3, (g, w, h, rnd) => {
    g.fillStyle = '#ede8dc';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b1b1b';
    g.beginPath();
    g.arc(w / 2, h * 0.2, w * 0.15, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(w * 0.15, h);
    g.lineTo(w * 0.2, h * 0.42);
    g.quadraticCurveTo(w / 2, h * 0.3, w * 0.8, h * 0.42);
    g.lineTo(w * 0.85, h);
    g.fill();
    g.strokeStyle = '#ede8dc';
    g.lineWidth = 2;
    for (const r of [0.08, 0.16, 0.24, 0.32]) {
      g.beginPath();
      g.ellipse(w / 2, h * 0.58, w * r, w * r * 1.3, 0, 0, Math.PI * 2);
      g.stroke();
    }
    for (let i = 0; i < 9; i++) {
      g.fillStyle = '#ede8dc';
      g.beginPath();
      g.arc(w / 2 + (rnd() - 0.5) * w * 0.4, h * 0.58 + (rnd() - 0.5) * h * 0.3, 3 + rnd() * 2, 0, Math.PI * 2);
      g.fill();
    }
  });
  add('photo', 1, 1, (g, w, h, rnd) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#8fb4d0');
    bg.addColorStop(0.6, '#d8c9a8');
    bg.addColorStop(1, '#7d6a4c');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3; i++) {
      const x = w * (0.28 + i * 0.22);
      const s = i === 2 ? 0.7 : 1;
      g.fillStyle = ['#3b3530', '#5a3d2e', '#2e3a4a'][i];
      g.beginPath();
      g.arc(x, h * (0.45 + (1 - s) * 0.2), 9 * s, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x - 12 * s, h * (0.55 + (1 - s) * 0.2), 24 * s, h * 0.45);
    }
    g.strokeStyle = '#f2efe6';
    g.lineWidth = 8;
    g.strokeRect(0, 0, w, h);
    age(g, w, h, rnd, 0.8);
  });

  // ------------------------------------------------------------ Vanta branding (atrium)
  add('banner', 2, 6, (g, w, h, rnd) => {
    const bg = g.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, '#7e1012');
    bg.addColorStop(0.5, '#a3171a');
    bg.addColorStop(1, '#7e1012');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(240,236,230,0.85)';
    g.fillRect(14, 0, 4, h);
    g.fillRect(w - 18, 0, 4, h);
    vLogo(g, w / 2, h * 0.2, w * 0.28, '#f1ece6');
    text(g, 'VANTA', w / 2, h * 0.34, w - 50, 38, '#f1ece6', 600, 'center');
    text(g, 'DYNAMICS', w / 2, h * 0.38, w - 60, 15, '#e6c9c2', 500, 'center');
    ['PEOPLE', 'SECURITY', 'PROGRESS'].forEach((t, i) => text(g, t, w / 2, h * (0.72 + i * 0.05), w - 60, 18, '#ecd6d0', 500, 'center'));
    // Folds and grime.
    for (let i = 0; i < 6; i++) {
      const x = rnd() * w;
      const gr = g.createLinearGradient(x - 10, 0, x + 10, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.18)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x - 10, 0, 20, h);
    }
    age(g, w, h, rnd, 0.8);
  });
  add('vantaMark', 3, 1, (g, w, h, rnd) => {
    g.fillStyle = '#16181b';
    g.fillRect(0, 0, w, h);
    vLogo(g, h * 0.62, h / 2, h * 0.34, '#d8d4cc');
    g.fillStyle = '#a3171a';
    g.fillRect(h * 0.62 - h * 0.12, h * 0.5 - 2, h * 0.24, 4);
    text(g, 'VANTA', h * 1.15, h * 0.42, w - h * 1.3, 40, '#e6e2da', 600);
    text(g, 'DYNAMICS', h * 1.15, h * 0.74, w - h * 1.3, 16, '#9aa0a6', 500);
    age(g, w, h, rnd, 0.5);
  });
  add('floorSite9', 5, 2, (g, w, h, rnd) => {
    text(g, 'SITE-9', w / 2, h * 0.42, w - 30, 150, 'rgba(26,28,31,0.85)', 900, 'center', STENCIL);
    text(g, 'RESEARCH  |  SECURITY  |  A SAFER TOMORROW', w / 2, h * 0.86, w - 40, 26, 'rgba(26,28,31,0.8)', 700, 'center');
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.7})`;
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 8, 2 + rnd() * 5);
    }
    g.globalCompositeOperation = 'source-over';
  });
  add('barrier', 2, 1, (g, w, h, rnd) => {
    stripes(g, 0, 0, w, h, '#e9e4dc', '#b3141a', 22);
    g.fillStyle = '#f0ede6';
    g.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
    g.fillStyle = '#b3141a';
    g.beginPath();
    g.moveTo(w * 0.32, h * 0.42);
    g.lineTo(w * 0.56, h * 0.42);
    g.lineTo(w * 0.56, h * 0.3);
    g.lineTo(w * 0.7, h * 0.5);
    g.lineTo(w * 0.56, h * 0.7);
    g.lineTo(w * 0.56, h * 0.58);
    g.lineTo(w * 0.32, h * 0.58);
    g.closePath();
    g.fill();
    age(g, w, h, rnd, 0.6);
  });

  // ------------------------------------------------------------ room plates (doors)
  /** Room codes on the plates: wing letter + number. */
  const CODES: Record<string, string> = {
    lobby: 'A-01', cafeteria: 'A-02', atrium: 'A-03', security: 'B-01', medbay: 'B-02', barracks: 'B-03', garden: 'C-01',
    assembly: 'D-01', warehouse: 'D-02', hangar: 'D-03', labs: 'R-01', cleanroom: 'R-02', prototypes: 'R-03',
    servers: 'S-01', cooling: 'S-02', power: 'P-01',
  };
  for (const room of rooms) {
    const name = room.name;
    if (!name) continue;
    add(`plate_${room.id}`, 5, 1, (g, w, h, rnd) => {
      g.fillStyle = '#1b1d20';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#3a3e43';
      g.lineWidth = 4;
      g.strokeRect(2, 2, w - 4, h - 4);
      const code = CODES[room.id] ?? '';
      fit(g, code, w * 0.3, 60, 900, STENCIL);
      g.fillStyle = '#e4dfd4';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(code, 18, h * 0.54);
      const cw = Math.max(w * 0.27, g.measureText(code).width + 26);
      g.fillStyle = '#a3171a';
      g.fillRect(cw + 10, h * 0.18, 5, h * 0.64);
      text(g, name.toUpperCase(), cw + 30, h * 0.42, w - cw - 46, 38, '#f0ece4', 700);
      text(g, `SITE-9  ·  LEVEL 0  ·  ${(room.zone ?? '').toUpperCase()}`, cw + 31, h * 0.8, w - cw - 46, 14, '#8a9096', 600);
      age(g, w, h, rnd, 0.5);
    });
  }

  // ------------------------------------------------------------ wayfinding (hung over the halls)
  const way = (id: string, rows: [string, string][]) =>
    add(id, 6, 2, (g, w, h, rnd) => {
      g.fillStyle = '#16181b';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#a3171a';
      g.fillRect(0, 0, w, 6);
      const rh = (h - 16) / rows.length;
      rows.forEach(([arrow, label], i) => {
        const y = 12 + rh * (i + 0.5);
        if (i) {
          g.fillStyle = '#2c3035';
          g.fillRect(16, 12 + rh * i, w - 32, 2);
        }
        const right = arrow === '▶';
        text(g, arrow, right ? w - 30 : 30, y + 2, 40, 40, '#e0a51c', 900, 'center');
        text(g, label, right ? w - 62 : 62, y + 2, w - 110, 34, '#eceae4', 700, right ? 'right' : 'left');
      });
      age(g, w, h, rnd, 0.4);
    });
  // Facing north (towards the labs): west is on your left.
  way('wayAtriumN', [['▲', 'R&D LABS'], ['◀', 'GARDEN COURT · ASSEMBLY HALL'], ['▶', 'MEDICAL BAY · SERVER HALL']]);
  way('wayAtriumS', [['▲', 'ARRIVAL LOBBY'], ['◀', 'MEDICAL BAY · SERVER HALL'], ['▶', 'GARDEN COURT · ASSEMBLY HALL']]);
  way('wayLobby', [['▲', 'ATRIUM · R&D LABS'], ['◀', 'CAFETERIA · HANGAR'], ['▶', 'SECURITY · BARRACKS']]);

  // ------------------------------------------------------------ lit panels (emissive)
  const temp = (id: string, v: string, color: string) =>
    add(id, 2, 1, (g, w, h) => {
      g.fillStyle = '#0d1013';
      g.fillRect(0, 0, w, h);
      text(g, 'SECTOR AIR', 14, 18, w - 28, 15, '#6b7682', 700);
      text(g, v, 14, h * 0.62, w - 28, 54, color, 800);
      g.fillStyle = color;
      g.fillRect(w - 26, 12, 12, 12);
    });
  temp('temp1', '+19 °C', '#8fffb0');
  temp('temp2', '+4 °C', '#9fe3ff');
  temp('temp3', '−18 °C', '#7fb8ff');
  temp('temp4', '−31 °C', '#ff8a7a');
  add('headcount', 4, 2, (g, w, h) => {
    g.fillStyle = '#0b0e10';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2a3238';
    g.lineWidth = 4;
    g.strokeRect(6, 6, w - 12, h - 12);
    text(g, 'WARDEN · PERSONNEL', 24, 30, w - 48, 20, '#6b7682', 700);
    text(g, 'BADGED IN', 24, 80, w / 2, 22, '#9aa6b2', 700);
    text(g, '26', w - 30, 84, 140, 64, '#8fffb0', 800, 'right');
    text(g, 'TRACKED', 24, 152, w / 2, 22, '#9aa6b2', 700);
    text(g, '27', w - 30, 156, 140, 64, '#ff5a4a', 800, 'right');
    text(g, 'RECOUNT FAILED ×14', 24, h - 26, w - 48, 16, '#ff5a4a', 700);
  });
  add('warden', 4, 1, (g, w, h) => {
    g.fillStyle = '#0b0e10';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffd25a';
    g.beginPath();
    g.arc(30, h / 2, 9, 0, Math.PI * 2);
    g.fill();
    text(g, 'WARDEN', 52, h * 0.36, w - 70, 30, '#e9e6df', 800);
    text(g, 'ALL ROUTES CLEAR · NO ACTION REQUIRED', 52, h * 0.74, w - 70, 18, '#ffd25a', 700);
  });
  add('xray', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = '#060a10';
    g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7);
    glow.addColorStop(0, 'rgba(140,180,220,0.35)');
    glow.addColorStop(1, 'rgba(140,180,220,0.05)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    // A robot hand: palm block and jointed fingers.
    g.strokeStyle = 'rgba(225,240,255,0.85)';
    g.fillStyle = 'rgba(225,240,255,0.25)';
    g.lineWidth = 3;
    g.fillRect(w * 0.36, h * 0.52, w * 0.3, h * 0.26);
    g.strokeRect(w * 0.36, h * 0.52, w * 0.3, h * 0.26);
    for (let f = 0; f < 4; f++) {
      let x = w * (0.39 + f * 0.08);
      let y = h * 0.52;
      for (let j = 0; j < 3; j++) {
        const l = h * (0.1 - j * 0.015);
        g.strokeRect(x - 4, y - l, 8, l - 3);
        g.beginPath();
        g.arc(x, y - l - 2, 4, 0, Math.PI * 2);
        g.stroke();
        y -= l + 4;
        x += (rnd() - 0.5) * 2;
      }
    }
    g.strokeRect(w * 0.27, h * 0.55, w * 0.08, h * 0.1);
    text(g, 'K-07 · R HAND · FRACTURE C2', 10, h - 14, w - 20, 12, 'rgba(225,240,255,0.7)', 600);
  });

  // ------------------------------------------------------------ decals (alpha)
  add('crack', 2, 2, (g, w, h, rnd) => crack(g, w, h, rnd));
  add('crack2', 2, 2, (g, w, h, rnd) => crack(g, w, h, rnd));
  add('scorch', 2, 2, (g, w, h, rnd) => {
    for (let i = 0; i < 40; i++) {
      const r = w * (0.08 + rnd() * 0.25);
      const x = w / 2 + (rnd() - 0.5) * w * 0.35;
      const y = h / 2 + (rnd() - 0.5) * h * 0.35;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(8,6,4,${0.2 + rnd() * 0.15})`);
      gr.addColorStop(1, 'rgba(8,6,4,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(10,8,6,${0.3 + rnd() * 0.4})`;
      const a = rnd() * Math.PI * 2;
      const d = w * (0.15 + rnd() * 0.3);
      g.fillRect(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, 2 + rnd() * 4, 2 + rnd() * 4);
    }
    vignette(g, w, h, 0.4);
  });
  add('oil', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = 'rgba(14,11,8,0.85)';
    blob(g, w / 2, h / 2, w * 0.3, rnd);
    g.fill();
    for (let i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(14,11,8,0.7)';
      blob(g, w / 2 + (rnd() - 0.5) * w * 0.6, h / 2 + (rnd() - 0.5) * h * 0.6, w * (0.04 + rnd() * 0.07), rnd, 8);
      g.fill();
    }
    g.fillStyle = 'rgba(60,70,90,0.18)';
    blob(g, w / 2 - 10, h / 2 - 10, w * 0.15, rnd);
    g.fill();
    vignette(g, w, h, 0.8);
  });
  add('puddle', 2, 2, (g, w, h, rnd) => {
    g.fillStyle = 'rgba(255,255,255,0.92)';
    blob(g, w / 2, h / 2, w * 0.36, rnd, 10);
    g.fill();
    for (let i = 0; i < 4; i++) {
      blob(g, w / 2 + (rnd() - 0.5) * w * 0.7, h / 2 + (rnd() - 0.5) * h * 0.7, w * (0.05 + rnd() * 0.08), rnd, 8);
      g.fill();
    }
    vignette(g, w, h, 0.85);
  });
  add('holes', 2, 2, (g, w, h, rnd) => {
    for (let i = 0; i < 9; i++) {
      const x = w * (0.2 + rnd() * 0.6);
      const y = h * (0.2 + rnd() * 0.6);
      const r = 4 + rnd() * 4;
      g.fillStyle = 'rgba(200,196,188,0.5)';
      g.beginPath();
      g.arc(x, y, r * 2.2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(10,9,8,0.95)';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(20,18,16,0.6)';
      g.lineWidth = 1.2;
      for (let k = 0; k < 4; k++) {
        const a = rnd() * Math.PI * 2;
        g.beginPath();
        g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        g.lineTo(x + Math.cos(a) * r * (3 + rnd() * 3), y + Math.sin(a) * r * (3 + rnd() * 3));
        g.stroke();
      }
    }
  });
  add('frost', 2, 2, (g, w, h, rnd) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(225,240,255,0.75)');
    gr.addColorStop(0.6, 'rgba(225,240,255,0.35)');
    gr.addColorStop(1, 'rgba(225,240,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(245,250,255,0.8)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * w * 0.45;
      const x = w / 2 + Math.cos(a) * d;
      const y = h / 2 + Math.sin(a) * d;
      const l = 4 + rnd() * 10;
      for (let k = 0; k < 3; k++) {
        const b = a + (k * Math.PI) / 3;
        g.beginPath();
        g.moveTo(x - Math.cos(b) * l, y - Math.sin(b) * l);
        g.lineTo(x + Math.cos(b) * l, y + Math.sin(b) * l);
        g.stroke();
      }
    }
    vignette(g, w, h, 0.5);
  });
  add('dust', 2, 2, (g, w, h, rnd) => {
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(70,58,42,${rnd() * 0.18})`;
      const s = 2 + rnd() * 8;
      g.fillRect(w / 2 + (rnd() - 0.5) * w * rnd() * 1.4, h / 2 + (rnd() - 0.5) * h * rnd() * 1.4, s, s);
    }
    vignette(g, w, h, 0.3);
  });
  add('boots', 4, 1, (g, w, h, rnd) => {
    g.fillStyle = 'rgba(22,18,14,0.6)';
    for (let i = 0; i < 9; i++) {
      const x = 30 + i * ((w - 60) / 8);
      const y = h / 2 + (i % 2 ? -14 : 14);
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 2 + (rnd() - 0.5) * 0.2);
      g.globalAlpha = 1 - i * 0.08;
      for (let k = 0; k < 5; k++) g.fillRect(-9, -16 + k * 5, 18, 3);
      g.fillRect(-8, 14, 16, 8);
      g.restore();
    }
    g.globalAlpha = 1;
  });
  add('skid', 4, 1, (g, w, h, rnd) => {
    for (const y of [h * 0.28, h * 0.72]) {
      const gr = g.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, 'rgba(10,10,10,0)');
      gr.addColorStop(0.2, 'rgba(10,10,10,0.6)');
      gr.addColorStop(1, 'rgba(10,10,10,0.15)');
      g.fillStyle = gr;
      g.fillRect(0, y - 12, w, 24);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let x = 0; x < w; x += 9) g.fillRect(x + rnd() * 2, y - 12, 3, 24);
    }
  });
  add('drag', 4, 1, (g, w, h, rnd) => {
    for (let i = 0; i < 5; i++) {
      const y = h / 2 + (rnd() - 0.5) * h * 0.5;
      const gr = g.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, 'rgba(14,11,8,0.85)');
      gr.addColorStop(1, 'rgba(14,11,8,0)');
      g.strokeStyle = gr;
      g.lineWidth = 4 + rnd() * 10;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + (rnd() - 0.5) * 30, w * 0.6, y + (rnd() - 0.5) * 30, w, y + (rnd() - 0.5) * 20);
      g.stroke();
    }
    g.fillStyle = 'rgba(14,11,8,0.85)';
    blob(g, 40, h / 2, 36, rnd, 9);
    g.fill();
  });
  add('graffitiLifts', 4, 1, (g, w, h, rnd) => spray(g, 'STAY OUT OF THE LIFTS', 14, h / 2, w - 28, 54, '#d42a1e', rnd));
  add('graffitiSees', 4, 1, (g, w, h, rnd) => spray(g, "IT KNOWS WHERE YOU'LL BE", 14, h / 2, w - 28, 50, '#e9e6df', rnd));
  add('graffitiCount', 4, 1, (g, w, h, rnd) => spray(g, 'COUNT AGAIN. 27', 14, h / 2, w - 28, 54, '#e0a51c', rnd));
  add('tally', 2, 1, (g, w, h, rnd) => {
    g.strokeStyle = 'rgba(235,232,224,0.85)';
    g.lineWidth = 4;
    g.lineCap = 'round';
    for (let grp = 0; grp < 3; grp++) {
      const x0 = 18 + grp * 66;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(x0 + i * 11, 28 + rnd() * 4);
        g.lineTo(x0 + i * 11 + (rnd() - 0.5) * 3, 84 + rnd() * 4);
        g.stroke();
      }
      if (grp < 2) {
        g.beginPath();
        g.moveTo(x0 - 6, 76);
        g.lineTo(x0 + 42, 36);
        g.stroke();
      }
    }
  });
  add('arrowSafe', 2, 1, (g, w, h, rnd) => {
    spray(g, 'SAFE', 12, h * 0.36, w * 0.6, 40, '#3ccf6a', rnd);
    g.strokeStyle = '#3ccf6a';
    g.lineWidth = 8;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(16, h * 0.74);
    g.lineTo(w - 26, h * 0.74);
    g.lineTo(w - 46, h * 0.6);
    g.moveTo(w - 26, h * 0.74);
    g.lineTo(w - 46, h * 0.88);
    g.stroke();
  });
  add('keepClear', 4, 1, (g, w, h, rnd) => {
    text(g, 'KEEP CLEAR', w / 2, h / 2 + 4, w - 30, 84, 'rgba(224,165,28,0.85)', 900, 'center', STENCIL);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.6})`;
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 4);
    }
    g.globalCompositeOperation = 'source-over';
  });
  for (const n of ['01', '02', '03']) {
    add(`num${n}`, 2, 2, (g, w, h, rnd) => {
      text(g, n, w / 2, h / 2 + 8, w - 20, 170, 'rgba(224,165,28,0.85)', 900, 'center', STENCIL);
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `rgba(0,0,0,${rnd() * 0.6})`;
        g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 4);
      }
      g.globalCompositeOperation = 'source-over';
    });
  }
  const streak = (id: string, rgb: string) =>
    add(id, 1, 2, (g, w, h, rnd) => {
      for (let i = 0; i < 14; i++) {
        const x = w / 2 + (rnd() - 0.5) * w * 0.5;
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, `rgba(${rgb},0.55)`);
        gr.addColorStop(0.15 + rnd() * 0.5, `rgba(${rgb},0.25)`);
        gr.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = gr;
        g.fillRect(x, 0, 3 + rnd() * 8, h * (0.5 + rnd() * 0.5));
      }
      g.fillStyle = `rgba(${rgb},0.5)`;
      g.fillRect(w * 0.15, 0, w * 0.7, 6);
    });
  streak('leak', '28,26,22');
  streak('rust', '110,52,22');
  add('clock', 1, 1, (g, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 4;
    g.fillStyle = '#1d1f22';
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f2f0ea';
    g.beginPath();
    g.arc(cx, cy, r - 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1d1f22';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.save();
      g.translate(cx + Math.sin(a) * (r - 14), cy - Math.cos(a) * (r - 14));
      g.rotate(a);
      g.fillRect(-2, -6, 4, i % 3 ? 8 : 12);
      g.restore();
    }
    // Stopped at 3:12.
    g.strokeStyle = '#1d1f22';
    g.lineCap = 'round';
    g.lineWidth = 5;
    const ha = ((3 + 12 / 60) / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(ha) * r * 0.45, cy - Math.cos(ha) * r * 0.45);
    g.stroke();
    g.lineWidth = 3;
    const ma = (12 / 60) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(ma) * r * 0.7, cy - Math.cos(ma) * r * 0.7);
    g.stroke();
  });
  add('dartboard', 1, 1, (g, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 3;
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * Math.PI * 2;
      const a1 = ((i + 1) / 20) * Math.PI * 2;
      for (const [r0, r1, c0, c1] of [[0.62, 1, '#151515', '#e8dcc0'], [0.55, 0.62, '#b3141a', '#0d7a3a'], [0.12, 0.55, '#151515', '#e8dcc0']] as const) {
        g.fillStyle = i % 2 ? c0 : c1;
        g.beginPath();
        g.arc(cx, cy, r * r1, a0, a1);
        g.arc(cx, cy, r * r0, a1, a0, true);
        g.closePath();
        g.fill();
      }
    }
    g.fillStyle = '#b3141a';
    g.beginPath();
    g.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
    g.fill();
  });
  return E;
}

export interface AtlasMaterials {
  /** Printed signs, posters, boards (lit by the room). */
  sign: THREE.MeshStandardMaterial;
  /** Door plates: lit by the room plus a faint backlight. */
  plate: THREE.MeshStandardMaterial;
  /** Status panels with their own light (dim with the power, see Site9.setBlackout). */
  lit: THREE.MeshStandardMaterial;
  /** Exit signs: battery backed, stay on in a blackout. */
  exit: THREE.MeshStandardMaterial;
  /** Dirt, cracks, scorch, oil, graffiti, stencils. */
  decal: THREE.MeshStandardMaterial;
  /** Standing water / oil puddles: mirror-smooth. */
  wet: THREE.MeshStandardMaterial;
  /** Frost on the cold floors. */
  frost: THREE.MeshStandardMaterial;
}

export class Site9Atlas {
  readonly texture: THREE.CanvasTexture;
  readonly mats: AtlasMaterials;
  private rects = new Map<string, [number, number, number, number]>();

  constructor(mobile: boolean, rooms: { id: string; rect: [number, number, number, number]; name?: string; zone?: string }[]) {
    const k = mobile ? 0.5 : 1;
    const c = document.createElement('canvas');
    c.width = SHEET * k;
    c.height = SHEET_H * k;
    const g = c.getContext('2d')!;
    // Shelf packing on the unit grid, tallest first.
    const list = entries(rooms).sort((a, b) => b.h - a.h || b.w - a.w);
    let cx = 0;
    let cy = 0;
    let rowH = 0;
    let seed = 0x9e37;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const e of list) {
      if (cx + e.w > COLS) {
        cx = 0;
        cy += rowH;
        rowH = 0;
      }
      if (cy + e.h > ROWS) {
        console.warn(`Site9Atlas: no room for ${e.id}`);
        continue;
      }
      const px = cx * UNIT + GUTTER;
      const py = cy * UNIT + GUTTER;
      const pw = e.w * UNIT - GUTTER * 2;
      const ph = e.h * UNIT - GUTTER * 2;
      g.save();
      g.scale(k, k);
      g.translate(px, py);
      g.beginPath();
      g.rect(0, 0, pw, ph);
      g.clip();
      e.draw(g, pw, ph, rnd);
      g.restore();
      // UVs (flipY: v = 1 at the top of the canvas), half a texel in from the edge.
      const inset = 0.5 / k;
      this.rects.set(e.id, [(px + inset) / SHEET, 1 - (py + ph - inset) / SHEET_H, (px + pw - inset) / SHEET, 1 - (py + inset) / SHEET_H]);
      cx += e.w;
      rowH = Math.max(rowH, e.h);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = mobile ? MOBILE_ANISOTROPY : 8;
    this.texture = t;
    const decal = (o: THREE.MeshStandardMaterialParameters) =>
      new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...o });
    this.mats = {
      sign: new THREE.MeshStandardMaterial({ map: t, roughness: 0.62, metalness: 0.05 }),
      plate: new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.5, metalness: 0.2 }),
      lit: new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.3 }),
      exit: new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.3 }),
      decal: decal({ roughness: 0.92 }),
      wet: decal({ color: 0x0e1114, roughness: 0.04, metalness: 0.4, opacity: 0.85 }),
      frost: decal({ roughness: 0.35, color: 0xdfeefc }),
    };
  }

  has(id: string): boolean {
    return this.rects.has(id);
  }

  /** A w × h plane showing atlas entry `id` (faces +Z). */
  plane(id: string, w: number, h: number): THREE.BufferGeometry {
    const g = new THREE.PlaneGeometry(w, h);
    const r = this.rects.get(id);
    if (!r) return g;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    return g;
  }

  /** Aspect (w / h) of an entry's cell. */
  aspect(id: string): number {
    const r = this.rects.get(id);
    return r ? ((r[2] - r[0]) * SHEET) / ((r[3] - r[1]) * SHEET_H) : 1;
  }
}
