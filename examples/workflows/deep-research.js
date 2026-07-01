/**
 * Deep research — consensus topology. Standalone example: pass the question via args:
 *   odw-daemon run --script examples/workflows/deep-research.js
 * This file is NOT what the /deep-research chat trigger executes. That trigger only
 * sets mode:"deep-research" and routes the prompt through the planner in research
 * mode, which compiles its own consensus workflow — it does not run this script or
 * read args().question.
 */

async function execute() {
  const question = args().question || 'What are the current best practices for this topic?';

  phase('Decompose', { estimatedAgents: 1 });
  const angles = await agent({
    role: 'research-planner',
    prompt:
      `Break this research question into 4-6 distinct investigation angles (different sources/perspectives): "${question}" ` +
      `Return JSON: {"angles": [{"id": string, "focus": string}]}`,
    schema: { type: 'object', properties: { angles: { type: 'array' } }, required: ['angles'] },
    maxTokens: 2000,
  });
  await checkpoint({ phase: 'decompose', angles });

  phase('Investigate', { estimatedAgents: angles.angles.length });
  const findings = await parallel(
    angles.angles.map((angle) => () =>
      agent({
        role: 'researcher',
        prompt:
          `Research this angle thoroughly from your knowledge: ${angle.focus} (overall question: "${question}") ` +
          `Return JSON: {"angle": string, "claims": [{"claim": string, "confidence": number, "reasoning": string}]}`,
        schema: {
          type: 'object',
          properties: { angle: { type: 'string' }, claims: { type: 'array' } },
          required: ['claims'],
        },
        maxTokens: 4000,
      })
    ),
    { maxConcurrency: 6 }
  );
  await checkpoint({ phase: 'investigate', findings });

  phase('Cross-examine', { estimatedAgents: 3 });
  const verified = await verify({
    target: findings,
    mode: 'consensus',
    critics: [
      { role: 'fact-checker', prompt: 'Cross-examine these research claims for factual errors and overconfidence.' },
      { role: 'fact-checker', prompt: 'Independently challenge these claims: which would not survive scrutiny?' },
      { role: 'completeness-checker', prompt: 'What important perspectives are MISSING from this research?' },
    ],
    consensusThreshold: 2,
    minConfidence: 0.7,
  });
  await checkpoint({ phase: 'cross-examine', verified });

  phase('Synthesis', { estimatedAgents: 1 });
  return agent({
    role: 'synthesis-agent',
    prompt:
      `Write a balanced research summary answering "${question}" from these verified findings: ` +
      `${JSON.stringify(verified).slice(0, 30000)} ` +
      `Return JSON: {"summary": string, "keyFindings": [string], "openQuestions": [string], "confidence": number}`,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' }, keyFindings: { type: 'array' },
        openQuestions: { type: 'array' }, confidence: { type: 'number' },
      },
      required: ['summary', 'keyFindings'],
    },
    maxTokens: 8000,
  });
}

module.exports = { execute };
