import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, 'results');

const endpoint = normalizeEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const model = process.env.AZURE_OPENAI_MODEL || 'Kimi-K2.6';
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview';

test('Azure endpoint serves Kimi-K2.6 chat completions', async () => {
  assert.ok(endpoint, 'AZURE_OPENAI_ENDPOINT is required');
  assert.ok(apiKey, 'AZURE_OPENAI_API_KEY is required');

  const body = {
    model,
    messages: [
      { role: 'system', content: 'Return only compact JSON.' },
      { role: 'user', content: 'Reply with {"framework":"working","model":"Kimi-K2.6"}.' },
    ],
    max_tokens: 512,
    temperature: 0,
  };

  const candidates = candidateUrls(endpoint, model, apiVersion);
  const attempts = [];

  for (const url of candidates) {
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    attempts.push({
      url: redactUrl(url),
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      bodyPreview: redact(text).slice(0, 600),
    });

    if (!response.ok) continue;

    const parsed = JSON.parse(text);
    const message = parsed.choices?.[0]?.message ?? {};
    const content = message.content ?? parsed.output_text ?? '';
    await persistResult({
      ok: true,
      model,
      selectedUrl: redactUrl(url),
      attempts,
      responseModel: parsed.model,
      finishReason: parsed.choices?.[0]?.finish_reason,
      usage: parsed.usage,
      contentPreview: content.slice(0, 600),
      reasoningPreview: (message.reasoning_content ?? '').slice(0, 600),
    });

    assert.equal(parsed.model, model);
    assert.match(content, /working|Kimi-K2\.6/i);
    return;
  }

  await persistResult({ ok: false, model, attempts });
  assert.fail(`No Azure chat-completions route succeeded. See ${join('Tests', 'results', 'azure-kimi-smoke-result.json')}`);
});

function normalizeEndpoint(value) {
  return value ? value.replace(/\/+$/, '') : '';
}

function candidateUrls(base, deployment, version) {
  const encoded = encodeURIComponent(deployment);
  const withVersion = `api-version=${encodeURIComponent(version)}`;
  return [
    `${base}/models/chat/completions?${withVersion}`,
    `${base}/openai/deployments/${encoded}/chat/completions?${withVersion}`,
    `${base}/openai/v1/chat/completions?${withVersion}`,
    `${base}/openai/chat/completions?${withVersion}`,
    `${base}/chat/completions`,
  ];
}

async function persistResult(result) {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, 'azure-kimi-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

function redactUrl(value) {
  return redact(value).replace(/api-key=[^&]+/gi, 'api-key=<redacted>');
}

function redact(value) {
  if (!value) return value;
  let output = String(value);
  if (apiKey) output = output.split(apiKey).join('<redacted>');
  return output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
}
