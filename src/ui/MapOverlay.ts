import type * as THREE from 'three';
import type { RoomDef, WallRun, DoorSlot } from '../world/LayoutBuilder';
import type { WallBuy, Terminal } from '../world/Site9';
import type { UtilityMarker } from '../game/Utilities';

export interface MapData {
  rooms: RoomDef[];
  walls: WallRun[];
  doors: DoorSlot[];
  wallBuys: WallBuy[];
  terminals: Terminal[];
  bounds: [number, number, number, number];
}

export interface MapState {
  player: { x: number; z: number; yaw: number };
  unlocked: Set<string>;
  isOpen(d: DoorSlot): boolean;
  robots: { x: number; z: number }[];
  allies: { x: number; z: number }[];
  enemies: { x: number; z: number }[];
  /** Stations, breakers, crate, sentries, ammo. */
  utilities?: UtilityMarker[];
  lightsOut?: () => boolean;
  /** Extraction points (open at the end of the match). */
  exits?: { x: number; z: number; name: string }[];
  /** The supply drop, announced or down. */
  drop?: { x: number; z: number } | null;
}

/**
 * The look: the HUD's (src/ui/hud-file.css). A dark surveyed plan, walls in aged
 * off-white ink, one red for what's shut or hostile, the rest muted.
 */
const INK = '#e4e0d4';
const RED = '#c8321f';
const HOSTILE = '#e0583a';
const ALLY = '#8fd0e8';
const EXIT = '#5fd08a';
const BUY = '#d8b65a';
const HIRE = '#8fb3c9';
/** Map type: the HUD's faces (Rajdhani, JetBrains Mono, loaded by index.html). */
const SANS = "Rajdhani, Bahnschrift, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', Consolas, monospace";
/** Shadow under marks drawn on the plan (thin and soft, never a black cartoon outline). */
const UNDER = 'rgba(0,0,0,0.62)';

const UTIL: Record<UtilityMarker['kind'], { color: string; glyph: string; name: string }> = {
  med: { color: '#6fc98c', glyph: '+', name: 'MEDICAL' },
  armor: { color: '#a9bccb', glyph: 'A', name: 'ARMOR' },
  breaker: { color: '#d8b65a', glyph: 'ϟ', name: 'POWER' },
  crate: { color: '#b49ad2', glyph: '?', name: 'SUPPLY' },
  turret: { color: HOSTILE, glyph: 'T', name: 'SENTRY' },
  ammo: { color: '#aeb27e', glyph: 'a', name: 'AMMO' },
};

/** Floor tone per room style: near-black, only a hint of what the room is. */
const ROOM_TINT: Record<string, string> = {
  lobby: '#25231f', cafe: '#28221b', security: '#1e2125', garden: '#1c231b', medical: '#1a2422', atrium: '#262421',
  factory: '#1e1f21', hangar: '#212326', labs: '#23272b', servers: '#171a1e', barracks: '#1f221d',
};
const S = 4; // static layer: pixels per metre

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

/**
 * Full-screen map (M) + a rotating minimap in the corner. Both draw from the
 * same layout data: rooms (locked zones dimmed), walls, shutters with prices,
 * wall weapons, the hire terminal, you, your allies and nearby threats.
 */
export class MapOverlay {
  private staticCanvas = document.createElement('canvas');
  private staticSet: Set<string> | null = null;
  private staticSize = -1;
  private full: HTMLDivElement;
  private fullCanvas: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private miniTimer = 0;
  private fullTimer = 0;
  /** Film grain over the minimap disc, painted once. */
  private grain: CanvasPattern | null = null;
  visible = false;
  /** Settings → MINIMAP (the full map on M stays). */
  private miniOn = true;

  constructor(parent: HTMLElement, private data: MapData) {
    const [x0, z0, x1, z1] = data.bounds;
    this.staticCanvas.width = (x1 - x0) * S;
    this.staticCanvas.height = (z1 - z0) * S;
    this.full = document.createElement('div');
    this.full.className = 'map-full';
    this.fullCanvas = document.createElement('canvas');
    this.full.appendChild(this.fullCanvas);
    const legend = document.createElement('div');
    legend.className = 'map-legend';
    const glyph = (k: UtilityMarker['kind'], label: string) => `<span><b style="color:${UTIL[k].color}">${UTIL[k].glyph}</b> ${label}</span>`;
    legend.innerHTML =
      '<span><i class="lg you"></i>You</span><span><i class="lg ally"></i>Allies</span><span><i class="lg door"></i>Shutter (price)</span>' +
      '<span><i class="lg buy"></i>Weapon</span><span><i class="lg hire"></i>Hire terminal</span><span><i class="lg bot"></i>Robots</span><span><i class="lg foe"></i>Enemy (firing)</span>' +
      glyph('med', 'Medical') + glyph('armor', 'Armor') + glyph('breaker', 'Power breaker') + glyph('crate', 'Supply crate') + glyph('turret', 'Sentry') +
      `<span class="lg-key">${document.body.classList.contains('is-touch') ? 'TAP TO CLOSE' : 'M · CLOSE'}</span>`;
    this.full.appendChild(legend);
    parent.appendChild(this.full);
    this.mini = document.createElement('canvas');
    this.mini.className = 'minimap';
    this.mini.width = this.mini.height = 400; // shown at 200 css px: crisp on any screen
    parent.appendChild(this.mini);
    document.body.classList.add('has-minimap');
  }

  /** Touch: tapping the minimap opens the full map (and tapping the map closes it). */
  onMiniTap(cb: () => void): void {
    this.mini.style.pointerEvents = 'auto';
    this.mini.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cb();
    });
    this.full.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cb();
    });
  }

  /** Show or hide the corner minimap (hidden: not drawn at all). */
  setMinimap(on: boolean): void {
    this.miniOn = on;
    this.mini.style.display = on ? '' : 'none';
    document.body.classList.toggle('has-minimap', on);
    this.miniTimer = 0;
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.full.classList.toggle('show', this.visible);
    this.fullTimer = 0; // draw on the next update, not after the throttle
    return this.visible;
  }

  private toCanvas(x: number, z: number): [number, number] {
    return [(x - this.data.bounds[0]) * S, (z - this.data.bounds[1]) * S];
  }

  /** Rooms + walls; redrawn only when the set of unlocked zones changes. (Names are drawn upright on top.) */
  private drawStatic(state: MapState): void {
    // Zones only ever unlock (the set only grows), so its size is its version.
    if (state.unlocked === this.staticSet && state.unlocked.size === this.staticSize) return;
    this.staticSet = state.unlocked;
    this.staticSize = state.unlocked.size;
    const g = this.staticCanvas.getContext('2d')!;
    g.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    for (const r of this.data.rooms) {
      const [a, b] = this.toCanvas(r.rect[0], r.rect[1]);
      const w = (r.rect[2] - r.rect[0]) * S;
      const h = (r.rect[3] - r.rect[1]) * S;
      const open = state.unlocked.has(r.zone);
      g.fillStyle = open ? (ROOM_TINT[r.style] ?? '#222') : '#0c0d0f';
      g.fillRect(a, b, w, h);
      g.save();
      g.beginPath();
      g.rect(a, b, w, h);
      g.clip();
      g.beginPath();
      if (open) {
        // A surveyor's grid every 4 m.
        g.strokeStyle = 'rgba(228,224,212,0.045)';
        g.lineWidth = 1;
        for (let x = a + 4 * S; x < a + w; x += 4 * S) {
          g.moveTo(x, b);
          g.lineTo(x, b + h);
        }
        for (let y = b + 4 * S; y < b + h; y += 4 * S) {
          g.moveTo(a, y);
          g.lineTo(a + w, y);
        }
      } else {
        // Locked: fine hatching, so open ground reads at a glance.
        g.strokeStyle = 'rgba(200,50,31,0.14)';
        g.lineWidth = 1.5;
        for (let k = -h; k < w; k += 10) {
          g.moveTo(a + k, b);
          g.lineTo(a + k + h, b + h);
        }
      }
      g.stroke();
      g.restore();
    }
    // Walls in ink, over a soft dark bed so they read on any floor tone.
    g.lineCap = 'square';
    g.beginPath();
    for (const w of this.data.walls) {
      const [ax, az] = this.toCanvas(w.x0, w.z0);
      const [bx, bz] = this.toCanvas(w.x1, w.z1);
      g.moveTo(ax, az);
      g.lineTo(bx, bz);
    }
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 5;
    g.stroke();
    g.strokeStyle = 'rgba(228,224,212,0.78)';
    g.lineWidth = 2;
    g.stroke();
  }

  /** A square tag with text (prices, names): dark, a stripe of its colour on the left. */
  private tag(g: Ctx, text: string, x: number, y: number, fg: string, px: number, size = 10): void {
    g.font = `700 ${size * px}px ${MONO}`;
    g.letterSpacing = `${0.8 * px}px`;
    const w = g.measureText(text).width + 10 * px;
    const h = (size + 6) * px;
    g.fillStyle = 'rgba(6,7,9,0.88)';
    g.fillRect(x - w / 2, y - h / 2, w, h);
    g.fillStyle = fg;
    g.fillRect(x - w / 2, y - h / 2, 2 * px, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + 1 * px, y + 0.5 * px);
    g.letterSpacing = '0px';
  }

  /** A ringed glyph (utilities): dark core, thin ring, the glyph in the HUD face. */
  private ring(g: Ctx, x: number, y: number, r: number, color: string, glyph: string, px: number, size: number): void {
    g.beginPath();
    g.arc(x, y, r + 1.5 * px, 0, Math.PI * 2);
    g.fillStyle = UNDER;
    g.fill();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8,9,11,0.92)';
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 1.4 * px;
    g.stroke();
    g.fillStyle = color;
    g.font = `700 ${size * px}px ${SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, x, y + 0.5 * px);
  }

  /**
   * Everything dynamic, drawn in screen space through `proj` (world → screen):
   * icons and text stay upright and the same size on the rotating minimap too.
   */
  private drawMarkers(g: Ctx, state: MapState, proj: (x: number, z: number) => [number, number], full: boolean, px: number, clipR = Infinity, cx = 0, cy = 0): void {
    const inside = (x: number, y: number, pad = 0) => Math.hypot(x - cx, y - cy) < clipR - pad;
    g.lineCap = 'butt';
    // Room names (upright), spaced mono like the dossier's labels.
    for (const r of this.data.rooms) {
      const [x, y] = proj((r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2);
      if (!inside(x, y, 20 * px)) continue;
      const open = state.unlocked.has(r.zone);
      g.font = `700 ${(full ? 11 : 7.5) * px}px ${MONO}`;
      g.letterSpacing = `${(full ? 2.2 : 1.4) * px}px`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 2.5 * px;
      g.strokeStyle = UNDER;
      const name = r.name.toUpperCase();
      g.strokeText(name, x, y);
      g.fillStyle = open ? 'rgba(228,224,212,0.66)' : 'rgba(228,224,212,0.3)';
      g.fillText(name, x, y);
      if (full && !open) {
        g.font = `700 ${9 * px}px ${MONO}`;
        g.strokeText('LOCKED', x, y + 14 * px);
        g.fillStyle = 'rgba(200,50,31,0.8)';
        g.fillText('LOCKED', x, y + 14 * px);
      }
    }
    g.letterSpacing = '0px';
    // Shutters: a red bar when shut (with its price), a faint ink line when open.
    for (const d of this.data.doors) {
      const open = state.isOpen(d);
      const hw = d.width / 2;
      const [ax, ay] = proj(d.center.x - (d.alongX ? hw : 0), d.center.z - (d.alongX ? 0 : hw));
      const [bx, by] = proj(d.center.x + (d.alongX ? hw : 0), d.center.z + (d.alongX ? 0 : hw));
      if (!inside((ax + bx) / 2, (ay + by) / 2, 4 * px)) continue;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      if (open) {
        g.strokeStyle = 'rgba(228,224,212,0.28)';
        g.lineWidth = 1.5 * px;
        g.stroke();
      } else {
        g.strokeStyle = UNDER;
        g.lineWidth = 6.5 * px;
        g.stroke();
        g.strokeStyle = RED;
        g.lineWidth = 4 * px;
        g.stroke();
      }
      if (full && !open) this.tag(g, `$${d.link.cost}`, (ax + bx) / 2, (ay + by) / 2 - 13 * px, BUY, px, 9);
    }
    // Wall weapons: a small amber diamond; name + price on the big map.
    for (const w of this.data.wallBuys) {
      const [x, y] = proj(w.pos.x, w.pos.z);
      if (!inside(x, y, 6 * px)) continue;
      const r = 5 * px;
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.fillStyle = 'rgba(8,9,11,0.92)';
      g.fill();
      g.strokeStyle = BUY;
      g.lineWidth = 1.5 * px;
      g.stroke();
      if (full) this.tag(g, `${w.weapon.replace(/_/g, ' ').toUpperCase()} $${w.cost}`, x, y + 14 * px, BUY, px, 8);
    }
    for (const t of this.data.terminals) {
      const [x, y] = proj(t.pos.x, t.pos.z);
      if (!inside(x, y, 6 * px)) continue;
      g.fillStyle = 'rgba(8,9,11,0.92)';
      g.fillRect(x - 5 * px, y - 5 * px, 10 * px, 10 * px);
      g.strokeStyle = HIRE;
      g.lineWidth = 1.5 * px;
      g.strokeRect(x - 5 * px, y - 5 * px, 10 * px, 10 * px);
      g.fillStyle = HIRE;
      g.fillRect(x - 1.5 * px, y - 1.5 * px, 3 * px, 3 * px);
      if (full) this.tag(g, 'HIRE', x, y + 14 * px, HIRE, px, 8);
    }
    for (const u of state.utilities ?? []) {
      const [x, y] = proj(u.x, u.z);
      if (!inside(x, y, 8 * px)) continue;
      const k = UTIL[u.kind];
      const hot = u.kind === 'breaker' ? !!state.lightsOut?.() : !!u.on;
      const small = u.kind === 'ammo';
      this.ring(g, x, y, (small ? 6 : 7.5) * px, hot ? RED : k.color, k.glyph, px, small ? 9 : 11);
      if (full && !small) this.tag(g, k.name, x, y + 16 * px, k.color, px, 8);
    }
    for (const e of state.exits ?? []) {
      const [x, y] = proj(e.x, e.z);
      if (!inside(x, y, 10 * px)) continue;
      g.beginPath();
      g.arc(x, y, 12 * px, 0, Math.PI * 2);
      g.fillStyle = 'rgba(95,208,138,0.14)';
      g.fill();
      g.strokeStyle = EXIT;
      g.lineWidth = 1.5 * px;
      g.stroke();
      g.beginPath();
      g.arc(x, y, 7 * px, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = EXIT;
      g.fillRect(x - 1.5 * px, y - 1.5 * px, 3 * px, 3 * px);
      this.tag(g, full ? `EXIT · ${e.name.toUpperCase()}` : 'EXIT', x, y + 20 * px, EXIT, px, 8);
    }
    if (state.drop) {
      const [x, y] = proj(state.drop.x, state.drop.z);
      if (inside(x, y, 10 * px)) {
        const r = 8 * px;
        g.beginPath();
        g.moveTo(x, y - r);
        g.lineTo(x + r, y);
        g.lineTo(x, y + r);
        g.lineTo(x - r, y);
        g.closePath();
        g.fillStyle = 'rgba(224,88,58,0.2)';
        g.fill();
        g.strokeStyle = HOSTILE;
        g.lineWidth = 1.6 * px;
        g.stroke();
        this.tag(g, full ? 'SUPPLY DROP' : 'DROP', x, y + 17 * px, HOSTILE, px, 8);
      }
    }
    // Contacts: a dark halo under each dot instead of a black outline.
    const dot = (p: { x: number; z: number }, color: string, r: number, square = false) => {
      const [x, y] = proj(p.x, p.z);
      if (!inside(x, y, 3 * px)) return;
      g.fillStyle = UNDER;
      g.beginPath();
      g.arc(x, y, (r + 1.6) * px, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = color;
      if (square) g.fillRect(x - r * px, y - r * px, 2 * r * px, 2 * r * px);
      else {
        g.beginPath();
        g.arc(x, y, r * px, 0, Math.PI * 2);
        g.fill();
      }
    };
    for (const r of state.robots) dot(r, RED, 2.8, true);
    for (const e of state.enemies) dot(e, HOSTILE, 4);
    for (const a of state.allies) dot(a, ALLY, 4.2);
    // You: a view cone (where you're looking) and an ink chevron; on the minimap both point up.
    const [x, y] = proj(state.player.x, state.player.z);
    g.save();
    g.translate(x, y);
    if (full) g.rotate(-state.player.yaw);
    const reach = (full ? 60 : 70) * px;
    const cone = g.createRadialGradient(0, 0, 4 * px, 0, 0, reach);
    cone.addColorStop(0, 'rgba(228,224,212,0.26)');
    cone.addColorStop(1, 'rgba(228,224,212,0)');
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, reach, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(0, -9 * px);
    g.lineTo(6.5 * px, 7 * px);
    g.lineTo(0, 3.5 * px);
    g.lineTo(-6.5 * px, 7 * px);
    g.closePath();
    g.lineJoin = 'miter';
    g.strokeStyle = UNDER;
    g.lineWidth = 3 * px;
    g.stroke();
    g.fillStyle = INK;
    g.fill();
    g.restore();
  }

  update(dt: number, state: MapState): void {
    this.drawStatic(state);
    // Phones: full map at 15 Hz and minimap at 15 Hz (canvas uploads every frame cost raster time).
    const touch = document.body.classList.contains('is-touch');
    if (this.visible) {
      this.fullTimer -= dt;
      if (this.fullTimer <= 0) {
        this.fullTimer = touch ? 1 / 15 : 0;
        this.drawFull(state, touch);
      }
    }
    this.miniTimer -= dt;
    if (this.miniOn && this.miniTimer <= 0) {
      this.miniTimer = touch ? 1 / 15 : 1 / 20;
      this.drawMini(state);
    }
  }

  private drawFull(state: MapState, touch: boolean): void {
    const c = this.fullCanvas;
    const dpr = Math.min(touch ? 1.5 : 2, window.devicePixelRatio || 1);
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.82;
    const sc = Math.min(maxW / this.staticCanvas.width, maxH / this.staticCanvas.height);
    const w = Math.round(this.staticCanvas.width * sc);
    const h = Math.round(this.staticCanvas.height * sc);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#08090b';
    g.fillRect(0, 0, c.width, c.height);
    const k = sc * dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.drawImage(this.staticCanvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const [b0, b1] = this.data.bounds;
    this.drawMarkers(g, state, (x, z) => [(x - b0) * S * k, (z - b1) * S * k], true, dpr);
  }

  /** Fine light and dark specks, tiled over the minimap disc like print grain. */
  private grainPattern(g: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.grain) return this.grain;
    const n = document.createElement('canvas');
    n.width = n.height = 96;
    const q = n.getContext('2d')!;
    const img = q.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random();
      const light = v > 0.5;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 230 : 0;
      img.data[i + 3] = Math.random() < 0.35 ? Math.round(Math.random() * 60) : 0;
    }
    q.putImageData(img, 0, 0);
    this.grain = g.createPattern(n, 'repeat');
    return this.grain;
  }

  private drawMini(state: MapState): void {
    const c = this.mini;
    const g: Ctx = c.getContext('2d')!;
    const px = c.width / 200; // drawn at 2x for crisp icons and text
    const R = c.width / 2;
    const rim = R - 3 * px;
    const metres = 42; // radius shown
    const sc = R / (metres * S);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath();
    g.arc(R, R, rim, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(7,8,10,0.86)';
    g.fillRect(0, 0, c.width, c.height);
    const [pcx, pcz] = this.toCanvas(state.player.x, state.player.z);
    const yaw = state.player.yaw;
    g.translate(R, R);
    g.rotate(yaw);
    g.scale(sc, sc);
    g.translate(-pcx, -pcz);
    g.drawImage(this.staticCanvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Range ring at half the radius (21 m).
    g.strokeStyle = 'rgba(228,224,212,0.08)';
    g.lineWidth = 1 * px;
    g.beginPath();
    g.arc(R, R, rim * 0.5, 0, Math.PI * 2);
    g.stroke();
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const proj = (x: number, z: number): [number, number] => {
      const [qx, qz] = this.toCanvas(x, z);
      const dx = (qx - pcx) * sc;
      const dz = (qz - pcz) * sc;
      return [R + dx * cos - dz * sin, R + dx * sin + dz * cos];
    };
    this.drawMarkers(g, state, proj, false, px, rim, R, R);
    // The disc darkens toward its edge, then the grain over all of it.
    const vig = g.createRadialGradient(R, R, rim * 0.55, R, R, rim);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = vig;
    g.fillRect(0, 0, c.width, c.height);
    const grain = this.grainPattern(g);
    if (grain) {
      g.fillStyle = grain;
      g.fillRect(0, 0, c.width, c.height);
    }
    g.restore();
    // Bezel: a hairline ring and compass ticks turning with the map.
    g.strokeStyle = 'rgba(228,224,212,0.42)';
    g.lineWidth = 1.2 * px;
    g.beginPath();
    g.arc(R, R, rim, 0, Math.PI * 2);
    g.stroke();
    const north = yaw - Math.PI / 2;
    g.beginPath();
    for (let i = 0; i < 36; i++) {
      const a = north + (i * Math.PI) / 18;
      const len = (i % 9 === 0 ? 0 : i % 3 === 0 ? 6 : 3) * px;
      if (!len) continue;
      g.moveTo(R + Math.cos(a) * rim, R + Math.sin(a) * rim);
      g.lineTo(R + Math.cos(a) * (rim - len), R + Math.sin(a) * (rim - len));
    }
    g.strokeStyle = 'rgba(228,224,212,0.35)';
    g.lineWidth = 1 * px;
    g.stroke();
    // Cardinal letters: N in red, the rest dim.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    ['N', 'E', 'S', 'W'].forEach((l, i) => {
      const a = north + (i * Math.PI) / 2;
      const d = rim - 10 * px;
      const x = R + Math.cos(a) * d;
      const y = R + Math.sin(a) * d;
      g.font = `700 ${(i === 0 ? 12 : 9) * px}px ${MONO}`;
      g.lineWidth = 3 * px;
      g.strokeStyle = UNDER;
      g.strokeText(l, x, y);
      g.fillStyle = i === 0 ? RED : 'rgba(228,224,212,0.5)';
      g.fillText(l, x, y);
    });
  }

  /** For callers that only know a THREE vector. */
  static pos(v: THREE.Vector3): { x: number; z: number } {
    return { x: v.x, z: v.z };
  }
}
