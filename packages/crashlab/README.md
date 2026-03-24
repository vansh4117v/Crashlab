# CrashLab — Deterministic Simulation Testing for Node.js

**Find 1-in-a-million race conditions in milliseconds, not months.**

CrashLab runs your application code inside a fully controlled simulation: virtual time, seeded randomness, and deterministic I/O scheduling. Every concurrency bug that would normally require weeks of load testing to surface can be reproduced on demand, debugged with a single seed, and guarded against regression forever.

---

## The Problem with Conventional Testing

Imagine a payment handler:

```typescript
async function charge(userId: string, amount: number) {
  const balance = await db.query('SELECT balance FROM accounts WHERE id = $1', [userId]);
  if (balance.rows[0].balance < amount) throw new Error('Insufficient funds');
  await stripe.charge(userId, amount);               // ~200ms network call
  await db.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, userId]);
}
```

A **double-payment race condition** is buried here. Two concurrent requests both read the same balance, both pass the guard, and both charge the card — but only one debits the account. This bug requires two requests to arrive within a ~200ms window. In a Jest or Vitest test suite, your async calls resolve sequentially; the window never opens and the test always passes.

**CrashLab compresses virtual time and shuffles I/O resolution order.** Across 1,000 seeds it explores every possible interleaving of those two awaits. Seed 847 opens the exact window. You get a failing test, a full timeline, and a replay command — before this ships.

---

## Example

**`scenarios/charge.scenario.ts`** — the file your team ships alongside the code:

```typescript
import type { SimEnv } from 'crashlab';

export default async function chargeScenario(env: SimEnv) {
  // Mock Stripe: 200ms virtual latency, deterministic response
  env.http.mock('POST https://api.stripe.com/v1/charges', {
    status: 200,
    body: JSON.stringify({ id: 'ch_sim', status: 'succeeded' }),
    latency: 200,
  });

  // Seed Postgres with a user who has $100
  env.pg.seedData('accounts', [{ id: 'user_1', balance: 100 }]);
  await env.pg.ready();

  // Fire two concurrent charge requests at the same virtual instant
  const req = () =>
    fetch('http://localhost:3000/charge', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user_1', amount: 100 }),
    });

  const [r1, r2] = await Promise.all([req(), req()]);

  // Advance virtual clock past the Stripe latency — both callbacks resolve
  await env.clock.advance(250);

  const result = await env.pg.query<{ balance: number }>(
    'SELECT balance FROM accounts WHERE id = $1', ['user_1']
  );

  env.timeline.record({
    timestamp: env.clock.now(),
    type: 'ASSERT',
    detail: `final balance: ${result.rows[0].balance}`,
  });

  // The balance must be 0 — any other value is a double-charge
  if (result.rows[0].balance !== 0) {
    throw new Error(`Double charge detected! Balance is ${result.rows[0].balance}, expected 0`);
  }
}
```

**`crashlab.config.js`** — wire it to the harness:

```javascript
import { Simulation } from 'crashlab';
import { resolve } from 'node:path';

const sim = new Simulation({ timeout: 15_000 });

sim.scenario('double charge guard', resolve('./scenarios/charge.scenario.ts'));

export default sim;
```

---

## How It Works — The Three Pillars

### 1. Virtual Clock
`Date.now()`, `performance.now()`, `setTimeout`, and `setInterval` are replaced with a fully controllable `VirtualClock`. Time only moves when you call `env.clock.advance(ms)`. A scenario that would take 200ms in production takes **0 wall-clock milliseconds** in simulation.

### 2. Seeded PRNG
`Math.random()` and `crypto.randomBytes()` are replaced with a deterministic Mulberry32-based generator seeded per-run. Given the same seed, every random value produced during the scenario is identical — every time, on every machine.

### 3. I/O Scheduler
Concurrent `await` calls that resolve at the same virtual timestamp are queued and **shuffled by the seed** before being delivered. Seed 0 might resolve DB-then-Stripe. Seed 847 resolves Stripe-then-DB. Running 1,000 seeds explores 1,000 distinct interleavings of every concurrent I/O operation in your code.

These three pillars together mean: **if a race condition is possible, a seed will find it.**

---

## CLI Usage

CrashLab has two operating modes and a replay command:

| | `run` | `hunt` |
|---|---|---|
| **What you specify** | Seed count | Time budget |
| **When it stops** | After N seeds (or first failure by default) | On first failure or timeout |
| **What it outputs** | Pass/fail summary with counts | Live per-seed status, full failure report |
| **Memory** | Only failures retained | Never accumulates passing results |
| **When to use** | CI / regression suites | Local debugging, "find me a bug" sessions |

---

### `crashlab run` — fixed seed count, CI mode

```sh
npx crashlab run --seeds=1000
```

Stops at the **first failure** by default (`stopOnFirstFailure: true`). To collect all failures across all seeds:

```sh
npx crashlab run --seeds=1000 --stop-on-first-failure=false
```

**Output:**
```
✗ [seed=847] double charge guard: Double charge detected! Balance is 100, expected 0
  Timeline:
    [0ms]    START: Scenario: double charge guard, seed: 847
    [0ms]    DB:    SELECT balance → 100  (request A)
    [0ms]    DB:    SELECT balance → 100  (request B)
    [200ms]  HTTP:  POST /v1/charges → succeeded  (request A)
    [200ms]  HTTP:  POST /v1/charges → succeeded  (request B)
    [200ms]  DB:    UPDATE balance = 0  (request A)
    [200ms]  DB:    UPDATE balance = 0  (request B)
    [200ms]  ASSERT: final balance: 100
    [200ms]  FAIL:  Double charge detected! Balance is 100, expected 0

0/1000 passed, 1 failed
```

---

### `crashlab hunt` — time-budget mode, local debugging

Hunt mode runs as many seeds as it can fit within a time budget and stops the moment it finds a failure. There is no seed count — just run until you find something.

```sh
npx crashlab hunt ./scenarios/charge.scenario.ts
npx crashlab hunt ./scenarios/charge.scenario.ts --timeout=10m
```

Duration format: `30s` | `5m` | `1h`. Default: `5m`.

**Live output:**
```
Hunting: charge.scenario.ts  (timeout: 5m)

[OK  ] Seed 482910341
[OK  ] Seed 482910342
[OK  ] Seed 482910343
[FAIL] Seed 482910344

────────────────────────────────────────────────────────────
FAILURE FOUND after 4 seeds in 2s
  Scenario : charge.scenario
  Seed     : 482910344
  Error    : Double charge detected! Balance is 100, expected 0

Timeline:
  [0ms]  START: ...
  ...

Replay command:
  crashlab replay --seed=482910344 --scenario="charge.scenario" --config=crashlab.config.js
```

If no failure is found within the budget:
```
No failure found after 1247 seeds in 5m 0s (timeout after 5m 0s).
Your scenario may be correct, or the bug requires a specific condition not yet explored.
```

Press **Ctrl+C** to stop early — CrashLab finishes the current seed, discards its result (it may have been interrupted mid-flight), and exits cleanly with code `0`:
```
No failure found after 1247 seeds in 2m 14s (interrupted by Ctrl+C).
```

---

### `crashlab replay` — reproduce a specific failure

```sh
npx crashlab replay --seed=847 --scenario="double charge guard"
```

> [!TIP]
> **The same seed always produces the same failure.** You can share `--seed=847` with a colleague, add it to a CI regression suite, or step through it in a debugger. The entire execution is deterministic.

---

### `sim.run()` API — programmatic use

```typescript
// Default: stop on first failure, only store failing results
const result = await sim.run({ seeds: 1000 });
// result.passed    → boolean
// result.passes    → number of seeds that passed
// result.failures  → ScenarioResult[] (only failures; passing results are not retained)

// Opt out of early stop to collect all failures
const result = await sim.run({ seeds: 1000, stopOnFirstFailure: false });

// Replay always returns the full result regardless of pass/fail
const replay = await sim.replay({ seed: 847, scenario: 'double charge guard' });
// replay.passed    → boolean
// replay.result    → ScenarioResult (always present, including timeline)
```

### Custom config path

```sh
npx crashlab run --config=./tests/sim/crashlab.config.js --seeds=500
```

---

## Installation

### Batteries-included (recommended)

```sh
npm install --save-dev crashlab
```

`crashlab` includes every mock: Postgres (PGlite), MongoDB (MongoMemoryServer), Redis (ioredis-mock), HTTP, TCP, virtual clock, PRNG, filesystem. Install this and you are done.

### À la carte

If you only need a subset of the mocks — say, virtual time and HTTP interception with no database overhead — install the lightweight engine and only the layers you need:

```sh
npm install --save-dev @crashlab/core @crashlab/clock @crashlab/http-proxy
```

`@crashlab/core` ships the `Simulation` class, CLI runner, and worker engine. It has **no dependency on PGlite, MongoDB, or Redis**. Mocks that are not installed simply appear as `null` on `env.pg`, `env.redis`, and `env.mongo`.

Available sub-packages:

| Package | What it provides |
|---|---|
| `@crashlab/core` | `Simulation` class, CLI, worker engine |
| `@crashlab/clock` | `VirtualClock` |
| `@crashlab/random` | `SeededRandom` |
| `@crashlab/scheduler` | `Scheduler` |
| `@crashlab/http-proxy` | `HttpInterceptor` |
| `@crashlab/tcp` | `TcpInterceptor` |
| `@crashlab/filesystem` | `VirtualFS` |
| `@crashlab/pg-mock` | `PgMock` (PGlite) |
| `@crashlab/redis-mock` | `RedisMock` (ioredis-mock) |
| `@crashlab/mongo` | `MongoMock` (MongoMemoryServer) |

---

## Support Matrix

| Protocol / Driver | CrashLab Support | Notes |
|---|---|---|
| **PostgreSQL** | ✅ Full | PGlite in-process — wire-protocol compatible |
| **MongoDB** | ✅ Full | Proxied to MongoMemoryServer per-run |
| **Redis** | ✅ Full | In-process RESP protocol handler |
| **HTTP / Fetch** | ✅ Full | `http.request`, `https.request`, `globalThis.fetch` |
| **Prisma** | ✅ Compatible | Loopback TCP servers on 5432 / 27017 / 6379 |
| **ioredis / mongoose / pg** | ✅ Compatible | Client-side module patch — zero config |
| **MySQL** | ❌ Not supported | Port 3306 throws `CrashLabUnsupportedProtocolError` in v1.0 |

> [!NOTE]
> **Prisma compatibility:** CrashLab binds real loopback TCP servers on 127.0.0.1:5432, :6379, and :27017, so Prisma's out-of-process Rust query engine connects to the same mocks as your in-process drivers. If a real database is running on those ports, CrashLab records a `WARNING` in the timeline and falls back to the client-side interceptor.

---

## Honest Limitations

CrashLab is precise about what it controls. Senior engineers deserve a straight answer:

| Limitation | Reason |
|---|---|
| **Native C++ addons** | Native code runs outside the V8 sandbox. `require('better-sqlite3')` or `bcrypt` bypass all module patches. Use pure-JS alternatives in scenarios, or wrap them in an HTTP service that CrashLab can mock. |
| **Engine-level microtask interleaving** | V8's microtask queue is not observable from userland. CrashLab controls macro-task and I/O scheduling; it cannot reorder `Promise.resolve()` chains that don't yield to the event loop. |
| **`worker_threads` spawned by your app** | Child workers inherit real globals, not CrashLab's patched ones. Scenarios should avoid code paths that spawn workers; use the simulation environment's own concurrency tools instead. |
| **True wall-clock timers** | Any library that calls the real `setTimeout` before CrashLab installs its patch (e.g. at module evaluation time) will use real time. Import order matters. |

---

## Scenario API Reference

```typescript
import type { SimEnv } from 'crashlab';

export default async function myScenario(env: SimEnv) {
  env.clock         // VirtualClock — advance(), now(), setTimeout(), setInterval()
  env.random        // SeededRandom — next() → [0,1), nextInt(n)
  env.scheduler     // Scheduler — enqueueCompletion(), runTick()
  env.http          // HttpInterceptor — mock(), calls, unmatched handling
  env.tcp           // TcpInterceptor — mock(), addLocalServer()
  env.pg            // PgMock — seedData(), query(), ready(), createHandler()
  env.redis         // RedisMock — seedData(), createHandler()
  env.mongo         // MongoMock — find(), drop(), createHandler()
  env.fs            // VirtualFS — readFileSync(), writeFileSync(), existsSync()
  env.faults        // FaultInjector — diskFull(), clockSkew(), networkPartition()
  env.timeline      // Timeline — record({ timestamp, type, detail })
  env.seed          // number — the current run's seed value
}
```

---

## Architecture

### Package split

```
npm install crashlab             ← batteries-included (re-exports @crashlab/core + all mocks)
npm install @crashlab/core         ← lightweight engine only (no PGlite / MongoDB / Redis)
```

`@crashlab/core` declares the heavy mock packages as **optional peer dependencies**. If they are not installed `env.pg`, `env.redis`, and `env.mongo` are `null`. The `crashlab` wrapper lists them as required dependencies, guaranteeing they are always present.

### Runtime flow

```
Simulation.run({ seeds: N })          ← lives in @crashlab/core
│
├─ _startMongo()                      → MongoMemoryServer (skipped if not installed)
│
└─ for each seed × scenario
   └─ Worker thread (isolated globals)
      ├─ createEnv(seed)              → VirtualClock, PRNG, Scheduler, lightweight mocks
      │   ├─ try import('@crashlab/pg-mock')    → PgMock  | null
      │   ├─ try import('@crashlab/redis-mock') → RedisMock | null
      │   └─ try import('@crashlab/mongo')      → MongoMock | null
      ├─ install patches              → Date.now, Math.random, net.createConnection, fetch
      ├─ import(scenario)             → dynamic ES module load (file-based)
      ├─ await scenarioFn(env)
      ├─ timeline.toString()          → posted to parent
      └─ finally: uninstall patches, drop mongo db, worker.terminate()
```

Each worker is fully isolated. Patches applied inside one worker never leak to the main thread or sibling workers. After `run()` returns there are zero zombie workers and zero mongod instances.

---

## Contributing

```sh
git clone https://github.com/your-org/crashlab
npm install
npm run build
npm test           # vitest — 176 tests
```

All packages live under `packages/`. The monorepo uses npm workspaces + tsup for building. PRs must pass `npm test` with zero failures.

### Releasing

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing. All packages are versioned together (fixed group).

```sh
# 1. Describe your change (prompts for bump type + summary)
npx changeset

# 2. Apply version bumps — updates all package.json versions and cross-package pins
npm run version

# 3. Build and publish to npm
npm run release
```

---

## License

MIT
