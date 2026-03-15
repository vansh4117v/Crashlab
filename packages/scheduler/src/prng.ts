/**
 * Mulberry32 — fast 32-bit seeded PRNG.
 * Returns a function yielding numbers in [0, 1).
 *
 * This is a self-contained fallback so `@simnode/scheduler` has zero
 * hard dependencies.  If `@simnode/random` is available in the monorepo,
 * consumers can pass their own SeededRandom instead.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher-Yates shuffle using a seeded PRNG.
 * Mutates `arr` in place and returns it.
 */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
