# Ax Runtime Roadmap for pi-code-graph

Ax (`@ax-llm/ax`) is a TypeScript-native DSPy-style framework. For pi-code-graph, the goal is not only prompt optimization; it is to make query understanding a typed LLM program with deterministic safety rails around graph execution.

## Goals

1. Improve natural-language → Cypher reliability.
2. Route questions to the right tool path: graph query, dependency analysis, semantic search, exact text, or grep recommendation.
3. Keep read-only database safety deterministic and non-negotiable.
4. Preserve existing provider/auth behavior through Pi's `modelRegistry`.
5. Make Ax opt-in first, then consider making it the default after benchmark wins.

## Non-goals

- Do not let an unconstrained Ax agent execute arbitrary tools/Cypher.
- Do not run GEPA/ACE optimization during normal user queries.
- Do not log API keys, OAuth tokens, or provider headers.
- Do not remove the existing `CypherGenerator` until Ax has regression coverage and benchmark wins.

## Ax provider model

Use a **custom Ax AI service/provider**, not Ax's built-in provider wrappers, as the primary runtime path. This mirrors pi-para's DSPy GEPA setup, where custom `BaseLM` subclasses bypass litellm so Pi OAuth headers, Claude Code billing headers, token refresh, and provider quirks stay under our control.

Why custom instead of built-in Ax providers:

- Pi already has a provider/auth abstraction via `ctx.modelRegistry` and `src/auth.ts`.
- Anthropic OAuth and Claude Code billing require specific headers/token-refresh behavior.
- Existing pi-code-graph `LLMClient` implementations already handle OpenRouter/OpenAI-compatible, Anthropic, Google, and Ollama request shapes.
- A custom Ax provider avoids a second provider registry and avoids subtle auth drift between Pi, legacy Cypher generation, and Ax generation.

Target shape:

```ts
import type {
  AxAIService,
  AxChatRequest,
  AxChatResponse,
  AxAIServiceOptions,
  AxModelConfig,
} from '@ax-llm/ax';

export class PiAxAIService implements AxAIService<string, string, string> {
  constructor(private readonly client: LLMClient, private readonly config: LLMConfig) {}

  getId() { return `pi-code-graph:${this.config.provider}:${this.config.model}`; }
  getName() { return 'Pi Code Graph LLM'; }

  async chat(req: Readonly<AxChatRequest<string>>, options?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> {
    const messages = convertAxPromptToChatMessages(req.chatPrompt);
    const response = await this.client.chat(messages);
    return {
      results: [{ index: 0, content: response.content, finishReason: 'stop' }],
      modelUsage: response.usage ? {
        ai: 'pi-code-graph',
        model: response.model,
        tokens: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        },
      } : undefined,
    };
  }

  // Other AxAIService methods: features, metrics, model list, options, cost, embed fallback.
}
```

Provider/auth flow:

1. Resolve provider/model/API key/headers through Pi `modelRegistry` or `~/.cgs/config.toml` using the existing `LLMConfig` path.
2. Build the existing concrete `LLMClient` (`OpenAIClient`, `AnthropicClient`, `GoogleClient`, `OllamaClient`, etc.).
3. Wrap that client in `PiAxAIService`.
4. Pass `PiAxAIService` to Ax programs (`ax(...).forward(piAxAI, input)`).

Do not use Ax built-in provider wrappers (`ai({ name: 'openrouter' })`, etc.) for pi-code-graph runtime or evals. All Ax programs must run through `PiAxAIService` so provider behavior, auth, headers, token refresh, logging, and failure semantics match the extension runtime.

## Target runtime architecture

```txt
User question
  ↓
AxQueryRouter
  route: graph | dependency | semantic | exact_text | grep_recommended | unsupported
  confidence
  reason
  ↓
Route execution
  graph       → AxCypherGenerator → validators → Memgraph
  dependency  → analyze_code_dependencies
  semantic    → semantic_code_search
  exact_text   → generated Comment/Literal/Builtin Cypher → validators → Memgraph
  grep_recommended → honest response recommending ripgrep for exhaustive text
  ↓
AxResultSummarizer (optional)
  concise answer + caveats + truncation note
```

Deterministic safeguards stay outside Ax:

- `validateCypherReadOnly()`
- scalar `IN`/`ANY` misuse validation
- project-scope injection via `applyProjectScopeToCypher()`
- result caps/truncation metadata
- no raw arbitrary Cypher agent tool

## Phase 0 — Baseline and fixture set

Deliverables:

- `evals/ax-cypher/dataset.ts`
- `evals/ax-cypher/run-baseline.ts`
- fixture queries covering:
  - direct callers
  - transitive callers
  - interface/object-literal implementations
  - comments/TODOs
  - string literals
  - builtins (`console.log`, `JSON.parse`, etc.)
  - path filters
  - ambiguous names
  - scalar/list operator traps
  - cross-project leakage traps

Metrics:

- valid read-only Cypher
- contains project scope or is safely scope-injected
- executes without Memgraph error
- expected row overlap
- no `RETURN n` whole-node output
- uses correct labels/properties
- obeys LIMIT/result-cap conventions

Exit criteria:

- Current legacy generator has a recorded baseline score.
- Benchmark data is checked in without secrets.

## Phase 1 — Add custom Ax provider bridge

Deliverables:

- Add `@ax-llm/ax` dependency.
- Add `src/lib/ax/pi-ax-ai-service.ts`.
- Add `createPiAxAIService(config: LLMConfig): PiAxAIService`.
- Reuse existing pi-code-graph provider clients instead of Ax built-in provider wrappers.
- Do not implement fallback to Ax built-in providers. If `PiAxAIService` cannot be constructed, Ax mode is unavailable and the caller should report that clearly or use the explicitly configured legacy engine.
- Add prompt conversion helpers:
  - Ax `system`/`user`/`assistant` prompt parts → existing `ChatMessage[]`.
  - Ax function-result/tool content should initially be rejected or degraded because v1 Ax Cypher programs do not need tool calling.
  - Multimodal/file/url content should initially throw a clear unsupported error for query generation.
- Add usage/metrics mapping from `LLMResponse.usage` to Ax `modelUsage`.

Exit criteria:

- Unit tests prove Ax chat requests are converted to existing `LLMClient.chat()` calls.
- Unit tests cover Anthropic OAuth/custom-header config without exposing secrets.
- No API key/header values appear in logs or snapshots.
- Legacy generator remains default.

## Phase 2 — Ax query router

Deliverables:

- `src/lib/ax/query-router.ts`
- Ax signature:

```ts
const routeQuery = ax(`
  question:string,
  availableTools:string,
  graphSchema:string ->
  route:class "graph, dependency, semantic, exact_text, grep_recommended, unsupported",
  confidence:number,
  reason:string
`);
```

Routing rules:

- call graph / implements / imports / structure → `graph`
- blast radius / callers/callees of known symbol → `dependency`
- fuzzy concept search → `semantic`
- comments/literals/builtins/exact tokens → `exact_text`
- exhaustive docs/package-lock/raw text request → `grep_recommended`

Exit criteria:

- Router beats simple keyword routing on the eval set.
- Low-confidence routes fall back to legacy behavior or ask for clarification.

## Phase 3 — Ax Cypher generator

Deliverables:

- `src/lib/ax/cypher-generator.ts`
- Implement same interface as existing `CypherGenerator` where practical.
- Ax signature:

```ts
const generateCypher = ax(`
  question:string,
  route:string,
  graphSchema:string,
  relationshipSchema:string,
  projectName:string,
  cypherRules:string ->
  cypher:string,
  confidence:number,
  resultShape:string,
  caveats:string[]
`);
```

Post-processing:

1. strip code fences;
2. validate read-only;
3. validate no scalar `IN`/`ANY` misuse;
4. apply project scope;
5. enforce/append LIMIT where needed.

Exit criteria:

- Ax generator executes cleanly on baseline eval set.
- No decrease in safety validations.
- Legacy generator can still be selected.

## Phase 4 — Ax repair loop

Deliverables:

- `src/lib/ax/cypher-repair.ts`
- Trigger only after validator or Memgraph read-query failure.
- Ax signature:

```ts
const repairCypher = ax(`
  question:string,
  invalidCypher:string,
  error:string,
  graphSchema:string,
  cypherRules:string ->
  repairedCypher:string,
  explanation:string
`);
```

Limits:

- Max 1–2 repair attempts.
- Never repair a mutation into execution without re-validating.

Exit criteria:

- Scalar/list and syntax failures recover in evals.
- No repair path bypasses validators.

## Phase 5 — Runtime integration and settings

Deliverables:

- Extend settings:

```toml
[query]
engine = "legacy" # legacy | ax
ax_router = true
ax_repair = true
ax_max_repair_attempts = 1
```

- CLI/config UI support.
- Tool output should expose `engine: 'ax'`, `route`, `confidence`, and `repair_attempted` in details.
- Initial routing integration: when `engine = "ax"` and `ax_router = true`, `query_code_graph` uses `AxQueryRouter` to route `semantic` questions to semantic search, `dependency` questions to dependency analysis when a target symbol is extracted, return honest `grep_recommended`/`unsupported` responses, and send `graph`/`exact_text` routes through the Ax Cypher generator.

Exit criteria:

- `engine=legacy` behavior unchanged.
- `engine=ax` works in Pi with OpenRouter and at least one direct provider.
- If Ax provider cannot be constructed, Ax mode reports unavailable. There is no fallback to Ax built-in providers; legacy is used only when explicitly configured.

## Phase 6 — Ax GEPA/ACE optimization

Deliverables:

- `evals/ax-cypher/optimize-gepa.ts`
- `evals/ax-cypher/optimized/` artifacts.
- Use AxGEPA with train/validation split.

Metric should return multiple objective scores:

```ts
{
  validity: 0 | 1,
  execution: 0 | 1,
  projectScope: 0 | 1,
  expectedRows: 0..1,
  shape: 0..1,
  safety: 0 | 1
}
```

Exit criteria:

- Optimized Ax program beats unoptimized Ax and legacy baseline on validation set.
- Optimized prompt/config can be loaded without running GEPA at user query time.

## Phase 7 — Default decision

Promote Ax from opt-in to default only if:

- eval score improves materially;
- latency/cost are acceptable;
- OpenRouter/OpenAI/Anthropic/Gemini/Ollama provider paths work through `PiAxAIService`;
- OAuth/custom-header cases work through the existing pi-code-graph clients or reliably fall back;
- docs clearly describe safety model and fallback behavior.

## Testing plan

Required per phase:

```bash
npx tsc --noEmit
npx vitest run
```

Additional Ax eval commands once added:

```bash
npm run eval:ax-cypher
npm run optimize:ax-cypher
```

Regression cases to preserve:

- `ANY/IN expected a list, got string` never reaches user as raw Memgraph error.
- Generated queries are project-scoped.
- Result truncation is visible.
- Exact text questions do not get overclaimed semantic answers.
- Clean index still produces complete call edges on large repos.

## Open questions

- Should Ax be a normal dependency or optional peer dependency?
- How should optimized prompt artifacts be versioned and migrated?
- Should `PiAxAIService` live entirely in pi-code-graph, or should a reusable Pi→Ax adapter be extracted later for pi-para/other extensions?
- Should exact text routing recommend external `rg`, or should pi-code-graph add a dedicated grep tool integration?
