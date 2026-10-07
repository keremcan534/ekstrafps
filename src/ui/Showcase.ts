import * as THREE from 'three';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../enemies/Soldier';
import { RogueRobot } from '../enemies/RogueRobot';
import type { SoldierPalette } from '../enemies/SoldierSkin';
import type { WeaponData } from '../weapons/WeaponData';
import type { Physics } from '../core/Physics';
import type { NavGrid } from '../ai/NavGrid';
import { Humanoid, defaultPose, type HumanoidPose, type HumanoidSkin } from '../targets/Humanoid';
import { choirSkin, choirEyes, labSkin } from '../enemies/CivilianSkin';

/** What the showcase needs from the game (Game.showcaseDeps). */
export interface ShowcaseDeps {
  soldierDeps: SoldierDeps;
  physics: Physics;
  nav: NavGrid;
  weapon: (id: string) => WeaponData | undefined;
}

interface Lineup {
  name: string;
  tag: string;
  text: string;
  /** Rim / key light colours. */
  rim: number;
  key: number;
  members: THREE.Object3D[];
  update(dt: number): void;
}

/** The stage sits far outside the map (its hitboxes never meet a bullet or a bot). */
const STAGE = new THREE.Vector3(900, 0, 900);
const HOLD = 9;
const HEMI_SKY = 0x2a1012;

/**
 * Main-menu unit showcase: a dark stage with a red-lit floor, the factions of
 * Site-9 lined up in turn — the SABLE trio around The Warden, your
 * Vanta squad, the rival squads, the rogue machines — each revealed by its rim
 * lights coming up, the camera drifting round them.
 */
export class Showcase {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  private lineups: Lineup[] = [];
  private index = 0;
  private t = 0;
  private rims: THREE.SpotLight[] = [];
  private key: THREE.SpotLight;
  private floorGlow: THREE.MeshBasicMaterial;
  private ring: THREE.MeshBasicMaterial;
  private motes: THREE.Points;
  private onChange: (l: Lineup) => void;
  /** Every body on the stage (switched off for good when the game starts). */
  private bodies: Humanoid[] = [];
  private hemi = new THREE.HemisphereLight(HEMI_SKY, 0x050203, 0.6);
  /** Phones: the current lineup's rim colour, blended into the hemisphere by the reveal. */
  private rimColor = new THREE.Color();
  private mobile: boolean;

  constructor(d: ShowcaseDeps, onChange: (l: { name: string; tag: string; text: string }) => void) {
    this.onChange = onChange;
    const S = this.scene;
    S.background = new THREE.Color(0x030102);
    S.fog = new THREE.Fog(0x080203, 9, 26);
    S.add(this.hemi);
    // Phones: one spotlight (the key) and the hemisphere takes the rim colour.
    this.mobile = !!d.soldierDeps.lowSpec;

    // Floor: dark glossy deck, a soft red pool, a thin glowing ring.
    const deck = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshStandardMaterial({ color: 0x0b0a0b, roughness: 0.32, metalness: 0.6 }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.copy(STAGE);
    S.add(deck);
    this.floorGlow = new THREE.MeshBasicMaterial({ map: radial(), color: 0xff1a12, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), this.floorGlow);
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(STAGE).setY(0.01);
    S.add(pool);
    this.ring = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.8, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 3.43, 96), this.ring);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(STAGE).setY(0.012);
    S.add(ring);

    // Lights: two hard rims from behind, a key from the front-left above.
    for (const sx of this.mobile ? [] : [-1, 1]) {
      const l = new THREE.SpotLight(0xff2010, 0, 22, 0.42, 0.55, 1.2);
      l.position.copy(STAGE).add(new THREE.Vector3(sx * 4.5, 5.5, -4.5));
      l.target.position.copy(STAGE).add(new THREE.Vector3(0, 1, 0));
      S.add(l, l.target);
      this.rims.push(l);
    }
    this.key = new THREE.SpotLight(0xffe2d6, 0, 24, 0.38, 0.7, 1.4);
    this.key.position.copy(STAGE).add(new THREE.Vector3(-3.5, 6, 7));
    this.key.target.position.copy(STAGE).add(new THREE.Vector3(0, 1.1, 0));
    S.add(this.key, this.key.target);

    this.motes = dust();
    this.motes.position.copy(STAGE).add(new THREE.Vector3(0, 2.2, 0));
    S.add(this.motes);

    // --- Lineups (built once, shown one at a time).
    const deps: SoldierDeps = { ...d.soldierDeps, scene: S, muzzleLights: undefined, lowSpec: d.soldierDeps.lowSpec };
    const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
    const target: PlayerTarget = {
      feet: STAGE.clone().add(new THREE.Vector3(0, 0, 12)), head: STAGE.clone().add(new THREE.Vector3(0, 1.7, 12)),
      chest: STAGE.clone().add(new THREE.Vector3(0, 1.35, 12)), velocity: new THREE.Vector3(), sprinting: false, crouching: false, alive: true,
    };
    const squad = (team: string, palettes: SoldierPalette[], weapons: string[], base: number): { members: THREE.Object3D[]; update(dt: number): void } => {
      const n = palettes.length;
      const sols = palettes.map((p, i) => {
        const s = new Soldier(deps, base + i, hooks, team, p);
        const w = d.weapon(weapons[i % weapons.length]);
        if (w) s.setWeapon(w);
        // A shallow arc, the middle one a step ahead.
        const x = (i - (n - 1) / 2) * 1.35;
        const z = -Math.abs(i - (n - 1) / 2) * 0.55 + (i === Math.floor(n / 2) && n % 2 ? 0.35 : 0);
        s.spawn(STAGE.clone().add(new THREE.Vector3(x, 0, z)), 0);
        return s;
      });
      const face = sols.map((s, i) => STAGE.clone().add(new THREE.Vector3((i - (n - 1) / 2) * 0.5, 1.3, 12)));
      this.bodies.push(...sols.map((s) => s.body));
      return {
        members: sols.map((s) => s.body.root),
        update: (dt) => sols.forEach((s, i) => s.update(dt, target, sols, face[i], i === Math.floor(n / 2) && n % 2 ? 'ready' : 'low', false)),
      };
    };

    const bd = squad('bd', ['bd', 'bdboss', 'bd'], ['mk47', 'scarh', 'm4a1'], 70);
    this.lineups.push({ name: 'SABLE', tag: 'THE WARDEN AND ITS CLEANUP CREW', text: 'Corporate wet-work, led by a machine that talks in a dead man’s voice. Night vision, suppressors, no witnesses. When the power dies, they are already inside.', rim: 0xff1a0a, key: 0xffd6cc, ...bd });
    const vanta = squad('alpha', ['vanta', 'vanta', 'vanta'], ['m4a1', 'ak47', 'svd'], 74);
    this.lineups.push({ name: 'VANTA SECURITY', tag: 'YOUR SQUAD', text: 'Four contractors, one wallet each, and a facility gone dark. Buy, hire, extract — or don’t come back.', rim: 0x3a8bff, key: 0xe6f0ff, ...vanta });
    const rivals = squad('bravo', ['bravo', 'charlie', 'delta'], ['ak47', 'mp5', 'saiga12'], 78);
    this.lineups.push({ name: 'RIVAL SQUADS', tag: 'BRAVO · CHARLIE · DELTA', text: 'Three other crews on the same contract. They hear you, they flank you, and they want your cash.', rim: 0xffa21a, key: 0xfff0dc, ...rivals });

    // Robots: three walkers, visors lit.
    const robots: RogueRobot[] = [];
    const rhooks = { onDamage() {}, onDeath() {}, onAttack() {}, onThud() {}, onWake() {} };
    [-1.5, 0, 1.5].forEach((x, i) => {
      const r = new RogueRobot(d.physics, S, d.nav, rhooks);
      r.spawn(STAGE.clone().add(new THREE.Vector3(x, 0, i === 1 ? 0.3 : -0.3)), 300, 1, 0, 'idle', 0);
      r.wanders = false;
      r.setVariant('normal');
      robots.push(r);
      this.bodies.push(r.body);
    });
    this.lineups.push({
      name: 'ROGUE MACHINES', tag: 'SITE-9 ASSEMBLY LINE', text: 'Line 2 keeps building them with no night shift. More every wave; the fast ones cross a corridor in seconds.', rim: 0xff0a2a, key: 0xffe0e0,
      members: robots.map((r) => r.body.root),
      update: (dt) => robots.forEach((r) => r.update(dt, [], robots)),
    });

    const scav = squad('salvage', ['salvage', 'salvage', 'salvage'], ['saiga12', 'mosin', 'ppsh'], 82);
    this.lineups.push({ name: 'SALVAGERS', tag: 'SCAVENGERS', text: 'Whatever guns they found, whatever gear still fits. They come for the loot and shoot anyone in the way.', rim: 0xd8a060, key: 0xfff0dc, ...scav });

    // Bodies without a weapon (lab staff, The Choir): posed straight through Humanoid.
    const posed = (skins: HumanoidSkin[], pose: (i: number, t: number, p: HumanoidPose) => void) => {
      const bodies = skins.map((skin, i) => {
        const b = new Humanoid(d.physics, S, skin, {}, {});
        b.root.position.copy(STAGE).add(new THREE.Vector3((i - 1) * 1.4, 0, i === 1 ? 0.3 : -0.3));
        b.root.rotation.y = (i - 1) * -0.25;
        b.reset(false);
        this.bodies.push(b);
        return b;
      });
      const poses = bodies.map(() => defaultPose());
      let t = 0;
      return {
        members: bodies.map((b) => b.root),
        update: (dt: number) => {
          t += dt;
          bodies.forEach((b, i) => {
            pose(i, t, poses[i]);
            b.update(dt, poses[i]);
          });
        },
      };
    };
    const choir = posed([choirSkin(0), choirSkin(1), choirSkin(2)], (i, t, p) => {
      p.idle = false;
      p.crouch = i === 1 ? 0.15 : 0.4;
      p.spineX = i === 1 ? 0.2 : 0.42;
      p.headX = -0.2;
      p.headY = Math.sin(t * 0.7 + i * 2) * 0.3; // slow, wrong head tilts
      p.armL = -0.35;
      p.armR = i === 1 ? -2.6 : -0.75; // the middle one has the blade up
      p.elbows = i === 1 ? 0.6 : 0.9;
      choirEyes.emissiveIntensity = 1.4 + Math.sin(t * 3.1) * 0.4;
    });
    this.lineups.push({ name: 'THE CHOIR', tag: 'WHEN THE LIGHTS DIE', text: 'They believe the machines remember. In a blackout they creep up in the dark and rush you with a blade. Keep your flashlight on them.', rim: 0xff1424, key: 0x8a6464, ...choir });
    const staff = posed([labSkin(0), labSkin(1), labSkin(4)], (i, t, p) => {
      p.idle = false;
      const cower = i === 0;
      p.crouch = cower ? 0.75 : 0.05;
      p.spineX = cower ? 0.62 : 0.1;
      p.headX = cower ? 0.45 : 0;
      p.headY = Math.sin(t * 1.3 + i * 2) * 0.5; // looking round, scared
      p.armL = cower ? -1.45 : -0.2;
      p.armR = cower ? -1.45 : -0.2;
      p.elbows = cower ? 2.45 : 0.4;
    });
    this.lineups.push({ name: 'LAB STAFF', tag: 'STILL HIDING IN THE LABS', text: 'The ones who didn’t get out. They panic and run at gunfire; robots hunt them. Shooting one costs you.', rim: 0x9fc4ff, key: 0xf0f6ff, ...staff });

    for (const l of this.lineups) for (const m of l.members) m.visible = false;
    this.show(0);
  }

  /** The game is starting: the stage's bodies leave the physics world. */
  dispose(): void {
    for (const b of this.bodies) b.setActive(false);
    this.bodies = [];
  }

  private show(i: number): void {
    for (const m of this.lineups[this.index].members) m.visible = false;
    this.index = i;
    const l = this.lineups[i];
    for (const m of l.members) m.visible = true;
    for (const r of this.rims) r.color.setHex(l.rim);
    this.rimColor.setHex(l.rim);
    this.key.color.setHex(l.key);
    this.floorGlow.color.setHex(l.rim);
    this.ring.color.setHex(l.rim);
    this.t = 0;
    this.onChange(l);
  }

  update(dt: number, aspect: number): void {
    this.t += dt;
    if (this.t > HOLD) this.show((this.index + 1) % this.lineups.length);
    const t = this.t;
    const l = this.lineups[this.index];
    l.update(dt);
    // Reveal: rims snap on with a stutter, the key fades up; everything dims before the cut.
    const out = Math.min(1, Math.max(0, (HOLD - t) / 0.6));
    const rim = (t < 0.25 ? (Math.sin(t * 90) > 0 ? 1 : 0.2) : 1) * Math.min(1, t * 4) * out;
    for (const r of this.rims) r.intensity = 220 * rim;
    // Phones (no rim spots): the tint follows the reveal, so rim 0 is exactly the desktop hemisphere.
    if (this.mobile) {
      this.hemi.color.setHex(HEMI_SKY).lerp(this.rimColor, 0.6 * rim);
      this.hemi.intensity = 0.6 + 0.6 * rim;
    }
    this.key.intensity = 110 * Math.min(1, Math.max(0, (t - 0.4) / 1.2)) * out;
    this.floorGlow.opacity = 0.5 * rim;
    this.ring.opacity = 0.85 * rim;
    // Camera: low, slow drift across the line.
    const a = -0.28 + (t / HOLD) * 0.56;
    const r = 7.4 - (t / HOLD) * 0.8;
    this.camera.aspect = aspect;
    this.camera.position.set(STAGE.x + Math.sin(a) * r, 1.15 + Math.sin(t * 0.3) * 0.06, STAGE.z + Math.cos(a) * r);
    // Wide screens: the line sits right of centre (the menu is on the left).
    const shift = aspect > 1.3 ? -0.95 : 0;
    this.camera.lookAt(STAGE.x + Math.cos(a) * shift, 1.05, STAGE.z - Math.sin(a) * shift);
    this.camera.updateProjectionMatrix();
    this.motes.rotation.y += dt * 0.02;
  }
}

/** Soft radial falloff (floor pool). */
function radial(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A slow cloud of dust in the light. */
function dust(): THREE.Points {
  const n = 500;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 6;
    p[i * 3] = Math.sin(a) * r;
    p[i * 3 + 1] = (Math.random() - 0.5) * 4.4;
    p[i * 3 + 2] = Math.cos(a) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff9a8a, size: 0.018, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
}
