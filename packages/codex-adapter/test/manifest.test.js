'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '..');

test('plugin.json metadata is valid JSON with required fields', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'odw');
  assert.equal(manifest.license, 'MIT');
});

test('.codex-plugin/plugin.json marketplace manifest is valid and in sync', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const legacy = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, legacy.name);
  assert.equal(manifest.license, legacy.license);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(manifest.version, 'marketplace manifest must declare a version');
  assert.ok(manifest.interface && manifest.interface.displayName, 'interface.displayName required for marketplace listings');
});

test('canonical skill folder exists with frontmatter and daemon steps', () => {
  const skill = readFileSync(join(root, 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: odw\r?\n/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /daemon-bridge\.js plan/);
  assert.ok(existsSync(join(root, 'AGENTS.md')));
});

test('canonical ultracode alias skill exists with frontmatter and daemon steps', () => {
  const skill = readFileSync(join(root, 'skills', 'ultracode', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: ultracode\r?\n/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /daemon-bridge\.js plan/);
  assert.match(skill, /ultracode/);
});

test('every tracked daemon-bridge.js stays byte-identical to the codex-adapter source', () => {
  // The bridges are deliberate duplicates fanned out across adapters/plugin bundles
  // (zero-dependency skill packaging; CONTRIBUTING.md forbids adapters importing the
  // daemon) — edits must land in EVERY copy. This guard hash-compares all tracked
  // copies against the canonical codex-adapter source so drift in ANY copy is caught.
  const repoRoot = join(root, '..', '..');
  const canonicalRel = 'packages/codex-adapter/scripts/daemon-bridge.js';
  const canonical = readFileSync(join(repoRoot, canonicalRel));

  const listed = execFileSync('git', ['ls-files', '*daemon-bridge.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const copies = listed.split('\n').map((line) => line.trim()).filter(Boolean);

  assert.ok(copies.length >= 2, `expected multiple tracked daemon-bridge.js copies, found ${copies.length}`);
  assert.ok(copies.includes(canonicalRel), 'canonical codex-adapter daemon-bridge.js must be tracked');

  for (const rel of copies) {
    if (rel === canonicalRel) continue;
    const copy = readFileSync(join(repoRoot, rel));
    assert.ok(copy.equals(canonical), `daemon-bridge drifted: ${rel} differs from ${canonicalRel} — apply identical edits to every copy`);
  }
});

test('daemon-bridge --check exits 1 with a helpful message when daemon is down', () => {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'daemon-bridge.js'), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, ODW_DAEMON_PORT: '59998' },
      timeout: 15000,
    });
    assert.fail('expected non-zero exit');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /not reachable|Start it/);
  }
});

test('daemon-bridge with no args prints usage and exits 2', () => {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'daemon-bridge.js')], { encoding: 'utf8', timeout: 15000 });
    assert.fail('expected non-zero exit');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /usage/);
  }
});
