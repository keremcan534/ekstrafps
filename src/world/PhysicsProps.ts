import * as THREE from 'three';
import { RAPIER, GROUPS, type Physics, type SurfaceType } from '../core/Physics';

const mats = {
  crate: new THREE.MeshStandardMaterial({ color: 0x8d949e, metalness: 0.1, roughness: 0.75 }),
  crateDark: new THREE.MeshStandardMaterial({ color: 0x4d535b, metalness: 0.2, roughness: 0.7 }),
  barrel: new THREE.MeshStandardMaterial({ color: 0xb8401f, metalness: 0.55, roughness: 0.45 }),
  barrelBlue: new THREE.MeshStandardMaterial({ color: 0x2f5f9e, metalness: 0.55, roughness: 0.45 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa1aa, metalness: 0.9, roughness: 0.3 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5, roughness: 0.6 }),
};

const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
const barrelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 18);

/**
 * Dynamic physics props: cubes, barrels, hanging steel plates / bags.
 * Every prop registers as a hit receiver with its body, so bullets push it.
 */
export class PhysicsProps {
  readonly group = new THREE.Group();
  private ropes: { mesh: THREE.Mesh; anchor: THREE.Vector3; body: RAPIER.RigidBody; local: THREE.Vector3 }[] = [];
  private tmp = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpT = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private physics: Physics) {}

  private dynamicBody(pos: THREE.Vector3, rotY = 0): RAPIER.RigidBody {
    const q = new THREE.Quaternion().setFromAxisAngle(this.up, rotY);
    return this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(q)
        .setLinearDamping(0.05)
        .setAngularDamping(0.15)
        .setCcdEnabled(true),
    );
  }

  private attach(body: RAPIER.RigidBody, desc: RAPIER.ColliderDesc, mesh: THREE.Mesh, surface: SurfaceType): void {
    const col = this.physics.world.createCollider(desc.setCollisionGroups(GROUPS.prop), body);
    this.physics.register(col, { surface, body, allowDecals: false });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const t = body.translation();
    mesh.position.set(t.x, t.y, t.z);
    const r = body.rotation();
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.group.add(mesh);
    this.physics.addSynced(body, mesh);
  }

  cube(pos: THREE.Vector3, size: number, rotY = 0, dark = false): void {
    const body = this.dynamicBody(pos, rotY);
    const mesh = new THREE.Mesh(cubeGeo, dark ? mats.crateDark : mats.crate);
    mesh.scale.setScalar(size);
    // Lighter per volume for big cubes so they still react to gunfire.
    const density = size < 0.6 ? 120 : 80;
    this.attach(body, RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setDensity(density).setFriction(0.7), mesh, 'concrete');
  }

  barrel(pos: THREE.Vector3, blue = false): void {
    const body = this.dynamicBody(pos, Math.random() * Math.PI);
    const mesh = new THREE.Mesh(barrelGeo, blue ? mats.barrelBlue : mats.barrel);
    this.attach(body, RAPIER.ColliderDesc.cylinder(0.45, 0.3).setDensity(110).setFriction(0.6).setRestitution(0.1), mesh, 'metal');
  }

  /** Pyramid stack of small cubes — the shotgun's favourite toy. */
  stack(origin: THREE.Vector3, rows: number, size: number): void {
    for (let row = 0; row < rows; row++) {
      const n = rows - row;
      for (let i = 0; i < n; i++) {
        const x = origin.x + (i - (n - 1) / 2) * (size + 0.01);
        this.cube(new THREE.Vector3(x, origin.y + size / 2 + row * (size + 0.002), origin.z), size, 0, (row + i) % 2 === 1);
      }
    }
  }

  /** Steel gong plate hanging from a hinge: rings and swings when shot. */
  steelPlate(anchor: THREE.Vector3, width = 0.6, height = 0.6, chain = 0.6): void {
    const fixed = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(anchor.x, anchor.y, anchor.z));
    const center = new THREE.Vector3(anchor.x, anchor.y - chain - height / 2, anchor.z);
    const body = this.dynamicBody(center);
    body.setAngularDamping(0.5);
    const mesh = new THREE.Mesh(cubeGeo, mats.steel);
    mesh.scale.set(width, height, 0.03);
    this.attach(body, RAPIER.ColliderDesc.cuboid(width / 2, height / 2, 0.015).setDensity(1200), mesh, 'metal');
    this.physics.world.createImpulseJoint(
      RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: chain + height / 2, z: 0 }, { x: 1, y: 0, z: 0 }),
      fixed,
      body,
      true,
    );
    this.addRope(anchor, body, new THREE.Vector3(0, height / 2, 0));
  }

  /** Barrel hanging on a rope (spherical joint) — a punching bag. */
  hangingBarrel(anchor: THREE.Vector3, length = 1.4): void {
    const fixed = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(anchor.x, anchor.y, anchor.z));
    const pos = new THREE.Vector3(anchor.x, anchor.y - length - 0.45, anchor.z);
    const body = this.dynamicBody(pos);
    const mesh = new THREE.Mesh(barrelGeo, mats.barrelBlue);
    this.attach(body, RAPIER.ColliderDesc.cylinder(0.45, 0.3).setDensity(90), mesh, 'metal');
    this.physics.world.createImpulseJoint(
      RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: length + 0.45, z: 0 }),
      fixed,
      body,
      true,
    );
    this.addRope(anchor, body, new THREE.Vector3(0, 0.45, 0));
  }

  private addRope(anchor: THREE.Vector3, body: RAPIER.RigidBody, local: THREE.Vector3): void {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), mats.rope);
    mesh.castShadow = true;
    this.group.add(mesh);
    this.ropes.push({ mesh, anchor: anchor.clone(), body, local });
  }

  /** Update rope meshes to stretch between anchor and the swinging body. */
  update(): void {
    for (const r of this.ropes) {
      const t = r.body.translation(this.tmpT);
      r.body.rotation(this.tmpQ);
      // World-space attach point on the swinging body.
      this.tmp.copy(r.local).applyQuaternion(this.tmpQ);
      this.tmp.x += t.x;
      this.tmp.y += t.y;
      this.tmp.z += t.z;
      r.mesh.position.copy(r.anchor).add(this.tmp).multiplyScalar(0.5);
      const dir = this.tmp.sub(r.anchor);
      const len = dir.length() || 1;
      r.mesh.scale.set(1, len, 1);
      r.mesh.quaternion.setFromUnitVectors(this.up, dir.divideScalar(len));
    }
  }
}
