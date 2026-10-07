/**
 * The terminal's screen: a 192×144 canvas drawn pixel by pixel (scaled up by CSS), a
 * 3×5 bitmap font and palette sprites. Everything a program draws goes through here.
 */

export const W = 192;
export const H = 144;

/** 3×5 glyphs, five rows of three ('#' lit). */
const GLYPH_ROWS: Record<string, string> = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.',
  E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#',
  I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
  M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..',
  Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#',
  Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###', '0': '### #.# #.# #.# ###', '1': '.#. ##. .#. .#. ###',
  '2': '##. ..# .#. #.. ###', '3': '##. ..# .#. ..# ##.', '4': '#.# #.# ### ..# ..#', '5': '### #.. ##. ..# ##.',
  '6': '.## #.. ### #.# ###', '7': '### ..# .#. .#. .#.', '8': '### #.# ### #.# ###', '9': '### #.# ### ..# ##.',
  '.': '... ... ... ... .#.', ',': '... ... ... ##. .#.', '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.',
  ':': '... .#. ... .#. ...', '-': '... ... ### ... ...', "'": '.#. .#. ... ... ...', '"': '#.# #.# ... ... ...',
  '/': '..# ..# .#. #.. #..', '(': '.#. #.. #.. #.. .#.', ')': '.#. ..# ..# ..# .#.', '+': '... .#. ### .#. ...',
  '%': '#.# ..# .#. #.. #.#', '°': '##. ##. ... ... ...', '=': '... ### ... ### ...', '>': '#.. .#. ..# .#. #..',
  '<': '..# .#. #.. .#. ..#', '_': '... ... ... ... ###', '#': '#.# ### #.# ### #.#', '♪': '.## .#. .#. ##. ##.',
  '[': '##. #.. #.. #.. ##.', ']': '.## ..# ..# ..# .##', '*': '... #.# .#. #.# ...', '~': '... .#. #.# ... ...',
};
const GLYPHS: Record<string, string> = Object.fromEntries(Object.entries(GLYPH_ROWS).map(([k, v]) => [k, v.replace(/ /g, '')]));

/** Normalise text to the glyph set (upper case, Turkish letters folded, minus sign). */
function norm(s: string): string {
  return s
    .replace(/−/g, '-')
    .replace(/…/g, '...')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/×/g, 'X')
    .toUpperCase()
    .replace(/[İI]/g, 'I')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C');
}

export type Align = 'left' | 'center' | 'right';

export interface Sprite {
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
}

/** A sprite from rows of palette keys ('.' transparent). */
export function sprite(rows: string[], pal: Record<string, string>): Sprite {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = pal[row[x]];
      if (!c) continue;
      g.fillStyle = c;
      g.fillRect(x, y, 1, 1);
    }
  });
  return { w, h, canvas };
}

export class Screen {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  /** Screen shake, decays every frame (in pixels). */
  shake = 0;
  private ox = 0;
  private oy = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.g.imageSmoothingEnabled = false;
  }

  /** Start a frame: shake offset for this frame. */
  begin(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 18);
    this.ox = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    this.oy = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
  }

  clear(c: string): void {
    this.g.fillStyle = c;
    this.g.fillRect(0, 0, W, H);
  }

  rect(x: number, y: number, w: number, h: number, c: string): void {
    this.g.fillStyle = c;
    this.g.fillRect(Math.round(x) + this.ox, Math.round(y) + this.oy, Math.round(w), Math.round(h));
  }

  /** A 1-px outline. */
  frame(x: number, y: number, w: number, h: number, c: string): void {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c);
    this.rect(x + w - 1, y, 1, h, c);
  }

  /** A 1-px line (Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number, c: string): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    this.g.fillStyle = c;
    for (let i = 0; i < 600; i++) {
      this.g.fillRect(x0 + this.ox, y0 + this.oy, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  draw(s: Sprite, x: number, y: number, flip = false, scale = 1): void {
    const g = this.g;
    const px = Math.round(x) + this.ox;
    const py = Math.round(y) + this.oy;
    if (!flip && scale === 1) {
      g.drawImage(s.canvas, px, py);
      return;
    }
    g.save();
    g.translate(px + (flip ? s.w * scale : 0), py);
    g.scale(flip ? -scale : scale, scale);
    g.drawImage(s.canvas, 0, 0);
    g.restore();
  }

  /** Width of a string in pixels at a scale. */
  textWidth(s: string, scale = 1): number {
    return norm(s).length * 4 * scale - scale;
  }

  text(s: string, x: number, y: number, c: string, scale = 1, align: Align = 'left'): void {
    const t = norm(s);
    let cx = Math.round(x) + this.ox;
    const cy = Math.round(y) + this.oy;
    if (align !== 'left') cx -= Math.round(this.textWidth(t, scale) / (align === 'center' ? 2 : 1));
    this.g.fillStyle = c;
    for (const ch of t) {
      const glyph = GLYPHS[ch];
      if (glyph)
        for (let i = 0; i < 15; i++) if (glyph[i] === '#') this.g.fillRect(cx + (i % 3) * scale, cy + Math.floor(i / 3) * scale, scale, scale);
      cx += 4 * scale;
    }
  }

  /** Word-wrapped text in a box `w` wide; returns the height used. */
  para(s: string, x: number, y: number, w: number, c: string, lineH = 7): number {
    const max = Math.max(1, Math.floor((w + 1) / 4));
    const lines: string[] = [];
    for (const raw of s.split('\n')) {
      let line = '';
      for (const word of raw.split(' ')) {
        if (line && (line + ' ' + word).length > max) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    lines.forEach((l, i) => this.text(l, x, y + i * lineH, c));
    return lines.length * lineH;
  }

  /** A dialogue box along the bottom (or top). */
  box(s: string, c = '#e8e8e8', top = false, bg = '#000000', edge = '#8a8a8a'): void {
    const y = top ? 4 : H - 30;
    this.rect(4, y, W - 8, 26, bg);
    this.frame(4, y, W - 8, 26, edge);
    this.para(s, 9, y + 5, W - 18, c);
  }

  /** Sprinkle static over the whole screen (`amount` 0..1). */
  noise(amount: number, c = '#ffffff'): void {
    const n = Math.floor(W * H * amount * 0.04);
    this.g.fillStyle = c;
    for (let i = 0; i < n; i++) this.g.fillRect((Math.random() * W) | 0, (Math.random() * H) | 0, 1, 1);
  }

  /** Fill the whole screen with a translucent colour. */
  tint(c: string, a: number): void {
    this.g.globalAlpha = Math.max(0, Math.min(1, a));
    this.g.fillStyle = c;
    this.g.fillRect(0, 0, W, H);
    this.g.globalAlpha = 1;
  }
}
