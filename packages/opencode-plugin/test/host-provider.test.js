import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeBackend } from '../src/host-provider.js';

function mockClient(promptImpl) {
  const calls = [];
  const deleted = [];
  let seq = 0;
  return {
    calls,
    deleted,
    session: {
      create: async () => ({ id: `sess-${++seq}` }),
      prompt: async ({ path, body }) => { calls.push({ id: path.id, body }); return promptImpl(body); },
      delete: async ({ path }) => { deleted.push(path.id); },
    },
  };
}

test('opencode backend: maps a job onto session.prompt — omits model (keyless), uses system, reads parts', async () => {
  const client = mockClient((body) => ({ parts: [{ type: 'text', text: 'reply for ' + body.parts[0].text }] }));
  const backend = createOpencodeBackend(client);

  const r = await backend.invoke({ prompt: 'p1', systemPrompt: 'be brief' });
  assert.equal(r.text, 'reply for p1');
  const sent = client.calls[0].body;
  assert.equal(sent.system, 'be brief', 'system prompt uses the first-class field');
  assert.equal(sent.model, undefined, 'model OMITTED → inherits the user\'s configured OpenCode model (the keyless win)');
  assert.equal(sent.noReply, undefined, 'noReply must NOT be set — noReply:true makes session.prompt echo the user parts back without generating (verified live on CLI 1.2.27)');
  assert.equal(sent.parts[0].text, 'p1');
  await backend.dispose();
});

test('opencode backend: FRESH single-use session per invoke, bulk-deleted at dispose (no cross-agent history contamination, no delete-race)', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client);
  await backend.invoke({ prompt: 'a' });
  await backend.invoke({ prompt: 'b' });
  await backend.invoke({ prompt: 'c' });
  const ids = client.calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 3, 'every invoke runs in its own child session — without noReply, a reused session would leak each agent\'s conversation into the next');
  assert.equal(client.deleted.length, 0, 'deletion is DEFERRED — an immediate per-call delete races OpenCode\'s internal async work on the session (live-verified NotFoundError + stall on 1.2.27)');
  await backend.dispose();
  assert.deepEqual([...client.deleted].sort(), [...ids].sort(), 'dispose() bulk-deletes every single-use session');
});

test('opencode backend: reads text from a {data:{parts}} wrapper too', async () => {
  const client = mockClient((body) => ({ data: { parts: [{ type: 'text', text: 'wrapped:' + body.parts[0].text }] } }));
  const backend = createOpencodeBackend(client);
  const r = await backend.invoke({ prompt: 'z' });
  assert.equal(r.text, 'wrapped:z');
  await backend.dispose();
});

test('opencode backend: forces an explicit providerID/modelID only when asked', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client, { model: 'anthropic/claude-sonnet-4-6' });
  await backend.invoke({ prompt: 'p' });
  assert.deepEqual(client.calls[0].body.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  await backend.dispose();
});

test('opencode backend: errors clearly when no session can be created', async () => {
  const client = { session: { prompt: async () => ({ parts: [] }) } }; // no create
  const backend = createOpencodeBackend(client);
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /no session available/);
});

test('opencode backend: reports every created child session via onSessionCreate (recursion-guard wiring)', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const seen = [];
  const backend = createOpencodeBackend(client, { onSessionCreate: (id) => seen.push(id) });
  await backend.invoke({ prompt: 'p' });
  await backend.invoke({ prompt: 'q' });
  assert.equal(seen.length, 2, 'every per-invoke session is reported so the chat.message hook can skip it');
  await backend.dispose();
});

test('opencode backend: empty reply WITH a host error throws retryable service_unavailable', async () => {
  const client = mockClient(() => ({ parts: [], info: { error: { code: 'ConnectionRefused' } } }));
  const backend = createOpencodeBackend(client);
  await assert.rejects(
    () => backend.invoke({ prompt: 'p' }),
    (err) => err.code === 'service_unavailable' && /ConnectionRefused/.test(err.message),
    'an upstream failure resolves with empty parts + info.error (verified live) and must surface as a retryable error'
  );
  await backend.dispose();
});

test('opencode backend: empty reply WITHOUT a host error is returned as-is (left to schema-correction retry)', async () => {
  const client = mockClient(() => ({ parts: [] }));
  const backend = createOpencodeBackend(client);
  const r = await backend.invoke({ prompt: 'p' });
  assert.equal(r.text, '', 'a legitimately-empty reply is not an infrastructure failure');
  await backend.dispose();
});

test('opencode backend: sessions from failed invokes are still cleaned at dispose', async () => {
  const client = mockClient(() => { throw new Error('boom'); });
  const backend = createOpencodeBackend(client);
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /boom/);
  await backend.dispose();
  assert.equal(client.deleted.length, 1, 'dispose cleans up sessions whose prompt failed');
});
