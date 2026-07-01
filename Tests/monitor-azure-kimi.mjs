import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, 'results');
const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 60_000);
const once = process.argv.includes('--once');

if (!process.env.AZURE_OPENAI_ENDPOINT) throw new Error('AZURE_OPENAI_ENDPOINT is required');
if (!process.env.AZURE_OPENAI_API_KEY) throw new Error('AZURE_OPENAI_API_KEY is required');
process.env.AZURE_OPENAI_MODEL ||= 'Kimi-K2.6';

await mkdir(resultsDir, { recursive: true });

async function runProbe() {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['--test', join(__dirname, 'azure-kimi-smoke.test.mjs')], {
    cwd: join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const status = {
    ok: exitCode === 0,
    exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: process.env.AZURE_OPENAI_MODEL,
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  };
  await writeFile(join(resultsDir, 'monitor-status.json'), `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

do {
  const status = await runProbe();
  console.log(`${status.finishedAt} Azure Kimi monitor ${status.ok ? 'OK' : 'FAILED'}`);
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (true);
