import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const resultsRoot = join(root, 'Tests', 'results', 'odw-real-projects');
const processPath = join(resultsRoot, 'monitor-process.json');
const latestPath = join(resultsRoot, 'monitor-latest.json');
const ledgerPath = join(resultsRoot, 'ledger.json');

const processStatus = existsSync(processPath) ? JSON.parse(stripBom(await readFile(processPath, 'utf8'))) : {};
const latest = existsSync(latestPath) ? JSON.parse(await readFile(latestPath, 'utf8')) : {};
const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, 'utf8')) : { projects: {} };
const projects = Object.values(ledger.projects ?? {});

console.log(JSON.stringify({
  pid: processStatus.pid,
  running: processStatus.pid ? isRunning(processStatus.pid) : false,
  provider: processStatus.provider,
  intervalMinutes: processStatus.intervalMinutes,
  durationHours: processStatus.durationHours,
  current: ledger.current,
  successes: projects.filter((project) => project.ok).length,
  attempted: projects.filter((project) => (project.attempts ?? 0) > 0).length,
  failedOrPendingRetry: projects.filter((project) => (project.attempts ?? 0) > 0 && !project.ok).length,
  latestIteration: latest.iteration,
  latestOk: latest.ok,
  latestFinishedAt: latest.finishedAt,
  nextRunAt: latest.nextRunAt,
  brief: processStatus.brief ?? 'Tests/results/odw-real-projects/brief-latest.md',
  stopCommand: processStatus.stopCommand,
}, null, 2));

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
