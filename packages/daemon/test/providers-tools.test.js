/**
 * Provider callWithTools wire mapping: the queue's neutral transcript →
 * each provider's native shape, and the native tool-call response → neutral
 * {id, name, args}. Fetch is injected via fetchImpl (the unit.test.js
 * provider-test convention), so no real network is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAnthropicProvider } = await import('../src/providers/anthropic.js');
const { createOpenAIProvider } = await import('../src/providers/openai.js');
const { createOllamaProvider } = await import('../src/providers/ollama.js');
const { createHostProvider } = await import('../src/providers/host.js');

const fakeFetch = (assertFn, payload) => async (url, init) => {
  assertFn?.(url, JSON.parse(init.body), init);
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const TOOL_DEFS = [{
  name: 'read_file',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

const TRANSCRIPT = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: 'working', toolCalls: [{ id: 'p1', name: 'glob', args: { pattern: '*' } }] },
  { role: 'tool', toolCallId: 'p1', name: 'glob', content: '["a.js"]' },
  { role: 'tool', toolCallId: 'p2', name: 'glob', content: 'boom', isError: true },
];

// ── anthropic ────────────────────────────────────────────────────────────────

test('anthropic callWithTools: tools + transcript map to native blocks, NEVER output_config, tool_use parsed', async () => {
  let captured;
  const provider = createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured = body; }, {
      content: [
        { type: 'text', text: 'I will read' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.js' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
  });
  const res = await provider.callWithTools({
    model: 'claude-opus-4-8',
    systemPrompt: 'sys',
    temperature: 0.3,
    schema: { type: 'object' }, // must NOT become output_config on a tool call
    messages: TRANSCRIPT,
    tools: TOOL_DEFS,
  });
  assert.equal(captured.output_config, undefined, 'forced format + tools is rejected by the API — never send it');
  assert.deepEqual(captured.tools, [{ name: 'read_file', description: 'read a file', input_schema: TOOL_DEFS[0].inputSchema }]);
  assert.equal(captured.system, 'sys');
  assert.equal(captured.temperature, 0.3, 'temperature is sent on the wire now (dynamic 400-driven strip, not a model-name allowlist)');
  assert.deepEqual(captured.messages[0], { role: 'user', content: 'go' });
  assert.deepEqual(captured.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 'p1', name: 'glob', input: { pattern: '*' } },
    ],
  });
  // every tool_result for one assistant turn merges into a SINGLE user message
  assert.deepEqual(captured.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'p1', content: '["a.js"]' },
      { type: 'tool_result', tool_use_id: 'p2', content: 'boom', is_error: true },
    ],
  });
  assert.equal(captured.messages.length, 3);
  assert.equal(res.text, 'I will read');
  assert.deepEqual(res.toolCalls, [{ id: 'tu1', name: 'read_file', args: { path: 'a.js' } }]);
  assert.deepEqual([res.tokensInput, res.tokensOutput], [5, 3]);
});

test('anthropic callWithTools: tool-free final turn stays plain; end_turn yields no toolCalls', async () => {
  let captured;
  const provider = createAnthropicProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured = body; }, {
      content: [{ type: 'text', text: '{"n":1}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const res = await provider.callWithTools({ model: 'claude-sonnet-4-6', schema: { type: 'object' }, messages: [{ role: 'user', content: 'p' }] });
  assert.equal(captured.tools, undefined);
  assert.equal(captured.output_config, undefined, 'schema is enforced by the queue, not the wire');
  assert.equal(res.toolCalls, undefined);
  assert.equal(res.text, '{"n":1}');
});

// ── openai ───────────────────────────────────────────────────────────────────

test('openai callWithTools: tools/messages mapping, NEVER response_format, malformed arguments → parseError', async () => {
  let captured;
  const provider = createOpenAIProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured = body; }, {
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
            { id: 'c2', type: 'function', function: { name: 'glob', arguments: '{oops' } },
          ],
        },
      }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }),
  });
  const res = await provider.callWithTools({
    model: 'gpt-5-mini',
    maxTokens: 128,
    systemPrompt: 'sys',
    schema: { type: 'object' }, // must NOT become response_format on a tool call
    messages: TRANSCRIPT,
    tools: TOOL_DEFS,
  });
  assert.equal(captured.response_format, undefined, 'response_format + tools is never sent');
  assert.equal(captured.max_completion_tokens, 128, 'NEW_TOKEN_PARAM handling preserved');
  assert.deepEqual(captured.tools, [{
    type: 'function',
    function: { name: 'read_file', description: 'read a file', parameters: TOOL_DEFS[0].inputSchema },
  }]);
  assert.deepEqual(captured.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(captured.messages[1], { role: 'user', content: 'go' });
  assert.deepEqual(captured.messages[2], {
    role: 'assistant',
    content: 'working',
    tool_calls: [{ id: 'p1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }],
  });
  assert.deepEqual(captured.messages[3], { role: 'tool', tool_call_id: 'p1', content: '["a.js"]' });
  assert.deepEqual(captured.messages[4], { role: 'tool', tool_call_id: 'p2', content: 'boom' });
  // parsing: good args parse; broken JSON degrades to {} + parseError (never throws)
  assert.deepEqual(res.toolCalls[0], { id: 'c1', name: 'read_file', args: { path: 'a.js' } });
  assert.equal(res.toolCalls[1].name, 'glob');
  assert.deepEqual(res.toolCalls[1].args, {});
  assert.match(res.toolCalls[1].parseError, /unparseable tool arguments/);
  assert.equal(res.text, '');
  assert.deepEqual([res.tokensInput, res.tokensOutput], [9, 4]);
});

test('openai callWithTools: tool-free call stays plain and a normal text reply yields no toolCalls', async () => {
  let captured;
  const provider = createOpenAIProvider({
    apiKey: 'k',
    fetchImpl: fakeFetch((url, body) => { captured = body; }, {
      choices: [{ message: { content: '{"n":1}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  const res = await provider.callWithTools({ model: 'gpt-4o', maxTokens: 64, schema: { type: 'object' }, messages: [{ role: 'user', content: 'p' }] });
  assert.equal(captured.tools, undefined);
  assert.equal(captured.response_format, undefined);
  assert.equal(captured.max_tokens, 64, 'legacy models keep max_tokens');
  assert.equal(res.toolCalls, undefined);
  assert.equal(res.text, '{"n":1}');
});

// ── ollama ───────────────────────────────────────────────────────────────────

test('ollama callWithTools: tools sent WITHOUT format; object-form arguments accepted; ids synthesized', async () => {
  let captured;
  const provider = createOllamaProvider({
    fetchImpl: fakeFetch((url, body) => { captured = body; }, {
      message: {
        content: '',
        // ollama emits arguments as an OBJECT and no call id
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }],
      },
      prompt_eval_count: 6,
      eval_count: 2,
    }),
  });
  const res = await provider.callWithTools({
    model: 'ollama:llama3',
    schema: { type: 'object' }, // a forced format would suppress tool_calls — must be absent
    messages: TRANSCRIPT,
    tools: TOOL_DEFS,
  });
  assert.equal(captured.model, 'llama3');
  assert.equal(captured.format, undefined, 'format never rides along with tools');
  assert.deepEqual(captured.tools, [{
    type: 'function',
    function: { name: 'read_file', description: 'read a file', parameters: TOOL_DEFS[0].inputSchema },
  }]);
  assert.deepEqual(captured.messages[1].tool_calls, [{ function: { name: 'glob', arguments: { pattern: '*' } } }], 'arguments stay an object on the ollama wire');
  assert.deepEqual(captured.messages[2], { role: 'tool', tool_name: 'glob', content: '["a.js"]' });
  assert.deepEqual(res.toolCalls[0].args, { path: 'a.js' }, 'object-form arguments handled');
  assert.equal(res.toolCalls[0].name, 'read_file');
  assert.ok(res.toolCalls[0].id, 'id synthesized when ollama provides none');
  assert.deepEqual([res.tokensInput, res.tokensOutput], [6, 2]);
});

test('ollama callWithTools: string-form arguments also parse; format applies on the tool-FREE final call', async () => {
  const provider = createOllamaProvider({
    fetchImpl: fakeFetch(undefined, {
      message: { content: '', tool_calls: [{ function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }] },
    }),
  });
  const res = await provider.callWithTools({ model: 'ollama:llama3', messages: [{ role: 'user', content: 'p' }], tools: TOOL_DEFS });
  assert.deepEqual(res.toolCalls[0].args, { pattern: '*.js' }, 'string-form arguments handled too');

  let captured;
  const provider2 = createOllamaProvider({
    fetchImpl: fakeFetch((url, body) => { captured = body; }, { message: { content: '{}' } }),
  });
  await provider2.callWithTools({ model: 'ollama:llama3', schema: { type: 'object' }, messages: [{ role: 'user', content: 'p' }] });
  assert.deepEqual(captured.format, { type: 'object' }, 'the queue’s final schema turn lets ollama enforce format');
  assert.equal(captured.tools, undefined);
});

// ── host ─────────────────────────────────────────────────────────────────────

test('host provider: plain-text protocol maps neutral transcript to tool calls', async () => {
  let captured;
  const provider = createHostProvider({
    invoke: async (job) => {
      captured = job;
      return { text: '{"text":"reading","toolCalls":[{"id":"h1","name":"read_file","args":{"path":"a.js"}}]}', usage: { input: 9, output: 4 } };
    },
  });
  const res = await provider.callWithTools({
    model: 'host:default',
    systemPrompt: 'sys',
    schema: { type: 'object' },
    messages: TRANSCRIPT,
    tools: TOOL_DEFS,
  });
  assert.match(captured.prompt, /ODW_TEXT_TOOL_PROTOCOL/);
  assert.match(captured.prompt, /read_file/);
  assert.match(captured.prompt, /role=tool/);
  assert.equal(captured.messages, undefined);
  assert.equal(captured.tools, undefined);
  assert.equal(captured.schema, undefined);
  assert.equal(captured.systemPrompt, undefined);
  assert.equal(res.text, 'reading');
  assert.deepEqual(res.toolCalls, [{ id: 'h1', name: 'read_file', args: { path: 'a.js' } }]);
  assert.deepEqual([res.tokensInput, res.tokensOutput], [9, 4]);
});

test('host provider: tool-free final turn returns raw text for queue schema validation', async () => {
  let captured;
  const provider = createHostProvider({
    invoke: async (job) => {
      captured = job;
      return '{"summary":"done"}';
    },
  });
  const res = await provider.callWithTools({
    model: 'host:default',
    schema: { type: 'object' },
    messages: [{ role: 'user', content: 'Respond with ONLY JSON' }],
  });
  assert.doesNotMatch(captured.prompt, /ODW_TEXT_TOOL_PROTOCOL/);
  assert.equal(res.text, '{"summary":"done"}');
  assert.equal(res.toolCalls, undefined);
});
