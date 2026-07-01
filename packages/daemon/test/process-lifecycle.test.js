/**
 * Daemon process lifecycle: stopDaemon() PID-file hygiene. On Windows a
 * SIGTERM is a hard terminate, so the daemon's drain handler (which clears the
 * pid file on POSIX) usually never runs — stopDaemon() must therefore remove
 * the pid file itself after a successful kill so `status` reflects reality.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandbox ~/.odw to a temp dir BEFORE importing the module under test.
const HOME = mkdtempSync(join(tmpdir(), 'odw-proc-'));
process.env.ODW_HOME = HOME;

const { stopDaemon, daemonPaths, daemonStatusFromPidFile } = await import('../src/process.js');

/** Spawn a real long-lived detached child and return its pid. */
function spawnLived() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

test('stopDaemon: no pid file → returns false, nothing to clean', () => {
  const { pidFile } = daemonPaths();
  if (existsSync(pidFile)) rmSync(pidFile, { force: true });
  assert.equal(stopDaemon(), false);
  assert.equal(existsSync(pidFile), false);
});

test('stopDaemon: stale (dead) pid file → returns false and removes the stale file', () => {
  const { pidFile } = daemonPaths();
  // a pid that is essentially never live; existence probe fails → not running
  writeFileSync(pidFile, '999999999', 'utf8');
  assert.equal(daemonStatusFromPidFile().running, false);
  assert.equal(stopDaemon(), false);
  assert.equal(existsSync(pidFile), false, 'stale pid file is cleared');
});

test('stopDaemon: signals a live daemon; on Windows the pid file is removed immediately', async () => {
  const { pidFile } = daemonPaths();
  const pid = spawnLived();
  writeFileSync(pidFile, String(pid), 'utf8');

  // sanity: the child is live, so status reports running
  assert.deepEqual(daemonStatusFromPidFile(), { running: true, pid });

  const signalled = stopDaemon();
  assert.equal(signalled, true, 'a live daemon is signalled');

  if (process.platform === 'win32') {
    // hard terminate: the drain handler never clears the pid, so stopDaemon must
    assert.equal(existsSync(pidFile), false, 'Windows: pid file removed after kill so status is honest');
  } else {
    // POSIX: the (real) drain handler owns removal; stopDaemon leaves it in place
    assert.equal(existsSync(pidFile), true, 'POSIX: pid file left for the drain handler to clear');
    // clean up the file + the still-dying child ourselves
    rmSync(pidFile, { force: true });
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // give the OS a beat, then make sure the child is actually dead (no leak)
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(daemonStatusFromPidFile().running, false, 'the signalled daemon is no longer running');
});

test.after(() => {
  // Each test kills its own child; just drop the sandbox home.
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
