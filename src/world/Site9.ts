import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { MeshBuilder } from './MeshBuilder';
import { PhysicsProps } from './PhysicsProps';
import { corrugatedTexture, gridTexture } from '../fx/Textures';
import type { RobotOptions } from '../targets/RobotTarget';
import type { GameMap, SquadSpawn, Station } from './GameMap';

type V3 = [number, number, number];
type Door = [center: number, width: number, height?: number];

const METAL: HitReceiver = { surface: 'metal', allowDecals: true };
const T = 0.3; // wall thickness
const H = 4; // room height
const HALL_H = 9;
const DOOR_H = 2.7;

/**
 * Site-9: Vanta Dynamics' underground robotics facility (single level).
 *
 *   Centre      assembly hall (9 m tall): conveyor lines, gantries, dormant robots,
 *               raised glass control booth (stairs on the east side)
 *   Ring        4 m corridor around the hall
 *   North       lift lobby (player spawn) + security checkpoint, canteen,
 *               Black Division barracks
 *   East        R&D offices, server hall, clean lab, director's office
 *   South       robot test cells (glass fronts), generator room
 *   West        garage (vehicle gate), logistics warehouse (cargo lift)
 *
 * x: -56..56, z: -42..42. Ceilings don't cast shadows, so the overhead key light
 * gives soft "ceiling light" shadows under objects.
 */
export class Site9 implements GameMap {
  readonly name = 'Site-9';
  readonly group = new THREE.Group();
  readonly props: PhysicsProps;
  readonly spawn = new THREE.Vector3(0, 0, -38);
  readonly spawnYaw = Math.PI;
  readonly robotSpawns: RobotOptions[] = [];
  readonly squads: SquadSpawn[];
  readonly navBounds: [number, number, number, number] = [-56, -42, 56, 42];
  readonly sun: THREE.DirectionalLight;
  readonly skyColor = 0x0d0e10;
  readonly stations: Station[] = [
    { name: 'Lift lobby (spawn)', pos: [0, 0, -38], yaw: Math.PI },
    { name: 'Assembly hall', pos: [-14, 0, 12], yaw: -Math.PI / 4 },
    { name: 'Control booth (raised)', pos: [-3, 3.25, -14.5], yaw: Math.PI },
    { name: 'Garage', pos: [-34, 0, -30], yaw: Math.PI * 0.5 },
    { name: 'Warehouse', pos: [-30, 0, 30], yaw: Math.PI * 0.5 },
    { name: 'Server hall', pos: [27, 0, 5], yaw: -Math.PI * 0.5 },
    { name: 'Test cells', pos: [-8, 0, 23], yaw: Math.PI },
    { name: 'Black Division barracks', pos: [12, 0, -24], yaw: 0 },
  ];

  private b = new MeshBuilder(true);
  private ceil = new MeshBuilder(true);
  private clear = new MeshBuilder(false);
  private mats: Record<string, THREE.Material>;
  private serverLeds: THREE.MeshStandardMaterial;
  private time = 0;

  constructor(private physics: Physics, mobile: boolean) {
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    this.serverLeds = std({ color: 0x000000, emissive: 0x38ff8a, emissiveIntensity: 2 });
    this.mats = {
      floor: std({ map: gridTexture('#3a3d42', '#2f3236', '#36393d'), roughness: 0.55, metalness: 0.1 }),
      floorHall: std({ map: gridTexture('#4a4d52', '#3a3d41', '#45484c'), roughness: 0.6, metalness: 0.15 }),
      wall: std({ map: gridTexture('#d3d6da', '#b7bbc0', '#c9cdd1'), roughness: 0.75 }),
      wallHall: std({ map: gridTexture('#8a8e94', '#6c7075', '#7e8288'), roughness: 0.85 }),
      wallDark: std({ map: gridTexture('#2c2f33', '#232528', '#2a2c30'), roughness: 0.8 }),
      concrete: std({ map: gridTexture('#62666d', '#4e5157', '#5a5e64'), roughness: 0.88 }),
      ceiling: std({ color: 0x24272b, roughness: 1 }),
      metal: std({ color: 0x4a5058, metalness: 0.85, roughness: 0.35 }),
      darkMetal: std({ color: 0x23262a, metalness: 0.8, roughness: 0.4 }),
      accent: std({ color: 0xd9a21b, roughness: 0.6 }),
      stripe: std({ color: 0xe8e8e8, roughness: 0.7 }),
      vanta: std({ color: 0x9a1612, roughness: 0.6 }),
      lamp: std({ color: 0x000000, emissive: 0xf2f6ff, emissiveIntensity: 2.6 }),
      lampWarm: std({ color: 0x000000, emissive: 0xffd9a8, emissiveIntensity: 2.4 }),
      lampRed: std({ color: 0x000000, emissive: 0xff2a1a, emissiveIntensity: 2.2 }),
      screen: std({ color: 0x000000, emissive: 0x3aa0ff, emissiveIntensity: 1.4 }),
      leds: this.serverLeds,
      glass: std({ color: 0x9fc6d8, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.2, depthWrite: false }),
      wood: std({ color: 0x6b4f36, roughness: 0.8 }),
      fabric: std({ color: 0x2f3f52, roughness: 0.95 }),
      contGreen: std({ map: corrugatedTexture('#2f3a2d'), roughness: 0.7, metalness: 0.35 }),
      carRed: std({ color: 0x5a1a16, metalness: 0.6, roughness: 0.35 }),
      carGrey: std({ color: 0x3b3f45, metalness: 0.6, roughness: 0.35 }),
      tire: std({ color: 0x121212, roughness: 0.9 }),
    };

    this.buildShell();
    this.buildHall();
    this.buildRing();
    this.buildNorth();
    this.buildEast();
    this.buildSouth();
    this.buildWest();
    this.buildSigns();
    this.b.build(this.group);
    this.ceil.build(this.group, { castShadow: false, receiveShadow: true });
    this.clear.build(this.group, { castShadow: false, receiveShadow: false });

    this.props = new PhysicsProps(physics);
    this.group.add(this.props.group);
    this.placeProps();
    this.placeRobots();
    this.squads = this.buildSquads();

    // --- Lighting: cool overhead fill + a key light from above (ceilings don't
    // cast), a few practical point lights for colour and contrast. ---
    this.group.add(new THREE.HemisphereLight(0xe6edf5, 0x3a3d42, 1.15));
    const sun = new THREE.DirectionalLight(0xf4f7ff, 1.5);
    sun.position.set(6, 30, 4);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const cam = sun.shadow.camera;
    cam.left = -60;
    cam.right = 60;
    cam.top = 46;
    cam.bottom = -46;
    cam.near = 5;
    cam.far = 50;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    this.group.add(sun, sun.target);
    this.sun = sun;
    const point = (color: number, intensity: number, dist: number, pos: V3) => {
      const l = new THREE.PointLight(color, intensity, dist, 2);
      l.position.set(...pos);
      this.group.add(l);
    };
    point(0xfff1e0, 70, 26, [-10, 7.5, 0]);
    point(0xfff1e0, 70, 26, [10, 7.5, 0]);
    if (!mobile) {
      point(0x5aa8ff, 26, 16, [40, 3.4, 5]); // server hall
      point(0xff3a20, 18, 14, [16, 3.4, -31]); // barracks
      point(0xffb060, 26, 16, [16, 3.4, 31]); // generator
      point(0xffd9a8, 30, 22, [-40, 3.5, -16]); // garage
    }
  }

  // ---------------------------------------------------------------- helpers

  private solid(mat: string, size: V3, pos: V3, receiver?: HitReceiver, rot?: V3, builder = this.b): void {
    builder.box(this.mats[mat], size, pos, rot);
    const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)) : undefined;
    this.physics.addStaticBox(new THREE.Vector3(...pos), new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2), q, receiver);
  }

  private detail(mat: string, size: V3, pos: V3, rot?: V3, builder = this.b): void {
    builder.box(this.mats[mat], size, pos, rot);
  }

  /** Wall along X at `z`, with door openings (centre, width[, height]). */
  private wallX(z: number, x0: number, x1: number, h: number, mat: string, doors: Door[] = []): void {
    let x = x0;
    for (const [c, w, dh = DOOR_H] of [...doors].sort((a, b) => a[0] - b[0])) {
      const a = c - w / 2;
      const b = c + w / 2;
      if (a > x) this.solid(mat, [a - x, h, T], [(a + x) / 2, h / 2, z]);
      if (h > dh) this.solid(mat, [w, h - dh, T], [c, (h + dh) / 2, z]);
      this.detail('darkMetal', [0.08, dh, T + 0.04], [a + 0.04, dh / 2, z]);
      this.detail('darkMetal', [0.08, dh, T + 0.04], [b - 0.04, dh / 2, z]);
      x = b;
    }
    if (x1 > x) this.solid(mat, [x1 - x, h, T], [(x1 + x) / 2, h / 2, z]);
  }

  /** Wall along Z at `x`, with door openings. */
  private wallZ(x: number, z0: number, z1: number, h: number, mat: string, doors: Door[] = []): void {
    let z = z0;
    for (const [c, w, dh = DOOR_H] of [...doors].sort((a, b) => a[0] - b[0])) {
      const a = c - w / 2;
      const b = c + w / 2;
      if (a > z) this.solid(mat, [T, h, a - z], [x, h / 2, (a + z) / 2]);
      if (h > dh) this.solid(mat, [T, h - dh, w], [x, (h + dh) / 2, c]);
      this.detail('darkMetal', [T + 0.04, dh, 0.08], [x, dh / 2, a + 0.04]);
      this.detail('darkMetal', [T + 0.04, dh, 0.08], [x, dh / 2, b - 0.04]);
      z = b;
    }
    if (z1 > z) this.solid(mat, [T, h, z1 - z], [x, h / 2, (z1 + z) / 2]);
  }

  /** Bulletproof glass pane with a thin frame. */
  private glass(size: V3, pos: V3): void {
    this.solid('glass', size, pos, METAL, undefined, this.clear);
    const vertical = size[0] < size[2];
    const len = vertical ? size[2] : size[0];
    for (const s of [-1, 1]) {
      const o = (len / 2) * s;
      this.detail('darkMetal', vertical ? [0.08, size[1], 0.08] : [0.08, size[1], 0.08], vertical ? [pos[0], pos[1], pos[2] + o] : [pos[0] + o, pos[1], pos[2]]);
    }
    this.detail('darkMetal', vertical ? [0.08, 0.08, len] : [len, 0.08, 0.08], [pos[0], pos[1] + size[1] / 2, pos[2]]);
    this.detail('darkMetal', vertical ? [0.08, 0.08, len] : [len, 0.08, 0.08], [pos[0], pos[1] - size[1] / 2, pos[2]]);
  }

  private ceilingSlab(x0: number, x1: number, z0: number, z1: number, y: number): void {
    this.solid('ceiling', [x1 - x0, 0.3, z1 - z0], [(x0 + x1) / 2, y + 0.15, (z0 + z1) / 2], undefined, undefined, this.ceil);
  }

  /** Grid of ceiling light panels over a room. */
  private lights(x0: number, x1: number, z0: number, z1: number, y: number, step = 6, mat = 'lamp'): void {
    for (let x = x0 + step / 2; x < x1; x += step) {
      for (let z = z0 + step / 2; z < z1; z += step) this.detail(mat, [1.4, 0.05, 0.5], [x, y - 0.03, z], undefined, this.ceil);
    }
  }

  // ---------------------------------------------------------------- structure

  private buildShell(): void {
    this.solid('floor', [112, 1, 84], [0, -0.5, 0]);
    this.wallX(-42, -56, 56, H + 0.3, 'wallDark');
    this.wallX(42, -56, 56, H + 0.3, 'wallDark');
    this.wallZ(-56, -42, 42, H + 0.3, 'wallDark');
    this.wallZ(56, -42, 42, H + 0.3, 'wallDark');
    // Ceilings: everything at 4 m except the open hall (9 m roof).
    this.ceilingSlab(-56, 56, -42, -16, H);
    this.ceilingSlab(-56, 56, 16, 42, H);
    this.ceilingSlab(-56, -20, -16, 16, H);
    this.ceilingSlab(20, 56, -16, 16, H);
    this.ceilingSlab(-20, 20, -16, 16, HALL_H);
  }

  private buildHall(): void {
    this.detail('floorHall', [40, 0.02, 32], [0, 0.011, 0]);
    this.wallX(-16, -20, 20, HALL_H, 'wallHall', [[-12, 3.2], [12, 3.2]]);
    this.wallX(16, -20, 20, HALL_H, 'wallHall', [[-10, 3.2], [0, 6, 4.2], [10, 3.2]]);
    this.wallZ(-20, -16, 16, HALL_H, 'wallHall', [[0, 5, 4]]);
    this.wallZ(20, -16, 16, HALL_H, 'wallHall', [[-8, 3.2], [8, 3.2]]);
    // Safety walkways (yellow lines) around the production floor.
    for (const z of [-11, 11]) this.detail('accent', [34, 0.02, 0.12], [0, 0.025, z]);
    for (const x of [-17, 17]) this.detail('accent', [0.12, 0.02, 22], [x, 0.025, 0]);

    // Conveyor lines (split so you can cross), rollers, assembly gantries.
    for (const z of [-5, 6]) {
      for (const [x0, x1] of [[-16, -6], [-3, 7], [10, 16]]) {
        const w = x1 - x0;
        this.solid('darkMetal', [w, 0.9, 1.6], [(x0 + x1) / 2, 0.45, z], METAL);
        this.detail('metal', [w, 0.04, 1.4], [(x0 + x1) / 2, 0.92, z]);
        for (let x = x0 + 0.4; x < x1; x += 0.8) this.detail('stripe', [0.06, 0.03, 1.4], [x, 0.95, z]);
        this.detail('accent', [w, 0.1, 0.06], [(x0 + x1) / 2, 0.75, z + 0.83]);
        this.detail('accent', [w, 0.1, 0.06], [(x0 + x1) / 2, 0.75, z - 0.83]);
      }
      for (const x of [-11, 2, 13]) {
        // Gantry over each assembly station.
        this.solid('metal', [0.25, 4.2, 0.25], [x - 1.6, 2.1, z - 1.3], METAL);
        this.solid('metal', [0.25, 4.2, 0.25], [x + 1.6, 2.1, z - 1.3], METAL);
        this.solid('metal', [0.25, 4.2, 0.25], [x - 1.6, 2.1, z + 1.3], METAL);
        this.solid('metal', [0.25, 4.2, 0.25], [x + 1.6, 2.1, z + 1.3], METAL);
        this.detail('accent', [3.6, 0.25, 0.25], [x, 4.3, z - 1.3]);
        this.detail('accent', [3.6, 0.25, 0.25], [x, 4.3, z + 1.3]);
        this.detail('darkMetal', [0.5, 0.5, 2.8], [x, 4.0, z]);
        this.detail('lampWarm', [0.4, 0.04, 2.4], [x, 3.73, z]);
      }
    }
    // Overhead crane runway + bridge.
    for (const z of [-14.5, 14.5]) this.detail('accent', [38, 0.5, 0.5], [0, 7.6, z]);
    this.detail('darkMetal', [0.8, 0.7, 29], [-4, 7.6, 0]);
    this.detail('darkMetal', [1.2, 0.8, 1.2], [-4, 7.0, 3]);
    this.detail('metal', [0.05, 3.5, 0.05], [-4, 5.0, 3]);
    this.detail('darkMetal', [1.6, 0.6, 1.0], [-4, 3.1, 3]);
    // Roof lamps.
    for (let x = -15; x <= 15; x += 6) for (const z of [-8, 0, 8]) this.detail('lamp', [1.6, 0.06, 0.6], [x, HALL_H - 0.04, z], undefined, this.ceil);

    // Raised control booth on the north wall, stairs up from the east.
    this.solid('concrete', [12, 3.2, 4], [0, 1.6, -14]);
    this.detail('accent', [12.02, 0.08, 0.08], [0, 3.2, -11.98]);
    this.glass([12, 1.1, 0.08], [0, 3.75, -12.05]);
    this.glass([0.08, 1.1, 3.9], [-5.95, 3.75, -14]);
    this.solid('darkMetal', [5, 1.0, 0.8], [-2, 3.7, -15.3]); // console
    this.detail('screen', [4.6, 0.5, 0.05], [-2, 4.4, -15.7]);
    this.detail('screen', [1.2, 0.04, 0.6], [-2, 4.21, -15.2]);
    // Stairs: visual steps over a hidden ramp (smooth movement, standard FPS trick).
    const run = 8;
    const rise = 3.2;
    for (let i = 0; i < 16; i++) {
      const h = ((i + 1) / 16) * rise;
      this.detail('concrete', [run / 16, h, 2.2], [6 + run - (i + 0.5) * (run / 16), h / 2, -14.4]);
    }
    const angle = Math.atan2(rise, run);
    const n = new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0);
    this.physics.addStaticBox(
      new THREE.Vector3(6 + run / 2 - n.x * 0.2, rise / 2 - n.y * 0.2, -14.4),
      new THREE.Vector3(Math.hypot(run, rise) / 2, 0.2, 1.1),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -angle),
    );
    this.solid('metal', [Math.hypot(run, rise), 1.0, 0.06], [6 + run / 2, rise / 2 + 0.5, -13.25], METAL, [0, 0, -angle]);
  }

  private buildRing(): void {
    // Outer ring walls (rooms beyond).
    this.wallX(-20, -24, 24, H, 'wall', [[0, 4], [-16, 2], [16, 2]]);
    this.wallX(20, -24, 24, H, 'wall', [[-14, 2], [-2, 2], [16, 2]]);
    this.wallZ(-24, -20, 20, H, 'wall', [[-10, 6, 3.4], [12, 3]]);
    this.wallZ(24, -20, 20, H, 'wall', [[-14, 2], [5, 2]]);
    // Ceiling strip lights + floor guide stripes.
    for (let x = -21; x <= 21; x += 6) {
      this.detail('lamp', [1.6, 0.05, 0.4], [x, H - 0.03, -18], undefined, this.ceil);
      this.detail('lamp', [1.6, 0.05, 0.4], [x, H - 0.03, 18], undefined, this.ceil);
    }
    for (let z = -15; z <= 15; z += 6) {
      this.detail('lamp', [0.4, 0.05, 1.6], [-22, H - 0.03, z], undefined, this.ceil);
      this.detail('lamp', [0.4, 0.05, 1.6], [22, H - 0.03, z], undefined, this.ceil);
    }
    this.detail('vanta', [48, 0.02, 0.15], [0, 0.02, -18]);
    this.detail('vanta', [48, 0.02, 0.15], [0, 0.02, 18]);
    this.detail('vanta', [0.15, 0.02, 36], [-22, 0.02, 0]);
    this.detail('vanta', [0.15, 0.02, 36], [22, 0.02, 0]);
    // Wall bumpers.
    for (const z of [-19.8, 19.8]) this.detail('darkMetal', [47, 0.25, 0.08], [0, 0.6, z]);
  }

  private buildNorth(): void {
    // Partitions: canteen | lobby + security | barracks.
    this.wallZ(-8, -42, -20, H, 'wall', [[-34, 2]]);
    this.wallZ(8, -42, -20, H, 'wall', [[-34, 2]]);
    this.lights(-24, 24, -42, -20, H, 6);

    // Lift lobby: lift doors, reception.
    for (const x of [-4.5, 0, 4.5]) {
      this.detail('metal', [2.2, 2.8, 0.1], [x, 1.4, -41.8]);
      this.detail('darkMetal', [0.06, 2.8, 0.12], [x, 1.4, -41.78]);
      this.detail('lampWarm', [0.5, 0.12, 0.04], [x, 3.1, -41.78]);
    }
    this.solid('wood', [5, 1.1, 1.0], [-4, 0.55, -33]);
    this.detail('stripe', [5.1, 0.06, 1.1], [-4, 1.12, -33]);
    // Security checkpoint: turnstiles with gaps, guard booth, scanner.
    for (const x of [-7, -4.6, -2.2, 2.2, 4.6, 7]) this.solid('metal', [1.2, 1.0, 0.5], [x, 0.5, -26], METAL);
    this.detail('vanta', [16, 0.02, 0.4], [0, 0.02, -27]);
    this.solid('darkMetal', [2.2, 1.1, 2.2], [0, 0.55, -24], METAL);
    this.glass([2.2, 1.6, 0.08], [0, 1.9, -22.9]);
    this.solid('metal', [1.2, 1.9, 2.6], [6, 0.95, -23], METAL); // scanner arch
    // Canteen: tables and counter.
    for (const x of [-20, -15]) for (const z of [-36, -30, -24]) {
      this.solid('stripe', [2.4, 0.08, 1.1], [x, 0.76, z]);
      this.detail('darkMetal', [0.1, 0.72, 0.1], [x, 0.36, z]);
      this.solid('darkMetal', [2.4, 0.45, 0.35], [x, 0.22, z - 0.8]);
      this.solid('darkMetal', [2.4, 0.45, 0.35], [x, 0.22, z + 0.8]);
    }
    this.solid('metal', [10, 1.0, 0.9], [-16, 0.5, -40.5], METAL);
    // Black Division barracks: bunks, lockers, weapon rack, red light.
    for (const z of [-40, -36, -32]) {
      this.solid('darkMetal', [2.1, 0.5, 0.95], [21.5, 0.25, z]);
      this.detail('fabric', [2.0, 0.12, 0.9], [21.5, 0.56, z]);
      this.solid('darkMetal', [2.1, 0.08, 0.95], [21.5, 1.5, z]);
      this.detail('fabric', [2.0, 0.12, 0.9], [21.5, 1.6, z]);
      this.detail('darkMetal', [0.06, 1.9, 0.06], [20.5, 0.95, z - 0.45]);
      this.detail('darkMetal', [0.06, 1.9, 0.06], [20.5, 0.95, z + 0.45]);
    }
    for (let x = 10.5; x < 18; x += 0.75) this.solid('darkMetal', [0.7, 2.0, 0.55], [x, 1.0, -41.5]);
    this.solid('darkMetal', [3, 1.4, 0.4], [13, 0.7, -21]);
    this.detail('lampRed', [0.4, 0.05, 1.4], [16, H - 0.03, -31], undefined, this.ceil);
  }

  private buildEast(): void {
    this.wallZ(24, -42, -20, H, 'wall');
    this.wallZ(24, 20, 42, H, 'wall');
    this.wallX(-5, 24, 56, H, 'wall', [[40, 2]]);
    this.wallX(15, 24, 56, H, 'wall', [[32, 2]]);
    this.wallZ(40, 15, 42, H, 'wall', [[30, 1.6]]);
    this.lights(24, 56, -42, -5, H, 6);
    this.lights(24, 56, 15, 42, H, 6);
    // Server hall: dimmer, between the rack rows.
    for (let z = -0.25; z <= 14; z += 3.5) for (let x = 30; x <= 52; x += 7) this.detail('lamp', [1.4, 0.05, 0.3], [x, H - 0.03, z], undefined, this.ceil);
    // R&D offices: glass cubicles with desks and screens.
    for (const x of [30, 38, 46]) {
      for (const z of [-36, -27, -18, -11]) {
        this.solid('wall', [0.1, 1.4, 3.6], [x - 3, 0.7, z]);
        this.solid('wood', [2.2, 0.06, 1.0], [x - 1, 0.76, z - 0.8]);
        this.detail('darkMetal', [0.08, 0.72, 0.08], [x - 2, 0.36, z - 0.8]);
        this.detail('darkMetal', [0.08, 0.72, 0.08], [x, 0.36, z - 0.8]);
        this.detail('screen', [0.7, 0.42, 0.04], [x - 1, 1.05, z - 1.2]);
        this.detail('darkMetal', [0.5, 0.5, 0.5], [x - 1, 0.25, z + 0.3]);
      }
    }
    // Server hall: rack rows with blinking LEDs, cold-aisle floor.
    for (let z = -2; z <= 12; z += 3.5) {
      this.solid('darkMetal', [24, 2.3, 1.1], [41, 1.15, z], METAL);
      for (let x = 30; x < 53; x += 1.2) {
        this.detail('leds', [0.04, 0.04, 0.02], [x, 1.7, z + 0.56]);
        this.detail('leds', [0.04, 0.04, 0.02], [x + 0.3, 1.2, z + 0.56]);
        this.detail('leds', [0.04, 0.04, 0.02], [x, 1.7, z - 0.56]);
      }
    }
    this.detail('screen', [0.6, 0.04, 30], [26.5, H - 0.03, 5], undefined, this.ceil);
    // Clean lab: glass isolation booths, lab benches.
    for (const x of [28, 34]) {
      this.glass([4, 2.4, 0.08], [x, 1.2, 24]);
      this.glass([0.08, 2.4, 4], [x - 2, 1.2, 26]);
      this.solid('stripe', [2.4, 0.9, 1], [x, 0.45, 27]);
    }
    for (const z of [33, 38]) this.solid('stripe', [10, 0.9, 1.2], [32, 0.45, z]);
    // Director's office: desk, bookcases, Vanta wall emblem.
    this.solid('wood', [3.2, 0.8, 1.4], [48, 0.4, 33]);
    this.detail('screen', [0.9, 0.5, 0.05], [48, 1.1, 32.5]);
    for (let x = 42.5; x < 55; x += 2.2) this.solid('wood', [2, 2.6, 0.5], [x, 1.3, 41.5]);
    this.detail('vanta', [3, 3, 0.05], [55.8, 2.1, 28], [0, Math.PI / 2, 0]);
  }

  private buildSouth(): void {
    // Observation corridor z 20..28, four glass-fronted test cells, generator room.
    this.wallZ(8, 20, 42, H, 'wall');
    this.lights(-24, 8, 20, 28, H, 4);
    for (const [i, cx] of [-20, -12, -4, 4].entries()) {
      this.glass([2.6, 2.6, 0.1], [cx - 2.4, 1.3, 28]);
      this.glass([2.6, 2.6, 0.1], [cx + 2.4, 1.3, 28]);
      this.solid('wallHall', [8, H - 2.6, T], [cx, (H + 2.6) / 2, 28]);
      if (i > 0) this.wallZ(cx - 4, 28, 42, H, 'wallHall');
      this.detail('lamp', [2, 0.05, 2], [cx, H - 0.03, 35], undefined, this.ceil);
      this.detail('accent', [5, 0.02, 0.12], [cx, 0.02, 31]);
      this.solid('darkMetal', [3, 0.15, 3], [cx, 0.075, 36]); // test pad
      this.detail('screen', [1.2, 0.6, 0.05], [cx + 2.8, 2.0, 28.2]);
    }
    // Generator room: big generator, fuel tanks, pipes.
    this.lights(8, 24, 20, 42, H, 6, 'lampWarm');
    this.solid('darkMetal', [5, 2.6, 8], [16, 1.3, 33], METAL);
    this.detail('accent', [5.05, 0.15, 8.05], [16, 2.0, 33]);
    for (const z of [30, 33, 36]) this.detail('metal', [0.6, 0.6, 0.6], [16, 2.9, z]);
    for (const z of [24, 27]) this.solid('metal', [2.2, 2.2, 2.2], [21.5, 1.1, z], METAL);
    this.detail('metal', [0.3, 0.3, 20], [9, 3.4, 31]);
    this.detail('metal', [0.3, 0.3, 20], [9.6, 3.4, 31]);
    this.solid('darkMetal', [1.6, 1.8, 0.5], [11, 0.9, 21.5]); // control panel
    this.detail('lampRed', [0.15, 0.15, 0.04], [10.6, 1.5, 21.24]);
    this.detail('screen', [0.8, 0.4, 0.04], [11.2, 1.3, 21.24]);
  }

  private buildWest(): void {
    this.wallX(10, -56, -24, H, 'wall', [[-40, 3]]);
    this.wallZ(-24, -42, -20, H, 'wall');
    this.wallZ(-24, 20, 42, H, 'wall');
    this.lights(-56, -24, -42, 10, H, 7, 'lampWarm');
    this.lights(-56, -24, 10, 42, H, 7);
    // Garage: pillars, bays, vehicles, vehicle gate (closed) on the west wall.
    for (const x of [-46, -34]) for (const z of [-33, -19, -5]) {
      this.solid('concrete', [0.8, H, 0.8], [x, H / 2, z]);
      this.detail('accent', [0.82, 0.3, 0.82], [x, 0.15, z]);
    }
    for (let z = -40; z <= 6; z += 3.2) this.detail('stripe', [5, 0.02, 0.1], [-52.5, 0.02, z]);
    const car = (x: number, z: number, mat: string, rotY: number) => {
      this.solid(mat, [1.9, 0.8, 4.4], [x, 0.65, z], METAL, [0, rotY, 0]);
      this.solid(mat, [1.7, 0.6, 2.4], [x, 1.35, z + 0.2], METAL, [0, rotY, 0]);
      this.detail('glass', [1.72, 0.45, 2.2], [x, 1.38, z + 0.2], [0, rotY, 0], this.clear);
    };
    car(-52.5, -36.8, 'carGrey', 0);
    car(-52.5, -27.2, 'carRed', 0);
    car(-52.5, -14.4, 'carGrey', 0);
    car(-40, -12, 'carRed', 0.4);
    // Armoured van.
    this.solid('darkMetal', [2.3, 2.3, 5.6], [-30, 1.15, -34], METAL);
    this.detail('vanta', [2.32, 0.2, 5.62], [-30, 1.6, -34]);
    this.solid('darkMetal', [6, H, 0.4], [-55.8, H / 2, -24], METAL, [0, Math.PI / 2, 0]); // gate shutter
    this.detail('accent', [0.05, 0.3, 6], [-55.5, 0.15, -24]);
    this.detail('lampRed', [0.05, 0.2, 0.6], [-55.5, 3.4, -20.5]);
    // Warehouse: racking rows with crates, cargo lift, containers.
    for (const z of [16, 22, 28]) {
      for (const x of [-50, -42]) {
        this.solid('metal', [6, 0.12, 1.4], [x, 1.4, z], METAL);
        this.solid('metal', [6, 0.12, 1.4], [x, 2.8, z], METAL);
        for (const dx of [-2.95, 2.95]) this.solid('accent', [0.12, 3.6, 1.4], [x + dx, 1.8, z]);
        for (const dx of [-2, 0, 2]) {
          this.detail('wood', [1.1, 0.9, 1.1], [x + dx, 0.45, z]);
          this.detail('contGreen', [1.1, 0.9, 1.1], [x + dx, 1.92, z]);
        }
      }
    }
    this.solid('contGreen', [2.44, 2.6, 6.06], [-30, 1.3, 36]);
    for (const x of [-52, -48]) {
      this.detail('metal', [3.4, 3.2, 0.1], [x, 1.6, 41.8]);
      this.detail('accent', [3.4, 0.2, 0.12], [x, 3.3, 41.78]);
    }
  }

  /** Painted zone signs: big orientation text on the corridor walls. */
  private buildSigns(): void {
    const sign = (text: string, w: number, pos: V3, rotY: number, color = '#e8e8e8', bg = '#1b1d20') => {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = bg;
      g.fillRect(0, 0, 512, 128);
      g.fillStyle = '#9a1612';
      g.fillRect(0, 0, 14, 128);
      g.fillStyle = color;
      g.font = 'bold 58px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText(text, 36, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      m.position.set(...pos);
      m.rotation.y = rotY;
      this.group.add(m);
    };
    sign('VANTA · SITE-9', 6, [0, 2.9, -41.8], 0);
    sign('ASSEMBLY', 3, [-4, 3.3, -20.18], Math.PI);
    sign('ASSEMBLY', 3, [-4, 3.3, -16.18], Math.PI);
    sign('GARAGE', 2.4, [-23.82, 3.3, -14], Math.PI / 2);
    sign('WAREHOUSE', 2.4, [-23.82, 3.3, 16], Math.PI / 2);
    sign('SERVERS', 2.4, [23.82, 3.3, 9], -Math.PI / 2);
    sign('R&D', 2.4, [23.82, 3.3, -10], -Math.PI / 2);
    sign('TEST CELLS', 2.4, [-8, 3.3, 19.82], Math.PI);
    sign('POWER', 2.4, [12, 3.3, 19.82], Math.PI);
    sign('SECURITY', 2.4, [10, 3.3, -19.82], 0);
    sign('CANTEEN', 2.4, [-11, 3.3, -19.82], 0);
  }

  private placeProps(): void {
    const p = this.props;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // Hall: crates and drums near the walls.
    p.stack(v(-17, 0, -13), 3, 0.6);
    p.cube(v(16.5, 0.5, -12.5), 1, 0.3);
    p.cube(v(16.6, 1.5, -12.4), 1, 0.7, true);
    p.barrel(v(-18, 0.45, 12));
    p.barrel(v(-17.2, 0.45, 13), true);
    p.barrel(v(17.5, 0.45, 13.5));
    p.cube(v(7, 0.4, 13), 0.8, 0.2);
    // Corridors and wings.
    p.barrel(v(-22.8, 0.45, -6));
    p.cube(v(22.6, 0.4, 14), 0.8, 0.4, true);
    p.stack(v(-36, 0, 34), 4, 0.5);
    p.barrel(v(-27, 0.45, 20));
    p.barrel(v(-26.2, 0.45, 21), true);
    p.barrel(v(20, 0.45, 38));
    p.cube(v(-44, 0.5, -26), 1, 0.5);
  }

  private placeRobots(): void {
    // Dormant production robots on the assembly lines and in the test cells.
    for (const x of [-11, 2, 13]) {
      this.robotSpawns.push({ position: new THREE.Vector3(x, 0.9, -5), facing: Math.PI });
      this.robotSpawns.push({ position: new THREE.Vector3(x, 0.9, 6), facing: 0 });
    }
    for (const cx of [-20, -12, -4, 4]) this.robotSpawns.push({ position: new THREE.Vector3(cx, 0.15, 36), facing: Math.PI });
  }

  private buildSquads(): SquadSpawn[] {
    const r = (pts: number[][]) => pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
    return [
      // Ring patrol around the hall.
      { route: r([[-22, -18], [22, -18], [22, 18], [-22, 18]]), spawnIndex: 2 },
      // Wing sweep: barracks → garage → warehouse → hall → servers → offices.
      {
        route: r([[16, -30], [-22, -10], [-40, -28], [-40, 24], [-22, 12], [0, 0], [22, 8], [40, 5], [40, -30], [22, -14]]),
        spawnIndex: 0,
      },
    ];
  }

  update(dt: number): void {
    this.props.update();
    // Server LEDs flicker.
    this.time += dt;
    this.serverLeds.emissiveIntensity = 1.4 + Math.sin(this.time * 9) * Math.sin(this.time * 23.7) * 0.9;
  }
}
