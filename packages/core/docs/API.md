# crashlab — API Reference

## Responsibility

The top-level package users install (`npm i crashlab`). It orchestrates the entire simulation lifecycle: spawning isolated worker threads per seed, starting a shared MongoDB memory server, driving the virtual clock, and aggregating pass/fail results. Also ships the `crashlab` CLI binary (`run`, `replay`, `hunt`).

---

## Classes

### `Simulation`

The entry point for all simulation work.

#### Constructor

```ts
new Simulation(opts?: { seed?: number; timeout?: number; workerGrace?: number })
```

| Option | Default | Description |
|--------|---------|-------------|
| `seed` | `0` | Base seed. Each additional seed increments this by 1. |
| `timeout` | `30_000` | Per-scenario timeout in ms before the worker is killed. |
| `workerGrace` | `5_000` | Extra ms the main-thread watchdog waits beyond `timeout` before forcibly terminating a worker that has entered a synchronous infinite loop (the internal timeout cannot fire in that case). Reduce this if you want faster cleanup on hangs. |

---

#### `simulation.scenario(name, fnOrPath)`

Register a scenario to run on every seed.

```ts
sim.scenario('my race', '/abs/path/to/race.scenario.js');
// or inline (legacy — closures over outer scope not available):
sim.scenario('my race', async (env) => { ... });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique label shown in results and timelines |
| `fnOrPath` | `string \| (env: SimEnv) => Promise<void>` | Absolute path to a scenario module **or** an inline async function |

---

#### `simulation.run(opts?): Promise<SimResult>`

Run all scenarios across N seeds sequentially.

```ts
const result = await sim.run({ seeds: 100, stopOnFirstFailure: true });
```

| Option | Default | Description |
|--------|---------|-------------|
| `seeds` | `1` | Number of seeds to iterate over |
| `stopOnFirstFailure` | `true` | Exit after the first failing seed |

**Returns `SimResult`:**
```ts
interface SimResult {
  passed: boolean;
  passes: number;
  failures: ScenarioResult[];
}
```

---

#### `simulation.replay(opts): Promise<ReplayResult>`

Re-run a single known seed for debugging. Prints the full timeline.

```ts
const r = await sim.replay({ seed: 42, scenario: 'my race' });
console.log(r.result.timeline);
```

**Returns `ReplayResult`:**
```ts
interface ReplayResult {
  passed: boolean;
  result: ScenarioResult;
}
```

---

#### `simulation.hunt(opts?): Promise<HuntResult>`

Run seeds indefinitely until a failure is found or the time budget expires. The canonical way to find rare race conditions.

```ts
const result = await sim.hunt({
  timeout: 5 * 60 * 1000,   // 5 minutes
  signal: { aborted: false }, // set .aborted = true to stop cleanly (e.g. SIGINT)
  onProgress: (seed, passed) => {
    console.log(`[${passed ? 'OK  ' : 'FAIL'}] Seed ${seed}`);
  },
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `300_000` | Total wall-clock budget in ms |
| `signal` | — | Abort handle — set `.aborted = true` on Ctrl+C to stop after the current seed without false failures |
| `onProgress` | — | Callback invoked after each completed seed |

**Returns `HuntResult`:**
```ts
interface HuntResult {
  failure: ScenarioResult | null; // null = no bug found in time budget
  seedsRun: number;
  elapsedMs: number;
}
```

> **SIGINT behaviour:** If Ctrl+C fires while a seed is in-flight, that seed is silently discarded — its failure is an interruption artifact, not a real bug.

---

## Types

### `ScenarioResult`

```ts
interface ScenarioResult {
  name: string;
  seed: number;
  passed: boolean;
  error?: string;
  timeline: string; // human-readable event log
}
```

### `SimEnv`

The environment object passed to every scenario function.

```ts
interface SimEnv {
  seed: number;
  clock: VirtualClock;       // @crashlab/clock
  random: SeededRandom;      // @crashlab/random
  scheduler: Scheduler;      // @crashlab/scheduler
  http: HttpInterceptor;     // @crashlab/http-proxy
  tcp: TcpInterceptor;       // @crashlab/tcp
  fs: VirtualFS;             // @crashlab/filesystem
  pg: PgMock;                // @crashlab/pg-mock
  redis: RedisMock;          // @crashlab/redis-mock
  mongo: MongoMock;          // @crashlab/mongo
  faults: FaultInjector;
  timeline: Timeline;
  pump: (ms: number, steps?: number) => Promise<void>;
}

#### `pump()` vs `clock.advance()`

Both methods advance virtual time, but they serve different purposes:

| | `clock.advance(ms)` | `pump(ms, steps?)` |
|---|---|---|
| **Event loop** | Stays in the virtual tick — never yields to Node.js | Yields to the real host event loop between each step |
| **Determinism** | Fully deterministic — same seed always produces identical execution | Less deterministic — real I/O timing can vary between runs |
| **Use case** | All pure-virtual scenarios (mocked HTTP, mocked TCP, mocked DB) | Integration scenarios that drive real TCP connections (e.g. a running Express server via supertest) |
| **Performance** | Instantaneous — no wall-clock time passes | Slow — each step waits ~1ms of real time |

**Use `clock.advance()` for the vast majority of scenarios.** It is the correct tool whenever all I/O passes through CrashLab's mock layer (HttpInterceptor, TcpInterceptor, PgMock, etc.).

**Use `pump()` only** when your scenario starts a real TCP server (e.g. `app.listen()`) and makes requests against it. In that case, the request/response cycle goes through the real Node.js event loop and must be processed before the scheduler can drain its mock completions.

```ts
// Prefer this — purely virtual, fully deterministic
await env.clock.advance(500);

// Only when needed — real event loop involved
await env.pump(500);
```

---

### `Timeline`

Records structured events during a scenario run.

```ts
class Timeline {
  record(evt: TimelineEvent): void;
  toString(): string; // human-readable "[Xms] TYPE: detail" lines
  events: ReadonlyArray<TimelineEvent>;
}

interface TimelineEvent {
  timestamp: number;
  type: string;   // 'START' | 'END' | 'FAIL' | 'FAULT' | 'WARNING' | ...
  detail: string;
}
```

### `FaultInjector`

Convenience wrapper around the raw interceptors for common fault patterns.

```ts
class FaultInjector {
  networkPartition(duration: number): void;  // block all HTTP + TCP for duration ms
  slowDatabase(opts: { latency: number }): void; // add extra latency to all DB I/O
  diskFull(path?: string): void;             // inject ENOSPC at a filesystem path
  clockSkew(amount: number): void;           // offset clock.now() by amount ms
  processRestart(server, delay: number): void; // schedule stop+start via scheduler
}
```

---

## CLI

Installed as `crashlab` binary (also available via `npx crashlab`).

```
crashlab run    [--config=<path>] [--seeds=<N>] [--stop-on-first-failure=<bool>]
crashlab replay --seed=<N> --scenario="<name>" [--config=<path>]
crashlab hunt   <scenario-path> [--timeout=<duration>]
```

**Duration format:** `30s` | `5m` | `1h`

### Config file format

```js
// crashlab.config.js
import { Simulation } from 'crashlab';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sim = new Simulation({ seed: 0 });

sim.scenario('race condition', path.join(__dirname, 'race.scenario.js'));

export default sim;
```

### Scenario file format

```js
// race.scenario.js
export default async function (env) {
  const { clock, http, faults, pump } = env;
  // ... inject faults, make requests, assert outcomes
}
```
