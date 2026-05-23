import { ax } from '@ax-llm/ax';
import { LLMGenerationError, buildGraphSchemaAndRules } from '../llm-service.js';
import type { PiAxAIService } from './pi-ax-ai-service.js';

export type AxQueryRoute = 'graph' | 'dependency' | 'semantic' | 'exact_text' | 'grep_recommended' | 'unsupported';

export interface AxQueryRoutingDecision {
  route: AxQueryRoute;
  confidence: number;
  reason: string;
  targetSymbol?: string;
  direction?: 'dependents' | 'dependencies' | 'both';
  depth?: number;
}

const VALID_ROUTES = new Set<AxQueryRoute>([
  'graph',
  'dependency',
  'semantic',
  'exact_text',
  'grep_recommended',
  'unsupported',
]);

const routeQueryProgram = ax(`
  question:string,
  availableTools:string,
  graphSchemaAndRules:string ->
  route:class "graph, dependency, semantic, exact_text, grep_recommended, unsupported",
  confidence:number "0 to 1 confidence",
  reason:string "Short reason for the route",
  targetSymbol:string "For dependency/caller/callee questions, the best symbol name such as AuthStorage.login or AuthStorage.getApiKey. Empty string if not applicable.",
  direction:class "dependents, dependencies, both" "dependents for who-calls-this, dependencies for what-this-calls, both for impact/blast-radius/general dependency questions",
  depth:number "Traversal depth for dependency questions, usually 1, max 3"
`);

interface AxRouteOut {
  route: string;
  confidence?: number;
  reason?: string;
  targetSymbol?: string;
  direction?: string;
  depth?: number;
}

export class AxQueryRouter {
  private readonly graphSchemaAndRules = buildGraphSchemaAndRules();
  private readonly availableTools = [
    'query_code_graph: structural graph/Cypher questions',
    'analyze_code_dependencies: callers/callees/blast radius for known symbols',
    'semantic_code_search: fuzzy concept search by meaning',
    'exact_text: Comment/Literal/Builtin graph nodes for exact code text patterns',
    'grep_recommended: exhaustive raw text/docs/package-lock search is better handled by ripgrep',
  ].join('\n');

  constructor(private readonly ai: PiAxAIService) {}

  async route(question: string): Promise<AxQueryRoutingDecision> {
    const result = await routeQueryProgram.forward(this.ai, {
      question,
      availableTools: this.availableTools,
      graphSchemaAndRules: this.graphSchemaAndRules,
    }) as AxRouteOut;

    const route = result.route as AxQueryRoute;
    if (!VALID_ROUTES.has(route)) {
      throw new LLMGenerationError(`Ax router returned invalid route: ${result.route}`);
    }

    const direction = result.direction === 'dependencies' || result.direction === 'both'
      ? result.direction
      : 'dependents';
    const depth = typeof result.depth === 'number' && Number.isFinite(result.depth)
      ? Math.max(1, Math.min(3, Math.round(result.depth)))
      : 1;

    return {
      route,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0,
      reason: result.reason || '',
      targetSymbol: result.targetSymbol || undefined,
      direction,
      depth,
    };
  }
}
