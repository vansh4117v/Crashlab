# simnode — API Reference

## Responsibility

The top-level package users install (`npm i simnode`). It orchestrates the entire simulation lifecycle: spawning isolated worker threads per seed, starting a shared MongoDB memory server, driving the virtual clock, and aggregating pass/fail results. Also ships the `simnode` CLI binary (`run`, `replay`, `hunt`).

---

## Classes

### `Simulation`

The entry point for all simulation work.

#### Constructor

```ts
new Simulation(opts?: { seed?: number; timeout?: number })
```

| Option | Default | Description |
|--------|---------|-------------|
| `seed` | `0` | Base seed. Each additional seed increments this by 1. |
| `timeout` | `30_000` | Per-scenario timeout in ms before the worker is killed. |

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
  clock: VirtualClock;       // @simnode/clock
  random: SeededRandom;      // @simnode/random
  scheduler: Scheduler;      // @simnode/scheduler
  http: HttpInterceptor;     // @simnode/http-proxy
  tcp: TcpInterceptor;       // @simnode/tcp
  fs: VirtualFS;             // @simnode/filesystem
  pg: PgMock;                // @simnode/pg-mock
  redis: RedisMock;          // @simnode/redis-mock
  mongo: MongoMock;          // @simnode/mongo
  faults: FaultInjector;
  timeline: Timeline;
  pump: (ms: number, steps?: number) => Promise<void>;
}
```

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

Installed as `simnode` binary (also available via `npx simnode`).

```
simnode run    [--config=<path>] [--seeds=<N>] [--stop-on-first-failure=<bool>]
simnode replay --seed=<N> --scenario="<name>" [--config=<path>]
simnode hunt   <scenario-path> [--timeout=<duration>]
```

**Duration format:** `30s` | `5m` | `1h`

### Config file format

```js
// simnode.config.js
import { Simulation } from 'simnode';
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
