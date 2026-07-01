---
name: ultracode
description: Ultracode-style dynamic workflows for Antigravity. Use when the user says "ultracode", "workflow:", "/deep-research", or asks for broad multi-file work with planning, parallel agents, verification, or crash-resume.
---

# Ultracode Through Open Dynamic Workflows for Antigravity

This is the Antigravity-facing ultracode alias for Open Dynamic Workflows. It routes the expected ultracode entrypoint through the same ODW daemon, MCP tools, plugin rules, and native fallback as the `odw` skill.

## Step 0: Check the daemon

Run:

```bash
node scripts/daemon-bridge.js --check
```

- Exit 0: use the daemon path.
- Exit 1 with auth guidance: tell the user to copy `~/.odw/daemon.token` into `ODW_DAEMON_TOKEN` or the host setting.
- Exit 1 because the daemon is offline: tell the user to run `odw-daemon start` or `odw-daemon doctor antigravity`.

## Daemon Path

1. Prefer MCP tools when available: call `odw_health`, then `odw_run` for direct execution or `odw_plan` first when the user wants to review the plan, the task is expensive, or mutation risk is high.
2. If MCP tools are unavailable but the daemon is reachable, use the local bridge:
   - `node scripts/daemon-bridge.js plan "<task>"`
   - `node scripts/daemon-bridge.js exec plan.json`
   - `node scripts/daemon-bridge.js status <workflowId>`
   - `node scripts/daemon-bridge.js result <workflowId>`
3. Report the workflow id, topology, agent count, cost/time estimate, and final synthesized result. Do not redo the same work manually while ODW is running it.

## Antigravity-Native Fallback

If the daemon is unavailable, state that full ultracode requires the daemon, then use Antigravity's native planning and editing flow: discovery -> parallel work -> adversarial verification -> synthesis.

Never include secrets in prompts, plans, logs, or workflow artifacts.
