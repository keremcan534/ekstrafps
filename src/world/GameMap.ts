import type * as THREE from 'three';
import type { PhysicsProps } from './PhysicsProps';
import type { RobotOptions } from '../targets/RobotTarget';

export interface Station {
  name: string;
  pos: [number, number, number];
  yaw: number;
}

/** One SABLE squad: its patrol loop and where on it the column starts. */
export interface SquadSpawn {
  route: THREE.Vector3[];
  spawnIndex: number;
}

/** What the game needs from a map (the Weapon Lab arena, Site-9, ...). */
export interface GameMap {
  readonly name: string;
  readonly group: THREE.Group;
  readonly props: PhysicsProps;
  readonly spawn: THREE.Vector3;
  readonly spawnYaw: number;
  readonly robotSpawns: RobotOptions[];
  readonly squads: SquadSpawn[];
  /** Navigation bounds (x0, z0, x1, z1). */
  readonly navBounds: [number, number, number, number];
  readonly sun: THREE.DirectionalLight;
  /** Quick-travel test stations (M). */
  readonly stations: Station[];
  /** Scene background / fog colour. */
  readonly skyColor: number;
  /** Tone-mapping exposure (default 1.05). */
  readonly exposure?: number;
  update(dt: number, focus?: THREE.Vector3): void;
}
