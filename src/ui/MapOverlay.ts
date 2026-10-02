import type * as THREE from 'three';
import type { RoomDef, WallRun, DoorSlot } from '../world/LayoutBuilder';
import type { WallBuy, Terminal } from '../world/Site9';

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
}

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
  private staticKey = '';
  private full: HTMLDivElement;
  private fullCanvas: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private miniTimer = 0;
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
      '<span><i class="lg buy"></i>Weapon</span><span><i class="lg term"></i>Hire terminal</span><span><i class="lg bot"></i>Robots</span><span class="lg-key">M close</span>';
    this.full.appendChild(legend);
    parent.appendChild(this.full);
    this.mini = document.createElement('canvas');
    this.mini.className = 'minimap';
    this.mini.width = this.mini.height = 200;
    parent.appendChild(this.mini);
    document.body.classList.add('has-minimap');
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.full.classList.toggle('show', this.visible);
    return this.visible;
  }

  private toCanvas(x: number, z: number): [number, number] {
    return [(x - this.data.bounds[0]) * S, (z - this.data.bounds[1]) * S];
  }

  /** Rooms + walls; redrawn only when the set of unlocked zones changes. */
  private drawStatic(state: MapState): void {
    const key = [...state.unlocked].sort().join(',');
    if (key === this.staticKey) return;
    this.staticKey = key;
    const g = this.staticCanvas.getContext('2d')!;
    g.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    for (const r of this.data.rooms) {
      const [a, b] = this.toCanvas(r.rect[0], r.rect[1]);
      const w = (r.rect[2] - r.rect[0]) * S;
      const h = (r.rect[3] - r.rect[1]) * S;
      g.fillStyle = ROOM_COLORS[r.style] ?? '#999';
      g.fillRect(a, b, w, h);
      if (!state.unlocked.has(r.zone)) {
        g.fillStyle = 'rgba(12,13,15,0.62)';
        g.fillRect(a, b, w, h);
      }
    }
    g.strokeStyle = '#141518';
    g.lineWidth = 3;
    g.lineCap = 'square';
    g.beginPath();
    for (const w of this.data.walls) {
      const [ax, az] = this.toCanvas(w.x0, w.z0);
      const [bx, bz] = this.toCanvas(w.x1, w.z1);
      g.moveTo(ax, az);
      g.lineTo(bx, bz);
    }
    g.stroke();
    g.font = '600 22px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const r of this.data.rooms) {
      const [cx, cz] = this.toCanvas((r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2);
      g.fillStyle = state.unlocked.has(r.zone) ? 'rgba(20,20,22,0.75)' : 'rgba(230,230,230,0.45)';
      g.fillText(r.name.toUpperCase(), cx, cz);
    }
  }

  /** Dynamic markers in static-canvas space. */
  private drawMarkers(g: CanvasRenderingContext2D, state: MapState, scale: number, labels: boolean): void {
    for (const d of this.data.doors) {
      const open = state.isOpen(d);
      const [cx, cz] = this.toCanvas(d.center.x, d.center.z);
      const half = (d.width / 2) * S;
      g.strokeStyle = open ? '#4fd36a' : '#e0a51c';
      g.lineWidth = (open ? 3 : 7) / scale;
      g.beginPath();
      if (d.alongX) {
        g.moveTo(cx - half, cz);
        g.lineTo(cx + half, cz);
      } else {
        g.moveTo(cx, cz - half);
        g.lineTo(cx, cz + half);
      }
      g.stroke();
      if (labels && !open) {
        g.font = `700 ${18 / scale}px system-ui, sans-serif`;
        g.fillStyle = '#ffd25a';
        g.strokeStyle = '#000';
        g.lineWidth = 4 / scale;
        g.strokeText(`$${d.link.cost}`, cx, cz - 14 / scale);
        g.fillText(`$${d.link.cost}`, cx, cz - 14 / scale);
      }
    }
    for (const w of this.data.wallBuys) {
      const [x, z] = this.toCanvas(w.pos.x, w.pos.z);
      g.fillStyle = '#ffd25a';
      g.beginPath();
      g.arc(x, z, 7 / scale, 0, Math.PI * 2);
      g.fill();
      if (labels) {
        g.font = `600 ${14 / scale}px system-ui, sans-serif`;
        g.fillStyle = '#fff';
        g.strokeStyle = '#000';
        g.lineWidth = 3 / scale;
        const t = `${w.weapon.replace('_', ' ').toUpperCase()} $${w.cost}`;
        g.strokeText(t, x, z + 18 / scale);
        g.fillText(t, x, z + 18 / scale);
      }
    }
    for (const t of this.data.terminals) {
      const [x, z] = this.toCanvas(t.pos.x, t.pos.z);
      g.fillStyle = '#4fb8ff';
      g.fillRect(x - 7 / scale, z - 7 / scale, 14 / scale, 14 / scale);
    }
    const dot = (p: { x: number; z: number }, color: string, r: number) => {
      const [x, z] = this.toCanvas(p.x, p.z);
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, z, r / scale, 0, Math.PI * 2);
      g.fill();
    };
    for (const r of state.robots) dot(r, '#ff3b2f', 5);
    for (const e of state.enemies) dot(e, '#ff8a1f', 6);
    for (const a of state.allies) dot(a, '#4fe0ff', 7);
    // Player arrow.
    const [px, pz] = this.toCanvas(state.player.x, state.player.z);
    g.save();
    g.translate(px, pz);
    g.rotate(-state.player.yaw);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 2 / scale;
    g.beginPath();
    g.moveTo(0, -16 / scale);
    g.lineTo(10 / scale, 12 / scale);
    g.lineTo(0, 6 / scale);
    g.lineTo(-10 / scale, 12 / scale);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  update(dt: number, state: MapState): void {
    this.drawStatic(state);
    if (this.visible) this.drawFull(state);
    this.miniTimer -= dt;
    if (this.miniTimer <= 0) {
      this.miniTimer = 1 / 20;
      this.drawMini(state);
    }
  }

  private drawFull(state: MapState): void {
    const c = this.fullCanvas;
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.82;
    const sc = Math.min(maxW / this.staticCanvas.width, maxH / this.staticCanvas.height);
    const w = Math.round(this.staticCanvas.width * sc);
    const h = Math.round(this.staticCanvas.height * sc);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(sc, 0, 0, sc, 0, 0);
    g.drawImage(this.staticCanvas, 0, 0);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.drawMarkers(g, state, sc, true);
  }

  private drawMini(state: MapState): void {
    const c = this.mini;
    const g = c.getContext('2d')!;
    const R = c.width / 2;
    const metres = 55; // radius shown
    const sc = R / (metres * S);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(14,15,17,0.72)';
    g.fillRect(0, 0, c.width, c.height);
    const [px, pz] = this.toCanvas(state.player.x, state.player.z);
    g.translate(R, R);
    g.rotate(state.player.yaw);
    g.scale(sc, sc);
    g.translate(-px, -pz);
    g.globalAlpha = 0.92;
    g.drawImage(this.staticCanvas, 0, 0);
    g.globalAlpha = 1;
    this.drawMarkers(g, state, sc, false);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(R, R, R - 2, 0, Math.PI * 2);
    g.stroke();
    // North marker.
    const ang = state.player.yaw - Math.PI / 2;
    g.fillStyle = '#e0a51c';
    g.font = '700 13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', R + Math.cos(ang) * (R - 12), R + Math.sin(ang) * (R - 12));
  }

  /** For callers that only know a THREE vector. */
  static pos(v: THREE.Vector3): { x: number; z: number } {
    return { x: v.x, z: v.z };
  }
}
