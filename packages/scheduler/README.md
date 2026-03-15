# @simnode/scheduler

Cooperative deterministic scheduler for mock I/O boundaries. Holds enqueued completions until their virtual time arrives, then releases them in a PRNG-shuffled order — making all macro-level race conditions fully reproducible with the same seed. Does **not** intercept V8 microtasks or Promise internals.

## Usage

```ts
import { Scheduler } from '@simnode/scheduler';

const sched = new Scheduler({ prngSeed: 42 });

// Mock I/O layer enqueues completions:
sched.enqueueCompletion({ id: 'db-read-1', when: 80, run: () => resolveQuery1() });
sched.enqueueCompletion({ id: 'db-read-2', when: 80, run: () => resolveQuery2() });

// When the virtual clock advances to t=80:
await sched.runTick(80);
// Both completions run in deterministic PRNG-shuffled order.
```

## Clock integration

```ts
import { VirtualClock } from '@simnode/clock';

const clock = new VirtualClock(0);
const sched = new Scheduler({ clock, prngSeed: 42 });
// Contract: when clock.advance() reaches time t, call await sched.runTick(t).
```
