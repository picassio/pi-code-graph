import { applyProjectScopeToCypher } from '../../src/lib/tools/codebase-query.js';
import { validateCypherReadOnly } from '../../src/lib/llm-service.js';
import type { CypherEvalExample, ExpectedRoute } from './dataset.js';

export interface CypherEvalPrediction {
  route?: ExpectedRoute | string;
  cypher?: string;
  error?: string;
  executionOk?: boolean;
  executionError?: string;
}

export interface CypherEvalScore {
  id: string;
  total: number;
  validity: number;
  safety: number;
  execution: number;
  projectScope: number;
  shape: number;
  route: number;
  feedback: string[];
}

function includesAll(haystack: string, needles: string[] | undefined): boolean {
  return !needles || needles.every((needle) => haystack.includes(needle));
}

function excludesAll(haystack: string, needles: string[] | undefined): boolean {
  return !needles || needles.every((needle) => !haystack.includes(needle));
}

export function scoreCypherPrediction(example: CypherEvalExample, pred: CypherEvalPrediction): CypherEvalScore {
  const feedback: string[] = [];
  const cypher = pred.cypher ?? '';
  const route = pred.route === example.expectedRoute ? 1 : 0;
  if (!route) feedback.push(`route mismatch: expected ${example.expectedRoute}, got ${pred.route ?? 'none'}`);

  let validity = 0;
  let safety = 0;
  let execution = pred.executionOk === false ? 0 : 1;
  const routedDependencyWithoutCypher = example.expectedRoute === 'dependency' && pred.route === 'dependency' && !cypher;
  if (example.expectedRoute === 'grep_recommended' || example.expectedRoute === 'semantic' || routedDependencyWithoutCypher) {
    validity = pred.error ? 0 : 1;
    safety = 1;
  } else if (cypher.toUpperCase().includes('MATCH')) {
    validity = 1;
    try {
      validateCypherReadOnly(cypher);
      safety = 1;
    } catch (err) {
      feedback.push(`safety validation failed: ${(err as Error).message}`);
    }
  } else {
    feedback.push('cypher missing MATCH');
  }

  const scoped = cypher ? applyProjectScopeToCypher(cypher, example.projectName) : '';
  const projectScope = example.expectedRoute === 'grep_recommended' || example.expectedRoute === 'semantic' || routedDependencyWithoutCypher
    ? 1
    : (scoped.includes('$project') || scoped.includes('.project')) ? 1 : 0;
  if (!projectScope) feedback.push('missing project scope');

  const shape = routedDependencyWithoutCypher || (includesAll(cypher, example.mustContain) && excludesAll(cypher, example.mustNotContain)) ? 1 : 0;
  if (!shape) feedback.push('missing required tokens or contains forbidden tokens');

  if (pred.executionOk === false) feedback.push(`execution failed: ${pred.executionError ?? 'unknown error'}`);

  const total = 0.20 * route + 0.20 * validity + 0.20 * safety + 0.20 * execution + 0.10 * projectScope + 0.10 * shape;
  if (feedback.length === 0) feedback.push('ok');

  return { id: example.id, total, validity, safety, execution, projectScope, shape, route, feedback };
}

export function summarizeScores(scores: CypherEvalScore[]) {
  const avg = (key: keyof CypherEvalScore) => scores.reduce((sum, s) => sum + (typeof s[key] === 'number' ? s[key] as number : 0), 0) / Math.max(1, scores.length);
  return {
    count: scores.length,
    total: avg('total'),
    validity: avg('validity'),
    safety: avg('safety'),
    execution: avg('execution'),
    projectScope: avg('projectScope'),
    shape: avg('shape'),
    route: avg('route'),
  };
}
