# code-graph vs grep/ripgrep — Benchmark Report

Repo: `pi-mono` (indexed fresh via `index_repository` before tests)
Tools compared:
- **grep**: `ripgrep` (`rg`) on the working tree
- **code-graph**: `query_code_graph`, `analyze_code_dependencies`, `semantic_code_search`, `get_code_from_graph` (Memgraph-backed)

---

## TEST 1 — Direct callers of `AuthStorage.login`

**grep** (`rg "\.login\("`)
- Time: ~15ms
- Found 3 matches:
  - `packages/ai/src/cli.ts:39` — `provider.login(...)` — **false positive** (different `login`, on OAuth provider)
  - `packages/coding-agent/src/core/auth-storage.ts:354` — `provider.login(callbacks)` — **false positive** (inside `AuthStorage.login` itself, calls provider's login)
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3911` — `authStorage.login(...)` — true positive
- Precision 1/3, recall 1/1.

**code-graph** (`analyze_code_dependencies`, direction=dependents)
- Time: ~1s total (two calls — first attempt with bare `AuthStorage.login` returned nothing; had to resolve fully qualified name via `query_code_graph` first)
- Found 1 result:
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts:InteractiveMode.showLoginDialog` — true positive, with **enclosing function** identified
- Precision 1/1, recall 1/1.

**Winner: code-graph.** grep was instant but noisy (67% false positives from method-name collisions). code-graph was precise and gave the calling function rather than just a line. UX wart: bare `Class.method` should resolve without forcing the full file-prefixed qualified name.

---

## TEST 2 (revised) — Implementations of `OAuthProvider` in pi-mono

**grep** (`rg "implements OAuthProvider\b"`)
- Time: ~14ms
- Found 0 matches.

**code-graph** (`query_code_graph` for classes implementing `OAuthProvider`)
- Time: ~instant
- Found 0 results.

**Reality check:** pi-mono has **no class** that uses `implements OAuthProvider`. The actual interface is `OAuthProviderInterface`, and the pattern is object literals annotated by interface type:

```ts
export const anthropicOAuthProvider: OAuthProviderInterface = { ... }
```

A follow-up `rg ": OAuthProviderInterface = \{"` finds 5 real implementations: `anthropic.ts`, `google-antigravity.ts`, `openai-codex.ts`, `google-gemini-cli.ts`, `github-copilot.ts`, plus an inline one at `model-registry.ts:697`.

**Winner: tie (both failed).** Both correctly reported 0 for the literal question asked, but neither surfaced the *real* implementations.
- grep: failed because the query used the wrong interface name and the wrong pattern; with `rg ": OAuthProviderInterface = \{"` it finds them all in <20ms.
- code-graph: would still miss them even with the right interface name — it models class `implements`/`extends` edges but **does not model "object literal annotated with interface type" as an implementation relationship**. This is a structural blind spot for TypeScript codebases that prefer object literals over classes.

---

## TEST 3 — Transitive callers of `AuthStorage.getApiKey` (depth 3)

**grep** (`rg "authStorage\.getApiKey"`)
- Time: ~13ms
- Found 28 lines across 4 files:
  - `packages/mom/src/agent.ts:46` — production caller in another package
  - `packages/coding-agent/src/core/model-registry.ts:582, 624` — production callers
  - 25 lines in `packages/coding-agent/test/auth-storage.test.ts` — test callers
- Limitation: depth-1 only; transitive trace requires manual recursive grepping per new caller.

**code-graph** (`analyze_code_dependencies`, direction=dependents, depth=3)
- Time: ~instant (single call)
- Found **only 2 dependents at depth 1**:
  - `ModelRegistry.getApiKeyAndHeaders`
  - `ModelRegistry.getApiKeyForProvider`
- **No depth-2 or depth-3 results** were returned, despite `depth=3`.
- Missed: `mom/src/agent.ts:46` cross-package call, and **all 25 test-file call sites**.

**Winner: grep.** code-graph's headline feature (transitive call chains) did not materialize here. It returned a partial depth-1 answer and silently dropped the deeper levels. grep was complete at depth 1 with zero false positives on this name.

Likely causes for code-graph misses:
1. Test files appear to be excluded (or under-linked) from the dependents graph.
2. The cross-package `mom` call site uses a differently-bound `authStorage` symbol that the resolver didn't link.
3. The `depth` parameter did not actually expand traversal — either a bug or the immediate dependents' outgoing edges aren't in the graph.

---

## TEST 4 — Find OAuth token refresh logic (concept search)

**grep** (`rg -l "refreshToken|refresh_token|refreshAccessToken"`)
- Time: ~14ms
- Found 15 files (file-list mode), all relevant: `oauth/anthropic.ts`, `oauth/index.ts`, all 5 provider files, copilot/codex tests, custom-provider extensions.
- Returns *files*, not specific functions — needs a follow-up grep inside each file to find the actual refresh entry points.
- Recall depends entirely on guessing the right substring. If a file used `renewSession` or `rotateCredentials`, grep would miss it.

**code-graph** (`semantic_code_search "refresh OAuth tokens"`, top_k=10)
- Time: ~instant
- Found 10 ranked **functions** (not files), all directly relevant:
  - `refreshOAuthToken` (the dispatcher in `oauth/index.ts`) — the single best entry point a human would want
  - `refreshAnthropicToken`, `refreshOpenAICodexToken`, `refreshAccessToken`, `refreshQwenToken`
  - `refreshToken` in anthropic / github-copilot / openai-codex
  - `isOAuthToken`
- Scores cluster ~46–51% absolute (low but consistently ranked); all hits on-topic.

**Winner: code-graph (semantic search).** This is the test where code-graph is most clearly superior. grep returned a bag of files and required prior knowledge of the vocabulary; semantic search returned a ranked list of functions immediately readable via `get_code_from_graph`. For exploratory "where is X handled?" on an unfamiliar codebase or for fuzzy concepts ("retry logic", "rate limiting", "credential rotation"), semantic search is dramatically faster to a useful answer. grep still wins when you already know exact naming conventions and want guaranteed recall.

---

## Summary table

| Test | Question | Winner | Why |
|---|---|---|---|
| 1 | Direct callers of `AuthStorage.login` | **code-graph** | grep had 67% false positives from method-name collisions; code-graph was precise and gave enclosing function |
| 2 | Implementations of `OAuthProvider` interface | **tie (both failed)** | code-graph doesn't model `const x: Interface = {}`; grep needed the right pattern/name |
| 3 | Transitive callers of `AuthStorage.getApiKey` | **grep** | code-graph found only 2/5+ direct callers; depth>1 returned nothing; tests and cross-package calls missed |
| 4 | OAuth refresh logic (concept search) | **code-graph** | semantic search returned ranked functions; grep returned files and required vocabulary |

### When to use which

**Use code-graph for:**
- Precise caller analysis on collision-prone method names
- Semantic / concept search on unfamiliar code
- Getting enclosing-function context instead of raw line numbers

**Use grep for:**
- Exhaustive recall when you know the pattern
- Transitive traces (until code-graph's depth>1 is fixed)
- Object-literal / non-class TypeScript patterns
- Anything in test files
- When you need guaranteed determinism

---

## Bugs and gaps surfaced in pi-code-graph

1. **`analyze_code_dependencies` requires file-prefixed qualified name.** Bare `ClassName.method` silently returns "No dependency information found" instead of resolving the symbol. Should accept the same forms `query_code_graph` returns.
2. **`depth` parameter not expanding past depth 1.** TEST 3 with `depth=3` returned only depth-1 dependents and no transitive callers, even though those depth-1 callers clearly have their own callers in the codebase.
3. **Test files appear to be excluded (or severely under-linked) from the dependents graph.** TEST 3 missed all 25 test-file call sites of `AuthStorage.getApiKey`.
4. **Cross-package call sites missed.** TEST 3 missed `packages/mom/src/agent.ts:46` calling `authStorage.getApiKey("anthropic")` from a different package than the definition.
5. **Object literals typed by an interface are not modeled as implementations.** TEST 2: a `const x: SomeInterface = { ... }` does not show up as an implementer of `SomeInterface`. This is a major blind spot for idiomatic TypeScript that prefers object literals over classes.

All five gaps are reproducible against the pi-mono index built immediately before the tests were run.

---

# v0.15.0 retest — after grep-vs-graph follow-up fixes

Repo: `pi-mono`
Index: clean full re-index after `v0.15.0`, embeddings disabled for structural benchmark
Index time: ~53.5s for 852 eligible files
Validation: `npx tsc --noEmit`; `npx vitest run` → 344 passing tests

Important retest discoveries fixed before the final numbers below:
- Clean full indexes on large repos were missing some `CALLS` edges because pass 3 depended on the bounded AST cache. `GraphUpdater` now tracks all processed code files and re-parses evicted ASTs for call extraction.
- Upgraded Memgraph instances need constraints/indexes for new labels (`Comment`, `Literal`, `Builtin`). `GraphUpdater` now ensures constraints at run start.
- Fire-and-forget auto-flush from synchronous batch methods could race with ongoing parsing. Batch methods now require caller-managed awaited flushes.

## Retest summary

| Test | grep / ripgrep | code-graph | Winner | Notes |
|---|---:|---:|---|---|
| Direct callers of `AuthStorage.login` | 3 line matches, ~17ms | 1 true caller, ~66ms | **code-graph for precision; grep for speed** | grep still returns 2 method-name collisions; graph returns enclosing caller `InteractiveMode.showLoginDialog`. |
| `OAuthProviderInterface` object-literal implementations | 6 matches, ~16ms | 6 implementers, ~58ms | **tie** | Previous graph blind spot is fixed; graph now models `const x: Interface = {}` implementations. |
| Transitive callers of `AuthStorage.getApiKey` depth ≤ 3 | 28 line matches, ~15ms | 19 graph callers, ~65ms | **mixed** | Graph now includes cross-package and transitive callers; grep still has more raw test-file line occurrences. Counts are not one-to-one because graph dedupes by enclosing function/module. |
| TODO/FIXME/comment search | 192 text matches, ~17ms | 15 comment-node matches, ~42ms | **grep** | Graph now sees comments, but grep is still the correct exhaustive text-search tool and also searches docs/strings. |
| `console.log` builtin calls | 754 text matches, ~18ms | 200 returned of many builtin nodes, ~35ms | **grep for exhaustive text; graph for structured builtin nodes** | Graph output is capped/truncated visibly instead of silently. |
| `OPENROUTER_API_KEY` string literal | 30 text matches, ~16ms | 3 literal nodes, ~68ms | **grep** | Graph intentionally indexes code literals, not every docs/package-lock occurrence. |

## Updated conclusion

The fixes materially improve code-graph on structural questions:
- object-literal interface implementations are now first-class graph facts;
- large-repo full indexing no longer silently loses early-file call edges due AST-cache eviction;
- current-project scoping and truncation metadata make query results safer/honester;
- comments, literals, and builtins are visible in the graph after re-indexing.

The honest comparison remains:
- **Use grep/ripgrep** for exhaustive exact text search, comments, docs, package-lock hits, and fastest known-pattern scans.
- **Use code-graph** for structural relationships, call/dependency analysis, enclosing function context, cross-file/cross-package graph traversal, and semantic/concept search.
