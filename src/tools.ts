/**
 * Tool definitions for pi-code-graph
 * 
 * Provides MCP-compatible tools that directly use the ported TypeScript library
 * instead of invoking the CGR CLI subprocess.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { basename } from "node:path";

import { getServiceManager } from "./services.js";
import { getSettings } from "./settings.js";
import { formatResults, formatCodeSnippet, formatDependencies, formatProjectList } from "./formatters.js";
import type { ResultItem, CodeSnippetResult, DependencyResult } from "./types.js";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Ensure services are initialized for the given context
 */
async function ensureServices(ctx: ExtensionContext): Promise<void> {
	const manager = getServiceManager();
	
	if (!manager.isInitialized()) {
		const settings = getSettings();
		await manager.initialize({
			memgraphHost: settings.memgraphHost,
			memgraphPort: parseInt(settings.memgraphPort, 10),
			projectRoot: ctx.cwd,
			projectName: settings.projectName || basename(ctx.cwd),
		}, ctx);
	}
	// Note: don't auto-switch project context on cwd change.
	// The user should explicitly set projectName in config or use index_repository
	// to change the active project. This allows querying a project from any directory.
}

/**
 * Convert library result to extension result format
 */
function toResultItems(items: unknown[]): ResultItem[] {
	return items.map((item: unknown) => {
		const rec = item as Record<string, unknown>;

		// Find name: try common aliases the LLM might generate
		const name = (rec.name ?? rec.caller_name ?? rec.callee_name ?? rec.function_name ?? rec.method_name ?? rec.class_name) as string | undefined;

		// Find qualified name: try common aliases
		const qualified_name = (rec.qualifiedName ?? rec.qualified_name ?? rec.caller_qn ?? rec.callee_qn ?? rec.qn) as string | undefined;

		// Find path
		const path = (rec.path ?? rec.filePath ?? rec.file_path) as string | undefined;

		// Find type/labels
		const type = rec.type as string | undefined;
		let labels = rec.labels as string[] | undefined;
		if (!labels && (rec.caller_type || rec.callee_type)) {
			labels = (rec.caller_type ?? rec.callee_type) as string[] | undefined;
		}

		// Fallback: if nothing matched, use first string value from the record
		let fallbackName: string | undefined;
		if (!name && !qualified_name && !path) {
			for (const val of Object.values(rec)) {
				if (typeof val === 'string' && val.length > 0) {
					fallbackName = val;
					break;
				}
			}
		}

		return {
			name: name ?? fallbackName,
			qualified_name,
			path,
			type,
			labels,
			start_line: (rec.startLine ?? rec.start_line) as number | undefined,
			end_line: (rec.endLine ?? rec.end_line) as number | undefined,
			docstring: rec.docstring as string | undefined,
			source_code: (rec.sourceCode ?? rec.source_code) as string | undefined,
			file_path: path,
			score: rec.score as number | undefined,
		};
	});
}

// =============================================================================
// Query Tools
// =============================================================================

/**
 * Register all read-only query tools
 */
export function registerQueryTools(pi: ExtensionAPI): void {
	// ─────────────────────────────────────────────────────────────────────────────
	// Tool: Query Code Graph (Natural Language)
	// ─────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "query_code_graph",
		label: "Query Code Graph",
		description:
			"Query the codebase knowledge graph using natural language. " +
			"Ask questions about code structure, relationships, dependencies, and more. " +
			"Examples: 'What functions call UserService.create?', 'Show classes in the auth module', " +
			"'Find all API endpoints', 'What does the login flow look like?'. " +
			"Requires the codebase to be indexed in Memgraph.",
		promptSnippet: "Query codebase structure via knowledge graph (functions, classes, call graphs, dependencies)",
		promptGuidelines: [
			"Use query_code_graph FIRST when you need to understand code structure — who calls what, class hierarchies, module dependencies, imports, and call chains",
			"Prefer query_code_graph over grep/find for structural questions like 'what calls this function', 'what classes inherit from X', 'what does this module export'",
			"For finding code by what it does (semantic meaning), use semantic_code_search instead",
			"After query_code_graph returns qualified names, use get_code_from_graph to retrieve the actual source code",
			"Before using query tools, run index_repository first if you or the user have made code changes since the last index",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural language question about the codebase structure or relationships",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await ensureServices(ctx);
			const manager = getServiceManager();

			onUpdate?.({
				details: {},
				content: [{ type: "text", text: `Querying code graph: "${params.query}"...` }],
			});

			try {
				const tools = await manager.getToolCollection();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Query cancelled" }], details: {} };
				}
				
				const result = await tools.codebaseQuery.queryCodebaseKnowledgeGraph(params.query);
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Query cancelled" }], details: {} };
				}

				if (result.results && result.results.length > 0) {
					const items = toResultItems(result.results);
					return {
						content: [{ type: "text", text: formatResults(items, params.query) }],
						details: { 
							results: items, 
							query: params.query, 
							cypher_query: result.query_used,
							row_count: result.results.length,
						},
					};
				}

				// Return summary if no structured results
				const output = result.summary || "No results found";
				return {
					content: [{ type: "text", text: output }],
					details: { 
						query: params.query,
						cypher_query: result.query_used,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Code graph query failed: ${message}`);
			}
		},
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Tool: Get Code Snippet by Qualified Name
	// ─────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "get_code_from_graph",
		label: "Get Code from Graph",
		description:
			"Retrieve source code for a function, class, or method using its fully qualified name. " +
			"Use this after query_code_graph to get the actual source code of a specific item. " +
			"Example qualified names: 'myproject.services.user.UserService.create_user', " +
			"'myproject.utils.validate_email', 'myproject.models.User'",
		promptSnippet: "Get source code by qualified name from the code graph",
		parameters: Type.Object({
			qualified_name: Type.String({
				description: "Fully qualified name (e.g., 'project.module.ClassName.method_name')",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await ensureServices(ctx);
			const manager = getServiceManager();

			onUpdate?.({
				content: [{ type: "text", text: `Retrieving: ${params.qualified_name}...` }],
				details: {},
			});

			try {
				const tools = await manager.getToolCollection();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Retrieval cancelled" }], details: {} };
				}
				
				const result = await tools.codeRetriever.findCodeSnippet(params.qualified_name);
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Retrieval cancelled" }], details: {} };
				}

				if (result && result.source_code) {
					const snippet: CodeSnippetResult = {
						source_code: result.source_code,
						file_path: result.file_path,
						start_line: result.line_start,
						end_line: result.line_end,
						qualified_name: params.qualified_name,
						found: result.found,
					};
					
					return {
						content: [{ type: "text", text: formatCodeSnippet(snippet, params.qualified_name) }],
						details: {
							qualified_name: params.qualified_name,
							file_path: snippet.file_path,
							start_line: snippet.start_line,
							end_line: snippet.end_line,
							found: true,
						},
					};
				}

				return {
					content: [{ type: "text", text: `No source found for: ${params.qualified_name}` }],
					details: { qualified_name: params.qualified_name, found: false },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Failed to get code: ${message}`);
			}
		},
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Tool: Semantic Code Search
	// ─────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "semantic_code_search",
		label: "Semantic Code Search",
		description:
			"Search for code semantically using natural language description of functionality. " +
			"Unlike query_code_graph which searches structure (names, relationships), this finds code by meaning. " +
			"Examples: 'functions that validate user input', 'error handling for database connections', " +
			"'code that sends emails', 'authentication logic'",
		promptSnippet: "Search code by semantic meaning (what the code does, not its name)",
		promptGuidelines: [
			"Use semantic_code_search when you need to find code by what it does, not by its name — e.g., 'code that validates email addresses' or 'error handling logic'",
			"Prefer semantic_code_search over grep when you're unsure of naming conventions or want to find functionally similar code",
			"Before using query tools, run index_repository first if you or the user have made code changes since the last index",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural language description of the code functionality you're looking for",
			}),
			top_k: Type.Optional(
				Type.Number({
					description: "Maximum number of results (default: 5, max: 20)",
					minimum: 1,
					maximum: 20,
					default: 5,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await ensureServices(ctx);
			const manager = getServiceManager();
			const topK = params.top_k || 5;

			onUpdate?.({
				content: [{ type: "text", text: `Semantic search: "${params.query}"...` }],
				details: {},
			});

			try {
				const tools = await manager.getToolCollection();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Search cancelled" }], details: {} };
				}
				
				// Check if semantic search is available
				if (!tools.semanticSearch) {
					// Fall back to structured query if semantic search is not available
					const fallbackResult = await tools.codebaseQuery.queryCodebaseKnowledgeGraph(
						`Find functions or methods related to: ${params.query}. Return top ${topK} results.`
					);
					
					if (fallbackResult.results && fallbackResult.results.length > 0) {
						const items = toResultItems(fallbackResult.results);
						return {
							content: [{ type: "text", text: formatResults(items, params.query) }],
							details: { 
								results: items, 
								query: params.query, 
								top_k: topK,
								fallback: true,
								note: "Semantic search not available; using graph query fallback",
							},
						};
					}
					
					return {
						content: [{ type: "text", text: "Semantic search not available (no embedding service configured). No fallback results found." }],
						details: { query: params.query, top_k: topK, fallback: true },
					};
				}
				
				const searchResults = await tools.semanticSearch.search(params.query, topK);
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Search cancelled" }], details: {} };
				}

				if (searchResults && searchResults.length > 0) {
					const items = toResultItems(searchResults);
					return {
						content: [{ type: "text", text: formatResults(items, params.query) }],
						details: { results: items, query: params.query, top_k: topK },
					};
				}

				return {
					content: [{ type: "text", text: "No matching code found" }],
					details: { query: params.query, top_k: topK },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Semantic search failed: ${message}`);
			}
		},
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Tool: Analyze Dependencies
	// ─────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "analyze_code_dependencies",
		label: "Analyze Code Dependencies",
		description:
			"Analyze code dependencies for a module, class, or function. " +
			"Shows what depends on the target (dependents/callers) and what the target depends on (dependencies/callees). " +
			"Useful for understanding impact of changes and finding related code.",
		promptSnippet: "Analyze dependencies and call graph (what calls this, what this calls)",
		promptGuidelines: [
			"Use analyze_code_dependencies BEFORE refactoring or modifying a function/class to understand what code would break",
			"Check 'dependents' direction to find all callers that would be affected by a signature change",
			"Before using query tools, run index_repository first if you or the user have made code changes since the last index",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Module, class, or function to analyze (e.g., 'auth.UserService' or 'utils.validate')",
			}),
			direction: Type.Optional(
				StringEnum(["both", "dependents", "dependencies"] as const, {
					description: "Which to show: 'dependents' (callers), 'dependencies' (callees), or 'both' (default)",
					default: "both",
				}),
			),
			depth: Type.Optional(
				Type.Number({
					description: "How many levels deep to analyze (default: 1, max: 5)",
					minimum: 1,
					maximum: 5,
					default: 1,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await ensureServices(ctx);
			const manager = getServiceManager();
			const direction = params.direction || "both";
			const depth = params.depth || 1;

			onUpdate?.({
				content: [{ type: "text", text: `Analyzing dependencies for: ${params.target}...` }],
				details: {},
			});

			try {
				const tools = await manager.getToolCollection();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Analysis cancelled" }], details: {} };
				}
				
				const depAnalysisResult = await tools.dependencyAnalyzer.analyzeDependencies(params.target);
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Analysis cancelled" }], details: {} };
				}

				if (!depAnalysisResult) {
					return {
						content: [{ type: "text", text: `No dependency information found for: ${params.target}` }],
						details: { target: params.target, direction, depth },
					};
				}

				// Filter results based on direction
				const depResult: DependencyResult = {
					target: params.target,
				};
				
				if (direction === "dependents" || direction === "both") {
					if (depAnalysisResult.callers && depAnalysisResult.callers.length > 0) {
						depResult.dependents = toResultItems(depAnalysisResult.callers);
					}
				}
				
				if (direction === "dependencies" || direction === "both") {
					if (depAnalysisResult.callees && depAnalysisResult.callees.length > 0) {
						depResult.dependencies = toResultItems(depAnalysisResult.callees);
					}
				}

				return {
					content: [{ type: "text", text: formatDependencies(depResult, params.target) }],
					details: { 
						target: params.target, 
						direction, 
						depth,
						callers_count: depAnalysisResult.callers?.length || 0,
						callees_count: depAnalysisResult.callees?.length || 0,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Dependency analysis failed: ${message}`);
			}
		},
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Tool: List Projects
	// ─────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "list_graph_projects",
		label: "List Graph Projects",
		description: "List all projects currently indexed in the code graph database.",
		promptSnippet: "List all indexed projects in the code knowledge graph",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			await ensureServices(ctx);
			const manager = getServiceManager();

			try {
				const graphService = await manager.getMemgraphService();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: {} };
				}
				
				const projects = await graphService.listProjects();
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: {} };
				}

				if (projects && projects.length > 0) {
					return {
						content: [{ type: "text", text: formatProjectList(projects) }],
						details: { projects, count: projects.length },
					};
				}

				return {
					content: [{ type: "text", text: "No projects found in the graph" }],
					details: { projects: [], count: 0 },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Failed to list projects: ${message}`);
			}
		},
	});
}

// =============================================================================
// Indexing Tools
// =============================================================================

/**
 * Register indexing tools (only if CGR_ALLOW_INDEX=true or settings.allowIndex)
 */
export function registerIndexingTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "index_repository",
		label: "Index Repository",
		description:
			"Index or update the current repository in the code graph. " +
			"Parses all source files and builds/updates the knowledge graph. " +
			"WARNING: Can take several minutes for large codebases. " +
			"Use incremental mode (default) for faster updates of changed files only.",
		promptSnippet: "Index/update current repository in the code knowledge graph (must be enabled first)",
		promptGuidelines: [
			"Before using query tools, the repository must be indexed with index_repository",
			"If indexing is disabled, tell the user to run: /cgs config → Project Settings → Enable Indexing",
		],
		parameters: Type.Object({
			clean: Type.Optional(
				Type.Boolean({
					description: "Clean existing project data before indexing (default: false, uses incremental update)",
					default: false,
				}),
			),
			project_name: Type.Optional(
				Type.String({
					description: "Custom project name (default: directory name)",
				}),
			),
			project_root: Type.Optional(
				Type.String({
					description: "Path to project root directory (default: current working directory)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Check if indexing is enabled
			const settings = getSettings();
			if (!settings.allowIndex && process.env.CGR_ALLOW_INDEX !== "true") {
				return {
					content: [{
						type: "text" as const,
						text: "Indexing is disabled for safety.\n\n" +
							"To enable, ask the user to run:\n" +
							"  /cgs config → Project Settings → Enable Indexing\n" +
							"Or set environment variable: CGR_ALLOW_INDEX=true",
					}],
					details: { error: "indexing_disabled" },
				};
			}

			await ensureServices(ctx);
			const manager = getServiceManager();
			const projectRoot = params.project_root || ctx.cwd;
			const projectName = params.project_name || basename(projectRoot);

			onUpdate?.({
				content: [{ type: "text", text: `Indexing repository as "${projectName}"...` }],
				details: {},
			});

			try {
				// Update project context
				await manager.updateProjectContext(projectRoot, projectName, ctx);
				
				// Create graph updater
				const updater = await manager.createGraphUpdater({
					force: params.clean,
					projectName,
					onProgress: (current, total, message) => {
						onUpdate?.({
							content: [{ type: "text", text: `[${current}/${total}] ${message}` }],
							details: { current, total, message },
						});
					},
				});
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Indexing cancelled" }], details: {} };
				}

				if (params.clean) {
					onUpdate?.({
						content: [{ type: "text", text: `Cleaning existing data for "${projectName}"...` }],
						details: {},
					});
					
					const graphService = await manager.getMemgraphService();
					await graphService.deleteProject(projectName);
				}

				// Run the indexing
				await updater.run(params.clean);
				
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Indexing cancelled" }], details: {} };
				}

				return {
					content: [{ type: "text", text: `Repository indexed successfully as "${projectName}".` }],
					details: { project_name: projectName, clean: params.clean },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				throw new Error(`Indexing failed: ${message}`);
			}
		},
	});
}
