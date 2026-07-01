import { buildScenarios } from './lib/scenarios.mjs';
import { runCampaign } from './lib/runner.mjs';

const target = Number(process.env.ODW_ENDURANCE_TARGET || process.argv.find((arg) => arg.startsWith('--target='))?.split('=')[1] || 100);
const providerMode = process.env.ODW_PROVIDER_MODE || process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] || 'mock';
const concurrency = Number(process.env.ODW_ENDURANCE_CONCURRENCY || process.argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] || 4);

const summary = await runCampaign({ scenarios: buildScenarios({ count: target }), providerMode, concurrency });
console.log(JSON.stringify({ ok: summary.ok, total: summary.total, passed: summary.passed, failed: summary.failed, totalAgentCalls: summary.totalAgentCalls }, null, 2));
process.exitCode = summary.ok ? 0 : 1;
