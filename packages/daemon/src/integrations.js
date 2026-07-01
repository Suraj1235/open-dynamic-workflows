/**
 * Agentic-coder integration installers.
 *
 * MCP is the universal lane: Cursor, Codex, Kimi Code, Zed, Cline/Windsurf-
 * style clients, and other MCP hosts can all point at
 * packages/mcp-server/src/index.js. Native adapters remain available where the
 * host exposes better hooks (OpenCode plugin, Codex/Antigravity/OpenClaw
 * skills).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANAGED_BEGIN = '# BEGIN open-dynamic-workflows';
const MANAGED_END = '# END open-dynamic-workflows';
const AGENTS_BEGIN = '<!-- BEGIN open-dynamic-workflows -->';
const AGENTS_END = '<!-- END open-dynamic-workflows -->';
const GEMINI_BEGIN = '<!-- BEGIN open-dynamic-workflows -->';
const GEMINI_END = '<!-- END open-dynamic-workflows -->';

export function mcpServerCommand({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  // ODW_MCP_SAMPLING opts a host into the KEYLESS engine-hosting server: it runs
  // ODW's real engine in-process on the client's OWN model when the client
  // advertises MCP sampling, and transparently falls back to the daemon proxy
  // when it doesn't. Default stays the proxy entry so nothing regresses for
  // hosts/clients without sampling (Codex, Antigravity today) — flip the flag and
  // any sampling-capable client goes keyless with no further config.
  const entry = process.env.ODW_MCP_SAMPLING
    ? join(repoRoot, 'packages', 'mcp-server', 'src', 'embedded-index.js')
    : join(repoRoot, 'packages', 'mcp-server', 'src', 'index.js');
  return { command: 'node', args: [slash(entry)] };
}

export function installCursorMcp({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(targetDir, '.cursor', 'mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const rulePath = installCursorRule({ targetDir });
  const skillPath = installCursorSkill({ targetDir, repoRoot });
  const ultracodeSkillPath = installCursorUltracodeSkill({ targetDir, repoRoot });
  const subagentPath = installCursorSubagent({ targetDir, repoRoot });
  const extensionPath = installEditorExtension({ home, repoRoot, profileDir: '.cursor' }).path;
  return { kind: 'cursor', path, rulePath, skillPath, ultracodeSkillPath, subagentPath, extensionPath, server: current.mcpServers.odw };
}

export function installGenericMcpConfig({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(targetDir, '.mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installAgentInstructions({ targetDir, host: 'generic MCP hosts' });
  return { kind: 'mcp', path, instructionsPath, server: current.mcpServers.odw };
}

export function installKimiMcp({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.kimi-code', 'mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installAgentInstructions({ targetDir, host: 'Kimi Code' });
  const skillPath = installKimiSkill({ targetDir, repoRoot });
  const ultracodeSkillPath = installKimiUltracodeSkill({ targetDir, repoRoot });
  return { kind: 'kimi', path, instructionsPath, skillPath, ultracodeSkillPath, server: current.mcpServers.odw };
}

export function installGeminiMcp({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.gemini', 'settings.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installGeminiInstructions({ targetDir });
  const commandsPath = installGeminiCommands({ targetDir, repoRoot });
  return { kind: 'gemini', path, instructionsPath, commandsPath, server: current.mcpServers.odw };
}

export function installZedMcp({
  targetDir = process.cwd(),
  repoRoot = DEFAULT_REPO_ROOT,
  host = 'Zed',
  skillHost = 'Zed Agent',
  doctorAgent = 'zed',
  kind = 'zed',
} = {}) {
  const path = join(targetDir, '.zed', 'settings.json');
  const current = readJson(path, { context_servers: {} });
  current.context_servers = objectOrEmpty(current.context_servers);
  current.context_servers.odw = mcpServerCommand({ repoRoot });
  writeJson(path, current);
  const instructionsPath = installAgentInstructions({ targetDir, host });
  const skillPath = installZedSkill({ targetDir, repoRoot, host: skillHost, doctorAgent });
  const ultracodeSkillPath = installZedUltracodeSkill({ targetDir, repoRoot, host: skillHost, doctorAgent });
  return { kind, path, instructionsPath, skillPath, ultracodeSkillPath, server: current.context_servers.odw };
}

export function installZcodeMcp(options = {}) {
  return {
    kind: 'zcode',
    steps: [
      installGenericMcpConfig(options),
      installZedMcp({
        ...options,
        host: 'zcode',
        skillHost: 'zcode',
        doctorAgent: 'zcode',
        kind: 'zcode-context',
      }),
    ],
  };
}

export function installCodexMcp({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.codex', 'config.toml');
  const current = readText(path, '');
  const block = [
    MANAGED_BEGIN,
    '[mcp_servers.odw]',
    'command = "node"',
    `args = [${JSON.stringify(mcpServerCommand({ repoRoot }).args[0])}]`,
    MANAGED_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedBlock(current, block));
  return { kind: 'codex-mcp', path };
}

export function installCodexSkill({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(home, '.agents', 'skills', 'odw');
  copySkillWithBridge(join(repoRoot, 'packages', 'codex-adapter', 'skills', 'odw'), dest, repoRoot);
  const ultracodeDest = join(home, '.agents', 'skills', 'ultracode');
  copySkillWithBridge(join(repoRoot, 'packages', 'codex-adapter', 'skills', 'ultracode'), ultracodeDest, repoRoot);
  return { kind: 'codex-skill', path: dest, ultracodePath: ultracodeDest };
}

export function installCodexPlugin({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = codexPluginPath({ home, repoRoot });
  ensureDir(dest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', '.codex-plugin'), join(dest, '.codex-plugin'));
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'skills'), join(dest, 'skills'));
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'scripts'));
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'skills', 'odw', 'scripts'));
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'skills', 'ultracode', 'scripts'));
  cpSync(join(repoRoot, 'packages', 'codex-adapter', 'AGENTS.md'), join(dest, 'AGENTS.md'));
  cpSync(join(repoRoot, 'packages', 'codex-adapter', 'README.md'), join(dest, 'README.md'));
  cpSync(join(repoRoot, 'packages', 'codex-adapter', 'plugin.json'), join(dest, 'plugin.json'));
  const mcpPath = join(dest, '.mcp.json');
  writeJson(mcpPath, { mcpServers: { odw: mcpServerCommand({ repoRoot }) } });
  const marketplacePath = installCodexMarketplace({ home });
  return { kind: 'codex-plugin', path: dest, marketplacePath, mcpPath };
}

export function installCursorSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.cursor', 'skills', 'odw');
  return copySkillWithBridge(join(repoRoot, 'packages', 'cursor-adapter', 'skills', 'odw'), dest, repoRoot);
}

export function installCursorUltracodeSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.cursor', 'skills', 'ultracode');
  return copySkillWithBridge(join(repoRoot, 'packages', 'cursor-adapter', 'skills', 'ultracode'), dest, repoRoot);
}

export function installCursorSubagent({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.cursor', 'agents', 'odw-orchestrator.md');
  ensureDir(dirname(dest));
  cpSync(join(repoRoot, 'packages', 'cursor-adapter', 'agents', 'odw-orchestrator.md'), dest);
  return dest;
}

export function installKimiSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.kimi', 'skills', 'odw');
  return copySkillWithBridge(join(repoRoot, 'packages', 'kimi-adapter', 'skills', 'odw'), dest, repoRoot);
}

export function installKimiUltracodeSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.kimi', 'skills', 'ultracode');
  return copySkillWithBridge(join(repoRoot, 'packages', 'kimi-adapter', 'skills', 'ultracode'), dest, repoRoot);
}

export function installZedSkill({
  targetDir = process.cwd(),
  repoRoot = DEFAULT_REPO_ROOT,
  host = 'Zed Agent',
  doctorAgent = 'zed',
} = {}) {
  const dest = join(targetDir, '.agents', 'skills', 'odw');
  copySkillWithBridge(join(repoRoot, 'packages', 'zed-adapter', 'skills', 'odw'), dest, repoRoot);
  retargetZedSkill(dest, { host, doctorAgent });
  return dest;
}

export function installZedUltracodeSkill({
  targetDir = process.cwd(),
  repoRoot = DEFAULT_REPO_ROOT,
  host = 'Zed Agent',
  doctorAgent = 'zed',
} = {}) {
  const dest = join(targetDir, '.agents', 'skills', 'ultracode');
  copySkillWithBridge(join(repoRoot, 'packages', 'zed-adapter', 'skills', 'ultracode'), dest, repoRoot);
  retargetZedSkill(dest, { host, doctorAgent });
  return dest;
}

export function installGeminiCommands({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.gemini', 'commands');
  ensureDir(dest);
  cpSync(join(repoRoot, 'packages', 'gemini-adapter', 'commands', 'odw.toml'), join(dest, 'odw.toml'));
  cpSync(join(repoRoot, 'packages', 'gemini-adapter', 'commands', 'ultracode.toml'), join(dest, 'ultracode.toml'));
  return dest;
}

export function installAntigravity({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const globalPluginPath = installAntigravityPlugin({
    dest: join(home, '.gemini', 'config', 'plugins', 'odw'),
    repoRoot,
  });
  const cliPluginPath = installAntigravityPlugin({
    dest: join(home, '.gemini', 'antigravity-cli', 'plugins', 'odw'),
    repoRoot,
  });
  const workspacePluginPath = installAntigravityPlugin({
    dest: join(targetDir, '.agents', 'plugins', 'odw'),
    repoRoot,
  });

  const skillDest = join(home, '.gemini', 'skills', 'odw');
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'odw'), skillDest, repoRoot);

  const ultracodeSkillDest = join(home, '.gemini', 'skills', 'ultracode');
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'ultracode'), ultracodeSkillDest, repoRoot);

  const configSkillDest = join(home, '.gemini', 'config', 'skills', 'odw');
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'odw'), configSkillDest, repoRoot);

  const configUltracodeSkillDest = join(home, '.gemini', 'config', 'skills', 'ultracode');
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'ultracode'), configUltracodeSkillDest, repoRoot);

  const workflowDest = join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md');
  ensureDir(dirname(workflowDest));
  cpSync(join(repoRoot, 'packages', 'antigravity-adapter', 'workflows', 'odw-run.md'), workflowDest);

  const geminiMcpPath = join(home, '.gemini', 'config', 'mcp_config.json');
  const antigravityCliMcpPath = join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
  const workspaceMcpPath = join(targetDir, '.agents', 'mcp_config.json');
  writeMcpServersJson(geminiMcpPath, repoRoot);
  writeMcpServersJson(antigravityCliMcpPath, repoRoot);
  writeMcpServersJson(workspaceMcpPath, repoRoot);

  return {
    kind: 'antigravity',
    skillPath: skillDest,
    ultracodeSkillPath: ultracodeSkillDest,
    configSkillPath: configSkillDest,
    configUltracodeSkillPath: configUltracodeSkillDest,
    workflowPath: workflowDest,
    geminiMcpPath,
    antigravityCliMcpPath,
    workspaceMcpPath,
    globalPluginPath,
    cliPluginPath,
    workspacePluginPath,
  };
}

export function installOpenClaw({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(home, '.openclaw', 'skills', 'open-dynamic-workflows');
  copyFresh(join(repoRoot, 'packages', 'openclaw-adapter', 'skills', 'open-dynamic-workflows'), dest);
  return { kind: 'openclaw', path: dest };
}

export function installOpencodePlugin({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const pluginDir = join(targetDir, '.opencode', 'plugins');
  ensureDir(pluginDir);
  const pluginPath = join(pluginDir, 'odw.mjs');
  const pluginUrl = pathToFileURL(join(repoRoot, 'packages', 'opencode-plugin', 'src', 'index.js')).href;
  writeText(pluginPath, [
    '// Generated by open-dynamic-workflows. Keep this tiny wrapper in your project.',
    `export { default } from ${JSON.stringify(pluginUrl)};`,
    `export * from ${JSON.stringify(pluginUrl)};`,
    '',
  ].join('\n'));

  const commandsDest = join(targetDir, '.opencode', 'commands');
  ensureDir(commandsDest);
  cpSync(join(repoRoot, 'packages', 'opencode-plugin', 'commands', 'odw.md'), join(commandsDest, 'odw.md'));
  cpSync(join(repoRoot, 'packages', 'opencode-plugin', 'commands', 'ultracode.md'), join(commandsDest, 'ultracode.md'));
  cpSync(join(repoRoot, 'packages', 'opencode-plugin', 'commands', 'workflows.md'), join(commandsDest, 'workflows.md'));

  const configPath = join(targetDir, 'opencode.json');
  const current = readJson(configPath, {});
  const plugins = Array.isArray(current.plugin) ? current.plugin.filter((entry) => entry !== './.opencode/plugins/odw.mjs') : [];
  plugins.push('./.opencode/plugins/odw.mjs');
  current.plugin = plugins;
  writeJson(configPath, current);
  return { kind: 'opencode', pluginPath, commandsPath: commandsDest, configPath };
}

export function installVscodeExtension({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const { path: dest } = installEditorExtension({ home, repoRoot, profileDir: '.vscode' });
  return { kind: 'vscode', path: dest };
}

export function installAgentIntegration(kind, options = {}) {
  switch (kind) {
    case 'mcp':
    case 'generic-mcp':
      return installGenericMcpConfig(options);
    case 'codex':
      return { kind, steps: [installCodexMcp(options), installCodexPlugin(options), installCodexSkill(options)] };
    case 'codex-mcp':
      return installCodexMcp(options);
    case 'codex-plugin':
      return installCodexPlugin(options);
    case 'codex-skill':
      return installCodexSkill(options);
    case 'cursor':
      return installCursorMcp(options);
    case 'kimi':
    case 'kimi-code':
      return installKimiMcp(options);
    case 'gemini':
    case 'gemini-cli':
      return installGeminiMcp(options);
    case 'zed':
      return installZedMcp(options);
    case 'zcode':
      return installZcodeMcp(options);
    case 'opencode':
      return installOpencodePlugin(options);
    case 'vscode':
    case 'vs-code':
      return installVscodeExtension(options);
    case 'antigravity':
      return installAntigravity(options);
    case 'openclaw':
      return installOpenClaw(options);
    case 'all':
      return installAllIntegrations(options);
    default:
      throw new Error(`unknown integration "${kind}" (valid: mcp, codex, codex-mcp, codex-plugin, codex-skill, cursor, kimi, gemini, zed, zcode, opencode, vscode, antigravity, openclaw, all)`);
  }
}

function installAllIntegrations(options = {}) {
  const result = {
    kind: 'all',
    steps: [
      installGenericMcpConfig(options),
      installCodexMcp(options),
      installCodexPlugin(options),
      installCodexSkill(options),
      installCursorMcp(options),
      installKimiMcp(options),
      installGeminiMcp(options),
      installZedMcp({
        ...options,
        host: 'Zed and zcode-compatible agents',
        skillHost: 'Zed Agent and zcode',
        doctorAgent: 'zed or zcode',
      }),
      installOpencodePlugin(options),
      installVscodeExtension(options),
      installAntigravity(options),
      installOpenClaw(options),
    ],
  };
  const instructionsPath = installAgentInstructions({
    targetDir: options.targetDir,
    host: 'generic MCP hosts, Kimi Code, Zed, and zcode-compatible agents',
  });
  return { ...result, instructionsPath };
}

export function doctorAgentIntegration(kind = 'all', options = {}) {
  const checks = doctorChecksFor(kind, options);
  return {
    kind,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function doctorChecksFor(kind, options = {}) {
  switch (kind) {
    case 'mcp':
    case 'generic-mcp':
      return [
        checkMcpJson('generic mcp config', join(options.targetDir ?? process.cwd(), '.mcp.json'), 'mcpServers', options),
        checkAgentInstructions('generic agent instructions', options.targetDir ?? process.cwd()),
      ];
    case 'codex':
      return [...doctorChecksFor('codex-mcp', options), ...doctorChecksFor('codex-plugin', options), ...doctorChecksFor('codex-skill', options)];
    case 'codex-mcp':
      return [checkText('codex mcp config', join(options.home ?? homedir(), '.codex', 'config.toml'), [
        '[mcp_servers.odw]',
        mcpServerCommand(options).args[0],
      ])];
    case 'codex-plugin':
      return [
        checkText('codex plugin manifest', join(codexPluginPath(options), '.codex-plugin', 'plugin.json'), [
          '"name": "odw"',
          '"mcpServers": "./.mcp.json"',
        ]),
        checkMcpJson('codex plugin mcp config', join(codexPluginPath(options), '.mcp.json'), 'mcpServers', options),
        checkExists('codex plugin skill', join(codexPluginPath(options), 'skills', 'odw', 'SKILL.md')),
        checkExists('codex plugin daemon bridge', join(codexPluginPath(options), 'scripts', 'daemon-bridge.js')),
        checkExists('codex plugin skill bridge', join(codexPluginPath(options), 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('codex plugin ultracode skill', join(codexPluginPath(options), 'skills', 'ultracode', 'SKILL.md'), [
          'name: ultracode',
          'odw_run',
        ]),
        checkExists('codex plugin ultracode bridge', join(codexPluginPath(options), 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
        checkCodexMarketplace('codex personal marketplace', codexMarketplacePath(options)),
      ];
    case 'codex-skill':
      return [
        checkExists('codex skill', join(options.home ?? homedir(), '.agents', 'skills', 'odw', 'SKILL.md')),
        checkExists('codex daemon bridge', join(options.home ?? homedir(), '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('codex ultracode skill', join(options.home ?? homedir(), '.agents', 'skills', 'ultracode', 'SKILL.md'), [
          'name: ultracode',
          'odw_run',
        ]),
        checkExists('codex ultracode daemon bridge', join(options.home ?? homedir(), '.agents', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
      ];
    case 'cursor':
      return [
        checkMcpJson('cursor mcp config', join(options.targetDir ?? process.cwd(), '.cursor', 'mcp.json'), 'mcpServers', options),
        checkText('cursor workflow rule', join(options.targetDir ?? process.cwd(), '.cursor', 'rules', 'open-dynamic-workflows.mdc'), [
          'alwaysApply: true',
          'odw_run',
          'ultracode',
        ]),
        checkExists('cursor agent skill', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'odw', 'SKILL.md')),
        checkExists('cursor daemon bridge', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('cursor ultracode agent skill', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'ultracode', 'SKILL.md'), [
          'name: ultracode',
          'Cursor Agent',
          'odw_run',
        ]),
        checkExists('cursor ultracode daemon bridge', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
        checkText('cursor odw orchestrator subagent', join(options.targetDir ?? process.cwd(), '.cursor', 'agents', 'odw-orchestrator.md'), [
          'name: odw-orchestrator',
          'model: inherit',
          'odw_run',
        ]),
        checkExists('cursor dashboard extension', join(editorExtensionPath({ ...options, profileDir: '.cursor' }), 'package.json')),
        checkExists('cursor dashboard entrypoint', join(editorExtensionPath({ ...options, profileDir: '.cursor' }), 'extension.js')),
      ];
    case 'kimi':
    case 'kimi-code':
      return [
        checkMcpJson('kimi mcp config', join(options.home ?? homedir(), '.kimi-code', 'mcp.json'), 'mcpServers', options),
        checkAgentInstructions('kimi agent instructions', options.targetDir ?? process.cwd()),
        checkText('kimi flow skill', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'odw', 'SKILL.md'), [
          'type: flow',
          '/flow:odw',
          'daemon-bridge.js --check',
        ]),
        checkExists('kimi daemon bridge', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('kimi ultracode flow skill', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'ultracode', 'SKILL.md'), [
          'type: flow',
          '/flow:ultracode',
          'daemon-bridge.js --check',
        ]),
        checkExists('kimi ultracode daemon bridge', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
      ];
    case 'gemini':
    case 'gemini-cli':
      return [
        checkMcpJson('gemini mcp config', join(options.home ?? homedir(), '.gemini', 'settings.json'), 'mcpServers', options),
        checkGeminiInstructions('gemini project instructions', options.targetDir ?? process.cwd()),
        checkText('gemini odw command', join(options.targetDir ?? process.cwd(), '.gemini', 'commands', 'odw.toml'), [
          'description = "Run a task through Open Dynamic Workflows"',
          'mcp_odw_odw_run',
          '{{args}}',
        ]),
        checkText('gemini ultracode command', join(options.targetDir ?? process.cwd(), '.gemini', 'commands', 'ultracode.toml'), [
          'description = "Run an ultracode workflow through Open Dynamic Workflows"',
          'mcp_odw_odw_run',
          '{{args}}',
        ]),
      ];
    case 'zed':
      return [
        checkMcpJson('zed context server config', join(options.targetDir ?? process.cwd(), '.zed', 'settings.json'), 'context_servers', options),
        checkAgentInstructions('zed agent instructions', options.targetDir ?? process.cwd()),
        checkText('zed agent skill', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'odw', 'SKILL.md'), [
          'Zed Agent',
          'odw_run',
          'daemon-bridge.js --check',
        ]),
        checkExists('zed daemon bridge', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('zed ultracode agent skill', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'ultracode', 'SKILL.md'), [
          'Zed Agent',
          'odw_run',
          'daemon-bridge.js --check',
        ]),
        checkExists('zed ultracode daemon bridge', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
      ];
    case 'zcode':
      return [
        checkMcpJson('zcode generic mcp config', join(options.targetDir ?? process.cwd(), '.mcp.json'), 'mcpServers', options),
        checkMcpJson('zcode context server config', join(options.targetDir ?? process.cwd(), '.zed', 'settings.json'), 'context_servers', options),
        checkText('zcode agent instructions', join(options.targetDir ?? process.cwd(), 'AGENTS.md'), [
          AGENTS_BEGIN,
          'zcode',
          'odw_run',
          'ultracode',
        ]),
        checkText('zcode agent skill', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'odw', 'SKILL.md'), [
          'zcode',
          'odw_run',
          'daemon-bridge.js --check',
        ]),
        checkExists('zcode daemon bridge', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('zcode ultracode agent skill', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'ultracode', 'SKILL.md'), [
          'zcode',
          'odw_run',
          'daemon-bridge.js --check',
        ]),
        checkExists('zcode ultracode daemon bridge', join(options.targetDir ?? process.cwd(), '.agents', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
      ];
    case 'opencode':
      return [
        checkText('opencode plugin config', join(options.targetDir ?? process.cwd(), 'opencode.json'), [
          './.opencode/plugins/odw.mjs',
        ]),
        checkExists('opencode plugin wrapper', join(options.targetDir ?? process.cwd(), '.opencode', 'plugins', 'odw.mjs')),
        checkText('opencode odw command', join(options.targetDir ?? process.cwd(), '.opencode', 'commands', 'odw.md'), [
          'workflow: $ARGUMENTS',
        ]),
        checkExists('opencode ultracode command', join(options.targetDir ?? process.cwd(), '.opencode', 'commands', 'ultracode.md')),
        checkExists('opencode workflows command', join(options.targetDir ?? process.cwd(), '.opencode', 'commands', 'workflows.md')),
      ];
    case 'vscode':
    case 'vs-code':
      return [
        checkExists('vscode extension', join(vscodeExtensionPath(options), 'package.json')),
        checkExists('vscode extension entrypoint', join(vscodeExtensionPath(options), 'extension.js')),
        checkExists('vscode extension icon', join(vscodeExtensionPath(options), 'media', 'icon.svg')),
      ];
    case 'antigravity':
      return [
        ...checkAntigravityPlugin('antigravity global plugin', join(options.home ?? homedir(), '.gemini', 'config', 'plugins', 'odw'), options),
        ...checkAntigravityPlugin('antigravity cli plugin', join(options.home ?? homedir(), '.gemini', 'antigravity-cli', 'plugins', 'odw'), options),
        ...checkAntigravityPlugin('antigravity workspace plugin', join(options.targetDir ?? process.cwd(), '.agents', 'plugins', 'odw'), options),
        checkExists('antigravity skill', join(options.home ?? homedir(), '.gemini', 'skills', 'odw', 'SKILL.md')),
        checkText('antigravity ultracode skill', join(options.home ?? homedir(), '.gemini', 'skills', 'ultracode', 'SKILL.md'), [
          'name: ultracode',
          'odw_run',
        ]),
        checkExists('antigravity ultracode skill bridge', join(options.home ?? homedir(), '.gemini', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
        checkExists('antigravity config skill', join(options.home ?? homedir(), '.gemini', 'config', 'skills', 'odw', 'SKILL.md')),
        checkExists('antigravity config skill bridge', join(options.home ?? homedir(), '.gemini', 'config', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
        checkText('antigravity config ultracode skill', join(options.home ?? homedir(), '.gemini', 'config', 'skills', 'ultracode', 'SKILL.md'), [
          'name: ultracode',
          'odw_run',
        ]),
        checkExists('antigravity config ultracode skill bridge', join(options.home ?? homedir(), '.gemini', 'config', 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
        checkExists('antigravity saved workflow', join(options.home ?? homedir(), '.gemini', 'antigravity', 'global_workflows', 'odw-run.md')),
        checkMcpJson('antigravity gemini mcp config', join(options.home ?? homedir(), '.gemini', 'config', 'mcp_config.json'), 'mcpServers', options),
        checkMcpJson('antigravity cli mcp config', join(options.home ?? homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json'), 'mcpServers', options),
        checkMcpJson('antigravity workspace mcp config', join(options.targetDir ?? process.cwd(), '.agents', 'mcp_config.json'), 'mcpServers', options),
      ];
    case 'openclaw':
      return [checkExists('openclaw skill', join(options.home ?? homedir(), '.openclaw', 'skills', 'open-dynamic-workflows', 'SKILL.md'))];
    case 'all':
      return [
        ...doctorChecksFor('mcp', options),
        ...doctorChecksFor('codex', options),
        ...doctorChecksFor('cursor', options),
        ...doctorChecksFor('kimi', options),
        ...doctorChecksFor('gemini', options),
        ...doctorChecksFor('zed', options),
        ...doctorChecksFor('zcode', options),
        ...doctorChecksFor('opencode', options),
        ...doctorChecksFor('vscode', options),
        ...doctorChecksFor('antigravity', options),
        ...doctorChecksFor('openclaw', options),
      ];
    default:
      throw new Error(`unknown integration "${kind}" (valid: mcp, codex, codex-mcp, codex-plugin, codex-skill, cursor, kimi, gemini, zed, zcode, opencode, vscode, antigravity, openclaw, all)`);
  }
}

function installAgentInstructions({ targetDir = process.cwd(), host = 'MCP host' } = {}) {
  const path = join(targetDir, 'AGENTS.md');
  const block = [
    AGENTS_BEGIN,
    '## Open Dynamic Workflows',
    '',
    `For ${host}, route substantial workflow requests through the ODW MCP server when it is available.`,
    '',
    'Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.',
    '',
    '- Call `odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `odw_run` for direct execution. Use `odw_plan` first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `odw_status`, `odw_result`, and `odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor <agent>`) and then fall back to the host agent native planning only if useful.',
    '',
    AGENTS_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedSection(readText(path, ''), block, AGENTS_BEGIN, AGENTS_END));
  return path;
}

function installCursorRule({ targetDir = process.cwd() } = {}) {
  const path = join(targetDir, '.cursor', 'rules', 'open-dynamic-workflows.mdc');
  writeText(path, [
    '---',
    'description: Route workflow, ultracode, and deep-research requests through Open Dynamic Workflows',
    'alwaysApply: true',
    '---',
    '',
    '# Open Dynamic Workflows',
    '',
    'When the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution, prefer the ODW MCP tools.',
    '',
    '- Call `odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `odw_run` for direct execution. Use `odw_plan` first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `odw_status`, `odw_result`, and `odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor cursor`) and then fall back to Cursor-native planning only if useful.',
    '',
  ].join('\n'));
  return path;
}

function installGeminiInstructions({ targetDir = process.cwd() } = {}) {
  const path = join(targetDir, 'GEMINI.md');
  const block = [
    GEMINI_BEGIN,
    '## Open Dynamic Workflows',
    '',
    'For Gemini CLI, route substantial workflow requests through the ODW MCP server when it is available.',
    '',
    'Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.',
    '',
    '- Gemini CLI exposes ODW tools with the MCP prefix: `mcp_odw_odw_health`, `mcp_odw_odw_plan`, `mcp_odw_odw_run`, `mcp_odw_odw_status`, `mcp_odw_odw_result`, `mcp_odw_odw_list`, and `mcp_odw_odw_control`.',
    '- Call `mcp_odw_odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `mcp_odw_odw_run` (`odw_run`) for direct execution. Use `mcp_odw_odw_plan` (`odw_plan`) first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `mcp_odw_odw_status`, `mcp_odw_odw_result`, and `mcp_odw_odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor gemini`) and then fall back to Gemini-native planning only if useful.',
    '',
    GEMINI_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedSection(readText(path, ''), block, GEMINI_BEGIN, GEMINI_END));
  return path;
}

function checkMcpJson(label, path, section, options) {
  if (!existsSync(path)) return check(false, label, path, 'missing');
  let json;
  try {
    json = JSON.parse(readText(path, '{}'));
  } catch (error) {
    return check(false, label, path, `invalid JSON: ${error.message}`);
  }
  const server = json?.[section]?.odw;
  if (!server || typeof server !== 'object') return check(false, label, path, `missing ${section}.odw`);
  const expected = mcpServerCommand(options);
  if (server.command !== expected.command) return check(false, label, path, `expected command ${expected.command}`);
  if (!Array.isArray(server.args) || server.args[0] !== expected.args[0]) {
    return check(false, label, path, 'odw server path does not match this checkout');
  }
  return check(true, label, path, 'ready');
}

function checkText(label, path, fragments) {
  if (!existsSync(path)) return check(false, label, path, 'missing');
  const text = readText(path, '');
  const missing = fragments.find((fragment) => !text.includes(fragment));
  if (missing) return check(false, label, path, `missing ${missing}`);
  return check(true, label, path, 'ready');
}

function checkAgentInstructions(label, targetDir) {
  return checkText(label, join(targetDir, 'AGENTS.md'), [
    AGENTS_BEGIN,
    'odw_run',
    'ultracode',
  ]);
}

function checkGeminiInstructions(label, targetDir) {
  return checkText(label, join(targetDir, 'GEMINI.md'), [
    GEMINI_BEGIN,
    'odw_run',
    'ultracode',
  ]);
}

function checkAntigravityPlugin(label, path, options) {
  return [
    checkText(`${label} manifest`, join(path, 'plugin.json'), [
      '"$schema": "https://antigravity.google/schemas/v1/plugin.json"',
      '"name": "odw"',
      'Open Dynamic Workflows',
    ]),
    checkMcpJson(`${label} mcp config`, join(path, 'mcp_config.json'), 'mcpServers', options),
    checkExists(`${label} skill`, join(path, 'skills', 'odw', 'SKILL.md')),
    checkExists(`${label} skill bridge`, join(path, 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
    checkText(`${label} ultracode skill`, join(path, 'skills', 'ultracode', 'SKILL.md'), [
      'name: ultracode',
      'odw_run',
    ]),
    checkExists(`${label} ultracode skill bridge`, join(path, 'skills', 'ultracode', 'scripts', 'daemon-bridge.js')),
    checkText(`${label} rule`, join(path, 'rules', 'odw.md'), [
      'odw_run',
      'ultracode',
    ]),
  ];
}

function checkExists(label, path) {
  return check(existsSync(path), label, path, existsSync(path) ? 'ready' : 'missing');
}

function checkCodexMarketplace(label, path) {
  if (!existsSync(path)) return check(false, label, path, 'missing');
  let json;
  try {
    json = JSON.parse(readText(path, '{}'));
  } catch (error) {
    return check(false, label, path, `invalid JSON: ${error.message}`);
  }
  const entry = Array.isArray(json.plugins)
    ? json.plugins.find((plugin) => plugin?.name === 'odw')
    : null;
  if (!entry) return check(false, label, path, 'missing odw plugin entry');
  if (entry.source?.type !== 'local') return check(false, label, path, 'expected local source');
  if (entry.source?.path !== './.codex/plugins/odw') return check(false, label, path, 'expected path ./.codex/plugins/odw');
  return check(true, label, path, 'ready');
}

function check(ok, label, path, message) {
  return { ok, label, path, message };
}

function installCodexMarketplace({ home = homedir() } = {}) {
  const path = codexMarketplacePath({ home });
  const current = readJson(path, {});
  const plugins = Array.isArray(current.plugins)
    ? current.plugins.filter((plugin) => plugin?.name !== 'odw')
    : [];
  plugins.push({
    name: 'odw',
    source: { type: 'local', path: './.codex/plugins/odw' },
  });
  current.plugins = plugins;
  writeJson(path, current);
  return path;
}

function installAntigravityPlugin({ dest, repoRoot }) {
  copyFresh(join(repoRoot, 'packages', 'antigravity-adapter', 'plugin'), dest);
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'odw'), join(dest, 'skills', 'odw'), repoRoot);
  copySkillWithBridge(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'ultracode'), join(dest, 'skills', 'ultracode'), repoRoot);
  writeMcpServersJson(join(dest, 'mcp_config.json'), repoRoot);
  return dest;
}

function copySkillWithBridge(src, dest, repoRoot) {
  copyFresh(src, dest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'scripts'));
  return dest;
}

function retargetZedSkill(dest, { host, doctorAgent }) {
  const path = join(dest, 'SKILL.md');
  const fallbackLower = host === 'Zed Agent' ? 'Zed-native fallback' : `${host}-native fallback`;
  const fallbackTitle = host === 'Zed Agent' ? 'Zed-Native Fallback' : `${host} Native Fallback`;
  const text = readText(path, '')
    .replaceAll('Zed Agent', host)
    .replaceAll('Zed-native fallback', fallbackLower)
    .replaceAll('Zed-Native Fallback', fallbackTitle)
    .replaceAll('doctor zed', `doctor ${doctorAgent}`);
  writeText(path, text);
}

function writeMcpServersJson(path, repoRoot) {
  const current = readJson(path, { mcpServers: {} });
  current.mcpServers = objectOrEmpty(current.mcpServers);
  current.mcpServers.odw = mcpServerCommand({ repoRoot });
  writeJson(path, current);
  return current;
}

function codexPluginPath(options = {}) {
  return join(options.home ?? homedir(), '.codex', 'plugins', 'odw');
}

function codexMarketplacePath(options = {}) {
  return join(options.home ?? homedir(), '.agents', 'plugins', 'marketplace.json');
}

function installEditorExtension({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT, profileDir }) {
  const dest = editorExtensionPath({ home, repoRoot, profileDir });
  copyFresh(join(repoRoot, 'packages', 'vscode-extension'), dest);
  return { path: dest };
}

function editorExtensionPath(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const manifest = readJson(join(repoRoot, 'packages', 'vscode-extension', 'package.json'), {});
  return join(options.home ?? homedir(), options.profileDir, 'extensions', `${manifest.publisher}.${manifest.name}-${manifest.version}`);
}

function vscodeExtensionPath(options = {}) {
  return editorExtensionPath({ ...options, profileDir: '.vscode' });
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyFresh(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
}

function replaceManagedBlock(text, block) {
  return replaceManagedSection(text, block, MANAGED_BEGIN, MANAGED_END);
}

function replaceManagedSection(text, block, begin, end) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trimEnd();
  const pattern = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'm');
  if (pattern.test(clean)) return `${clean.replace(pattern, block).trimEnd()}\n`;
  return `${clean}${clean ? '\n\n' : ''}${block}`;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readText(path, JSON.stringify(fallback)));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readText(path, fallback) {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return fallback;
  }
}

function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text, 'utf8');
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function slash(path) {
  return resolve(path).replace(/\\/g, '/');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
