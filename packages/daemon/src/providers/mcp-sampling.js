/**
 * MCP-sampling host-model backend for ODW's embedded orchestrator.
 *
 * The host-agnostic twin of the OpenCode backend (host-provider.js): instead of
 * OpenCode's client.session.prompt, it dispatches every ODW agent job through an
 * MCP `sampling/createMessage` request back to the connected MCP CLIENT — so the
 * client's ALREADY-AUTHENTICATED model runs the inference. Keyless: no separate
 * ODW provider key, no daemon. Works on ANY MCP client that advertises the
 * `sampling` capability; a client that doesn't is gated out before this backend
 * is ever constructed (see the engine-hosting server's capability probe).
 *
 * `sampler` is anything exposing createMessage(params, opts) — in production the
 * MCP Server, adapted so createMessage issues the server->client request.
 *
 * Notes mirrored from the OpenCode backend's hard-won lessons:
 *  - MCP sampling results carry NO token usage, so we return only { text } and
 *    let createHostProvider ESTIMATE tokens — that keeps the budget runaway-rail
 *    live (host.js), exactly as with OpenCode.
 *  - includeContext is pinned to 'none': ODW builds its own hyper-scoped per-agent
 *    prompts and must not inherit the host's unrelated conversation context.
 *  - the model is DELIBERATELY not sent (modelPreferences omitted) — the host
 *    picks its own configured model, which is the keyless win.
 */

/**
 * @param {{ createMessage: (params: object, opts?: {signal?: AbortSignal}) => Promise<object> }} sampler
 * @param {{ maxTokens?: number }} [opts]
 */
export function createMcpSamplingBackend(sampler, opts = {}) {
  if (!sampler || typeof sampler.createMessage !== 'function') {
    throw new Error('createMcpSamplingBackend requires a sampler with a createMessage(params, opts) method');
  }
  const defaultMaxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 4096;

  async function invoke(job, { signal } = {}) {
    const params = {
      messages: [{ role: 'user', content: { type: 'text', text: String(job.prompt ?? '') } }],
      maxTokens: Number.isFinite(job.maxTokens) ? job.maxTokens : defaultMaxTokens,
      includeContext: 'none',
    };
    if (job.systemPrompt) params.systemPrompt = String(job.systemPrompt);
    if (Number.isFinite(job.temperature)) params.temperature = job.temperature;

    const res = await sampler.createMessage(params, signal ? { signal } : {});
    const text = res?.content?.text ?? '';

    // A host-reported error (or empty reply flagged as error) is retryable
    // infrastructure failure; a legitimately-empty reply is returned as-is and
    // left to the queue's schema-correction retry.
    if (!text && (res?.isError || res?.stopReason === 'error')) {
      const err = new Error('mcp-sampling backend: host returned an error / empty reply');
      err.code = 'service_unavailable';
      throw err;
    }
    return { text };
  }

  return { invoke };
}
