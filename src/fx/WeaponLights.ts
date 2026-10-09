import * as THREE from 'three';

/**
 * Weapon-mounted lights for SABLE operators. Every operator carries a
 * visible beam (a soft additive cone: cheap, readable from across a dark hall);
 * the few operators nearest the camera also get a real spot light from a fixed
 * pool, so the floor and walls light up where they look. The pool never grows or
 * shrinks (changing the light count would recompile every shader mid-fight).
 */

/** 0..1: how dark it is (the game sets it each frame; beams fade in with it). */
export const weaponLight = { level: 0 };

const beamGeo = (() => {
  const g = new THREE.ConeGeometry(1, 1, 24, 1, true);
  g.translate(0, -0.5, 0); // tip at the origin, opening along -Y
  g.rotateX(-Math.PI / 2); // open along +Z (the rifle's forward)
  return g;
})();

export function makeBeam(): THREE.Mesh & { setStrength(v: number): void } {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    // Additive: order-free, so one pass instead of three's back-then-front pair.
    forceSinglePass: true,
    fog: false,
    uniforms: { color: { value: new THREE.Color(0xdfe9ff) }, strength: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vZ = position.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color; uniform float strength;
      varying vec3 vN; varying vec3 vV; varying float vZ;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
        float along = smoothstep(0.0, 0.06, vZ) * pow(1.0 - clamp(vZ, 0.0, 1.0), 1.6);
        gl_FragColor = vec4(color * facing * along * strength, 1.0);
      }`,
  });
  const m = new THREE.Mesh(beamGeo, mat) as unknown as THREE.Mesh & { setStrength(v: number): void };
  m.scale.set(1.5, 1.5, 15); // 15 m throw, ~3 m wide at the end
  m.frustumCulled = false;
  m.renderOrder = 5;
  m.setStrength = (v) => (mat.uniforms.strength.value = v);
  return m;
}

export interface LightSource {
  readonly lit: boolean;
  lightOrigin(out: THREE.Vector3): THREE.Vector3;
  lightDir(out: THREE.Vector3): THREE.Vector3;
}

/** Everyone currently carrying a weapon light (SABLE operators register themselves). */
export const lightSources = new Set<LightSource>();

export class WeaponLights {
  readonly group = new THREE.Group();
  private lights: THREE.SpotLight[] = [];
  private tmp = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.SpotLight(0xe8f0ff, 0, 34, 0.3, 0.55, 1.15);
      l.castShadow = false;
      this.group.add(l, l.target);
      this.lights.push(l);
    }
  }

  update(camera: THREE.Vector3): void {
    const level = weaponLight.level;
    const near = [...lightSources].filter((s) => s.lit);
    near.sort((a, b) => a.lightOrigin(this.tmp).distanceToSquared(camera) - b.lightOrigin(this.dir).distanceToSquared(camera));
    this.lights.forEach((l, i) => {
      const s = near[i];
      if (!s || level < 0.05) {
        l.intensity = 0;
        return;
      }
      s.lightOrigin(l.position);
      s.lightDir(this.dir);
      l.target.position.copy(l.position).addScaledVector(this.dir, 10);
      l.target.updateMatrixWorld();
      l.intensity = 60 * level;
    });
  }
}
