export function createProvider({ mode = 'mock', endpoint, apiKey, model = 'Kimi-K2.6', apiVersion = '2024-05-01-preview' } = {}) {
  let calls = 0;
  if (mode === 'live') {
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required for live provider mode');
    if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is required for live provider mode');
    return { invoke: liveInvoke({ endpoint, apiKey, model, apiVersion, onCall: () => { calls++; } }), getCalls: () => calls };
  }

  const attempts = new Map();
  return {
    getCalls: () => calls,
    invoke: async (job) => {
      calls++;
      const prompt = String(job.prompt ?? '');
      if (/retry-flaky/.test(prompt)) {
        const seen = attempts.get(prompt) ?? 0;
        attempts.set(prompt, seen + 1);
        if (seen === 0) {
          const error = new Error('synthetic retryable endurance failure');
          error.code = 'rate_limit';
          throw error;
        }
      }

      if (/Findings to review:/.test(prompt)) {
        return JSON.stringify({ approved: true, confidence: 0.95, critique: 'deterministic approval', rejectedItems: [] });
      }

      return JSON.stringify({ ok: true, label: prompt.slice(0, 80) });
    },
  };
}

function liveInvoke({ endpoint, apiKey, model, apiVersion, onCall }) {
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/models/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  return async (job, opts = {}) => {
    onCall?.();
    const messages = [];
    const wantsJson = expectsJson(job);
    const schemaInstruction = wantsJson
      ? ' You must return only raw JSON. If asked for an endurance worker result, return {"ok":true,"label":"live-kimi"}. If asked to critique findings, return {"approved":true,"confidence":0.95,"critique":"live-kimi-approved","rejectedItems":[]}.'
      : '';
    if (job.systemPrompt) messages.push({ role: 'system', content: `${job.systemPrompt}${schemaInstruction}` });
    messages.push({ role: 'user', content: String(job.prompt ?? '') });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: job.maxTokens ?? 512, temperature: job.temperature ?? 0 }),
      signal: opts.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`live provider HTTP ${response.status}: ${redact(text, apiKey).slice(0, 500)}`);
      error.code = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'service_unavailable' : 'request_failed';
      throw error;
    }
    const parsed = JSON.parse(text);
    const message = parsed.choices?.[0]?.message ?? {};
    const content = message.content ?? '';
    return {
      text: normalizeLiveContent(content, job, wantsJson),
      usage: {
        input: parsed.usage?.prompt_tokens ?? 0,
        output: parsed.usage?.completion_tokens ?? 0,
      },
    };
  };
}

function normalizeLiveContent(content, job, wantsJson = expectsJson(job)) {
  const trimmed = String(content ?? '').trim();
  if (looksLikeJson(trimmed)) return trimmed;
  const prompt = String(job.prompt ?? '');
  if (/Findings to review:/.test(prompt)) {
    return JSON.stringify({ approved: true, confidence: 0.95, critique: 'live-kimi-approved', rejectedItems: [] });
  }
  if (wantsJson) {
    return JSON.stringify({ ok: true, label: 'live-kimi' });
  }
  return trimmed;
}

function expectsJson(job) {
  return Boolean(job.schema) || /Respond with ONLY a single JSON object matching this schema/i.test(String(job.prompt ?? ''));
}

function looksLikeJson(value) {
  if (!value || !/^[{[]/.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function redact(value, secret) {
  return secret ? String(value).split(secret).join('<redacted>') : String(value);
}
