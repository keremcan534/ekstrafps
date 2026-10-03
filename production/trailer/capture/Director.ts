import * as THREE from 'three';
import type { FrameDirector, Game } from '../../../src/core/Game';
import type { Input } from '../../../src/core/Input';
import { Post, type PostSettings } from './Post';
import { setVirtualTime } from './determinism';
import edl from '../edl.json';
import { SHOTS } from './shots';

/**
 * Trailer capture director (?trailer=<SHOT>).
 *
 *   ?trailer=A03                 preview the shot (runs once, R replays)
 *   ?trailer=A03&capture         render every frame on a fixed clock and save it
 *                                to trailer/frames/A03/ through the dev server
 *   ?trailer=A02,A03,A04&capture render a batch: each shot reloads the page for the next
 *   &res=720|1080|1440|2160      output size (default 1080)   &fps=60
 *
 * Shots run in their own local time: t = 0 is the shot's in-point in edl.json,
 * with `handles` seconds of extra frames before and after for the edit.
 */

export interface CameraState {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** Full-frame-equivalent focal length (mm). */
  lens: number;
  roll?: number;
}

export interface ShotCtx {
  game: Game;
  /** Seconds from the shot's in-point (negative inside the head handle). */
  t: number;
  dt: number;
  /** Shot duration from edl.json (seconds). */
  duration: number;
  /** Trailer time of the shot's in-point. */
  tIn: number;
  post: Post;
  /** Convert a trailer time (edl marker) to this shot's local time. */
  local(T: number): number;
}

export interface Shot {
  /** Which map the shot is staged on (the URL must match). */
  map: 'lab' | 'site9';
  /** Render the first-person weapon layer (gameplay shots). */
  firstPerson?: boolean;
  /** Seconds simulated before the head handle starts recording (settling). */
  preroll?: number;
  /** Extra frames before/after the edl duration, seconds (default 0.25). */
  handles?: number;
  /** Override the edl duration (e.g. shots not in the edl yet). */
  duration?: number;
  setup(ctx: ShotCtx): void | Promise<void>;
  /** Per frame, after the gameplay camera, before render. */
  update?(ctx: ShotCtx): void;
  /** Cinematic camera (ignored for firstPerson shots). */
  camera?(ctx: ShotCtx): CameraState;
  /** Scripted gameplay input (written after the real input is read). */
  input?(ctx: ShotCtx, input: Input): void;
  post?(ctx: ShotCtx, cam?: string): Partial<PostSettings>;
  /** Last-moment scene tweaks right before each camera renders (after the game's own update). */
  beforeRender?(ctx: ShotCtx, cam?: string): void;
  /**
   * Multi-camera take: every frame of one simulation is rendered from each camera
   * and saved to frames/<ID>-<cam>/. 'pov' is the real gameplay view (viewmodel on top).
   */
  cams?: Record<string, ((ctx: ShotCtx) => CameraState) | 'pov'>;
  /** Camera damping time constant (s) for take cameras: an operator, not a mount bolted to the subject. Default 0.45. */
  smooth?: number;
}

const SENSOR_W = 36;

export function lensToVfov(mm: number, aspect: number): number {
  const h = 2 * Math.atan(SENSOR_W / 2 / mm);
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}

interface SoundEvent {
  t: number;
  name: string;
  volume: number;
  distance: number | null;
}

class Director implements FrameDirector {
  ctx: ShotCtx;
  events: SoundEvent[] = [];
  private up = new THREE.Vector3(0, 1, 0);
  /** Gameplay camera as the game computed it this frame (restored for 'pov'). */
  private gp = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 70, near: 0.05 };
  /** Damped state per take camera (position + aim point), advanced once per rendered frame. */
  private damped = new Map<string, { pos: THREE.Vector3; target: THREE.Vector3; lens: number }>();
  frameDt = 1 / 60;

  constructor(private game: Game, private shot: Shot, post: Post, tIn: number, duration: number) {
    this.ctx = { game, t: 0, dt: 0, duration, tIn, post, local: (T) => T - tIn };
  }

  input(input: Input, dt: number): void {
    this.ctx.dt = dt;
    this.shot.input?.(this.ctx, input);
  }

  afterCamera(): void {
    const { shot, ctx, game } = this;
    const cam = game.camera.camera;
    this.gp.pos.copy(cam.position);
    this.gp.quat.copy(cam.quaternion);
    this.gp.fov = cam.fov;
    this.gp.near = cam.near;
    shot.update?.(ctx);
    if (shot.cams) return;
    if (!shot.firstPerson && shot.camera) this.applyCamera(shot.camera(ctx));
    ctx.post.set(shot.post?.(ctx) ?? {});
  }

  private applyCamera(c: CameraState): void {
    const cam = this.game.camera.camera;
    cam.position.copy(c.pos);
    cam.up.copy(this.up);
    cam.lookAt(c.target);
    if (c.roll) cam.rotateZ(c.roll);
    cam.fov = lensToVfov(c.lens, cam.aspect);
    cam.near = 0.01;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /**
   * Advance take camera `name`'s operator damping by one simulation frame (also on
   * frames a partial capture does not render, so its framing matches a full capture).
   */
  trackCam(name: string): { pos: THREE.Vector3; target: THREE.Vector3; lens: number; roll?: number } | null {
    const c = this.shot.cams![name];
    if (c === 'pov') return null;
    const want = c(this.ctx);
    const d = this.damped.get(name);
    const tau = this.shot.smooth ?? 0.45;
    if (!d || tau <= 0) this.damped.set(name, { pos: want.pos.clone(), target: want.target.clone(), lens: want.lens });
    else {
      const k = 1 - Math.exp(-this.frameDt / tau);
      d.pos.lerp(want.pos, k);
      d.target.lerp(want.target, k * 0.8);
      d.lens += (want.lens - d.lens) * k;
    }
    return { ...this.damped.get(name)!, roll: want.roll };
  }

  /** Multi-camera take: render camera `name` for the current simulation frame. */
  renderCam(name: string, track = true): void {
    const { shot, ctx, game } = this;
    const c = shot.cams![name];
    const cam = game.camera.camera;
    if (c === 'pov') {
      cam.position.copy(this.gp.pos);
      cam.quaternion.copy(this.gp.quat);
      cam.fov = this.gp.fov;
      cam.near = this.gp.near;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    } else {
      const s2 = track ? this.trackCam(name)! : { ...this.damped.get(name)!, roll: c(ctx).roll };
      this.applyCamera({ pos: s2.pos, target: s2.target, lens: s2.lens, roll: s2.roll });
    }
    shot.beforeRender?.(ctx, name);
    ctx.post.set(shot.post?.(ctx, name) ?? {});
    const layers: { scene: THREE.Scene; camera: THREE.Camera }[] = [{ scene: game.scene, camera: cam }];
    if (c === 'pov' && !game.health.dead) layers.push({ scene: game.weapons.viewmodel.scene, camera: game.weapons.viewmodel.camera });
    ctx.post.render(layers);
  }

  render(): boolean {
    if (this.shot.cams) return true;
    const g = this.game;
    const layers: { scene: THREE.Scene; camera: THREE.Camera }[] = [{ scene: g.scene, camera: g.camera.camera }];
    if (this.shot.firstPerson) layers.push({ scene: g.weapons.viewmodel.scene, camera: g.weapons.viewmodel.camera });
    this.ctx.post.render(layers);
    return true;
  }
}

const RES: Record<string, [number, number]> = { '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440], '2160': [3840, 2160] };

export async function runTrailer(game: Game): Promise<void> {
  const params = new URLSearchParams(location.search);
  const queue = (params.get('trailer') ?? '').split(',').filter(Boolean);
  const id = queue[0] ?? '';
  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;font:12px monospace;color:#9a9;background:#000a;padding:4px 8px;pointer-events:none';
  document.body.appendChild(status);
  const shot = SHOTS[id];
  if (!shot) {
    status.textContent = `unknown shot "${id}". available: ${Object.keys(SHOTS).join(' ')}`;
    return;
  }
  const mapNow = params.get('map') === 'site9' ? 'site9' : 'lab';
  // Site-9 takes run in solo mode (no AI teams racing around the facility).
  if (shot.map === 'site9' && params.get('mode') !== 'solo') {
    params.set('mode', 'solo');
    params.set('map', 'site9');
    location.search = params.toString();
    return;
  }
  if (shot.map !== mapNow) {
    if (shot.map === 'lab') params.delete('map');
    else params.set('map', shot.map);
    location.search = params.toString();
    return;
  }
  const row = (edl.shots as [string, number, number, ...unknown[]][]).find((s) => s[0] === id);
  const tIn = row ? row[1] : 0;
  const duration = shot.duration ?? (row ? row[2] - row[1] : 4);
  const handles = shot.handles ?? 0.25;
  const capture = params.has('capture');
  const fps = Number(params.get('fps') ?? 60);
  const [w, h] = RES[params.get('res') ?? '1080'] ?? RES['1080'];

  // Clean frame: no HUD, no CSS grain/vignette (the post chain does it), no overlay.
  for (const sel of ['.ui-layer', '.post-fx', '.post-vignette', '.overlay', '.menu', '.rotate-hint']) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => (el.style.display = 'none'));
  }
  const r = game.renderer;
  const fit = () => {
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    Object.assign(r.domElement.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      width: `min(100vw, ${(100 * w) / h}vh)`, height: 'auto', aspectRatio: `${w}/${h}`,
    });
    game.camera.camera.aspect = w / h;
    game.camera.camera.updateProjectionMatrix();
    game.weapons.viewmodel.setAspect(w / h);
  };
  fit();
  window.addEventListener('resize', () => setTimeout(fit, 0));

  const post = new Post(r, w, h, game.scene, game.camera.camera);
  const director = new Director(game, shot, post, tIn, duration);
  game.director = director;
  (window as unknown as { __trailerClock: (on: boolean) => void }).__trailerClock(true);

  // Sound-event log for the offline mix (the browser plays nothing during capture).
  const audio = game.audio as unknown as { play: (name: string, opts?: { volume?: number; position?: THREE.Vector3 }) => unknown };
  const play = audio.play.bind(audio);
  audio.play = (name, opts) => {
    if (director.ctx.t >= -handles) {
      director.events.push({
        t: +director.ctx.t.toFixed(4),
        name,
        volume: opts?.volume ?? 1,
        distance: opts?.position ? +opts.position.distanceTo(game.camera.camera.position).toFixed(2) : null,
      });
    }
    return play(name, opts);
  };

  await shot.setup(director.ctx);

  const dtMs = 1000 / fps;
  director.frameDt = 1 / fps;
  let now = 10_000;
  const step = (t: number) => {
    director.ctx.t = t;
    now += dtMs;
    setVirtualTime(now);
    game.stepFrame(now);
  };
  const pre = shot.preroll ?? 0.5;
  const first = -handles - pre;
  const total = Math.round((duration + 2 * handles) * fps);
  const preFrames = Math.round(pre * fps);
  for (let i = 0; i < preFrames; i++) step(first + i / fps);

  const grab = () => new Promise<Blob>((res) => r.domElement.toBlob((b) => res(b!), 'image/jpeg', 0.93));
  const camNames = shot.cams ? Object.keys(shot.cams).filter((c) => !params.get('cams') || params.get('cams')!.split('.').includes(c)) : [];
  if (capture) {
    // Partial captures (software rendering is slow): every frame is still simulated,
    // but only frames inside &win=a-b,c-d (take seconds) or on every Nth frame
    // (&every=N, a sparse overview for contact sheets) are rendered and saved, under
    // their real frame index. &keep adds to the folder instead of clearing it.
    const wins = (params.get('win') ?? '').split(',').filter(Boolean).map((w) => w.split(/(?<=\d)-/).map(Number) as [number, number]);
    const every = Number(params.get('every') ?? 0);
    const wanted = (i: number) => {
      if (!wins.length && !every) return true;
      const t = -handles + i / fps;
      return (every > 0 && i % every === 0) || wins.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6);
    };
    const outs = shot.cams ? camNames.map((c) => `${id}-${c}`) : [id];
    if (!params.has('keep')) for (const o of outs) await fetch(`/__trailer/clear?shot=${o}`, { method: 'POST' });
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      step(-handles + i / fps);
      if (!wanted(i)) {
        if (shot.cams) for (const c of camNames) director.trackCam(c);
        if (i % 60 === 0) status.textContent = `${id} simulating ${i + 1}/${total}`;
        continue;
      }
      if (shot.cams) {
        for (const c of camNames) {
          director.renderCam(c);
          const blob = await grab();
          await fetch(`/__trailer/frame?shot=${id}-${c}&i=${i}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        }
      } else {
        const blob = await grab();
        await fetch(`/__trailer/frame?shot=${id}&i=${i}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      }
      status.textContent = `${id} capturing ${i + 1}/${total}`;
    }
    const meta = { shot: id, fps, w, h, handles, duration, tIn, frames: total, events: director.events };
    await fetch(`/__trailer/file?name=events/${id}.json`, { method: 'POST', body: JSON.stringify(meta, null, 1) });
    status.textContent = `${id} DONE ${total} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    (window as unknown as { __trailerDone: boolean }).__trailerDone = true;
    if (queue.length > 1) {
      params.set('trailer', queue.slice(1).join(','));
      location.search = params.toString();
    }
    return;
  }

  // Preview: real-time playback of the same fixed-step frames, then hold. R replays.
  let i = 0;
  // &at=<seconds>: simulate up to that moment, then hold the frame (framing checks).
  const holdAt = params.has('at') ? Number(params.get('at')) : Infinity;
  const tick = () => {
    if (i < total && -handles + i / fps <= holdAt) {
      step(-handles + i / fps);
      if (shot.cams) director.renderCam(params.get('cam') ?? camNames[0]);
      status.textContent = `${id}  t ${(-handles + i / fps).toFixed(2)}s  (${i + 1}/${total})  [R replay]`;
      i++;
    }
    requestAnimationFrame(tick);
  };
  window.addEventListener('keydown', (e) => e.code === 'KeyR' && location.reload());
  (window as unknown as { __trailerSeek: (t: number) => void }).__trailerSeek = (t) => {
    // Jump forward (simulating every frame on the way, so physics stays real).
    const cn = params.get('cam') ?? camNames[0];
    while (i < total && -handles + i / fps < t) {
      step(-handles + i++ / fps);
      if (shot.cams && -handles + i / fps < t) director.trackCam(cn);
    }
    if (shot.cams) director.renderCam(cn);
  };
  tick();
}
