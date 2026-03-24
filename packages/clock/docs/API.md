# @crashlab/clock — API Reference

## Responsibility

Provides a manually-controllable virtual clock that replaces Node.js time primitives (`setTimeout`, `setInterval`, `Date.now`, etc.) inside a simulation worker thread. Time only moves when you explicitly call `advance()` — making all timer-based logic fully deterministic and reproducible across runs with the same seed.

---

## Classes

### `VirtualClock`

The core clock. Holds a priority-queue of pending timers and fires them in scheduled-time order when the clock is advanced.

#### Constructor

```ts
new VirtualClock(startTime?: number)
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `startTime` | `0` | Initial virtual timestamp in milliseconds |

#### Time Queries

| Method | Returns | Description |
|--------|---------|-------------|
| `now()` | `number` | Current virtual timestamp (includes any applied skew) |
| `pending()` | `Array<{id, scheduledTime}>` | Snapshot of all pending timer entries, sorted by fire time |

#### Time Control

| Method | Description |
|--------|-------------|
| `advance(duration: number): Promise<void>` | **Primary method.** Advances the clock by `duration` ms, firing every timer whose scheduled time falls within the window. New timers registered inside callbacks are picked up in the same advance pass. |
| `advanceTo(timestamp: number): Promise<void>` | Jump to an absolute virtual timestamp, draining all timers along the way. |
| `freeze()` | Pause the clock — `advance()` becomes a no-op until `unfreeze()`. |
| `unfreeze()` | Resume a frozen clock. |
| `skew(amount: number)` | Apply a clock-skew offset (ms) to `now()` without firing any timers. Simulates clock drift. |
| `reset(startTime?: number)` | Reset the clock to `startTime`, clearing all pending timers. |

**Example — advancing 1 second in 10 steps:**
```ts
await clock.advance(1000);
```

**Example — simulating clock skew:**
```ts
clock.skew(+5000); // now() returns virtualTime + 5000
```

#### Timer Primitives

These match the Node.js global signatures and are installed as global replacements by `install()`.

| Method | Description |
|--------|-------------|
| `setTimeout(cb, delay, ...args)` | Schedule a one-shot callback at `now + delay` ms |
| `clearTimeout(id)` | Cancel a pending timeout |
| `setInterval(cb, delay, ...args)` | Schedule a repeating callback every `delay` ms |
| `clearInterval(id)` | Cancel a repeating interval |
| `setImmediate(cb, ...args)` | Queue a callback to fire at the end of the current advance tick |
| `clearImmediate(id)` | Cancel a queued immediate |
| `nextTick(cb, ...args)` | Queue a micro-task-style callback (runs before native Promise microtasks) |

#### Hooks

| Property | Type | Description |
|----------|------|-------------|
| `onTick` | `(time: number) => Promise<void>` | Called after every timer fires. The `Scheduler` attaches here so I/O completions are drained at each tick. |

---

### `MinHeap<T>`

Internal priority queue used by `VirtualClock`. Exported for advanced use.

```ts
new MinHeap<T>(compareFn: (a: T, b: T) => number)
```

| Method | Description |
|--------|-------------|
| `push(item)` | Insert an item |
| `pop()` | Remove and return the minimum item |
| `peek()` | Return the minimum without removing |
| `remove(predicate)` | Remove the first item matching the predicate |
| `size` | Number of items in the heap |

---

## Functions

### `install(clock, opts?): ClockInstallResult`

Patches `globalThis` timer functions and `Date` to use the provided `VirtualClock`. Called automatically by the simulation worker.

```ts
import { install } from '@crashlab/clock';
const result = install(clock, { patchNextTick: false });
// ...
result.uninstall(); // restore originals
```

| Option | Default | Description |
|--------|---------|-------------|
| `patchNextTick` | `true` | Whether to override `process.nextTick` with the virtual queue |

### `createVirtualDate(clock): typeof Date`

Returns a `Date` subclass whose `Date.now()` reads from the virtual clock. Installed globally by `install()`.

---

## Types

```ts
interface TimerEntry {
  id: number;
  callback: (...args: unknown[]) => void | Promise<void>;
  scheduledTime: number;
  interval?: number; // present for setInterval entries
  args: unknown[];
}

interface ClockInstallOptions {
  patchNextTick?: boolean;
}

interface ClockInstallResult {
  uninstall(): void;
}
```
