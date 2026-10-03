import * as THREE from 'three';
import type { Site9 } from '../world/Site9';
import type { Survival } from './Survival';
import type { NavGrid } from '../ai/NavGrid';
import type { Combatant } from './TeamAgent';

/** Rooms a drop can land in: the middle of the facility, between every team's corner. */
const DROP_ROOMS = ['atrium', 'atrium', 'labs'];
const FIRST_AT = 75;
const WARNING = 20;
const CLAIM_TIME = 10;
const CLAIM_RADIUS = 5;
/** Unclaimed this long after landing: it's gone (the next one comes later). */
const EXPIRES = 120;
const SCORE = 500;
const CASH = 250;

export interface DropDeps {
  map: Site9;
  survival: Survival;
  nav: NavGrid;
  scene: THREE.Scene;
  /** Radio line / banner / sound for announcements. */
  announce(text: string, banner?: string): void;
  /** Zones each team is in now (the player's team included). */
  teamZones(): string[];
  /** Pay a team: score and each member's wallet. */
  reward(team: string, score: number, cash: number): void;
  teamName(team: string): string;
}

/**
 * Supply drops: the reason squads leave their corner. A crate is announced 20 s
 * ahead in the middle of the facility (with the shutters on the way there opened,
 * so every team can reach it), lands under a light beam, and goes to the first
 * team that holds it for 10 s with no other team inside 5 m: score plus cash for
 * every member. Contested, the clock stops. AI teams treat it as their objective
 * (AITeam: 'contest'), which is where the team fights happen.
 */
export class SupplyDrop {
  /** Where the next / current crate is, while it's announced or on the ground. */
  pos: THREE.Vector3 | null = null;
  private timer = FIRST_AT - WARNING;
  private landed = false;
  private age = 0;
  private holder = '';
  private hold = 0;
  private crate: THREE.Group | null = null;
  private beam: THREE.Mesh;
  private lastShout = 0;

  constructor(private d: DropDeps) {
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.6, 36, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.beam.visible = false;
    d.scene.add(this.beam);
  }

  /** The crate's position for AI objectives and the map (announced or landed). */
  get target(): THREE.Vector3 | null {
    return this.pos;
  }

  /** Where the drop stands, for the AI monitor. */
  get info(): { state: 'waiting' | 'inbound' | 'down'; t: number; holder: string; hold: number; room: string } {
    const room = this.pos ? (this.d.map.rooms.find((r) => r.rect[0] <= this.pos!.x && this.pos!.x <= r.rect[2] && r.rect[1] <= this.pos!.z && this.pos!.z <= r.rect[3])?.name ?? '') : '';
    if (!this.pos) return { state: 'waiting', t: this.timer + WARNING, holder: '', hold: 0, room };
    if (!this.landed) return { state: 'inbound', t: this.timer, holder: '', hold: 0, room };
    return { state: 'down', t: EXPIRES - this.age, holder: this.holder, hold: this.hold / CLAIM_TIME, room };
  }

  /** Seconds the leading team has held it (for the HUD). */
  get progress(): { team: string; t: number } | null {
    return this.landed && this.holder ? { team: this.holder, t: this.hold / CLAIM_TIME } : null;
  }

  update(dt: number, world: Combatant[]): void {
    if (!this.pos) {
      this.timer -= dt;
      if (this.timer <= 0) this.announce();
      return;
    }
    if (!this.landed) {
      this.timer -= dt;
      if (this.timer <= 0) this.land();
      return;
    }
    this.age += dt;
    this.beam.rotation.y += dt * 0.6;
    // Who is at the crate: one team alone → its clock runs; several → contested.
    const teams = new Set<string>();
    for (const c of world) {
      if (!c.alive || c.downed || c.kind === 'robot' || c.team === 'robots' || c.team === 'cult') continue;
      const dx = c.pos.x - this.pos.x;
      const dz = c.pos.z - this.pos.z;
      if (dx * dx + dz * dz < CLAIM_RADIUS * CLAIM_RADIUS) teams.add(c.team);
    }
    if (teams.size === 1) {
      const t = [...teams][0];
      if (t !== this.holder) {
        this.holder = t;
        this.hold = 0;
        this.shout(`${this.d.teamName(t)} is taking the supply drop.`);
      }
      this.hold += dt;
      if (this.hold >= CLAIM_TIME) return this.claim(t);
    } else if (teams.size > 1) {
      this.shout('The supply drop is contested.');
    } else this.hold = Math.max(0, this.hold - dt * 0.5);
    if (this.age > EXPIRES) {
      this.d.announce('The supply drop was lost: nobody secured it.');
      this.clear(150);
    }
  }

  private shout(text: string): void {
    if (this.age - this.lastShout < 6) return;
    this.lastShout = this.age;
    this.d.announce(text);
  }

  private announce(): void {
    const { map, nav } = this.d;
    const id = DROP_ROOMS[(Math.random() * DROP_ROOMS.length) | 0];
    const room = map.rooms.find((r) => r.id === id) ?? map.rooms[0];
    const [x0, z0, x1, z1] = room.rect;
    // The middle of the room (a fifth in from each wall), on walkable floor.
    const at = new THREE.Vector3();
    for (let i = 0; i < 20; i++) {
      const x = x0 + (x1 - x0) * (0.3 + Math.random() * 0.4);
      const z = z0 + (z1 - z0) * (0.3 + Math.random() * 0.4);
      if (nav.nearestWalkable(x, z, at, 3)) break;
    }
    this.pos = at.setY(0);
    this.timer = WARNING;
    this.landed = false;
    this.opened = this.openWay(map.zoneAt(at.x, at.z));
    this.d.announce(`Supply drop inbound: ${room.name.toUpperCase()} in ${WARNING} s.${this.opened ? ' Shutters on the way are open.' : ''}`, 'SUPPLY DROP INBOUND');
  }

  private opened = 0;

  /** Open the closed shutters between every team and the drop's zone (fewest doors each). */
  private openWay(target: string | null): number {
    if (!target) return 0;
    const sv = this.d.survival;
    let n = 0;
    for (const from of new Set(this.d.teamZones())) {
      for (const door of doorsToward(sv, from, target) ?? []) {
        if (door.open) continue;
        sv.openDoor(door);
        n++;
      }
    }
    return n;
  }

  private land(): void {
    const p = this.pos!;
    this.landed = true;
    this.age = 0;
    this.holder = '';
    this.hold = 0;
    this.crate = crateModel();
    this.crate.position.copy(p);
    this.d.scene.add(this.crate);
    this.beam.position.set(p.x, 18, p.z);
    this.beam.visible = true;
    this.d.announce('The supply drop is down. Hold it for 10 seconds to take it.', 'SUPPLY DROP');
  }

  private claim(team: string): void {
    this.d.reward(team, SCORE, CASH);
    this.d.announce(`${this.d.teamName(team)} secured the supply drop (+${SCORE} score, $${CASH} each).`, team === 'alpha' ? 'DROP SECURED' : undefined);
    this.clear(130 + Math.random() * 40);
  }

  private clear(next: number): void {
    if (this.crate) this.d.scene.remove(this.crate);
    this.crate = null;
    this.beam.visible = false;
    this.pos = null;
    this.landed = false;
    this.holder = '';
    this.hold = 0;
    this.timer = next;
  }
}

type DoorLike = Survival['doors'][number];

/**
 * The closed shutters to open to walk from zone `from` to zone `to`: breadth-first
 * over door hops (archways and open doors are free moves). null: no way at all.
 */
export function doorsToward(sv: Survival, from: string, to: string): DoorLike[] | null {
  const start = sv.reachable(from);
  if (start.has(to)) return [];
  const seen = new Set(start);
  let frontier: { zones: Set<string>; path: DoorLike[] }[] = [{ zones: start, path: [] }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const door of sv.doors) {
        if (door.open) continue;
        const [a, b] = door.zones;
        const inA = node.zones.has(a);
        if (inA === node.zones.has(b)) continue;
        const beyond = inA ? b : a;
        if (seen.has(beyond)) continue;
        const reach = sv.reachable(beyond);
        const path = [...node.path, door];
        if (reach.has(to)) return path;
        for (const z of reach) seen.add(z);
        next.push({ zones: new Set([...node.zones, ...reach]), path });
      }
    }
    frontier = next;
  }
  return null;
}

/** An olive crate with orange hazard bands (no light: a light added mid-match recompiles every shader). */
function crateModel(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.75), new THREE.MeshStandardMaterial({ color: 0x4b5232, roughness: 0.8 }));
  body.position.y = 0.35;
  body.castShadow = true;
  g.add(body);
  const band = new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff6a10, emissiveIntensity: 1.6 });
  for (const x of [-0.38, 0.38]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.77), band);
    b.position.set(x, 0.35, 0);
    g.add(b);
  }
  return g;
}
