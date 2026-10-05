import * as THREE from 'three';

/**
 * Thermal camera pass (trailer only, render only): bodies read hot, the world cold, smoke
 * gone (thermal sees through it). Swaps the scene's materials once, the first time the
 * thermal camera renders; a capture run renders a single camera, so nothing else sees it.
 * The white-hot grade, noise and HUD are added in post (tools/fx.py thermal()).
 */

const done = new WeakSet<THREE.Scene>();

export function thermalPass(scene: THREE.Scene, hot: THREE.Object3D[]): void {
  if (done.has(scene)) return;
  done.add(scene);
  const hotSet = new Set<THREE.Object3D>();
  for (const h of hot) h.traverse((o) => hotSet.add(o));
  // Bodies: hot and self-lit (a little shading so the shapes read). Guns and gear cooler.
  const skin = new THREE.MeshLambertMaterial({ color: 0x555555, emissive: 0xcfcfcf });
  const gear = new THREE.MeshLambertMaterial({ color: 0x444444, emissive: 0x6a6a6a });
  // The world: cold, only shaped by the lights (lamps stay warm spots).
  const cold = new THREE.MeshLambertMaterial({ color: 0x2c2c2c });
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
      o.visible = false; // smoke, dust, sparks
      return;
    }
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material & { transparent?: boolean; blending?: number };
    if (mat && (mat.blending === THREE.AdditiveBlending || (mat.transparent && (mat as THREE.MeshBasicMaterial).opacity < 0.6))) {
      // Muzzle flashes stay (hot); beams and haze cones go.
      if (!hotSet.has(o)) o.visible = false;
      return;
    }
    if (hotSet.has(o)) {
      const name = (o.parent?.name ?? '') + o.name;
      m.material = /rifle|gun|weapon|mag|barrel/i.test(name) ? gear : skin;
    } else m.material = cold;
  });
  scene.fog = new THREE.FogExp2(0x101010, 0.012);
}
