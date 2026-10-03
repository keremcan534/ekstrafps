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
}

const UTIL: Record<UtilityMarker['kind'], { color: string; glyph: string; name: string }> = {
  med: { color: '#2bdc6a', glyph: '+', name: 'MEDICAL' },
  armor: { color: '#9fc4ff', glyph: 'A', name: 'ARMOR' },
  breaker: { color: '#ffd25a', glyph: 'ϟ', name: 'POWER' },
  crate: { color: '#c890ff', glyph: '?', name: 'SUPPLY' },
  turret: { color: '#ff8a5c', glyph: 'T', name: 'SENTRY' },
  ammo: { color: '#b9c46a', glyph: 'a', name: 'AMMO' },
};

const ROOM_COLORS: Record<string, string> = {
  lobby: '#cfc7b8', cafe: '#c79a6b', security: '#9aa3ad', garden: '#6f9a55', medical: '#9ccfc2', atrium: '#d8d4cc',
  factory: '#8c9096', hangar: '#a4a8ad', labs: '#dfe5ea', servers: '#55606c', barracks: '#7b8a76',
};
const S = 4; // static layer: pixels per metre

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
  visible = false;

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
    legend.innerHTML =
      '<span><i class="lg you"></i>You</span><span><i class="lg ally"></i>Allies</span><span><i class="lg door"></i>Shutter (price)</span>' +
      '<span><i class="lg buy"></i>Weapon</span><span><i class="lg term"></i>Hire terminal</span><span><i class="lg bot"></i>Robots</span><span><i class="lg foe"></i>Enemy (firing)</span>' +
      '<span><b style="color:#2bdc6a">+</b> Medical</span><span><b style="color:#9fc4ff">A</b> Armor</span><span><b style="color:#ffd25a">ϟ</b> Power breaker</span><span><b style="color:#c890ff">?</b> Supply crate</span><span><b style="color:#ff8a5c">T</b> Sentry</span><span class="lg-key">M close</span>';
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
      g.fillStyle = ROOM_COLORS[r.style] ?? '#999';
      g.fillRect(a, b, w, h);
      if (!state.unlocked.has(r.zone)) {
        // Locked: dark with diagonal hatching, so open ground reads at a glance.
        g.fillStyle = 'rgba(12,13,15,0.7)';
        g.fillRect(a, b, w, h);
        g.save();
        g.beginPath();
        g.rect(a, b, w, h);
        g.clip();
        g.strokeStyle = 'rgba(255,255,255,0.06)';
        g.lineWidth = 3;
        for (let k = -h; k < w; k += 18) {
          g.moveTo(a + k, b);
          g.lineTo(a + k + h, b + h);
        }
        g.stroke();
        g.restore();
      }
    }
    g.strokeStyle = '#0d0e10';
    g.lineWidth = 4;
    g.lineCap = 'square';
    g.beginPath();
    for (const w of this.data.walls) {
      const [ax, az] = this.toCanvas(w.x0, w.z0);
      const [bx, bz] = this.toCanvas(w.x1, w.z1);
      g.moveTo(ax, az);
      g.lineTo(bx, bz);
    }
    g.stroke();
  }

  /** Small dark pill with text (prices, names): readable on any background. */
  private pill(g: CanvasRenderingContext2D, text: string, x: number, y: number, fg: string, px: number, size = 11): void {
    g.font = `700 ${size * px}px system-ui, sans-serif`;
    const w = g.measureText(text).width + 8 * px;
    const h = (size + 5) * px;
    g.fillStyle = 'rgba(10,11,13,0.85)';
    g.beginPath();
    g.roundRect(x - w / 2, y - h / 2, w, h, 4 * px);
    g.fill();
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5 * px);
  }

  /**
   * Everything dynamic, drawn in screen space through `proj` (world → screen):
   * icons and text stay upright and the same size on the rotating minimap too.
   */
  private drawMarkers(g: CanvasRenderingContext2D, state: MapState, proj: (x: number, z: number) => [number, number], full: boolean, px: number, clipR = Infinity, cx = 0, cy = 0): void {
    const inside = (x: number, y: number, pad = 0) => Math.hypot(x - cx, y - cy) < clipR - pad;
    g.lineCap = 'round';
    // Room names (upright).
    for (const r of this.data.rooms) {
      const [x, y] = proj((r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2);
      if (!inside(x, y, 20 * px)) continue;
      const open = state.unlocked.has(r.zone);
      g.font = `800 ${(full ? 14 : 9) * px}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 3.5 * px;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      const name = r.name.toUpperCase();
      g.strokeText(name, x, y);
      g.fillStyle = open ? '#f2f2f2' : '#8d9298';
      g.fillText(name, x, y);
      if (full && !open) {
        g.font = `600 ${10 * px}px system-ui, sans-serif`;
        g.strokeText('LOCKED', x, y + 14 * px);
        g.fillStyle = '#8d9298';
        g.fillText('LOCKED', x, y + 14 * px);
      }
    }
    // Shutters: thick amber when closed (with price), thin green when open.
    for (const d of this.data.doors) {
      const open = state.isOpen(d);
      const hw = d.width / 2;
      const [ax, ay] = proj(d.center.x - (d.alongX ? hw : 0), d.center.z - (d.alongX ? 0 : hw));
      const [bx, by] = proj(d.center.x + (d.alongX ? hw : 0), d.center.z + (d.alongX ? 0 : hw));
      if (!inside((ax + bx) / 2, (ay + by) / 2, 4 * px)) continue;
      g.strokeStyle = open ? '#4fd36a' : '#ffb01f';
      g.lineWidth = (open ? 3 : 6) * px;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      if (full && !open) this.pill(g, `$${d.link.cost}`, (ax + bx) / 2, (ay + by) / 2 - 13 * px, '#ffd25a', px, 10);
    }
    // Wall weapons: yellow gun tag; name + price on the big map.
    for (const w of this.data.wallBuys) {
      const [x, y] = proj(w.pos.x, w.pos.z);
      if (!inside(x, y, 6 * px)) continue;
      g.fillStyle = '#ffd25a';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * px;
      g.beginPath();
      g.roundRect(x - 6 * px, y - 4 * px, 12 * px, 8 * px, 2 * px);
      g.fill();
      g.stroke();
      if (full) this.pill(g, `${w.weapon.replace(/_/g, ' ').toUpperCase()} $${w.cost}`, x, y + 14 * px, '#ffe9a8', px, 9);
    }
    for (const t of this.data.terminals) {
      const [x, y] = proj(t.pos.x, t.pos.z);
      if (!inside(x, y, 6 * px)) continue;
      g.fillStyle = '#4fb8ff';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * px;
      g.fillRect(x - 6 * px, y - 6 * px, 12 * px, 12 * px);
      g.strokeRect(x - 6 * px, y - 6 * px, 12 * px, 12 * px);
      if (full) this.pill(g, 'HIRE', x, y + 14 * px, '#9fd4ff', px, 9);
    }
    for (const u of state.utilities ?? []) {
      const [x, y] = proj(u.x, u.z);
      if (!inside(x, y, 8 * px)) continue;
      const k = UTIL[u.kind];
      const r = (u.kind === 'ammo' ? 7 : 9) * px;
      g.fillStyle = '#0d0f11';
      g.strokeStyle = u.kind === 'breaker' && state.lightsOut?.() ? '#ff3b2f' : u.on ? '#ff3b2f' : k.color;
      g.lineWidth = 2.2 * px;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = k.color;
      g.font = `900 ${(u.kind === 'ammo' ? 9 : 11) * px}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(k.glyph, x, y + 0.5 * px);
      if (full && u.kind !== 'ammo') this.pill(g, k.name, x, y + 16 * px, k.color, px, 9);
    }
    for (const e of state.exits ?? []) {
      const [x, y] = proj(e.x, e.z);
      if (!inside(x, y, 10 * px)) continue;
      g.fillStyle = 'rgba(43,255,122,0.25)';
      g.strokeStyle = '#2bff7a';
      g.lineWidth = 2.6 * px;
      g.beginPath();
      g.arc(x, y, 12 * px, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#2bff7a';
      g.font = `900 ${11 * px}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('⇪', x, y + 0.5 * px);
      this.pill(g, full ? `EXIT · ${e.name.toUpperCase()}` : 'EXIT', x, y + 19 * px, '#2bff7a', px, 9);
    }
    const dot = (p: { x: number; z: number }, color: string, r: number) => {
      const [x, y] = proj(p.x, p.z);
      if (!inside(x, y, 3 * px)) return;
      g.fillStyle = color;
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * px;
      g.beginPath();
      g.arc(x, y, r * px, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    };
    for (const r of state.robots) dot(r, '#ff3b2f', 3.5);
    for (const e of state.enemies) dot(e, '#ff8a1f', 5);
    for (const a of state.allies) dot(a, '#4fe0ff', 5.5);
    // You: a white arrow (pointing where you face; on the minimap that's always up).
    const [x, y] = proj(state.player.x, state.player.z);
    g.save();
    g.translate(x, y);
    if (full) g.rotate(-state.player.yaw);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 2 * px;
    g.beginPath();
    g.moveTo(0, -10 * px);
    g.lineTo(7 * px, 8 * px);
    g.lineTo(0, 4 * px);
    g.lineTo(-7 * px, 8 * px);
    g.closePath();
    g.fill();
    g.stroke();
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
    if (this.miniTimer <= 0) {
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
    const k = sc * dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.drawImage(this.staticCanvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const [b0, b1] = this.data.bounds;
    this.drawMarkers(g, state, (x, z) => [(x - b0) * S * k, (z - b1) * S * k], true, dpr);
  }

  private drawMini(state: MapState): void {
    const c = this.mini;
    const g = c.getContext('2d')!;
    const px = c.width / 200; // drawn at 2x for crisp icons and text
    const R = c.width / 2;
    const metres = 42; // radius shown
    const sc = R / (metres * S);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 2 * px, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(14,15,17,0.78)';
    g.fillRect(0, 0, c.width, c.height);
    const [pcx, pcz] = this.toCanvas(state.player.x, state.player.z);
    const yaw = state.player.yaw;
    g.translate(R, R);
    g.rotate(yaw);
    g.scale(sc, sc);
    g.translate(-pcx, -pcz);
    g.globalAlpha = 0.95;
    g.drawImage(this.staticCanvas, 0, 0);
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const proj = (x: number, z: number): [number, number] => {
      const [qx, qz] = this.toCanvas(x, z);
      const dx = (qx - pcx) * sc;
      const dz = (qz - pcz) * sc;
      return [R + dx * cos - dz * sin, R + dx * sin + dz * cos];
    };
    this.drawMarkers(g, state, proj, false, px, R, R, R);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 2 * px;
    g.beginPath();
    g.arc(R, R, R - 2 * px, 0, Math.PI * 2);
    g.stroke();
    // North marker.
    const ang = yaw - Math.PI / 2;
    g.fillStyle = '#e0a51c';
    g.font = `800 ${13 * px}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', R + Math.cos(ang) * (R - 12 * px), R + Math.sin(ang) * (R - 12 * px));
  }

  /** For callers that only know a THREE vector. */
  static pos(v: THREE.Vector3): { x: number; z: number } {
    return { x: v.x, z: v.z };
  }
}
