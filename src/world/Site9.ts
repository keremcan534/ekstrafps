import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { PhysicsProps } from './PhysicsProps';
import { corrugatedTexture, glowTexture, grimeRoughness, gridTexture, woodTexture } from '../fx/Textures';
import type { RobotOptions } from '../targets/RobotTarget';
import type { GameMap, SquadSpawn, Station } from './GameMap';
import { LayoutBuilder, type BuiltRoom, type DoorSlot, type LinkDef, type RoomDef, type RoomStyle } from './LayoutBuilder';
import type { MeshBuilder } from './MeshBuilder';

type V3 = [number, number, number];

const METAL: HitReceiver = { surface: 'metal', allowDecals: true };

/** A weapon for sale on a wall (Survival). */
export interface WallBuy {
  weapon: string;
  cost: number;
  /** Centre of the board on the wall. */
  pos: THREE.Vector3;
  /** Yaw the board faces (into the room). */
  yaw: number;
  room: string;
}

/** Ammo cache spot (Survival activates a random subset each game). */
export interface AmmoSpot {
  pos: THREE.Vector3;
  yaw: number;
  zone: string;
}

/** Candidate area for a random hazard (electrified floor, gas leak, fire). */
export interface HazardSpot {
  rect: [number, number, number, number];
  zone: string;
}

/** Prices of the wall weapons; positions get a random weapon each game (lobby excepted). */
export const WEAPON_PRICES: Record<string, number> = {
  heavy_pistol: 300, kar98: 600, pump_shotgun: 900, mosin: 1000, ppsh: 1200, ak47: 1400, asval: 1600, m4a1: 1800, mk47: 2000, rd704: 2250,
};
const RANDOM_WEAPONS = ['pump_shotgun', 'mosin', 'ppsh', 'ak47', 'asval', 'm4a1', 'mk47', 'rd704', 'pump_shotgun', 'ppsh', 'ak47'];

export interface Terminal {
  kind: 'ally';
  cost: number;
  pos: THREE.Vector3;
  yaw: number;
  room: string;
}

/** Enemy emergence point: service lift, charging bay or floor hatch. */
export interface SpawnPoint {
  pos: THREE.Vector3;
  zone: string;
  kind: 'lift' | 'bay' | 'hatch';
  /** Lift light (flashes when a robot arrives). */
  light?: THREE.MeshStandardMaterial;
  /** Lift door leaves (slide open along `slide`). */
  doors?: THREE.Mesh[];
  slide?: THREE.Vector3;
  /** 0 closed .. 1 open; driven by Survival. */
  open?: number;
  openTimer?: number;
}

const ROOMS: RoomDef[] = [
  { id: 'lobby', name: 'Arrival Lobby', rect: [-18, 52, 18, 84], h: 7, style: 'lobby', zone: 'start' },
  { id: 'cafeteria', name: 'Cafeteria', rect: [-66, 52, -18, 84], h: 6, style: 'cafe', zone: 'lounge' },
  { id: 'security', name: 'Security', rect: [18, 52, 66, 84], h: 5, style: 'security', zone: 'security' },
  { id: 'garden', name: 'Garden Court', rect: [-66, 14, -40, 52], h: 14, style: 'garden', zone: 'garden', sky: true },
  { id: 'medbay', name: 'Medical Bay', rect: [40, 14, 66, 52], h: 5, style: 'medical', zone: 'medical' },
  { id: 'atrium', name: 'Atrium', rect: [-40, -6, 40, 52], h: 18, style: 'atrium', zone: 'atrium', skylight: true },
  { id: 'assembly', name: 'Assembly Hall', rect: [-110, -66, -40, 14], h: 14, style: 'factory', zone: 'assembly' },
  { id: 'warehouse', name: 'Warehouse', rect: [-110, -86, -40, -66], h: 10, style: 'factory', zone: 'assembly' },
  { id: 'hangar', name: 'Hangar', rect: [-110, 14, -66, 86], h: 16, style: 'hangar', zone: 'hangar' },
  { id: 'labs', name: 'R&D Labs', rect: [-40, -36, 40, -6], h: 6, style: 'labs', zone: 'labs' },
  { id: 'cleanroom', name: 'Clean Room', rect: [-40, -66, 0, -36], h: 5, style: 'labs', zone: 'deeplabs' },
  { id: 'prototypes', name: 'Prototype Lab', rect: [0, -66, 40, -36], h: 8, style: 'labs', zone: 'deeplabs' },
  { id: 'servers', name: 'Server Hall', rect: [40, -66, 110, 14], h: 7, style: 'servers', zone: 'servers' },
  { id: 'cooling', name: 'Cooling Plant', rect: [40, -86, 110, -66], h: 9, style: 'factory', zone: 'servers' },
  { id: 'barracks', name: 'Barracks', rect: [66, 14, 110, 86], h: 6, style: 'barracks', zone: 'barracks' },
  { id: 'power', name: 'Power Plant', rect: [-40, -86, 40, -66], h: 12, style: 'factory', zone: 'power' },
];

const buy = (a: string, b: string, at: number, cost: number, width = 4): LinkDef => ({ a, b, at, width, kind: 'buy', cost });
const open = (a: string, b: string, at: number, width: number, height = 6): LinkDef => ({ a, b, at, width, kind: 'open', height });

const LINKS: LinkDef[] = [
  buy('lobby', 'cafeteria', 68, 750),
  buy('lobby', 'security', 68, 750),
  buy('lobby', 'atrium', 0, 1500, 8),
  buy('cafeteria', 'garden', -53, 1000),
  buy('security', 'medbay', 53, 1000),
  buy('garden', 'atrium', 33, 1000, 6),
  buy('medbay', 'atrium', 33, 1000, 6),
  buy('cafeteria', 'hangar', 68, 1500),
  buy('garden', 'hangar', 33, 1500),
  buy('garden', 'assembly', -53, 1250, 6),
  buy('atrium', 'assembly', 4, 1250, 6),
  buy('hangar', 'assembly', -88, 1000, 8),
  open('assembly', 'warehouse', -75, 14),
  buy('atrium', 'labs', 0, 1250, 8),
  buy('labs', 'cleanroom', -20, 1000),
  buy('labs', 'prototypes', 20, 1000),
  open('cleanroom', 'prototypes', -51, 4, 3.5),
  buy('labs', 'assembly', -21, 1000),
  buy('labs', 'servers', -21, 1000),
  buy('atrium', 'servers', 4, 1250, 6),
  buy('medbay', 'servers', 53, 1250),
  open('servers', 'cooling', 75, 14),
  buy('security', 'barracks', 68, 2000),
  buy('medbay', 'barracks', 33, 2000),
  buy('servers', 'barracks', 88, 1500, 6),
  buy('cleanroom', 'power', -20, 1500),
  buy('prototypes', 'power', 20, 1500),
  buy('warehouse', 'power', -76, 1500),
  buy('cooling', 'power', -76, 1500),
];

/**
 * Site-9 (Survival map): Vanta Dynamics' research campus, one level,
 * ~220 × 170 m. Bright and airy on purpose: a glass-roofed atrium with a giant
 * robot statue, an open-air garden court, warm cafeteria, clean labs, a hangar
 * with a VTOL, a cathedral-sized assembly hall where rogue robots are built.
 *
 * Progression (Zombies-style): you start in the Arrival Lobby; every other zone
 * sits behind purchasable shutters. Two cheap side routes (cafeteria / security)
 * and one expensive direct one (atrium) lead inward.
 */
export class Site9 implements GameMap {
  readonly name = 'Site-9';
  readonly mode = 'survival' as const;
  readonly group = new THREE.Group();
  readonly props: PhysicsProps;
  readonly spawn = new THREE.Vector3(0, 0, 78);
  readonly spawnYaw = 0;
  readonly robotSpawns: RobotOptions[] = [];
  readonly squads: SquadSpawn[] = [];
  readonly navBounds: [number, number, number, number];
  readonly sun: THREE.DirectionalLight;
  readonly skyColor = 0xa9bccd;
  readonly exposure = 0.88;
  readonly stations: Station[] = [
    { name: 'Arrival Lobby (start)', pos: [0, 0, 78], yaw: 0 },
    { name: 'Atrium', pos: [0, 0, 40], yaw: 0 },
    { name: 'Garden Court', pos: [-53, 0, 45], yaw: 0 },
    { name: 'Assembly Hall', pos: [-60, 0, 0], yaw: Math.PI / 2 },
    { name: 'Hangar', pos: [-80, 0, 70], yaw: Math.PI / 2 },
    { name: 'Server Hall', pos: [45, 0, 0], yaw: -Math.PI / 2 },
    { name: 'Barracks', pos: [70, 0, 75], yaw: -Math.PI / 2 },
    { name: 'Power Plant', pos: [0, 0, -70], yaw: 0 },
  ];
  readonly layout: LayoutBuilder;
  readonly doors: DoorSlot[];
  readonly wallBuys: WallBuy[] = [];
  readonly terminals: Terminal[] = [];
  readonly spawnPoints: SpawnPoint[] = [];
  readonly ammoSpots: AmmoSpot[] = [];
  readonly hazardSpots: HazardSpot[] = [];
  readonly rooms = ROOMS;

  private mats: Record<string, THREE.Material>;
  private pools = new Map<number, THREE.Material>();
  private serverLeds: THREE.MeshStandardMaterial;
  private coreGlow: THREE.MeshStandardMaterial;
  private time = 0;
  private mobile: boolean;

  constructor(private physics: Physics, mobile: boolean) {
    this.mobile = mobile;
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const rough = grimeRoughness();
    const grid = (a: string, b: string, c: string, r = 0.8, metal = 0.05) => std({ map: gridTexture(a, b, c), roughnessMap: rough, roughness: Math.min(1, r + 0.12), metalness: metal });
    this.serverLeds = std({ color: 0x000000, emissive: 0x38ff8a, emissiveIntensity: 2 });
    this.coreGlow = std({ color: 0x000000, emissive: 0x4fd2ff, emissiveIntensity: 3 });
    const wood = woodTexture();
    this.mats = {
      white: std({ color: 0xe9ecef, roughness: 0.6 }),
      offwhite: std({ color: 0xd5d9dd, roughness: 0.7 }),
      grey: std({ color: 0x8d9298, roughness: 0.7 }),
      dark: std({ color: 0x2a2d31, roughness: 0.6, metalness: 0.3 }),
      steel: std({ color: 0x9aa1a9, metalness: 0.85, roughness: 0.35 }),
      gunmetal: std({ color: 0x41464d, metalness: 0.8, roughness: 0.4 }),
      yellow: std({ color: 0xe0a51c, roughness: 0.55 }),
      vanta: std({ color: 0xa3171a, roughness: 0.55 }),
      wood: std({ color: 0x9a6b42, map: wood, roughness: 0.6 }),
      woodDark: std({ color: 0x5e3f27, map: wood, roughness: 0.65 }),
      fabric: std({ color: 0x3e5568, roughness: 0.95 }),
      fabricWarm: std({ color: 0x8a4b35, roughness: 0.95 }),
      leaf: std({ color: 0x4f8a3c, roughness: 0.9 }),
      leafDark: std({ color: 0x3a6c2e, roughness: 0.9 }),
      bark: std({ color: 0x5b4330, roughness: 0.95 }),
      soil: std({ color: 0x3b2f25, roughness: 1 }),
      water: std({ color: 0x3a7fa0, roughness: 0.08, metalness: 0.3 }),
      mint: std({ color: 0x8fd1c0, roughness: 0.6 }),
      glass: std({ color: 0xbfe0ef, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2, depthWrite: false }),
      screen: std({ color: 0x000000, emissive: 0x3aa0ff, emissiveIntensity: 1.5 }),
      screenWarm: std({ color: 0x000000, emissive: 0xffb45a, emissiveIntensity: 1.4 }),
      lampCool: std({ color: 0x000000, emissive: 0xf2f6ff, emissiveIntensity: 2.6 }),
      lampWarm: std({ color: 0x000000, emissive: 0xffe1b5, emissiveIntensity: 2.4 }),
      lampRed: std({ color: 0x000000, emissive: 0xff2a1a, emissiveIntensity: 2.2 }),
      lampBlue: std({ color: 0x000000, emissive: 0x7fc2ff, emissiveIntensity: 2.2 }),
      leds: this.serverLeds,
      core: this.coreGlow,
      contGreen: std({ map: corrugatedTexture('#3d5a3a'), roughness: 0.7, metalness: 0.35 }),
      contBlue: std({ map: corrugatedTexture('#2b4766'), roughness: 0.7, metalness: 0.35 }),
      contRust: std({ map: corrugatedTexture('#7a3b22'), roughness: 0.75, metalness: 0.3 }),
      tire: std({ color: 0x141414, roughness: 0.9 }),
    };
    const m = this.mats;
    const styles: Record<string, RoomStyle> = {
      lobby: { floor: grid('#c9c2b6', '#ada597', '#bdb6aa', 0.35, 0.05), wall: grid('#d9dbdc', '#bfc3c6', '#cfd2d4', 0.7), ceiling: m.white, lamp: m.lampWarm, lampSpacing: 6, glow: 0xffe8c8 },
      cafe: { floor: std({ color: 0xa87a4f, map: wood, roughness: 0.55 }), wall: grid('#efe7da', '#ddd3c4', '#e7dece', 0.8), ceiling: m.offwhite, lamp: m.lampWarm, lampSpacing: 6, glow: 0xffd9a8 },
      security: { floor: grid('#9aa0a7', '#868c93', '#939920', 0.6), wall: grid('#d2d7dc', '#bcc2c8', '#c8cdd3', 0.75), ceiling: m.offwhite, lamp: m.lampCool, lampSpacing: 5, glow: 0xeef4ff },
      garden: { floor: grid('#5c8a45', '#557f40', '#598643', 1), wall: grid('#8a877f', '#77746d', '#83807a', 0.95), ceiling: m.offwhite, lamp: null, lampSpacing: 0, glow: 0 },
      medical: { floor: grid('#d3dcdb', '#b7c4c2', '#c9d3d1', 0.4), wall: grid('#e2e9e8', '#c7d3d1', '#d9e1e0', 0.7), ceiling: m.white, lamp: m.lampCool, lampSpacing: 5, glow: 0xeafff8 },
      atrium: { floor: grid('#bdb7ad', '#a39c91', '#b2aca2', 0.3, 0.05), wall: grid('#d2d4d6', '#b8bbbe', '#c8cacc', 0.7), ceiling: m.white, lamp: null, lampSpacing: 0, glow: 0 },
      factory: { floor: grid('#7c8086', '#6b6f75', '#767a80', 0.75, 0.1), wall: grid('#a2a6ac', '#8d9197', '#9a9ea4', 0.85), ceiling: m.grey, lamp: m.lampWarm, lampSpacing: 10, glow: 0xffe2b8 },
      hangar: { floor: grid('#8a8d90', '#787b7e', '#838689', 0.75, 0.1), wall: grid('#b5b9bd', '#a0a4a8', '#acb0b4', 0.85), ceiling: m.grey, lamp: m.lampCool, lampSpacing: 11, glow: 0xeef4ff },
      labs: { floor: grid('#dfe3e6', '#c4cace', '#d5d9dc', 0.35), wall: grid('#e6e9eb', '#cdd2d6', '#dde0e3', 0.7), ceiling: m.white, lamp: m.lampCool, lampSpacing: 5, glow: 0xf0f6ff },
      servers: { floor: grid('#3a3f46', '#30353b', '#363b41', 0.5, 0.2), wall: grid('#4a5059', '#3e434b', '#464c54', 0.7), ceiling: m.dark, lamp: m.lampBlue, lampSpacing: 7, glow: 0x9fd0ff },
      barracks: { floor: grid('#5d625c', '#50554f', '#585d57', 0.7), wall: grid('#7a7f78', '#6a6f68', '#747972', 0.8), ceiling: m.grey, lamp: m.lampWarm, lampSpacing: 6, glow: 0xffd8a8 },
    };

    this.layout = new LayoutBuilder(physics, ROOMS, LINKS, styles, {
      ao: new THREE.MeshBasicMaterial({ map: aoTexture(), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.55 }),
      pool: (c) => this.pool(c),
      skyFrame: m.steel,
      skyGlass: std({ color: 0xdff0ff, transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false }),
      trim: m.gunmetal,
    }, METAL);
    this.navBounds = [...this.layout.bounds] as [number, number, number, number];
    this.doors = this.layout.doors;

    this.buildLobby();
    this.buildCafeteria();
    this.buildSecurity();
    this.buildGarden();
    this.buildMedbay();
    this.buildAtrium();
    this.buildAssembly();
    this.buildHangar();
    this.buildLabs();
    this.buildServers();
    this.buildBarracks();
    this.buildPower();
    this.buildRandomSlots();
    this.buildSigns();
    this.layout.build(this.group);

    this.props = new PhysicsProps(physics);
    this.group.add(this.props.group);
    this.placeProps();

    // --- Lighting: bright daylight through the skylights + soft fill everywhere.
    // Ceilings don't cast shadows, so the key light reads as "light from above";
    // its shadow camera follows the player (crisp shadows nearby, cheap).
    this.group.add(new THREE.HemisphereLight(0xe6edf5, 0x5a534b, 1.2));
    const sun = new THREE.DirectionalLight(0xfff1e0, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const cam = sun.shadow.camera;
    const r = mobile ? 26 : 38;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 90;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    this.group.add(sun, sun.target);
    this.sun = sun;
    if (!mobile) {
      const point = (color: number, intensity: number, dist: number, pos: V3) => {
        const l = new THREE.PointLight(color, intensity, dist, 2);
        l.position.set(...pos);
        this.group.add(l);
      };
      point(0x5fd0ff, 60, 26, [88, 4, -26]); // data core
      point(0xffb060, 70, 30, [0, 8, -76]); // reactor
      point(0xff4030, 30, 18, [100, 4, 50]); // barracks
    }
  }

  private pool(color: number): THREE.Material {
    let m = this.pools.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: glowTexture(), color, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.pools.set(color, m);
    }
    return m;
  }

  private room(id: string): BuiltRoom {
    return this.layout.rooms.get(id)!;
  }

  // ---------------------------------------------------------------- prop kit

  /** Visual box in a room + optional collider. */
  private box(room: string, mat: string, size: V3, pos: V3, solid = true, rot?: V3, receiver?: HitReceiver): void {
    this.room(room).b.box(this.mats[mat], size, pos, rot);
    if (solid) {
      const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)) : undefined;
      this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), q, receiver);
    }
  }

  /** Cylinder (Y axis unless rotated) + an approximate box collider. */
  private cyl(room: string, mat: string, r: number, h: number, pos: V3, solid = true, rot: V3 = [0, 0, 0], segments = 16): void {
    this.room(room).b.cylinder(this.mats[mat], r, h, pos, rot, segments);
    if (solid) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
      this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(r * 0.85, h / 2, r * 0.85), q);
    }
  }

  private clear(room: string): MeshBuilder {
    return this.room(room).clear;
  }

  private glass(room: string, size: V3, pos: V3): void {
    this.clear(room).box(this.mats.glass, size, pos);
    this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), undefined, METAL);
    const vertical = size[0] < size[2];
    const len = vertical ? size[2] : size[0];
    for (const s of [-1, 1]) {
      const o = (len / 2) * s;
      this.box(room, 'gunmetal', [0.07, size[1], 0.07], vertical ? [pos[0], pos[1], pos[2] + o] : [pos[0] + o, pos[1], pos[2]], false);
    }
    this.box(room, 'gunmetal', vertical ? [0.07, 0.07, len] : [len, 0.07, 0.07], [pos[0], pos[1] + size[1] / 2, pos[2]], false);
  }

  private tree(room: string, x: number, z: number, scale = 1, potted = false): void {
    if (potted) {
      this.cyl(room, 'gunmetal', 0.7 * scale, 0.8, [x, 0.4, z]);
      this.cyl(room, 'soil', 0.62 * scale, 0.05, [x, 0.8, z], false);
    }
    const y0 = potted ? 0.8 : 0;
    this.cyl(room, 'bark', 0.14 * scale, 2.6 * scale, [x, y0 + 1.3 * scale, z], !potted, [0, 0, 0], 8);
    const crown = (dx: number, dy: number, dz: number, r: number, mat: string) =>
      this.room(room).b.add(this.mats[mat], new THREE.IcosahedronGeometry(r * scale, 1), [x + dx * scale, y0 + dy * scale, z + dz * scale]);
    crown(0, 3.1, 0, 1.3, 'leaf');
    crown(0.7, 2.6, 0.3, 0.9, 'leafDark');
    crown(-0.6, 2.7, -0.4, 0.95, 'leaf');
    crown(0.1, 3.8, -0.2, 0.8, 'leafDark');
  }

  private tableSet(room: string, x: number, z: number, top = 'white'): void {
    this.box(room, top, [2.4, 0.08, 1.0], [x, 0.76, z]);
    this.box(room, 'gunmetal', [0.12, 0.72, 0.12], [x, 0.36, z], false);
    for (const s of [-1, 1]) this.box(room, 'gunmetal', [2.2, 0.48, 0.4], [x, 0.24, z + s * 0.85]);
  }

  private sofa(room: string, x: number, z: number, yaw: number, mat = 'fabric'): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.box(room, mat, [2.2, 0.45, 0.9], [x, 0.22, z], true, [0, yaw, 0]);
    this.box(room, mat, [2.2, 0.55, 0.25], [x - s * 0.4, 0.6, z - c * 0.4], false, [0, yaw, 0]);
  }

  /** Cabinet / rack row along X at `z`. */
  private row(room: string, mat: string, x0: number, x1: number, z: number, h: number, d: number): void {
    this.box(room, mat, [x1 - x0, h, d], [(x0 + x1) / 2, h / 2, z], true, undefined, METAL);
  }

  /** Wall weapon slot. Outside the lobby the weapon is rolled at random each game. */
  private wallBuy(room: string, weapon: string, cost: number, pos: V3, yaw: number): void {
    if (room !== 'lobby') {
      weapon = RANDOM_WEAPONS[(Math.random() * RANDOM_WEAPONS.length) | 0];
      cost = WEAPON_PRICES[weapon];
    }
    this.wallBuys.push({ weapon, cost, pos: new THREE.Vector3(...pos), yaw, room });
  }

  private ammo(room: string, x: number, z: number, yaw: number): void {
    this.ammoSpots.push({ pos: new THREE.Vector3(x, 0, z), yaw, zone: ROOMS.find((r) => r.id === room)!.zone });
  }

  private hazard(room: string, x0: number, z0: number, x1: number, z1: number): void {
    this.hazardSpots.push({ rect: [x0, z0, x1, z1], zone: ROOMS.find((r) => r.id === room)!.zone });
  }

  private terminal(room: string, x: number, z: number, yaw: number): void {
    const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.terminals.push({ kind: 'ally', cost: 1500, pos: new THREE.Vector3(x + n.x * 0.3, 1.3, z + n.z * 0.3), yaw, room });
    const along = Math.abs(n.z) > 0.5;
    this.box(room, 'gunmetal', along ? [2.2, 2.6, 0.4] : [0.4, 2.6, 2.2], [x, 1.3, z], false);
    this.box(room, 'screen', along ? [1.6, 1.0, 0.05] : [0.05, 1.0, 1.6], [x + n.x * 0.23, 1.7, z + n.z * 0.23], false);
    this.box(room, 'vanta', along ? [2.2, 0.15, 0.42] : [0.42, 0.15, 2.2], [x, 2.65, z], false);
  }

  /** Extra random content candidates around the campus. */
  private buildRandomSlots(): void {
    // More wall-weapon slots (weapon rolled each game).
    this.wallBuy('hangar', '', 0, [-109.82, 1.6, 22], Math.PI / 2);
    this.wallBuy('barracks', '', 0, [109.82, 1.6, 66], -Math.PI / 2);
    this.wallBuy('cooling', '', 0, [60, 1.6, -85.82], 0);
    this.wallBuy('power', '', 0, [-30, 1.6, -85.82], 0);
    this.wallBuy('warehouse', '', 0, [-109.82, 1.6, -76], Math.PI / 2);
    this.wallBuy('cleanroom', '', 0, [-39.82, 1.6, -60], Math.PI / 2);
    this.wallBuy('prototypes', '', 0, [39.82, 1.6, -42], -Math.PI / 2);
    // More contractor terminals (other teams will use these too).
    this.terminal('hangar', -66.2, 76, -Math.PI / 2);
    this.terminal('atrium', -39.8, 44, Math.PI / 2);
    this.terminal('servers', 109.8, -20, -Math.PI / 2);
    this.terminal('barracks', 66.2, 80, Math.PI / 2);
    // Ammo cache spots.
    const ammo: [string, number, number, number][] = [
      ['lobby', -16.5, 74, Math.PI / 2], ['cafeteria', -40, 53.3, 0], ['security', 64.6, 76, -Math.PI / 2], ['garden', -41.3, 40, -Math.PI / 2],
      ['medbay', 46, 15.3, 0], ['atrium', 38.6, 10, -Math.PI / 2], ['atrium', -38.6, 24, Math.PI / 2], ['assembly', -70, 12.6, Math.PI],
      ['assembly', -108.6, -40, Math.PI / 2], ['warehouse', -60, -84.6, 0], ['hangar', -70, 60, -Math.PI / 2], ['labs', 12, -7.4, Math.PI],
      ['cleanroom', -32, -64.6, 0], ['prototypes', 38.6, -60, -Math.PI / 2], ['servers', 72, -2, 0], ['cooling', 84, -67.4, Math.PI],
      ['barracks', 96, 16, 0], ['power', 36, -72, -Math.PI / 2],
    ];
    for (const [r, x, z, y] of ammo) this.ammo(r, x, z, y);
    // Hazard candidate areas.
    this.hazard('assembly', -80, -20, -72, -12);
    this.hazard('assembly', -100, -60, -92, -52);
    this.hazard('warehouse', -88, -80, -82, -72);
    this.hazard('hangar', -100, 70, -92, 78);
    this.hazard('labs', -6, -32, 6, -26);
    this.hazard('cleanroom', -30, -52, -22, -46);
    this.hazard('prototypes', 26, -56, 34, -48);
    this.hazard('servers', 70, -44, 78, -36);
    this.hazard('cooling', 60, -82, 68, -74);
    this.hazard('power', -14, -84, -6, -80);
    this.hazard('garden', -60, 26, -55, 30);
    this.hazard('medbay', 50, 36, 56, 42);
    this.hazard('barracks', 84, 40, 92, 48);
    this.hazard('atrium', -30, 0, -24, 6);
  }

  private spawnAt(zone: string, pts: [number, number][], kind: SpawnPoint['kind'] = 'bay'): void {
    for (const [x, z] of pts) this.spawnPoints.push({ pos: new THREE.Vector3(x, 0, z), zone, kind });
  }

  /**
   * Service lift set into a wall (yaw = direction it faces). Robots arrive in it:
   * a chime, the call light flashes, one steps out.
   */
  private serviceLift(room: string, x: number, z: number, yaw: number): void {
    const zone = ROOMS.find((r) => r.id === room)!.zone;
    const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const t = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const at = (o: number, y: number, d: number): V3 => [x + n.x * d + t.x * o, y, z + n.z * d + t.z * o];
    const sizeT = (a: number, h: number, b: number): V3 => (Math.abs(n.z) > 0.5 ? [a, h, b] : [b, h, a]);
    this.box(room, 'gunmetal', sizeT(3.2, 3.2, 0.1), at(0, 1.6, 0.05), false);
    this.box(room, 'dark', sizeT(2.5, 2.7, 0.04), at(0, 1.35, 0.07), false); // dark cab behind the doors
    this.box(room, 'yellow', sizeT(3.2, 0.12, 0.08), at(0, 3.25, 0.12), false);
    const light = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffa040, emissiveIntensity: 0.4 });
    this.room(room).b.box(light, sizeT(0.5, 0.18, 0.05), at(0, 2.95, 0.15));
    // Door leaves are separate meshes so they can slide open.
    const leafGeo = new THREE.BoxGeometry(...sizeT(1.25, 2.7, 0.06));
    const doors = [-0.64, 0.64].map((o) => {
      const m = new THREE.Mesh(leafGeo, this.mats.steel);
      m.position.set(...at(o, 1.35, 0.11));
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.home = m.position.clone();
      m.userData.side = Math.sign(o);
      this.room(room).group.add(m);
      return m;
    });
    const p = at(0, 0, 1.0);
    this.spawnPoints.push({ pos: new THREE.Vector3(p[0], 0, p[2]), zone, kind: 'lift', light, doors, slide: t.clone(), open: 0, openTimer: 0 });
  }

  // ---------------------------------------------------------------- rooms

  private buildLobby(): void {
    const R = 'lobby';
    // Lift bank on the south wall: the way you came in (and the way they come).
    for (const x of [-7, 0, 7]) {
      this.serviceLift(R, x, 83.85, Math.PI);
      this.box(R, 'gunmetal', [0.25, 0.4, 0.08], [x + 2, 1.3, 83.8], false);
    }
    // Reception desk.
    this.box(R, 'woodDark', [8, 1.1, 1.4], [0, 0.55, 70]);
    this.box(R, 'white', [8.2, 0.08, 1.6], [0, 1.14, 70], false);
    this.box(R, 'woodDark', [1.4, 1.1, 3], [-4.7, 0.55, 71.5]);
    this.box(R, 'woodDark', [1.4, 1.1, 3], [4.7, 0.55, 71.5]);
    this.box(R, 'screen', [1.0, 0.6, 0.05], [-1.5, 1.5, 70.2], false);
    this.box(R, 'screen', [1.0, 0.6, 0.05], [1.5, 1.5, 70.2], false);
    for (const x of [-12, 12]) {
      this.tree(R, x, 76, 0.9, true);
      this.sofa(R, x, 63, 0);
      this.sofa(R, x, 59, Math.PI);
      this.box(R, 'woodDark', [1.6, 0.4, 0.8], [x, 0.2, 61]);
    }
    // Maintenance hatches: robots climb out of these too.
    for (const [x, z] of [[-15, 55], [15, 55], [-15, 81], [15, 81]]) {
      this.box(R, 'gunmetal', [1.6, 0.04, 1.6], [x, 0.03, z], false);
      this.box(R, 'yellow', [1.7, 0.03, 0.12], [x, 0.04, z - 0.85], false);
      this.box(R, 'yellow', [1.7, 0.03, 0.12], [x, 0.04, z + 0.85], false);
    }
    this.spawnAt('start', [[-15, 55], [15, 55], [-15, 81], [15, 81]], 'hatch');
    this.wallBuy(R, 'kar98', 600, [-17.82, 1.6, 59], Math.PI / 2);
    this.wallBuy(R, 'heavy_pistol', 300, [17.82, 1.6, 59], -Math.PI / 2);
  }

  private buildCafeteria(): void {
    const R = 'cafeteria';
    for (let x = -60; x <= -28; x += 6) for (const z of [60, 66, 72]) this.tableSet(R, x, z);
    // Serving counter + kitchen along the south wall.
    this.box(R, 'steel', [22, 1.0, 1.2], [-44, 0.5, 80.5], true, undefined, METAL);
    this.box(R, 'white', [22, 0.06, 1.3], [-44, 1.03, 80.5], false);
    this.box(R, 'gunmetal', [22, 2.4, 0.6], [-44, 2.6, 83.6], false);
    for (let x = -54; x <= -34; x += 5) this.box(R, 'screenWarm', [3, 1.2, 0.05], [x, 3.6, 83.25], false);
    for (const z of [56, 58.4, 60.8]) {
      this.box(R, 'vanta', [1.0, 2.0, 1.1], [-65.3, 1.0, z], true, undefined, METAL);
      this.box(R, 'screen', [0.05, 1.2, 0.7], [-64.78, 1.2, z], false);
    }
    // Pendant lamps over the tables.
    for (let x = -60; x <= -28; x += 6) for (const z of [60, 66, 72]) {
      this.box(R, 'gunmetal', [0.03, 2.2, 0.03], [x, 4.9, z], false);
      this.cyl(R, 'lampWarm', 0.35, 0.2, [x, 3.7, z], false, [0, 0, 0], 12);
    }
    for (const x of [-62, -22]) this.tree(R, x, 76, 0.7, true);
    this.serviceLift(R, -64, 83.85, Math.PI);
    this.wallBuy(R, 'pump_shotgun', 900, [-30, 1.6, 52.18], 0);
    this.spawnAt('lounge', [[-64, 64], [-64, 76], [-22, 56]]);
  }

  private buildSecurity(): void {
    const R = 'security';
    for (const z of [58, 64, 70]) {
      this.box(R, 'gunmetal', [6, 1.0, 0.8], [30, 0.5, z], true, undefined, METAL);
      this.box(R, 'steel', [1.4, 2.2, 0.15], [34, 1.1, z - 0.6], false);
      this.box(R, 'steel', [1.4, 2.2, 0.15], [34, 1.1, z + 0.6], false);
      this.box(R, 'steel', [1.4, 0.15, 1.35], [34, 2.2, z], false);
    }
    for (const z of [58, 66, 74]) {
      this.glass(R, [0.08, 2.6, 6], [52, 1.3, z]);
      this.box(R, 'woodDark', [3, 0.8, 1.2], [58, 0.4, z]);
      this.box(R, 'screen', [1.4, 0.7, 0.05], [58, 1.25, z - 0.5], false);
    }
    // Holding cells (bars) in the south-east corner.
    for (let x = 54; x <= 64; x += 0.35) this.box(R, 'steel', [0.05, 3, 0.05], [x, 1.5, 79], false);
    this.physics.addStaticBox(new THREE.Vector3(59, 1.5, 79), new THREE.Vector3(5.2, 1.5, 0.08), undefined, METAL);
    // Contractor terminal: hire a Vanta Security operator.
    this.terminals.push({ kind: 'ally', cost: 1500, pos: new THREE.Vector3(24, 1.3, 83.5), yaw: Math.PI, room: R });
    this.box(R, 'gunmetal', [2.2, 2.6, 0.4], [24, 1.3, 83.75], false);
    this.box(R, 'screen', [1.6, 1.0, 0.05], [24, 1.7, 83.52], false);
    this.serviceLift(R, 65.85, 60, -Math.PI / 2);
    this.wallBuy(R, 'ppsh', 1200, [40, 1.6, 83.82], Math.PI);
    this.spawnAt('security', [[64, 56], [46, 82], [62, 70]]);
  }

  private buildGarden(): void {
    const R = 'garden';
    this.box(R, 'offwhite', [3, 0.03, 38], [-53, 0.02, 33], false);
    this.box(R, 'offwhite', [26, 0.03, 3], [-53, 0.02, 33], false);
    for (const [x, z] of [[-60, 20], [-46, 20], [-60, 46], [-46, 46], [-61, 33], [-45, 27]]) {
      this.box(R, 'gunmetal', [5, 0.5, 5], [x, 0.25, z]);
      this.box(R, 'soil', [4.6, 0.05, 4.6], [x, 0.52, z], false);
      this.tree(R, x, z, 1.3, false);
    }
    this.cyl(R, 'offwhite', 3.2, 0.6, [-53, 0.3, 33], true, [0, 0, 0], 24);
    this.cyl(R, 'water', 2.9, 0.05, [-53, 0.6, 33], false, [0, 0, 0], 24);
    for (const z of [24, 42]) {
      this.box(R, 'wood', [2.4, 0.45, 0.6], [-49.5, 0.3, z]);
      this.box(R, 'wood', [2.4, 0.45, 0.6], [-56.5, 0.3, z]);
    }
    // Lit windows of the surrounding buildings, up the court walls.
    for (let z = 18; z < 50; z += 6) {
      for (const y of [7, 10.5]) {
        this.box(R, 'lampWarm', [0.05, 1.6, 3], [-65.8, y, z], false);
        this.box(R, 'lampCool', [0.05, 1.6, 3], [-40.2, y, z], false);
      }
    }
    this.wallBuy(R, 'mosin', 1000, [-65.82, 1.6, 24], Math.PI / 2);
    this.serviceLift(R, -45, 14.15, 0);
    this.spawnAt('garden', [[-64, 16], [-42, 50], [-64, 50]]);
  }

  private buildMedbay(): void {
    const R = 'medbay';
    for (const z of [18, 24, 30, 36, 42, 48]) {
      this.box(R, 'white', [2.1, 0.6, 1.0], [62.5, 0.5, z]);
      this.box(R, 'mint', [2.0, 0.12, 0.9], [62.5, 0.86, z], false);
      this.box(R, 'steel', [0.04, 2.4, 2.6], [61, 1.2, z + 1.6], false);
      this.box(R, 'mint', [0.03, 1.8, 2.6], [61, 1.5, z + 1.6], false);
    }
    this.box(R, 'steel', [2.2, 0.9, 0.8], [48, 0.45, 30], true, undefined, METAL);
    this.cyl(R, 'lampCool', 0.6, 0.15, [48, 3.2, 30], false, [0, 0, 0], 18);
    this.box(R, 'steel', [0.06, 1.6, 0.06], [48, 4.1, 30], false);
    for (let z = 16; z < 50; z += 2.2) {
      if (Math.abs(z - 33) < 4) continue; // keep the atrium door clear
      this.box(R, 'white', [0.6, 2.0, 2.0], [40.6, 1.0, z]);
    }
    this.serviceLift(R, 45, 51.85, Math.PI);
    this.wallBuy(R, 'asval', 1600, [65.82, 1.6, 20], -Math.PI / 2);
    this.spawnAt('medical', [[42, 16], [64, 50], [50, 50]]);
  }

  private buildAtrium(): void {
    const R = 'atrium';
    // Central island: the ATLAS statue on a planted plinth.
    this.cyl(R, 'offwhite', 6, 1.0, [0, 0.5, 22], true, [0, 0, 0], 32);
    this.cyl(R, 'soil', 5.6, 0.05, [0, 1.02, 22], false, [0, 0, 0], 32);
    this.atlas(R, 0, 1.0, 22);
    for (const [x, z] of [[-20, 8], [20, 8], [-20, 38], [20, 38]]) {
      this.box(R, 'offwhite', [6, 0.8, 6], [x, 0.4, z]);
      this.box(R, 'soil', [5.6, 0.05, 5.6], [x, 0.82, z], false);
      this.tree(R, x, z, 1.6, false);
    }
    // Upper-floor balconies (decor) with glass railings and lit office windows.
    for (const y of [6.5, 12]) {
      for (const side of [-1, 1]) {
        const x = side * 38.5;
        this.box(R, 'offwhite', [3, 0.35, 46], [x, y, 23], false);
        this.clear(R).box(this.mats.glass, [0.05, 1.1, 46], [x - side * 1.5, y + 0.7, 23]);
        for (let z = 4; z < 44; z += 6) this.box(R, y < 10 ? 'lampWarm' : 'lampCool', [0.05, 2.2, 4], [side * 39.82, y + 1.6, z], false);
      }
      this.box(R, 'offwhite', [74, 0.35, 3], [0, y, -4.5], false);
      this.clear(R).box(this.mats.glass, [74, 1.1, 0.05], [0, y + 0.7, -3]);
    }
    for (const x of [-26, -9, 9, 26]) this.box(R, 'vanta', [3, 7, 0.08], [x, 11, -5.7], false);
    for (const [x, z] of [[-10, 8], [10, 8], [-10, 38], [10, 38], [-30, 22], [30, 22]]) this.box(R, 'woodDark', [3, 0.45, 0.8], [x, 0.23, z]);
    for (const x of [-6, 6]) {
      this.box(R, 'white', [0.6, 2.2, 0.6], [x, 1.1, 46]);
      this.box(R, 'screen', [0.05, 1.0, 0.5], [x + (x < 0 ? 0.33 : -0.33), 1.5, 46], false);
    }
    for (const x of [-30, 30]) this.serviceLift(R, x, -5.85, 0);
    this.wallBuy(R, 'ak47', 1400, [26, 1.6, 51.82], Math.PI);
    this.spawnAt('atrium', [[-38, -4], [38, -4], [-38, 50], [38, 50], [0, -4]]);
  }

  /** ATLAS: Vanta's flagship robot, ~8 m tall, on the atrium island. */
  private atlas(R: string, x: number, y: number, z: number): void {
    const s = 4.2;
    const b = (mat: string, size: V3, pos: V3) => this.box(R, mat, [size[0] * s, size[1] * s, size[2] * s], [x + pos[0] * s, y + pos[1] * s, z + pos[2] * s], false);
    for (const side of [-1, 1]) {
      b('gunmetal', [0.18, 0.85, 0.2], [0.14 * side, 0.43, 0]);
      b('dark', [0.22, 0.08, 0.32], [0.14 * side, 0.04, 0.04]);
      b('white', [0.2, 0.18, 0.22], [0.14 * side, 0.5, 0.01]);
      b('gunmetal', [0.13, 0.7, 0.14], [0.42 * side, 1.08, 0.12]);
      b('white', [0.17, 0.16, 0.17], [0.4 * side, 1.47, 0.02]);
    }
    b('dark', [0.46, 0.18, 0.28], [0, 0.9, 0]);
    b('white', [0.62, 0.55, 0.38], [0, 1.25, 0]);
    b('vanta', [0.38, 0.28, 0.04], [0, 1.27, 0.19]);
    b('white', [0.7, 0.1, 0.32], [0, 1.53, 0]);
    b('dark', [0.36, 0.3, 0.33], [0, 1.78, 0]);
    b('lampBlue', [0.3, 0.07, 0.03], [0, 1.8, 0.17]);
    this.physics.addStaticBox(new THREE.Vector3(x, y + 4, z), new THREE.Vector3(1.6, 4, 1.0));
  }

  private buildAssembly(): void {
    const R = 'assembly';
    // Three conveyor lines (gapped so you can cross) with assembly gantries.
    for (const z of [-46, -26, -6]) {
      for (const [x0, x1] of [[-104, -88], [-84, -66], [-62, -46]]) {
        const w = x1 - x0;
        this.box(R, 'gunmetal', [w, 0.9, 2], [(x0 + x1) / 2, 0.45, z], true, undefined, METAL);
        this.box(R, 'steel', [w, 0.05, 1.8], [(x0 + x1) / 2, 0.93, z], false);
        for (let x = x0 + 0.5; x < x1; x += 1) this.box(R, 'offwhite', [0.08, 0.03, 1.8], [x, 0.96, z], false);
        this.box(R, 'yellow', [w, 0.12, 0.06], [(x0 + x1) / 2, 0.75, z + 1.03], false);
        this.box(R, 'yellow', [w, 0.12, 0.06], [(x0 + x1) / 2, 0.75, z - 1.03], false);
      }
      for (const x of [-96, -75, -54]) {
        for (const dx of [-2, 2]) for (const dz of [-1.6, 1.6]) this.box(R, 'yellow', [0.3, 5.5, 0.3], [x + dx, 2.75, z + dz], true, undefined, METAL);
        this.box(R, 'yellow', [4.6, 0.35, 0.35], [x, 5.6, z - 1.6], false);
        this.box(R, 'yellow', [4.6, 0.35, 0.35], [x, 5.6, z + 1.6], false);
        this.box(R, 'dark', [1.0, 1.0, 3.4], [x, 5.2, z], false);
        this.box(R, 'lampWarm', [0.8, 0.05, 3], [x, 4.68, z], false);
        this.box(R, 'white', [0.9, 1.1, 0.6], [x, 2.9, z], false);
        this.box(R, 'dark', [0.6, 0.5, 0.55], [x, 3.75, z], false);
      }
    }
    for (const z of [-64, 12]) this.box(R, 'yellow', [68, 0.8, 0.8], [-75, 11.5, z], false);
    this.box(R, 'dark', [1.2, 1.0, 76], [-80, 11.5, -26], false);
    // Robot charging bays: rogue robots step out of these.
    for (let x = -104; x <= -46; x += 8) {
      this.box(R, 'dark', [3, 4, 0.6], [x, 2, -65.6], false);
      this.box(R, 'screenWarm', [2.2, 3.2, 0.05], [x, 2, -65.28], false);
    }
    for (let z = -58; z <= 6; z += 8) {
      this.box(R, 'dark', [0.6, 4, 3], [-109.6, 2, z], false);
      this.box(R, 'screenWarm', [0.05, 3.2, 2.2], [-109.28, 2, z], false);
    }
    this.spawnAt('assembly', [[-104, -63], [-88, -63], [-72, -63], [-56, -63], [-107, -50], [-107, -26], [-107, -2], [-44, 10]]);
    const W = 'warehouse';
    for (const z of [-82, -76, -70]) {
      for (const [x0, x1] of [[-106, -90], [-86, -70], [-66, -48]]) {
        this.row(W, 'gunmetal', x0, x1, z, 0.15, 1.6);
        for (const y of [2.4, 4.8]) this.box(W, 'gunmetal', [x1 - x0, 0.12, 1.6], [(x0 + x1) / 2, y, z], false);
        for (let x = x0 + 1; x < x1; x += 2.2) {
          this.box(W, 'wood', [1.6, 1.4, 1.4], [x, 0.85, z]);
          this.box(W, 'contBlue', [1.6, 1.2, 1.4], [x, 3.05, z], false);
          this.box(W, 'contRust', [1.6, 1.2, 1.4], [x + 0.2, 5.45, z], false);
        }
        for (const x of [x0, x1]) this.box(W, 'yellow', [0.15, 6.5, 1.6], [x, 3.25, z]);
      }
    }
    this.wallBuy(R, 'rd704', 2250, [-100, 1.6, 13.82], Math.PI);
    this.spawnAt('assembly', [[-108, -84], [-42, -84]]);
  }

  private buildHangar(): void {
    const R = 'hangar';
    // VTOL transport on the pad.
    this.box(R, 'yellow', [18, 0.05, 18], [-88, 0.03, 50], false);
    this.cyl(R, 'offwhite', 2.2, 16, [-88, 3.2, 50], true, [Math.PI / 2, 0, 0], 20);
    this.box(R, 'offwhite', [22, 0.4, 3.2], [-88, 4.8, 49], false);
    this.box(R, 'offwhite', [0.4, 4, 3], [-88, 6.6, 57.5], false);
    for (const x of [-99, -77]) {
      this.cyl(R, 'gunmetal', 1.4, 2.4, [x, 4.8, 49], false, [Math.PI / 2, 0, 0], 16);
      this.box(R, 'dark', [7, 0.08, 0.4], [x, 6.3, 49], false);
    }
    this.clear(R).box(this.mats.glass, [3.2, 1.2, 2.2], [-88, 4.6, 42.4]);
    this.box(R, 'vanta', [0.05, 1.2, 6], [-85.78, 3.4, 52], false);
    // Cargo truck, containers, fuel tanks, the giant hangar door (west wall).
    this.box(R, 'gunmetal', [2.6, 3.0, 9], [-72, 1.9, 28], true, undefined, METAL);
    this.box(R, 'vanta', [2.6, 2.4, 2.6], [-72, 1.6, 34.2], true, undefined, METAL);
    for (const z of [25, 31, 33.5]) {
      this.cyl(R, 'tire', 0.55, 0.4, [-73.4, 0.55, z], false, [0, 0, Math.PI / 2], 12);
      this.cyl(R, 'tire', 0.55, 0.4, [-70.6, 0.55, z], false, [0, 0, Math.PI / 2], 12);
    }
    this.box(R, 'contGreen', [2.44, 2.6, 6.06], [-104, 1.3, 22]);
    this.box(R, 'contBlue', [2.44, 2.6, 6.06], [-104, 1.3, 29]);
    this.box(R, 'contRust', [2.44, 2.6, 6.06], [-104, 3.9, 25.5], false);
    for (const z of [78, 82]) this.cyl(R, 'offwhite', 1.6, 5, [-106, 2.5, z], true, [0, 0, 0], 18);
    this.box(R, 'steel', [0.4, 12, 40], [-109.6, 6, 52], false);
    for (let z = 33; z < 72; z += 2) this.box(R, z % 4 < 2 ? 'yellow' : 'dark', [0.08, 0.6, 1.2], [-109.35, 0.3, z], false);
    this.serviceLift(R, -80, 85.85, Math.PI);
    this.spawnAt('hangar', [[-108, 16], [-68, 84], [-108, 84]]);
  }

  private buildLabs(): void {
    const R = 'labs';
    for (const x of [-32, -20, 20, 32]) {
      for (const z of [-30, -14]) {
        this.glass(R, [9, 2.8, 0.08], [x, 1.4, z + 4]);
        this.glass(R, [0.08, 2.8, 8], [x - 4.5, 1.4, z]);
        this.box(R, 'white', [6, 0.9, 1.2], [x, 0.45, z - 2]);
        this.box(R, 'screen', [1.2, 0.7, 0.05], [x, 1.35, z - 2.5], false);
        this.box(R, 'steel', [0.6, 1.8, 0.6], [x + 3, 0.9, z + 1]);
      }
    }
    this.cyl(R, 'gunmetal', 1.6, 0.9, [0, 0.45, -21], true, [0, 0, 0], 24);
    this.cyl(R, 'core', 1.3, 0.05, [0, 0.93, -21], false, [0, 0, 0], 24);
    this.serviceLift(R, -39.85, -28, Math.PI / 2);
    this.serviceLift(R, 39.85, -12, -Math.PI / 2);
    this.wallBuy(R, 'm4a1', 1800, [0, 1.6, -35.82], 0);
    this.spawnAt('labs', [[-38, -34], [38, -34], [-38, -8]]);
    const C = 'cleanroom';
    for (const x of [-34, -24, -14]) {
      this.glass(C, [6, 2.6, 0.08], [x, 1.3, -44]);
      this.box(C, 'white', [3, 1.8, 1.8], [x, 0.9, -56]);
      this.box(C, 'lampCool', [2.4, 0.05, 1.2], [x, 1.83, -56], false);
    }
    const P = 'prototypes';
    for (const x of [8, 16, 24, 32]) {
      this.box(P, 'gunmetal', [0.3, 1.2, 18], [x - 4, 0.6, -51], true, undefined, METAL);
      this.box(P, 'offwhite', [1.2, 1.8, 0.2], [x, 0.9, -64], true, undefined, METAL);
    }
    this.box(P, 'gunmetal', [3, 0.5, 3], [20, 0.25, -40]);
    this.box(P, 'white', [1.4, 2.0, 1.0], [20, 2.2, -40]);
    this.box(P, 'dark', [0.9, 0.7, 0.8], [20, 3.6, -40], false);
    this.box(P, 'lampRed', [0.6, 0.12, 0.05], [20, 3.65, -39.58], false);
    this.spawnAt('deeplabs', [[-38, -64], [-2, -64], [38, -64]]);
  }

  private buildServers(): void {
    const R = 'servers';
    for (let z = -62; z <= 10; z += 4) {
      this.row(R, 'dark', 44, 68, z, 2.4, 1.2);
      for (let x = 45; x < 68; x += 1.1) {
        this.box(R, 'leds', [0.05, 0.05, 0.02], [x, 1.8, z + 0.61], false);
        this.box(R, 'leds', [0.05, 0.05, 0.02], [x + 0.4, 1.2, z - 0.61], false);
      }
    }
    // Data core: glowing column in a ring of cabinets.
    this.cyl(R, 'gunmetal', 5, 0.6, [88, 0.3, -26], true, [0, 0, 0], 32);
    this.cyl(R, 'core', 1.6, 6.4, [88, 3.8, -26], true, [0, 0, 0], 24);
    for (const y of [1.5, 3.5, 5.5]) this.cyl(R, 'steel', 2.2, 0.15, [88, y, -26], false, [0, 0, 0], 24);
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      if (a === 3) continue; // gap to walk in
      this.box(R, 'dark', [1.2, 2.4, 0.8], [88 + Math.cos(ang) * 9, 1.2, -26 + Math.sin(ang) * 9], true, [0, -ang, 0]);
    }
    this.serviceLift(R, 100, -65.85, 0);
    this.serviceLift(R, 109.85, 0, -Math.PI / 2);
    this.wallBuy(R, 'mk47', 2000, [109.82, 1.6, -40], -Math.PI / 2);
    this.spawnAt('servers', [[108, -64], [108, 12], [72, -64], [72, 12]]);
    const C = 'cooling';
    for (let x = 48; x <= 102; x += 9) {
      this.cyl(C, 'steel', 2.2, 5, [x, 2.5, -78], true, [0, 0, 0], 20);
      this.box(C, 'gunmetal', [0.5, 0.5, 18], [x, 7.2, -76], false);
    }
    this.spawnAt('servers', [[42, -84], [108, -84]]);
  }

  private buildBarracks(): void {
    const R = 'barracks';
    for (let z = 18; z <= 46; z += 4) {
      this.box(R, 'dark', [2.2, 0.5, 1.0], [107, 0.25, z]);
      this.box(R, 'fabric', [2.1, 0.12, 0.9], [107, 0.56, z], false);
      this.box(R, 'dark', [2.2, 0.08, 1.0], [107, 1.6, z]);
      this.box(R, 'fabric', [2.1, 0.12, 0.9], [107, 1.7, z], false);
    }
    this.row(R, 'gunmetal', 70, 86, 15, 2.1, 0.6);
    for (let x = 70; x <= 90; x += 0.36) this.box(R, 'steel', [0.04, 3, 0.04], [x, 1.5, 60], false);
    this.physics.addStaticBox(new THREE.Vector3(80, 1.5, 60), new THREE.Vector3(10, 1.5, 0.08), undefined, METAL);
    for (const z of [68, 74, 80]) {
      this.box(R, 'woodDark', [1.2, 1.1, 2.4], [72, 0.55, z]);
      this.box(R, 'offwhite', [0.6, 1.6, 0.05], [106, 1.4, z], false);
    }
    for (const x of [76, 90, 104]) this.box(R, 'vanta', [3, 4.5, 0.06], [x, 3.4, 85.88], false);
    this.serviceLift(R, 96, 85.85, Math.PI);
    this.spawnAt('barracks', [[108, 16], [108, 84], [68, 84], [96, 50]]);
  }

  private buildPower(): void {
    const R = 'power';
    for (const x of [-26, 26]) {
      this.cyl(R, 'steel', 4, 9, [x, 4.5, -76], true, [0, 0, 0], 28);
      this.cyl(R, 'yellow', 4.05, 0.4, [x, 7, -76], false, [0, 0, 0], 28);
    }
    this.cyl(R, 'gunmetal', 5, 1, [0, 0.5, -76], true, [0, 0, 0], 28);
    this.cyl(R, 'screenWarm', 2.4, 7, [0, 4.5, -76], true, [0, 0, 0], 24);
    for (const x of [-12, 12]) this.box(R, 'gunmetal', [0.6, 0.6, 18], [x, 9.5, -76], false);
    this.serviceLift(R, -10, -85.85, 0);
    this.serviceLift(R, 10, -85.85, 0);
    this.spawnAt('power', [[-38, -84], [38, -84], [0, -84]]);
  }

  /** Room name signs above every opening, on both sides. */
  private buildSigns(): void {
    const tex = new Map<string, THREE.Texture>();
    const signTex = (text: string) => {
      let t = tex.get(text);
      if (!t) {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 96;
        const g = c.getContext('2d')!;
        g.fillStyle = '#16181b';
        g.fillRect(0, 0, 512, 96);
        g.fillStyle = '#a3171a';
        g.fillRect(0, 0, 10, 96);
        g.fillStyle = '#f0f0f0';
        g.font = '600 46px system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(text.toUpperCase(), 30, 50);
        t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        tex.set(text, t);
      }
      return t;
    };
    for (const l of LINKS) {
      const a = ROOMS.find((r) => r.id === l.a)!;
      const b = ROOMS.find((r) => r.id === l.b)!;
      const vertical = a.rect[2] === b.rect[0] || a.rect[0] === b.rect[2];
      const line = vertical ? (a.rect[2] === b.rect[0] ? a.rect[2] : a.rect[0]) : a.rect[3] === b.rect[1] ? a.rect[3] : a.rect[1];
      const h = Math.min(l.height ?? 4, Math.min(a.h, b.h) - 0.4) + 0.75;
      for (const [from, to] of [[a, b], [b, a]] as const) {
        // Sign on `from`'s side, naming the room you walk into.
        const dir = vertical ? (to.rect[0] >= from.rect[2] ? 1 : -1) : to.rect[1] >= from.rect[3] ? 1 : -1;
        const off = -dir * 0.17;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.49), new THREE.MeshBasicMaterial({ map: signTex(to.name), toneMapped: false }));
        if (vertical) {
          m.position.set(line + off, h, l.at);
          m.rotation.y = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
        } else {
          m.position.set(l.at, h, line + off);
          m.rotation.y = dir > 0 ? Math.PI : 0;
        }
        this.room(from.id).group.add(m);
      }
    }
    // Big lobby logo over the lifts.
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f2f3f4';
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#a3171a';
    g.fillRect(60, 70, 18, 116);
    g.fillStyle = '#1b1d20';
    g.font = '700 120px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('VANTA', 110, 118);
    g.font = '400 44px system-ui, sans-serif';
    g.fillStyle = '#5a5e64';
    g.fillText('DYNAMICS  ·  SITE-9', 560, 124);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    logo.position.set(0, 5.1, 83.82);
    logo.rotation.y = Math.PI;
    this.room('lobby').group.add(logo);
  }

  private placeProps(): void {
    const p = this.props;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    p.stack(v(-96, 0, 8), 4, 0.6);
    p.barrel(v(-62, 0.45, 10));
    p.barrel(v(-61, 0.45, 11), true);
    p.cube(v(-80, 0.5, 80), 1, 0.3);
    p.cube(v(-79, 0.5, 78.6), 1, 0.7, true);
    p.barrel(v(100, 0.45, -70));
    p.barrel(v(62, 0.45, 82));
    p.stack(v(-46, 0, -84), 3, 0.5);
  }

  /** Zone of the room containing (x, z). */
  zoneAt(x: number, z: number): string | null {
    return this.layout.roomAt(x, z)?.zone ?? null;
  }

  update(dt: number, focus?: THREE.Vector3): void {
    this.props.update();
    this.time += dt;
    this.serverLeds.emissiveIntensity = 1.4 + Math.sin(this.time * 9) * Math.sin(this.time * 23.7) * 0.9;
    this.coreGlow.emissiveIntensity = 2.6 + Math.sin(this.time * 1.7) * 0.6;
    // Shadow camera follows the player (texel-snapped so shadows don't swim).
    if (focus) {
      const r = this.mobile ? 26 : 38;
      const texel = (2 * r) / this.sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel;
      const fz = Math.round(focus.z / texel) * texel;
      this.sun.target.position.set(fx, 0, fz);
      this.sun.position.set(fx + 14, 40, fz + 9);
      this.sun.target.updateMatrixWorld();
    }
  }
}

/** Vertical contact-shadow gradient: dark at the floor, gone by ~0.5 m. */
function aoTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
}
