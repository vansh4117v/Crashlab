import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// Re-export shared types so consumers import from a single entry point.
export type { SimEnv, TimelineEvent } from './env.js';
export { Timeline, FaultInjector } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// When running from dist/ (production) the worker sits alongside this file.
// When running from src/ (vitest transforms TS directly) fall back to dist/.
const _workerSibling = join(__dirname, 'simulation-worker.js');
const WORKER_SCRIPT  = existsSync(_workerSibling)
  ? _workerSibling
  : join(__dirname, '..', 'dist', 'simulation-worker.js');

interface ScenarioDef {
  name: string;
  fn: (env: import('./env.js').SimEnv) => Promise<void>;
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

interface WorkerResult {
  name: string;
  seed: number;
  passed: boolean;
  error?: string;
  timeline: string;
}

export class Simulation {
  private _baseSeed: number;
  private _timeout: number;
  private _scenarios: ScenarioDef[] = [];

  constructor(opts?: { seed?: number; timeout?: number }) {
    this._baseSeed = opts?.seed ?? 0;
    this._timeout  = opts?.timeout ?? 30_000;
  }

  scenario(name: string, fn: (env: import('./env.js').SimEnv) => Promise<void>): void {
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
    const found = this._scenarios.find(s => s.name === opts.scenario);
    if (!found) throw new Error(`Scenario not found: ${opts.scenario}`);
    const r = await this._runScenario(found, opts.seed);
    return { passed: r.passed, scenarios: [r] };
  }

  private _runScenario(scenario: ScenarioDef, seed: number): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      // Serialise the scenario function for the worker.
      // NOTE: scenarios must be self-contained – closures over variables defined
      // outside the scenario body are not available in the worker context.
      const fnSource = scenario.fn.toString();

      const worker = new Worker(WORKER_SCRIPT, {
        workerData: {
          seed,
          fnSource,
          scenarioName: scenario.name,
          timeout: this._timeout,
        },
      });

      worker.once('message', (result: WorkerResult) => resolve(result));
      worker.once('error',   (err)                   => reject(err));
      worker.once('exit',    (code) => {
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code} for scenario "${scenario.name}"`));
        }
      });
    });
  }
}
