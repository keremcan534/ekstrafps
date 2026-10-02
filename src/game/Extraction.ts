import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Site9 } from '../world/Site9';
import type { NavGrid } from '../ai/NavGrid';
import type { AudioSystem } from '../audio/AudioSystem';
import type { ImpactSystem } from '../fx/ImpactSystem';
import type { Physics } from '../core/Physics';
import type { TeamAgent } from './TeamAgent';
import type { WeaponData } from '../weapons/WeaponData';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../enemies/Soldier';
import { metalTexture } from '../fx/Textures';
import { smoothstep } from '../core/math';

/**
 * Extraction sites. When the clock runs out two exits open:
 *
 *   LZ ATRIUM     a tandem-rotor cargo helicopter flies in and lands; the crew
 *                 secures the ramp and a flare man waves you in.
 *   EVAC BUNKER   a concrete shelter on the hangar floor; its blast doors grind
 *                 open onto a red-lit corridor going down.
 *
 * Stand in the zone for 5 s (counted down on screen) and the cinematic plays:
 * your squad boards / goes in, the crew follows, and you're out.
 */

export interface ExtractDeps {
  scene: THREE.Scene;
  map: Site9;
  nav: NavGrid;
  physics: Physics;
  soldierDeps: SoldierDeps;
  audio: AudioSystem;
  impacts: ImpactSystem;
  weaponData(id: string): WeaponData | undefined;
  allies(): TeamAgent[];
  playerPos: THREE.Vector3;
  /** The weapon in your hands (the stand-in carries it in the cinematic). */
  playerWeapon(): string;
}

export interface CameraShot {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

export interface ExtractSite {
  readonly name: string;
  /** Where teams run to (and the centre of the zone). */
  readonly pos: THREE.Vector3;
  /** Open for business (landed / doors open). */
  readonly ready: boolean;
  inZone(p: THREE.Vector3): boolean;
  update(dt: number): void;
  /** Start the exit cinematic. Returns the camera per frame; `done` fires at the end. */
  cinematic(done: () => void): (dt: number) => CameraShot;
  /** Cinematic length (s). */
  readonly cinematicLength: number;
}

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
const nobody: PlayerTarget = { feet: v(0, -99, 0), head: v(0, -98, 0), chest: v(0, -98.5, 0), velocity: v(), sprinting: false, crouching: false, alive: false };

/** The most open walkable spot in a room (for a landing zone / a structure footprint). */
function openSpot(d: ExtractDeps, roomId: string, radius: number): THREE.Vector3 {
  const room = d.map.rooms.find((r) => r.id === roomId)!;
  const [x0, z0, x1, z1] = room.rect;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  let best = v(cx, 0, cz);
  let bestScore = -Infinity;
  for (let x = x0 + radius; x <= x1 - radius; x += 2) {
    for (let z = z0 + radius; z <= z1 - radius; z += 2) {
      if (!d.nav.walkable(x, z)) continue;
      let open = 0;
      for (const r of [radius * 0.35, radius * 0.7, radius])
        for (let a = 0; a < 16; a++) if (d.nav.walkable(x + Math.cos((a / 16) * Math.PI * 2) * r, z + Math.sin((a / 16) * Math.PI * 2) * r)) open++;
      const score = open * 10 - Math.hypot(x - cx, z - cz) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = v(x, 0, z);
      }
    }
  }
  return best;
}

function std(color: number, metal = 0.45, rough = 0.6, map = true): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, map: map ? metalTexture() : null });
}

/** Dust skating out from under a rotor / a door. */
function wash(impacts: ImpactSystem, c: THREE.Vector3, strength: number, count: number): void {
  const dust = (impacts as unknown as { dust: { spawn(p: object): void } }).dust;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1 + Math.random() * 5;
    const sp = (3 + Math.random() * 5) * strength;
    dust.spawn({
      x: c.x + Math.cos(a) * r, y: c.y + 0.1 + Math.random() * 0.3, z: c.z + Math.sin(a) * r,
      vx: Math.cos(a) * sp, vy: 0.3 + Math.random() * 0.8, vz: Math.sin(a) * sp,
      life: 0.9 + Math.random() * 0.9, size: 0.4, sizeEnd: 1.6 + Math.random(), stretch: 0,
      r: 0.62, g: 0.6, b: 0.56, alpha: 0.22 * strength, gravity: -0.2, drag: 1.4,
    });
  }
}

function crewSoldier(d: ExtractDeps, i: number, at: THREE.Vector3, weapon: string): Soldier {
  const s = new Soldier(d.soldierDeps, 60 + i, hooks, 'alpha', 'vanta');
  const w = d.weaponData(weapon);
  if (w) s.setWeapon(w);
  s.spawn(at, 0);
  s.body.root.visible = false;
  return s;
}

/** Your body for the cinematic (in play you only see your hands). */
function standIn(d: ExtractDeps): Soldier {
  const s = new Soldier(d.soldierDeps, 70, hooks, 'alpha', 'vanta');
  const w = d.weaponData(d.playerWeapon()) ?? d.weaponData('m4a1');
  if (w) s.setWeapon(w);
  s.spawn(d.playerPos.clone().setY(0), 0);
  return s;
}

/** Squadmates run for the exit; on reaching it they're aboard. */
function boardAllies(d: ExtractDeps, door: () => THREE.Vector3): TeamAgent[] {
  const going = d.allies().filter((a) => a.alive && !a.downed);
  for (const a of going) a.order = { kind: 'goto', at: door().clone(), speed: 4 };
  return going;
}

// =========================================================================== helicopter

const LAND_T = 11;

export class HeliExit implements ExtractSite {
  readonly name = 'LZ ATRIUM';
  readonly pos: THREE.Vector3;
  readonly cinematicLength = 8.2;
  private group = new THREE.Group();
  private ramp = new THREE.Group();
  private rotors: THREE.Object3D[] = [];
  private nav: THREE.Mesh[] = [];
  private strobe: THREE.Mesh;
  private search: THREE.SpotLight;
  private cabin: THREE.PointLight;
  private flare: THREE.Group;
  private flareLight: THREE.PointLight;
  private crew: Soldier[] = [];
  private posts: THREE.Vector3[] = [];
  private t = 0;
  private lz: THREE.Vector3;
  private yaw = 0;
  private landed = false;
  private crewOut = false;
  private leaving = -1;
  private rampAngle = 0;

  constructor(private d: ExtractDeps) {
    this.lz = openSpot(d, 'atrium', 11);
    const atrium = d.map.rooms.find((r) => r.id === 'atrium')!;
    // Ramp toward the middle of the room (open floor), nose toward the nearer wall.
    this.yaw = this.lz.z < (atrium.rect[1] + atrium.rect[3]) / 2 ? 0 : Math.PI;
    const back = v(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.pos = this.lz.clone().addScaledVector(back, 8.5);
    d.nav.nearestWalkable(this.pos.x, this.pos.z, this.pos, 4);
    this.build();
    this.strobe = this.group.getObjectByName('strobe') as THREE.Mesh;
    this.search = this.group.getObjectByName('search') as THREE.SpotLight;
    this.cabin = this.group.getObjectByName('cabin') as THREE.PointLight;
    // Flare (the crewman's hand) + its light.
    this.flare = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x8a1a10, roughness: 0.6 }));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3a1a).multiplyScalar(6) }));
    tip.position.y = 0.17;
    this.flare.add(stick, tip);
    this.flareLight = new THREE.PointLight(0xff3216, 0, 18, 1.4);
    this.flare.add(this.flareLight);
    this.flare.visible = false;
    d.scene.add(this.flare);
    this.group.visible = true;
    d.scene.add(this.group);
    d.audio.play('heli.approach');
    // Crew: two guards and the flare man (spawned aboard, hidden until the ramp drops).
    const ramp = this.lz.clone().addScaledVector(back, 5);
    const side = v(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.posts = [
      ramp.clone().addScaledVector(side, -3.4).addScaledVector(back, 1.5),
      ramp.clone().addScaledVector(side, 3.4).addScaledVector(back, 1.5),
      ramp.clone().addScaledVector(back, 2.6),
    ];
    for (let i = 0; i < 3; i++) this.crew.push(crewSoldier(d, i, this.lz.clone().addScaledVector(back, 3.5), i === 2 ? 'heavy_pistol' : 'm4a1'));
  }

  get ready(): boolean {
    return this.crewOut;
  }

  inZone(p: THREE.Vector3): boolean {
    return this.ready && Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 5.5;
  }

  private build(): void {
    const g = this.group;
    const body = std(0x434a3c, 0.4, 0.62);
    const dark = std(0x1d2024, 0.6, 0.5);
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b1418, metalness: 0.9, roughness: 0.15, emissive: new THREE.Color(0x0a2a1c), emissiveIntensity: 0.6 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    // Fuselage (nose toward -Z), cockpit, sponsons, rotor pylons, gear.
    add(new RoundedBoxGeometry(3.2, 3.0, 12, 4, 0.7), body, 0, 2.3, 0);
    add(new RoundedBoxGeometry(3.0, 1.6, 2.4, 4, 0.6), body, 0, 2.6, -6.4);
    add(new RoundedBoxGeometry(2.6, 1.0, 1.6, 4, 0.4), glass, 0, 3.05, -6.9);
    add(new RoundedBoxGeometry(0.9, 0.9, 6.5, 3, 0.35), dark, -1.85, 1.3, 0.4);
    add(new RoundedBoxGeometry(0.9, 0.9, 6.5, 3, 0.35), dark, 1.85, 1.3, 0.4);
    add(new RoundedBoxGeometry(1.5, 1.2, 2.4, 3, 0.4), body, 0, 4.1, -4.6);
    add(new RoundedBoxGeometry(1.8, 2.6, 2.8, 3, 0.5), body, 0, 4.4, 4.9);
    add(new RoundedBoxGeometry(0.7, 0.6, 3.8, 3, 0.25), dark, -1.05, 3.95, 1.5);
    add(new RoundedBoxGeometry(0.7, 0.6, 3.8, 3, 0.25), dark, 1.05, 3.95, 1.5);
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[-1.5, -4.2], [1.5, -4.2], [-1.6, 3.6], [1.6, 3.6]]) {
      add(wheelGeo, dark, x, 0.42, z);
      add(new THREE.BoxGeometry(0.16, 0.7, 0.16), dark, x * 0.85, 0.85, z);
    }
    // Rear ramp (hinged at the bottom of the cargo door).
    this.ramp.position.set(0, 0.85, 6.0);
    add(new THREE.BoxGeometry(2.7, 0.14, 3.0), dark, 0, 0, 1.5, this.ramp);
    g.add(this.ramp);
    // Tandem rotors: a blurred disc + three blades each.
    const discMat = new THREE.MeshBasicMaterial({ color: 0x050607, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    for (const [y, z] of [[4.85, -4.6], [6.0, 4.9]]) {
      const hub = new THREE.Group();
      hub.position.set(0, y, z);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(7.6, 48), discMat);
      disc.rotation.x = -Math.PI / 2;
      hub.add(disc);
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.06, 0.45), dark);
        blade.position.x = 3.7;
        const arm = new THREE.Group();
        arm.rotation.y = (i / 3) * Math.PI * 2;
        arm.add(blade);
        hub.add(arm);
      }
      g.add(hub);
      this.rotors.push(hub);
    }
    // Lights: nav (red left / green right), strobe, searchlight, red cabin glow at the ramp.
    for (const [x, c] of [[-1.7, 0xff2010], [1.7, 0x20ff60]] as const) {
      const m = add(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(5) }), x, 2.4, -5.6);
      this.nav.push(m);
    }
    const strobe = add(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(8) }), 0, 6.5, 5.2);
    strobe.name = 'strobe';
    const search = new THREE.SpotLight(0xe8f0ff, 0, 70, 0.28, 0.5, 1.1);
    search.name = 'search';
    search.position.set(0, 0.9, -6.8);
    search.target.position.set(0, -20, -14);
    g.add(search, search.target);
    const cabin = new THREE.PointLight(0xff3a20, 0, 9, 1.5);
    cabin.name = 'cabin';
    cabin.position.set(0, 2.2, 4.2);
    g.add(cabin);
    // Rotor-wash blocker for bullets/players once landed (fuselage only).
    g.rotation.y = this.yaw;
  }

  /** Flight path: in from high and far, flare, settle onto the LZ. */
  private flightPos(t: number, out: THREE.Vector3): THREE.Vector3 {
    const k = Math.min(1, t / LAND_T);
    const e = smoothstep(k);
    const fwd = v(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const start = this.lz.clone().addScaledVector(fwd, 120).add(v(30, 55, 0));
    const above = this.lz.clone().add(v(0, 22, 0));
    if (k < 0.72) {
      const q = smoothstep(k / 0.72);
      out.lerpVectors(start, above, q);
    } else {
      const q = smoothstep((k - 0.72) / 0.28);
      out.lerpVectors(above, this.lz, q);
    }
    void e;
    return out;
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    for (const [i, r] of this.rotors.entries()) r.rotation.y += dt * (i ? -26 : 26);
    this.nav.forEach((m) => (m.visible = Math.floor(t * 1.2) % 2 === 0));
    this.strobe.visible = t % 1.1 < 0.07;
    if (this.leaving < 0) {
      if (t < LAND_T) {
        this.flightPos(t, this.group.position);
        const k = t / LAND_T;
        this.group.rotation.set(k > 0.6 && k < 0.95 ? -0.12 * Math.sin(((k - 0.6) / 0.35) * Math.PI) : 0.06, this.yaw, Math.sin(t * 0.6) * 0.03);
        this.search.intensity = 260;
        const h = this.group.position.y;
        if (h < 14) wash(this.d.impacts, this.lz, 1 - h / 14, 3);
      } else if (!this.landed) {
        this.landed = true;
        this.group.position.copy(this.lz);
        this.group.rotation.set(0, this.yaw, 0);
        this.search.intensity = 0;
      }
    }
    if (this.landed && this.leaving < 0) {
      wash(this.d.impacts, this.lz, 0.35, 1);
      // Ramp down, cabin glows, crew out.
      this.rampAngle = Math.min(1.18, this.rampAngle + dt * 0.9);
      this.cabin.intensity = 8 * (this.rampAngle / 1.18);
      if (this.rampAngle > 1.0 && !this.crewOut) {
        this.crewOut = true;
        this.crew.forEach((c, i) => {
          c.body.root.visible = true;
          c.steerTo(this.posts[i], 2.2);
        });
      }
    }
    this.ramp.rotation.x = this.rampAngle;
    this.updateCrew(dt);
  }

  private updateCrew(dt: number): void {
    if (!this.crewOut) return;
    const back = v(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.crew.forEach((c, i) => {
      if (!c.body.root.visible) return;
      const look = i < 2 ? c.pos.clone().addScaledVector(back, 6).add(v((i ? 1 : -1) * 4, 1.4, 0)) : this.d.playerPos.clone().setY(1.5);
      c.update(dt, nobody, this.crew, c.pathDone ? look : null, i < 2 ? 'ready' : 'low', false);
    });
    // The flare man waves the flare overhead at you.
    const fm = this.crew[2];
    this.flare.visible = fm.body.root.visible;
    if (this.flare.visible) {
      const t = this.t;
      const toYou = this.d.playerPos.clone().sub(fm.pos).setY(0).normalize();
      const right = v(-toYou.z, 0, toYou.x);
      const swing = Math.sin(t * 5.2) * 0.75;
      this.flare.position.copy(fm.pos).addScaledVector(right, 0.35 + swing * 0.5).add(v(0, 2.05 + Math.cos(t * 5.2) * 0.12, 0)).addScaledVector(toYou, 0.15);
      this.flare.rotation.set(0, 0, swing * 0.8);
      this.flareLight.intensity = 9 + Math.random() * 3;
      if (Math.random() < 0.5) {
        const sparks = (this.d.impacts as unknown as { sparks: { spawn(p: object): void } }).sparks;
        sparks.spawn({ x: this.flare.position.x, y: this.flare.position.y + 0.17, z: this.flare.position.z, vx: (Math.random() - 0.5) * 1.2, vy: Math.random() * 1.5, vz: (Math.random() - 0.5) * 1.2, life: 0.3 + Math.random() * 0.3, size: 0.05, sizeEnd: 0.01, stretch: 0.02, r: 1, g: 0.35, b: 0.15, alpha: 1, gravity: 2, drag: 1 });
      }
    }
  }

  cinematic(done: () => void): (dt: number) => CameraShot {
    const d = this.d;
    const me = standIn(d);
    const back = v(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const side = v(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const inside = this.lz.clone().addScaledVector(back, 2.2);
    const rampFoot = this.lz.clone().addScaledVector(back, 6.5);
    me.steerTo(rampFoot, 3.4);
    const allies = boardAllies(d, () => inside);
    let t = 0;
    let finished = false;
    const shot = { pos: v(), target: v(), fov: 50 };
    return (dt: number) => {
      t += dt;
      // You: to the ramp, then up into the cabin.
      if (me.pathDone && me.body.root.visible) me.steerTo(inside, 2.6);
      if (me.body.root.visible && me.pos.distanceTo(inside) < 1.2) me.body.setActive(false);
      if (me.body.root.visible) me.update(dt, nobody, [me], null, 'low', false);
      for (const a of allies) if (a.alive && a.soldier.pos.distanceTo(inside) < 2.6) a.leave();
      // Crew: guards signal and fall back, flare man last.
      if (t > 2.4 && t < 2.5) this.crew.slice(0, 2).forEach((c) => c.steerTo(inside, 3));
      if (t > 3.4 && t < 3.5) this.crew[2].steerTo(inside, 3);
      for (const c of this.crew) if (c.body.root.visible && c.pos.distanceTo(inside) < 1.4 && t > 2.5) c.body.setActive(false);
      // Ramp up, then lift off and bank away.
      if (t > 4.6) this.rampAngle = Math.max(0, this.rampAngle - dt * 1.4);
      if (t > 5.0 && this.leaving < 0) {
        this.leaving = 0;
        d.audio.play('heli.takeoff');
        for (const a of allies) if (a.alive) a.leave();
      }
      if (this.leaving >= 0) {
        this.leaving += dt;
        const l = this.leaving;
        this.group.position.copy(this.lz).add(v(0, 1.6 * l * l, 0)).addScaledVector(v(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.9 * l * l);
        this.group.rotation.set(-0.16 * Math.min(1, l / 1.5), this.yaw + 0.05 * l, -0.1 * Math.min(1, l));
        this.cabin.intensity = Math.max(0, this.cabin.intensity - dt * 6);
        wash(d.impacts, this.lz, Math.max(0, 1 - l / 3), 4);
      }
      // Camera: low wide side · behind the boarding · looking up at the lift-off.
      if (t < 3.0) {
        shot.pos.copy(this.lz).addScaledVector(side, 13).addScaledVector(back, 6).setY(1.1);
        shot.target.copy(this.lz).addScaledVector(back, 4).setY(2.0);
        shot.fov = 42;
      } else if (t < 5.0) {
        shot.pos.copy(this.lz).addScaledVector(back, 13).addScaledVector(side, -3.5).setY(1.9);
        shot.target.copy(this.lz).addScaledVector(back, 3).setY(2.2);
        shot.fov = 38;
      } else {
        shot.pos.copy(this.lz).addScaledVector(back, 18).addScaledVector(side, 6).setY(0.8);
        shot.target.copy(this.group.position).add(v(0, 2.5, 0));
        shot.fov = 48;
      }
      if (t >= this.cinematicLength && !finished) {
        finished = true;
        done();
      }
      return shot;
    };
  }
}

// =========================================================================== bunker

export class BunkerExit implements ExtractSite {
  readonly name = 'EVAC BUNKER';
  readonly pos: THREE.Vector3;
  readonly cinematicLength = 7.2;
  private group = new THREE.Group();
  private doorL: THREE.Mesh;
  private doorR: THREE.Mesh;
  private beacons: THREE.Group[] = [];
  private beaconLight: THREE.PointLight;
  private t = 0;
  private open = 0;
  private closing = -1;
  private origin: THREE.Vector3;
  private fwd: THREE.Vector3;

  constructor(private d: ExtractDeps) {
    this.origin = openSpot(d, 'hangar', 7);
    const hangar = d.map.rooms.find((r) => r.id === 'hangar')!;
    // Doors face the middle of the hangar.
    const cx = (hangar.rect[0] + hangar.rect[2]) / 2;
    const cz = (hangar.rect[1] + hangar.rect[3]) / 2;
    const toMid = v(cx - this.origin.x, 0, cz - this.origin.z);
    if (toMid.lengthSq() < 4) toMid.set(0, 0, 1);
    toMid.normalize();
    this.fwd = Math.abs(toMid.x) > Math.abs(toMid.z) ? v(Math.sign(toMid.x), 0, 0) : v(0, 0, Math.sign(toMid.z));
    this.pos = this.origin.clone().addScaledVector(this.fwd, 6.2);
    d.nav.nearestWalkable(this.pos.x, this.pos.z, this.pos, 4);
    const doors = this.build();
    this.doorL = doors[0];
    this.doorR = doors[1];
    this.beaconLight = new THREE.PointLight(0xff2a10, 0, 22, 1.4);
    this.beaconLight.position.copy(this.origin).addScaledVector(this.fwd, 4.6).setY(6.2);
    d.scene.add(this.group, this.beaconLight);
    d.audio.play('blastdoor.open', { position: this.pos });
  }

  get ready(): boolean {
    return this.open > 0.95;
  }

  inZone(p: THREE.Vector3): boolean {
    return this.ready && Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 4.2;
  }

  private build(): THREE.Mesh[] {
    const g = this.group;
    g.position.copy(this.origin);
    g.rotation.y = Math.atan2(this.fwd.x, this.fwd.z);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x6b6a66, roughness: 0.92, metalness: 0.05, map: metalTexture() });
    const steel = std(0x3b4046, 0.75, 0.42);
    const hazard = new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.7, metalness: 0.2 });
    const add = (w: number, h: number, dd: number, x: number, y: number, z: number, mat: THREE.Material, collide = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      if (collide) {
        m.updateMatrixWorld(true);
        const c = m.getWorldPosition(v());
        this.d.physics.addStaticBox(c, v(w / 2, h / 2, dd / 2), m.getWorldQuaternion(new THREE.Quaternion()));
      }
      return m;
    };
    // Shell: back wall, sides, roof, a front face around a 5 m opening (local +Z = front).
    add(9.5, 7.2, 0.8, 0, 3.6, -4.6, concrete);
    add(1.2, 7.2, 9.6, -4.15, 3.6, 0, concrete);
    add(1.2, 7.2, 9.6, 4.15, 3.6, 0, concrete);
    add(9.5, 1.2, 9.6, 0, 6.6, 0, concrete);
    add(2.1, 6.0, 1.0, -3.2, 3.0, 4.4, concrete);
    add(2.1, 6.0, 1.0, 3.2, 3.0, 4.4, concrete);
    add(9.5, 1.6, 1.0, 0, 6.2, 4.4, concrete);
    // Hazard-striped frame.
    add(0.4, 5.4, 0.3, -2.35, 2.7, 4.95, hazard, false);
    add(0.4, 5.4, 0.3, 2.35, 2.7, 4.95, hazard, false);
    add(5.1, 0.4, 0.3, 0, 5.35, 4.95, hazard, false);
    // Inside: a dark corridor sloping down, red strip lights receding into it.
    const black = new THREE.MeshStandardMaterial({ color: 0x0a0b0c, roughness: 1 });
    add(4.6, 0.2, 8.4, 0, 0.05, 0, black, false);
    add(4.6, 5.0, 0.2, 0, 2.5, -3.9, black, false);
    for (let i = 0; i < 5; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.06, 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2412).multiplyScalar(3 - i * 0.45) }));
      strip.position.set(0, 4.9 - i * 0.55, 3.2 - i * 1.5);
      g.add(strip);
    }
    const inner = new THREE.PointLight(0xff2010, 6, 10, 1.6);
    inner.position.set(0, 2.5, 0.5);
    g.add(inner);
    // Blast doors (slide sideways into the walls).
    const dl = add(2.4, 5.3, 0.6, -1.2, 2.65, 4.35, steel, false);
    const dr = add(2.4, 5.3, 0.6, 1.2, 2.65, 4.35, steel, false);
    for (const dm of [dl, dr]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.35, 0.05), hazard);
      stripe.position.set(0, -1.9, 0.32);
      dm.add(stripe);
    }
    // Rotating beacons on the header.
    for (const x of [-3.4, 3.4]) {
      const b = new THREE.Group();
      b.position.set(x, 7.45, 4.2);
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.32, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a10).multiplyScalar(4) }));
      b.add(lamp);
      const beam = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3.2, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xff3018, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.rotation.z = Math.PI / 2;
      beam.position.x = 1.6;
      b.add(beam);
      g.add(b);
      this.beacons.push(b);
    }
    return [dl, dr];
  }

  update(dt: number): void {
    this.t += dt;
    for (const [i, b] of this.beacons.entries()) b.rotation.y = this.t * 4 * (i ? -1 : 1);
    this.beaconLight.intensity = 30 * (0.4 + 0.6 * Math.max(0, Math.sin(this.t * 8)));
    if (this.closing < 0) this.open = Math.min(1, this.open + dt * 0.35);
    const slide = 2.35 * smoothstep(this.open);
    this.doorL.position.x = -1.2 - slide;
    this.doorR.position.x = 1.2 + slide;
    if (this.open < 1 && this.closing < 0 && Math.random() < 0.6) wash(this.d.impacts, this.pos.clone().addScaledVector(this.fwd, -1.2), 0.25, 1);
  }

  cinematic(done: () => void): (dt: number) => CameraShot {
    const d = this.d;
    const me = standIn(d);
    const inside = this.origin.clone().addScaledVector(this.fwd, 1.0);
    const deep = this.origin.clone().addScaledVector(this.fwd, -3.0);
    me.steerTo(inside, 3.2);
    const allies = boardAllies(d, () => inside);
    const side = v(this.fwd.z, 0, -this.fwd.x);
    let t = 0;
    let finished = false;
    let slammed = false;
    const shot = { pos: v(), target: v(), fov: 45 };
    return (dt: number) => {
      t += dt;
      if (me.body.root.visible) {
        if (me.pathDone) me.steerTo(deep, 2.4);
        if (me.pos.distanceTo(deep) < 1.0) me.body.setActive(false);
        me.update(dt, nobody, [me], null, 'low', false);
      }
      for (const a of allies) if (a.alive && a.soldier.pos.distanceTo(inside) < 2.4) a.leave();
      // Doors grind shut behind you; the slam.
      if (t > 3.6) {
        if (this.closing < 0) {
          this.closing = 0;
          d.audio.play('blastdoor.slam', { position: this.pos });
          for (const a of allies) if (a.alive) a.leave();
        }
        this.closing += dt;
        this.open = Math.max(0, 1 - this.closing / 2.1);
        if (this.open <= 0 && !slammed) {
          slammed = true;
          const c = this.origin.clone().addScaledVector(this.fwd, 4.4).setY(2.6);
          for (let i = 0; i < 4; i++) d.impacts.shortOut(c.clone().addScaledVector(side, (Math.random() - 0.5) * 3).add(v(0, (Math.random() - 0.5) * 3, 0)), i === 0);
          wash(d.impacts, this.pos, 1, 30);
          if (me.body.root.visible) me.body.setActive(false);
        }
      }
      // Camera: behind the squad as they go in · tight on the closing doors.
      if (t < 3.4) {
        shot.pos.copy(this.pos).addScaledVector(this.fwd, 8).addScaledVector(side, 2.2).setY(1.7);
        shot.target.copy(this.origin).addScaledVector(this.fwd, 2).setY(2.2);
        shot.fov = 46;
      } else {
        shot.pos.copy(this.pos).addScaledVector(this.fwd, 5.5).addScaledVector(side, -3).setY(1.2);
        shot.target.copy(this.origin).addScaledVector(this.fwd, 4.4).setY(2.8);
        shot.fov = 40;
      }
      if (t >= this.cinematicLength && !finished) {
        finished = true;
        done();
      }
      return shot;
    };
  }
}

let hazardTex: THREE.Texture | null = null;
function hazardTexture(): THREE.Texture {
  if (hazardTex) return hazardTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e0a51c';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#16171a';
  for (let i = -128; i < 256; i += 40) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 20, 0);
    g.lineTo(i + 148, 128);
    g.lineTo(i + 128, 128);
    g.fill();
  }
  hazardTex = new THREE.CanvasTexture(c);
  hazardTex.colorSpace = THREE.SRGBColorSpace;
  hazardTex.wrapS = hazardTex.wrapT = THREE.RepeatWrapping;
  hazardTex.repeat.set(2, 1);
  return hazardTex;
}
