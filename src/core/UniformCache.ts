import type * as THREE from 'three';
import { clipVersion } from './LightClip';
import { foldTableVersion } from '../world/MaterialFold';

type Setter = { setValue(gl: WebGL2RenderingContext, v: unknown, textures?: unknown): void };
/** A node of three's uniform tree: a single uniform (addr, cache) or a struct / array of them (seq). */
type Node = Setter & { id: string | number; addr?: WebGLUniformLocation; cache?: number[]; seq?: Node[] };

const done = new WeakSet<object>();

/** The light structs whose colours are compared as the GPU holds them (float32), and those colours. */
const LIGHT_STRUCTS = new Set(['hemisphereLights', 'directionalLights', 'pointLights', 'spotLights', 'rectAreaLights']);
const LIGHT_COLOURS = new Set(['skyColor', 'groundColor', 'color']);

/**
 * three's vec3 setter compares the doubles it was last given, but a GL program holds float32:
 * a light whose intensity eases towards its target (Site-9's skylight fill, the gun's light)
 * changes by less than a float32 step for many seconds and was re-sent to every lit program
 * each frame, the same float32 every time. This one compares and sends the float32 values
 * (what WebGL would round the doubles to): it skips exactly the sends that change nothing.
 */
function setColour32(this: Node, gl: WebGL2RenderingContext, v: { r: number; g: number; b: number } | { x: number; y: number; z: number } | ArrayLike<number>): void {
  const c = this.cache!;
  let r: number, g: number, b: number;
  // As three's own vec3 setter: a colour, a vector or (the ambient light) a plain [r, g, b].
  if ((v as { r?: number }).r !== undefined) {
    const col = v as { r: number; g: number; b: number };
    r = Math.fround(col.r);
    g = Math.fround(col.g);
    b = Math.fround(col.b);
  } else if ((v as { x?: number }).x !== undefined) {
    const vec = v as { x: number; y: number; z: number };
    r = Math.fround(vec.x);
    g = Math.fround(vec.y);
    b = Math.fround(vec.z);
  } else {
    const a = v as ArrayLike<number>;
    r = Math.fround(a[0]);
    g = Math.fround(a[1]);
    b = Math.fround(a[2]);
  }
  if (c[0] === r && c[1] === g && c[2] === b) return;
  gl.uniform3f(this.addr!, r, g, b);
  c[0] = r;
  c[1] = g;
  c[2] = b;
}

/** Every light colour under a light struct (any depth) takes the float32 compare. */
function colours32(n: Node): void {
  if (n.seq) for (const c of n.seq) colours32(c);
  else if (LIGHT_COLOURS.has(String(n.id)) && n.cache) n.setValue = setColour32 as Setter['setValue'];
}

/**
 * Textures many programs read the same one of: three's DFG lookup (every lit material), the
 * grime texture, the batches' tables and the stand-ins' bone texture. three hands texture units
 * out per draw from 0 up in its program's sampler order, so the same texture landed on unit 1
 * for one program and on unit 3 for the next and was bound again and again (the DFG lookup ~18
 * times a frame). Each now has a unit of its own at the top of the range (three hands out a
 * dozen at most here), where a draw finds it still bound. Which unit a sampler reads from
 * changes nothing it reads. Units counted down from the last: index = from the top.
 */
const PINNED: Record<string, number> = { dfgLUT: 1, boneTexture: 2, sbTex: 3, rbTex: 4, grimeMap: 5 };
/** The skinned stand-ins' bone texture (every copy's bones, core/SkinnedBatch): a unit apart from the single skeletons'. */
const ATLAS = 6;

type Textures = { setTexture2D(t: THREE.Texture, slot: number): void };

function pinTo(unit: number, own: Setter['setValue']): Setter['setValue'] {
  return function (this: Node, gl, v, textures) {
    // No texture: three's own (its empty stand-in, on a unit of the draw's).
    if (!v) return own.call(this, gl, v, textures);
    const c = this.cache!;
    if (c[0] !== unit) {
      gl.uniform1i(this.addr!, unit);
      c[0] = unit;
    }
    (textures as Textures).setTexture2D(v as THREE.Texture, unit);
  };
}

/**
 * three compares its single uniforms with what it last sent, but sends arrays every time a
 * material's uniforms go out (each switch of material, the lights with each switch of
 * program). Here that was the light probe's nine vectors (flattened into a scratch array
 * first) and the light clip rooms (core/LightClip, 1 KB), dozens of times a frame, though
 * they change a few times a minute. A GL program keeps its uniform values, so each program
 * gets them only when they differ from what it last got.
 *
 * Once a frame before rendering: patches the programs compiled since (a program still
 * compiling waits: its uniform table would block on the compile).
 */
export function cacheUniforms(renderer: THREE.WebGLRenderer): void {
  for (const p of renderer.info.programs ?? []) {
    if (done.has(p)) continue;
    if (!(p as { isReady?: () => boolean }).isReady?.()) continue;
    done.add(p);
    const map = (p.getUniforms() as unknown as { map: Record<string, Setter | undefined> }).map;
    // The clip rooms: by version (0 = no limits; a new one whenever the rooms change).
    for (const u of [map.clipPoint, map.clipSpot]) {
      if (!u) continue;
      const send = u.setValue;
      let held = -1;
      u.setValue = function (gl, v, textures) {
        const now = clipVersion();
        if (held === now) return;
        held = now;
        send.call(this, gl, v, textures);
      };
    }
    // A fold's material table (world/MaterialFold): by its version (it changes when a lamp dims or flickers).
    const fold = map.foldTab;
    if (fold) {
      const send = fold.setValue;
      let held = -1;
      let heldTab: unknown = null;
      fold.setValue = function (gl, v, textures) {
        const now = foldTableVersion(v);
        if (held === now && heldTab === v && now >= 0) return;
        held = now;
        heldTab = v;
        send.call(this, gl, v, textures);
      };
    }
    // The light probe: nine Vector3s, compared (as float32, what the program holds) with the last ones sent.
    const probe = map.lightProbe;
    if (probe) {
      const send = probe.setValue;
      const held = new Float32Array(27).fill(NaN);
      probe.setValue = function (gl, v, textures) {
        const sh = v as THREE.Vector3[];
        let same = sh.length === 9;
        for (let i = 0; i < 9 && i < sh.length; i++) {
          const k = i * 3;
          const c = sh[i];
          const x = Math.fround(c.x);
          const y = Math.fround(c.y);
          const z = Math.fround(c.z);
          if (held[k] !== x || held[k + 1] !== y || held[k + 2] !== z) {
            same = false;
            held[k] = x;
            held[k + 1] = y;
            held[k + 2] = z;
          }
        }
        if (!same) send.call(this, gl, v, textures);
      };
    }
    // Light colours (and the ambient's): float32 compares.
    for (const n of (p.getUniforms() as unknown as { seq: Node[] }).seq) {
      if (LIGHT_STRUCTS.has(String(n.id))) colours32(n);
      else if (n.id === 'ambientLightColor' && n.cache) n.setValue = setColour32 as Setter['setValue'];
    }
    // Shared textures on units of their own.
    const top = renderer.capabilities.maxTextures;
    for (const [name, k] of Object.entries(PINNED)) {
      const u = map[name] as Node | undefined;
      if (u && u.cache && !u.seq) u.setValue = pinTo(top - (name === 'boneTexture' && map.sbTex ? ATLAS : k), u.setValue);
    }
  }
}
