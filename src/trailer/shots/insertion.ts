import * as THREE from 'three';
import type { CameraState, Shot } from '../Director';
import { Soldier, type PlayerTarget, type SoldierDeps } from '../../enemies/Soldier';
import { blackStage, dust, ease, handheld, lerpV } from '../stage';
import { metalTexture } from '../../fx/Textures';
import { smoothstep } from '../../core/math';

/**
 * Act II insertion on a night landing deck: two operators walk in through rotor
 * wash, the aircraft (silhouette, searchlight, nav light only) hovers, the masked
 * lead fast-ropes down, the team settles, the aircraft lifts away, the lead turns
 * toward a sound and brings the rifle up. Real soldier rigs and animation.
 */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Ins {
  lead: Soldier;
  ops: Soldier[];
  heli: THREE.Group;
  rotor: THREE.Mesh;
  nav: THREE.Mesh;
  beam: THREE.Mesh;
  search: THREE.SpotLight;
  rope: THREE.Mesh;
  wash: THREE.Points;
  washSeed: Float32Array;
  motes: ReturnType<typeof dust>;
  player: PlayerTarget;
}
let I: Ins | null = null;

const LAND = v(0, 0, -21);
const DESC0 = 3.2;
const DESC1 = 6.0;
const ROPE_TOP = 11.5;
const LIFT = 8.6;

export function gradientTex(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, 'rgba(255,255,255,0.0)');
  gr.addColorStop(0.15, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function heliAt(t: number): THREE.Vector3 {
  const hover = v(0.6 + Math.sin(t * 0.4) * 0.25, 13.2 + Math.sin(t * 0.7) * 0.15, -22.5);
  const k = smoothstep(Math.max(0, (t - LIFT) / 3.5));
  return hover.add(v(k * 3, k * 9, -k * 10));
}

export const IN: Shot = {
  map: 'lab',
  duration: 12.5,
  preroll: 1,
  handles: 0,
  setup(ctx) {
    const game = ctx.game;
    const set = blackStage(game);
    const haze = 0x0b0f15;
    game.scene.background = new THREE.Color(haze);
    game.scene.fog = new THREE.FogExp2(haze, 0.035);
    game.scene.environmentIntensity = 0.05;

    const deck = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.6, roughness: 0.6, map: metalTexture() }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, 0.002, -20);
    deck.receiveShadow = true;
    set.add(deck);
    // Containers and a barrier as background silhouettes.
    const box = (w: number, h: number, d: number, x: number, z: number, c: number, ry = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.3, map: metalTexture() }));
      m.position.set(x, h / 2, z);
      m.rotation.y = ry;
      m.castShadow = m.receiveShadow = true;
      set.add(m);
    };
    box(6.1, 2.6, 2.44, -9, -31, 0x3a2219, 0.1);
    box(6.1, 2.6, 2.44, -9.4, -31.2, 0x1f2a33, 0.1);
    box(6.1, 2.6, 2.44, 10, -33, 0x24302a, -0.2);
    box(6.1, 2.6, 2.44, 10.2, -33, 0x2b2f35, -0.2);
    box(12, 1.1, 0.6, 2, -38, 0x55524a);
    // Sodium lamps far back: warm practicals and bokeh.
    for (const [x, z] of [[-14, -40], [16, -44]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 9), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      pole.position.set(x, 4.5, z);
      set.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(4) }));
      head.position.set(x, 9, z);
      set.add(head);
      const sp = new THREE.SpotLight(0xff9a3c, 120, 26, 0.7, 0.6, 1.4);
      sp.position.set(x, 8.8, z);
      sp.target.position.set(x * 0.6, 0, z + 8);
      set.add(sp, sp.target);
    }
    // Cold moon fill from high behind (silhouettes).
    const moon = new THREE.DirectionalLight(0x6f86a8, 0.25);
    moon.position.set(-10, 20, -40);
    set.add(moon);

    // Aircraft: silhouette only. Fuselage, tail boom, blurred rotor disc, nav light.
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.7, metalness: 0.4 });
    const heli = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.25, 4.2, 6, 12), dark);
    body.rotation.z = Math.PI / 2;
    heli.add(body);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 6), dark);
    boom.rotation.z = Math.PI / 2;
    boom.position.set(5.2, 0.4, 0);
    heli.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.8, 0.15), dark);
    fin.position.set(8, 1.1, 0);
    heli.add(fin);
    const rotor = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 48),
      new THREE.MeshBasicMaterial({ color: 0x050607, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }),
    );
    rotor.rotation.x = -Math.PI / 2;
    rotor.position.y = 1.6;
    heli.add(rotor);
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.09), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a10).multiplyScalar(6) }));
    nav.position.set(-1.8, -1.1, 0);
    heli.add(nav);
    heli.rotation.y = 0.5;
    set.add(heli);
    // Searchlight + visible beam.
    const search = new THREE.SpotLight(0xe6eeff, 900, 40, 0.16, 0.45, 1.2);
    search.castShadow = true;
    search.shadow.mapSize.set(1024, 1024);
    set.add(search, search.target);
    const beamGeo = new THREE.ConeGeometry(2.6, 16, 32, 1, true);
    beamGeo.translate(0, -8, 0);
    const beam = new THREE.Mesh(
      beamGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { color: { value: new THREE.Color(0xbfd0ff) }, strength: { value: 0.22 } },
        vertexShader: `
          varying vec3 vN; varying vec3 vV; varying float vH;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vH = -position.y / 16.0;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 color; uniform float strength;
          varying vec3 vN; varying vec3 vV; varying float vH;
          void main() {
            float facing = pow(abs(dot(normalize(vN), normalize(vV))), 2.5);
            float along = smoothstep(0.0, 0.15, vH) * (1.0 - 0.55 * vH);
            gl_FragColor = vec4(color * facing * along * strength, 1.0);
          }`,
      }),
    );
    set.add(beam);
    // Rope.
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 6), new THREE.MeshStandardMaterial({ color: 0x1d1b18, roughness: 0.9 }));
    rope.castShadow = true;
    set.add(rope);
    // Rotor wash: dust skating outward over the deck.
    const N = 2600;
    const wpos = new Float32Array(N * 3);
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      seed[i * 3] = Math.random() * Math.PI * 2;
      seed[i * 3 + 1] = Math.random();
      seed[i * 3 + 2] = Math.random();
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    const wash = new THREE.Points(wg, new THREE.PointsMaterial({ color: 0x8d949c, size: 0.05, transparent: true, opacity: 0.42, depthWrite: false }));
    wash.frustumCulled = false;
    set.add(wash);
    const motes = dust(1800, v(14, 6, 14), v(0, 3, -21), 0.3);
    (motes.material as THREE.PointsMaterial).size = 0.02;
    set.add(motes);

    // Operators: real soldier rigs. Lead = respirator kit; two Vanta operators.
    const deps = (game as unknown as { soldierDeps: SoldierDeps }).soldierDeps;
    const hooks = { onSpotted() {}, onDamaged() {}, onKilled() {}, say() {}, onThud() {} };
    const rifle = game.weapons.weapons.find((w) => w.data.id === 'm4a1')!.data;
    const ak = game.weapons.weapons.find((w) => w.data.id === 'ak47')!.data;
    const lead = new Soldier(deps, 40, hooks, 'alpha', 'bd');
    lead.setWeapon(rifle);
    lead.spawn(LAND, 0);
    const op1 = new Soldier(deps, 41, hooks, 'alpha', 'vanta');
    op1.setWeapon(ak);
    op1.spawn(v(-1.3, 0, -11.5), Math.PI);
    const op2 = new Soldier(deps, 42, hooks, 'alpha', 'vanta');
    op2.setWeapon(rifle);
    op2.spawn(v(1.1, 0, -10.2), Math.PI);
    op1.steerTo(v(-1.9, 0, -23.4), 1.45);
    const player: PlayerTarget = { feet: v(0, -50, 200), head: v(0, -48, 200), chest: v(0, -49, 200), velocity: v(0, 0, 0), sprinting: false, crouching: false, alive: false };
    I = { lead, ops: [op1, op2], heli, rotor, nav, beam, search, rope, wash, washSeed: seed, motes, player };
  },
  update(ctx) {
    const s = I!;
    const t = ctx.t;
    const dt = ctx.dt;
    // Aircraft + searchlight sweep.
    const hp = heliAt(t);
    s.heli.position.copy(hp);
    s.heli.rotation.z = Math.sin(t * 0.5) * 0.03;
    s.rotor.rotation.z += dt * 40;
    s.nav.visible = Math.floor(t * 1.4) % 2 === 0;
    const aim = v(Math.sin(t * 0.55) * 7 - 1, 0, -19 + Math.cos(t * 0.37) * 4);
    if (t > DESC0 - 1 && t < DESC1 + 1) aim.lerp(LAND, 0.75);
    s.search.position.copy(hp).add(v(-1.6, -1.2, 0));
    s.search.target.position.copy(aim);
    s.search.target.updateMatrixWorld();
    s.beam.position.copy(s.search.position);
    const dir = aim.clone().sub(s.search.position);
    const len = dir.length();
    s.beam.scale.set(len / 16, len / 16, len / 16);
    s.beam.quaternion.setFromUnitVectors(v(0, -1, 0), dir.normalize());
    // Rope from the cabin to the deck while the lead is on it, then it swings up with the aircraft.
    const top = hp.clone().add(v(-0.6, -1.3, 0.4));
    const bottom = t < DESC1 + 1.2 ? LAND.clone().add(v(0.15, 0, 0.1)) : top.clone().add(v(0.4, -6, 0.3));
    s.rope.visible = t > DESC0 - 2.5 && t < LIFT + 2.5;
    s.rope.position.lerpVectors(top, bottom, 0.5);
    s.rope.scale.set(1, top.distanceTo(bottom), 1);
    s.rope.quaternion.setFromUnitVectors(v(0, 1, 0), top.clone().sub(bottom).normalize());
    // Wash: radial outward flow under the aircraft, stronger when low.
    const a = s.wash.geometry.getAttribute('position') as THREE.BufferAttribute;
    const strength = 1 - smoothstep(Math.max(0, (t - LIFT) / 4));
    for (let i = 0; i < a.count; i++) {
      const ang = s.washSeed[i * 3] + t * 0.15;
      const r = ((s.washSeed[i * 3 + 1] + t * (0.08 + 0.1 * s.washSeed[i * 3 + 2]) * strength) % 1) * 18 + 0.5;
      a.setXYZ(i, hp.x + Math.cos(ang) * r, 0.03 + s.washSeed[i * 3 + 2] * 0.5 * (1 - r / 19), hp.z + 2 + Math.sin(ang) * r);
    }
    a.needsUpdate = true;
    s.motes.tick(t * 3);

    // Operators.
    const [op1, op2] = s.ops;
    if (t > 1.2 && !(op2 as unknown as { _go?: boolean })._go) {
      op2.steerTo(v(2.0, 0, -23.8), 1.6);
      (op2 as unknown as { _go: boolean })._go = true;
    }
    const mates = [s.lead, op1, op2];
    const face = v(0, 1.4, 0);
    op1.update(dt, s.player, mates, face && op1.pathDone ? face : null, 'low', false);
    op2.update(dt, s.player, mates, face && op2.pathDone ? face : null, 'low', false);
    // Lead: on the rope (hopY), lands, waits, hears the beep at 10.2, turns a few degrees, rifle up.
    const h = t < DESC0 ? ROPE_TOP : t < DESC1 ? ROPE_TOP * (1 - smoothstep((t - DESC0) / (DESC1 - DESC0)) ** 0.8) : 0;
    (s.lead as unknown as { hopY: number }).hopY = h;
    const leadFace = t > 10.2 ? v(LAND.x + 7, 1.5, LAND.z + 9) : v(LAND.x, 1.5, LAND.z + 10);
    s.lead.update(dt, s.player, mates, leadFace, t > 10.6 ? 'ready' : 'low', false);
  },
  cams: {
    // B01: lens on the deck, operators walk past.
    boot: (ctx) => ({ pos: v(-0.55, 0.07, -14.4).add(handheld(ctx.t, 0.001, 1)), target: v(-1.4, 0.32, -17.8), lens: 24 }),
    // B02: hip-height, tracking behind operator 2.
    track: (ctx) => {
      const o = I!.ops[1];
      return { pos: o.pos.clone().add(v(-0.7, 1.05, 1.7)).add(handheld(ctx.t, 0.015, 2)), target: o.pos.clone().add(v(0.3, 1.1, -1.5)), lens: 35 };
    },
    // B03: low wide tilting up into the searchlight and the silhouette.
    tilt: (ctx) => ({
      pos: v(3.4, 0.5, -12).add(handheld(ctx.t, 0.01, 3)),
      target: lerpV(ctx.t, [[1.0, v(-1, 1, -21)], [4.5, heliAt(ctx.t).add(v(0, -2, 0))]]),
      lens: 24,
    }),
    // B04: 50 mm on gloves and rope as the lead slides down, tilting toward the boots.
    rope: (ctx) => {
      const L = I!.lead;
      const hy = (L as unknown as { hopY: number }).hopY;
      const y = Math.max(0.5, hy + 1.6 - ease(ctx.t, [[4.6, 0], [5.8, 1.2]]));
      return { pos: v(L.pos.x + 1.5, y + 0.15, L.pos.z + 1.6).add(handheld(ctx.t, 0.004, 4)), target: v(L.pos.x, y, L.pos.z), lens: 50 };
    },
    // B05: low, locked on the landing spot.
    land: (ctx) => ({ pos: v(1.6, 0.25, -18.6).add(handheld(ctx.t, 0.002, 5)), target: v(0, 0.35, -21), lens: 35 }),
    // B06: 85 mm crane up from the torso to the mask.
    crane: (ctx): CameraState => {
      const L = I!.lead;
      const k = ease(ctx.t, [[6.2, 0], [8.4, 1]]);
      return { pos: v(L.pos.x + 0.55, 1.05 + k * 0.62, L.pos.z + 1.7).add(handheld(ctx.t, 0.003, 6)), target: v(L.pos.x, 1.15 + k * 0.5, L.pos.z), lens: 85 };
    },
    // B07: 100 mm ECU on the respirator.
    mask: (ctx) => {
      const L = I!.lead;
      const f = v(Math.sin(L.yaw), 0, Math.cos(L.yaw));
      const r = v(Math.cos(L.yaw), 0, -Math.sin(L.yaw));
      const headY = 1.5;
      return { pos: L.pos.clone().addScaledVector(f, 0.62).addScaledVector(r, 0.22).setY(headY + 0.02).add(handheld(ctx.t, 0.0015, 7)), target: L.pos.clone().addScaledVector(f, 0.06).setY(headY), lens: 100 };
    },
    // B08: low wide frontal, lead foreground, team behind, aircraft lifting away.
    team: (ctx) => ({ pos: v(1.6, 0.55, -16.2).add(handheld(ctx.t, 0.008, 8)), target: v(-0.3, 2.6, -23), lens: 28 }),
    // B10: profile on the lead: head turn, rifle up.
    turn: (ctx) => {
      const L = I!.lead;
      return { pos: v(L.pos.x - 1.7, 1.55, L.pos.z + 1.1).add(handheld(ctx.t, 0.003, 9)), target: v(L.pos.x, 1.45, L.pos.z + 0.2), lens: 85 };
    },
  },
  post: (_ctx, cam) => ({
    exposure: cam === 'mask' || cam === 'crane' ? 0.85 : 1.15,
    contrast: 1.18,
    saturation: 0.75,
    bloom: { strength: 0.85, radius: 0.65, threshold: 0.8 },
    dof: cam === 'mask' ? { focus: 0.58, aperture: 0.05, maxblur: 0.016 } : cam === 'crane' || cam === 'turn' ? { focus: 1.9, aperture: 0.02, maxblur: 0.012 } : cam === 'rope' ? { focus: 2.2, aperture: 0.015, maxblur: 0.01 } : null,
  }),
};
