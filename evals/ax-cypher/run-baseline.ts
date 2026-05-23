import { CYPHER_EVAL_DATASET } from './dataset.js';
import { scoreCypherPrediction, summarizeScores } from './metrics.js';
import { createCypherGenerator, type LLMConfig } from '../../src/lib/llm-service.js';
import { executeEvalCypher, maybeCreateEvalGraph } from './execute.js';

if (process.argv.includes('--help')) {
  console.log(`Usage: npm run eval:ax-cypher:legacy

Environment:
  CGR_EVAL_PROVIDER=openrouter|openai|anthropic|google|ollama
  CGR_EVAL_MODEL=<model>
  CGR_EVAL_API_KEY=<key>
  CGR_EVAL_ENDPOINT=<optional endpoint>
  CGR_EVAL_EXECUTE=true # optionally execute generated Cypher against Memgraph
`);
  process.exit(0);
}

const provider = (process.env.CGR_EVAL_PROVIDER ?? 'ollama') as LLMConfig['provider'];
const generator = createCypherGenerator({
  provider,
  model: process.env.CGR_EVAL_MODEL || (provider === 'ollama' ? 'llama3.2' : undefined),
  apiKey: process.env.CGR_EVAL_API_KEY,
  endpoint: process.env.CGR_EVAL_ENDPOINT,
  temperature: 0,
});
const scores = [];
const graph = await maybeCreateEvalGraph();

for (const example of CYPHER_EVAL_DATASET) {
  let cypher = '';
  let error = '';
  try {
    if (example.expectedRoute !== 'grep_recommended' && example.expectedRoute !== 'semantic') {
      cypher = await generator.generate(example.question, example.projectName);
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const execution = await executeEvalCypher(graph, cypher, example.projectName);
  const score = scoreCypherPrediction(example, {
    route: 'graph',
    cypher,
    error,
    executionOk: execution.ok,
    executionError: execution.error,
  });
  scores.push(score);
  console.log(JSON.stringify({ id: example.id, score, cypher, error, execution }, null, 2));
}

await graph?.close();
console.log(JSON.stringify({ summary: summarizeScores(scores) }, null, 2));
