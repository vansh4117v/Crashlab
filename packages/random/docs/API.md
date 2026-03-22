# @simnode/random — API Reference

## Responsibility

Provides seeded, deterministic pseudo-random number generation via the **mulberry32** algorithm. Used to make `Math.random()`, `crypto.randomBytes()`, and `crypto.randomUUID()` fully reproducible — the same seed always produces the same sequence, eliminating flakiness from random values in tests.

---

## Classes

### `SeededRandom`

High-level RNG with utility helpers. One instance per simulation run, seeded from the scenario seed.

#### Constructor

```ts
new SeededRandom(seed: number)
```

---

#### Value Generation

| Method | Returns | Description |
|--------|---------|-------------|
| `next()` | `number` | Next float in `[0, 1)` |
| `intBetween(min, max)` | `number` | Integer in `[min, max]` inclusive |
| `pick(arr)` | `T` | Random element from an array |
| `shuffle(arr)` | `T[]` | New array with Fisher-Yates shuffle applied |

**Example:**
```ts
const rng = new SeededRandom(42);
rng.next();           // 0.6235... (always the same for seed 42)
rng.intBetween(1, 6); // dice roll
rng.pick(['a','b','c']); // random element
rng.shuffle([1,2,3,4]); // shuffled copy
```

---

#### Global Patching

#### `rng.install(): void`

Replace `Math.random` and `crypto.randomBytes` globally with this PRNG. Called automatically by `installDeterminismPatches()` in the simulation worker.

#### `rng.uninstall(): void`

Restore the originals. Called in the worker's `finally` block.

---

## Functions

### `mulberry32(seed: number): () => number`

Returns a raw PRNG function that generates floats in `[0, 1)`. The underlying algorithm for all determinism in SimNode.

```ts
import { mulberry32 } from '@simnode/random';
const rng = mulberry32(12345);
rng(); // 0.4242... 
rng(); // 0.7891...
```

### `patchMathRandom<T>(seed, fn): T`

Run a function with `Math.random` temporarily replaced by a seeded PRNG. Restores the original when done.

```ts
import { patchMathRandom } from '@simnode/random';
const id = patchMathRandom(42, () => generateRandomId());
// generateRandomId() used the seeded PRNG, not crypto random
```
