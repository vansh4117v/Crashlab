import { describe, it, expect } from 'vitest';
import { Simulation } from '../src/index.js';

describe('Simulation harness', () => {
  it('runs a passing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('simple pass', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'TEST', detail: 'hello' });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].timeline).toContain('hello');
  });

  it('captures failing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('will fail', async () => { throw new Error('boom'); });
    const result = await sim.run();
    expect(result.passed).toBe(false);
    expect(result.scenarios[0].error).toBe('boom');
    expect(result.scenarios[0].timeline).toContain('FAIL');
  });

  it('runs multiple seeds', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('seed tracker', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'SEED', detail: String(env.seed) });
    });
    const result = await sim.run({ seeds: 5 });
    const seeds = result.scenarios.map(s => s.seed);
    expect(seeds).toEqual([0, 1, 2, 3, 4]);
  }, 30_000);

  it('replay reproduces a specific seed', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('prng test', async (env) => {
      const v = env.random.next();
      env.timeline.record({ timestamp: 0, type: 'RNG', detail: String(v) });
    });
    const r1 = await sim.replay({ seed: 42, scenario: 'prng test' });
    const r2 = await sim.replay({ seed: 42, scenario: 'prng test' });
    const extract = (tl: string) => tl.match(/RNG: ([^\n]+)/)?.[1];
    expect(extract(r1.scenarios[0].timeline)).toBe(extract(r2.scenarios[0].timeline));
  });

  it('creates env with all mocked services', async () => {
    const sim = new Simulation();
    sim.scenario('env check', async (env) => {
      const allDefined = [env.clock, env.random, env.scheduler, env.http,
        env.tcp, env.fs, env.faults, env.timeline].every(v => v != null);
      env.timeline.record({ timestamp: 0, type: 'CHECK', detail: allDefined ? 'all-defined' : 'missing' });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios[0].timeline).toContain('all-defined');
  });

  it('fault injector: diskFull records timeline event', async () => {
    const sim = new Simulation();
    sim.scenario('disk full', async (env) => {
      env.faults.diskFull('/tmp/data');
      env.fs.install();
      try {
        const fs = (await import('node:fs')).default;
        // This would only throw if we use the CJS fs patched by VirtualFS
      } catch (e) {
        // expected
      }
    });
    const result = await sim.run();
    expect(result.scenarios[0].timeline).toContain('Disk full');
  });

  it('fault injector: clockSkew advances time', async () => {
    const sim = new Simulation();
    sim.scenario('time skip', async (env) => {
      env.faults.clockSkew(5000);
      env.timeline.record({ timestamp: env.clock.now(), type: 'SKEW', detail: String(env.clock.now()) });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios[0].timeline).toContain('SKEW: 5000');
  });
});

describe('Timeline', () => {
  it('toString formats events', async () => {
    const sim = new Simulation();
    sim.scenario('timeline', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'OP', detail: 'read' });
      env.timeline.record({ timestamp: 100, type: 'OP', detail: 'write' });
    });
    const result = await sim.run();
    expect(result.scenarios[0].timeline).toContain('[0ms] START');
    expect(result.scenarios[0].timeline).toContain('[0ms] OP: read');
    expect(result.scenarios[0].timeline).toContain('[100ms] OP: write');
  });
});
