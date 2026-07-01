const TYPES = ['fanout', 'pipeline', 'verify', 'checkpoint', 'compaction', 'retry', 'mixed'];

export function buildScenarios({ count = 100 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const type = TYPES[index % TYPES.length];
    const scale = scaleFor(id);
    return {
      id: `odw-${String(id).padStart(3, '0')}`,
      type,
      scale,
      expectedMinAgents: expectedMinAgents(type, scale),
      plan: planFor({ id, type, scale }),
    };
  });
}

function scaleFor(id) {
  if (id <= 25) return 'small';
  if (id <= 70) return 'medium';
  if (id <= 90) return 'large';
  return 'stress';
}

function widthFor(scale) {
  return { small: 2, medium: 4, large: 8, stress: 12 }[scale] ?? 2;
}

function expectedMinAgents(type, scale) {
  const width = widthFor(scale);
  if (type === 'pipeline') return width * 2;
  if (type === 'verify') return 1 + 3;
  if (type === 'compaction') return 1;
  if (type === 'retry') return 1;
  if (type === 'mixed') return width + 3;
  return width;
}

function planFor({ id, type, scale }) {
  return {
    prompt: `ODW endurance ${id} ${type} ${scale}`,
    topology: type,
    roles: [
      { id: 'worker', systemPrompt: 'Return deterministic compact JSON for endurance tests.' },
      { id: 'critic', systemPrompt: 'Review the target and return a JSON verdict.' },
    ],
    estimate: { totalAgents: expectedMinAgents(type, scale) },
    strategy: {
      budget: { model: 'host:default', maxTokens: 2_000_000, maxCostUSD: 1_000, alertAtPercent: 90 },
      timeouts: { total: 120 },
      retry: { maxAttempts: 3, backoff: 'linear' },
      context: { enabled: true },
    },
    script: scriptFor({ id, type, scale, width: widthFor(scale) }),
  };
}

function scriptFor({ id, type, scale, width }) {
  const promptPrefix = `case-${id}-${type}-${scale}`;
  if (type === 'pipeline') {
    return `async function execute(){
      phase('pipeline', {width:${width}});
      const items = Array.from({length:${width}}, (_, i) => i);
      const results = await pipeline(items, [
        async (item) => agent({role:'worker', prompt:'${promptPrefix}-discover-'+item, schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128}),
        async (prev, item) => agent({role:'worker', prompt:'${promptPrefix}-refine-'+item+' '+JSON.stringify(prev), schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128})
      ]);
      return {caseId:${id}, type:'pipeline', count:results.filter(Boolean).length, ok:results.every(r=>r && r.ok)};
    } module.exports={execute};`;
  }

  if (type === 'verify') {
    return `async function execute(){
      phase('verify', {critics:3});
      const target = await agent({role:'worker', prompt:'${promptPrefix}-candidate', schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128});
      const verdict = await verify({target, mode:'adversarial', minConfidence:0.2, critics:[
        {role:'critic', prompt:'approve valid endurance output'},
        {role:'critic', prompt:'reject malformed endurance output'},
        {role:'critic', prompt:'check label exists'}
      ]});
      return {caseId:${id}, type:'verify', ok:target.ok && verdict.passed, approvals:verdict.approvals, rejections:verdict.rejections};
    } module.exports={execute};`;
  }

  if (type === 'checkpoint') {
    return `async function execute(){
      phase('checkpoint', {width:${width}});
      await checkpoint({caseId:${id}, stage:'before'});
      const results = await parallel(Array.from({length:${width}}, (_, i) => () => agent({role:'worker', prompt:'${promptPrefix}-checkpoint-'+i, schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128})), {maxConcurrency:3});
      await checkpoint({caseId:${id}, stage:'after', count:results.length});
      return {caseId:${id}, type:'checkpoint', count:results.length, ok:results.every(r=>r.ok)};
    } module.exports={execute};`;
  }

  if (type === 'compaction') {
    const big = 'x'.repeat(2000);
    return `async function execute(){
      phase('compaction', {width:${width}});
      const compacted = await compact(Array.from({length:${width * 30}}, (_, i) => ({i, text:'${big}'})), {maxChars:4000});
      const result = await agent({role:'worker', prompt:'${promptPrefix}-compact '+JSON.stringify(compacted).slice(0, 2000), schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128});
      return {caseId:${id}, type:'compaction', compacted:compacted.length, ok:result.ok};
    } module.exports={execute};`;
  }

  if (type === 'retry') {
    return `async function execute(){
      phase('retry', {caseId:${id}});
      const result = await agent({role:'worker', prompt:'${promptPrefix}-retry-flaky', schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128});
      return {caseId:${id}, type:'retry', ok:result.ok, label:result.label};
    } module.exports={execute};`;
  }

  if (type === 'mixed') {
    return `async function execute(){
      phase('mixed', {width:${width}});
      const fan = await parallel(Array.from({length:${width}}, (_, i) => () => agent({role:'worker', prompt:'${promptPrefix}-mixed-'+i, schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128})), {maxConcurrency:4});
      const verdict = await verify({target:fan, mode:'consensus', consensusThreshold:2, critics:[
        {role:'critic', prompt:'approve array if all items have ok true'},
        {role:'critic', prompt:'approve array if labels are present'},
        {role:'critic', prompt:'approve valid endurance output'}
      ]});
      await checkpoint({caseId:${id}, fanout:fan.length, passed:verdict.passed});
      return {caseId:${id}, type:'mixed', count:fan.length, ok:fan.every(r=>r.ok) && verdict.passed};
    } module.exports={execute};`;
  }

  return `async function execute(){
    phase('fanout', {width:${width}});
    const results = await parallel(Array.from({length:${width}}, (_, i) => () => agent({role:'worker', prompt:'${promptPrefix}-fanout-'+i, schema:{type:'object', properties:{ok:{type:'boolean'}, label:{type:'string'}}, required:['ok','label']}, maxTokens:128})), {maxConcurrency:4});
    return {caseId:${id}, type:'fanout', count:results.length, ok:results.every(r=>r.ok)};
  } module.exports={execute};`;
}
