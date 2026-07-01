#!/usr/bin/env node
/**
 * One-shot interactive-free setup: write a starter ~/.odw/config.json if none
 * exists, install the daemon binary globally, and print next steps.
 * Cross-platform (no shell-specific syntax). Run: npm run setup
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.ODW_HOME || join(homedir(), '.odw');
const configPath = join(home, 'config.json');
const tokenPath = join(home, 'daemon.token');

// chmod 0600 on POSIX; win32 skips it (NTFS ignores POSIX modes and
// %USERPROFILE% ACLs are already user-private).
const tighten = (path) => {
  if (process.platform === 'win32') return;
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
};

const ind = (s) => `\x1b[38;5;105m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(ind('open dynamic workflows · setup'));

if (!existsSync(home)) mkdirSync(home, { recursive: true });

if (existsSync(configPath)) {
  tighten(configPath); // apiKeys live in this file — keep it user-only
  console.log(`  ${ok('✓')} config already present at ${configPath}`);
} else {
  const starter = {
    daemon: { port: 7345, maxConcurrency: 16, logLevel: 'info' },
    apiKeys: { anthropic: '', openai: '' },
    // Single-provider (Anthropic) happy path: one key under apiKeys.anthropic
    // satisfies all three roles. Swap any role to another provider's model
    // (e.g. planning: 'gpt-4o-mini') once you add that provider's key.
    models: { planning: 'claude-sonnet-4-6', default: 'claude-sonnet-4-6', fallback: 'claude-sonnet-4-6' },
    budget: { defaultMaxTokens: 1000000, defaultMaxCostUSD: 50, alertAtPercent: 80 },
  };
  // Written WITHOUT a BOM so every JSON parser (including Node's) accepts it.
  writeFileSync(configPath, JSON.stringify(starter, null, 2), { encoding: 'utf8', mode: 0o600 });
  tighten(configPath);
  console.log(`  ${ok('✓')} wrote starter config ${configPath}`);
  console.log('    → add an API key under "apiKeys", or set models.default to "ollama:<model>" for $0 local runs');
}

if (existsSync(tokenPath)) {
  tighten(tokenPath);
  console.log(`  ${ok('✓')} daemon token already present at ${tokenPath}`);
} else {
  writeFileSync(tokenPath, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
  tighten(tokenPath);
  console.log(`  ${ok('✓')} generated daemon auth token ${tokenPath}`);
}

try {
  console.log('  installing the odw-daemon binary globally...');
  // Call npm.cmd directly on Windows instead of shell:true — passing a shell to
  // execFileSync triggers Node's DEP0190 deprecation warning on every run.
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmBin, ['install', '-g', join(repoRoot, 'packages', 'daemon')], { stdio: 'inherit' });
  console.log(`  ${ok('✓')} odw-daemon is on your PATH`);
} catch {
  console.log('  (global install skipped — you can still run: npm run odw -- start)');
}

console.log('');
console.log('next:');
console.log('  odw-daemon start                         # or: npm start');
console.log('  odw-daemon run --prompt "workflow: ..."  # or: npm run odw -- run --prompt "..."');
console.log('  odw-daemon integrate all                 # install every supported agent adapter');
console.log('  odw-daemon integrate mcp|codex|cursor|kimi|gemini|zed|zcode|opencode|vscode|antigravity|openclaw');
console.log('  odw-daemon doctor all                    # verify daemon + agent wiring');
console.log('  npm run smoke:hosts                      # temp live install + host CLI probes');
