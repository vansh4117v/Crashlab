import { VirtualClock } from '@simnode/clock';
import { install as installClock } from '@simnode/clock';
import { SeededRandom, mulberry32 } from '@simnode/random';
import { Scheduler } from '@simnode/scheduler';
import { HttpInterceptor } from '@simnode/http-proxy';
import { TcpInterceptor } from '@simnode/tcp';
import { VirtualFS } from '@simnode/filesystem';
import { PgMock } from '@simnode/pg-mock';
import { RedisMock } from '@simnode/redis-mock';
import { MongoMock } from '@simnode/mongo';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const cryptoCjs = _require('node:crypto') as typeof import('node:crypto');

export interface TimelineEvent {
  timestamp: number;
  type: string;
  detail: string;
}

export class Timeline {
  private _events: TimelineEvent[] = [];
  record(evt: TimelineEvent): void { this._events.push(evt); }
  get events(): ReadonlyArray<TimelineEvent> { return this._events; }
  toString(): string {
    return this._events.map(e => `[${e.timestamp}ms] ${e.type}: ${e.detail}`).join('\n');
  }
}

export interface SimEnv {
  seed: number;
  clock: VirtualClock;
  random: SeededRandom;
  scheduler: Scheduler;
  http: HttpInterceptor;
  tcp: TcpInterceptor;
  fs: VirtualFS;
  /** Built-in PostgreSQL wire-protocol mock (connected to localhost:5432 via TCP mock). */
  pg: PgMock;
  /** Built-in Redis RESP mock (connected to localhost:6379 via TCP mock). */
  redis: RedisMock;
  /** Built-in MongoDB OP_MSG mock (connected to localhost:27017 via TCP mock). */
  mongo: MongoMock;
  faults: FaultInjector;
  timeline: Timeline;
}

export class FaultInjector {
  constructor(private _env: SimEnv) {}

  /**
   * Partition the network for `duration` virtual ms.
   * Both HTTP and TCP connections will be rejected during this window.
   */
  networkPartition(duration: number): void {
    this._env.http.blockAll(duration);
    this._env.tcp.blockAll(duration);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Network partition for ${duration}ms`,
    });
  }

  /**
   * Add latency to all TCP responses AND all HTTP responses (simulates slow DB).
   * Affects pg-mock, redis-mock, and mongo-mock handlers via TcpInterceptor.
   * Also affects HTTP-based DBs (CockroachDB, Supabase, PlanetScale via HTTP).
   */
  slowDatabase(opts: { latency: number }): void {
    this._env.tcp.setDefaultLatency(opts.latency);
    this._env.http.setDefaultLatency(opts.latency);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Slow DB: ${opts.latency}ms extra latency`,
    });
  }

  /** Inject a disk-full error for a given path. */
  diskFull(path = '/'): void {
    this._env.fs.inject(path, { error: 'ENOSPC: no space left on device', code: 'ENOSPC' });
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Disk full at ${path}`,
    });
  }

  /**
   * Apply a clock skew offset (ms) without advancing timers.
   * `clock.now()` will return a value offset by `amount`.
   */
  clockSkew(amount: number): void {
    this._env.clock.skew(amount);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Clock skew +${amount}ms`,
    });
  }

  /**
   * Simulate a server restart: stops the server at `delay/2` ms and
   * restarts it at `delay` ms via the scheduler.
   */
  processRestart(server: { stop?: () => void; start?: () => void }, delay: number): void {
    const now = this._env.clock.now();
    const stopAt = now + Math.floor(delay / 2);
    const startAt = now + delay;

    this._env.scheduler.enqueueCompletion({
      id: `fault-stop-${now}`,
      when: stopAt,
      run: async () => {
        server.stop?.();
        this._env.timeline.record({ timestamp: stopAt, type: 'FAULT', detail: 'Process stop (restart)' });
      },
    });
    this._env.scheduler.enqueueCompletion({
      id: `fault-start-${now}`,
      when: startAt,
      run: async () => {
        server.start?.();
        this._env.timeline.record({ timestamp: startAt, type: 'FAULT', detail: 'Process start (restart)' });
      },
    });

    this._env.timeline.record({
      timestamp: now,
      type: 'FAULT',
      detail: `Process restart scheduled in ${delay}ms`,
    });
  }
}

interface ScenarioDef {
  name: string;
  fn: (env: SimEnv) => Promise<void>;
}

export interface SimResult {
  passed: boolean;
  scenarios: Array<{
    name: string;
    seed: number;
    passed: boolean;
    error?: string;
    timeline: string;
  }>;
}

export class Simulation {
  private _baseSeed: number;
  private _timeout: number;
  private _scenarios: ScenarioDef[] = [];

  constructor(opts?: { seed?: number; timeout?: number }) {
    this._baseSeed = opts?.seed ?? 0;
    this._timeout = opts?.timeout ?? 30_000;
  }

  scenario(name: string, fn: (env: SimEnv) => Promise<void>): void {
    this._scenarios.push({ name, fn });
  }

  async run(opts?: { seeds?: number }): Promise<SimResult> {
    const seedCount = opts?.seeds ?? 1;
    const results: SimResult['scenarios'] = [];

    for (let s = 0; s < seedCount; s++) {
      const seed = this._baseSeed + s;
      for (const scenario of this._scenarios) {
        const r = await this._runScenario(scenario, seed);
        results.push(r);
      }
    }

    return { passed: results.every(r => r.passed), scenarios: results };
  }

  async replay(opts: { seed: number; scenario: string }): Promise<SimResult> {
    const scenario = this._scenarios.find(s => s.name === opts.scenario);
    if (!scenario) throw new Error(`Scenario not found: ${opts.scenario}`);
    const r = await this._runScenario(scenario, opts.seed);
    return { passed: r.passed, scenarios: [r] };
  }

  private async _runScenario(scenario: ScenarioDef, seed: number) {
    const env = this._createEnv(seed);

    // Wire clock → scheduler so advance() drives all I/O
    env.clock.onTick = async (t: number) => {
      await env.scheduler.runTick(t);
    };

    // Auto-install all interceptors
    env.http.install();
    env.tcp.install();
    env.fs.install();

    // Install determinism patches (timer + Date + crypto + performance.now)
    const patches = this._installDeterminismPatches(env);

    let passed = true;
    let error: string | undefined;

    try {
      env.timeline.record({ timestamp: 0, type: 'START', detail: `Scenario: ${scenario.name}, seed: ${seed}` });
      await Promise.race([
        scenario.fn(env),
        new Promise((_, reject) =>
          // Use the real (pre-patch) setTimeout via patches closure, so this
          // wall-clock timeout always ticks regardless of virtual clock.
          patches.realSetTimeout(() => reject(new Error('Scenario timeout')), this._timeout)
        ),
      ]);
      env.timeline.record({ timestamp: env.clock.now(), type: 'END', detail: 'Success' });
    } catch (err) {
      passed = false;
      error = err instanceof Error ? err.message : String(err);
      env.timeline.record({ timestamp: env.clock.now(), type: 'FAIL', detail: error });
    } finally {
      patches.restore();
      env.http.uninstall();
      env.tcp.uninstall();
      env.fs.uninstall();
      // Stop local TCP servers (mongo, pg, redis loopback servers)
      await env.tcp.stopLocalServers();
    }

    return { name: scenario.name, seed, passed, error, timeline: env.timeline.toString() };
  }

  private _createEnv(seed: number): SimEnv {
    const clock = new VirtualClock(0);
    const random = new SeededRandom(seed);
    const scheduler = new Scheduler({ prngSeed: seed });

    const http = new HttpInterceptor({ clock, scheduler });
    const tcp = new TcpInterceptor({ clock, scheduler });
    // Pass clock to VirtualFS for realistic stat timestamps
    const fs = new VirtualFS({ clock });

    const timeline = new Timeline();

    // Built-in protocol mocks
    const pg = new PgMock();
    const redis = new RedisMock();
    const mongo = new MongoMock();

    const env: SimEnv = {
      seed, clock, random, scheduler,
      http, tcp, fs,
      pg, redis, mongo,
      faults: null as any,
      timeline,
    };
    env.faults = new FaultInjector(env);

    // Register built-in protocol mocks as TCP routes
    // These are the default "well-known port" routes; scenarios can override by
    // calling env.tcp.mock('host:port', { handler }) with a custom handler.
    tcp.mock('localhost:5432', { handler: pg.createHandler() });
    tcp.mock('localhost:6379', { handler: redis.createHandler() });
    tcp.mock('localhost:27017', { handler: mongo.createHandler() });

    // Start local TCP servers for protocols that may be accessed by external
    // processes (e.g. Prisma's query engine binary connects via real TCP).
    // These servers listen on 127.0.0.1 only and are torn down in finally.
    // We fire-and-forget here; proper cleanup happens via stopLocalServers() in finally.
    // NOTE: addLocalServer is called BEFORE install() so it uses the real net.Server.
    // The client-side interceptor (patching net.createConnection) also handles the same
    // routes, so in-process code goes through VirtualSocket while out-of-process
    // binaries use the loopback server.
    tcp.addLocalServer(5432, pg.createHandler());
    tcp.addLocalServer(6379, redis.createHandler());
    tcp.addLocalServer(27017, mongo.createHandler());

    return env;
  }

  /**
   * Install determinism patches:
   *  - crypto.randomBytes / randomUUID / getRandomValues → seeded PRNG
   *  - setTimeout / setInterval / clearTimeout / clearInterval / setImmediate / Date / performance.now → virtual clock
   *
   * Returns a `restore()` that undoes everything.
   */
  _installDeterminismPatches(env: SimEnv): { restore: () => void; realSetTimeout: typeof globalThis.setTimeout } {
    // Capture real setTimeout BEFORE the clock patch overwrites it
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);

    const origRandomBytes = cryptoCjs.randomBytes;
    const origRandomUUID = cryptoCjs.randomUUID;
    const origGetRandomValues = cryptoCjs.getRandomValues;

    // Node < 19 support: globalThis.crypto might be undefined
    const globalCrypto = globalThis.crypto;
    let origGlobalRandomUUID: typeof crypto.randomUUID | undefined;
    if (globalCrypto && globalCrypto.randomUUID) origGlobalRandomUUID = globalCrypto.randomUUID.bind(globalCrypto);
    let origGlobalGetRandomValues: typeof crypto.getRandomValues | undefined;
    if (globalCrypto && globalCrypto.getRandomValues) origGlobalGetRandomValues = globalCrypto.getRandomValues.bind(globalCrypto);

    const rng = mulberry32(env.seed);

    const randomBytesPatch = function (size: number, cb?: (err: Error | null, buf: Buffer) => void): Buffer {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
      if (cb) { queueMicrotask(() => cb(null, buf)); return buf; }
      return buf;
    };

    const getRandomValuesPatch = function <T extends ArrayBufferView | null>(typedArray: T): T {
      if (typedArray) {
        const u8 = new Uint8Array((typedArray as any).buffer, (typedArray as any).byteOffset, (typedArray as any).byteLength);
        for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rng() * 256);
      }
      return typedArray;
    };

    const randomUUIDPatch = function (): string {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.floor(rng() * 16);
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };

    Object.defineProperty(cryptoCjs, 'randomBytes', { value: randomBytesPatch, configurable: true });
    Object.defineProperty(cryptoCjs, 'randomUUID', { value: randomUUIDPatch, configurable: true });

    if (globalCrypto) {
      if (typeof globalCrypto.randomUUID === 'function') {
        Object.defineProperty(globalCrypto, 'randomUUID', { value: randomUUIDPatch, configurable: true });
      }
      if (typeof globalCrypto.getRandomValues === 'function') {
        Object.defineProperty(globalCrypto, 'getRandomValues', { value: getRandomValuesPatch, configurable: true });
      }
    }

    // Install clock patches (setTimeout, setInterval, Date, performance.now, etc.)
    // patchNextTick is set to false to avoid deadlocking scenario code that uses
    // dynamic import() or other Node.js internals which rely on the real process.nextTick.
    const clockResult = installClock(env.clock, { patchNextTick: false });

    return {
      realSetTimeout,
      restore() {
        // Restore clock patches first (timers, Date, process.nextTick, performance.now)
        clockResult.uninstall();

        Object.defineProperty(cryptoCjs, 'randomBytes', { value: origRandomBytes, configurable: true });
        Object.defineProperty(cryptoCjs, 'randomUUID', { value: origRandomUUID, configurable: true });
        if (globalCrypto) {
          if (origGlobalRandomUUID !== undefined) {
            Object.defineProperty(globalCrypto, 'randomUUID', { value: origGlobalRandomUUID, configurable: true });
          }
          if (origGlobalGetRandomValues !== undefined) {
             Object.defineProperty(globalCrypto, 'getRandomValues', { value: origGlobalGetRandomValues, configurable: true });
          }
        }
      },
    };
  }
}
