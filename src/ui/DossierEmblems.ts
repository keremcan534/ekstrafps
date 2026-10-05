/**
 * Faction insignia for the archive, drawn as vector (crisp at any size). Ink is
 * currentColor; each badge has one accent of its own.
 */

/** A gear outline: `teeth` square-ish teeth between radii r0 (root) and r1 (tip). */
function gear(cx: number, cy: number, r0: number, r1: number, teeth: number): string {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    const f = step * 0.22; // tooth flank
    const t = step * 0.16; // tip half-width
    const p = (r: number, ang: number) => `${(cx + Math.cos(ang) * r).toFixed(2)},${(cy + Math.sin(ang) * r).toFixed(2)}`;
    pts.push(p(r0, a - f - t), p(r1, a - t), p(r1, a + t), p(r0, a + f + t));
  }
  return `M${pts.join('L')}Z`;
}

const SVG = (body: string) => `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const EMBLEMS: Record<string, string> = {
  // SABLE: an angular black shield, a red visor slit, a fang below.
  sable: SVG(`
    <path d="M32 3 L55 11 V30 C55 45 45 55 32 61 C19 55 9 45 9 30 V11 Z" fill="#0c0c0e" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M32 8.5 L50 15 V30 C50 41.5 42.5 49.5 32 55 C21.5 49.5 14 41.5 14 30 V15 Z" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.2"/>
    <path d="M17 25 H47 L42.5 31.5 H21.5 Z" fill="#d4231b"/>
    <path d="M25 37 H39 L32 50 Z" fill="currentColor"/>`),
  // Vanta Dynamics: a ring and the company chevron.
  vanta: SVG(`
    <circle cx="32" cy="32" r="27" fill="#0b1220" stroke="currentColor" stroke-width="2.6"/>
    <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="1.2"/>
    <path d="M15 19 H25 L32 37 L39 19 H49 L36.5 47 H27.5 Z" fill="#5fb0ff"/>`),
  // Rival squads: a field shield, three chevrons (Bravo, Charlie, Delta).
  rivals: SVG(`
    <path d="M10 7 H54 V33 C54 46 44 55 32 61 C20 55 10 46 10 33 Z" fill="#17181b" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
    <g fill="none" stroke-width="4.4" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M18 17 L32 26 L46 17" stroke="#ffa040"/>
      <path d="M18 28 L32 37 L46 28" stroke="#9dff4a"/>
      <path d="M18 39 L32 48 L46 39" stroke="#d06aff"/>
    </g>`),
  // Rogue machines: a gear with a visor slit for a face.
  machines: SVG(`
    <path d="${gear(32, 32, 23, 29, 12)}" fill="#1b1b1e" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
    <rect x="17" y="20" width="30" height="24" rx="2" fill="#0d0d0f" stroke="currentColor" stroke-width="1.6"/>
    <rect x="21" y="29" width="22" height="5" fill="#ff2a3a"/>
    <circle cx="40" cy="24.5" r="1.8" fill="#ff2a3a"/>`),
  // Salvagers: a crossed wrench and crowbar on a round plate.
  salvage: SVG(`
    <circle cx="32" cy="32" r="28" fill="#1d1710" stroke="currentColor" stroke-width="2.6"/>
    <g stroke-linecap="round" fill="none">
      <path d="M17 49 L43 23 Q48 17 44.5 13" stroke="#d8a868" stroke-width="5"/>
      <path d="M47 47 L26 26" stroke="currentColor" stroke-width="5.4"/>
    </g>
    <path d="M27.8 17.6 A8.5 8.5 0 1 0 17.6 27.8 L22.6 22.6 Z" fill="currentColor"/>
    <circle cx="20" cy="20" r="2.6" fill="#1d1710"/>`),
  // The Choir: their pendant — a gear on a cord, a blade-like chevron above.
  choir: SVG(`
    <circle cx="32" cy="32" r="28" fill="#0a0506" stroke="currentColor" stroke-width="2.6"/>
    <path d="M22 26 L32 9 L42 26" fill="none" stroke="#c0182c" stroke-width="3" stroke-linejoin="miter"/>
    <path d="M32 26 V31" stroke="currentColor" stroke-width="2"/>
    <path d="${gear(32, 42, 8.5, 12, 8)}" fill="#c0182c"/>
    <circle cx="32" cy="42" r="4" fill="#0a0506"/>`),
  // Lab staff: a hexagon and a flask.
  staff: SVG(`
    <path d="M32 4 L56 18 V46 L32 60 L8 46 V18 Z" fill="#101418" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M26.5 15 H37.5 M29 15 V27 L19.5 45 Q18.4 48.5 21.8 48.5 H42.2 Q45.6 48.5 44.5 45 L35 27 V15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M23.7 40 H40.3 L43.4 46 Q44 47.3 42.6 47.3 H21.4 Q20 47.3 20.6 46 Z" fill="#a8c8ec"/>`),
};

export function emblem(id: string): string {
  return EMBLEMS[id] ?? '';
}
