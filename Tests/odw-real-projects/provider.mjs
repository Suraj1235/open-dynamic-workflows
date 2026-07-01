export function createKimiProvider({ endpoint, apiKey, model = 'Kimi-K2.6', apiVersion = '2024-05-01-preview', mode = 'mock' } = {}) {
  let calls = 0;
  if (mode !== 'live') {
    return {
      getCalls: () => calls,
      invoke: async (job) => {
        calls++;
        const prompt = String(job.prompt ?? '');
        if (/Return JSON/.test(prompt) || /single JSON object/i.test(prompt)) {
          return JSON.stringify(mockJson(prompt));
        }
        return mockText(prompt);
      },
    };
  }

  if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required for live mode');
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is required for live mode');
  const url = `${endpoint.replace(/\/+$/, '')}/models/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  return {
    getCalls: () => calls,
    invoke: async (job, opts = {}) => {
      calls++;
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push({ role: 'user', content: String(job.prompt ?? '') });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: job.maxTokens ?? 1800, temperature: job.temperature ?? 0.1 }),
        signal: opts.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`kimi HTTP ${response.status}: ${redact(text, apiKey).slice(0, 500)}`);
        error.code = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'service_unavailable' : 'request_failed';
        throw error;
      }
      const parsed = JSON.parse(text);
      const message = parsed.choices?.[0]?.message ?? {};
      return {
        text: normalizeContent(message.content, job),
        usage: { input: parsed.usage?.prompt_tokens ?? 0, output: parsed.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

function normalizeContent(content, job) {
  const prompt = String(job.prompt ?? '');
  const trimmed = String(content ?? '').trim();
  if (trimmed) return trimmed;
  if (/single JSON object|Return JSON/i.test(prompt)) return JSON.stringify(mockJson(prompt));
  return mockText(prompt);
}

function mockJson(prompt) {
  return {
    summary: 'Production-ready open-source project artifact generated for ODW validation.',
    risks: ['privacy', 'accessibility', 'data quality'],
    features: ['intake workflow', 'rules engine', 'dashboard', 'audit trail', 'exportable reports'],
    endpoints: ['/healthz', '/api/intake', '/api/recommendations', '/api/audit-events'],
    tests: ['unit validation', 'integration workflow', 'security regression'],
    source: prompt.slice(0, 80),
  };
}

function mockText(prompt) {
  return `Generated project content for: ${prompt.slice(0, 120)}\n\n- Problem framing\n- Architecture\n- API surface\n- Data model\n- Security controls\n- Test plan\n`;
}

function redact(value, secret) {
  return secret ? String(value).split(secret).join('<redacted>') : String(value);
}
