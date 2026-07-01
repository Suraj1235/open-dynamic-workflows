#!/usr/bin/env node
/**
 * Daemon bridge for skill-based harnesses (Codex, Antigravity, anything that
 * can run a shell command). Plain CommonJS, zero dependencies.
 *
 *   daemon-bridge.js --check                 → exit 0 if daemon healthy, 1 otherwise
 *   daemon-bridge.js plan "<prompt>"         → plan JSON to stdout (also saves plan.json)
 *   daemon-bridge.js exec <plan.json>        → workflowId to stdout
 *   daemon-bridge.js status <workflowId>     → status JSON
 *   daemon-bridge.js result <workflowId>     → blocks until done, prints result JSON
 *   daemon-bridge.js list                    → all workflows
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function daemonPort() {
  if (process.env.ODW_DAEMON_PORT) return Number(process.env.ODW_DAEMON_PORT);
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.env.ODW_HOME || path.join(os.homedir(), '.odw'), 'config.json'), 'utf8')
    );
    if (config.daemon && config.daemon.port) return Number(config.daemon.port);
  } catch {
    /* default */
  }
  return 7345;
}

// Bearer token for the daemon: env wins over ~/.odw/daemon.token. Resolved
// lazily per request — the daemon (and its token file) may be started after
// this process. Absent/unreadable file means "no token".
function daemonToken() {
  if (process.env.ODW_DAEMON_TOKEN) return process.env.ODW_DAEMON_TOKEN;
  try {
    const raw = fs.readFileSync(
      path.join(process.env.ODW_HOME || path.join(os.homedir(), '.odw'), 'daemon.token'),
      'utf8'
    );
    // Strip a UTF-8 BOM if present — editors and PowerShell on Windows often write one.
    return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim() || null;
  } catch {
    return null;
  }
}

const AUTH_GUIDANCE = 'odw daemon requires an auth token (copy ~/.odw/daemon.token or set ODW_DAEMON_TOKEN)';

const BASE = `http://127.0.0.1:${daemonPort()}`;

async function request(method, route, body) {
  // Headers are built unconditionally so GETs carry the token too.
  const headers = body ? { 'content-type': 'application/json' } : {};
  const token = daemonToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // 401 means the daemon IS running but the token is missing/wrong — never
    // report it as unreachable/offline.
    const error = new Error(AUTH_GUIDANCE);
    error.unauthorized = true;
    throw error;
  }
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  if (command === '--check') {
    try {
      const health = await request('GET', '/health');
      console.log(`odw daemon healthy on ${BASE} — ${health.activeWorkflows} active workflow(s)`);
      process.exit(0);
    } catch (error) {
      if (error.unauthorized) {
        console.error(error.message);
      } else {
        console.error(`odw daemon not reachable on ${BASE}. Install from github.com/Suraj1235/open-dynamic-workflows (clone, npm install, npm run setup), then: odw-daemon start`);
      }
      process.exit(1);
    }
  }

  if (command === 'plan') {
    if (!arg) throw new Error('usage: daemon-bridge.js plan "<prompt>"');
    const { plan } = await request('POST', '/workflows/plan', { prompt: arg });
    fs.writeFileSync('plan.json', JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({
      planId: plan.planId,
      topology: plan.topology,
      estimate: plan.estimate,
      tasks: plan.taskGraph.tasks.map((t) => ({ id: t.id, type: t.type, parallelizable: t.parallelizable })),
      savedTo: 'plan.json',
    }, null, 2));
    return;
  }

  if (command === 'exec') {
    const plan = JSON.parse(fs.readFileSync(arg || 'plan.json', 'utf8'));
    const { workflowId } = await request('POST', '/workflows/exec', { plan, cwd: process.cwd() });
    console.log(workflowId);
    return;
  }

  if (command === 'status') {
    if (!arg) throw new Error('usage: daemon-bridge.js status <workflowId>');
    const record = await request('GET', `/workflows/${arg}`);
    console.log(JSON.stringify({
      workflowId: arg, status: record.status,
      agents: { total: record.total_agents, completed: record.completed_agents, failed: record.failed_agents },
      costUSD: record.cost_usd, nodeStats: record.nodeStats,
    }, null, 2));
    return;
  }

  if (command === 'result') {
    if (!arg) throw new Error('usage: daemon-bridge.js result <workflowId>');
    const body = await request('GET', `/workflows/${arg}/result?wait`);
    console.log(JSON.stringify(body, null, 2));
    process.exit(body.status === 'completed' ? 0 : 1);
  }

  if (command === 'list') {
    const { workflows } = await request('GET', '/workflows');
    console.log(JSON.stringify(workflows, null, 2));
    return;
  }

  console.error('usage: daemon-bridge.js --check | plan "<prompt>" | exec <plan.json> | status <id> | result <id> | list');
  process.exit(2);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
