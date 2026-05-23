import { CYPHER_EVAL_DATASET } from './dataset.js';
import { scoreCypherPrediction, summarizeScores } from './metrics.js';
import { createAxCypherGenerator } from '../../src/lib/ax/cypher-generator.js';
import { createLLMClient, type LLMConfig } from '../../src/lib/llm-service.js';
import { PiAxAIService } from '../../src/lib/ax/pi-ax-ai-service.js';
import { AxQueryRouter } from '../../src/lib/ax/query-router.js';
import { executeEvalCypher, maybeCreateEvalGraph } from './execute.js';

if (process.argv.includes('--help')) {
  console.log(`Usage: npm run eval:ax-cypher

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
const config: LLMConfig = {
  provider,
  model: process.env.CGR_EVAL_MODEL || (provider === 'ollama' ? 'llama3.2' : 'anthropic/claude-3.5-sonnet'),
  apiKey: process.env.CGR_EVAL_API_KEY,
  endpoint: process.env.CGR_EVAL_ENDPOINT,
  temperature: 0,
  maxTokens: 2048,
};

const ai = new PiAxAIService(config, createLLMClient(config));
const router = new AxQueryRouter(ai);
const generator = createAxCypherGenerator({ ...config, ai, maxRepairAttempts: 1 });
const scores = [];
const graph = await maybeCreateEvalGraph();

for (const example of CYPHER_EVAL_DATASET) {
  let route: string | undefined;
  let cypher = '';
  let error = '';
  try {
    const routing = await router.route(example.question);
    route = routing.route;
    if (routing.route !== 'grep_recommended' && routing.route !== 'semantic' && routing.route !== 'unsupported' && routing.route !== 'dependency') {
      cypher = await generator.generate(example.question, example.projectName);
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const execution = await executeEvalCypher(graph, cypher, example.projectName);
  const score = scoreCypherPrediction(example, {
    route,
    cypher,
    error,
    executionOk: execution.ok,
    executionError: execution.error,
  });
  scores.push(score);
  console.log(JSON.stringify({ id: example.id, route, score, metadata: generator.getLastGenerationMetadata(), cypher, error, execution }, null, 2));
}

await graph?.close();
console.log(JSON.stringify({ summary: summarizeScores(scores) }, null, 2));
