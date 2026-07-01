import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { assertPublicHttpUrl, validateGlob, assertSafeGitArgs, createToolExecutor } = await import('../src/tools.js');

// ── SSRF guard (no real network: lookup is injected) ─────────────────────────

const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const neverResolve = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };

test('ssrf: non-http(s) schemes are rejected', async () => {
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com/x'), /must be http\(s\)/);
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /must be http\(s\)/);
  await assert.rejects(() => assertPublicHttpUrl('not a url'), /invalid url/);
});

test('ssrf: private/internal literal v4 addresses are blocked', async () => {
  const blocked = [
    'http://0.0.0.0/', 'http://10.1.2.3/', 'http://127.0.0.1:8080/x',
    'http://169.254.169.254/latest/meta-data/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.168.1.1/', 'http://100.64.0.1/', 'http://100.127.0.1/', 'http://198.18.0.1/', 'http://198.19.5.5/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), /blocked/, url);
  }
  // the WHATWG URL parser canonicalizes integer/octal v4 forms to dotted-quad
  await assert.rejects(() => assertPublicHttpUrl('http://2130706433/'), /blocked/, 'integer-form 127.0.0.1');
});

test('ssrf: v6 loopback/unspecified/private/link-local/mapped-v4 are blocked', async () => {
  const blocked = [
    'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), /blocked/, url);
  }
});

test('ssrf: blocked hostnames are rejected without a lookup', async () => {
  const blocked = [
    'http://localhost/', 'http://localhost:3000/x', 'http://foo.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata.goog/',
    'http://kubernetes.default.svc/', 'http://anything.svc.cluster.local/',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url, { lookup: resolveTo('93.184.216.34') }), /blocked host/, url);
  }
});

test('ssrf: a hostname resolving to ANY private address is blocked (DNS pinning)', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://evil.example.com/', { lookup: resolveTo('93.184.216.34', '10.0.0.5') }),
    /resolves to a private\/internal address/
  );
  await assert.rejects(
    () => assertPublicHttpUrl('http://rebind.example.com/', { lookup: resolveTo('::ffff:192.168.0.1') }),
    /resolves to a private\/internal address/
  );
});

test('ssrf: public hosts pass; lookup failure throws a clear error', async () => {
  const u = await assertPublicHttpUrl('https://example.com/docs', { lookup: resolveTo('93.184.216.34', '2606:2800:220:1::1') });
  assert.equal(u.hostname, 'example.com');
  await assert.rejects(() => assertPublicHttpUrl('http://no-such-host.example/', { lookup: neverResolve }), /cannot resolve host/);
  await assert.rejects(() => assertPublicHttpUrl('http://empty.example/', { lookup: resolveTo() }), /cannot resolve host/);
});

test('ssrf: allowPrivateNetwork bypasses the address checks (localhost docs servers)', async () => {
  const opts = { allowPrivateNetwork: true, lookup: neverResolve };
  await assert.doesNotReject(() => assertPublicHttpUrl('http://localhost:8080/docs', opts));
  await assert.doesNotReject(() => assertPublicHttpUrl('http://127.0.0.1:3000/', opts));
  // scheme is still enforced even when private networks are allowed
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd', opts), /must be http\(s\)/);
});

// ── glob complexity limits ────────────────────────────────────────────────────

test('glob: validateGlob enforces length and wildcard limits', () => {
  assert.equal(validateGlob('src/**/*.{js,ts}'), 'src/**/*.{js,ts}');
  assert.throws(() => validateGlob('x'.repeat(501)), /too long: 501 chars/);
  assert.throws(() => validateGlob('*?'.repeat(9)), /too complex: 18 wildcards/);
  // 16 wildcards is the inclusive maximum
  assert.equal(validateGlob('*'.repeat(16)), '*'.repeat(16));
});

// ── git tool subcommand allowlist ───────────────────────────────────────────
// Unblocking the git tool (git_commit approval) must NOT double as a licence
// for destructive git — force-push, hard-reset, arbitrary `-c` config overrides.

test('git: safe subcommands (status/diff/log/add/commit) pass the allowlist', () => {
  assert.deepEqual(assertSafeGitArgs(['status', '--short']), ['status', '--short']);
  assert.deepEqual(assertSafeGitArgs(['log', '-1']), ['log', '-1']);
  assert.deepEqual(assertSafeGitArgs(['diff', '--staged']), ['diff', '--staged']);
  assert.deepEqual(assertSafeGitArgs(['add', '-A']), ['add', '-A']);
  assert.deepEqual(assertSafeGitArgs(['commit', '-m', 'msg']), ['commit', '-m', 'msg']);
});

test('git: dangerous subcommands (push/reset/clean/rebase/update-ref) are blocked', () => {
  assert.throws(() => assertSafeGitArgs(['push', 'origin', 'main']), /subcommand "push" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['reset', 'HEAD~1']), /subcommand "reset" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['clean', '-fdx']), /subcommand "clean" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['rebase', '-i', 'HEAD~3']), /subcommand "rebase" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['update-ref', 'HEAD', 'deadbeef']), /subcommand "update-ref" is not allowed/);
  assert.throws(() => assertSafeGitArgs([]), /no subcommand provided/);
});

test('git: a force-push is blocked (both the push subcommand and the --force/-f flag)', () => {
  // push is not on the allowlist at all
  assert.throws(() => assertSafeGitArgs(['push', 'origin', 'main']), /"push" is not allowed/);
  // blocked flags are rejected before the subcommand → the --force/-f/--force-with-lease
  // guard trips first; either way a force-push can never run.
  assert.throws(() => assertSafeGitArgs(['push', '--force', 'origin', 'main']), /flag "--force" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['push', '-f']), /flag "-f" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['push', '--force-with-lease']), /flag "--force-with-lease" is not allowed/);
});

test('git: a hard-reset is blocked (both the reset subcommand and the --hard flag)', () => {
  // reset is not on the allowlist
  assert.throws(() => assertSafeGitArgs(['reset', 'origin/main']), /"reset" is not allowed/);
  // --hard trips the flag guard first (checked before the subcommand)
  assert.throws(() => assertSafeGitArgs(['reset', '--hard', 'origin/main']), /flag "--hard" is not allowed/);
  // --hard is rejected as a flag even on an otherwise-allowed subcommand
  assert.throws(() => assertSafeGitArgs(['checkout', '--hard']), /flag "--hard" is not allowed/);
});

test('git: arbitrary -c config override and --exec are blocked even before an allowed subcommand', () => {
  // -c core.hooksPath=/evil status  → would run an arbitrary hook: blocked by flag
  assert.throws(() => assertSafeGitArgs(['-c', 'core.hooksPath=/tmp/evil', 'status']), /flag "-c" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['-c', 'protocol.ext.allow=always', 'fetch']), /flag "-c" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['--config-env=X=Y', 'status']), /flag "--config-env" is not allowed/);
  assert.throws(() => assertSafeGitArgs(['fetch', '--upload-pack', 'sh -c evil', 'origin']), /flag "--upload-pack" is not allowed/);
});

test('git tool executor: force-push / hard-reset are blocked end-to-end even with git_commit unblocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-git-'));
  try {
    // real repo so an ALLOWED command actually runs
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'f.txt'), 'x\n');

    // git_commit REMOVED from requireApprovalFor → the approval gate is open,
    // yet destructive git must still be refused by the allowlist.
    const exec = createToolExecutor({
      cwd: root,
      safety: { requireApprovalFor: [], autoApproveReadOnly: true, dryRun: false, blockedCommands: [] },
    });

    // allowed subcommands run for real
    const status = await exec({ tool: 'git', args: ['status', '--short'] });
    assert.match(status.stdout, /f\.txt/);
    await exec({ tool: 'git', args: ['add', 'f.txt'] });
    const commit = await exec({ tool: 'git', args: ['commit', '-m', 'init'] });
    assert.match(commit.stdout, /init/);

    // the whole point: commit approval does NOT unlock force-push / hard-reset / -c.
    // (blocked flags are rejected before the subcommand, so force/hard trip the flag
    // guard first — either way the destructive op is refused, which is what matters.)
    await assert.rejects(() => exec({ tool: 'git', args: ['push', '--force', 'origin', 'main'] }), /is not allowed/);
    await assert.rejects(() => exec({ tool: 'git', args: ['push', 'origin', 'main'] }), /"push" is not allowed/);
    await assert.rejects(() => exec({ tool: 'git', args: ['reset', '--hard', 'HEAD~1'] }), /is not allowed/);
    await assert.rejects(() => exec({ tool: 'git', args: ['reset', 'HEAD~1'] }), /"reset" is not allowed/);
    await assert.rejects(() => exec({ tool: 'git', args: ['-c', 'core.hooksPath=/tmp/evil', 'status'] }), /flag "-c" is not allowed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
