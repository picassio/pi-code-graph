# Ax Cypher Eval Results

Date: 2026-05-23
Branch: `feature/ax-runtime-provider`
Commit: `acf1481` plus local eval-harness updates before amend
Repo/index used for execution checks: `pi-mono` in local Memgraph
Provider for both runs: OpenRouter model `anthropic/claude-opus-4-6`

No API keys or provider secrets are stored in this report.

## Command shape

```bash
CGR_EVAL_EXECUTE=true \
CGR_EVAL_PROVIDER=openrouter \
CGR_EVAL_MODEL=anthropic/claude-opus-4-6 \
CGR_EVAL_API_KEY=<redacted> \
npm run eval:ax-cypher:legacy

CGR_EVAL_EXECUTE=true \
CGR_EVAL_PROVIDER=openrouter \
CGR_EVAL_MODEL=anthropic/claude-opus-4-6 \
CGR_EVAL_API_KEY=<redacted> \
npm run eval:ax-cypher
```

## Summary

| Engine | Total | Route | Validity | Safety | Execution | Project scope | Shape |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy | 0.825 | 0.250 | 1.000 | 1.000 | 0.875 | 1.000 | 1.000 |
| Ax router + Ax generator | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

## Per-case notes

| Case | Expected route | Legacy | Ax |
|---|---|---|---|
| direct callers of `AuthStorage.login` | dependency | Routed as graph and generated a Cypher syntax error during execution. | Routed to dependency; no Cypher generation needed. |
| `OAuthProviderInterface` implementations | graph | Valid/executed. | Valid/executed. |
| transitive callers of `AuthStorage.getApiKey` | dependency | Routed as graph; query executed but route was wrong. | Routed to dependency; no Cypher generation needed. |
| `console.log` builtins | exact_text | Routed as graph; query executed but route was wrong. | Routed exact_text; generated/executed. |
| `OPENROUTER_API_KEY` literals | exact_text | Routed as graph; query executed but route was wrong. | Routed exact_text; generated/executed. |
| exhaustive docs/package-lock text search | grep_recommended | Routed as graph. | Routed grep_recommended; no Cypher generation. |
| OAuth token refresh concept | semantic | Routed as graph. | Routed semantic; no Cypher generation. |
| methods whose name contains create | graph | Valid/executed. | Valid/executed. |

## Ripgrep comparison

A matching ripgrep pass was run with hand-picked patterns for the same eight prompts:

```bash
npm run eval:ax-cypher:rg
```

Summary:

| Tool | Wall time for 8 prompts | Total matches/rows | What it optimizes for |
|---|---:|---:|---|
| ripgrep | ~140 ms | 3,067 text matches | Exhaustive exact text search |
| Ax router + graph tools | ~65 s | route/tool-specific | Intent routing, graph/dependency/semantic answers |

Per-case ripgrep counts:

| Case | rg pattern shape | rg matches | rg result quality |
|---|---|---:|---|
| direct callers of `AuthStorage.login` | `authStorage\.login\(` | 1 | Excellent if the receiver variable is known; no alias/enclosing-function reasoning. |
| `OAuthProviderInterface` implementations | `: OAuthProviderInterface = \{` | 6 | Excellent exact-pattern result once the TS object-literal shape is known. |
| transitive callers of `AuthStorage.getApiKey` | `getApiKey\(` | 57 | Finds raw direct text occurrences; does not compute transitive call chains. |
| `console.log` builtins | `console\.log` | 637 | Best for exhaustive text hits. |
| `OPENROUTER_API_KEY` literals | `OPENROUTER_API_KEY` | 30 | Finds docs/scripts/tests too; not restricted to code literal nodes. |
| docs/package-lock text search | `@mariozechner/pi-coding-agent` | 297 | Clear rg win; this is not a graph problem. |
| OAuth token refresh concept | guessed refresh-token regex | 90 | Good only after a human guesses vocabulary; not semantic/ranked by function. |
| methods whose name contains create | broad create-call regex | 1,949 | Fast but very noisy and not AST-aware. |

## Interpretation

The main Ax win in this eval is routing, not raw Cypher syntax. Legacy generation can produce usable Cypher for many graph-shaped questions, but it lacks route awareness and sometimes attempts graph queries where semantic search, dependency analysis, or ripgrep recommendation is a better product behavior.

Against ripgrep, the conclusion is intentionally mixed:

- **ripgrep wins hard on speed and exhaustive text recall**: 8 searches in ~140 ms versus an LLM-routed Ax eval in ~65 s.
- **Ax/code-graph wins on product behavior for structural or fuzzy questions**: it can route caller/dependency questions to graph tools, concept questions to semantic search, and raw text questions back to ripgrep instead of pretending the graph is always best.
- The practical goal is not to replace `rg`; it is to decide when `rg` is the right answer and when graph/semantic/dependency tooling is worth the extra latency.

This validates the Phase 5 design: keep deterministic validators and graph execution, but let Ax classify the user intent before choosing the execution path.

## Caveats

- This is a small fixture set, not a final benchmark.
- Execution score currently checks whether generated Cypher executes, not semantic correctness of returned rows.
- Dependency and semantic routes are scored as successful route decisions; full end-to-end quality should be tested in Pi tool smoke tests.
