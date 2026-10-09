import type * as THREE from 'three';
import { clipVersion } from './LightClip';

type Setter = { setValue(gl: WebGL2RenderingContext, v: unknown, textures?: unknown): void };

const done = new WeakSet<object>();

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
    // The light probe: nine Vector3s, compared with the last ones sent.
    const probe = map.lightProbe;
    if (probe) {
      const send = probe.setValue;
      const held = new Float64Array(27).fill(NaN);
      probe.setValue = function (gl, v, textures) {
        const sh = v as THREE.Vector3[];
        let same = sh.length === 9;
        for (let i = 0; i < 9 && i < sh.length; i++) {
          const k = i * 3;
          const c = sh[i];
          if (held[k] !== c.x || held[k + 1] !== c.y || held[k + 2] !== c.z) {
            same = false;
            held[k] = c.x;
            held[k + 1] = c.y;
            held[k + 2] = c.z;
          }
        }
        if (!same) send.call(this, gl, v, textures);
      };
    }
  }
}
