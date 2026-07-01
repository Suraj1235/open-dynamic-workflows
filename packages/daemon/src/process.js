/**
 * Daemon process lifecycle: detached background spawn (cross-platform),
 * PID file management, graceful SIGTERM/SIGINT drain.
 */

import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureHome } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {{pidFile: string, logFile: string}} */
export function daemonPaths() {
  const { pidFile, logFile } = ensureHome();
  return { pidFile, logFile };
}

/**
 * Spawn the daemon detached (survives the parent). Returns the child PID.
 * @param {string[]} [args] extra args for `cli.js start --foreground`
 */
export function spawnDetached(args = []) {
  const { pidFile, logFile } = daemonPaths();
  const logFd = openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [join(here, 'cli.js'), 'start', '--foreground', ...args],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env, ODW_DAEMONIZED: '1' },
    }
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid), 'utf8');
  return child.pid;
}

/** @returns {{running: boolean, pid?: number}} */
export function daemonStatusFromPidFile() {
  const { pidFile } = daemonPaths();
  if (!existsSync(pidFile)) return { running: false };
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  try {
    process.kill(pid, 0); // existence probe
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

/** Send termination signal to the daemon by PID file. @returns {boolean} signalled */
export function stopDaemon() {
  const { pidFile } = daemonPaths();
  const status = daemonStatusFromPidFile();
  if (!status.running || !status.pid) {
    if (existsSync(pidFile)) rmSync(pidFile, { force: true });
    return false;
  }
  process.kill(status.pid); // SIGTERM (terminates on Windows)
  // On Windows a SIGTERM is a hard terminate — the daemon's drain handler
  // (which clears the pid file) frequently never runs, so `status` would keep
  // reporting a stale pid. Remove it here so status reflects reality at once.
  // On POSIX the drain handler clears it after graceful shutdown, so leave it.
  if (process.platform === 'win32' && existsSync(pidFile)) {
    rmSync(pidFile, { force: true });
  }
  return true;
}

/** Remove the PID file (called by the daemon itself on clean shutdown). */
export function clearPidFile() {
  const { pidFile } = daemonPaths();
  rmSync(pidFile, { force: true });
}

/** Write the CURRENT process pid (foreground daemon owns the pid file). */
export function writePidFile() {
  const { pidFile } = daemonPaths();
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

/**
 * Graceful shutdown: drain HTTP, close DB, remove PID file, exit 0 within the
 * window; force-exit 1 if the drain stalls.
 * @param {{server: {close: () => Promise<void>}, store: {close: Function}, logger: object, timeoutMs?: number}} deps
 */
export function installShutdownHandlers({ server, store, logger, timeoutMs = 30_000 }) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, draining...`);
    const force = setTimeout(() => {
      logger.error('drain window exceeded, forcing exit');
      process.exit(1);
    }, timeoutMs);
    force.unref();
    try {
      await server.close();
      store.close();
      clearPidFile();
      logger.info('clean shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown error', { error });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}
