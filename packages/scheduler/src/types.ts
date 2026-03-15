/**
 * Minimal clock interface (duck-typed — no hard dep on @simnode/clock).
 *
 * When the clock advances to time `t`, it should call:
 *   await scheduler.runTick(t)
 */
export interface IClock {
  now(): number;
}

/** An enqueued mock-I/O completion that the scheduler holds until its virtual time arrives. */
export interface PendingOp {
  /** Unique operation identifier (for debugging / logging). */
  id: string;
  /** Virtual timestamp (ms) when this operation completes. */
  when: number;
  /** Callback to execute when the scheduler releases this operation. */
  run: () => Promise<void> | void;
}
