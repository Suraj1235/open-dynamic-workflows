import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const resultsRoot = join(root, 'Tests', 'results', 'odw-real-projects');
const intervalMs = Number(process.env.ODW_REAL_PROJECT_INTERVAL_MS ?? 15 * 60 * 1000);
const durationMs = Number(process.env.ODW_REAL_PROJECT_DURATION_MS ?? 24 * 60 * 60 * 1000);
const provider = process.env.ODW_PROVIDER_MODE ?? 'mock';
const projectsPerCycle = Number(process.env.ODW_REAL_PROJECTS_PER_CYCLE ?? 10);
const stopAt = Date.now() + durationMs;
let iteration = 0;

await mkdir(resultsRoot, { recursive: true });
await writeBrief({ iteration: 0, ok: false, exitCode: null, provider, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), nextRunAt: new Date().toISOString(), stdoutTail: 'Monitor started. First project batch is running.', stderrTail: '' });
while (Date.now() < stopAt) {
  iteration++;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['Tests/odw-real-projects/run-until-100.mjs', '--target=100', `--provider=${provider}`, `--max-projects=${projectsPerCycle}`], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const status = { iteration, ok: exitCode === 0, exitCode, provider, projectsPerCycle, startedAt, finishedAt: new Date().toISOString(), nextRunAt: new Date(Math.min(Date.now() + intervalMs, stopAt)).toISOString(), stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000) };
  await writeFile(join(resultsRoot, 'monitor-latest.json'), `${JSON.stringify(status, null, 2)}\n`);
  await writeBrief(status);
  console.log(`${status.finishedAt} ODW real-project monitor iteration=${iteration} ${status.ok ? 'OK' : 'CONTINUING'}`);
  if (status.ok) break;
  if (Date.now() + intervalMs > stopAt) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

async function writeBrief(status) {
  const ledgerPath = join(resultsRoot, 'ledger.json');
  let ledger = { successes: 0, failures: 0, current: 'n/a', projects: {} };
  if (existsSync(ledgerPath)) {
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch {}
  }
  const completed = Object.values(ledger.projects ?? {}).filter((project) => project.ok).length;
  const attempted = Object.values(ledger.projects ?? {}).filter((project) => (project.attempts ?? 0) > 0).length;
  const failed = Object.values(ledger.projects ?? {}).filter((project) => (project.attempts ?? 0) > 0 && !project.ok).length;
  const current = ledger.current ?? 'n/a';
  const brief = `# ODW Real-Project Build Brief\n\n` +
    `- Time: ${status.finishedAt}\n` +
    `- Monitor iteration: ${status.iteration}\n` +
    `- Provider: ${status.provider}\n` +
    `- Current project: ${current}\n` +
    `- Successful projects: ${completed}/100\n` +
    `- Attempted projects: ${attempted}/100\n` +
    `- Failed or pending retry: ${failed}\n` +
    `- Last run exit code: ${status.exitCode}\n` +
    `- Next run: ${status.nextRunAt}\n\n` +
    `## Last Output\n\n\`\`\`text\n${status.stdoutTail || status.stderrTail || 'No output captured.'}\n\`\`\`\n`;
  await writeFile(join(resultsRoot, 'brief-latest.md'), brief);
  const historyPath = join(resultsRoot, 'brief-history.md');
  const previous = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : '# ODW Real-Project Build Brief History\n\n';
  await writeFile(historyPath, `${previous}\n---\n\n${brief}`);
}
