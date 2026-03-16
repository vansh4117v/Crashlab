import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install, VirtualClock } from '../src/index.js';

describe('VirtualClock cascade', () => {
  let clock: VirtualClock;
  let uninstall: () => void;

  beforeEach(() => {
    const installed = install();
    clock = installed.clock;
    uninstall = installed.uninstall;
  });

  afterEach(() => {
    uninstall();
  });

  it('handles timers scheduling timers at the exact same virtual millisecond', async () => {
    const executionOrder: string[] = [];

    setTimeout(() => {
      executionOrder.push('t1');
      setTimeout(() => {
        executionOrder.push('t3');
      }, 0);
    }, 10);

    setTimeout(() => {
      executionOrder.push('t2');
    }, 10);

    await clock.advance(10);
    // t1 and t2 fire at 10. t1 schedules t3 at 10. 
    // Because the advance block is window 0 to 10, t3 should fire BEFORE the window closes.
    expect(executionOrder).toEqual(['t1', 't2', 't3']);
  });

  it('handles interval cascade within the same window', async () => {
    const executionOrder: string[] = [];
    let count = 0;

    const id = setInterval(() => {
      executionOrder.push(`i${count++}`);
      if (count === 3) clearInterval(id);
    }, 5);

    await clock.advance(20);

    expect(count).toBe(3);
    expect(executionOrder).toEqual(['i0', 'i1', 'i2']);
  });
});
