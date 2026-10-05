/**
 * Grime for the archive, painted once on canvases (nothing moves): stains and scuffs
 * for the desk, coffee rings, smudges and creases for the paper, scratches and dust for
 * the photographs, and a ragged edge for paper and prints.
 */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Soft blotches (stains, damp, dirt). */
function blotches(g: CanvasRenderingContext2D, w: number, h: number, n: number, rgb: string, alpha: [number, number], size: [number, number]): void {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = rnd(size[0], size[1]);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = rnd(alpha[0], alpha[1]);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(0.6, `rgba(${rgb},${a * 0.45})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(x, y, r, r * rnd(0.5, 1), rnd(0, Math.PI), 0, Math.PI * 2);
    g.fill();
  }
}

/** Hairline scratches: long, slightly bent strokes. */
function scratches(g: CanvasRenderingContext2D, w: number, h: number, n: number, rgb: string, alpha: [number, number]): void {
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const len = rnd(30, 420);
    const a = Math.random() < 0.6 ? rnd(-0.35, 0.35) + (Math.random() < 0.5 ? 0 : Math.PI / 2) : rnd(0, Math.PI);
    g.strokeStyle = `rgba(${rgb},${rnd(alpha[0], alpha[1])})`;
    g.lineWidth = rnd(0.4, 1.3);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + rnd(-12, 12), y + Math.sin(a) * len * 0.5 + rnd(-12, 12), x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
}

/** Dust specks and fibres. */
function dust(g: CanvasRenderingContext2D, w: number, h: number, n: number, rgb: string, alpha: [number, number]): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(${rgb},${rnd(alpha[0], alpha[1])})`;
    const r = Math.random() < 0.9 ? rnd(0.4, 1.4) : rnd(1.5, 3);
    g.beginPath();
    g.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
    g.fill();
  }
  // A few hairs / fibres.
  for (let i = 0; i < n / 60; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    g.strokeStyle = `rgba(${rgb},${rnd(alpha[0], alpha[1])})`;
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + rnd(-20, 20), y + rnd(-20, 20), x + rnd(-30, 30), y + rnd(-30, 30), x + rnd(-40, 40), y + rnd(-40, 40));
    g.stroke();
  }
}

/** A coffee ring. */
function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  for (let k = 0; k < 3; k++) {
    g.strokeStyle = `rgba(92, 58, 24, ${rnd(0.12, 0.22)})`;
    g.lineWidth = rnd(1.5, 3.5);
    g.beginPath();
    g.arc(x + rnd(-2, 2), y + rnd(-2, 2), r + rnd(-2, 2), rnd(0, 1), Math.PI * 2 - rnd(0, 0.8));
    g.stroke();
  }
  const gr = g.createRadialGradient(x, y, r * 0.2, x, y, r);
  gr.addColorStop(0, 'rgba(110,70,30,0)');
  gr.addColorStop(0.85, 'rgba(110,70,30,0.06)');
  gr.addColorStop(1, 'rgba(110,70,30,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

export interface Grime {
  desk: string;
  paper: string;
  photo: string;
  screen: string;
}

export function makeGrime(): Grime {
  // Desk: dark stains, lighter scuffs, scratches, dust.
  const [d, dg] = canvas(1024, 1024);
  blotches(dg, 1024, 1024, 40, '0,0,0', [0.12, 0.3], [40, 220]);
  blotches(dg, 1024, 1024, 18, '120,118,112', [0.04, 0.1], [30, 160]);
  scratches(dg, 1024, 1024, 90, '200,198,190', [0.04, 0.14]);
  scratches(dg, 1024, 1024, 40, '0,0,0', [0.15, 0.35]);
  dust(dg, 1024, 1024, 900, '210,208,200', [0.05, 0.22]);

  // Paper: brown age blotches, smudged fingerprints, a ring or two, creases, edge burn.
  const [p, pg] = canvas(700, 900);
  blotches(pg, 700, 900, 30, '96,70,40', [0.08, 0.2], [30, 160]);
  blotches(pg, 700, 900, 10, '40,34,28', [0.05, 0.12], [12, 40]);
  ring(pg, rnd(420, 620), rnd(560, 820), rnd(38, 56));
  if (Math.random() < 0.6) ring(pg, rnd(60, 300), rnd(80, 300), rnd(26, 40));
  for (let k = 0; k < 2; k++) {
    // Creases: a dark line with a light edge beside it.
    const y = rnd(200, 700);
    const tilt = rnd(-30, 30);
    pg.strokeStyle = 'rgba(40,32,22,0.14)';
    pg.lineWidth = 1.4;
    pg.beginPath();
    pg.moveTo(0, y);
    pg.lineTo(700, y + tilt);
    pg.stroke();
    pg.strokeStyle = 'rgba(255,250,236,0.14)';
    pg.beginPath();
    pg.moveTo(0, y + 2);
    pg.lineTo(700, y + tilt + 2);
    pg.stroke();
  }
  scratches(pg, 700, 900, 30, '60,50,40', [0.04, 0.1]);
  dust(pg, 700, 900, 260, '50,40,30', [0.06, 0.2]);
  const edge = pg.createRadialGradient(350, 450, 260, 350, 450, 620);
  edge.addColorStop(0, 'rgba(70,50,28,0)');
  edge.addColorStop(1, 'rgba(70,50,28,0.48)');
  pg.fillStyle = edge;
  pg.fillRect(0, 0, 700, 900);

  // Photographs: bright hairline scratches and dust on the emulsion, a few dark specks.
  const [ph, hg] = canvas(900, 600);
  scratches(hg, 900, 600, 70, '235,235,230', [0.08, 0.28]);
  dust(hg, 900, 600, 500, '230,230,225', [0.08, 0.35]);
  dust(hg, 900, 600, 120, '0,0,0', [0.2, 0.5]);
  blotches(hg, 900, 600, 6, '255,255,250', [0.03, 0.07], [30, 120]);

  // The whole screen: a whisper of dust and a few long scratches.
  const [sc, sg] = canvas(1280, 720);
  scratches(sg, 1280, 720, 14, '220,218,210', [0.03, 0.08]);
  dust(sg, 1280, 720, 260, '220,218,210', [0.03, 0.12]);

  return { desk: d.toDataURL(), paper: p.toDataURL(), photo: ph.toDataURL(), screen: sc.toDataURL() };
}

/** A ragged outline for paper / prints (polygon with small random notches). */
export function raggedEdge(n = 22, depth = 3): string {
  const pts: string[] = [];
  const j = () => rnd(0, depth).toFixed(1);
  for (let i = 0; i <= n; i++) pts.push(`${((i / n) * 100).toFixed(2)}% ${j()}px`);
  for (let i = 0; i <= n; i++) pts.push(`calc(100% - ${j()}px) ${((i / n) * 100).toFixed(2)}%`);
  for (let i = n; i >= 0; i--) pts.push(`${((i / n) * 100).toFixed(2)}% calc(100% - ${j()}px)`);
  for (let i = n; i >= 0; i--) pts.push(`${j()}px ${((i / n) * 100).toFixed(2)}%`);
  return `polygon(${pts.join(',')})`;
}

/**
 * Wear for printed and stamped type (a mask: opaque ink with specks, scuffs and a few
 * scratches eaten out of it), so big letters read as inked onto something old.
 */
export function wearMask(w = 512, h = 256): string {
  const [c, g] = canvas(w, h);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  blotches(g, w, h, Math.round((w * h) / 9000), '0,0,0', [0.25, 0.6], [4, 22]);
  dust(g, w, h, Math.round((w * h) / 120), '0,0,0', [0.5, 1]);
  scratches(g, w, h, Math.round((w * h) / 9000), '0,0,0', [0.5, 0.9]);
  return c.toDataURL();
}
