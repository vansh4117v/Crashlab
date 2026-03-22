# @simnode/scheduler — API Reference

## Responsibility

A cooperative, deterministic I/O scheduler. Mock handlers (TCP, HTTP) don't deliver responses immediately — they call `scheduler.enqueueCompletion()` with a virtual timestamp. When the clock advances to that timestamp, the scheduler fires all due completions in a PRNG-shuffled order. This makes every macro-level race condition reproducible: the same seed always produces the same interleaving.

---

## Classes

### `Scheduler`

#### Constructor

```ts
new Scheduler(opts?: { clock?: IClock; prngSeed?: number })
```

| Option | Default | Description |
|--------|---------|-------------|
| `clock` | — | Optional virtual clock. When attached, the scheduler is wired to `clock.onTick`. |
| `prngSeed` | `0` | Seed for the mulberry32 PRNG that determines shuffling order within same-tick groups. Each simulation seed passes its own value here, guaranteeing different orderings per seed. |

---

### Core Methods

#### `scheduler.enqueueCompletion(op: PendingOp): void`

Register a mock I/O completion to fire at a specific virtual time. The `run` callback is **not** called immediately — it is held until `runTick(t)` is called with `t >= op.when`.

```ts
scheduler.enqueueCompletion({
  id: 'redis-get-1',        // unique ID (for debugging)
  when: clock.now() + 10,   // virtual timestamp to fire at
  run: async () => {
    socket.emit('data', responseBuffer);
  },
});
```

**`PendingOp`:**

```ts
interface PendingOp {
  id: string;
  when: number;     // virtual timestamp (ms)
  run: () => Promise<void> | void;
}
```

---

#### `scheduler.runTick(virtualTime: number): Promise<void>`

Collect all enqueued ops with `when <= virtualTime`, sort by `when` ascending, shuffle within same-`when` groups via the PRNG, then execute sequentially with microtask checkpoints between each.

Cascading completions — ops enqueued during a callback that are also ready at the same tick — are picked up in a second pass of the same call. This preserves causal ordering.

```ts
// Wired automatically via clock.onTick:
clock.onTick = async (t) => { await scheduler.runTick(t); };
```

---

#### `scheduler.drain(): Promise<void>`

Immediately execute **all** pending ops, regardless of their `when` timestamp. Useful for test teardown to flush any remaining completions.

```ts
await scheduler.drain();
```

---

#### `scheduler.attachClock(clock: IClock): void`

Attach (or replace) the clock reference. The scheduler's `runTick` will now be called automatically on each clock advance.

---

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `pendingCount` | `number` | Number of ops currently waiting in the queue |

---

## Ordering Guarantee

Within a single virtual timestamp, the execution order of concurrent completions is:
1. **Stable-sorted** by `when` ascending (earlier ops run first across different timestamps).
2. **PRNG-shuffled** within each group of ops sharing the exact same `when` value.

This means each seed produces a unique, reproducible interleaving of concurrent operations — which is how SimNode discovers race conditions.

---

## Types

```ts
interface PendingOp {
  id: string;
  when: number;
  run: () => Promise<void> | void;
}

interface IClock {
  now(): number;
}

interface SchedulerOptions {
  clock?: IClock;
  prngSeed?: number;
}
```
