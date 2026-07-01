/**
 * Embedded orchestrator — the daemon's composition root (queue + runtime +
 * sandbox) MINUS the HTTP server and SQLite, so a host plugin (e.g. OpenCode)
 * can run the REAL ODW engine IN-PROCESS, dispatching every agent() call through
 * the host's own model via a caller-supplied invoke(). No daemon, no second API
 * key: the host's already-configured auth pays.
 *
 * The engine above the provider — odw-core planning, the WASM sandbox, the
 * primitives, the context-window guard, budget, retries — is reused byte-for-byte;
 * only the leaf network call is swapped for `invoke()`.
 */

import { EventEmitter } from 'node:events';
import { createPlan, mergeStrategy } from 'odw-core';
import { createMemoryStore } from './memory-store.js';
import { createAgentQueue } from './agent-queue.js';
import { createRuntime } from './runtime.js';
import { createHostProvider } from './providers/host.js';

// Re-exported so host plugins/servers can assemble the keyless sampling path
// (createMcpSamplingBackend -> createEmbeddedOrchestrator) from ONE entry point.
export { createMcpSamplingBackend } from './providers/mcp-sampling.js';

const HOST_MODEL = 'host:default';

/**
 * @param {{ invoke?: (job: object, opts: {signal?: AbortSignal}) => Promise<string|{text: string, usage?: object}>,
 *           resolveProvider?: (model: string) => {provider: object, model: string},
 *           maxConcurrency?: number, maxAgents?: number, perAgentTimeout?: number, maxAttempts?: number,
 *           model?: string, safety?: object, git?: object, logger?: object,
 *           store?: object, events?: object }} options
 */
export function createEmbeddedOrchestrator(options = {}) {
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const store = options.store ?? createMemoryStore();
  const events = options.events ?? new EventEmitter();
  events.setMaxListeners?.(100);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 8);
  const defaultMaxAgents = positiveInt(options.maxAgents);
  const model = options.model ?? HOST_MODEL;

  let resolveProvider = options.resolveProvider;
  if (!resolveProvider) {
    if (typeof options.invoke !== 'function') {
      throw new Error('createEmbeddedOrchestrator requires either invoke() or resolveProvider');
    }
    const provider = createHostProvider({ invoke: options.invoke });
    resolveProvider = (m) => ({ provider, model: m || model });
  }

  const config = {
    models: { default: model },
    // Mutations stay approval-gated by default (read-only safe); the caller can
    // opt in to write_file/run_bash for build-style workflows.
    safety: options.safety ?? { requireApprovalFor: ['write_file', 'run_bash', 'git_commit'], autoApproveReadOnly: true, dryRun: false, blockedCommands: [] },
    git: options.git ?? { createBranch: false, branchPrefix: 'odw/', commitCheckpoints: false },
    daemon: { maxConcurrency },
  };

  const queue = createAgentQueue({
    maxConcurrency,
    retry: { maxAttempts: options.maxAttempts ?? 3, backoff: 'exponential' },
    perAgentTimeout: options.perAgentTimeout ?? 120,
    resolveProvider,
    logger,
  });

  /** Planning (run() AND the runtime's replan() bridge): heuristic createPlan
   *  WITHOUT llmDecompose — embedded has no planning model, so heuristic
   *  decomposition is the documented degradation. */
  const planner = (prompt, plannerOptions = {}) =>
    createPlan(prompt, {
      ...plannerOptions,
      maxAgents: positiveInt(plannerOptions.maxAgents) ?? defaultMaxAgents,
      strategy: mergeStrategy({
        budget: { model },
        concurrency: { max: maxConcurrency, default: maxConcurrency },
        safety: config.safety,
        git: config.git,
        ...(plannerOptions.strategy ?? {}),
      }),
    });

  const runtime = createRuntime({ store, queue, config, events, logger, planner });

  /**
   * Plan (if given a prompt) and execute to completion, returning the result.
   * @param {string|object} promptOrPlan a natural-language prompt or a prebuilt plan
   * @param {{cwd?: string, args?: object, strategy?: object, maxAgents?: number}} [runOptions]
   */
  async function run(promptOrPlan, runOptions = {}) {
    const plan = typeof promptOrPlan === 'string'
      ? await planner(promptOrPlan, { strategy: runOptions.strategy, maxAgents: runOptions.maxAgents })
      : promptOrPlan;

    const workflowId = await runtime.execWorkflow(plan, runOptions.strategy, {
      cwd: runOptions.cwd ?? process.cwd(),
      args: runOptions.args ?? {},
      roles: plan.roles,
      wait: true,
    });

    const row = store.getWorkflow(workflowId);
    let result = null;
    try { result = row?.result ? JSON.parse(row.result) : null; } catch { result = row?.result ?? null; }
    return { workflowId, status: row?.status ?? 'unknown', result, plan, store, events };
  }

  return { run, runtime, queue, store, events, execWorkflow: runtime.execWorkflow, control: runtime.control };
}

function positiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
