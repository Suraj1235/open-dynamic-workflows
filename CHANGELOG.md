# Changelog

This project does not use version numbers. Entries are marked by milestone.

## Native OpenCode mode LIVE-VALIDATED — two real bugs found and fixed

The embedded path was previously verified only against mocked SDK responses. A full live validation on OpenCode CLI 1.2.27 (Windows, real `opencode run`, real model round-trips through the host's own auth) completed end-to-end: plugin loaded from `.opencode/plugins/`, `ultracode` trigger fired headless, the engine ran 93 model round-trips of parallel child-session fan-out (~190s), and synthesized a real audit — **no daemon, no second API key**. The live run plus an adversarial review pass exposed three bugs the mocks had certified as correct, plus hardening:

- **`noReply: true` echo bug (critical, fixed).** `session.prompt({ noReply: true })` does NOT mean "reply without chat side-effects" — it means *context-only, no generation*, and it resolves with the **user's own parts echoed back** (20–50ms "replies" that were our own prompts). Every embedded agent was talking to itself; schema validation then correctly rejected the echoes. Fixed by letting the prompt generate normally. The unit-test mock had encoded the wrong assumption and now asserts the opposite.
- **`chat.message` recursion storm (critical, fixed).** The hook fires for every user message in **every** session of the opencode process — including the prompts ODW sends to its own child agent sessions. Agent prompts contain workflow-intent words, so each child prompt re-triggered `runEmbedded` (4 nested runs per run, ~75 sessions before the kill). Fixed with a two-layer guard: child-session IDs are registered via the backend's new `onSessionCreate` hook and skipped, and an `embeddedActive` mutex (checked and set synchronously — no await window for two triggers to interleave) caps the process at one embedded run; a trigger that loses the race gets the native-orchestration directive instead of being dropped, and per-run IDs are pruned after cleanup so the guard set can't grow unboundedly.
- **Cross-agent history contamination (critical, fixed).** Without `noReply`, every prompt *appends to the session's conversation*, so the old round-robin session pool leaked each agent's conversation into the next agent's context (cross-task contamination + unbounded context growth). Every `invoke()` now runs in a **fresh, single-use child session**, with deletion **deferred to end-of-run** — an immediate per-call delete races OpenCode's own async work on the session (live-verified: instant deletes produced a server-side `NotFoundError` unhandled rejection and stalled the workflow). Full isolation, unlimited parallel fan-out, create cost ~tens of ms against multi-second model calls.
- **Empty-reply hardening.** An unreachable upstream makes `session.prompt` *resolve* with zero text and an error tucked in `info` (verified live: `ConnectionRefused` → `parts: []`). The backend now throws a retryable `service_unavailable` when the host reports an error, and leaves legitimately-empty replies to the queue's schema-correction retry.
- **`ODW_HOST_MODEL`** (`providerID/modelID`) forces the model for embedded agents — useful when the host default is a weak free model that can't hold the JSON contract; unset, child sessions inherit the host's configured default.
- **`ODW_DEBUG=1`** adds embedded-path observability (import failures, per-run workflow id + elapsed, first-call SDK payload shape) so a real engine break is distinguishable from the intended drop-in degrade.
- **Ops notes from the validation:** headless `opencode run` on Windows must have stdin redirected (`< NUL`) or it blocks before bootstrap; project plugins load from `.opencode/plugins/` (plural — singular silently fails). A dogfooding shim at `.opencode/plugins/odw.js` now loads the workspace plugin when this repo itself is opened in OpenCode.

## Native OpenCode mode — the engine runs on your host model (no daemon, no second key)

Closes the biggest seam in the "seamless like Claude Code" goal: ODW used to require its own external provider key + a running daemon even when you were already inside OpenCode. Now, on OpenCode, ODW's *real* engine runs embedded in the plugin and dispatches every `agent()` call through OpenCode's already-configured model.

- **Embedded orchestrator** (`odw-daemon/embedded`) — the daemon's composition root (queue + runtime + WASM sandbox) minus the HTTP server and SQLite, with a pure-JS in-memory store, so a host plugin can run the full engine in-process. odw-core, the sandbox, the primitives, the context guard, retries and budget are reused byte-for-byte.
- **Host provider** (`providers/host.js`) — a one-function agent backend: anything that takes a prompt and returns text can back `agent()`. It estimates token usage when the host hides it, so the **budget hard-stop still trips** (an embedded run can't loop on your own auth unbounded).
- **OpenCode plugin** now runs embedded by default: on a `workflow:` / `ultracode` / `/deep-research` trigger it builds the engine and routes sub-agents to `client.session.prompt()` (model omitted → inherits your configured model/auth; structured output via the existing schema-suffix cascade; a round-robin child-session pool for real parallel fan-out). Daemon and prompt-directive remain ordered fallbacks; the single-file drop-in degrades cleanly when the engine deps aren't installed.
- **Honest platform matrix.** Verified via live-docs research: only OpenCode exposes a host-model API to extensions. Codex is MCP-client-only (no host-model API, no sampling); Antigravity locks model access to its internal engine; MCP "sampling" is deprecated (SEP-2577) and unsupported by all three. So the Codex/Antigravity skills now state plainly that the no-key path is the host orchestrating itself (not the ODW engine) and the full engine needs the daemon + one key — no pretend-keyless claims.

## Context-window hardening (small-model lifeline)

Mirrors how Claude Code runs arbitrarily large tasks without exhausting the model window — sub-agent isolation and filesystem-as-memory already existed here; this adds the missing **compaction** layer so the engine never overflows a model's input window, which is the difference between a run surviving and crashing on small/free models.

- **Model context-window registry** (`odw-core`) — per-model input windows, with the llama-3 (8K) vs llama-3.1 (128K) disambiguation, and a deliberately conservative **8192-token default for unknown / `ollama:*` / `*-free` ids** (over-budgeting compacts a little early; under-budgeting crashes the call).
- **Tokenizer-free token estimator** — content-aware char/token divisors (denser for code/JSON/CJK) plus a safety margin, biased to over-count so the safe failure mode wins.
- **Pre-call context-fit guard** — before each agent call the input is measured against `(window − reserved output) × safetyFactor`; if it would overflow, only the **user-content portion** is compacted (system prompt + schema instruction are reserved and never cut). It is a pure pass-through when the input fits, and proactive compaction is **skipped for unknown-window models** so custom/local endpoints keep today's behavior.
- **Self-healing overflow recovery** — a provider `context_length_exceeded` / "prompt is too long" 400 is now classified as a distinct, **bounded** `context_overflow` (cross-provider phrase set incl. Anthropic's), and the queue compacts-and-retries instead of hard-failing the workflow. Terminating by construction (attempt cap + monotonic shrink); never added to the blind-retry set.
- **Structure-preserving compaction** — `compact()` (guest primitive) and the script-generator's dependency-context injection drop **whole** array items / object properties to a budget instead of the old blind `JSON.stringify(...).slice(N)` that could cut mid-structure; output always re-parses as valid JSON, and it is byte-identical when the value already fits.
- **Semantic `summarize()`** — opt-in map-reduce compression for prose, routed through the normal tracked `agent()` bridge (budget-counted, cached, abortable).
- **Studio Prime workflow upgrade** — parallel + `summarize()`d research (and it now actually *uses* P3 research, which the prior version discarded), context-safe `compact()` hand-off between phases, a hardened fix-until-green loop (root-cause diagnosis, repeated-failure escalation, and a one-file-at-a-time fallback for weak models), and sharper Apex verification.

## Reliability & polish pass

- **Self-correcting agent retries** — when a model returns malformed or schema-invalid JSON, the retry now re-prompts with the exact validation error and the previous bad output, so weaker/free models recover instead of failing the run.
- **More tolerant JSON extraction** — single-quoted strings, unquoted keys, Python-style `True/False/None`, and leading prose are now repaired before parsing.
- **Clear failure reasons** — failed runs surface the cause at the top level (`odw-daemon status`, `GET /workflows/:id`, and `odw-daemon run` print `reason:`). Raw QuickJS/WASM aborts are wrapped instead of leaking into the terminal.
- **Resilient `run`** — replaced the single long-held result connection with short polling that shows live progress; no more dropped multi-minute waits.
- **Windows-aware safety** — default `blockedCommands` now include destructive PowerShell/cmd patterns, matched case-insensitively.
- **Docs** — documented `baseURLs.default` for any OpenAI-compatible endpoint; clarified install-from-GitHub (and the unrelated npm name); corrected test counts.

## Initial public release

The first working cut of open-dynamic-workflows.

- **Core** — natural-language → task graph, topology selection (mapreduce, pipeline, adversarial, consensus, tree search, hybrid), hyper-scoped specialist roles, and a compiler that emits the `execute(context)` orchestration script. Pure, no I/O.
- **Daemon** — QuickJS-WASM sandbox with the full primitive set (`agent`, `parallel`, `pipeline`, `verify`, `loop`, `phase`, `log`, `checkpoint`, `budget`, `args`, `context.tools`); concurrency queue with retry/backoff and per-agent timeouts; provider adapters for Anthropic, OpenAI (and any OpenAI-compatible endpoint), and Ollama; SQLite/WAL state with deterministic crash-resume; per-workflow token and cost budgets; HTTP + WebSocket API on `127.0.0.1`; a full CLI (`start`, `stop`, `status`, `restart --resume`, `logs`, `run`, `db-check`).
- **Adapters** — OpenCode plugin (triggers, custom tools, slash commands, daemon-or-native fallback); Codex skill folder + bridge; Antigravity skill + saved workflow; VS Code extension (tree view, dashboard webview, status bar).
- **Examples** — security audit, JS→TS migration, deep research.
- **Safety** — sandbox isolation, approval-gated mutations, key redaction, loopback-only binding, hard budgets.
