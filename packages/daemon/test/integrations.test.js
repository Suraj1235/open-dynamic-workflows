import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  doctorAgentIntegration,
  installAgentIntegration,
  installAntigravity,
  installCodexMcp,
  installCodexPlugin,
  installCursorMcp,
  installGeminiMcp,
  installGenericMcpConfig,
  installKimiMcp,
  installOpencodePlugin,
  installVscodeExtension,
  installZedMcp,
  mcpServerCommand,
} from '../src/integrations.js';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const execFileAsync = promisify(execFile);

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), name));
}

/** Minimal /health responder so `doctor` sees a live daemon without booting one. */
function startProbeDaemon(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', uptime: 1, activeWorkflows: 0, activeAgents: 0,
        queuedAgents: 0, maxActiveAgentsObserved: 0, maxConcurrency: 16,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

test('mcpServerCommand points every MCP host at the local ODW MCP server', () => {
  const command = mcpServerCommand({ repoRoot });
  assert.equal(command.command, 'node');
  assert.ok(command.args[0].endsWith('packages/mcp-server/src/index.js'));
});

test('installCursorMcp writes MCP, rule, skill, subagent, and Cursor dashboard extension', () => {
  const home = tempDir('odw-cursor-home-');
  const targetDir = tempDir('odw-cursor-');
  try {
    const result = installCursorMcp({ home, targetDir, repoRoot });
    installCursorMcp({ home, targetDir, repoRoot });

    const path = join(targetDir, '.cursor', 'mcp.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers), ['odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));

    const rule = readFileSync(join(targetDir, '.cursor', 'rules', 'open-dynamic-workflows.mdc'), 'utf8');
    assert.match(rule, /alwaysApply: true/);
    assert.match(rule, /odw_run/);
    assert.match(rule, /ultracode/);

    const skill = readFileSync(join(targetDir, '.cursor', 'skills', 'odw', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\r?\nname: odw\r?\n/);
    assert.match(skill, /Cursor Agent/);
    assert.match(skill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.cursor', 'skills', 'odw', 'scripts', 'daemon-bridge.js')));

    const ultracodeSkill = readFileSync(join(targetDir, '.cursor', 'skills', 'ultracode', 'SKILL.md'), 'utf8');
    assert.match(ultracodeSkill, /^---\r?\nname: ultracode\r?\n/);
    assert.match(ultracodeSkill, /Cursor Agent/);
    assert.match(ultracodeSkill, /odw_run/);
    assert.match(ultracodeSkill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.cursor', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));

    assert.ok(result.subagentPath.replace(/\\/g, '/').endsWith('.cursor/agents/odw-orchestrator.md'));
    const subagent = readFileSync(join(targetDir, '.cursor', 'agents', 'odw-orchestrator.md'), 'utf8');
    assert.match(subagent, /^---\r?\nname: odw-orchestrator\r?\n/);
    assert.match(subagent, /model: inherit/);
    assert.match(subagent, /odw_run/);
    assert.match(subagent, /daemon-bridge\.js/);

    assert.ok(result.extensionPath.replace(/\\/g, '/').endsWith('.cursor/extensions/open-dynamic-workflows.odw-vscode-0.1.0'));
    assert.ok(existsSync(join(home, '.cursor', 'extensions', 'open-dynamic-workflows.odw-vscode-0.1.0', 'package.json')));
    assert.ok(existsSync(join(home, '.cursor', 'extensions', 'open-dynamic-workflows.odw-vscode-0.1.0', 'extension.js')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('installGenericMcpConfig writes an importable project MCP config', () => {
  const targetDir = tempDir('odw-generic-mcp-');
  try {
    writeFileSync(join(targetDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        existing: { command: 'node', args: ['server.js'] },
      },
    }));

    installGenericMcpConfig({ targetDir, repoRoot });
    installGenericMcpConfig({ targetDir, repoRoot });

    const data = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers).sort(), ['existing', 'odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));

    const agents = readFileSync(join(targetDir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /BEGIN open-dynamic-workflows/);
    assert.match(agents, /workflow:/);
    assert.match(agents, /odw_run/);
    assert.equal((agents.match(/BEGIN open-dynamic-workflows/g) ?? []).length, 1);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installKimiMcp writes Kimi Code CLI global MCP config', () => {
  const home = tempDir('odw-kimi-');
  const targetDir = tempDir('odw-kimi-target-');
  try {
    installKimiMcp({ home, targetDir, repoRoot });
    installKimiMcp({ home, targetDir, repoRoot });

    const data = JSON.parse(readFileSync(join(home, '.kimi-code', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers), ['odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));
    assert.match(readFileSync(join(targetDir, 'AGENTS.md'), 'utf8'), /Kimi Code/);

    const skill = readFileSync(join(targetDir, '.kimi', 'skills', 'odw', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\r?\nname: odw\r?\n/);
    assert.match(skill, /type: flow/);
    assert.match(skill, /\/flow:odw/);
    assert.match(skill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.kimi', 'skills', 'odw', 'scripts', 'daemon-bridge.js')));

    const ultracodeSkill = readFileSync(join(targetDir, '.kimi', 'skills', 'ultracode', 'SKILL.md'), 'utf8');
    assert.match(ultracodeSkill, /^---\r?\nname: ultracode\r?\n/);
    assert.match(ultracodeSkill, /type: flow/);
    assert.match(ultracodeSkill, /\/flow:ultracode/);
    assert.match(ultracodeSkill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.kimi', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('installGeminiMcp writes Gemini CLI settings and project instructions', () => {
  const home = tempDir('odw-gemini-home-');
  const targetDir = tempDir('odw-gemini-target-');
  try {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({
      selectedAuthType: 'oauth-personal',
      mcpServers: {
        existing: { command: 'node', args: ['existing.js'] },
      },
    }));

    const result = installGeminiMcp({ home, targetDir, repoRoot });
    installGeminiMcp({ home, targetDir, repoRoot });

    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(settings.selectedAuthType, 'oauth-personal');
    assert.deepEqual(Object.keys(settings.mcpServers).sort(), ['existing', 'odw']);
    assert.equal(settings.mcpServers.odw.command, 'node');
    assert.ok(settings.mcpServers.odw.args[0].includes('mcp-server'));

    const geminiMd = readFileSync(join(targetDir, 'GEMINI.md'), 'utf8');
    assert.match(geminiMd, /Gemini CLI/);
    assert.match(geminiMd, /mcp_odw_odw_run/);
    assert.match(geminiMd, /odw_run/);
    assert.match(geminiMd, /ultracode/);
    assert.equal((geminiMd.match(/BEGIN open-dynamic-workflows/g) ?? []).length, 1);

    assert.equal(result.kind, 'gemini');
    assert.ok(result.path.replace(/\\/g, '/').endsWith('.gemini/settings.json'));
    assert.ok(result.instructionsPath.endsWith('GEMINI.md'));
    assert.ok(result.commandsPath.endsWith(join('.gemini', 'commands')));

    const odwCommand = readFileSync(join(targetDir, '.gemini', 'commands', 'odw.toml'), 'utf8');
    const ultracodeCommand = readFileSync(join(targetDir, '.gemini', 'commands', 'ultracode.toml'), 'utf8');
    assert.match(odwCommand, /description = "Run a task through Open Dynamic Workflows"/);
    assert.match(odwCommand, /mcp_odw_odw_run/);
    assert.match(odwCommand, /\{\{args\}\}/);
    assert.match(ultracodeCommand, /description = "Run an ultracode workflow through Open Dynamic Workflows"/);
    assert.match(ultracodeCommand, /mcp_odw_odw_run/);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('installZedMcp writes project Zed context server settings', () => {
  const targetDir = tempDir('odw-zed-');
  try {
    mkdirSync(join(targetDir, '.zed'), { recursive: true });
    writeFileSync(join(targetDir, '.zed', 'settings.json'), JSON.stringify({
      theme: 'One Dark',
      context_servers: {
        existing: { command: 'node', args: ['server.js'] },
      },
    }));

    installZedMcp({ targetDir, repoRoot });
    installZedMcp({ targetDir, repoRoot });

    const data = JSON.parse(readFileSync(join(targetDir, '.zed', 'settings.json'), 'utf8'));
    assert.equal(data.theme, 'One Dark');
    assert.deepEqual(Object.keys(data.context_servers).sort(), ['existing', 'odw']);
    assert.equal(data.context_servers.odw.command, 'node');
    assert.ok(data.context_servers.odw.args[0].includes('mcp-server'));
    assert.match(readFileSync(join(targetDir, 'AGENTS.md'), 'utf8'), /Zed/);

    const skill = readFileSync(join(targetDir, '.agents', 'skills', 'odw', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\r?\nname: odw\r?\n/);
    assert.match(skill, /Zed Agent/);
    assert.match(skill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js')));

    const ultracodeSkill = readFileSync(join(targetDir, '.agents', 'skills', 'ultracode', 'SKILL.md'), 'utf8');
    assert.match(ultracodeSkill, /^---\r?\nname: ultracode\r?\n/);
    assert.match(ultracodeSkill, /Zed Agent/);
    assert.match(ultracodeSkill, /odw_run/);
    assert.match(ultracodeSkill, /daemon-bridge\.js --check/);
    assert.ok(existsSync(join(targetDir, '.agents', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installAgentIntegration zcode writes zcode-specific project guidance over Zed-compatible settings', () => {
  const targetDir = tempDir('odw-zcode-');
  try {
    const result = installAgentIntegration('zcode', { targetDir, repoRoot });
    installAgentIntegration('zcode', { targetDir, repoRoot });

    assert.equal(result.kind, 'zcode');
    assert.ok(existsSync(join(targetDir, '.mcp.json')));
    assert.ok(existsSync(join(targetDir, '.zed', 'settings.json')));

    const agents = readFileSync(join(targetDir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /For zcode/);
    assert.match(agents, /odw_run/);
    assert.match(agents, /ultracode/);

    const skill = readFileSync(join(targetDir, '.agents', 'skills', 'odw', 'SKILL.md'), 'utf8');
    assert.match(skill, /zcode/);
    assert.doesNotMatch(skill, /doctor zed/);

    const ultracodeSkill = readFileSync(join(targetDir, '.agents', 'skills', 'ultracode', 'SKILL.md'), 'utf8');
    assert.match(ultracodeSkill, /zcode/);
    assert.doesNotMatch(ultracodeSkill, /doctor zed/);

    const doctor = doctorAgentIntegration('zcode', { targetDir, repoRoot });
    assert.equal(doctor.kind, 'zcode');
    assert.equal(doctor.ok, true);
    assert.ok(doctor.checks.some((check) => check.label === 'zcode generic mcp config'));
    assert.ok(doctor.checks.some((check) => check.label === 'zcode context server config'));
    assert.ok(doctor.checks.some((check) => check.label === 'zcode agent instructions'));
    assert.ok(doctor.checks.some((check) => check.label === 'zcode ultracode agent skill'));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installCodexMcp preserves existing config and replaces the managed odw block', () => {
  const home = tempDir('odw-codex-');
  try {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-5"\n', { flag: 'w' });

    installCodexMcp({ home, repoRoot });
    installCodexMcp({ home, repoRoot });

    const text = readFileSync(join(codexDir, 'config.toml'), 'utf8');
    assert.match(text, /model = "gpt-5"/);
    assert.equal((text.match(/\[mcp_servers\.odw\]/g) ?? []).length, 1);
    assert.match(text, /command = "node"/);
    assert.match(text, /mcp-server\/src\/index\.js/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installCodexPlugin installs a Codex plugin bundle and personal marketplace entry', () => {
  const home = tempDir('odw-codex-plugin-');
  try {
    mkdirSync(join(home, '.agents', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      plugins: [
        { name: 'keep-me', source: { type: 'local', path: './keep-me' } },
      ],
    }));

    const result = installCodexPlugin({ home, repoRoot });
    installCodexPlugin({ home, repoRoot });

    const pluginDir = join(home, '.codex', 'plugins', 'odw');
    assert.equal(result.kind, 'codex-plugin');
    assert.equal(result.path, pluginDir);
    assert.ok(existsSync(join(pluginDir, '.codex-plugin', 'plugin.json')));
    assert.ok(existsSync(join(pluginDir, 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(pluginDir, 'skills', 'ultracode', 'SKILL.md')));
    assert.ok(existsSync(join(pluginDir, 'scripts', 'daemon-bridge.js')));
    assert.ok(existsSync(join(pluginDir, 'skills', 'odw', 'scripts', 'daemon-bridge.js')));
    assert.ok(existsSync(join(pluginDir, 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));

    const manifest = JSON.parse(readFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.mcpServers, './.mcp.json');

    const pluginMcp = JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8'));
    assert.equal(pluginMcp.mcpServers.odw.command, 'node');
    assert.ok(pluginMcp.mcpServers.odw.args[0].includes('mcp-server'));

    const marketplace = JSON.parse(readFileSync(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name).sort(), ['keep-me', 'odw']);
    assert.deepEqual(marketplace.plugins.find((plugin) => plugin.name === 'odw'), {
      name: 'odw',
      source: { type: 'local', path: './.codex/plugins/odw' },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installOpencodePlugin writes a local plugin wrapper and slash commands', () => {
  const targetDir = tempDir('odw-opencode-');
  try {
    installOpencodePlugin({ targetDir, repoRoot });
    const plugin = readFileSync(join(targetDir, '.opencode', 'plugins', 'odw.mjs'), 'utf8');
    const config = JSON.parse(readFileSync(join(targetDir, 'opencode.json'), 'utf8'));
    assert.match(plugin, /packages\/opencode-plugin\/src\/index\.js/);
    assert.ok(config.plugin.includes('./.opencode/plugins/odw.mjs'));
    assert.ok(existsSync(join(targetDir, '.opencode', 'commands', 'odw.md')));
    assert.match(readFileSync(join(targetDir, '.opencode', 'commands', 'odw.md'), 'utf8'), /^workflow: \$ARGUMENTS/m);
    assert.ok(existsSync(join(targetDir, '.opencode', 'commands', 'ultracode.md')));
    assert.ok(existsSync(join(targetDir, '.opencode', 'commands', 'workflows.md')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installVscodeExtension installs the unpacked VS Code extension into the user extension dir', () => {
  const home = tempDir('odw-vscode-home-');
  try {
    const result = installVscodeExtension({ home, repoRoot });
    installVscodeExtension({ home, repoRoot });

    assert.equal(result.kind, 'vscode');
    assert.match(result.path.replace(/\\/g, '/'), /\.vscode\/extensions\/open-dynamic-workflows\.odw-vscode-0\.1\.0$/);
    assert.ok(existsSync(join(result.path, 'package.json')));
    assert.ok(existsSync(join(result.path, 'extension.js')));
    assert.ok(existsSync(join(result.path, 'media', 'icon.svg')));

    const manifest = JSON.parse(readFileSync(join(result.path, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'odw-vscode');
    assert.equal(manifest.publisher, 'open-dynamic-workflows');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installAntigravity wires Gemini and Antigravity MCP configs without clobbering existing servers', () => {
  const home = tempDir('odw-antigravity-home-');
  const targetDir = tempDir('odw-antigravity-target-');
  try {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
      theme: 'dark',
      mcpServers: {
        existing: { command: 'node', args: ['existing.js'] },
      },
    }));
    mkdirSync(join(targetDir, '.agents'), { recursive: true });
    writeFileSync(join(targetDir, '.agents', 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        local: { command: 'node', args: ['local.js'] },
      },
    }));

    const result = installAntigravity({ home, targetDir, repoRoot });
    installAntigravity({ home, targetDir, repoRoot });

    const gemini = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.equal(gemini.theme, 'dark');
    assert.deepEqual(Object.keys(gemini.mcpServers).sort(), ['existing', 'odw']);
    assert.equal(gemini.mcpServers.odw.command, 'node');
    assert.ok(gemini.mcpServers.odw.args[0].includes('mcp-server'));

    const antigravityCli = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(antigravityCli.mcpServers), ['odw']);
    assert.equal(antigravityCli.mcpServers.odw.command, 'node');

    const workspace = JSON.parse(readFileSync(join(targetDir, '.agents', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(workspace.mcpServers).sort(), ['local', 'odw']);
    assert.equal(workspace.mcpServers.odw.command, 'node');

    assert.equal(result.kind, 'antigravity');
    assert.ok(existsSync(join(home, '.gemini', 'config', 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'config', 'skills', 'odw', 'scripts', 'daemon-bridge.js')));
    assert.ok(existsSync(join(home, '.gemini', 'config', 'skills', 'ultracode', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'config', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'ultracode', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));
    assert.ok(result.configSkillPath.replace(/\\/g, '/').endsWith('.gemini/config/skills/odw'));
    assert.ok(result.geminiMcpPath.replace(/\\/g, '/').endsWith('.gemini/config/mcp_config.json'));
    assert.ok(result.antigravityCliMcpPath.replace(/\\/g, '/').endsWith('.gemini/antigravity-cli/mcp_config.json'));
    assert.ok(result.workspaceMcpPath.replace(/\\/g, '/').endsWith('.agents/mcp_config.json'));
    assert.ok(result.globalPluginPath.replace(/\\/g, '/').endsWith('.gemini/config/plugins/odw'));
    assert.ok(result.cliPluginPath.replace(/\\/g, '/').endsWith('.gemini/antigravity-cli/plugins/odw'));
    assert.ok(result.workspacePluginPath.replace(/\\/g, '/').endsWith('.agents/plugins/odw'));

    const workflow = readFileSync(join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md'), 'utf8');
    assert.match(workflow, /\.gemini\/config\/skills\/odw\/scripts\/daemon-bridge\.js/);

    for (const pluginDir of [result.globalPluginPath, result.cliPluginPath, result.workspacePluginPath]) {
      const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
      assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
      assert.equal(manifest.name, 'odw');
      assert.match(manifest.description, /Open Dynamic Workflows/);

      const pluginMcp = JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8'));
      assert.equal(pluginMcp.mcpServers.odw.command, 'node');
      assert.ok(pluginMcp.mcpServers.odw.args[0].includes('mcp-server'));
      assert.ok(existsSync(join(pluginDir, 'skills', 'odw', 'SKILL.md')));
      assert.ok(existsSync(join(pluginDir, 'skills', 'odw', 'scripts', 'daemon-bridge.js')));
      assert.ok(existsSync(join(pluginDir, 'skills', 'ultracode', 'SKILL.md')));
      assert.ok(existsSync(join(pluginDir, 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')));
      assert.match(readFileSync(join(pluginDir, 'rules', 'odw.md'), 'utf8'), /odw_run/);
    }
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('installAgentIntegration copies native skill folders for codex, antigravity, and openclaw', () => {
  const home = tempDir('odw-skills-');
  const targetDir = tempDir('odw-skills-target-');
  try {
    const codex = installAgentIntegration('codex-skill', { home, repoRoot });
    const antigravity = installAgentIntegration('antigravity', { home, targetDir, repoRoot });
    const openclaw = installAgentIntegration('openclaw', { home, repoRoot });

    assert.ok(existsSync(join(home, '.agents', 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'ultracode', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'ultracode', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md')));
    assert.ok(existsSync(join(targetDir, '.agents', 'mcp_config.json')));
    assert.ok(existsSync(join(home, '.openclaw', 'skills', 'open-dynamic-workflows', 'SKILL.md')));
    assert.equal(codex.kind, 'codex-skill');
    assert.equal(antigravity.kind, 'antigravity');
    assert.equal(openclaw.kind, 'openclaw');
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('project-local skill bridges run inside type module projects', () => {
  const home = tempDir('odw-module-home-');
  const targetDir = tempDir('odw-module-target-');
  try {
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ type: 'module' }));
    installAgentIntegration('all', { home, targetDir, repoRoot });

    for (const bridgePath of [
      join(targetDir, '.cursor', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
      join(targetDir, '.cursor', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js'),
      join(targetDir, '.kimi', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
      join(targetDir, '.kimi', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js'),
      join(targetDir, '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
      join(targetDir, '.agents', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js'),
    ]) {
      assert.throws(
        () => execFileSync(process.execPath, [bridgePath, '--check'], {
          encoding: 'utf8',
          env: { ...process.env, ODW_DAEMON_PORT: '59998' },
          timeout: 15000,
        }),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(String(error.stderr), /not reachable|Start it/);
          assert.doesNotMatch(String(error.stderr), /require is not defined/);
          return true;
        }
      );
    }
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli integrate command installs a requested agent integration', () => {
  const targetDir = tempDir('odw-cli-target-');
  const home = tempDir('odw-cli-home-');
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
        'integrate',
        'kimi',
        '--target',
        targetDir,
        '--home',
        home,
        '--repo',
        repoRoot,
      ],
      { encoding: 'utf8', env: { ...process.env, ODW_HOME: home } }
    );
    assert.match(output, /kimi/);
    assert.ok(existsSync(join(home, '.kimi-code', 'mcp.json')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli integrate command can print machine-readable JSON', () => {
  const targetDir = tempDir('odw-cli-json-target-');
  const home = tempDir('odw-cli-json-home-');
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
        'integrate',
        'cursor',
        '--target',
        targetDir,
        '--home',
        home,
        '--repo',
        repoRoot,
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, ODW_HOME: home } }
    );
    const report = JSON.parse(output);
    assert.equal(report.ok, true);
    assert.equal(report.agent, 'cursor');
    assert.equal(report.result.kind, 'cursor');
    assert.ok(report.result.path.endsWith(join('.cursor', 'mcp.json')));
    assert.ok(report.result.ultracodeSkillPath.endsWith(join('.cursor', 'skills', 'ultracode')));
    assert.ok(existsSync(join(targetDir, '.cursor', 'skills', 'ultracode', 'SKILL.md')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration reports missing integration files without throwing', () => {
  const targetDir = tempDir('odw-doctor-missing-target-');
  const home = tempDir('odw-doctor-missing-home-');
  try {
    const result = doctorAgentIntegration('kimi', { targetDir, home, repoRoot });

    assert.equal(result.kind, 'kimi');
    assert.equal(result.ok, false);
    assert.equal(result.checks.length, 6);
    assert.ok(result.checks.every((check) => check.ok === false));
    assert.match(result.checks[0].message, /missing/);
    assert.match(result.checks[0].path, /\.kimi-code/);
    assert.equal(result.checks[1].label, 'kimi agent instructions');
    assert.equal(result.checks[2].label, 'kimi flow skill');
    assert.equal(result.checks[3].label, 'kimi daemon bridge');
    assert.equal(result.checks[4].label, 'kimi ultracode flow skill');
    assert.equal(result.checks[5].label, 'kimi ultracode daemon bridge');

    // A fully-absent group is neutral (skipped), not failed — but an explicit
    // single-adapter request still reports "not ready" because the user asked
    // about that one adapter specifically.
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].agent, 'kimi');
    assert.equal(result.groups[0].status, 'absent');
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration all mode is ready on a clean install (uninstalled adapters are skipped, not failed)', () => {
  const targetDir = tempDir('odw-doctor-clean-target-');
  const home = tempDir('odw-doctor-clean-home-');
  try {
    // Nothing installed at all — the classic fresh-install scenario.
    const result = doctorAgentIntegration('all', { targetDir, home, repoRoot });

    assert.equal(result.kind, 'all');
    // No adapter is partially installed, so `all` is ready (daemon liveness is
    // checked separately by the CLI). The bug was flagging never-installed
    // adapters (zcode, opencode, etc.) as failures.
    assert.equal(result.ok, true);
    assert.ok(result.groups.length >= 10);
    // Every group is fully absent → skipped/neutral, never partial or ok.
    assert.ok(result.groups.every((group) => group.status === 'absent'));
    assert.ok(result.checks.every((check) => check.ok === false));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration all mode fails when an adapter is only partially installed', () => {
  const targetDir = tempDir('odw-doctor-partial-target-');
  const home = tempDir('odw-doctor-partial-home-');
  try {
    // Install opencode only, then corrupt one of its files so the group is
    // present-but-broken (partial), while every other adapter stays absent.
    installOpencodePlugin({ targetDir, repoRoot });
    writeFileSync(join(targetDir, 'opencode.json'), JSON.stringify({ plugin: [] }));

    const result = doctorAgentIntegration('all', { targetDir, home, repoRoot });
    assert.equal(result.ok, false);

    const opencode = result.groups.find((group) => group.agent === 'opencode');
    assert.equal(opencode.status, 'partial');
    // All the never-installed adapters remain neutral.
    assert.ok(result.groups.filter((group) => group.agent !== 'opencode').every((group) => group.status === 'absent'));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli doctor all exits 0 on a clean install when the daemon is running', async () => {
  const targetDir = tempDir('odw-cli-doctor-clean-target-');
  const home = tempDir('odw-cli-doctor-clean-home-');
  const port = 45999;
  // Async execFile (not execFileSync) so this process's event loop stays free
  // to serve the child's /health probe while the CLI subprocess runs.
  const server = await startProbeDaemon(port);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
        'doctor',
        'all',
        '--target',
        targetDir,
        '--home',
        home,
        '--repo',
        repoRoot,
        '--port',
        String(port),
      ],
      { encoding: 'utf8', env: { ...process.env, ODW_HOME: home, ODW_DAEMON_PORT: String(port) } }
    );
    // Exit 0 (execFileAsync rejects on non-zero) proves fully-absent adapters
    // don't fail the run; the daemon is up and nothing is partially installed.
    assert.match(stdout, /skipped|not installed/i);
    assert.match(stdout, /daemon running/);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli doctor command can print machine-readable JSON', () => {
  const targetDir = tempDir('odw-cli-doctor-json-target-');
  const home = tempDir('odw-cli-doctor-json-home-');
  try {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
          'doctor',
          'mcp',
          '--target',
          targetDir,
          '--home',
          home,
          '--repo',
          repoRoot,
          '--port',
          '59998',
          '--json',
        ],
        { encoding: 'utf8', env: { ...process.env, ODW_HOME: home, ODW_DAEMON_PORT: '59998' } }
      ),
      (error) => {
        assert.equal(error.status, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.agent, 'mcp');
        assert.equal(report.integration.kind, 'mcp');
        assert.equal(report.integration.ok, false);
        assert.equal(report.daemon.ok, false);
        assert.equal(report.daemon.port, 59998);
        assert.ok(report.integration.checks.some((check) => check.label === 'generic mcp config' && check.ok === false));
        assert.equal(error.stdout.includes('\u001b['), false);
        return true;
      }
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration verifies every installed integration in all mode', () => {
  const targetDir = tempDir('odw-doctor-all-target-');
  const home = tempDir('odw-doctor-all-home-');
  try {
    installAgentIntegration('all', { targetDir, home, repoRoot });

    const result = doctorAgentIntegration('all', { targetDir, home, repoRoot });
    assert.equal(result.kind, 'all');
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 15);
    const agents = readFileSync(join(targetDir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /generic MCP hosts, Kimi Code, Zed, and zcode-compatible agents/);
    const zedStyleSkill = readFileSync(join(targetDir, '.agents', 'skills', 'odw', 'SKILL.md'), 'utf8');
    assert.match(zedStyleSkill, /Zed Agent and zcode/);
    assert.match(zedStyleSkill, /doctor zed or zcode/);
    assert.ok(result.checks.some((check) => check.label === 'kimi mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'codex ultracode skill'));
    assert.ok(result.checks.some((check) => check.label === 'kimi agent instructions'));
    assert.ok(result.checks.some((check) => check.label === 'kimi flow skill'));
    assert.ok(result.checks.some((check) => check.label === 'kimi ultracode flow skill'));
    assert.ok(result.checks.some((check) => check.label === 'gemini mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'gemini project instructions'));
    assert.ok(result.checks.some((check) => check.label === 'gemini odw command'));
    assert.ok(result.checks.some((check) => check.label === 'gemini ultracode command'));
    assert.ok(result.checks.some((check) => check.label === 'zed context server config'));
    assert.ok(result.checks.some((check) => check.label === 'zed agent skill'));
    assert.ok(result.checks.some((check) => check.label === 'zed ultracode agent skill'));
    assert.ok(result.checks.some((check) => check.label === 'zcode generic mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'zcode context server config'));
    assert.ok(result.checks.some((check) => check.label === 'zcode agent instructions'));
    assert.ok(result.checks.some((check) => check.label === 'zcode ultracode agent skill'));
    assert.ok(result.checks.some((check) => check.label === 'vscode extension'));
    assert.ok(result.checks.some((check) => check.label === 'opencode plugin config'));
    assert.ok(result.checks.some((check) => check.label === 'opencode odw command'));
    assert.ok(result.checks.some((check) => check.label === 'cursor workflow rule'));
    assert.ok(result.checks.some((check) => check.label === 'cursor agent skill'));
    assert.ok(result.checks.some((check) => check.label === 'cursor ultracode agent skill'));
    assert.ok(result.checks.some((check) => check.label === 'cursor odw orchestrator subagent'));
    assert.ok(result.checks.some((check) => check.label === 'cursor dashboard extension'));
    assert.ok(result.checks.some((check) => check.label === 'antigravity gemini mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'antigravity config skill'));
    assert.ok(result.checks.some((check) => check.label === 'antigravity config ultracode skill'));
    assert.ok(result.checks.some((check) => check.label === 'antigravity cli mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'antigravity workspace mcp config'));
    assert.ok(result.checks.every((check) => check.ok));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli doctor command prints a failing readiness report', () => {
  const targetDir = tempDir('odw-cli-doctor-target-');
  const home = tempDir('odw-cli-doctor-home-');
  try {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
          'doctor',
          'mcp',
          '--target',
          targetDir,
          '--home',
          home,
          '--repo',
          repoRoot,
        ],
        { encoding: 'utf8', env: { ...process.env, ODW_HOME: home } }
      ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stdout, /mcp integration/);
        assert.match(error.stdout, /missing/);
        return true;
      }
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
