import * as THREE from 'three';
import type { Game } from '../../../src/core/Game';
import { feel } from '../../../src/config/Feel';
import { smoothstep } from '../../../src/core/math';

/** Keyframe helpers for camera moves: [t, value] pairs, smoothstep between keys. */
export function ease(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + (v1 - v0) * smoothstep((t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

export function lerpV(t: number, keys: [number, THREE.Vector3][], out = new THREE.Vector3()): THREE.Vector3 {
  if (t <= keys[0][0]) return out.copy(keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1];
      const [t1, b] = keys[i];
      return out.lerpVectors(a, b, smoothstep((t - t0) / (t1 - t0)));
    }
  }
  return out.copy(keys[keys.length - 1][1]);
}

/**
 * Operator-style camera breathing: a sum of slow incommensurate sines (repeatable,
 * no RNG), amplitude in metres. Real handheld, not shake.
 */
export function handheld(t: number, amp: number, seed = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const s = seed * 1.7;
  return out.set(
    (Math.sin(t * 0.83 + s) * 0.6 + Math.sin(t * 2.11 + s * 2.3) * 0.3 + Math.sin(t * 4.7 + s) * 0.1) * amp,
    (Math.sin(t * 0.67 + s * 1.3) * 0.6 + Math.sin(t * 1.93 + s) * 0.3 + Math.sin(t * 5.3 + s * 0.7) * 0.1) * amp,
    (Math.sin(t * 0.51 + s * 0.4) * 0.5 + Math.sin(t * 1.37 + s * 1.9) * 0.5) * amp * 0.5,
  );
}

/**
 * A black stage: the map, its lights, sky and fog are hidden; lab robots and the
 * Black Division squad are hidden and their AI is off. Shots build their own set.
 */
export function blackStage(game: Game): THREE.Group {
  game.arena.group.visible = false;
  game.scene.background = new THREE.Color(0x000000);
  game.scene.fog = null;
  game.scene.environmentIntensity = 0.03;
  feel.enemyAI = false;
  feel.godMode = true;
  for (const r of game.robots) r.root.visible = false;
  for (const sq of game.squads) for (const s of sq.soldiers) s.body.root.visible = false;
  const set = new THREE.Group();
  set.name = 'trailer-set';
  game.scene.add(set);
  return set;
}

/** Slowly drifting dust motes (additive, tiny), visible where it's dark enough to read. */
export function dust(count: number, size: THREE.Vector3, center: THREE.Vector3, opacity = 0.35): THREE.Points & { tick(t: number): void } {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * size.x;
    pos[i * 3 + 1] = (Math.random() - 0.5) * size.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * size.z;
    seed[i] = Math.random() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  const mat = new THREE.PointsMaterial({ color: 0xb8c4cc, size: 0.0035, sizeAttenuation: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(geo, mat) as unknown as THREE.Points & { tick(t: number): void };
  pts.position.copy(center);
  pts.frustumCulled = false;
  pts.tick = (t) => {
    const a = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const s = seed[i];
      a.setXYZ(
        i,
        pos[i * 3] + Math.sin(t * 0.21 + s) * 0.02 + t * 0.004,
        pos[i * 3 + 1] + Math.sin(t * 0.17 + s * 1.3) * 0.015 - t * 0.003,
        pos[i * 3 + 2] + Math.cos(t * 0.19 + s * 0.7) * 0.02,
      );
    }
    a.needsUpdate = true;
  };
  return pts;
}
