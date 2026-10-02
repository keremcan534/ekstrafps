/**
 * Trailer capture only (?trailer): makes takes repeatable. Imported first by
 * main.ts so every module sees it. Math.random becomes a seeded PRNG (?seed=N)
 * and performance.now() reads a virtual clock the director advances per frame.
 */
export const trailerMode = new URLSearchParams(location.search).has('trailer');

let virtualMs = 0;

export function setVirtualTime(ms: number): void {
  virtualMs = ms;
}

export function reseed(seed: number): void {
  state = seed >>> 0 || 1;
}

let state = 1;

if (trailerMode) {
  reseed(Number(new URLSearchParams(location.search).get('seed') ?? 9));
  // mulberry32
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const realNow = performance.now.bind(performance);
  let virtual = false;
  performance.now = () => (virtual ? virtualMs : realNow());
  (window as unknown as { __trailerClock: (on: boolean) => void }).__trailerClock = (on) => (virtual = on);
}
