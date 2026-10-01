import * as THREE from 'three';
import { bulletHoleTexture, metalDentTexture } from './Textures';

/**
 * Bullet marks on static world geometry. One InstancedMesh per mark type,
 * used as a ring buffer (oldest marks get recycled). 2 draw calls total.
 */
class DecalSet {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private used = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);
  private spin = new THREE.Quaternion();

  constructor(texture: THREE.Texture, capacity: number, private baseSize: number) {
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: 0.6,
      metalness: 0.3,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 1;
  }

  add(point: THREE.Vector3, normal: THREE.Vector3, scale: number): void {
    this.q.setFromUnitVectors(this.z, normal);
    this.spin.setFromAxisAngle(this.z, Math.random() * Math.PI * 2);
    this.q.multiply(this.spin);
    this.p.copy(point).addScaledVector(normal, 0.004);
    const size = this.baseSize * scale * (0.85 + Math.random() * 0.3);
    this.s.set(size, size, size);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.next, this.m);
    this.next = (this.next + 1) % this.mesh.instanceMatrix.count;
    this.used = Math.min(this.used + 1, this.mesh.instanceMatrix.count);
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Decals {
  readonly group = new THREE.Group();
  private hole: DecalSet;
  private dent: DecalSet;

  constructor(capacity: number) {
    this.hole = new DecalSet(bulletHoleTexture(), capacity, 0.09);
    this.dent = new DecalSet(metalDentTexture(), capacity, 0.07);
    this.group.add(this.hole.mesh, this.dent.mesh);
  }

  add(kind: 'hole' | 'dent', point: THREE.Vector3, normal: THREE.Vector3, scale = 1): void {
    (kind === 'hole' ? this.hole : this.dent).add(point, normal, scale);
  }
}
