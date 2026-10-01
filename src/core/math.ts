export const DEG = Math.PI / 180;

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const saturate = (v: number): number => clamp(v, 0, 1);

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
};

export const smoothstep = (t: number): number => {
  const x = saturate(t);
  return x * x * (3 - 2 * x);
};

export const randRange = (min: number, max: number): number => min + Math.random() * (max - min);
export const randSign = (): number => (Math.random() < 0.5 ? -1 : 1);

/** Map t from [a,b] to [0,1], clamped. Handy for procedural animation phases. */
export const phase = (t: number, a: number, b: number): number => saturate((t - a) / (b - a));

/** Smooth 0 -> 1 -> 0 bump over [a, b]. */
export const bump = (t: number, a: number, b: number): number => {
  const p = phase(t, a, b);
  return Math.sin(p * Math.PI);
};

/**
 * FOV values in configs are HORIZONTAL degrees at 16:9 (like most PC shooters).
 * Three.js wants vertical FOV; wider screens (phones) then get more horizontal view (Hor+).
 */
export const hfovToVfov = (hfovDeg: number): number =>
  (2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / (16 / 9))) / DEG;

/**
 * Phone/tablet detection. Touchscreen laptops also report touch support, so a
 * device with ANY fine pointer (mouse/trackpad) is treated as a PC; `?mouse`
 * forces PC mode, `?touch` forces touch mode (handled by the caller).
 */
export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(location.search).has('mouse')) return false;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return hasTouch && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
};
