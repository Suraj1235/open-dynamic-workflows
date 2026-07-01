import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmbeddedOrchestrator } from '../../packages/daemon/src/embedded.js';
import { createKimiProvider } from './provider.mjs';
import { validateProject } from './validator.mjs';

export async function buildProject({ project, outputRoot, providerMode = 'mock' }) {
  const provider = createKimiProvider({
    mode: providerMode,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    model: process.env.AZURE_OPENAI_MODEL || 'Kimi-K2.6',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview',
  });
  const orch = createEmbeddedOrchestrator({ invoke: provider.invoke, maxConcurrency: 4, perAgentTimeout: 90, maxAttempts: 3 });
  const plan = projectPlan(project);
  const started = Date.now();
  const run = await orch.run(plan, { cwd: outputRoot });
  const artifacts = run.result?.artifacts;
  const projectDir = join(outputRoot, `${project.id}-${project.slug}`);
  await materializeProject(projectDir, project, artifacts);
  const validation = validateProject(projectDir);
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    industry: project.industry,
    odwStatus: run.status,
    ok: validation.ok,
    durationMs: Date.now() - started,
    providerCalls: provider.getCalls(),
    workflowId: run.workflowId,
    validation,
    projectDir,
  };
}

function projectPlan(project) {
  return {
    prompt: `Build production-ready open-source project package for ${project.title}`,
    topology: 'actual-project-build',
    roles: [
      { id: 'product', systemPrompt: 'You are a principal product architect. Return concise, actionable content.' },
      { id: 'backend', systemPrompt: 'You are a pragmatic backend engineer designing secure APIs and data models.' },
      { id: 'security', systemPrompt: 'You are a zero-trust security reviewer.' },
      { id: 'qa', systemPrompt: 'You are a test architect focused on production readiness.' },
    ],
    estimate: { totalAgents: 6 },
    strategy: { budget: { model: 'host:default', maxTokens: 2_000_000, maxCostUSD: 1_000 }, timeouts: { total: 180 } },
    script: `async function execute(){
      const brief = ${JSON.stringify(project)};
      phase('discover', {project: brief.slug});
      const product = await agent({role:'product', prompt:'Return JSON product spec for '+JSON.stringify(brief)+'. Return JSON with summary, users, features, workflows, successMetrics.', maxTokens:1200, schema:{type:'object', properties:{summary:{type:'string'}, users:{type:'array'}, features:{type:'array'}, workflows:{type:'array'}, successMetrics:{type:'array'}}, required:['summary','features']}});
      const parallelWork = await parallel([
        () => agent({role:'backend', prompt:'Return JSON technical architecture, API endpoints, and data entities for '+brief.title+'. Return JSON with architecture, endpoints, entities.', maxTokens:1400, schema:{type:'object', properties:{architecture:{type:'string'}, endpoints:{type:'array'}, entities:{type:'array'}}, required:['architecture','endpoints','entities']}}),
        () => agent({role:'security', prompt:'Return JSON security controls, privacy risks, abuse cases, and compliance notes for '+brief.title+'.', maxTokens:1400, schema:{type:'object', properties:{controls:{type:'array'}, risks:{type:'array'}, abuseCases:{type:'array'}, compliance:{type:'array'}}, required:['controls','risks']}}),
        () => agent({role:'qa', prompt:'Return JSON test plan, acceptance criteria, and production readiness checks for '+brief.title+'.', maxTokens:1400, schema:{type:'object', properties:{tests:{type:'array'}, acceptance:{type:'array'}, readiness:{type:'array'}}, required:['tests','acceptance']}})
      ]);
      const review = await verify({target:{brief, product, parallelWork}, mode:'adversarial', critics:[
        {role:'security', prompt:'Reject if this is not safe enough for an open-source production starter.'},
        {role:'qa', prompt:'Reject if deliverables are too vague to build.'},
        {role:'product', prompt:'Reject if the project does not solve a real user problem.'}
      ]});
      await checkpoint({project: brief.slug, reviewPassed: review.passed});
      return {ok: review.passed, artifacts:{brief, product, architecture:parallelWork[0], security:parallelWork[1], qa:parallelWork[2], review}};
    } module.exports={execute};`,
  };
}

async function materializeProject(projectDir, project, artifacts = {}) {
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await mkdir(join(projectDir, 'test'), { recursive: true });
  const spec = artifacts.product ?? {};
  const arch = artifacts.architecture ?? {};
  const security = artifacts.security ?? {};
  const qa = artifacts.qa ?? {};
  await writeFile(join(projectDir, 'README.md'), readme(project, spec, arch, security, qa));
  await writeFile(join(projectDir, 'PRD.md'), doc('PRD', project, spec));
  await writeFile(join(projectDir, 'ARCHITECTURE.md'), doc('Architecture', project, arch));
  await writeFile(join(projectDir, 'API.md'), doc('API', project, { endpoints: arch.endpoints ?? [] }));
  await writeFile(join(projectDir, 'DATA_MODEL.md'), doc('Data Model', project, { entities: arch.entities ?? [] }));
  await writeFile(join(projectDir, 'SECURITY.md'), doc('Security', project, security));
  await writeFile(join(projectDir, 'TEST_PLAN.md'), doc('Test Plan', project, qa));
  await writeFile(join(projectDir, 'ROADMAP.md'), roadmap(project));
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: project.slug, version: '0.1.0', type: 'module', license: project.license, scripts: { test: 'node --test test/' } }, null, 2));
  await writeFile(join(projectDir, 'src/index.js'), source(project));
  await writeFile(join(projectDir, 'test/index.test.js'), testSource(project));
}

function readme(project, spec, arch, security, qa) {
  return `# ${project.title}\n\nLicense: ${project.license}\n\n## Problem\n${project.problem}\n\n## Users\n${list(spec.users ?? ['operators', 'case workers', 'community administrators'])}\n\n## Architecture\n${arch.architecture ?? 'Modular intake, rules, recommendation, audit, and reporting services.'}\n\n## API\n${list(arch.endpoints ?? ['/healthz', '/api/intake', '/api/recommendations', '/api/audit-events'])}\n\n## Data\n${list(arch.entities ?? ['IntakeRecord', 'Recommendation', 'AuditEvent'])}\n\n## Security\n${list(security.controls ?? ['input validation', 'role-based access', 'audit logging', 'data minimization'])}\n\n## Test\n${list(qa.tests ?? ['unit tests', 'integration tests', 'security regression tests'])}\n`;
}

function doc(title, project, data) {
  return `# ${title}: ${project.title}\n\n## Problem\n${project.problem}\n\n## Details\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
}

function roadmap(project) {
  return `# Roadmap: ${project.title}\n\n1. Prototype intake and validation.\n2. Implement core recommendation engine.\n3. Add audit trail and exports.\n4. Run privacy, security, accessibility, and reliability reviews.\n5. Prepare production deployment package.\n`;
}

function source(project) {
  return `export function health(){ return { ok: true, service: ${JSON.stringify(project.slug)} }; }\nexport function validateIntake(input){ return Boolean(input && typeof input === 'object'); }\nexport function recommend(input){ if(!validateIntake(input)) throw new Error('invalid intake'); return { project: ${JSON.stringify(project.slug)}, recommendations: [], auditRequired: true }; }\n`;
}

function testSource(project) {
  return `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { health, validateIntake, recommend } from '../src/index.js';\n\ntest('health reports service', () => { assert.deepEqual(health(), { ok: true, service: ${JSON.stringify(project.slug)} }); });\ntest('validateIntake rejects missing intake', () => { assert.equal(validateIntake(null), false); });\ntest('recommend returns an auditable response', () => { assert.equal(recommend({}).auditRequired, true); });\n`;
}

function list(values) {
  return values.map((value) => `- ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
}
