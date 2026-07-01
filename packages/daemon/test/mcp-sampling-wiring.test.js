import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServerCommand } from '../src/integrations.js';

// The installer must default to the proxy entry (no regression) and switch every
// host's MCP config to the keyless engine-hosting entry when ODW_MCP_SAMPLING is
// set — one flag lights up keyless for every host the instant it ships sampling.
test('mcpServerCommand: defaults to the proxy entry', () => {
  const prev = process.env.ODW_MCP_SAMPLING;
  delete process.env.ODW_MCP_SAMPLING;
  try {
    assert.match(mcpServerCommand({ repoRoot: '/repo' }).args[0], /packages\/mcp-server\/src\/index\.js$/);
  } finally {
    if (prev !== undefined) process.env.ODW_MCP_SAMPLING = prev;
  }
});

test('mcpServerCommand: points at the keyless embedded entry when ODW_MCP_SAMPLING is set', () => {
  const prev = process.env.ODW_MCP_SAMPLING;
  process.env.ODW_MCP_SAMPLING = '1';
  try {
    assert.match(mcpServerCommand({ repoRoot: '/repo' }).args[0], /packages\/mcp-server\/src\/embedded-index\.js$/);
  } finally {
    if (prev === undefined) delete process.env.ODW_MCP_SAMPLING;
    else process.env.ODW_MCP_SAMPLING = prev;
  }
});
