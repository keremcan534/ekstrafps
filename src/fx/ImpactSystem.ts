import * as THREE from 'three';
import { ParticleSystem, spawnParams } from './Particles';
import { Decals } from './Decals';
import { feel } from '../config/Feel';
import type { SurfaceType } from '../core/Physics';
import type { AudioSystem } from '../audio/AudioSystem';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * All visual + audio feedback that happens out in the world:
 * bullet impacts per surface, tracers, muzzle smoke, robot death bursts.
 */
export class ImpactSystem {
  readonly group = new THREE.Group();
  readonly sparks: ParticleSystem;
  readonly dust: ParticleSystem;
  readonly decals: Decals;
  private sp = spawnParams();
  private refl = new THREE.Vector3();
  private tangentA = new THREE.Vector3();
  private tangentB = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(private audio: AudioSystem, mobile: boolean) {
    this.sparks = new ParticleSystem(mobile ? 700 : 1500, 'additive', 0.55);
    this.dust = new ParticleSystem(mobile ? 400 : 900, 'normal', 0.9);
    this.decals = new Decals(mobile ? 96 : 220);
    this.group.add(this.dust.mesh, this.sparks.mesh, this.decals.group);
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.dust.update(dt);
  }

  /**
   * @param intensity weapon-specific scale (shotgun pellets use < 1 so 10 pellets aren't 10x noise)
   * @param decal whether the surface is static world geometry
   */
  impact(surface: SurfaceType, point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, intensity: number, decal: boolean, playSound = true): void {
    this.refl.copy(dir).addScaledVector(normal, -2 * dir.dot(normal)).normalize();
    this.buildTangents(normal);
    const n = Math.max(0.35, intensity);
    if (intensity > 1.6) {
      // Full-power rifle rounds: bigger burst, chunkier debris and a deep hit sound.
      this.burstChips(point, normal, Math.round(4 * intensity), 0.25, 0.24, 0.23);
      this.burstDust(point, normal, Math.round(2 * intensity), 0.45, 0.43, 0.4);
      this.flash(point, normal, 0.12 * intensity, 1, 0.8, 0.55);
      if (playSound) this.audio.play('impact.heavy', { position: point, volume: Math.min(1, intensity / 2.2) });
    }

    switch (surface) {
      case 'concrete':
        this.burstDust(point, normal, Math.round(4 * n), 0.42, 0.4, 0.38);
        this.burstChips(point, normal, Math.round(5 * n), 0.2, 0.19, 0.18);
        if (Math.random() < 0.35) this.burstSparks(point, 2, 4, 0.6, 1.0, 0.75, 0.4);
        if (decal && feel.decals) this.decals.add('hole', point, normal, 1);
        if (playSound) this.audio.play('impact.concrete', { position: point, volume: 0.6 + 0.4 * Math.min(1, intensity) });
        break;
      case 'metal':
        this.burstSparks(point, Math.round(11 * n), 9, 1.0, 1.0, 0.7, 0.3);
        this.flash(point, normal, 0.16, 1, 0.8, 0.5);
        this.burstDust(point, normal, 1, 0.3, 0.3, 0.32);
        if (decal && feel.decals) this.decals.add('dent', point, normal, 1);
        if (playSound) this.audio.play('impact.metal', { position: point, volume: 0.7 + 0.3 * Math.min(1, intensity) });
        break;
      case 'robot':
        this.burstSparks(point, Math.round(9 * n), 8, 1.0, 0.65, 0.2, 0.3);
        this.burstSparks(point, Math.round(3 * n), 5, 0.6, 0.85, 1.0, 0.25);
        this.flash(point, normal, 0.18, 1, 0.6, 0.25);
        this.burstDust(point, normal, Math.round(2 * n), 0.12, 0.12, 0.13);
        if (playSound) this.audio.play('impact.robot', { position: point });
        break;
      case 'robotWeak':
        this.burstSparks(point, Math.round(18 * n), 11, 0.6, 0.95, 1.0, 0.35);
        this.burstSparks(point, Math.round(8 * n), 7, 1.0, 1.0, 0.75, 0.3);
        this.flash(point, normal, 0.38, 0.7, 0.95, 1.0);
        this.burstDust(point, normal, Math.round(3 * n), 0.1, 0.1, 0.12);
        if (playSound) this.audio.play('impact.robotweak', { position: point });
        break;
    }
  }

  /** Bullet skipping off a hard surface: bright streak of sparks + whine. */
  ricochet(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3): void {
    this.refl.copy(dir).addScaledVector(normal, -2 * dir.dot(normal)).normalize();
    this.burstSparks(point, 7, 12, 1.0, 0.9, 0.6, 0.25);
    this.flash(point, normal, 0.1, 1, 0.85, 0.6);
    this.audio.play('impact.ricochet', { position: point });
  }

  /** World-space muzzle blast: burning powder sparks + a brief bright core. */
  muzzleBlast(pos: THREE.Vector3, forward: THREE.Vector3, scale: number): void {
    if (scale <= 0.3) return;
    const p = this.sp;
    const n = Math.round(3 + 5 * scale);
    for (let i = 0; i < n; i++) {
      const s = rand(6, 22) * Math.min(1.5, scale);
      p.x = pos.x + forward.x * 0.04;
      p.y = pos.y + forward.y * 0.04;
      p.z = pos.z + forward.z * 0.04;
      p.vx = (forward.x + rand(-0.25, 0.25)) * s;
      p.vy = (forward.y + rand(-0.2, 0.3)) * s;
      p.vz = (forward.z + rand(-0.25, 0.25)) * s;
      p.life = rand(0.04, 0.14);
      p.size = rand(0.006, 0.012);
      p.sizeEnd = 0.003;
      p.stretch = 0.01;
      p.r = 1;
      p.g = rand(0.65, 0.85);
      p.b = 0.35;
      p.alpha = 1;
      p.gravity = 4;
      p.drag = 4;
      this.sparks.spawn(p);
    }
    p.x = pos.x + forward.x * 0.12 * scale;
    p.y = pos.y + forward.y * 0.12 * scale;
    p.z = pos.z + forward.z * 0.12 * scale;
    p.vx = p.vy = p.vz = 0;
    p.life = 0.045;
    p.size = 0.22 * scale;
    p.sizeEnd = 0.1 * scale;
    p.stretch = 0;
    p.r = 1;
    p.g = 0.78;
    p.b = 0.45;
    p.alpha = 0.85;
    p.gravity = 0;
    p.drag = 0;
    this.sparks.spawn(p);
  }

  muzzleSmoke(pos: THREE.Vector3, forward: THREE.Vector3, amount: number): void {
    if (amount <= 0) return;
    const p = this.sp;
    const count = amount >= 1 ? 2 : Math.random() < amount ? 1 : 0;
    for (let i = 0; i < count; i++) {
      p.x = pos.x + forward.x * 0.05;
      p.y = pos.y + forward.y * 0.05;
      p.z = pos.z + forward.z * 0.05;
      p.vx = forward.x * rand(0.4, 1.0) + rand(-0.1, 0.1);
      p.vy = forward.y * rand(0.4, 1.0) + rand(0.15, 0.35);
      p.vz = forward.z * rand(0.4, 1.0) + rand(-0.1, 0.1);
      p.life = rand(0.6, 1.1);
      p.size = 0.04;
      p.sizeEnd = rand(0.22, 0.32);
      p.stretch = 0;
      p.r = p.g = p.b = 0.72;
      p.alpha = 0.07 * Math.min(1.5, amount + 0.5);
      p.gravity = -0.15;
      p.drag = 2.5;
      this.dust.spawn(p);
    }
  }

  /** Big electric burst when a robot dies. */
  robotDeath(point: THREE.Vector3): void {
    this.burstSparks(point, 40, 9, 1.0, 0.7, 0.25, 0.6);
    this.burstSparks(point, 20, 7, 0.6, 0.9, 1.0, 0.5);
    this.flash(point, this.tmp.set(0, 1, 0), 0.9, 1, 0.75, 0.4);
    const p = this.sp;
    for (let i = 0; i < 8; i++) {
      p.x = point.x + rand(-0.2, 0.2);
      p.y = point.y + rand(-0.2, 0.3);
      p.z = point.z + rand(-0.2, 0.2);
      p.vx = rand(-0.8, 0.8);
      p.vy = rand(0.4, 1.4);
      p.vz = rand(-0.8, 0.8);
      p.life = rand(0.9, 1.6);
      p.size = 0.15;
      p.sizeEnd = rand(0.7, 1.0);
      p.stretch = 0;
      p.r = p.g = p.b = rand(0.1, 0.18);
      p.alpha = 0.45;
      p.gravity = -0.4;
      p.drag = 1.8;
      this.dust.spawn(p);
    }
  }

  // --- building blocks ---

  private buildTangents(n: THREE.Vector3): void {
    this.tangentA.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    this.tangentB.crossVectors(n, this.tangentA);
  }

  private burstSparks(point: THREE.Vector3, count: number, speed: number, r: number, g: number, b: number, life: number): void {
    const p = this.sp;
    for (let i = 0; i < count; i++) {
      // Mostly along the reflection, widely scattered.
      const s = speed * rand(0.35, 1.2);
      p.vx = (this.refl.x + rand(-0.9, 0.9)) * s;
      p.vy = (this.refl.y + rand(-0.5, 1.1)) * s;
      p.vz = (this.refl.z + rand(-0.9, 0.9)) * s;
      p.x = point.x;
      p.y = point.y;
      p.z = point.z;
      p.life = life * rand(0.4, 1.1);
      p.size = rand(0.008, 0.016);
      p.sizeEnd = 0.004;
      p.stretch = 0.012;
      p.r = r;
      p.g = g;
      p.b = b;
      p.alpha = 1;
      p.gravity = 9.5;
      p.drag = 2.2;
      this.sparks.spawn(p);
    }
  }

  private flash(point: THREE.Vector3, normal: THREE.Vector3, size: number, r: number, g: number, b: number): void {
    const p = this.sp;
    p.x = point.x + normal.x * 0.03;
    p.y = point.y + normal.y * 0.03;
    p.z = point.z + normal.z * 0.03;
    p.vx = p.vy = p.vz = 0;
    p.life = 0.06;
    p.size = size;
    p.sizeEnd = size * 0.5;
    p.stretch = 0;
    p.r = r;
    p.g = g;
    p.b = b;
    p.alpha = 0.9;
    p.gravity = 0;
    p.drag = 0;
    this.sparks.spawn(p);
  }

  private burstDust(point: THREE.Vector3, normal: THREE.Vector3, count: number, r: number, g: number, b: number): void {
    const p = this.sp;
    for (let i = 0; i < count; i++) {
      const a = rand(-0.6, 0.6);
      const c = rand(-0.6, 0.6);
      const s = rand(0.6, 2.0);
      p.vx = (normal.x + this.tangentA.x * a + this.tangentB.x * c) * s;
      p.vy = (normal.y + this.tangentA.y * a + this.tangentB.y * c) * s;
      p.vz = (normal.z + this.tangentA.z * a + this.tangentB.z * c) * s;
      p.x = point.x + normal.x * 0.02;
      p.y = point.y + normal.y * 0.02;
      p.z = point.z + normal.z * 0.02;
      p.life = rand(0.45, 0.9);
      p.size = rand(0.04, 0.07);
      p.sizeEnd = rand(0.2, 0.32);
      p.stretch = 0;
      p.r = r;
      p.g = g;
      p.b = b;
      p.alpha = 0.32;
      p.gravity = 0.4;
      p.drag = 4;
      this.dust.spawn(p);
    }
  }

  private burstChips(point: THREE.Vector3, normal: THREE.Vector3, count: number, r: number, g: number, b: number): void {
    const p = this.sp;
    for (let i = 0; i < count; i++) {
      const s = rand(2, 4.5);
      p.vx = (normal.x + rand(-0.7, 0.7)) * s;
      p.vy = (normal.y + rand(-0.2, 0.9)) * s;
      p.vz = (normal.z + rand(-0.7, 0.7)) * s;
      p.x = point.x;
      p.y = point.y;
      p.z = point.z;
      p.life = rand(0.35, 0.7);
      p.size = p.sizeEnd = rand(0.012, 0.022);
      p.stretch = 0;
      p.r = r;
      p.g = g;
      p.b = b;
      p.alpha = 1;
      p.gravity = 12;
      p.drag = 0.5;
      this.dust.spawn(p);
    }
  }
}
