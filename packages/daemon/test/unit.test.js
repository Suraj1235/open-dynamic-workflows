import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect ~/.odw to a temp sandbox for the whole suite.
const HOME = mkdtempSync(join(tmpdir(), 'odw-unit-'));
process.env.ODW_HOME = HOME;

const { odwHome, loadConfig, apiKeyFor, defaultConfig } = await import('../src/config.js');
const { createLogger, redact } = await import('../src/logger.js');
const { openDatabase, createStore } = await import('../src/db.js');
const { createBudget } = await import('../src/budget.js');
const { createAgentQueue } = await import('../src/agent-queue.js');
const { createToolExecutor, globWalk } = await import('../src/tools.js');
const { createSandbox } = await import('../src/sandbox.js');
const { createAnthropicProvider } = await import('../src/providers/anthropic.js');
const { createOpenAIProvider } = await import('../src/providers/openai.js');
const { createOllamaProvider } = await import('../src/providers/ollama.js');
const { checkProviderReadiness, resolveProvider } = await import('../src/providers/index.js');

after(() => rmSync(HOME, { recursive: true, force: true }));

// ── config ───────────────────────────────────────────────────────────────────

test('config: ODW_HOME redirect + file merge + env port override', () => {
  assert.equal(odwHome(), HOME);
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ daemon: { maxConcurrency: 42 }, apiKeys: { anthropic: 'k-from-file' } }));
  process.env.ODW_DAEMON_PORT = '9111';
  const config = loadConfig();
  delete process.env.ODW_DAEMON_PORT;
  assert.equal(config.daemon.maxConcurrency, 42);
  assert.equal(config.daemon.port, 9111);
  assert.equal(config.daemon.checkpointInterval, 30); // default survives
  assert.equal(apiKeyFor(config, 'anthropic'), 'k-from-file');
  rmSync(join(HOME, 'config.json'));
});

test('config: a UTF-8 BOM in config.json does not defeat parsing (Windows/PowerShell)', () => {
  // PowerShell Set-Content -Encoding utf8 prepends a BOM; JSON.parse rejects it.
  writeFileSync(join(HOME, 'config.json'), '﻿' + JSON.stringify({ models: { default: 'minimax-m3-free' } }), 'utf8');
  const config = loadConfig();
  assert.equal(config.models.default, 'minimax-m3-free', 'BOM-prefixed config must still load');
  rmSync(join(HOME, 'config.json'));
});

test('config: env fallback for API keys', () => {
  process.env.OPENAI_API_KEY = 'env-key';
  assert.equal(apiKeyFor(defaultConfig(), 'openai'), 'env-key');
  delete process.env.OPENAI_API_KEY;
  assert.equal(apiKeyFor(defaultConfig(), 'openai'), undefined);
});

// ── logger ───────────────────────────────────────────────────────────────────

test('logger: emits valid JSON lines with required fields and redacts secrets', () => {
  const lines = [];
  const logger = createLogger({ level: 'debug', stream: { write: (l) => lines.push(l) } });
  logger.info('hello sk-abcdef1234567890abcdef');
  logger.error('boom', { apiKey: 'sk-supersecret123456', detail: 'Bearer abcdefghijklmnop' });
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.ok(record.timestamp && record.level && record.message);
    assert.ok(!line.includes('sk-abcdef'), 'raw key must be redacted');
    assert.ok(!line.includes('supersecret'), 'field key must be redacted');
    assert.ok(!line.includes('abcdefghijklmnop'), 'bearer must be redacted');
  }
  assert.equal(redact('token ghp_abcdefghij1234567890abc'), 'token [REDACTED]');
});

// ── db/store ─────────────────────────────────────────────────────────────────

test('db: migrations apply once, store round-trips a workflow + nodes + checkpoints + journal', () => {
  const dbPath = join(HOME, 'data', 'unit.db');
  const db = openDatabase(dbPath);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  const store = createStore(db);

  store.insertWorkflow({
    workflow_id: 'wf_test', status: 'running', root_prompt: 'p', compiled_script: 's',
    execution_strategy: '{}', topology: 'hybrid', total_agents: 5, budget_max_usd: 10,
  });
  assert.equal(store.getWorkflow('wf_test').status, 'running');

  store.upsertNode({ node_id: 'n1', workflow_id: 'wf_test', phase_name: 'Work', role_id: 'r', status: 'running', prompt: 'x', max_retries: 3 });
  store.completeNode({ node_id: 'n1', output: '{"a":1}', tokens_input: 10, tokens_output: 5, cost_usd: 0.01, duration_ms: 100 });
  assert.deepEqual(JSON.parse(store.completedNodes('wf_test')[0].output), { a: 1 });

  store.upsertNode({ node_id: 'n2', workflow_id: 'wf_test', phase_name: 'Work', role_id: 'r', status: 'running', prompt: 'y', max_retries: 3 });
  assert.equal(store.requeueOrphans('wf_test'), 1, 'running orphan requeued');
  assert.equal(store.getNode('n2').status, 'queued');
  assert.equal(store.getNode('n2').retry_count, 1);

  store.insertCheckpoint({ checkpoint_id: 'cp1', workflow_id: 'wf_test', phase_name: 'Work', checkpoint_key: 'k', state_data: '{"s":1}', agent_results: null });
  assert.equal(store.latestCheckpoint('wf_test').checkpoint_key, 'k');

  store.journal('wf_test', 'phase', { name: 'Work' });
  store.journal('wf_test', 'log', { message: 'm' });
  const events = store.journalAfter('wf_test', 0);
  assert.equal(events.length, 2);
  assert.ok(store.journalAfter('wf_test', events[0].journal_id).length === 1, 'after-id replay');

  store.setWorkflowResult('wf_test', 'completed', { done: true });
  assert.equal(store.getWorkflow('wf_test').status, 'completed');
  store.close();
});

// ── budget ───────────────────────────────────────────────────────────────────

test('budget: warning at 80%, hard stop at 100%', () => {
  const alerts = [];
  const budget = createBudget({ maxTokens: 1000, maxCostUSD: 1000, alertAtPercent: 80, onAlert: (t, u) => alerts.push([t, u.percentUsed]) });
  budget.track('claude-sonnet-4-6', 700, 100); // 800 tokens = 80%
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], 'warning');
  assert.equal(budget.exceeded(), false);
  budget.track('claude-sonnet-4-6', 200, 100); // 1100 ≥ 100%
  assert.equal(alerts[1][0], 'exceeded');
  assert.equal(budget.exceeded(), true);
});

// ── providers ────────────────────────────────────────────────────────────────

const fakeFetch = (assertFn, payload) => async (url, init) => {
  assertFn?.(url, JSON.parse(init.body), init);
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

test('provider/anthropic: wire shape, temperature sent (dynamic-strip, not model-name allowlist), usage mapping', async () => {
  let captured;
  const provider = createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body, init) => {
      captured = { url, body, headers: init.headers };
    }, { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 7, output_tokens: 3 } }),
  });
  const res = await provider.call({ model: 'claude-opus-4-8', prompt: 'p', systemPrompt: 'sys', temperature: 0.5, schema: { type: 'object' } });
  assert.match(captured.url, /\/v1\/messages$/);
  assert.equal(captured.headers['x-api-key'], 'k');
  assert.equal(captured.body.system, 'sys');
  // Temperature is now ALWAYS sent; models that reject it trigger a 400 the
  // provider recognizes and strips-then-retries (see providers-error.test.js).
  // No stale per-model NO_TEMPERATURE allowlist anymore.
  assert.equal(captured.body.temperature, 0.5, 'temperature is sent on the wire; stripping is 400-driven, not name-driven');
  assert.ok(captured.body.output_config.format.schema, 'structured output via output_config');
  assert.deepEqual([res.tokensInput, res.tokensOutput, res.text], [7, 3, 'hi']);

  // sonnet keeps temperature
  let captured2;
  const provider2 = createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured2 = body; }, { content: [], usage: {} }),
  });
  await provider2.call({ model: 'claude-sonnet-4-6', prompt: 'p', temperature: 0.2 });
  assert.equal(captured2.temperature, 0.2);
});

test('provider/openai: bearer auth, max_completion_tokens for new models, usage mapping', async () => {
  let captured;
  const provider = createOpenAIProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body, init) => { captured = { url, body, auth: init.headers.authorization }; },
      { choices: [{ message: { content: 'out' } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }),
  });
  const res = await provider.call({ model: 'gpt-5-mini', prompt: 'p', maxTokens: 256, schema: { type: 'object' } });
  assert.equal(captured.auth, 'Bearer k');
  assert.equal(captured.body.max_completion_tokens, 256);
  assert.equal(captured.body.max_tokens, undefined);
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.deepEqual([res.tokensInput, res.tokensOutput, res.text], [11, 4, 'out']);

  let captured2;
  const provider2 = createOpenAIProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured2 = body; }, { choices: [{ message: { content: '' } }], usage: {} }),
  });
  await provider2.call({ model: 'gpt-4o', prompt: 'p', maxTokens: 99 });
  assert.equal(captured2.max_tokens, 99, 'legacy models keep max_tokens');
});

test('provider/ollama: schema goes directly into format, eval counts map, zero on cache hit', async () => {
  let captured;
  const provider = createOllamaProvider({
    fetchImpl: fakeFetch((url, body) => { captured = { url, body }; },
      { message: { content: 'local' }, eval_count: 9 /* prompt_eval_count omitted = cache hit */ }),
  });
  const res = await provider.call({ model: 'ollama:llama3', prompt: 'p', schema: { type: 'object' } });
  assert.match(captured.url, /\/api\/chat$/);
  assert.equal(captured.body.model, 'llama3');
  assert.deepEqual(captured.body.format, { type: 'object' });
  assert.deepEqual([res.tokensInput, res.tokensOutput, res.text], [0, 9, 'local']);
});

test('provider routing: claude→anthropic, gpt→openai, ollama→ollama, prefix→compatible, unknown→error', () => {
  const config = { ...defaultConfig(), apiKeys: { anthropic: 'a', openai: 'b', zen: 'c' }, baseURLs: { zen: 'http://localhost:9999/v1' } };
  assert.equal(resolveProvider('claude-sonnet-4-6', config).provider.name, 'anthropic');
  assert.equal(resolveProvider('gpt-4o-mini', config).provider.name, 'openai');
  assert.equal(resolveProvider('o4-mini', config).provider.name, 'openai');
  assert.equal(resolveProvider('ollama:phi3', config).provider.name, 'ollama');
  const zen = resolveProvider('zen:minimax-m2.5', config);
  assert.equal(zen.provider.name, 'zen');
  assert.equal(zen.model, 'minimax-m2.5');
  assert.throws(() => resolveProvider('mystery-model', config), /No provider route/);
});

test('provider readiness: reports missing required keys without probing the network', () => {
  const config = { ...defaultConfig(), apiKeys: {}, models: { default: 'claude-sonnet-4-6', fallback: 'gpt-4o' } };
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const readiness = checkProviderReadiness(config, [
      { purpose: 'default', model: 'claude-sonnet-4-6', required: true },
      { purpose: 'fallback', model: 'gpt-4o', required: false },
    ]);
    assert.equal(readiness.ok, false);
    assert.match(readiness.reason, /default claude-sonnet-4-6: anthropic provider requires an API key/);
    assert.equal(readiness.checks.find((c) => c.purpose === 'fallback').required, false);
  } finally {
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test('provider error classification: maps transient HTTP status codes', async () => {
  const failingFetch = (status) => async () => ({ ok: false, status, text: async () => 'err' });
  const provider = createOpenAIProvider({ apiKey: 'k', fetchImpl: failingFetch(429) });
  await assert.rejects(() => provider.call({ model: 'gpt-4o', prompt: 'p' }), (e) => e.code === 'rate_limit');
  const provider2 = createOpenAIProvider({ apiKey: 'k', fetchImpl: failingFetch(503) });
  await assert.rejects(() => provider2.call({ model: 'gpt-4o', prompt: 'p' }), (e) => e.code === 'service_unavailable');
});

// ── agent queue ──────────────────────────────────────────────────────────────

function queueWith(providerCall, opts = {}) {
  return createAgentQueue({
    maxConcurrency: opts.maxConcurrency ?? 4,
    retry: { maxAttempts: opts.maxAttempts ?? 3, backoff: 'linear' },
    perAgentTimeout: opts.perAgentTimeout ?? 5,
    resolveProvider: () => ({ provider: { name: 'fake', call: providerCall }, model: 'fake-model' }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...opts,
  });
}

test('queue: success path returns validated structured output + usage', async () => {
  const queue = queueWith(async () => ({ text: '{"answer": 42}', tokensInput: 5, tokensOutput: 2 }));
  const result = await queue.executeAgent({ model: 'm', prompt: 'p', schema: { answer: 'number' } });
  assert.deepEqual(result.output, { answer: 42 });
  assert.equal(result.tokensInput, 5);
  assert.ok(result.durationMs >= 0);
});

test('queue: retries retryable errors then succeeds', async () => {
  let attempts = 0;
  const queue = queueWith(async () => {
    attempts++;
    if (attempts < 3) {
      const e = new Error('rate limited');
      e.code = 'rate_limit';
      throw e;
    }
    return { text: 'ok', tokensInput: 1, tokensOutput: 1 };
  });
  const result = await queue.executeAgent({ model: 'm', prompt: 'p' });
  assert.equal(attempts, 3);
  assert.equal(result.output, 'ok');
});

test('queue: non-retryable error fails fast', async () => {
  let attempts = 0;
  const queue = queueWith(async () => {
    attempts++;
    const e = new Error('bad request');
    e.code = 'request_failed';
    throw e;
  });
  await assert.rejects(() => queue.executeAgent({ model: 'm', prompt: 'p' }));
  assert.equal(attempts, 1);
});

test('queue: schema-invalid output retries (re-prompt) up to budget', async () => {
  let attempts = 0;
  const queue = queueWith(async () => {
    attempts++;
    return attempts < 2
      ? { text: 'not json at all', tokensInput: 1, tokensOutput: 1 }
      : { text: '{"n": 1}', tokensInput: 1, tokensOutput: 1 };
  });
  const result = await queue.executeAgent({ model: 'm', prompt: 'p', schema: { n: 'number' } });
  assert.equal(attempts, 2);
  assert.deepEqual(result.output, { n: 1 });
});

test('queue: self-correction — the retry prompt carries the validation error + bad output', async () => {
  const prompts = [];
  const queue = queueWith(async (job) => {
    prompts.push(job.prompt);
    return prompts.length < 2
      ? { text: '{"wrong": "shape"}', tokensInput: 1, tokensOutput: 1 }
      : { text: '{"n": 7}', tokensInput: 1, tokensOutput: 1 };
  });
  const result = await queue.executeAgent({ model: 'm', prompt: 'do the thing', schema: { n: 'number' } });
  assert.deepEqual(result.output, { n: 7 });
  // first prompt is clean; second must reference the rejection + the prior bad output
  assert.ok(!/was rejected/i.test(prompts[0]));
  assert.match(prompts[1], /was rejected/i);
  assert.match(prompts[1], /wrong/); // includes the bad output snippet
});

test('queue: per-agent timeout classifies as timeout', async () => {
  const queue = queueWith(
    (job, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    { perAgentTimeout: 0.2, maxAttempts: 1 }
  );
  await assert.rejects(() => queue.executeAgent({ model: 'm', prompt: 'p' }), /timeout/);
});

test('queue: abort signal stops everything', async () => {
  const controller = new AbortController();
  const queue = queueWith(
    (job, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    { maxAttempts: 3 }
  );
  const pending = queue.executeAgent({ model: 'm', prompt: 'p' }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => pending, (e) => e.name === 'AbortError');
});

test('queue: concurrency is respected', async () => {
  let inflight = 0;
  let peak = 0;
  const queue = queueWith(async (_job) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 30));
    inflight--;
    return { text: 'ok', tokensInput: 1, tokensOutput: 1 };
  }, { maxConcurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, () => queue.executeAgent({ model: 'm', prompt: 'p' })));
  assert.equal(peak, 2);
  assert.equal(queue.highWaterPending(), 2);
});

// ── tools ────────────────────────────────────────────────────────────────────

test('tools: glob/read/search work read-only; write gated; escape blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-tools-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'const password = "x";\nconst ok = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const t = 2;\n');

  const safety = { requireApprovalFor: ['write_file', 'run_bash', 'git_commit'], autoApproveReadOnly: true, dryRun: false, blockedCommands: [] };
  const exec = createToolExecutor({ cwd: root, safety });

  const files = await exec({ tool: 'glob', args: ['src/**/*.{js,ts}'] });
  assert.deepEqual(files.sort(), ['src/a.js', 'src/b.ts']);

  const content = await exec({ tool: 'read_file', args: ['src/a.js'] });
  assert.match(content, /const ok = 1/);

  const hits = await exec({ tool: 'search', args: ['password', 'src/**/*.js'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);

  await assert.rejects(() => exec({ tool: 'write_file', args: ['src/c.js', 'x'] }), /requires approval/);
  await assert.rejects(() => exec({ tool: 'read_file', args: ['../../etc/passwd'] }), /escapes/);
  await assert.rejects(() => exec({ tool: 'nope', args: [] }), /unknown tool/);

  // explicit opt-out enables writes
  const permissive = createToolExecutor({ cwd: root, safety: { ...safety, requireApprovalFor: [] } });
  const written = await permissive({ tool: 'write_file', args: ['out/new.txt', 'hello'] });
  assert.match(written.written, /new\.txt/);
  assert.equal(readFileSync(join(root, 'out', 'new.txt'), 'utf8'), 'hello');

  rmSync(root, { recursive: true, force: true });
});

test('tools: blocked commands are caught case-insensitively (Windows + POSIX)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-blocked-'));
  const exec = createToolExecutor({
    cwd: root,
    safety: { requireApprovalFor: [], autoApproveReadOnly: true, dryRun: false, blockedCommands: ['rm -rf /', 'Remove-Item -Recurse -Force', 'format '] },
  });
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['rm -RF / --no-preserve-root'] }), /blocked command/);
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['remove-item -recurse -force C:\\\\'] }), /blocked command/);
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['FORMAT C:'] }), /blocked command/);
  rmSync(root, { recursive: true, force: true });
});

test('tools: run_bash captures output + exit code on a non-zero exit (no throw)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-run-'));
  const exec = createToolExecutor({ cwd: root, safety: { requireApprovalFor: [], autoApproveReadOnly: true, dryRun: false, blockedCommands: [] } });
  const ok = await exec({ tool: 'run_bash', args: ['node -e "process.exit(0)"'] });
  assert.equal(ok.exitCode, 0);
  const bad = await exec({ tool: 'run_bash', args: ['node -e "process.exit(5)"'] });
  assert.equal(bad.failed, true, 'non-zero exit reported, not thrown');
  assert.notEqual(bad.exitCode, 0);
  rmSync(root, { recursive: true, force: true });
});

test('tools: globWalk handles **, *, ? and alternation', () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-glob-'));
  mkdirSync(join(root, 'deep', 'deeper'), { recursive: true });
  writeFileSync(join(root, 'top.md'), '');
  writeFileSync(join(root, 'deep', 'mid.js'), '');
  writeFileSync(join(root, 'deep', 'deeper', 'leaf.ts'), '');
  assert.deepEqual(globWalk(root, '**/*.md'), ['top.md']);
  assert.deepEqual(globWalk(root, 'deep/**/*.{js,ts}').sort(), ['deep/deeper/leaf.ts', 'deep/mid.js']);
  assert.deepEqual(globWalk(root, 'deep/???.js'), ['deep/mid.js']);
  rmSync(root, { recursive: true, force: true });
});

// ── sandbox ──────────────────────────────────────────────────────────────────

test('sandbox: full primitive surface works inside the guest', async () => {
  const seen = { agents: [], checkpoints: [], phases: [], logs: [], tools: [] };
  const sandbox = await createSandbox({
    hostBridges: {
      agent: async (job) => {
        seen.agents.push(job.prompt);
        await new Promise((r) => setTimeout(r, 10));
        if (/critic/i.test(job.prompt)) return { approved: true, confidence: 0.9, critique: '', rejectedItems: [] };
        return { echo: job.prompt };
      },
      tool: async ({ tool }) => {
        seen.tools.push(tool);
        return tool === 'glob' ? ['x.js', 'y.js'] : 'tool-output';
      },
      checkpoint: async (data) => {
        seen.checkpoints.push(data);
        return null;
      },
      log: ({ message }) => seen.logs.push(message),
      phase: ({ name }) => seen.phases.push(name),
      budget: () => ({ tokensUsed: 123, costUSD: 0.5, maxTokens: 1000, maxCostUSD: 10, percentUsed: 12.3 }),
      args: () => ({ topic: 'testing' }),
    },
    strategy: { concurrency: { max: 4 } },
  });

  const script = `
    async function execute(context) {
      phase("Demo");
      log("starting");
      const files = await context.tools.glob("**/*.js");
      const results = await parallel(files.map(f => () => agent({ role: "a", prompt: "analyze " + f })), { maxConcurrency: 2 });
      const piped = await pipeline([1, 2], [
        async (n) => n * 10,
        async (n) => n + 1,
      ]);
      let i = 0;
      await loop(() => i >= 2, async () => { i++; });
      const verified = await verify({
        target: results,
        mode: "adversarial",
        critics: [{ role: "c", prompt: "critic one" }, { role: "c", prompt: "critic two" }],
        consensusThreshold: 2,
      });
      await checkpoint({ phase: "demo", n: results.length });
      const b = budget();
      const a = args();
      return { results, piped, i, verifiedPassed: verified.passed, budgetTokens: b.tokensUsed, topic: a.topic };
    }
    module.exports = { execute };
  `;

  const result = await sandbox.runScript(script);
  sandbox.dispose();

  assert.equal(result.results.length, 2);
  assert.deepEqual(result.piped, [11, 21]);
  assert.equal(result.i, 2);
  assert.equal(result.verifiedPassed, true);
  assert.equal(result.budgetTokens, 123);
  assert.equal(result.topic, 'testing');
  assert.deepEqual(seen.phases, ['Demo']);
  assert.ok(seen.agents.length === 4, 'two analyses + two critics');
  assert.equal(seen.checkpoints.length, 1);
});

test('sandbox: verify() modes differ — errored critics sink consensus but not adversarial', async () => {
  // 3 critics: one approves confidently, one rejects confidently, one errors (confidence 0).
  let call = 0;
  const jobs = [];
  const sandbox = await createSandbox({
    hostBridges: {
      agent: async (job) => {
        jobs.push(job);
        call++;
        if (call % 3 === 1) return { approved: true, confidence: 0.9, critique: '', rejectedItems: ['itemA'] };
        if (call % 3 === 2) return { approved: false, confidence: 0.9, critique: 'reject', rejectedItems: ['itemB'] };
        throw new Error('critic crashed'); // becomes approved:false, confidence:0 in-guest
      },
    },
  });
  const script = `
    async function execute() {
      const critics = [{role:"c",tools:["read_file"],prompt:"one"},{role:"c",tools:["search"],prompt:"two"},{role:"c",prompt:"three"}];
      const adversarial = await verify({ target: [1], mode: "adversarial", critics, consensusThreshold: 2, minConfidence: 0.5 });
      const consensus  = await verify({ target: [1], mode: "consensus",  critics, consensusThreshold: 2, minConfidence: 0.5 });
      return {
        advPassed: adversarial.passed, advRejections: adversarial.rejections,
        conPassed: consensus.passed, conApprovals: consensus.approvals,
        rejectedItems: adversarial.rejectedItems,
      };
    }
    module.exports = { execute };
  `;
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.equal(result.advPassed, true, 'adversarial survives: only 1 confident rejection < threshold 2');
  assert.equal(result.advRejections, 1);
  assert.equal(result.conPassed, false, 'consensus fails: only 1 confident approval < threshold 2');
  assert.equal(result.conApprovals, 1);
  assert.deepEqual(result.rejectedItems.sort(), ['itemA', 'itemB']);
  assert.deepEqual(jobs[0].tools, ['read_file']);
  assert.deepEqual(jobs[1].tools, ['search']);
  assert.equal(jobs[2].tools, undefined);
});

test('sandbox: no fs/process/require escape hatches exist', async () => {
  const sandbox = await createSandbox({ hostBridges: { agent: async () => ({}) } });
  const probes = [
    'typeof require',
    'typeof process',
    'typeof globalThis.fetch',
    'typeof eval === "function" ? "evalexists" : "noeval"',
  ];
  const script = `
    async function execute() {
      return [${probes.map((p) => JSON.stringify(p)).join(',')}].map(function (src) {
        try { return String((0, eval)(src)); } catch (e) { return "throw:" + e.name; }
      });
    }
    module.exports = { execute };
  `;
  // QuickJS HAS eval inside the VM, but the VM has no host capabilities —
  // assert the dangerous globals are absent.
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.equal(result[0], 'undefined', 'no require');
  assert.equal(result[1], 'undefined', 'no process');
  assert.equal(result[2], 'undefined', 'no fetch');
});

test('sandbox: infinite synchronous loop is interrupted', async () => {
  const sandbox = await createSandbox({
    hostBridges: { agent: async () => ({}) },
    sliceTimeoutMs: 200,
  });
  const script = `
    async function execute() { while (true) {} }
    module.exports = { execute };
  `;
  await assert.rejects(() => sandbox.runScript(script), /interrupted|script error/i);
  sandbox.dispose();
});

test('sandbox: bridge errors surface as guest exceptions with messages', async () => {
  const sandbox = await createSandbox({
    hostBridges: { agent: async () => { throw Object.assign(new Error('budget exceeded'), { code: 'paused' }); } },
  });
  const script = `
    async function execute() {
      try {
        await agent({ role: "x", prompt: "p" });
        return "no-error";
      } catch (e) {
        return "caught:" + e.message;
      }
    }
    module.exports = { execute };
  `;
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.equal(result, 'caught:budget exceeded');
});

test('sandbox: script without module.exports.execute is rejected', async () => {
  const sandbox = await createSandbox({ hostBridges: { agent: async () => ({}) } });
  await assert.rejects(() => sandbox.runScript('var x = 1;'), /must export execute/);
  sandbox.dispose();
});
