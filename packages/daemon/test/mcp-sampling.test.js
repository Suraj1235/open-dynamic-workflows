import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStrategy } from 'odw-core';

const { createMcpSamplingBackend } = await import('../src/providers/mcp-sampling.js');
const { createEmbeddedOrchestrator } = await import('../src/embedded.js');

// A stand-in for an MCP client's sampling capability: records what the server
// asked for and answers like a host running inference on its OWN model/creds.
function fakeSampler(reply) {
  const calls = [];
  return {
    calls,
    async createMessage(params, opts) {
      calls.push({ params, opts });
      const asked = params?.messages?.[0]?.content?.text ?? '';
      const text = typeof reply === 'function' ? reply(asked) : reply;
      return { role: 'assistant', content: { type: 'text', text }, model: 'host-model' };
    },
  };
}

test('mcp-sampling: maps an agent job to sampling/createMessage and returns the assistant text', async () => {
  const s = fakeSampler('the answer');
  const backend = createMcpSamplingBackend(s);
  const res = await backend.invoke({ prompt: 'do X', systemPrompt: 'be terse', maxTokens: 123 });
  assert.equal(res.text, 'the answer');
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].params.messages, [{ role: 'user', content: { type: 'text', text: 'do X' } }]);
  assert.equal(s.calls[0].params.systemPrompt, 'be terse');
  assert.equal(s.calls[0].params.maxTokens, 123);
  assert.equal(s.calls[0].params.includeContext, 'none', 'ODW builds its own scoped prompts — never inherit host context');
});

test('mcp-sampling: maxTokens defaults to 4096 when the job omits it', async () => {
  const s = fakeSampler('x');
  await createMcpSamplingBackend(s).invoke({ prompt: 'p' });
  assert.equal(s.calls[0].params.maxTokens, 4096);
});

test('mcp-sampling: forwards the abort signal to createMessage', async () => {
  const s = fakeSampler('x');
  const ac = new AbortController();
  await createMcpSamplingBackend(s).invoke({ prompt: 'p' }, { signal: ac.signal });
  assert.equal(s.calls[0].opts.signal, ac.signal);
});

test('mcp-sampling: requires a sampler with createMessage()', () => {
  assert.throws(() => createMcpSamplingBackend({}), /createMessage/);
});

test('mcp-sampling: drives the embedded engine KEYLESS — every agent() runs through host sampling', async () => {
  const s = fakeSampler((asked) => 'RESULT:' + asked.slice(0, 3));
  const orch = createEmbeddedOrchestrator({ invoke: createMcpSamplingBackend(s).invoke, maxConcurrency: 2 });
  const { status, result } = await orch.run({
    script: 'async function execute(){ const a = await agent({prompt:"alpha"}); '
      + 'const b = await parallel([()=>agent({prompt:"beta"}), ()=>agent({prompt:"gamma"})]); '
      + 'return { a, b }; } module.exports = { execute };',
    strategy: mergeStrategy({ budget: { model: 'host:default' } }),
    roles: [],
    topology: 'hybrid',
    estimate: { totalAgents: 1 },
    prompt: 'test',
  });
  assert.equal(status, 'completed');
  assert.equal(result.a, 'RESULT:alp');
  assert.deepEqual(result.b, ['RESULT:bet', 'RESULT:gam']);
  assert.equal(s.calls.length, 3, 'all three agent() calls dispatched via MCP sampling — no ODW key');
});
