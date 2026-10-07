import * as THREE from 'three';

/**
 * Lights stop at walls. None of the point or spot lights casts shadows (a shadow-casting point
 * light is six depth renders a frame), so a lamp lit the room behind the wall as if it weren't
 * there. Site-9's rooms are rectangles: each light gets the floor plan of the room it is in, and
 * every lit material fades its contribution out within FADE m past that room's walls (the wall's
 * far face already faces away from it; what leaked was the floor and everything deeper in).
 * Through a doorway the light spills a little and fades, rather than stopping on a line.
 *
 * Built into three's shared shader chunks, so every lit material gets it, whatever its own
 * onBeforeCompile does. The rectangles live in two Float32Arrays that three shares by reference
 * across materials (arrays of vectors it would copy per material). An empty rectangle (all
 * zero, also what a material without these uniforms reads) means "no limit".
 */

const MAX = 32;
/** How far past its room's walls a light fades to nothing (m). */
const FADE = 0.3;

/** x0, z0, x1, z1 per light, in three's light order (see sync). */
export const clipPoint = new Float32Array(MAX * 4);
export const clipSpot = new Float32Array(MAX * 4);

let installed = false;

export function installLightClip(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.common += '\nvarying vec3 vClipWorld;\n';
  C.project_vertex += `
vec4 clipWp = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	clipWp = batchingMatrix * clipWp;
#endif
#ifdef USE_INSTANCING
	clipWp = instanceMatrix * clipWp;
#endif
vClipWorld = ( modelMatrix * clipWp ).xyz;
`;
  C.lights_pars_begin += `
uniform vec4 clipPoint[ ${MAX} ];
uniform vec4 clipSpot[ ${MAX} ];
float lightRoomMask( const in vec4 r ) {
	if ( r.z <= r.x ) return 1.0;
	vec2 p = vClipWorld.xz;
	vec2 d = max( r.xy - p, p - r.zw );
	return 1.0 - smoothstep( 0.0, ${FADE.toFixed(2)}, max( d.x, d.y ) );
}
`;
  C.lights_fragment_begin = C.lights_fragment_begin
    .replace(
      'getPointLightInfo( pointLight, geometryPosition, directLight );',
      'getPointLightInfo( pointLight, geometryPosition, directLight );\n\t\tdirectLight.color *= lightRoomMask( clipPoint[ i ] );',
    )
    .replace(
      'getSpotLightInfo( spotLight, geometryPosition, directLight );',
      'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= lightRoomMask( clipSpot[ i ] );',
    );
  const L = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const k of ['standard', 'physical', 'lambert', 'phong', 'toon']) {
    if (!L[k]) continue;
    L[k].uniforms.clipPoint = { value: clipPoint };
    L[k].uniforms.clipSpot = { value: clipSpot };
  }
}

const points: THREE.PointLight[] = [];
const spots: THREE.SpotLight[] = [];
const rect = new THREE.Vector4();
const at = new THREE.Vector3();
/** three's own light order: shadow casters first, then ones with a light map (stable sort). */
const order = (a: THREE.Light, b: THREE.Light): number =>
  (b.castShadow ? 2 : 0) - (a.castShadow ? 2 : 0) + ((b as THREE.SpotLight).map ? 1 : 0) - ((a as THREE.SpotLight).map ? 1 : 0);

/**
 * Before the world render: each point / spot light's room, in the order three will upload
 * them (the scene's visible lights in traversal order, sorted as WebGLLights does).
 * `room(x, z, out)`: the floor plan rectangle there, false for none (outside: no limit).
 * `free`: lights never limited (the player's flashlight, which casts a real shadow).
 */
export function syncLightClip(scene: THREE.Scene, room: (x: number, z: number, out: THREE.Vector4) => boolean, free?: THREE.Light): void {
  points.length = spots.length = 0;
  scene.traverseVisible((o) => {
    if ((o as THREE.PointLight).isPointLight) points.push(o as THREE.PointLight);
    else if ((o as THREE.SpotLight).isSpotLight) spots.push(o as THREE.SpotLight);
  });
  points.sort(order);
  spots.sort(order);
  fill(clipPoint, points, room, free);
  fill(clipSpot, spots, room, free);
}

/** After the world render: other scenes (the gun in your hands) are lit without limits. */
export function clearLightClip(): void {
  clipPoint.fill(0);
  clipSpot.fill(0);
}

function fill(out: Float32Array, lights: THREE.Light[], room: (x: number, z: number, out: THREE.Vector4) => boolean, free?: THREE.Light): void {
  out.fill(0);
  for (let i = 0; i < Math.min(MAX, lights.length); i++) {
    const l = lights[i];
    if (l === free || l.intensity <= 0) continue;
    l.getWorldPosition(at);
    if (!room(at.x, at.z, rect)) continue;
    out[i * 4] = rect.x;
    out[i * 4 + 1] = rect.y;
    out[i * 4 + 2] = rect.z;
    out[i * 4 + 3] = rect.w;
  }
}
