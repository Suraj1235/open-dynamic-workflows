import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbeddedOrchestrator } from '../../../packages/daemon/src/embedded.js';
import { createProvider } from './provider.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const resultsDir = join(root, 'results', 'odw-endurance');

export async function runCampaign({
  scenarios,
  providerMode = process.env.ODW_PROVIDER_MODE || 'mock',
  concurrency = Number(process.env.ODW_ENDURANCE_CONCURRENCY || 4),
  timeoutMs = Number(process.env.ODW_ENDURANCE_TIMEOUT_MS || 300_000),
  reportPrefix = `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`,
} = {}) {
  await mkdir(resultsDir, { recursive: true });
  const provider = createProvider({
    mode: providerMode,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    model: process.env.AZURE_OPENAI_MODEL || 'Kimi-K2.6',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview',
  });

  const results = [];
  const startedAt = new Date().toISOString();
  for (const scenario of scenarios) {
    results.push(await withTimeout(runScenario(scenario, provider, concurrency), timeoutMs, scenario.id));
  }

  const summary = summarize({ startedAt, providerMode, results, totalAgentCalls: provider.getCalls() });
  await writeReports(reportPrefix, summary);
  return summary;
}

async function runScenario(scenario, provider, concurrency) {
  const started = Date.now();
  const events = [];
  const orch = createEmbeddedOrchestrator({
    invoke: provider.invoke,
    maxConcurrency: concurrency,
    perAgentTimeout: 45,
    maxAttempts: 3,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  orch.events.on('workflow-event', (event) => events.push({ type: event.type, payload: event.payload, ts: event.ts }));

  try {
    const run = await orch.run(scenario.plan, { cwd: join(root, '..') });
    const agentStarts = events.filter((event) => event.type === 'agent_start').length;
    const agentFailures = events.filter((event) => event.type === 'agent_failed').length;
    const checkpoints = events.filter((event) => event.type === 'checkpoint').length;
    const passed = run.status === 'completed' && run.result?.ok === true && agentStarts >= scenario.expectedMinAgents;
    return {
      id: scenario.id,
      type: scenario.type,
      scale: scenario.scale,
      passed,
      status: run.status,
      durationMs: Date.now() - started,
      workflowId: run.workflowId,
      result: run.result,
      expectedMinAgents: scenario.expectedMinAgents,
      agentStarts,
      agentFailures,
      checkpoints,
      error: passed ? null : `status=${run.status}; ok=${run.result?.ok}; agents=${agentStarts}/${scenario.expectedMinAgents}`,
    };
  } catch (error) {
    return {
      id: scenario.id,
      type: scenario.type,
      scale: scenario.scale,
      passed: false,
      status: 'threw',
      durationMs: Date.now() - started,
      expectedMinAgents: scenario.expectedMinAgents,
      agentStarts: events.filter((event) => event.type === 'agent_start').length,
      agentFailures: events.filter((event) => event.type === 'agent_failed').length,
      checkpoints: events.filter((event) => event.type === 'checkpoint').length,
      error: String(error?.message ?? error).slice(0, 1000),
    };
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      id: label,
      passed: false,
      status: 'timeout',
      durationMs: timeoutMs,
      error: `scenario exceeded timeout ${timeoutMs}ms`,
    }), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarize({ startedAt, providerMode, results, totalAgentCalls }) {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const byType = {};
  const byScale = {};
  for (const result of results) {
    byType[result.type ?? 'unknown'] ??= { total: 0, passed: 0, failed: 0 };
    byType[result.type ?? 'unknown'].total++;
    byType[result.type ?? 'unknown'][result.passed ? 'passed' : 'failed']++;
    byScale[result.scale ?? 'unknown'] ??= { total: 0, passed: 0, failed: 0 };
    byScale[result.scale ?? 'unknown'].total++;
    byScale[result.scale ?? 'unknown'][result.passed ? 'passed' : 'failed']++;
  }
  return {
    ok: failed === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerMode,
    total: results.length,
    passed,
    failed,
    totalAgentCalls,
    byType,
    byScale,
    failures: results.filter((result) => !result.passed),
    results,
  };
}

async function writeReports(prefix, summary) {
  const jsonPath = join(resultsDir, `${prefix}.json`);
  const mdPath = join(resultsDir, `${prefix}.md`);
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(mdPath, markdown(summary));
  await writeFile(join(resultsDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(resultsDir, 'latest.md'), markdown(summary));
}

function markdown(summary) {
  const rows = summary.results.map((result) => `| ${result.id} | ${result.type} | ${result.scale} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.agentStarts ?? 0} | ${result.durationMs ?? 0} | ${escapeCell(result.error ?? '')} |`).join('\n');
  return `# ODW Endurance Campaign\n\n` +
    `- Started: ${summary.startedAt}\n` +
    `- Finished: ${summary.finishedAt}\n` +
    `- Provider mode: ${summary.providerMode}\n` +
    `- Total: ${summary.total}\n` +
    `- Passed: ${summary.passed}\n` +
    `- Failed: ${summary.failed}\n` +
    `- Total agent calls: ${summary.totalAgentCalls}\n\n` +
    `## Results\n\n| ID | Type | Scale | Status | Agents | Duration ms | Error |\n| --- | --- | --- | --- | ---: | ---: | --- |\n${rows}\n`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
