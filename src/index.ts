/**
 * pi-code-graph: Code Graph RAG Extension for pi-coding-agent
 *
 * Provides codebase knowledge graph queries directly in pi using a native
 * TypeScript implementation (ported from Python code-graph-rag).
 *
 * This extension provides READ-ONLY tools for agents to understand codebase structure
 * before making changes. Index updates can be done via /cgs index command or the
 * index_repository tool (if enabled).
 *
 * Features:
 * - Natural language queries about code structure and relationships
 * - Semantic code search (find code by meaning)
 * - Dependency analysis (callers, callees, impact analysis)
 * - Source code retrieval by qualified name
 * - Optional indexing tools (disabled by default for safety)
 *
 * Setup:
 * 1. Start Memgraph: docker run -d -p 7687:7687 memgraph/memgraph
 * 2. Copy this extension to ~/.pi/agent/extensions/ or install as a package
 * 3. Configure LLM provider via /cgs config
 * 4. Index your repo: /cgs index
 *
 * Environment variables:
 * - CGR_PROJECT_NAME: Project name in the graph (default: current directory name)
 * - CGR_ALLOW_INDEX: Set to "true" to enable indexing tools (default: false)
 * - MEMGRAPH_HOST: Memgraph host (default: "localhost")
 * - MEMGRAPH_PORT: Memgraph port (default: "7687")
 *
 * Note: This extension now uses a native TypeScript library instead of
 * the Python CGR CLI. The CLI is no longer required.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

import { getServiceManager, checkMemgraphConnectivity } from "./services.js";
import { registerQueryTools, registerIndexingTools } from "./tools.js";
import { registerCommands } from "./commands.js";
import { hasValidCredentials } from "./auth.js";
import { loadFromEnvironment, loadSettingsFromFile, getSettings, getConfigFilePath } from "./settings.js";


// Track availability state
let isAvailable = false;
let lastCheckError: string | null = null;

/**
 * Main extension entry point
 */
export default function codeGraphRAGExtension(pi: ExtensionAPI): void {
	// Load settings: first from ~/.cgs/config.toml, then override with environment
	const fileResult = loadSettingsFromFile();
	if (!fileResult.success) {
		console.warn(`[pi-code-graph] Failed to load config from ${getConfigFilePath()}: ${fileResult.error}`);
	}
	loadFromEnvironment();
	
	// ═══════════════════════════════════════════════════════════════════════════
	// REGISTER TOOLS
	// ═══════════════════════════════════════════════════════════════════════════

	// Always register query tools and indexing tools
	// (indexing tool checks allowIndex at execution time)
	registerQueryTools(pi);
	registerIndexingTools(pi);

	// ═══════════════════════════════════════════════════════════════════════════
	// REGISTER COMMANDS
	// ═══════════════════════════════════════════════════════════════════════════

	registerCommands(pi);

	// ═══════════════════════════════════════════════════════════════════════════
	// LIFECYCLE HOOKS
	// ═══════════════════════════════════════════════════════════════════════════

	// Inject code graph workflow context into the system prompt
	pi.on("before_agent_start", async (_event, _ctx) => {
		const settings = getSettings();
		const indexingEnabled = settings.allowIndex || process.env.CGR_ALLOW_INDEX === "true";
		const manager = getServiceManager();
		const initialized = manager.isInitialized();

		// Build contextual guidance based on current state
		const lines: string[] = [
			"",
			"## Code Graph RAG (pi-code-graph extension)",
			"",
			"A code knowledge graph is available for understanding codebase structure.",
		];

		if (!initialized) {
			lines.push(
				"",
				"### Setup Required",
				"The code graph is not yet initialized. To set up:",
				"1. Run `/cgs setup` for guided first-time setup (starts Memgraph, configures LLM, indexes repo)",
				"   Or manually: `/cgs docker start`, `/cgs config`, `/cgs index`",
				"2. Then use `query_code_graph`, `semantic_code_search`, `analyze_code_dependencies` to explore",
			);
		} else {
			lines.push(
				"",
				"### Available Workflow",
				"- Use `query_code_graph` to understand code structure (calls, imports, class hierarchies)",
				"- Use `semantic_code_search` to find code by what it does",
				"- Use `analyze_code_dependencies` before refactoring to check impact",
				"- Use `get_code_from_graph` to retrieve source code by qualified name",
				"- Use `list_graph_projects` to see indexed projects",
			);
			if (indexingEnabled) {
				lines.push("- Use `index_repository` to update the graph after code changes");
			}
		}

		lines.push("");
		lines.push("User commands: `/cgs setup` (first-time setup), `/cgs config` (settings), `/cgs status` (check), `/cgs docker` (manage Memgraph), `/cgs index` (index repo), `/cgs query` (quick query)");

		return {
			systemPrompt: _event.systemPrompt + lines.join("\n"),
		};
	});

	// Check availability and initialize services on session start
	pi.on("session_start", async (_event, ctx) => {
		// Load settings from ~/.cgs/config.toml (refresh for new session)
		loadSettingsFromFile();
		const settings = getSettings();

		// Check Memgraph connectivity using native library
		const mgStatus = await checkMemgraphConnectivity(
			settings.memgraphHost,
			parseInt(settings.memgraphPort, 10)
		);
		
		if (!mgStatus.available) {
			isAvailable = false;
			lastCheckError = mgStatus.error || "Memgraph not reachable";

			ctx.ui.notify(
				`Code Graph RAG: Memgraph not reachable at ${settings.memgraphHost}:${settings.memgraphPort}.\n\nRun /cgs setup for guided first-time setup, or /cgs docker start to start Memgraph.`,
				"warning",
			);
			return;
		}

		// Check for LLM credentials (uses pi's auth system)
		const credStatus = await hasValidCredentials(ctx);
		if (!credStatus.valid) {
			ctx.ui.notify(
				`Code Graph RAG: ${credStatus.error}\n\nConfigure via /cgs config or use Ollama for local inference.`,
				"warning",
			);
			// Don't return - tools will still work, they just need credentials for queries
		}

		// Initialize services
		try {
			const manager = getServiceManager();
			await manager.initialize({
				memgraphHost: settings.memgraphHost,
				memgraphPort: parseInt(settings.memgraphPort, 10),
				projectRoot: ctx.cwd,
				projectName: settings.projectName || basename(ctx.cwd),
			}, ctx);
			
			isAvailable = true;
			lastCheckError = null;
		} catch (err) {
			isAvailable = false;
			lastCheckError = err instanceof Error ? err.message : "Unknown error";
			console.warn(`[pi-code-graph] Failed to initialize services: ${lastCheckError}`);
		}

		// Show brief status in footer
		ctx.ui.setStatus("cgs", `📊 ${settings.projectName || basename(ctx.cwd)}`);

		// Clear status after 3 seconds
		setTimeout(() => {
			ctx.ui.setStatus("cgs", undefined);
		}, 3000);
	});

	// Update status when agent starts
	pi.on("agent_start", async (_event, ctx) => {
		if (isAvailable) {
			ctx.ui.setStatus("cgs", "📊");
		}
	});

	// Clear status when agent ends
	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setStatus("cgs", undefined);
	});
}

// Re-export service manager for programmatic access
export { getServiceManager, initializeServices, checkMemgraphConnectivity } from "./services.js";

// Re-export auth utilities
export { hasValidCredentials, getPreferredProvider } from "./auth.js";

// Re-export the library components for advanced usage
export * from "./lib/index.js";
