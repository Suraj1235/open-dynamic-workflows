/**
 * OpenCode host-model backend for ODW's embedded orchestrator.
 *
 * Maps an ODW agent job onto OpenCode's own SDK so every sub-agent runs on the
 * user's ALREADY-CONFIGURED model/auth — no external ODW key, no daemon. This is
 * the leaf that the embedded orchestrator calls in place of an external provider.
 *
 * Verified LIVE against OpenCode CLI 1.2.27 (not just SDK typings):
 *  - body.model is an OBJECT { providerID, modelID } — so we OMIT it to inherit
 *    the host's configured model (the keyless win); only set it if explicitly forced.
 *  - NEVER set noReply:true — it means "context only, do not generate" and the
 *    response echoes the USER parts back (20-50ms non-replies that are your own
 *    prompt). A normal prompt's response carries the assistant reply in the
 *    top-level `parts` array of an {info, parts} payload.
 *  - there is NO body.format / json_schema field — structured output is handled by
 *    the queue's existing schema-suffix + tolerant extractJson cascade upstream.
 *  - body.system is a first-class field for the system prompt.
 *  - session.prompt resolves (does NOT reject) on upstream failure, with empty
 *    parts and the error in payload.info.error.
 *
 * ISOLATION: every invoke() runs in a FRESH, SINGLE-USE child session. Without
 * noReply, prompts append to a session's conversation history — a reused/pooled
 * session would leak every previous agent's conversation into the next agent's
 * context (cross-task contamination + unbounded context growth). Create overhead
 * is ~tens of ms against multi-second model calls, and fresh sessions also give
 * unlimited parallel fan-out with zero same-session serialization.
 *
 * DELETION IS DEFERRED to dispose() at end-of-run, NOT done per-call: deleting a
 * session immediately after its reply races OpenCode's own async work on that
 * session (title generation etc.) — verified live on 1.2.27, where an immediate
 * delete produced a server-side NotFoundError unhandled rejection and stalled
 * the workflow. Bulk deletion after the run (the pattern the original pool used)
 * is race-free.
 */

export function createOpencodeBackend(client, opts = {}) {
  const created = []; // single-use child sessions, bulk-deleted at dispose()

  function readId(res) {
    return res?.id ?? res?.data?.id ?? null;
  }

  async function invoke(job, { signal } = {}) {
    let id = null;
    if (typeof client?.session?.create === 'function') {
      try {
        id = readId(await client.session.create({ body: { title: `odw-agent-${created.length}` } }));
      } catch { /* fall through to the caller-provided session below */ }
      if (id) {
        created.push(id);
        // Let the caller track ODW-owned sessions so its chat.message hook can
        // skip them — child prompts MUST NOT re-trigger orchestration.
        opts.onSessionCreate?.(id);
      }
    }
    // Degraded fallback only: a caller-provided session accumulates history
    // across calls (no isolation) — better than failing outright.
    if (!id && opts.sessionID) id = opts.sessionID;
    if (!id) {
      throw new Error('opencode backend: no session available (client.session.create unavailable)');
    }

    const body = {
      parts: [{ type: 'text', text: String(job.prompt ?? '') }],
    };
    if (job.systemPrompt) body.system = String(job.systemPrompt);
    // model OMITTED → inherit the user's configured OpenCode model/auth (keyless).
    // Only force a specific model when explicitly requested as "providerID/modelID".
    if (typeof opts.model === 'string' && opts.model.includes('/')) {
      const [providerID, modelID] = opts.model.split('/');
      body.model = { providerID, modelID };
    }

    const init = signal ? { signal } : undefined;
    const res = await client.session.prompt({ path: { id }, body }, init);
    const payload = res?.data ?? res ?? {};
    const parts = payload.parts ?? payload.info?.parts ?? [];
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (process.env.ODW_DEBUG && !invoke._shapeLogged) {
      invoke._shapeLogged = true;
      console.error(`[odw] first invoke shape: hasData=${res?.data != null} keys=${Object.keys(payload).join(',')} parts.length=${parts.length} text.length=${text.length}`);
    }
    // An unreachable/failed upstream makes session.prompt RESOLVE with zero
    // text and an error in info (verified live: ConnectionRefused → parts=[]).
    // Only a host-reported error is retryable infrastructure failure; a
    // legitimately-empty reply (no error) is returned as-is and left to the
    // queue's schema-correction retry, which can tell the model what it expected.
    if (!text && payload.info?.error) {
      const err = new Error(`opencode backend: empty reply — host error: ${JSON.stringify(payload.info.error).slice(0, 200)}`);
      err.code = 'service_unavailable';
      throw err;
    }
    return { text };
  }

  async function dispose() {
    if (typeof client?.session?.delete === 'function') {
      for (const id of created.splice(0)) {
        try { await client.session.delete({ path: { id } }); } catch { /* ignore */ }
      }
    } else {
      created.length = 0;
    }
  }

  return { invoke, dispose };
}
