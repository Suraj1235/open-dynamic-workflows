/**
 * Engine-hosting MCP server variant — capability-gated KEYLESS execution.
 *
 * The default server (index.js) is a pure stdio->HTTP proxy to the keyed daemon.
 * This variant additionally runs ODW's REAL engine IN-PROCESS via MCP sampling
 * when the connected client advertises the `sampling` capability: the client's
 * own already-authenticated model runs every agent, so there is NO separate ODW
 * key and NO daemon. Clients that don't advertise sampling (Codex, Antigravity
 * today) transparently fall back to the daemon proxy — and light up keyless with
 * zero further code the instant they ship sampling.
 *
 * The keyless win rides entirely on the already-built seam: createMcpSamplingBackend
 * -> createHostProvider -> createEmbeddedOrchestrator (the engine reused byte-for-byte).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CreateMessageResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createEmbeddedOrchestrator, createMcpSamplingBackend } from 'odw-daemon/embedded';
import { createDaemonClient } from './daemon-client.js';
import { TOOL_DEFINITIONS, createToolHandlers } from './tools.js';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: `error: ${message}` }], isError: true });

/**
 * The single routing decision that makes any host keyless the moment it advertises
 * sampling: embedded (in-process, keyless) iff the client supports sampling AND the
 * call carries a prompt. planId runs live only in the daemon's plan cache, so it
 * always routes to the daemon.
 */
export function chooseOdwRunPath({ hasSampling, args }) {
  const hasPrompt = typeof args?.prompt === 'string' && args.prompt.length > 0;
  return hasSampling && hasPrompt ? 'embedded' : 'daemon';
}

/** Adapt the MCP Server into the { createMessage } sampler createMcpSamplingBackend expects. */
function samplerFor(server) {
  return {
    createMessage: (params, opts) =>
      server.request({ method: 'sampling/createMessage', params }, CreateMessageResultSchema, opts),
  };
}

export function createEmbeddedOdwServer({
  version = '0.0.0',
  daemonClient = createDaemonClient(),
  createOrchestrator = (opts) => createEmbeddedOrchestrator(opts),
  makeSampler = samplerFor,
} = {}) {
  const server = new Server({ name: 'odw', version }, { capabilities: { tools: {} } });
  const proxy = createToolHandlers(daemonClient);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'odw_run') {
      const hasSampling = Boolean(server.getClientCapabilities?.()?.sampling);
      if (chooseOdwRunPath({ hasSampling, args }) === 'embedded') {
        return runEmbedded(args);
      }
    }
    const handler = proxy[name];
    if (!handler) return fail(`unknown tool ${name}`);
    return handler(args);
  });

  async function runEmbedded(args) {
    try {
      const backend = createMcpSamplingBackend(makeSampler(server));
      const orch = createOrchestrator({ invoke: backend.invoke });
      const runOpts = { cwd: args.cwd || process.cwd() };
      if (Number.isFinite(args.maxAgents)) runOpts.maxAgents = args.maxAgents;
      const { workflowId, status, result } = await orch.run(String(args.prompt), runOpts);
      return text({ workflowId, status, result, mode: 'embedded-sampling' });
    } catch (error) {
      return fail(String(error?.message ?? error));
    }
  }

  return { server, chooseOdwRunPath };
}
