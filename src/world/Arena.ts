import * as THREE from 'three';
import type { HitReceiver, Physics } from '../core/Physics';
import { MeshBuilder } from './MeshBuilder';
import { PhysicsProps } from './PhysicsProps';
import { corrugatedTexture, gridTexture } from '../fx/Textures';
import type { RobotOptions } from '../targets/RobotTarget';

const METAL: HitReceiver = { surface: 'metal', allowDecals: true };

type V3 = [number, number, number];

/**
 * Graybox Weapon Lab arena (units: metres, firing line at z = 0, range goes toward -Z).
 *
 *   Left zone  (x < -8): close-range robots, cube pyramid, barrels, hanging barrel
 *   Centre     (|x| < 7): shooting lanes with robots at 10 / 20 (moving) / 30 / 50 m,
 *                         hanging steel plates at 20 m and 50 m
 *   Right zone (x > 8): stairs → raised platform → ramp, pillars, metal cover
 *   Behind spawn: crouch tunnel + jump boxes for movement testing
 *   Black Division yard (z < -65, through two doors in the back wall): open-air
 *   container yard where the enemy squad patrols.
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly props: PhysicsProps;
  readonly spawn = new THREE.Vector3(0, 0, 4);
  readonly robotSpawns: RobotOptions[] = [];
  /** Black Division patrol loop (yard). */
  readonly patrolRoute: THREE.Vector3[] = [
    [-16.5, -70], [-17, -84], [-8, -95], [-9, -112], [2, -123], [16, -121], [20, -96], [15.5, -70], [0, -69],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  readonly squadSpawnIndex = 3;
  /** Navigation bounds (x0, z0, x1, z1). */
  readonly navBounds: [number, number, number, number] = [-22, -127, 22, 16];
  readonly sun: THREE.DirectionalLight;

  private builder = new MeshBuilder(true);
  private mats: Record<string, THREE.MeshStandardMaterial>;

  constructor(private physics: Physics, mobile: boolean) {
    this.mats = {
      floor: new THREE.MeshStandardMaterial({ map: gridTexture('#3b3e43', '#2a2c30', '#34373b'), roughness: 0.9, metalness: 0.05 }),
      wall: new THREE.MeshStandardMaterial({ map: gridTexture('#4b4f56', '#3a3d43', '#45484e'), roughness: 0.92 }),
      concrete: new THREE.MeshStandardMaterial({ map: gridTexture('#62666d', '#4e5157', '#5a5e64'), roughness: 0.88 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.85, roughness: 0.38 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6 }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.7 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 1 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xeaf2ff, emissiveIntensity: 2.5 }),
      asphalt: new THREE.MeshStandardMaterial({ map: gridTexture('#2b2d30', '#232528', '#28292c'), roughness: 0.95 }),
      yardWall: new THREE.MeshStandardMaterial({ map: gridTexture('#3a3c40', '#2e3034', '#36383c'), roughness: 0.95 }),
      contGreen: new THREE.MeshStandardMaterial({ map: corrugatedTexture('#2f3a2d'), roughness: 0.7, metalness: 0.35 }),
      contRust: new THREE.MeshStandardMaterial({ map: corrugatedTexture('#5b2d1d'), roughness: 0.75, metalness: 0.3 }),
      contBlue: new THREE.MeshStandardMaterial({ map: corrugatedTexture('#1f2b3a'), roughness: 0.7, metalness: 0.35 }),
      contFrame: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.6, metalness: 0.5 }),
      sandbag: new THREE.MeshStandardMaterial({ map: gridTexture('#4a4536', '#3c382c', '#443f32'), roughness: 1 }),
      sodium: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffa24a, emissiveIntensity: 3 }),
    };

    this.buildShell();
    this.buildRange();
    this.buildLeftZone();
    this.buildRightZone();
    this.buildMovementCourse();
    this.buildYard();
    this.builder.build(this.group);
    this.buildLabels();

    this.props = new PhysicsProps(physics);
    this.group.add(this.props.group);
    this.placeProps();
    this.placeRobots();

    // --- Lighting ---
    this.group.add(new THREE.HemisphereLight(0xc8d6ff, 0x3a3631, 1.0));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
    // Same light direction as before, re-centred so the shadow map also covers the yard.
    sun.position.set(14, 30, -21);
    sun.target.position.set(0, 0, -55);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const cam = sun.shadow.camera;
    cam.left = -62;
    cam.right = 62;
    cam.top = 62;
    cam.bottom = -62;
    cam.near = 5;
    cam.far = 120;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    this.group.add(sun, sun.target);
    this.sun = sun;
  }

  /** Static solid: visual + collider in one call. */
  private solid(mat: string, size: V3, pos: V3, receiver?: HitReceiver, rot?: V3): void {
    this.builder.box(this.mats[mat], size, pos, rot);
    const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)) : undefined;
    this.physics.addStaticBox(
      new THREE.Vector3(...pos),
      new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2),
      q,
      receiver ?? (mat === 'metal' ? METAL : undefined),
    );
  }

  /** Invisible sloped collider. Surface centre `top`, rising toward -Z. */
  private hiddenRamp(top: V3, width: number, run: number, rise: number): void {
    const angle = Math.atan2(rise, run);
    const half = 0.2;
    const n = new THREE.Vector3(0, Math.cos(angle), Math.sin(angle));
    this.physics.addStaticBox(
      new THREE.Vector3(top[0], top[1] - n.y * half, top[2] - n.z * half),
      new THREE.Vector3(width / 2, half, Math.hypot(run, rise) / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle),
    );
  }

  /** Visual-only detail (stripes, lamps). */
  private detail(mat: string, size: V3, pos: V3): void {
    this.builder.box(this.mats[mat], size, pos);
  }

  private buildShell(): void {
    this.solid('floor', [44, 1, 80], [0, -0.5, -24]);
    this.solid('wall', [1, 10, 80], [-22.5, 5, -24]);
    this.solid('wall', [1, 10, 80], [22.5, 5, -24]);
    // Back wall with two 4 m doors into the Black Division yard.
    this.solid('wall', [4.5, 10, 1], [-20.75, 5, -64.5]);
    this.solid('wall', [29, 10, 1], [0, 5, -64.5]);
    this.solid('wall', [4.5, 10, 1], [20.75, 5, -64.5]);
    for (const x of [-16.5, 16.5]) {
      this.solid('wall', [4, 6.5, 1], [x, 6.75, -64.5]);
      this.detail('accent', [4, 0.12, 1.02], [x, 3.44, -64.5]);
    }
    this.solid('wall', [46, 10, 1], [0, 5, 16.5]);
    // Ceiling + light strips (visual only, no shadows from the ceiling)
    const ceiling = new MeshBuilder(false);
    ceiling.box(this.mats.ceiling, [46, 1, 82], [0, 10.5, -24]);
    for (const x of [-14, -3, 3, 14]) ceiling.box(this.mats.lamp, [0.35, 0.08, 72], [x, 9.98, -24]);
    ceiling.build(this.group, { castShadow: false, receiveShadow: false });
    // Wall base trim
    this.detail('accent', [0.05, 0.3, 80], [-21.98, 0.15, -24]);
    this.detail('accent', [0.05, 0.3, 80], [21.98, 0.15, -24]);
  }

  private buildRange(): void {
    // Lane dividers with walk-through gaps.
    for (const x of [-7.2, 7.2]) {
      for (const [z0, z1] of [[-3, -12], [-16, -36], [-40, -58]]) {
        const len = z0 - z1;
        this.solid('concrete', [0.4, 1.2, len], [x, 0.6, (z0 + z1) / 2]);
        this.detail('accent', [0.42, 0.06, len], [x, 1.21, (z0 + z1) / 2]);
      }
    }
    // Firing line + distance stripes
    this.detail('accent', [14, 0.02, 0.18], [0, 0.011, 0]);
    for (const d of [5, 10, 20, 30, 50]) {
      this.detail('stripe', [14, 0.02, 0.08], [0, 0.011, -d]);
      // Marker posts on the dividers
      for (const x of [-7.2, 7.2]) this.solid('metal', [0.12, 1.4, 0.12], [x, 1.9, -d]);
    }
    // Metal backstop behind the 50 m line
    this.solid('metal', [16, 6, 0.3], [0, 3, -63.8]);
    // Steel plate gantries at 20 m and 50 m
    for (const z of [-22, -52]) {
      this.solid('metal', [14.4, 0.25, 0.25], [0, 3.6, z]);
      this.solid('metal', [0.25, 3.6, 0.25], [-7.2, 1.8, z]);
      this.solid('metal', [0.25, 3.6, 0.25], [7.2, 1.8, z]);
    }
  }

  private buildLeftZone(): void {
    for (const [x, z] of [[-14, -19], [-19, -27], [-11, -31], [-16, -42]]) this.pillar(x, z);
    // Low cover wall
    this.solid('concrete', [3, 1.1, 0.5], [-13, 0.55, -24]);
    this.solid('metal', [1.2, 1.2, 1.2], [-20, 0.6, -15]);
  }

  private buildRightZone(): void {
    // Raised platform
    this.solid('concrete', [9, 3, 13], [16.5, 1.5, -20.5]);
    this.detail('accent', [9.02, 0.08, 0.08], [16.5, 3.0, -14.02]);
    this.detail('accent', [0.08, 0.08, 13.02], [12.0, 3.0, -20.5]);
    // Stairs up to the platform (12 x 0.25 m rise, 1 m run). Visual steps only;
    // the collider is a hidden ramp through the step noses, so movement and the
    // camera stay smooth (standard FPS trick).
    for (let i = 1; i <= 12; i++) {
      const h = i * 0.25;
      // The top step is solid so the ramp hands over cleanly to the platform.
      if (i === 12) this.solid('concrete', [3, h, 1], [14.5, h / 2, -2 - (i - 0.5)]);
      else this.detail('concrete', [3, h, 1], [14.5, h / 2, -2 - (i - 0.5)]);
      this.detail('accent', [3.0, 0.03, 0.08], [14.5, h + 0.005, -2 - (i - 1) - 0.06]);
    }
    this.hiddenRamp([14.5, 1.5, -7], 3, 12, 3);
    // Ramp down from the back of the platform
    const angle = -Math.atan2(3, 10);
    const n = new THREE.Vector3(0, Math.cos(angle), Math.sin(angle));
    this.solid('concrete', [3, 0.4, Math.hypot(10, 3)], [19.5, 1.5 - n.y * 0.2, -32 - n.z * 0.2], undefined, [angle, 0, 0]);
    // Metal cover crates
    this.solid('metal', [1.2, 1.2, 1.2], [19.6, 3.6, -16.2]);
    this.solid('metal', [1.2, 1.2, 1.2], [10.6, 0.6, -8]);
    this.solid('metal', [1.2, 2.4, 1.2], [10.6, 1.2, -9.4]);
    for (const [x, z] of [[11, -31], [16, -40], [11, -48], [19, -52]]) this.pillar(x, z);
  }

  private buildMovementCourse(): void {
    // Crouch tunnel (1.3 m clearance)
    this.solid('concrete', [0.3, 1.3, 4], [-6, 0.65, 10]);
    this.solid('concrete', [0.3, 1.3, 4], [-3, 0.65, 10]);
    this.solid('concrete', [3.3, 0.3, 4], [-4.5, 1.45, 10]);
    this.detail('accent', [3.32, 0.08, 0.05], [-4.5, 1.3, 7.99]);
    // Jump boxes
    this.solid('concrete', [1.5, 0.5, 1.5], [4, 0.25, 10]);
    this.solid('concrete', [1.5, 1.0, 1.5], [6, 0.5, 10]);
    this.solid('concrete', [1.5, 1.5, 1.5], [8, 0.75, 10]);
    this.pillar(-12, 11);
    this.pillar(12, 12);
  }

  /** Open-air container yard behind the range: the Black Division patrol area. */
  private buildYard(): void {
    this.solid('asphalt', [46, 1, 63], [0, -0.5, -95.5]);
    this.solid('yardWall', [1, 8, 63], [-22.5, 4, -95.5]);
    this.solid('yardWall', [1, 8, 63], [22.5, 4, -95.5]);
    this.solid('yardWall', [46, 8, 1], [0, 4, -127.5]);
    this.detail('accent', [0.05, 0.3, 63], [-21.98, 0.15, -95.5]);
    this.detail('accent', [0.05, 0.3, 63], [21.98, 0.15, -95.5]);

    const container = (x: number, z: number, alongZ: boolean, mat: string, y = 0) => {
      const size: V3 = alongZ ? [2.44, 2.6, 6.06] : [6.06, 2.6, 2.44];
      this.solid(mat, size, [x, y + 1.3, z]);
      // Corner posts + top rails.
      const hx = size[0] / 2 - 0.06;
      const hz = size[2] / 2 - 0.06;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.detail('contFrame', [0.14, 2.62, 0.14], [x + sx * hx, y + 1.3, z + sz * hz]);
      this.detail('contFrame', [size[0] + 0.02, 0.1, 0.14], [x, y + 2.57, z + hz]);
      this.detail('contFrame', [size[0] + 0.02, 0.1, 0.14], [x, y + 2.57, z - hz]);
      // Door end: locking bars.
      const end = alongZ ? z + size[2] / 2 + 0.01 : x + size[0] / 2 + 0.01;
      for (const o of [-0.7, -0.35, 0.35, 0.7]) {
        if (alongZ) this.detail('contFrame', [0.04, 2.3, 0.04], [x + o, y + 1.3, end]);
        else this.detail('contFrame', [0.04, 2.3, 0.04], [end, y + 1.3, z + o]);
      }
    };
    container(-11, -78, true, 'contGreen');
    container(-2, -90, false, 'contRust');
    container(11, -80, true, 'contBlue');
    container(11, -80, true, 'contGreen', 2.6);
    container(15, -102, false, 'contRust');
    container(-14, -104, false, 'contBlue');
    container(2, -114, true, 'contGreen');
    container(-19, -120, false, 'contRust');

    const jersey = (x: number, z: number, alongZ: boolean) => {
      this.solid('concrete', alongZ ? [0.6, 0.85, 3] : [3, 0.85, 0.6], [x, 0.425, z]);
      this.detail('accent', alongZ ? [0.62, 0.08, 3.02] : [3.02, 0.08, 0.62], [x, 0.7, z]);
    };
    jersey(-3, -75, false);
    jersey(18, -88, true);
    jersey(-18, -90, true);
    jersey(6, -96, true);
    jersey(-8, -99, false);
    jersey(9, -120, false);
    jersey(-6, -121, false);

    this.solid('sandbag', [4, 1.0, 0.7], [0, 0.5, -104]);
    this.solid('sandbag', [0.7, 1.0, 3], [-13, 0.5, -91]);
    this.solid('sandbag', [3, 1.0, 0.7], [17, 0.5, -114]);
    this.solid('concrete', [2, 3, 2], [19, 1.5, -73]);

    // Sodium lamp posts.
    for (const [x, z] of [[-21.2, -80], [21.2, -95], [-21.2, -110], [0, -126.2], [21.2, -118]]) {
      this.detail('metal', [0.12, 6, 0.12], [x, 3, z]);
      this.detail('metal', [0.5, 0.12, 0.3], [x - Math.sign(x || 1) * 0.3, 6, z]);
      this.detail('sodium', [0.36, 0.05, 0.2], [x - Math.sign(x || 1) * 0.35, 5.93, z]);
    }
  }

  private pillar(x: number, z: number): void {
    this.solid('concrete', [1.2, 10, 1.2], [x, 5, z]);
    this.detail('accent', [1.22, 0.3, 1.22], [x, 0.15, z]);
  }

  /** All distance labels share one texture atlas → a single draw call. */
  private buildLabels(): void {
    const dists = [5, 10, 20, 30, 50];
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128 * dists.length;
    const ctx = canvas.getContext('2d')!;
    dists.forEach((d, i) => {
      const y = i * 128;
      ctx.fillStyle = '#111215';
      ctx.fillRect(0, y + 8, 256, 112);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(0, y + 8, 256, 8);
      ctx.fillRect(0, y + 112, 256, 8);
      ctx.font = 'bold 64px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${d} m`, 128, y + 66);
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const b = new MeshBuilder(false);
    const plane = (i: number, w: number, h: number, pos: V3, rot: V3) => {
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.getAttribute('uv');
      const v0 = 1 - (i + 1) / dists.length;
      const v1 = 1 - i / dists.length;
      for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) > 0.5 ? v1 : v0);
      b.add(mat, g, pos, rot);
    };
    dists.forEach((d, i) => {
      for (const x of [-7.2, 7.2]) plane(i, 1.2, 0.6, [x, 2.9, -d + 0.07], [0, 0, 0]);
      plane(i, 2.4, 1.2, [0, 0.02, -d + 1.0], [-Math.PI / 2, 0, 0]);
    });
    b.build(this.group, { castShadow: false, receiveShadow: false });
  }

  private placeProps(): void {
    const p = this.props;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // Left zone: shotgun playground
    p.stack(v(-19, 0, -6), 5, 0.4);
    p.cube(v(-9.2, 0.2, -3), 0.4, 0.3);
    p.cube(v(-9.8, 0.2, -3.6), 0.4, 0.9, true);
    p.cube(v(-13, 0.5, -12), 1, 0.2);
    p.cube(v(-16.5, 0.5, -13), 1, 0.7, true);
    p.cube(v(-16.5, 1.5, -13), 1, 0.4);
    p.barrel(v(-10, 0.45, -9));
    p.barrel(v(-10.7, 0.45, -9.8), true);
    p.barrel(v(-9.4, 0.45, -10.2));
    p.hangingBarrel(v(-13, 6.5, -17), 2.6);
    // Centre range
    p.steelPlate(v(-5.6, 3.48, -22), 0.6, 0.6, 0.5);
    p.steelPlate(v(5.6, 3.48, -22), 0.45, 0.45, 0.5);
    p.steelPlate(v(-4, 3.48, -52), 0.9, 0.9, 0.4);
    p.steelPlate(v(4, 3.48, -52), 0.6, 0.6, 0.4);
    p.barrel(v(5.5, 0.45, -29));
    p.cube(v(-5.6, 0.2, -31), 0.4);
    // Right zone
    p.barrel(v(18, 0.45, -5));
    p.barrel(v(18.8, 0.45, -6), true);
    p.cube(v(19.5, 0.5, -9.5), 1, 0.4);
    p.cube(v(17, 3.2, -25.5), 0.4);
    p.cube(v(17.6, 3.2, -25.5), 0.4, 0.5, true);
  }

  private placeRobots(): void {
    const face = (x: number, z: number) => Math.atan2(0 - x, 3 - z);
    const add = (x: number, y: number, z: number, rail?: RobotOptions['rail']) =>
      this.robotSpawns.push({ position: new THREE.Vector3(x, y, z), facing: rail ? 0 : face(x, z), rail });
    // Close range (5 m)
    add(-11, 0, -5);
    add(-15, 0, -5.5);
    // Centre lanes
    add(-3.5, 0, -10);
    add(3.5, 0, -10);
    add(0, 0, -20, { axis: new THREE.Vector3(1, 0, 0), length: 8, speed: 0.9 });
    add(-3, 0, -30);
    add(3, 0, -30);
    add(0, 0, -50);
    // Right zone: on the platform and on the floor behind it
    add(16.5, 3, -24);
    add(14, 0, -44);
  }

  update(): void {
    this.props.update();
  }
}
