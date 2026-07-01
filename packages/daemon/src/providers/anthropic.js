/**
 * Anthropic Messages API adapter.
 * POST {baseURL}/v1/messages — headers: x-api-key, anthropic-version: 2023-06-01.
 * max_tokens REQUIRED top-level; system top-level; content = typed blocks.
 * Structured output: output_config.format json_schema (fallback: prompt-embedded).
 * Newer models (opus 4.7+) reject the temperature field; rather than a stale
 * model allowlist we detect the API's "temperature unsupported" 400 and retry
 * ONCE without it — model-name-agnostic, so it never goes out of date.
 * usage: {input_tokens, output_tokens}.
 */

export function createAnthropicProvider({ apiKey, baseURL = 'https://api.anthropic.com', fetchImpl = fetch }) {
  if (!apiKey) throw new Error('anthropic provider requires an API key (config.apiKeys.anthropic or ANTHROPIC_API_KEY)');

  // Shared request plumbing for call() and callWithTools().
  const baseBody = (job) => {
    const body = { model: job.model, max_tokens: job.maxTokens ?? 4096 };
    if (job.systemPrompt) body.system = job.systemPrompt;
    // Always send temperature when supplied. If the model doesn't accept it the
    // API returns a 400 we recognize and post() strips-and-retries once (below),
    // instead of relying on a hardcoded model list that goes stale each release.
    if (job.temperature !== undefined) body.temperature = job.temperature;
    return body;
  };

  const sendOnce = async (body, opts) => {
    const res = await fetchImpl(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw httpError('anthropic', res.status, errorBody);
    }
    return res.json();
  };

  // Dynamic temperature self-heal: on a 400 that reports temperature is
  // unsupported/deprecated for the model, drop the field and retry EXACTLY once
  // (bounded — a second failure rethrows, never loops). Mirrors the reactive
  // context-overflow self-heal: match the error text, correct, retry once.
  const post = async (body, opts) => {
    try {
      return await sendOnce(body, opts);
    } catch (error) {
      if (error.code === 'temperature_unsupported' && 'temperature' in body) {
        const { temperature, ...withoutTemp } = body;
        void temperature;
        try {
          return await sendOnce(withoutTemp, opts);
        } catch (retryError) {
          // Self-heal already spent: a temperature-less request that STILL
          // reports "temperature unsupported" is an unexpected server state, not
          // a recoverable one — demote to a plain failure so nothing loops on it.
          if (retryError.code === 'temperature_unsupported') retryError.code = 'request_failed';
          throw retryError;
        }
      }
      throw error;
    }
  };

  const usageOf = (data) => ({
    tokensInput: data.usage?.input_tokens ?? 0,
    tokensOutput: data.usage?.output_tokens ?? 0,
  });

  const textOf = (data) => (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    name: 'anthropic',
    /**
     * @param {{model: string, systemPrompt?: string, prompt: string, maxTokens?: number,
     *          temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async call(job, opts = {}) {
      const body = { ...baseBody(job), messages: [{ role: 'user', content: job.prompt }] };
      if (job.schema) {
        body.output_config = { format: { type: 'json_schema', schema: job.schema } };
      }
      const data = await post(body, opts);
      return { text: textOf(data), ...usageOf(data), raw: data };
    },

    /**
     * Tool-loop variant: neutral transcript in, {text, toolCalls?} out.
     * NEVER sends output_config — the API rejects forced format + tools, and
     * the queue enforces schemas on the final turn via prompt + extractJson.
     * @param {{model: string, systemPrompt?: string, messages: object[],
     *          tools?: Array<{name: string, description: string, inputSchema: object}>,
     *          maxTokens?: number, temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async callWithTools(job, opts = {}) {
      const body = { ...baseBody(job), messages: toAnthropicMessages(job.messages ?? []) };
      if (job.tools?.length) {
        body.tools = job.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      }
      const data = await post(body, opts);
      let toolCalls;
      if (data.stop_reason === 'tool_use') {
        toolCalls = (data.content ?? [])
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ id: block.id, name: block.name, args: block.input ?? {} }));
      }
      return {
        text: textOf(data),
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        ...usageOf(data),
        raw: data,
      };
    },
  };
}

/** Neutral transcript → Anthropic messages (tool calls/results become content blocks). */
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      if (m.isError) block.is_error = true;
      // Anthropic requires every tool_result for one assistant turn in a SINGLE
      // following user message — merge consecutive tool results.
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

/**
 * Provider-spanning phrases that signal a context-window overflow on an HTTP 400.
 * Anthropic exposes NO machine-readable code — 'prompt is too long' is the only
 * signal — and self-hosted OpenAI-compatible servers (vLLM/sglang/Gemini) ship
 * their own phrasings, so the set is broad and lives in one editable place.
 */
export const CONTEXT_OVERFLOW_PHRASES = [
  'context_length_exceeded',
  'context length',
  'maximum context length',
  'context window',
  'context size',
  'too many tokens',
  'token limit',
  'prompt is too long',
  'input is too long',
  'input length and max_tokens exceed context limit',
  'input token count exceeds',
  'is longer than the model',
  'reduce the length of the messages',
];

/**
 * Phrases on an HTTP 400 that mean the model rejected the `temperature` field
 * (newer models deprecate sampling params). Kept broad and editable in one
 * place — like CONTEXT_OVERFLOW_PHRASES — so detection is model-name-agnostic
 * and survives future model releases without a code change.
 */
export const TEMPERATURE_UNSUPPORTED_PHRASES = [
  'temperature is deprecated',
  'temperature is not supported',
  'temperature is no longer supported',
  'temperature parameter is not supported',
  'does not support temperature',
  'unsupported parameter: temperature',
  'unsupported_parameter: temperature',
  'temperature: this parameter is not supported',
  'temperature and top_p cannot both be specified',
];

export function httpError(provider, status, body) {
  const text = String(body ?? '');
  const err = new Error(`${provider} HTTP ${status}: ${text.slice(0, 300)}`);
  err.status = status;

  if (status === 429) err.code = 'rate_limit';
  else if (status === 408 || status === 504) err.code = 'timeout';
  else if (status >= 500) err.code = 'service_unavailable';
  else if (status === 401 || status === 403) {
    // A present-but-invalid API key. Give an actionable message instead of a
    // raw body slice, and NEVER echo the key. Non-retryable by design (not in
    // the RETRYABLE set) — retrying a bad key just burns attempts.
    err.code = 'auth_failed';
    err.message =
      `${provider} rejected the API key (HTTP ${status}) — verify config.apiKeys.${provider} ` +
      `or the ${provider.toUpperCase()}_API_KEY env var in ~/.odw/config.json`;
  } else if ((status === 400 || status === 413) && isContextOverflow(text)) {
    // Sub-classify the recoverable 400 so the queue self-heals (compact + retry)
    // instead of treating it as a generic non-retryable failure (the hermes-agent
    // #813 bug). Auth/schema 400s stay 'request_failed' and never enter the loop.
    err.code = 'context_overflow';
    const nums = parseOverflowTokens(text);
    if (nums.requestedTokens) err.requestedTokens = nums.requestedTokens;
    if (nums.limitTokens) err.limitTokens = nums.limitTokens;
  } else if (status === 400 && isTemperatureUnsupported(text)) {
    // Sub-classify so the anthropic provider strips temperature and retries once.
    err.code = 'temperature_unsupported';
  } else err.code = 'request_failed';

  return err;
}

function isContextOverflow(body) {
  const lower = body.toLowerCase();
  return CONTEXT_OVERFLOW_PHRASES.some((p) => lower.includes(p));
}

function isTemperatureUnsupported(body) {
  const lower = body.toLowerCase();
  return TEMPERATURE_UNSUPPORTED_PHRASES.some((p) => lower.includes(p));
}

/**
 * Best-effort extraction of the limit + requested token counts from the error
 * message, enabling a single corrective trim instead of blind halving. Brittle
 * by nature (phrasing varies by provider) so callers MUST tolerate undefined.
 */
function parseOverflowTokens(body) {
  // Anthropic: "prompt is too long: 233153 tokens > 200000 maximum"
  const gt = body.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (gt) return { requestedTokens: toInt(gt[1]), limitTokens: toInt(gt[2]) };
  // OpenAI: "maximum context length is 128000 tokens. However, you requested 130000 tokens"
  const max = body.match(/maximum context length is (\d[\d,]*)/i);
  const req = body.match(/you requested (\d[\d,]*)/i);
  return { limitTokens: max ? toInt(max[1]) : undefined, requestedTokens: req ? toInt(req[1]) : undefined };
}

function toInt(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
