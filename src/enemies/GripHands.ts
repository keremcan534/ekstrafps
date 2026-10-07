import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Gloved hands already closed round a gun, for the third-person soldiers (their models have
 * no finger bones: their own hands are folded away and these sit on the gun, see Soldier and
 * GunGrips). Built from capsules and a rounded block, ~1k triangles each, in the gun rig's
 * frame (barrel towards −z, up +y, the gun's right side +x), origin on the grip point.
 *
 *   firing   on the pistol grip: back of the hand on the right side, four fingers wrapping
 *            round the front of the grip (the index finger reaching for the trigger), the
 *            thumb over the left side.
 *   support  under the handguard: palm under it, fingers wrapping up the far (right) side,
 *            the thumb along the near (left) side.
 */

const R = 0.0095; // finger radius
const RADIAL = 6;

function capsule(a: THREE.Vector3, b: THREE.Vector3, r = R): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.001, d.length());
  const g = new THREE.CapsuleGeometry(r, len, 2, RADIAL);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function block(size: [number, number, number], at: [number, number, number]): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(...size) * 0.45);
  g.translate(...at);
  return g;
}

/** A finger from its knuckle: `segs` points, joined by capsules. */
function finger(points: [number, number, number][], r = R): THREE.BufferGeometry[] {
  const v = points.map((p) => new THREE.Vector3(...p));
  const out: THREE.BufferGeometry[] = [];
  for (let i = 1; i < v.length; i++) out.push(capsule(v[i - 1], v[i], r * (1 - i * 0.06)));
  return out;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

let firing: THREE.BufferGeometry | null = null;
let support: THREE.BufferGeometry | null = null;

/** The firing hand round a pistol grip (grip roughly along y, its front towards −z). */
export function firingHand(): THREE.BufferGeometry {
  if (firing) return firing;
  const parts: THREE.BufferGeometry[] = [];
  // Back of the hand on the right of the grip, the wrist running back and up.
  parts.push(block([0.026, 0.09, 0.075], [0.03, -0.005, 0.012]));
  // Four fingers, top (index, on the trigger) to bottom: from the knuckles at the front of
  // the back of the hand, round the front of the grip, ending on its left side.
  const rows = [0.03, 0.011, -0.008, -0.027];
  rows.forEach((y, i) => {
    if (i === 0) {
      // Index: straight forward to the trigger, bent at its tip.
      parts.push(...finger([[0.026, y, -0.022], [0.012, y - 0.002, -0.05], [-0.002, y - 0.008, -0.062]]));
      return;
    }
    parts.push(...finger([[0.026, y, -0.022], [0.016, y - 0.002, -0.046], [-0.012, y - 0.004, -0.048], [-0.024, y - 0.004, -0.03]], R * (i === 3 ? 0.88 : 1)));
  });
  // Thumb: from the heel of the hand over the top of the grip, down the left side.
  parts.push(...finger([[0.022, 0.035, 0.03], [0.0, 0.05, 0.012], [-0.022, 0.045, -0.012]], R * 1.1));
  // Wrist cuff back to where the sleeve ends.
  parts.push(capsule(new THREE.Vector3(0.03, 0.0, 0.04), new THREE.Vector3(0.034, 0.012, 0.095), 0.021));
  const g = merged(parts);
  // Sits a little behind the grip point: the fingers wrap the grip, not the trigger guard.
  g.translate(0, 0, 0.018);
  return (firing = g);
}

/** The support hand under a handguard (handguard along z). */
export function supportHand(): THREE.BufferGeometry {
  if (support) return support;
  const parts: THREE.BufferGeometry[] = [];
  // Palm under the handguard, the wrist back towards the shooter.
  parts.push(block([0.07, 0.026, 0.085], [-0.004, -0.032, 0.006]));
  // Fingers up the far (right) side, spread along the handguard.
  const cols = [-0.034, -0.014, 0.006, 0.024];
  cols.forEach((z, i) => {
    parts.push(...finger([[0.028, -0.028, z], [0.036, -0.004, z - 0.002], [0.03, 0.018, z - 0.004]], R * (i === 3 ? 0.88 : 1)));
  });
  // Thumb along the near (left) side, pointing forward.
  parts.push(...finger([[-0.032, -0.03, 0.03], [-0.036, -0.012, 0.0], [-0.032, 0.0, -0.03]], R * 1.1));
  // Wrist cuff back and down towards the forearm.
  parts.push(capsule(new THREE.Vector3(-0.01, -0.036, 0.04), new THREE.Vector3(-0.016, -0.05, 0.095), 0.021));
  return (support = merged(parts));
}
