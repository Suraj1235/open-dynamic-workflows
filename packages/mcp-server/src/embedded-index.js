#!/usr/bin/env node
/**
 * odw KEYLESS MCP server — stdio entry. Runs ODW's real engine in-process on the
 * connecting client's own model when the client advertises MCP sampling; falls
 * back to the keyed daemon proxy otherwise. Wired behind ODW_MCP_SAMPLING by the
 * integration installer so it's opt-in and non-regressing.
 */
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEmbeddedOdwServer } from './embedded-server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { server } = createEmbeddedOdwServer({ version });
await server.connect(new StdioServerTransport());
