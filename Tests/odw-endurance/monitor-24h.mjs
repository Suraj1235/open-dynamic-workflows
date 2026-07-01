import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, '..', 'results', 'odw-endurance');
const intervalMs = Number(process.env.ODW_MONITOR_INTERVAL_MS || 15 * 60 * 1000);
const durationMs = Number(process.env.ODW_MONITOR_DURATION_MS || 24 * 60 * 60 * 1000);
const target = process.env.ODW_ENDURANCE_TARGET || '100';
const startedAtMs = Date.now();
const stopAtMs = startedAtMs + durationMs;

await mkdir(resultsDir, { recursive: true });

let iteration = 0;
do {
  iteration++;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [join(__dirname, 'run-campaign.mjs'), `--target=${target}`], {
    cwd: join(__dirname, '..', '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const status = {
    iteration,
    ok: exitCode === 0,
    exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    nextRunAt: new Date(Math.min(Date.now() + intervalMs, stopAtMs)).toISOString(),
    target: Number(target),
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  };
  await writeFile(join(resultsDir, 'monitor-latest.json'), `${JSON.stringify(status, null, 2)}\n`);
  console.log(`${status.finishedAt} ODW endurance monitor iteration=${iteration} ${status.ok ? 'OK' : 'FAILED'}`);
  if (Date.now() + intervalMs > stopAtMs) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (Date.now() < stopAtMs);
