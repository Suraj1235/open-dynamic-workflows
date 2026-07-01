import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_FILES = ['README.md', 'PRD.md', 'ARCHITECTURE.md', 'API.md', 'DATA_MODEL.md', 'SECURITY.md', 'TEST_PLAN.md', 'ROADMAP.md', 'package.json', 'src/index.js', 'test/index.test.js'];
const REQUIRED_TERMS = ['problem', 'users', 'architecture', 'api', 'data', 'security', 'test', 'license'];

export function validateProject(projectDir) {
  const failures = [];
  for (const file of REQUIRED_FILES) {
    const path = join(projectDir, file);
    if (!existsSync(path)) failures.push(`missing ${file}`);
  }

  const readme = read(projectDir, 'README.md');
  for (const term of REQUIRED_TERMS) {
    if (!readme.toLowerCase().includes(term)) failures.push(`README missing ${term}`);
  }

  const pkg = read(projectDir, 'package.json');
  try {
    const parsed = JSON.parse(pkg);
    if (!parsed.scripts?.test) failures.push('package.json missing scripts.test');
    if (!parsed.license) failures.push('package.json missing license');
  } catch {
    failures.push('package.json invalid JSON');
  }

  const source = read(projectDir, 'src/index.js');
  if (!source.includes('export function')) failures.push('src/index.js missing exported functions');
  const tests = read(projectDir, 'test/index.test.js');
  if (!tests.includes('node:test') || !tests.includes('assert')) failures.push('test/index.test.js missing node:test assertions');

  return { ok: failures.length === 0, failures };
}

function read(projectDir, file) {
  const path = join(projectDir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
