import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const statusPath = join(root, 'Tests', 'results', 'odw-endurance', 'monitor-process.json');
const latestPath = join(root, 'Tests', 'results', 'odw-endurance', 'monitor-latest.json');

const processStatus = JSON.parse(stripBom(await readFile(statusPath, 'utf8')));
let latest = {};
try {
  latest = JSON.parse(await readFile(latestPath, 'utf8'));
} catch {
  latest = {};
}

const running = isRunning(processStatus.pid);
console.log(JSON.stringify({
  pid: processStatus.pid,
  running,
  provider: processStatus.provider,
  target: processStatus.target,
  intervalMinutes: processStatus.intervalMinutes,
  startedAt: processStatus.startedAt,
  latestIteration: latest.iteration,
  latestOk: latest.ok,
  latestFinishedAt: latest.finishedAt,
  nextRunAt: latest.nextRunAt,
  stopCommand: processStatus.stopCommand,
}, null, 2));

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
