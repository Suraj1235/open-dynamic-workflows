/**
 * Provider error-path behavior:
 *  1. anthropic dynamic temperature self-heal — a 400 whose message says
 *     temperature is unsupported/deprecated triggers a SINGLE retry with the
 *     temperature field dropped (model-name-agnostic; mirrors the context-
 *     overflow self-heal pattern). Models that accept temperature are unchanged.
 *  2. a present-but-invalid API key (HTTP 401/403) yields an explicit,
 *     actionable auth error (both anthropic and openai) — never leaks the key.
 *
 * Fetch is injected via fetchImpl (the unit.test.js provider-test convention),
 * so no real network is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAnthropicProvider } = await import('../src/providers/anthropic.js');
const { createOpenAIProvider } = await import('../src/providers/openai.js');

// A fetch stub that returns a 400 with the given error body on the FIRST call,
// then a successful payload on every call after. Records each request body.
function tempRejectThenOk(errorBody, okPayload) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return { ok: false, status: 400, text: async () => errorBody };
    }
    return { ok: true, json: async () => okPayload, text: async () => JSON.stringify(okPayload) };
  };
  return { fetchImpl, bodies };
}

const OK = { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 2, output_tokens: 1 } };

// ── Fix 1: dynamic temperature self-heal (model-agnostic) ────────────────────

test('anthropic: 400 "temperature is deprecated" retries ONCE without temperature and succeeds', async () => {
  const { fetchImpl, bodies } = tempRejectThenOk(
    '{"type":"error","error":{"type":"invalid_request_error","message":"temperature is deprecated for this model."}}',
    OK,
  );
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  // A model the STALE opus-4-(7|8) regex would NOT have caught — proves dynamic detection.
  const res = await provider.call({ model: 'claude-sonnet-4-6', prompt: 'p', temperature: 0.7 });

  assert.equal(bodies.length, 2, 'exactly one retry');
  assert.equal(bodies[0].temperature, 0.7, 'first attempt sends temperature (model was not on any allowlist)');
  assert.equal('temperature' in bodies[1], false, 'retry drops the temperature field entirely');
  assert.equal(bodies[1].model, 'claude-sonnet-4-6', 'retry keeps everything else identical');
  assert.equal(res.text, 'hi');
});

test('anthropic: temperature self-heal is model-name-agnostic (works for a future model name)', async () => {
  const { fetchImpl, bodies } = tempRejectThenOk(
    'temperature: this parameter is not supported for this model',
    OK,
  );
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  // A model name that no hardcoded regex could anticipate.
  const res = await provider.call({ model: 'claude-opus-4-9', prompt: 'p', temperature: 1 });

  assert.equal(bodies.length, 2);
  assert.equal('temperature' in bodies[1], false, 'retry drops temperature regardless of model name');
  assert.equal(res.text, 'hi');
});

test('anthropic: temperature self-heal also applies on the callWithTools path', async () => {
  const { fetchImpl, bodies } = tempRejectThenOk(
    'temperature is deprecated for this model.',
    { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  );
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  const res = await provider.callWithTools({ model: 'claude-sonnet-4-6', temperature: 0.5, messages: [{ role: 'user', content: 'p' }] });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0.5);
  assert.equal('temperature' in bodies[1], false, 'tool path retry also drops temperature');
  assert.equal(res.text, 'done');
});

test('anthropic: a NON-temperature 400 does NOT retry (fails fast as request_failed)', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: false, status: 400, text: async () => 'messages: field required' };
  };
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => provider.call({ model: 'claude-sonnet-4-6', prompt: 'p', temperature: 0.7 }),
    (e) => e.code === 'request_failed',
  );
  assert.equal(bodies.length, 1, 'unrelated 400s are not retried');
});

test('anthropic: retry fires at most ONCE — a second temperature 400 is thrown, never looped', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: false, status: 400, text: async () => 'temperature is deprecated for this model.' };
  };
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => provider.call({ model: 'claude-sonnet-4-6', prompt: 'p', temperature: 0.7 }),
    (e) => e.code === 'request_failed',
  );
  assert.equal(bodies.length, 2, 'one original + one retry, then give up (bounded, no infinite loop)');
});

test('anthropic: model that accepts temperature sends it and does NOT retry (behavior identical)', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => OK, text: async () => JSON.stringify(OK) };
  };
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });

  const res = await provider.call({ model: 'claude-sonnet-4-6', prompt: 'p', temperature: 0.3 });

  assert.equal(bodies.length, 1, 'happy path is a single call — no speculative retry');
  assert.equal(bodies[0].temperature, 0.3, 'temperature still sent for models that accept it');
  assert.equal(res.text, 'hi');
});

test('anthropic: no temperature supplied → nothing to strip, no retry logic engaged', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => OK, text: async () => JSON.stringify(OK) };
  };
  const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl });
  await provider.call({ model: 'claude-sonnet-4-6', prompt: 'p' });
  assert.equal(bodies.length, 1);
  assert.equal('temperature' in bodies[0], false);
});

// ── Fix 2: 401/403 → explicit, actionable auth error (no key leak) ───────────

const AUTH_STATUSES = [401, 403];

for (const status of AUTH_STATUSES) {
  test(`anthropic: HTTP ${status} yields a clear auth error mentioning config.apiKeys.anthropic (key not logged)`, async () => {
    const fetchImpl = async () => ({ ok: false, status, text: async () => '{"error":{"message":"invalid x-api-key"}}' });
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-SECRET-should-never-appear', fetchImpl });
    await assert.rejects(
      () => provider.call({ model: 'claude-sonnet-4-6', prompt: 'p' }),
      (e) => {
        assert.equal(e.code, 'auth_failed', 'explicit auth code, not the generic request_failed');
        assert.equal(e.status, status);
        assert.match(e.message, /api key/i, 'message names the problem in plain language');
        assert.match(e.message, /config\.apiKeys\.anthropic|ANTHROPIC_API_KEY|~\/\.odw\/config\.json/, 'message points at the fix');
        assert.doesNotMatch(e.message, /SECRET/, 'the API key value must never leak into the error');
        return true;
      },
    );
  });

  test(`openai: HTTP ${status} yields a clear auth error mentioning config.apiKeys.openai (key not logged)`, async () => {
    const fetchImpl = async () => ({ ok: false, status, text: async () => '{"error":{"message":"Incorrect API key provided"}}' });
    const provider = createOpenAIProvider({ apiKey: 'sk-SECRET-should-never-appear', fetchImpl });
    await assert.rejects(
      () => provider.call({ model: 'gpt-4o', prompt: 'p' }),
      (e) => {
        assert.equal(e.code, 'auth_failed');
        assert.equal(e.status, status);
        assert.match(e.message, /api key/i);
        assert.match(e.message, /config\.apiKeys\.openai|OPENAI_API_KEY|~\/\.odw\/config\.json/, 'message points at the fix');
        assert.doesNotMatch(e.message, /SECRET/);
        return true;
      },
    );
  });
}

test('openai-compatible provider: auth error uses the configured provider name in the hint', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const provider = createOpenAIProvider({ apiKey: 'k', name: 'opencode-zen', fetchImpl });
  await assert.rejects(
    () => provider.call({ model: 'some-model', prompt: 'p' }),
    (e) => {
      assert.equal(e.code, 'auth_failed');
      assert.match(e.message, /config\.apiKeys\.opencode-zen|opencode-zen/, 'hint uses the configured provider name');
      return true;
    },
  );
});
