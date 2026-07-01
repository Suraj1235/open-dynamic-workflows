import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { projectCatalog } from './catalog.mjs';

const root = process.cwd();
const resultsRoot = join(root, 'Tests', 'results', 'odw-real-projects');
const ledgerPath = join(resultsRoot, 'ledger.json');
const mode = process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] ?? process.env.ODW_PROVIDER_MODE ?? 'mock';
const target = Number(process.argv.find((arg) => arg.startsWith('--target='))?.split('=')[1] ?? process.env.ODW_PROJECT_TARGET ?? 100);
const maxProjects = Number(process.argv.find((arg) => arg.startsWith('--max-projects='))?.split('=')[1] ?? process.env.ODW_MAX_PROJECTS_PER_RUN ?? 100);
const maxAttemptsPerProject = Number(process.env.ODW_MAX_ATTEMPTS_PER_PROJECT ?? 3);

await mkdir(resultsRoot, { recursive: true });
const ledger = await loadLedger();
const catalog = projectCatalog();
let projectsRun = 0;

for (const project of catalog) {
  if (successCount(ledger) >= target) break;
  if (projectsRun >= maxProjects) break;
  if (ledger.projects[project.id]?.ok) continue;
  ledger.projects[project.id] ??= { id: project.id, slug: project.slug, attempts: 0, ok: false };

  while (!ledger.projects[project.id].ok && ledger.projects[project.id].attempts < maxAttemptsPerProject) {
    ledger.projects[project.id].attempts++;
    ledger.current = project.id;
    await saveLedger(ledger);
    const run = await runOne(project.id, mode);
    ledger.projects[project.id] = { ...ledger.projects[project.id], ...run, lastAttemptAt: new Date().toISOString() };
    projectsRun++;
    ledger.successes = successCount(ledger);
    ledger.failures = Object.values(ledger.projects).filter((item) => item.attempts > 0 && !item.ok).length;
    await saveLedger(ledger);
    if (!run.ok) break;
  }
}

ledger.finishedAt = new Date().toISOString();
ledger.successes = successCount(ledger);
await saveLedger(ledger);
console.log(JSON.stringify({ ok: ledger.successes >= target, target, successes: ledger.successes, failures: ledger.failures ?? 0, current: ledger.current, projectsRun }, null, 2));
process.exitCode = ledger.successes >= target ? 0 : 1;

async function runOne(id, provider) {
  const child = spawn(process.execPath, ['Tests/odw-real-projects/run-one.mjs', `--id=${id}`, `--provider=${provider}`], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  let parsed = {};
  try { parsed = JSON.parse(stdout); } catch {}
  return { ok: exitCode === 0, exitCode, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), ...parsed };
}

async function loadLedger() {
  if (!existsSync(ledgerPath)) return { startedAt: new Date().toISOString(), projects: {}, successes: 0, failures: 0 };
  return JSON.parse(await readFile(ledgerPath, 'utf8'));
}

async function saveLedger(ledger) {
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(join(resultsRoot, 'status.md'), statusMarkdown(ledger));
}

function successCount(ledger) {
  return Object.values(ledger.projects).filter((item) => item.ok).length;
}

function statusMarkdown(ledger) {
  const rows = Object.values(ledger.projects).map((item) => `| ${item.id} | ${item.slug} | ${item.ok ? 'PASS' : 'PENDING/FAIL'} | ${item.attempts ?? 0} | ${item.projectDir ?? ''} |`).join('\n');
  return `# ODW Real Projects Status\n\n- Successes: ${successCount(ledger)}\n- Current: ${ledger.current ?? 'n/a'}\n\n| ID | Slug | Status | Attempts | Project Dir |\n| --- | --- | --- | ---: | --- |\n${rows}\n`;
}
