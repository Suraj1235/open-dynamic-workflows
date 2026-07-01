import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { projectCatalog } from './catalog.mjs';
import { buildProject } from './builder.mjs';

const root = process.cwd();
const resultsRoot = join(root, 'Tests', 'results', 'odw-real-projects');
const outputRoot = join(resultsRoot, 'built-projects');
const id = process.argv.find((arg) => arg.startsWith('--id='))?.split('=')[1] ?? process.env.ODW_PROJECT_ID;
const mode = process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] ?? process.env.ODW_PROVIDER_MODE ?? 'mock';

if (!id) throw new Error('Use --id=001 or set ODW_PROJECT_ID');
await mkdir(resultsRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const project = projectCatalog().find((item) => item.id === String(id).padStart(3, '0'));
if (!project) throw new Error(`Unknown project id: ${id}`);

const startedAt = new Date().toISOString();
let result;
try {
  result = await buildProject({ project, outputRoot, providerMode: mode });
  const testRun = await runGeneratedTests(result.projectDir);
  result.tests = testRun;
  result.ok = result.ok && testRun.exitCode === 0;
  if (result.odwStatus && result.odwStatus !== 'completed') {
    result.frameworkDefect = `ODW workflow status was ${result.odwStatus} after artifacts materialized and tests passed`;
  }
} catch (error) {
  result = { id: project.id, slug: project.slug, title: project.title, industry: project.industry, ok: false, error: String(error?.message ?? error) };
}
result.startedAt = startedAt;
result.finishedAt = new Date().toISOString();
result.providerMode = mode;

await writeFile(join(resultsRoot, `project-${project.id}-${project.slug}.json`), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(join(resultsRoot, `project-${project.id}-${project.slug}.md`), markdown(result));
await writeFile(join(resultsRoot, 'latest-one.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ id: result.id, slug: result.slug, ok: result.ok, providerCalls: result.providerCalls, projectDir: result.projectDir }, null, 2));
process.exitCode = result.ok ? 0 : 1;

async function runGeneratedTests(projectDir) {
  if (!projectDir || !existsSync(projectDir)) return { exitCode: 1, stdout: '', stderr: 'project directory missing' };
  const child = spawn(process.execPath, ['--test', 'test/'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  return { exitCode, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) };
}

function markdown(result) {
  return `# ${result.id} ${result.title}\n\n- OK: ${result.ok}\n- Provider: ${result.providerMode}\n- Industry: ${result.industry}\n- Project directory: ${result.projectDir ?? 'n/a'}\n- Workflow ID: ${result.workflowId ?? 'n/a'}\n- Provider calls: ${result.providerCalls ?? 0}\n\n## Validation\n\n\`\`\`json\n${JSON.stringify(result.validation ?? {}, null, 2)}\n\`\`\`\n\n## Tests\n\nExit code: ${result.tests?.exitCode ?? 'n/a'}\n\n\`\`\`text\n${result.tests?.stdout ?? result.error ?? ''}\n${result.tests?.stderr ?? ''}\n\`\`\`\n`;
}
