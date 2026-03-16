import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install, VirtualClock } from '../src/index.js';

describe('VirtualClock cancellation', () => {
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

  it('handles a timer cancelling itself', async () => {
    let fired = false;
    let id: any;
    id = setTimeout(() => {
      fired = true;
      clearTimeout(id);
    }, 10);

    await clock.advance(10);
    expect(fired).toBe(true);
  });

  it('handles a timer cancelling another timer at the same scheduled time (T1 clears T2)', async () => {
    const executionOrder: string[] = [];

    const id2 = setTimeout(() => executionOrder.push('t2'), 10);
    
    setTimeout(() => {
      executionOrder.push('t1');
      clearTimeout(id2);
    }, 10); // t1 scheduled after t2 if using same delay? Wait, t2 gets id 1, t1 gets id 2. So t2 fires first in FIFO.
    
    // To make t1 clear t2, we schedule t1 first.
    const executionOrder2: string[] = [];
    let t2Id: any;
    
    setTimeout(() => {
      executionOrder2.push('tA');
      clearTimeout(t2Id);
    }, 10);

    t2Id = setTimeout(() => executionOrder2.push('tB'), 10);

    await clock.advance(10);
    
    expect(executionOrder2).toEqual(['tA']);
  });
  
  it('handles late cancellation via ID collection', async () => {
      let fired = false;
      const id = setTimeout(() => {
          fired = true;
      }, 5);
      
      // We manually add it to cancelled IDs without removing it from the heap explicitly
      // to simulate edge cases during iteration.
      clock.clearTimeout(id);
      
      await clock.advance(10);
      expect(fired).toBe(false);
  });
});
