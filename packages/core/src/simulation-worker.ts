/**
 * simulation-worker.ts
 *
 * Runs inside a worker_threads Worker. Receives scenario data via workerData,
 * creates a fresh isolated SimEnv, applies determinism patches to this
 * thread's globals, executes the scenario function inside a vm.runInNewContext
 * sandbox, and posts results back to the parent thread.
 *
 * Isolation guarantees:
 *  - Worker thread has its own global scope → patches never leak to main thread.
 *  - vm.runInNewContext provides a nested scope → scenario global writes are sandboxed.
 *  - Worker terminates after posting → no residual timers or module state.
 */
import { workerData, parentPort } from 'node:worker_threads';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { createEnv, installDeterminismPatches } from './env.js';
import type { SimEnv } from './env.js';

// A require() scoped to this worker file — injected into the vm sandbox
// so scenario functions can call require('node:net') etc. without import.meta.
const _workerRequire = createRequire(import.meta.url);

interface WorkerInput {
  seed: number;
  fnSource: string;
  scenarioName: string;
  timeout: number;
}

const { seed, fnSource, scenarioName, timeout } = workerData as WorkerInput;

async function main(): Promise<void> {
  // Build a fresh env (async because MongoMock.start() may spin up a process)
  const env = await createEnv(seed);

  // Wire clock → scheduler so advance() drives all I/O completions
  env.clock.onTick = async (t: number) => {
    await env.scheduler.runTick(t);
  };

  // Auto-install all interceptors on THIS thread's net/http/fs globals
  env.http.install();
  env.tcp.install();
  env.fs.install();

  // Apply determinism patches to THIS thread's globals
  const patches = installDeterminismPatches(env);

  let passed = true;
  let error: string | undefined;

  try {
    env.timeline.record({ timestamp: 0, type: 'START', detail: `Scenario: ${scenarioName}, seed: ${seed}` });

    // Build vm sandbox with the patched globals from this worker thread.
    // The scenario fn is re-compiled in this sandbox so it resolves `Date`,
    // `setTimeout`, `crypto`, etc. to the patched (virtual) versions.
    const sandbox = vm.createContext({
      env,
      // Async primitives
      Promise,
      queueMicrotask,
      // Patched globals (clock and crypto patches are already applied to
      // globalThis, so referencing them here hands the patched versions
      // into the vm context)
      Date:           globalThis.Date,
      setTimeout:     globalThis.setTimeout,
      clearTimeout:   globalThis.clearTimeout,
      setInterval:    globalThis.setInterval,
      clearInterval:  globalThis.clearInterval,
      setImmediate:   globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
      // I/O + utilities available to scenario code
      console,
      process,
      Buffer,
      require: _workerRequire,
      // Common globals scenario code might use
      Math,
      JSON,
      Error,
      Array,
      Object,
      Map,
      Set,
      Symbol,
      RegExp,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
    });

    // Compile and run the scenario fn in the vm context.
    // fnSource is the string representation of `async (env) => { ... }`.
    // Wrapping in parentheses makes it an expression so eval returns the fn.
    const scenarioFn = vm.runInContext(`(${fnSource})`, sandbox) as (env: SimEnv) => Promise<void>;

    await Promise.race([
      scenarioFn(env),
      new Promise<never>((_, reject) =>
        patches.realSetTimeout(
          () => reject(new Error('Scenario timeout')),
          timeout,
        ),
      ),
    ]);

    env.timeline.record({ timestamp: env.clock.now(), type: 'END', detail: 'Success' });
  } catch (err) {
    passed = false;
    error = err instanceof Error ? err.message : String(err);
    env.timeline.record({ timestamp: env.clock.now(), type: 'FAIL', detail: error });
  } finally {
    // Always restore patches and tear down interceptors in this worker thread.
    patches.restore();
    env.http.uninstall();
    env.tcp.uninstall();
    env.fs.uninstall();
    await env.tcp.stopLocalServers();
    // Stop embedded MongoDB if the mock has a stop() lifecycle method
    if (typeof (env.mongo as unknown as { stop?: () => Promise<void> }).stop === 'function') {
      await (env.mongo as unknown as { stop: () => Promise<void> }).stop();
    }
  }

  parentPort!.postMessage({
    name: scenarioName,
    seed,
    passed,
    error,
    timeline: env.timeline.toString(),
  });
}

main().catch(err => {
  parentPort!.postMessage({
    name: scenarioName,
    seed,
    passed: false,
    error: err instanceof Error ? err.message : String(err),
    timeline: '',
  });
});
