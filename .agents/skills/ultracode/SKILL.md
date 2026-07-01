---
name: ultracode
description: Ultracode-style dynamic workflows for Zed Agent. Use when the user says "ultracode", "workflow:", "/deep-research", or wants broad multi-file work with planning, parallel execution, verification, or crash-resume.
---

# Ultracode Through Open Dynamic Workflows for Zed Agent

Use this skill when the user invokes `/ultracode`, says `ultracode`, says `workflow:`, or asks for large coding work that benefits from explicit planning, parallel agents, verification, budgets, or crash-resumable execution.

The ODW context server should already be available from `.zed/settings.json`. The bridge scripts referenced below live next to this skill in `scripts/`.

## Step 0: Check the daemon

Run:

```bash
node scripts/daemon-bridge.js --check
```

- Exit 0: use the daemon path.
- Exit 1 with auth guidance: tell the user to copy `~/.odw/daemon.token` into `ODW_DAEMON_TOKEN` or the host setting.
- Exit 1 because the daemon is offline: tell the user to run `odw-daemon start` or `odw-daemon doctor zed`.

## Daemon Path

1. Prefer MCP/context-server tools when available: call `odw_health`, then `odw_run` for direct execution or `odw_plan` first when the user wants to review the plan, the task is expensive, or mutation risk is high.
2. If tools are unavailable but the daemon is reachable, use the local bridge:
   - `node scripts/daemon-bridge.js plan "<task>"`
   - `node scripts/daemon-bridge.js exec plan.json`
   - `node scripts/daemon-bridge.js status <workflowId>`
   - `node scripts/daemon-bridge.js result <workflowId>`
3. Report the workflow id, topology, agent count, cost/time estimate, and final synthesized result. Do not redo the same work manually while ODW is running it.

## Zed-Native Fallback

If the daemon is unavailable, state that full ultracode requires the daemon, then use Zed Agent's native planning and editing flow: discovery -> parallel work -> adversarial verification -> synthesis.

Never include secrets in prompts, plans, logs, or workflow artifacts.
