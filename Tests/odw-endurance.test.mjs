import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScenarios } from './odw-endurance/lib/scenarios.mjs';
import { runCampaign } from './odw-endurance/lib/runner.mjs';

test('ODW endurance campaign completes configured swarm scenarios', async () => {
  const target = Number(process.env.ODW_ENDURANCE_TARGET || 3);
  const scenarios = buildScenarios({ count: target });
  const summary = await runCampaign({ scenarios, providerMode: 'mock', concurrency: 2, timeoutMs: 120_000 });

  assert.equal(summary.total, target);
  assert.equal(summary.failed, 0);
  assert.equal(summary.passed, target);
  assert.ok(summary.totalAgentCalls >= target, 'campaign must exercise agent calls');
});
