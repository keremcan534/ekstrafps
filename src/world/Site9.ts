import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { PhysicsProps } from './PhysicsProps';
import { corrugatedTexture, glowTexture, grimeRoughness, gridTexture, woodTexture } from '../fx/Textures';
import type { RobotOptions } from '../targets/RobotTarget';
import type { GameMap, SquadSpawn, Station } from './GameMap';
import { LayoutBuilder, type BuiltRoom, type DoorSlot, type LinkDef, type RoomDef, type RoomStyle, type Rect } from './LayoutBuilder';
import type { MeshBuilder } from './MeshBuilder';

type V3 = [number, number, number];

const METAL: HitReceiver = { surface: 'metal', allowDecals: true };

/** A weapon for sale on a wall (Survival). */
/** Moonlight through the skylights and over the yard. */
const SUN = 0.3;

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

/** Free wall spot for random content (extra wall weapons, stations, breakers, crates, sentries). */
export interface WallSpot {
  /** On the wall face. */
  pos: THREE.Vector3;
  /** Faces into the room. */
  yaw: number;
  room: string;
  zone: string;
}

/** Candidate area for a random hazard (electrified floor, gas leak, fire). */
export interface HazardSpot {
  rect: [number, number, number, number];
  zone: string;
}

/** Prices of the wall weapons; positions get a random weapon each game (lobby excepted). */
export const WEAPON_PRICES: Record<string, number> = {
  heavy_pistol: 300, kar98: 600, glock18: 700, pump_shotgun: 900, mosin: 1000, mp5: 1100, ppsh: 1200, ak47: 1400, saiga12: 1500, asval: 1600,
  m4a1: 1800, mk47: 2000, svd: 2100, rd704: 2250, scarh: 2400, m249: 2600,
};
/** Team start rooms (4-team mode): cheap guns on their walls, a guaranteed ammo cache. */
export const TEAM_STARTS: Record<string, { room: string; zone: string; pos: [number, number] }> = {
  alpha: { room: 'lobby', zone: 'start', pos: [0, 78] },
  bravo: { room: 'hangar', zone: 'hangar', pos: [-82, 78] },
  charlie: { room: 'barracks', zone: 'barracks', pos: [90, 76] },
  delta: { room: 'power', zone: 'power', pos: [12, -69] },
};
const START_WEAPONS = ['kar98', 'pump_shotgun', 'mosin', 'glock18'];
const RANDOM_WEAPONS = [
  'pump_shotgun', 'mosin', 'ppsh', 'ak47', 'asval', 'm4a1', 'mk47', 'rd704', 'pump_shotgun', 'ppsh', 'ak47',
  'mp5', 'mp5', 'saiga12', 'svd', 'scarh', 'm249',
];

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
  buy('cafeteria', 'hangar', 68, 750),
  buy('garden', 'hangar', 33, 750),
  buy('garden', 'assembly', -53, 1250, 6),
  buy('atrium', 'assembly', 4, 1250, 6),
  buy('hangar', 'assembly', -88, 750, 8),
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
  buy('security', 'barracks', 68, 750),
  buy('medbay', 'barracks', 33, 750),
  buy('servers', 'barracks', 88, 750, 6),
  buy('cleanroom', 'power', -20, 750),
  buy('prototypes', 'power', 20, 750),
  buy('warehouse', 'power', -76, 750),
  buy('cooling', 'power', -76, 750),
];

// ---------------------------------------------------------------- scale
/**
 * Everything above (and every coordinate in the room builders below) is the
 * design layout. The built map is MAP_SCALE of it in X/Z: rooms shrink to
 * whole-metre rects, and each design point is mapped linearly inside its own
 * room, so things on a wall stay on that wall and the middle stays the middle.
 * Small props keep their real size; only long runs (≥ 4 m) shrink with the room.
 */
export const MAP_SCALE = 0.8;
const DESIGN = new Map<string, Rect>(ROOMS.map((r) => [r.id, [...r.rect] as Rect]));
for (const r of ROOMS) r.rect = r.rect.map((v) => Math.round(v * MAP_SCALE)) as Rect;
const ROOM_OF = new Map(ROOMS.map((r) => [r.id, r]));
function axisMap(id: string, a: 0 | 1, v: number): number {
  const d = DESIGN.get(id)!;
  const w = ROOM_OF.get(id)!.rect;
  const i0 = a === 0 ? 0 : 1;
  const i1 = a === 0 ? 2 : 3;
  return w[i0] + ((v - d[i0]) / (d[i1] - d[i0])) * (w[i1] - w[i0]);
}
/** World / design scale of a room along X (0) or Z (1). */
function kOf(id: string, a: 0 | 1): number {
  const d = DESIGN.get(id)!;
  const w = ROOM_OF.get(id)!.rect;
  return a === 0 ? (w[2] - w[0]) / (d[2] - d[0]) : (w[3] - w[1]) / (d[3] - d[1]);
}
/** Design point in room `id` → world (x, z). */
function W(id: string, x: number, z: number): [number, number] {
  return [axisMap(id, 0, x), axisMap(id, 1, z)];
}
/** Design point → world, using whichever room it is in (or nearest). */
function Wp(x: number, z: number): [number, number] {
  let best = ROOMS[0].id;
  let bd = Infinity;
  for (const [id, r] of DESIGN) {
    const dx = Math.max(r[0] - x, 0, x - r[2]);
    const dz = Math.max(r[1] - z, 0, z - r[3]);
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return W(best, x, z);
}
for (const l of LINKS) {
  const da = DESIGN.get(l.a)!;
  const db = DESIGN.get(l.b)!;
  const vertical = da[2] === db[0] || da[0] === db[2];
  const ax = vertical ? 1 : 0;
  l.at = Math.round((axisMap(l.a, ax, l.at) + axisMap(l.b, ax, l.at)) / 2);
}
for (const st of Object.values(TEAM_STARTS)) st.pos = W(st.room, st.pos[0], st.pos[1]);

/**
 * Site-9 (Survival map): Vanta Dynamics' research campus, one level,
 * ~176 × 136 m (MAP_SCALE of the design layout). Bright and airy on purpose: a glass-roofed atrium with a giant
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
  readonly spawn = new THREE.Vector3(...((p) => [p[0], 0, p[1]])(W('lobby', 0, 78)) as V3);
  readonly spawnYaw = 0;
  readonly robotSpawns: RobotOptions[] = [];
  readonly squads: SquadSpawn[] = [];
  readonly navBounds: [number, number, number, number];
  readonly sun: THREE.DirectionalLight;
  /** Night over Site-9: the skylights and the yard read dark. */
  readonly skyColor = 0x1b2330;
  readonly exposure = 0.88;
  readonly stations: Station[] = [
    { name: 'Arrival Lobby (start)', pos: ((p) => [p[0], 0, p[1]])(Wp(0, 78)) as V3, yaw: 0 },
    { name: 'Atrium', pos: ((p) => [p[0], 0, p[1]])(Wp(0, 40)) as V3, yaw: 0 },
    { name: 'Garden Court', pos: ((p) => [p[0], 0, p[1]])(Wp(-53, 45)) as V3, yaw: 0 },
    { name: 'Assembly Hall', pos: ((p) => [p[0], 0, p[1]])(Wp(-60, 0)) as V3, yaw: Math.PI / 2 },
    { name: 'Hangar', pos: ((p) => [p[0], 0, p[1]])(Wp(-80, 70)) as V3, yaw: Math.PI / 2 },
    { name: 'Server Hall', pos: ((p) => [p[0], 0, p[1]])(Wp(45, 0)) as V3, yaw: -Math.PI / 2 },
    { name: 'Barracks', pos: ((p) => [p[0], 0, p[1]])(Wp(70, 75)) as V3, yaw: -Math.PI / 2 },
    { name: 'Power Plant', pos: ((p) => [p[0], 0, p[1]])(Wp(0, -70)) as V3, yaw: 0 },
  ];
  readonly layout: LayoutBuilder;
  readonly doors: DoorSlot[];
  readonly wallBuys: WallBuy[] = [];
  readonly terminals: Terminal[] = [];
  readonly spawnPoints: SpawnPoint[] = [];
  readonly ammoSpots: AmmoSpot[] = [];
  readonly hazardSpots: HazardSpot[] = [];
  /** Room connections (archways always open; shutters when bought). */
  readonly links = LINKS;
  /** Free wall spots (Survival validates them against furniture and fills a random subset). */
  readonly wallSpots: WallSpot[] = [];
  readonly rooms = ROOMS;

  private mats: Record<string, THREE.Material>;
  private pools = new Map<number, THREE.Material>();
  private serverLeds: THREE.MeshStandardMaterial;
  private hemi!: THREE.HemisphereLight;
  /** Hemisphere fill with the power on (darker on desktop, phones keep a little more). */
  private ambient = 0.42;
  /** Coloured accent lights (reactor, data core) with their full intensity. */
  private accents: [THREE.PointLight, number][] = [];
  /** Ceiling lamps: position just under the panel, light colour, ceiling height. */
  readonly lampSpots: { pos: THREE.Vector3; color: number; h: number }[] = [];
  /** Emergency strip positions (the red lights during a blackout come from these). */
  readonly emergencySpots: THREE.Vector3[] = [];
  private emergency = new THREE.MeshStandardMaterial({ color: 0x200000, emissive: 0xff1a0a, emissiveIntensity: 0.01 }); // non-zero: keeps it out of the vertex-colour merge
  private lampBase = new Map<THREE.MeshStandardMaterial, number>();
  private blackout = 0;
  /** Floor footprints of everything standing on the floor (clutter keeps clear of them). */
  private footprints: [number, number, number, number][] = [];
  /** Broken, flickering lamp fixtures (one shared flicker) and their light pools. */
  private brokenLampMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xf2f6ff, emissiveIntensity: 2.6 });
  private brokenPool = new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xeef4ff, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  /** Where the broken lamps spark from (Game sprays sparks when one stutters back on). */
  readonly brokenLamps: THREE.Vector3[] = [];
  /** 0..1 brightness of the broken lamps this frame. */
  brokenLevel = 0;
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
      paper: std({ color: 0xe6e1d6, roughness: 0.9 }),
      cardboard: std({ color: 0x9a774e, roughness: 0.9 }),
      rubble: std({ color: 0x86827b, roughness: 0.95 }),
      stain: std({ color: 0x17140f, roughness: 0.25, metalness: 0.1 }),
      trash: std({ color: 0x121315, roughness: 0.35 }),
      sand: std({ color: 0x8b7b58, roughness: 1 }),
      extinguisher: std({ color: 0xb3141a, roughness: 0.4, metalness: 0.3 }),
      drumBlue: std({ color: 0x2f5f9e, metalness: 0.55, roughness: 0.45 }),
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
      merge: std({ vertexColors: true, roughness: 0.62, metalness: 0.25 }),
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
    this.buildDressing();
    this.buildRandomSlots();
    this.collectWallSpots();
    this.buildDetails();
    this.buildServices();
    this.buildClutter();
    this.buildSigns();
    this.layout.build(this.group);
    // Ceiling lamps (the practical lights near you come from these).
    for (const room of this.layout.rooms.values()) {
      const glow = styles[room.def.style]?.glow || 0xfff1e0;
      // Hung low in tall halls so each lamp makes a pool, not a floodlight.
      for (const p of room.lamps) this.lampSpots.push({ pos: new THREE.Vector3(p.x, Math.min(p.y - 0.25, 5.2), p.z), color: glow, h: p.y });
    }

    this.props = new PhysicsProps(physics);
    this.group.add(this.props.group);
    this.placeProps();

    // --- Lighting: night. Dim cool fill and moonlight through the skylights; the
    // light comes from the lamps (pools on the floor + real lights near you, see Lighting).
    // Ceilings don't cast shadows, so the key light reads as "light from above";
    // its shadow camera follows the player (crisp shadows nearby, cheap).
    this.ambient = mobile ? 0.42 : 0.24;
    this.hemi = new THREE.HemisphereLight(0xc4d0e0, 0x3a3631, this.ambient);
    this.group.add(this.hemi);
    for (const k of ['lampCool', 'lampWarm', 'lampBlue', 'screen', 'screenWarm']) {
      const m = this.mats[k] as THREE.MeshStandardMaterial;
      this.lampBase.set(m, m.emissiveIntensity);
    }
    const sun = new THREE.DirectionalLight(0xa8bce0, SUN);
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
        const [wx, wz] = Wp(pos[0], pos[2]);
        l.position.set(wx, pos[1], wz);
        this.group.add(l);
        this.accents.push([l, intensity]);
      };
      point(0x5fd0ff, 60, 26, [88, 4, -26]); // data core
      point(0xffb060, 70, 30, [0, 8, -76]); // reactor
      point(0xff4030, 30, 18, [100, 4, 50]); // barracks
    }
  }

  // ---------------------------------------------------------------- clutter

  /**
   * Lived-in, abandoned-facility clutter, the same every game (seeded):
   *  - floor litter (papers, rubble, cable runs, oil stains, fallen ceiling tiles): flat, walk over it
   *  - wall-side props (box stacks, cabinets, crates, drums, trash bags): solid, never in a doorway
   *  - barricade remains in the big rooms (an overturned table + sandbags): new cover
   *  - extinguishers, vents, hanging cables, and the odd broken lamp that flickers and sparks
   * Everything merges into the room meshes (no extra draw calls) except the broken lamps.
   */
  private buildClutter(): void {
    let seed = 0x5173;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const industrial = new Set(['factory', 'hangar', 'servers']);
    const starts = Object.values(TEAM_STARTS).map((s) => Wp(s.pos[0], s.pos[1]));

    for (const room of ROOMS) {
      const R = room.id;
      const [x0, z0, x1, z1] = room.rect;
      const w = x1 - x0;
      const d = z1 - z0;
      const ind = industrial.has(room.style);
      // Keep-outs: doorways, buy spots / stations, spawns, team starts.
      const keep: [number, number, number][] = [];
      for (const l of LINKS) {
        if (l.a !== R && l.b !== R) continue;
        const o = ROOM_OF.get(l.a === R ? l.b : l.a)!;
        const vertical = room.rect[2] === o.rect[0] || room.rect[0] === o.rect[2];
        if (vertical) keep.push([room.rect[2] === o.rect[0] ? x1 : x0, l.at, l.width / 2 + 3]);
        else keep.push([l.at, room.rect[3] === o.rect[1] ? z1 : z0, l.width / 2 + 3]);
      }
      for (const p of this.reserved) keep.push([p.x, p.z, 1.9]);
      for (const sp of this.spawnPoints) keep.push([sp.pos.x, sp.pos.z, 3]);
      for (const [sx, sz] of starts) keep.push([sx, sz, 5]);
      const clearOf = (x: number, z: number, hx: number, hz: number, pad: number) => {
        if (x - hx < x0 + 0.05 || x + hx > x1 - 0.05 || z - hz < z0 + 0.05 || z + hz > z1 - 0.05) return false;
        for (const [kx, kz, r] of keep) if (Math.hypot(kx - x, kz - z) < r + Math.max(hx, hz)) return false;
        for (const f of this.footprints) if (x + hx + pad > f[0] && x - hx - pad < f[2] && z + hz + pad > f[1] && z - hz - pad < f[3]) return false;
        return true;
      };

      // --- Floor litter (flat; you walk over it).
      const litter = Math.max(8, Math.min(110, Math.round((w * d) / 10)));
      for (let i = 0; i < litter; i++) {
        const x = x0 + 1 + rnd() * (w - 2);
        const z = z0 + 1 + rnd() * (d - 2);
        if (!clearOf(x, z, 0.4, 0.4, 0)) continue;
        const k = rnd();
        if (k < 0.4) {
          for (let j = 0, n = 1 + Math.floor(rnd() * 4); j < n; j++) {
            this.boxW(R, 'paper', [0.21, 0.004, 0.29], [x + (rnd() - 0.5) * 0.9, 0.006 + j * 0.001, z + (rnd() - 0.5) * 0.9], false, [0, rnd() * Math.PI, 0]);
          }
        } else if (k < 0.62) {
          for (let j = 0, n = 3 + Math.floor(rnd() * 5); j < n; j++) {
            const s = 0.05 + rnd() * 0.17;
            this.boxW(R, rnd() < 0.7 ? 'rubble' : 'gunmetal', [s, s * (0.5 + rnd() * 0.6), s * (0.7 + rnd() * 0.6)], [x + (rnd() - 0.5) * 1.1, s * 0.3, z + (rnd() - 0.5) * 1.1], false, [rnd() * 0.6, rnd() * 3, rnd() * 0.6]);
          }
        } else if (k < 0.77) {
          this.cylW(R, 'stain', 0.4 + rnd() * 0.9, 0.002, [x, 0.003, z], false, [0, 0, 0], 14);
        } else if (k < 0.9) {
          // Cable run: three kinked segments.
          let cx = x;
          let cz = z;
          let yaw = rnd() * Math.PI * 2;
          for (let j = 0; j < 3; j++) {
            const len = 0.8 + rnd() * 1.4;
            const mx = cx + Math.sin(yaw) * len * 0.5;
            const mz = cz + Math.cos(yaw) * len * 0.5;
            if (mx < x0 + 0.3 || mx > x1 - 0.3 || mz < z0 + 0.3 || mz > z1 - 0.3) break;
            this.boxW(R, 'dark', [0.035, 0.03, len], [mx, 0.016, mz], false, [0, yaw, 0]);
            cx += Math.sin(yaw) * len;
            cz += Math.cos(yaw) * len;
            yaw += (rnd() - 0.5) * 1.4;
          }
        } else if (!room.sky && !room.skylight) {
          // Fallen ceiling tile, one edge on the floor, plus a broken piece.
          const yaw = rnd() * Math.PI;
          this.boxW(R, 'offwhite', [0.6, 0.025, 0.6], [x, 0.1, z], false, [0.32, yaw, 0]);
          this.boxW(R, 'offwhite', [0.28, 0.025, 0.2], [x + 0.5, 0.013, z - 0.3], false, [0, yaw + 0.7, 0]);
        }
      }

      // --- Wall-side props (solid).
      const walls: [number, number, number, number, number, number][] = [
        [x0, z0, x1, z0, 0, 1], [x0, z1, x1, z1, 0, -1], [x0, z0, x0, z1, 1, 0], [x1, z0, x1, z1, -1, 0],
      ];
      const props = Math.round((2 * (w + d)) / (ind ? 7 : 9));
      let along = -1;
      let wall = walls[0];
      for (let i = 0, placed = 0; i < props * 5 && placed < props; i++) {
        // Half the time the next prop goes right beside the last one (props come in groups).
        const pair = along >= 0 && rnd() < 0.5;
        if (!pair) wall = pick(walls);
        const [ax, az, bx, bz, nx, nz] = wall;
        const len = Math.hypot(bx - ax, bz - az);
        const s = pair ? along + (rnd() < 0.5 ? -1.55 : 1.55) : 1.5 + rnd() * (len - 3);
        along = -1;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        const yaw = Math.atan2(nx, nz) + (rnd() - 0.5) * 0.25;
        const type = ind ? pick(['crate', 'crate', 'pallet', 'drums', 'cylinders', 'boxes'] as const) : pick(['boxes', 'boxes', 'cabinet', 'bags', 'chair'] as const);
        const depth = type === 'crate' || type === 'pallet' ? 0.6 : type === 'drums' ? 0.35 : 0.32;
        const x = ax + ux * s + nx * (depth + 0.2);
        const z = az + uz * s + nz * (depth + 0.2);
        const half = type === 'pallet' || type === 'drums' ? 0.7 : 0.6;
        if (!clearOf(x, z, nx ? depth : half, nx ? half : depth, 0.15)) continue;
        this.wallProp(R, type, x, z, yaw, rnd);
        placed++;
        along = s;
      }

      // --- Barricade remains in big rooms (cover in the open).
      if (w * d > 900) {
        for (let tries = 0, made = 0; tries < 30 && made < Math.round((w * d) / 1800); tries++) {
          const x = x0 + 6 + rnd() * (w - 12);
          const z = z0 + 6 + rnd() * (d - 12);
          if (!clearOf(x, z, 1.4, 1.4, 1.2)) continue;
          this.barricade(R, x, z, rnd() * Math.PI, rnd);
          made++;
        }
      }

      // --- Wall details: extinguishers and vents (flush, above the kick plate).
      for (const [ax, az, bx, bz, nx, nz] of walls) {
        const len = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        for (let s = 5 + rnd() * 6; s < len - 4; s += 13 + rnd() * 9) {
          // Wall faces sit 0.15 m inside the room boundary.
          const x = ax + ux * s + nx * 0.25;
          const z = az + uz * s + nz * 0.25;
          if (!clearOf(x, z, 0.2, 0.2, 0)) continue;
          if (rnd() < 0.55) {
            this.cylW(R, 'extinguisher', 0.085, 0.5, [x, 0.55, z], false, [0, 0, 0], 10);
            this.cylW(R, 'dark', 0.03, 0.08, [x, 0.84, z], false, [0, 0, 0], 6);
            this.boxW(R, 'gunmetal', nx ? [0.03, 0.14, 0.22] : [0.22, 0.14, 0.03], [x - nx * 0.08, 0.7, z - nz * 0.08], false);
          } else {
            const along = nz !== 0;
            this.boxW(R, 'dark', along ? [0.7, 0.32, 0.03] : [0.03, 0.32, 0.7], [x - nx * 0.085, 0.42, z - nz * 0.085], false);
            for (let k = 0; k < 4; k++) this.boxW(R, 'gunmetal', along ? [0.66, 0.025, 0.035] : [0.035, 0.025, 0.66], [x - nx * 0.07, 0.3 + k * 0.08, z - nz * 0.07], false);
          }
        }
      }

      // --- Hanging cables (well above head height) and a broken lamp.
      if (!room.sky) {
        for (let i = 0, n = Math.round((w * d) / 260); i < n; i++) {
          const x = x0 + 2 + rnd() * (w - 4);
          const z = z0 + 2 + rnd() * (d - 4);
          const len = Math.min(room.h - 2.6, 0.8 + rnd() * 2.2);
          if (len < 0.4) continue;
          this.boxW(R, 'dark', [0.025, len, 0.025], [x, room.h - len / 2, z], false, [(rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25]);
        }
        if (!room.skylight && rnd() < 0.75) {
          for (let tries = 0; tries < 10; tries++) {
            const x = x0 + 3 + rnd() * (w - 6);
            const z = z0 + 3 + rnd() * (d - 6);
            if (!clearOf(x, z, 0.8, 0.8, 0)) continue;
            this.brokenLamp(R, x, z, Math.min(room.h - 1.1, 4.2), room.h, rnd() * Math.PI);
            break;
          }
        }
      }
    }
  }

  /** One solid wall-side prop (world position; yaw faces into the room). */
  private wallProp(R: string, type: 'crate' | 'pallet' | 'drums' | 'cylinders' | 'boxes' | 'cabinet' | 'bags' | 'chair', x: number, z: number, yaw: number, rnd: () => number): void {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // Local (right, forward) offset → world.
    const P = (r: number, y: number, f: number): V3 => [x + c * r + s * f, y, z - s * r + c * f];
    const rot = (dy = 0): V3 => [0, yaw + dy, 0];
    switch (type) {
      case 'crate': {
        const k = 0.9 + rnd() * 0.3;
        this.boxW(R, 'woodDark', [k, k, k], [x, k / 2, z], true, rot((rnd() - 0.5) * 0.3));
        if (rnd() < 0.45) this.boxW(R, 'woodDark', [0.7, 0.7, 0.7], [x, k + 0.35, z], true, rot(rnd()));
        break;
      }
      case 'pallet': {
        this.boxW(R, 'wood', [1.2, 0.14, 1.0], [x, 0.07, z], true, rot());
        for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
          const b = 0.42 + rnd() * 0.12;
          this.boxW(R, 'cardboard', [b, b * 0.8, b], P((i % 2) * 0.5 - 0.25, 0.14 + b * 0.4 + Math.floor(i / 2) * b * 0.8, 0), true, rot((rnd() - 0.5) * 0.4));
        }
        break;
      }
      case 'drums':
        for (const r of [-0.34, 0.34]) this.cylW(R, rnd() < 0.5 ? 'vanta' : 'drumBlue', 0.3, 0.9, P(r, 0.45, 0), true, [0, 0, 0], 14);
        break;
      case 'cylinders':
        for (const r of [-0.22, 0, 0.22]) this.cylW(R, 'steel', 0.11, 1.4, P(r, 0.7, -0.15), true, [0, 0, (rnd() - 0.5) * 0.08], 10);
        this.boxW(R, 'yellow', [0.75, 0.05, 0.05], P(0, 1.05, 0.0), false, rot());
        break;
      case 'boxes':
        for (let i = 0, n = 1 + Math.floor(rnd() * 3); i < n; i++) {
          const b = 0.42 + rnd() * 0.2;
          this.boxW(R, 'cardboard', [b, b * 0.85, b], P((rnd() - 0.5) * 0.3, b * 0.425 + i * b * 0.8, 0), true, rot((rnd() - 0.5) * 0.6));
        }
        break;
      case 'cabinet':
        this.boxW(R, 'gunmetal', [0.5, 1.32, 0.6], [x, 0.66, z], true, rot());
        for (let i = 0; i < 4; i++) this.boxW(R, 'dark', [0.16, 0.025, 0.02], P(0, 0.25 + i * 0.32, 0.31), false, rot());
        if (rnd() < 0.5) this.boxW(R, 'gunmetal', [0.44, 0.26, 0.5], P(0, 0.9, 0.42), true, rot()); // drawer pulled out
        break;
      case 'bags':
        for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
          const r = 0.22 + rnd() * 0.1;
          this.room(R).b.add(this.mats.trash, new THREE.IcosahedronGeometry(r, 1), P((rnd() - 0.5) * 0.8, r * 0.8, (rnd() - 0.5) * 0.3), [rnd(), rnd() * 3, 0], [1, 0.8, 1]);
        }
        this.physics.addStaticBox(new THREE.Vector3(x, 0.3, z), new THREE.Vector3(0.5, 0.3, 0.35), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot())));
        this.footprints.push([x - 0.55, z - 0.55, x + 0.55, z + 0.55]);
        break;
      case 'chair': {
        // Knocked over: seat on its side, legs pointing out.
        this.boxW(R, 'fabric', [0.5, 0.08, 0.5], P(0, 0.27, 0), true, [Math.PI / 2, yaw, 0]);
        this.boxW(R, 'fabric', [0.5, 0.5, 0.08], P(0, 0.04, 0.25), false, rot());
        for (const r of [-0.2, 0.2]) this.boxW(R, 'gunmetal', [0.03, 0.03, 0.42], P(r, 0.12, -0.2), false, rot());
        break;
      }
    }
  }

  /** Overturned table with sandbags piled against it: waist-high cover. */
  private barricade(R: string, x: number, z: number, yaw: number, rnd: () => number): void {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const P = (r: number, y: number, f: number): V3 => [x + c * r + s * f, y, z - s * r + c * f];
    this.boxW(R, 'woodDark', [2.0, 0.95, 0.07], P(0, 0.475, 0), true, [0, yaw, 0]);
    for (const r of [-0.85, 0.85]) {
      for (const y of [0.2, 0.75]) this.boxW(R, 'gunmetal', [0.05, 0.05, 0.7], P(r, y, -0.38), false, [0, yaw, 0]);
    }
    for (let i = 0; i < 5; i++) {
      const row = i < 3 ? 0 : 1;
      this.boxW(R, 'sand', [0.62, 0.2, 0.36], P(-0.62 + (i % 3) * 0.62 + row * 0.31, 0.1 + row * 0.2, 0.25), true, [0, yaw + (rnd() - 0.5) * 0.2, 0]);
    }
    this.boxW(R, 'rubble', [0.3, 0.12, 0.25], P(1.2, 0.06, 0.6), false, [0, rnd() * 3, 0]);
  }

  /** A lamp fixture hanging off one cable, flickering (Site9.update) over a flickering pool. */
  private brokenLamp(R: string, x: number, z: number, y: number, ceiling: number, yaw: number): void {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    this.room(R).ceil.box(this.mats.gunmetal, [1.2, 0.08, 0.3], [x, y, z], [0, yaw, 0.55]);
    this.room(R).ceil.box(this.brokenLampMat, [1.0, 0.02, 0.2], [x, y - 0.05, z], [0, yaw, 0.55]);
    // The cable that held: from the high end up to the ceiling.
    const hx = x + c * 0.5;
    const hz = z - s * 0.5;
    const top = y + 0.28;
    this.room(R).ceil.box(this.mats.dark, [0.02, ceiling - top, 0.02], [hx, (ceiling + top) / 2, hz]);
    this.room(R).clear.add(this.brokenPool, new THREE.PlaneGeometry(5, 5), [x, 0.025, z], [-Math.PI / 2, 0, 0]);
    this.brokenLamps.push(new THREE.Vector3(x - c * 0.5, y - 0.3, z + s * 0.5));
  }

  private pool(color: number): THREE.Material {
    let m = this.pools.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: glowTexture(), color, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.pools.set(color, m);
    }
    return m;
  }

  private room(id: string): BuiltRoom {
    return this.layout.rooms.get(id)!;
  }

  // ---------------------------------------------------------------- prop kit

  /** Design-space size: long runs (≥ 4 m) shrink with the room, props keep their size. */
  private sz(room: string, size: V3): V3 {
    return [size[0] >= 4 ? size[0] * kOf(room, 0) : size[0], size[1], size[2] >= 4 ? size[2] * kOf(room, 1) : size[2]];
  }

  /** Design-space position in `room` → world. */
  private at(room: string, pos: V3): V3 {
    const [x, z] = W(room, pos[0], pos[2]);
    return [x, pos[1], z];
  }

  /** Box at design coordinates (room builders). */
  private box(room: string, mat: string, size: V3, pos: V3, solid = true, rot?: V3, receiver?: HitReceiver): void {
    this.boxW(room, mat, this.sz(room, size), this.at(room, pos), solid, rot, receiver);
  }

  /** Cylinder at design coordinates; big radii and horizontal lengths shrink with the room. */
  private cyl(room: string, mat: string, r: number, h: number, pos: V3, solid = true, rot: V3 = [0, 0, 0], segments = 16): void {
    const k = Math.min(kOf(room, 0), kOf(room, 1));
    const horizontal = Math.abs(rot[0]) > 0.1 || Math.abs(rot[2]) > 0.1;
    this.cylW(room, mat, r >= 3 ? r * k : r, horizontal && h >= 4 ? h * k : h, this.at(room, pos), solid, rot, segments);
  }

  /** Glass pane (no frame) at design coordinates. */
  private clearBox(room: string, size: V3, pos: V3): void {
    this.clear(room).box(this.mats.glass, this.sz(room, size), this.at(room, pos));
  }

  /**
   * Building services in every enclosed room: pipe runs and a cable tray under the
   * ceiling along the long walls, brackets, a dark kick plate along the wall bases and
   * recessed light strips. All merged into the room mesh (no extra draw calls), no colliders.
   */
  private buildServices(): void {
    for (const r of ROOMS) {
      if (r.sky) continue;
      const [x0, z0, x1, z1] = r.rect;
      const w = x1 - x0;
      const d = z1 - z0;
      const h = r.h;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const along = w >= d;
      const len = (along ? w : d) - 1.4;
      const y = h - 0.55;
      // Pipe runs on one long wall, cable tray on the other.
      const run = (off: number, size: [number, number], mat: string, yy: number) =>
        this.boxW(r.id, mat, along ? [len, size[0], size[1]] : [size[1], size[0], len], along ? [cx, yy, z0 + off] : [x0 + off, yy, cz], false);
      run(0.55, [0.24, 0.24], 'gunmetal', y);
      run(0.95, [0.15, 0.15], 'steel', y - 0.06);
      run(d >= 6 || w >= 6 ? (along ? d : w) - 0.5 : 0.5, [0.08, 0.52], 'dark', h - 1.05);
      for (let s = -len / 2 + 1; s < len / 2; s += 4) {
        const p: [number, number, number] = along ? [cx + s, y + 0.12, z0 + 0.75] : [x0 + 0.75, y + 0.12, cz + s];
        this.boxW(r.id, 'dark', along ? [0.07, 0.55, 0.85] : [0.85, 0.55, 0.07], p, false);
      }
      // Kick plates along the wall bases.
      this.boxW(r.id, 'dark', [w - 0.1, 0.16, 0.05], [cx, 0.08, z0 + 0.03], false);
      this.boxW(r.id, 'dark', [w - 0.1, 0.16, 0.05], [cx, 0.08, z1 - 0.03], false);
      this.boxW(r.id, 'dark', [0.05, 0.16, d - 0.1], [x0 + 0.03, 0.08, cz], false);
      this.boxW(r.id, 'dark', [0.05, 0.16, d - 0.1], [x1 - 0.03, 0.08, cz], false);
      // Recessed light strips on the long walls (they go dark with the power like every lamp).
      const strip = Math.min(2.2, h * 0.4);
      for (let s = -len / 2 + 3; s < len / 2 - 2; s += 7) {
        if (along) {
          this.boxW(r.id, 'lampCool', [strip, 0.07, 0.04], [cx + s, h * 0.58, z1 - 0.04], false);
          this.boxW(r.id, 'dark', [strip + 0.2, 0.2, 0.03], [cx + s, h * 0.58, z1 - 0.02], false);
        } else {
          this.boxW(r.id, 'lampCool', [0.04, 0.07, strip], [x1 - 0.04, h * 0.58, cz + s], false);
          this.boxW(r.id, 'dark', [0.03, 0.2, strip + 0.2], [x1 - 0.02, h * 0.58, cz + s], false);
        }
      }
    }
  }

  /** Visual box in a room + optional collider (world coordinates). */
  private boxW(room: string, mat: string, size: V3, pos: V3, solid = true, rot?: V3, receiver?: HitReceiver): void {
    this.room(room).b.box(this.mats[mat], size, pos, rot);
    if (pos[1] - size[1] / 2 < 1.2 && size[1] > 0.25) {
      const turned = !!rot && (Math.abs(rot[0]) + Math.abs(rot[1]) + Math.abs(rot[2]) > 0.01);
      const hx = turned ? Math.max(size[0], size[2]) / 2 : size[0] / 2;
      const hz = turned ? Math.max(size[0], size[2]) / 2 : size[2] / 2;
      this.footprints.push([pos[0] - hx, pos[2] - hz, pos[0] + hx, pos[2] + hz]);
    }
    if (solid) {
      const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)) : undefined;
      this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), q, receiver);
    }
  }

  /** Cylinder (Y axis unless rotated) + an approximate box collider (world coordinates). */
  private cylW(room: string, mat: string, r: number, h: number, pos: V3, solid = true, rot: V3 = [0, 0, 0], segments = 16): void {
    this.room(room).b.cylinder(this.mats[mat], r, h, pos, rot, segments);
    const lying = Math.abs(rot[0]) > 0.1 || Math.abs(rot[2]) > 0.1;
    const e = lying ? Math.max(r, h / 2) : r;
    if (pos[1] - (lying ? r : h / 2) < 1.2 && (h > 0.25 || r > 0.5)) this.footprints.push([pos[0] - e, pos[2] - e, pos[0] + e, pos[2] + e]);
    if (solid) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
      this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(r * 0.85, h / 2, r * 0.85), q);
    }
  }

  private clear(room: string): MeshBuilder {
    return this.room(room).clear;
  }

  private glass(room: string, sizeD: V3, posD: V3): void {
    const size = this.sz(room, sizeD);
    const pos = this.at(room, posD);
    this.clear(room).box(this.mats.glass, size, pos);
    this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), undefined, METAL);
    const vertical = size[0] < size[2];
    const len = vertical ? size[2] : size[0];
    for (const s of [-1, 1]) {
      const o = (len / 2) * s;
      this.boxW(room, 'gunmetal', [0.07, size[1], 0.07], vertical ? [pos[0], pos[1], pos[2] + o] : [pos[0] + o, pos[1], pos[2]], false);
    }
    this.boxW(room, 'gunmetal', vertical ? [0.07, 0.07, len] : [len, 0.07, 0.07], [pos[0], pos[1] + size[1] / 2, pos[2]], false);
  }

  private tree(room: string, xd: number, zd: number, scale = 1, potted = false): void {
    const [x, z] = W(room, xd, zd);
    if (potted) {
      this.cylW(room, 'gunmetal', 0.7 * scale, 0.8, [x, 0.4, z]);
      this.cylW(room, 'soil', 0.62 * scale, 0.05, [x, 0.8, z], false);
    }
    const y0 = potted ? 0.8 : 0;
    this.cylW(room, 'bark', 0.14 * scale, 2.6 * scale, [x, y0 + 1.3 * scale, z], !potted, [0, 0, 0], 8);
    const crown = (dx: number, dy: number, dz: number, r: number, mat: string) =>
      this.room(room).b.add(this.mats[mat], new THREE.IcosahedronGeometry(r * scale, 1), [x + dx * scale, y0 + dy * scale, z + dz * scale]);
    crown(0, 3.1, 0, 1.3, 'leaf');
    crown(0.7, 2.6, 0.3, 0.9, 'leafDark');
    crown(-0.6, 2.7, -0.4, 0.95, 'leaf');
    crown(0.1, 3.8, -0.2, 0.8, 'leafDark');
  }

  private tableSet(room: string, xd: number, zd: number, top = 'white'): void {
    const [x, z] = W(room, xd, zd);
    this.boxW(room, top, [2.4, 0.08, 1.0], [x, 0.76, z]);
    this.boxW(room, 'gunmetal', [0.12, 0.72, 0.12], [x, 0.36, z], false);
    for (const s of [-1, 1]) this.boxW(room, 'gunmetal', [2.2, 0.48, 0.4], [x, 0.24, z + s * 0.85]);
  }

  private sofa(room: string, xd: number, zd: number, yaw: number, mat = 'fabric'): void {
    const [x, z] = W(room, xd, zd);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.boxW(room, mat, [2.2, 0.45, 0.9], [x, 0.22, z], true, [0, yaw, 0]);
    this.boxW(room, mat, [2.2, 0.55, 0.25], [x - s * 0.4, 0.6, z - c * 0.4], false, [0, yaw, 0]);
  }

  /** Cabinet / rack row along X at `z`. */
  private row(room: string, mat: string, x0d: number, x1d: number, zd: number, h: number, d: number): void {
    const [x0, z] = W(room, x0d, zd);
    const [x1] = W(room, x1d, zd);
    this.boxW(room, mat, [x1 - x0, h, d], [(x0 + x1) / 2, h / 2, z], true, undefined, METAL);
  }

  /** Wall weapon slot. Outside the lobby the weapon is rolled at random each game. */
  /** Wall spots already used by gameplay objects (fixtures keep clear of them). */
  private reserved: THREE.Vector3[] = [];

  private wallBuy(room: string, weapon: string, cost: number, posD: V3, yaw: number): void {
    const pos = this.at(room, posD);
    this.reserved.push(new THREE.Vector3(pos[0], 0, pos[2]));
    if (room !== 'lobby') {
      const startRoom = Object.values(TEAM_STARTS).some((s) => s.room === room);
      const pool = startRoom ? START_WEAPONS : RANDOM_WEAPONS;
      weapon = pool[(Math.random() * pool.length) | 0];
      cost = WEAPON_PRICES[weapon];
    }
    this.wallBuys.push({ weapon, cost, pos: new THREE.Vector3(...pos), yaw, room });
  }

  private ammo(room: string, xd: number, zd: number, yaw: number): void {
    const [x, z] = W(room, xd, zd);
    this.reserved.push(new THREE.Vector3(x, 0, z));
    this.ammoSpots.push({ pos: new THREE.Vector3(x, 0, z), yaw, zone: ROOMS.find((r) => r.id === room)!.zone });
  }

  private hazard(room: string, x0d: number, z0d: number, x1d: number, z1d: number): void {
    const [x0, z0] = W(room, x0d, z0d);
    const [x1, z1] = W(room, x1d, z1d);
    this.hazardSpots.push({ rect: [x0, z0, x1, z1], zone: ROOMS.find((r) => r.id === room)!.zone });
  }

  private terminal(room: string, xd: number, zd: number, yaw: number): void {
    const [x, z] = W(room, xd, zd);
    this.reserved.push(new THREE.Vector3(x, 0, z));
    const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.terminals.push({ kind: 'ally', cost: 1500, pos: new THREE.Vector3(x + n.x * 0.3, 1.3, z + n.z * 0.3), yaw, room });
    const along = Math.abs(n.z) > 0.5;
    this.boxW(room, 'gunmetal', along ? [2.2, 2.6, 0.4] : [0.4, 2.6, 2.2], [x, 1.3, z], false);
    this.boxW(room, 'screen', along ? [1.6, 1.0, 0.05] : [0.05, 1.0, 1.6], [x + n.x * 0.23, 1.7, z + n.z * 0.23], false);
    this.boxW(room, 'vanta', along ? [2.2, 0.15, 0.42] : [0.42, 0.15, 2.2], [x, 2.65, z], false);
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

  /** Wall-mounted weapon added at runtime on a free wall spot (weapon rolled at random). */
  addWallBuy(spot: WallSpot): WallBuy {
    const weapon = RANDOM_WEAPONS[(Math.random() * RANDOM_WEAPONS.length) | 0];
    const wb: WallBuy = { weapon, cost: WEAPON_PRICES[weapon], pos: spot.pos.clone().setY(1.6), yaw: spot.yaw, room: spot.room };
    this.wallBuys.push(wb);
    return wb;
  }

  /**
   * Up to four free spots per room along its walls, clear of doors, lifts and
   * everything already placed. Reserved, so the decoration pass leaves them bare.
   */
  private collectWallSpots(): void {
    for (const room of ROOMS) {
      const R = room.id;
      const [x0, z0, x1, z1] = room.rect;
      const doorPts: THREE.Vector3[] = [];
      for (const l of LINKS) {
        if (l.a !== R && l.b !== R) continue;
        const o = ROOMS.find((r) => r.id === (l.a === R ? l.b : l.a))!;
        const vertical = room.rect[2] === o.rect[0] || room.rect[0] === o.rect[2];
        if (vertical) doorPts.push(new THREE.Vector3(room.rect[2] === o.rect[0] ? x1 : x0, 0, l.at));
        else doorPts.push(new THREE.Vector3(l.at, 0, room.rect[3] === o.rect[1] ? z1 : z0));
      }
      const clear = (x: number, z: number) => {
        for (const p of doorPts) if (Math.hypot(p.x - x, p.z - z) < 4) return false;
        for (const p of this.reserved) if (Math.hypot(p.x - x, p.z - z) < 3) return false;
        for (const sp of this.spawnPoints) if (Math.hypot(sp.pos.x - x, sp.pos.z - z) < 3) return false;
        return true;
      };
      const walls: [number, number, number, number, number, number][] = [
        [x0, z0, x1, z0, 0, 1], [x0, z1, x1, z1, 0, -1], [x0, z0, x0, z1, 1, 0], [x1, z0, x1, z1, -1, 0],
      ];
      const found: WallSpot[] = [];
      for (const [ax, az, cx, cz, nx, nz] of walls) {
        const len = Math.hypot(cx - ax, cz - az);
        const dx = (cx - ax) / len;
        const dz = (cz - az) / len;
        for (let s = 4 + Math.random() * 3; s < len - 4; s += 8 + Math.random() * 4) {
          const x = ax + dx * s + nx * 0.18;
          const z = az + dz * s + nz * 0.18;
          if (!clear(x, z)) continue;
          found.push({ pos: new THREE.Vector3(x, 0, z), yaw: Math.atan2(nx, nz), room: R, zone: room.zone });
        }
      }
      found.sort(() => Math.random() - 0.5);
      for (const sp of found.slice(0, 4)) {
        this.wallSpots.push(sp);
        this.reserved.push(sp.pos.clone());
      }
    }
  }

  private spawnAt(zone: string, pts: [number, number][], kind: SpawnPoint['kind'] = 'bay'): void {
    for (const [xd, zd] of pts) {
      const [x, z] = Wp(xd, zd);
      this.spawnPoints.push({ pos: new THREE.Vector3(x, 0, z), zone, kind });
    }
  }

  /**
   * Service lift set into a wall (yaw = direction it faces). Robots arrive in it:
   * a chime, the call light flashes, one steps out.
   */
  private serviceLift(room: string, xd: number, zd: number, yaw: number): void {
    const [x, z] = W(room, xd, zd);
    const zone = ROOMS.find((r) => r.id === room)!.zone;
    this.reserved.push(new THREE.Vector3(x, 0, z));
    const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const t = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const at = (o: number, y: number, d: number): V3 => [x + n.x * d + t.x * o, y, z + n.z * d + t.z * o];
    const sizeT = (a: number, h: number, b: number): V3 => (Math.abs(n.z) > 0.5 ? [a, h, b] : [b, h, a]);
    this.boxW(room, 'gunmetal', sizeT(3.2, 3.2, 0.1), at(0, 1.6, 0.05), false);
    this.boxW(room, 'dark', sizeT(2.5, 2.7, 0.04), at(0, 1.35, 0.07), false); // dark cab behind the doors
    this.boxW(room, 'yellow', sizeT(3.2, 0.12, 0.08), at(0, 3.25, 0.12), false);
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
      this.box(R, 'steel', [1.4, 2.2, 0.15], [34, 1.1, z - 0.6], true, undefined, METAL);
      this.box(R, 'steel', [1.4, 2.2, 0.15], [34, 1.1, z + 0.6], true, undefined, METAL);
      this.box(R, 'steel', [1.4, 0.15, 1.35], [34, 2.2, z], false);
    }
    for (const z of [58, 66, 74]) {
      this.glass(R, [0.08, 2.6, 6], [52, 1.3, z]);
      this.box(R, 'woodDark', [3, 0.8, 1.2], [58, 0.4, z]);
      this.box(R, 'screen', [1.4, 0.7, 0.05], [58, 1.25, z - 0.5], false);
    }
    // Holding cells (bars) in the south-east corner.
    for (let x = 54; x <= 64; x += 0.35) this.box(R, 'steel', [0.05, 3, 0.05], [x, 1.5, 79], false);
    this.physics.addStaticBox(new THREE.Vector3(...this.at(R, [59, 1.5, 79])), new THREE.Vector3(5.2 * kOf(R, 0), 1.5, 0.08), undefined, METAL);
    // Contractor terminal: hire a Vanta Security operator.
    this.terminals.push({ kind: 'ally', cost: 1500, pos: new THREE.Vector3(...this.at(R, [24, 1.3, 83.5])), yaw: Math.PI, room: R });
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
      this.box(R, 'steel', [0.04, 2.4, 2.6], [61, 1.2, z + 1.6], true, undefined, METAL); // bay divider
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
        this.clearBox(R, [0.05, 1.1, 46], [x - side * 1.5, y + 0.7, 23]);
        for (let z = 4; z < 44; z += 6) this.box(R, y < 10 ? 'lampWarm' : 'lampCool', [0.05, 2.2, 4], [side * 39.82, y + 1.6, z], false);
      }
      this.box(R, 'offwhite', [74, 0.35, 3], [0, y, -4.5], false);
      this.clearBox(R, [74, 1.1, 0.05], [0, y + 0.7, -3]);
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
  private atlas(R: string, xd: number, y: number, zd: number): void {
    const [x, z] = W(R, xd, zd);
    const s = 4.2;
    const b = (mat: string, size: V3, pos: V3) => this.boxW(R, mat, [size[0] * s, size[1] * s, size[2] * s], [x + pos[0] * s, y + pos[1] * s, z + pos[2] * s], false);
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
      this.box(R, 'dark', [3, 4, 0.6], [x, 2, -65.6], true, undefined, METAL);
      this.box(R, 'screenWarm', [2.2, 3.2, 0.05], [x, 2, -65.28], false);
    }
    for (let z = -58; z <= 6; z += 8) {
      this.box(R, 'dark', [0.6, 4, 3], [-109.6, 2, z], true, undefined, METAL);
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
    this.clearBox(R, [3.2, 1.2, 2.2], [-88, 4.6, 42.4]);
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
    for (let z = 33; z < 72; z += 2) this.box(R, z % 4 < 2 ? 'yellow' : 'dark', [0.08, 0.6, 1.2], [-109.35, 0.3, z], true, undefined, METAL);
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
    this.physics.addStaticBox(new THREE.Vector3(...this.at(R, [80, 1.5, 60])), new THREE.Vector3(10 * kOf(R, 0), 1.5, 0.08), undefined, METAL);
    for (const z of [68, 74, 80]) {
      this.box(R, 'woodDark', [1.2, 1.1, 2.4], [72, 0.55, z]);
      this.box(R, 'offwhite', [0.6, 1.6, 0.05], [106, 1.4, z]);
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

  // ---------------------------------------------------------------- set dressing

  /**
   * Second dressing pass for the big halls: things that tell you what the room is
   * for and break up the open floor (most of it doubles as cover). All built from
   * the rooms' own materials, so it merges into the existing per-room meshes:
   * no extra draw calls (phones stay fast).
   */
  private buildDressing(): void {
    // ---- Atrium: prototype display cases, low planter walls, info kiosks, floor inlays.
    const A = 'atrium';
    for (const [x, z] of [[-30, 30], [30, 14]]) {
      this.box(A, 'white', [3.2, 0.9, 2.2], [x, 0.45, z]);
      this.box(A, 'gunmetal', [3.3, 0.06, 2.3], [x, 0.92, z], false);
      this.clearBox(A, [3.0, 1.6, 2.0], [x, 1.75, z]);
      this.physics.addStaticBox(new THREE.Vector3(...this.at(A, [x, 1.75, z])), new THREE.Vector3(1.5, 0.8, 1.0), undefined, METAL);
      // A dormant prototype on the stand: legs, torso, head, visor.
      for (const s of [-1, 1]) this.box(A, 'dark', [0.2, 0.7, 0.22], [x + 0.18 * s, 1.3, z], false);
      this.box(A, 'white', [0.62, 0.55, 0.36], [x, 1.9, z], false);
      this.box(A, 'dark', [0.34, 0.3, 0.3], [x, 2.3, z], false);
      this.box(A, 'lampBlue', [0.26, 0.06, 0.02], [x, 2.32, z + 0.16], false);
      this.box(A, 'screen', [0.9, 0.3, 0.05], [x, 0.6, z + 1.13], false);
    }
    for (const x of [-12, 12]) {
      for (const z of [0, 46]) {
        this.box(A, 'offwhite', [5, 0.8, 1.1], [x, 0.4, z]);
        this.box(A, 'soil', [4.7, 0.05, 0.9], [x, 0.82, z], false);
        for (const dx of [-1.6, 0, 1.6]) this.box(A, dx === 0 ? 'leaf' : 'leafDark', [0.9, 0.6, 0.6], [x + dx, 1.15, z], false);
      }
    }
    for (const [x, z] of [[-34, 46], [34, 2]]) {
      this.box(A, 'white', [0.8, 1.3, 0.8], [x, 0.65, z]);
      this.box(A, 'screen', [0.05, 0.7, 0.6], [x + (x < 0 ? 0.43 : -0.43), 1.0, z], false);
    }
    for (const z of [2, 42]) this.box(A, 'gunmetal', [64, 0.02, 0.25], [0, 0.012, z], false);
    for (const x of [-26, 26]) this.box(A, 'gunmetal', [0.25, 0.02, 30], [x, 0.012, 22], false);

    // ---- Assembly hall: robot-part racks along the north wall, tool carts, crate cover, walkway lines.
    const M = 'assembly';
    for (const x of [-100, -74, -62]) {
      this.box(M, 'gunmetal', [5, 0.1, 1.2], [x, 0.05, 8]);
      for (const y of [0.9, 1.9, 2.9]) this.box(M, 'gunmetal', [5, 0.06, 1.2], [x, y, 8], false);
      for (const dx of [-2.45, 2.45]) this.box(M, 'yellow', [0.1, 3.2, 1.2], [x + dx, 1.6, 8], true, undefined);
      // The rack itself (shelves and parts are visual only): one collider for its body.
      const rc = this.at(M, [x, 1.5, 8]);
      const rs = this.sz(M, [5, 3, 1.2]);
      this.physics.addStaticBox(new THREE.Vector3(...rc), new THREE.Vector3(rs[0] / 2, rs[1] / 2, rs[2] / 2), undefined, METAL);
      for (let i = 0; i < 4; i++) {
        this.box(M, 'white', [0.55, 0.45, 0.4], [x - 1.8 + i * 1.2, 1.2, 8], false); // torso shells
        this.box(M, 'dark', [0.35, 0.3, 0.3], [x - 1.8 + i * 1.2, 2.13, 8], false); // heads
        this.box(M, 'lampBlue', [0.24, 0.05, 0.02], [x - 1.8 + i * 1.2, 2.16, 8.16], false);
        this.box(M, 'gunmetal', [0.16, 0.7, 0.16], [x - 1.6 + i * 1.2, 3.2, 8], false); // limbs
      }
    }
    for (const [x, z] of [[-90, -16], [-70, -36], [-56, -16], [-98, -36]]) {
      this.box(M, 'vanta', [1.2, 0.9, 0.7], [x, 0.55, z]);
      this.box(M, 'gunmetal', [1.25, 0.06, 0.75], [x, 1.02, z], false);
      for (const dy of [0.3, 0.6]) this.box(M, 'dark', [1.0, 0.03, 0.02], [x, dy + 0.3, z + 0.36], false);
    }
    for (const [x, z] of [[-70, -56], [-90, -56], [-50, -56]]) {
      this.box(M, 'contGreen', [1.6, 1.4, 1.4], [x, 0.7, z]);
      this.box(M, 'wood', [1.2, 1.0, 1.2], [x + 0.2, 1.9, z], false);
    }
    for (const z of [-16, -36]) this.box(M, 'yellow', [62, 0.02, 0.2], [-75, 0.012, z], false);

    // ---- Hangar: forklift, tool chests, drum cluster, tow tug, floor markings.
    const H = 'hangar';
    this.box(H, 'yellow', [1.3, 1.2, 2.4], [-76, 0.8, 70], true, undefined, METAL);
    this.box(H, 'dark', [1.1, 0.9, 0.9], [-76, 1.8, 70.6], false);
    for (const dx of [-0.45, 0.45]) this.box(H, 'gunmetal', [0.12, 3.0, 0.12], [-76 + dx, 1.5, 68.7], false);
    this.box(H, 'gunmetal', [1.1, 0.08, 1.2], [-76, 0.2, 68.0], false);
    for (const dz of [-1.0, 1.0]) for (const dx of [-0.7, 0.7]) this.cyl(H, 'tire', 0.3, 0.25, [-76 + dx, 0.3, 70 + dz], false, [0, 0, Math.PI / 2], 10);
    for (const z of [40, 44, 48]) {
      this.box(H, 'vanta', [0.8, 1.1, 1.6], [-67.5, 0.55, z]);
      for (const y of [0.3, 0.55, 0.8]) this.box(H, 'gunmetal', [0.02, 0.03, 1.4], [-67.9, y, z], false);
    }
    for (const [dx, dz] of [[0, 0], [0.7, 0.3], [-0.5, 0.6], [0.3, -0.7], [-0.7, -0.3]]) this.cyl(H, dx > 0 ? 'vanta' : 'contBlue', 0.3, 0.9, [-100 + dx, 0.45, 64 + dz], true, [0, 0, 0], 12);
    this.box(H, 'yellow', [1.4, 0.8, 2.2], [-82, 0.55, 36], true, undefined, METAL);
    this.box(H, 'dark', [1.2, 0.5, 0.8], [-82, 1.2, 35.6], false);
    for (const z of [30, 64]) this.box(H, 'yellow', [36, 0.02, 0.25], [-88, 0.012, z], false);

    // ---- Server hall: cooling units, ops desk cluster, floor grates around the core, gear crates.
    const S = 'servers';
    for (const z of [-50, -10]) {
      this.box(S, 'offwhite', [1.0, 2.2, 3.0], [108.6, 1.1, z]);
      for (let i = 0; i < 6; i++) this.box(S, 'dark', [0.02, 0.06, 2.6], [108.08, 0.5 + i * 0.25, z], false);
    }
    for (const dx of [-1.6, 1.6]) {
      this.box(S, 'dark', [2.8, 0.75, 1.0], [96 + dx, 0.375, 4]);
      this.box(S, 'screen', [0.9, 0.55, 0.05], [96 + dx - 0.5, 1.05, 3.65], false);
      this.box(S, 'screen', [0.9, 0.55, 0.05], [96 + dx + 0.5, 1.05, 3.65], false);
    }
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      this.box(S, 'dark', [1.6, 0.02, 1.6], [88 + Math.cos(ang) * 6.5, 0.012, -26 + Math.sin(ang) * 6.5], false, [0, -ang, 0]);
    }
    for (const [x, z] of [[78, -50], [80, 0], [100, -40]]) {
      this.box(S, 'dark', [1.2, 1.8, 0.8], [x, 0.9, z], true, undefined, METAL);
      this.box(S, 'leds', [0.05, 0.05, 0.02], [x - 0.3, 1.5, z + 0.41], false);
    }

    // ---- Barracks: mess tables with benches, gym corner, locker rows.
    const B = 'barracks';
    for (const z of [26, 40]) {
      this.box(B, 'woodDark', [6, 0.08, 1.1], [86, 0.76, z]);
      for (const dx of [-2.6, 2.6]) this.box(B, 'gunmetal', [0.1, 0.72, 0.9], [86 + dx, 0.36, z], false);
      for (const dz of [-0.85, 0.85]) this.box(B, 'woodDark', [6, 0.06, 0.35], [86, 0.45, z + dz]);
    }
    this.box(B, 'dark', [1.6, 0.45, 0.4], [76, 0.3, 50]);
    this.box(B, 'gunmetal', [0.08, 1.8, 0.08], [75, 0.9, 49.5], false);
    this.box(B, 'gunmetal', [0.08, 1.8, 0.08], [77, 0.9, 49.5], false);
    this.box(B, 'steel', [2.4, 0.05, 0.05], [76, 1.6, 49.5], false);
    for (const dx of [-1.25, 1.25]) this.cyl(B, 'dark', 0.22, 0.08, [76 + dx, 1.6, 49.5], false, [0, 0, Math.PI / 2], 12);
    for (const [z0, z1] of [[20, 28], [38, 46]]) {
      for (let z = z0; z <= z1; z += 0.8) {
        this.box(B, 'gunmetal', [0.5, 1.9, 0.75], [66.6, 0.95, z]);
        this.box(B, 'dark', [0.02, 0.2, 0.05], [66.86, 1.5, z + 0.25], false);
      }
    }

    // ---- Power plant: control consoles, valve wheels, pipe bundles on the south wall.
    const P = 'power';
    for (const x of [-10, 10]) {
      this.box(P, 'gunmetal', [3.4, 1.0, 0.9], [x, 0.5, -68.4]);
      this.box(P, 'screenWarm', [1.2, 0.5, 0.05], [x - 0.8, 1.35, -68.05], false, [-0.4, 0, 0]);
      this.box(P, 'screen', [1.2, 0.5, 0.05], [x + 0.8, 1.35, -68.05], false, [-0.4, 0, 0]);
      for (let i = 0; i < 5; i++) this.box(P, i % 2 ? 'lampRed' : 'leds', [0.06, 0.06, 0.02], [x - 1.2 + i * 0.6, 1.02, -67.95], false);
    }
    for (const x of [-34, -18, 18, 34]) {
      for (const y of [1.2, 2.0, 2.8]) this.cyl(P, 'steel', 0.18, 6, [x, y, -85.3], y < 2, [0, 0, Math.PI / 2], 10);
      this.cyl(P, 'vanta', 0.32, 0.05, [x + 3.2, 2.0, -84.9], false, [Math.PI / 2, 0, 0], 16);
    }
  }

  /**
   * Fills every room with style-appropriate detail: wall fixtures along each wall
   * (extinguishers, vents, sconces, posters, panels, cameras, pipes), ceiling
   * services (ducts, cable trays, pipe runs, grilles) and floor clutter in corners
   * (crates, pallets, bins, cones). Keeps clear of doors and gameplay objects.
   */
  private buildDetails(): void {
    const industrial = new Set(['factory', 'hangar', 'servers', 'barracks']);
    const extra = {
      red: new THREE.MeshStandardMaterial({ color: 0xb3221a, roughness: 0.45, metalness: 0.2 }),
      green: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x2bdc6a, emissiveIntensity: 1.8 }),
      poster: [0x3b5a7a, 0xa3171a, 0x2f5e46, 0xc9a23a, 0x4a4a52].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })),
      paper: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.9 }),
      cone: new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 }),
      pallet: new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 }),
    };
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    for (const room of ROOMS) {
      if (room.sky) continue;
      const R = room.id;
      const style = room.style;
      const ind = industrial.has(style);
      const [x0, z0, x1, z1] = room.rect;
      const h = room.h;
      const b = this.room(R).b;
      const ceil = this.room(R).ceil;
      const mat = (k: string) => this.mats[k];
      // Door centres on this room's walls (keep fixtures off them).
      const doorPts: THREE.Vector3[] = [];
      for (const l of LINKS) {
        if (l.a !== R && l.b !== R) continue;
        const o = ROOMS.find((r) => r.id === (l.a === R ? l.b : l.a))!;
        const vertical = room.rect[2] === o.rect[0] || room.rect[0] === o.rect[2];
        if (vertical) doorPts.push(new THREE.Vector3(room.rect[2] === o.rect[0] ? x1 : x0, 0, l.at));
        else doorPts.push(new THREE.Vector3(l.at, 0, room.rect[3] === o.rect[1] ? z1 : z0));
      }
      const clear = (x: number, z: number, r: number) => {
        for (const p of doorPts) if (Math.hypot(p.x - x, p.z - z) < r + 2.6) return false;
        for (const p of this.reserved) if (Math.hypot(p.x - x, p.z - z) < r + 1.8) return false;
        for (const sp of this.spawnPoints) if (Math.hypot(sp.pos.x - x, sp.pos.z - z) < r + 1.6) return false;
        return true;
      };
      // Walls: (start, end, inward normal).
      const walls: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
        [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(0, 0, 1)],
        [new THREE.Vector3(x0, 0, z1), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(0, 0, -1)],
        [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x0, 0, z1), new THREE.Vector3(1, 0, 0)],
        [new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(-1, 0, 0)],
      ];
      for (const [a, c, n] of walls) {
        const len = a.distanceTo(c);
        const dir = c.clone().sub(a).normalize();
        const step = ind ? 7 : 6;
        const yaw = Math.atan2(n.x, n.z);
        const along = Math.abs(n.z) > 0.5;
        const sz = (w: number, hh: number, d: number): V3 => (along ? [w, hh, d] : [d, hh, w]);
        for (let s = 2.5 + Math.random() * 2; s < len - 2; s += step + rnd(-1.5, 1.5)) {
          const x = a.x + dir.x * s;
          const z = a.z + dir.z * s;
          if (!clear(x, z, 0.6)) continue;
          const at = (off: number, y: number): V3 => [x + n.x * off, y, z + n.z * off];
          const pick = Math.random();
          if (pick < 0.22) {
            // Fire extinguisher on a bracket + sign above.
            b.cylinder(extra.red, 0.09, 0.55, at(0.14, 0.95), [0, 0, 0], 10);
            b.cylinder(mat('dark'), 0.05, 0.08, at(0.14, 1.27), [0, 0, 0], 8);
            b.box(mat('gunmetal'), sz(0.22, 0.06, 0.08), at(0.06, 1.05));
            b.box(extra.red, sz(0.3, 0.3, 0.02), at(0.02, 1.75));
          } else if (pick < 0.4) {
            // Wall vent grille.
            const vy = rnd(0.4, h - 1.2);
            b.box(mat('gunmetal'), sz(0.8, 0.5, 0.05), at(0.03, vy));
            for (let k = -2; k <= 2; k++) b.box(mat('dark'), sz(0.72, 0.03, 0.06), at(0.04, vy + k * 0.08));
          } else if (pick < 0.58) {
            // Electrical panel / junction box with conduit up to the ceiling.
            b.box(mat('offwhite'), sz(0.6, 0.8, 0.18), at(0.09, 1.5));
            b.box(mat('dark'), sz(0.5, 0.06, 0.19), at(0.1, 1.82));
            b.cylinder(mat('gunmetal'), 0.03, h - 1.9, at(0.05, 1.9 + (h - 1.9) / 2), [0, 0, 0], 6);
          } else if (pick < 0.76 && !ind) {
            // Framed poster / notice board.
            const p = extra.poster[(Math.random() * extra.poster.length) | 0];
            b.box(mat('dark'), sz(1.0, 1.4, 0.03), at(0.015, 1.7));
            b.box(p, sz(0.9, 1.3, 0.02), at(0.03, 1.7));
            b.box(extra.paper, sz(0.6, 0.25, 0.01), at(0.042, 1.9));
          } else if (pick < 0.76) {
            // Industrial: vertical pipe pair with clamps.
            for (const o of [-0.18, 0.18]) {
              const px = x + dir.x * o + n.x * 0.12;
              const pz = z + dir.z * o + n.z * 0.12;
              b.cylinder(mat('steel'), 0.07, h, [px, h / 2, pz], [0, 0, 0], 8);
              for (const cy of [1, 2.5, 4]) if (cy < h) b.box(mat('dark'), sz(0.18, 0.06, 0.18), [px, cy, pz]);
            }
          } else {
            // Wall light (sconce) + a small exit-style sign on some.
            b.box(mat('gunmetal'), sz(0.5, 0.12, 0.14), at(0.07, h - 0.9));
            b.box(ind ? mat('lampWarm') : mat('lampCool'), sz(0.42, 0.04, 0.1), at(0.09, h - 0.97));
            if (Math.random() < 0.3) b.box(extra.green, sz(0.36, 0.16, 0.03), at(0.03, h - 0.5));
          }
        }
        // Security camera in one corner per wall.
        if (Math.random() < 0.5) {
          const s = Math.random() < 0.5 ? 1.2 : len - 1.2;
          const x = a.x + dir.x * s + n.x * 0.25;
          const z = a.z + dir.z * s + n.z * 0.25;
          b.box(mat('offwhite'), [0.14, 0.12, 0.3], [x, h - 0.45, z], [0.3, yaw, 0]);
          b.box(mat('dark'), [0.06, 0.25, 0.06], [x, h - 0.25, z]);
          b.box(mat('lampRed'), [0.03, 0.03, 0.03], [x + n.x * 0.12, h - 0.42, z + n.z * 0.12]);
        }
      }
      // Emergency lights (dark until the power fails).
      for (const z of [z0 + 0.2, z1 - 0.2]) b.box(this.emergency, [1.2, 0.1, 0.08], [(x0 + x1) / 2, h - 0.35, z]);
      for (const x of [x0 + 0.2, x1 - 0.2]) b.box(this.emergency, [0.08, 0.1, 1.2], [x, h - 0.35, (z0 + z1) / 2]);
      // Where the red emergency light pools come from (a little in from each strip).
      for (const z of [z0 + 0.9, z1 - 0.9]) this.emergencySpots.push(new THREE.Vector3((x0 + x1) / 2, h - 0.6, z));
      for (const x of [x0 + 0.9, x1 - 0.9]) this.emergencySpots.push(new THREE.Vector3(x, h - 0.6, (z0 + z1) / 2));
      // Ceiling services.
      const longX = x1 - x0 >= z1 - z0;
      if (ind && !room.skylight) {
        // Big rectangular duct + cable tray + pipe bundle along the long axis.
        const span = longX ? x1 - x0 - 2 : z1 - z0 - 2;
        for (const [off, kind] of [[0.25, 'duct'], [0.55, 'tray'], [0.78, 'pipes']] as const) {
          const cx = longX ? (x0 + x1) / 2 : x0 + (x1 - x0) * off;
          const cz = longX ? z0 + (z1 - z0) * off : (z0 + z1) / 2;
          if (kind === 'duct') {
            ceil.box(mat('steel'), longX ? [span, 0.7, 1.0] : [1.0, 0.7, span], [cx, h - 0.75, cz]);
            for (let k = -span / 2 + 2; k < span / 2; k += 4) ceil.box(mat('gunmetal'), longX ? [0.08, 0.76, 1.06] : [1.06, 0.76, 0.08], [longX ? cx + k : cx, h - 0.75, longX ? cz : cz + k]);
          } else if (kind === 'tray') {
            ceil.box(mat('gunmetal'), longX ? [span, 0.08, 0.6] : [0.6, 0.08, span], [cx, h - 0.55, cz]);
            ceil.box(mat('yellow'), longX ? [span, 0.06, 0.12] : [0.12, 0.06, span], [cx, h - 0.48, cz + (longX ? 0.15 : 0)]);
            ceil.box(mat('dark'), longX ? [span, 0.06, 0.14] : [0.14, 0.06, span], [cx, h - 0.48, cz - (longX ? 0.12 : 0)]);
          } else {
            for (const o of [-0.25, 0, 0.25]) {
              ceil.cylinder(o === 0 ? extra.red : mat('steel'), 0.09, span, [longX ? cx : cx + o, h - 0.4, longX ? cz + o : cz], longX ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0], 8);
            }
          }
        }
        // Floor: painted walkway lines 1.2 m inside the walls.
        for (const z of [z0 + 1.2, z1 - 1.2]) b.box(mat('yellow'), [x1 - x0 - 2.4, 0.02, 0.1], [(x0 + x1) / 2, 0.025, z]);
        for (const x of [x0 + 1.2, x1 - 1.2]) b.box(mat('yellow'), [0.1, 0.02, z1 - z0 - 2.4], [x, 0.025, (z0 + z1) / 2]);
      } else if (!room.skylight) {
        // Office ceiling: return-air grilles and smoke detectors between the lamps.
        for (let x = x0 + 4; x < x1 - 2; x += 8) {
          for (let z = z0 + 4; z < z1 - 2; z += 8) {
            ceil.box(mat('offwhite'), [0.6, 0.03, 0.6], [x + 3, h - 0.02, z + 3]);
            ceil.box(mat('grey'), [0.5, 0.035, 0.05], [x + 3, h - 0.03, z + 3]);
            ceil.cylinder(mat('white'), 0.07, 0.04, [x, h - 0.03, z + 2], [0, 0, 0], 10);
          }
        }
      }
      // Corner clutter (never in a doorway).
      const corners: [number, number, number, number][] = [[x0 + 1.4, z0 + 1.4, 1, 1], [x1 - 1.4, z0 + 1.4, -1, 1], [x0 + 1.4, z1 - 1.4, 1, -1], [x1 - 1.4, z1 - 1.4, -1, -1]];
      for (const [cx, cz, sx, sz] of corners) {
        if (Math.random() < 0.35 || !clear(cx, cz, 1.2)) continue;
        if (ind) {
          // Pallet with stacked crates, maybe a cone.
          this.boxW(R, 'woodDark', [1.2, 0.14, 1.0], [cx, 0.07, cz], true);
          this.boxW(R, Math.random() < 0.5 ? 'contGreen' : 'contBlue', [1.0, 0.8, 0.8], [cx, 0.54, cz], true);
          if (Math.random() < 0.6) this.boxW(R, 'wood', [0.7, 0.55, 0.6], [cx + sx * 0.1, 1.22, cz + sz * 0.05], false, [0, rnd(-0.3, 0.3), 0]);
          if (Math.random() < 0.5) b.add(extra.cone, new THREE.ConeGeometry(0.16, 0.5, 10), [cx + sx * 1.0, 0.25, cz + sz * 0.3]);
        } else {
          // Bin + a potted plant or a water cooler.
          this.cylW(R, 'gunmetal', 0.22, 0.55, [cx, 0.275, cz], true, [0, 0, 0], 10);
          if (Math.random() < 0.5) {
            this.cylW(R, 'white', 0.3, 0.6, [cx + sx * 0.9, 0.3, cz + sz * 0.1], true, [0, 0, 0], 12);
            b.add(mat('leaf'), new THREE.IcosahedronGeometry(0.45, 1), [cx + sx * 0.9, 0.95, cz + sz * 0.1]);
          } else {
            this.boxW(R, 'white', [0.36, 1.0, 0.36], [cx + sx * 0.9, 0.5, cz + sz * 0.1], true);
            b.cylinder(this.mats.glass, 0.15, 0.4, [cx + sx * 0.9, 1.2, cz + sz * 0.1], [0, 0, 0], 10);
          }
        }
      }
    }
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
    logo.position.set(...this.at('lobby', [0, 5.1, 83.82]));
    logo.rotation.y = Math.PI;
    this.room('lobby').group.add(logo);
  }

  private placeProps(): void {
    const p = this.props;
    const v = (x: number, y: number, z: number) => {
      const [wx, wz] = Wp(x, z);
      return new THREE.Vector3(wx, y, wz);
    };
    p.stack(v(-96, 0, 8), 4, 0.6);
    p.barrel(v(-62, 0.45, 10));
    p.barrel(v(-61, 0.45, 11), true);
    p.cube(v(-80, 0.5, 80), 1, 0.3);
    p.cube(v(-79, 0.5, 78.6), 1, 0.7, true);
    p.barrel(v(100, 0.45, -70));
    p.barrel(v(62, 0.45, 82));
    p.stack(v(-46, 0, -84), 3, 0.5);
  }

  /** The room group an object at (x, z) belongs to (for visibility culling). */
  roomGroupAt(x: number, z: number): THREE.Object3D {
    const r = this.layout.roomAt(x, z);
    return r ? this.layout.rooms.get(r.id)!.group : this.group;
  }

  private visibleRooms = new Set<string>();
  private viewDepth = 3;
  private viewFar = Infinity;

  /** Graphics → view distance: how many rooms deep to draw, and how far past your neighbours. */
  setViewDepth(rooms: number, far: number): void {
    this.viewDepth = rooms;
    this.viewFar = far;
  }

  /**
   * Cheap portal culling: draw the room you're in plus rooms seen through open
   * links (archways, opened shutters), up to 3 rooms deep. Closed shutters block.
   */
  updateVisibility(x: number, z: number, isOpen: (l: LinkDef) => boolean): void {
    const here = this.layout.roomAt(x, z);
    if (!here) return;
    const seen = new Set<string>([here.id]);
    let frontier = [here.id];
    // Short view distance: fewer rooms deep, and rooms past your neighbours only within `far`.
    const maxDepth = this.viewDepth;
    const far = this.viewFar;
    for (let depth = 0; depth < maxDepth; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const l of LINKS) {
          const other = l.a === id ? l.b : l.b === id ? l.a : null;
          if (!other || seen.has(other)) continue;
          if (l.kind === 'buy' && !isOpen(l)) continue;
          if (depth > 0) {
            const r = ROOM_OF.get(other)!.rect;
            const dx = Math.max(r[0] - x, 0, x - r[2]);
            const dz = Math.max(r[1] - z, 0, z - r[3]);
            if (dx * dx + dz * dz > far * far) continue;
          }
          seen.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    this.visibleRooms = seen;
    for (const [id, room] of this.layout.rooms) room.group.visible = seen.has(id);
  }

  /** Is (x, z) in a room currently being drawn? (Characters in hidden rooms skip rendering.) */
  isVisibleAt(x: number, z: number): boolean {
    const r = this.layout.roomAt(x, z);
    return !r || this.visibleRooms.has(r.id);
  }

  /**
   * Power failure (Black Division raid): lamps and screens die, ambient falls to a
   * dim red, emergency strips pulse. k: 0 = normal .. 1 = full blackout.
   */
  setBlackout(k: number): void {
    this.blackout = k;
    this.hemi.intensity = this.ambient + (0.1 - this.ambient) * k;
    // Blacked out: the last of the fill is a faint red (the emergency strips).
    this.hemi.color.setRGB(0.77 + 0.2 * k, 0.82 - 0.65 * k, 0.88 - 0.72 * k);
    this.hemi.groundColor.setRGB(0.23 - 0.13 * k, 0.21 - 0.18 * k, 0.19 - 0.17 * k);
    this.sun.intensity = SUN * (1 - 0.8 * k);
    for (const [m, base] of this.lampBase) m.emissiveIntensity = base * (1 - 0.97 * k);
    for (const p of this.pools.values()) (p as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - k);
    // The reactor and the data core run on their own supply: dimmed, not dead.
    for (const [l, base] of this.accents) l.intensity = base * (1 - 0.7 * k);
  }

  /** Emergency lamp pulse 0.06..1 (strips and their lights beat together). */
  get emergencyPulse(): number {
    return 0.53 + 0.47 * Math.sin(this.time * 4);
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
    this.emergency.emissiveIntensity = this.blackout > 0.05 ? this.blackout * 3 * this.emergencyPulse : 0;
    // Broken lamps: dead most of the time, stuttering back on in bursts.
    const t = this.time;
    const burst = Math.sin(t * 0.9) * Math.sin(t * 2.3 + 1.3) > 0.2;
    const on = burst ? (Math.sin(t * 61) * Math.sin(t * 23) > -0.35 ? 1 : 0.08) : Math.sin(t * 37) > 0.985 ? 0.7 : 0.03;
    this.brokenLevel = on * (1 - this.blackout);
    this.brokenLampMat.emissiveIntensity = 0.02 + 2.6 * this.brokenLevel;
    this.brokenPool.opacity = 0.42 * this.brokenLevel;
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
