import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const { createEmbeddedOdwServer, chooseOdwRunPath } = await import('../src/embedded-server.js');

// A daemon that must NOT be touched on the keyless path, and SHOULD be on the fallback.
function stubDaemon() {
  const calls = { plan: 0, exec: 0, result: 0 };
  return {
    calls,
    base: 'http://stub',
    async health() { return { status: 'ok', activeWorkflows: 0, activeAgents: 0, uptime: 0 }; },
    async plan() { calls.plan++; return { plan: { planId: 'plan_stub', script: '', topology: 'hybrid', estimate: { totalAgents: 1 } } }; },
    async exec() { calls.exec++; return { workflowId: 'wf_stub' }; },
    async result() { calls.result++; return { status: 'completed', result: { ok: true } }; },
    async get() { return { status: 'completed' }; },
    async list() { return { workflows: [] }; },
    async control() { return { ok: true }; },
  };
}

async function link(server, clientCapabilities, samplingHandler) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: clientCapabilities });
  if (samplingHandler) client.setRequestHandler(CreateMessageRequestSchema, samplingHandler);
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

test('chooseOdwRunPath: embedded ONLY when the client supports sampling AND a prompt is given', () => {
  assert.equal(chooseOdwRunPath({ hasSampling: true, args: { prompt: 'do X' } }), 'embedded');
  assert.equal(chooseOdwRunPath({ hasSampling: false, args: { prompt: 'do X' } }), 'daemon');
  assert.equal(chooseOdwRunPath({ hasSampling: true, args: { planId: 'plan_1' } }), 'daemon', 'planId lives in the daemon');
  assert.equal(chooseOdwRunPath({ hasSampling: true, args: {} }), 'daemon');
});

test('embedded server: a sampling-capable client runs odw_run KEYLESS via sampling — no daemon touched', async () => {
  let samplingCalls = 0;
  const daemon = stubDaemon();
  const { server } = createEmbeddedOdwServer({ version: 'test', daemonClient: daemon });
  const client = await link(server, { sampling: {} }, async () => {
    samplingCalls++;
    return { role: 'assistant', content: { type: 'text', text: '{"summary":"ok"}' }, model: 'host-model' };
  });
  const res = await client.callTool({ name: 'odw_run', arguments: { prompt: 'audit the thing' } }, undefined, { timeout: 60000 });
  const payload = JSON.parse(res.content[0].text);
  assert.ok(samplingCalls >= 1, 'agents ran on the host model via sampling (keyless)');
  assert.equal(payload.mode, 'embedded-sampling');
  assert.ok(payload.workflowId, 'returns a workflow id');
  assert.equal(daemon.calls.exec, 0, 'no daemon involved on the keyless path');
  await client.close();
});

test('embedded server: a client WITHOUT sampling falls back to the daemon proxy', async () => {
  const daemon = stubDaemon();
  const { server } = createEmbeddedOdwServer({ version: 'test', daemonClient: daemon });
  const client = await link(server, {}, null); // no sampling capability
  const res = await client.callTool({ name: 'odw_run', arguments: { prompt: 'do X' } }, undefined, { timeout: 20000 });
  const payload = JSON.parse(res.content[0].text);
  assert.ok(daemon.calls.plan >= 1 && daemon.calls.exec >= 1, 'routed through the daemon');
  assert.equal(payload.workflowId, 'wf_stub');
  await client.close();
});

test('embedded server: non-run tools always delegate to the daemon proxy', async () => {
  const daemon = stubDaemon();
  const { server } = createEmbeddedOdwServer({ version: 'test', daemonClient: daemon });
  const client = await link(server, { sampling: {} }, async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'h' }));
  const res = await client.callTool({ name: 'odw_health', arguments: {} }, undefined, { timeout: 20000 });
  assert.match(res.content[0].text, /daemon ok/);
  await client.close();
});
