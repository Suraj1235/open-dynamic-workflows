import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const resultsRoot = join(root, 'Tests', 'results', 'odw-real-projects');
const ledgerPath = join(resultsRoot, 'ledger.json');
const monitorPath = join(resultsRoot, 'monitor-process.json');

const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, 'utf8')) : { projects: {} };
const monitor = existsSync(monitorPath) ? JSON.parse(stripBom(await readFile(monitorPath, 'utf8'))) : {};
const projects = Object.values(ledger.projects ?? {});
const successes = projects.filter((project) => project.ok).length;
const attempted = projects.filter((project) => (project.attempts ?? 0) > 0).length;
const failed = projects.filter((project) => (project.attempts ?? 0) > 0 && !project.ok).length;
const current = ledger.current ?? 'n/a';

const brief = `# ODW Real-Project Build Brief\n\n` +
  `- Time: ${new Date().toISOString()}\n` +
  `- Monitor PID: ${monitor.pid ?? 'n/a'}\n` +
  `- Monitor running: ${monitor.pid ? isRunning(monitor.pid) : false}\n` +
  `- Provider: ${monitor.provider ?? 'unknown'}\n` +
  `- Current project: ${current}\n` +
  `- Successful projects: ${successes}/100\n` +
  `- Attempted projects: ${attempted}/100\n` +
  `- Failed or pending retry: ${failed}\n` +
  `- Brief cadence requested: every ${monitor.intervalMinutes ?? 15} minutes\n\n` +
  `## Note\n\nEach project is built as its own ODW workflow and materialized into its own directory under \`Tests/results/odw-real-projects/built-projects/\`.\n`;

await writeFile(join(resultsRoot, 'brief-latest.md'), brief);
const historyPath = join(resultsRoot, 'brief-history.md');
const previous = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : '# ODW Real-Project Build Brief History\n\n';
await writeFile(historyPath, `${previous}\n---\n\n${brief}`);
console.log(brief);

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
