/**
 * Command definitions for pi-code-graph
 *
 * Single /cgs command with subcommands:
 *   /cgs config    - Interactive configuration
 *   /cgs status    - Check availability
 *   /cgs query     - Quick query
 *   /cgs index     - Index repository
 *   /cgs clear     - Clear widget
 *   /cgs help      - Show help
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

import { getServiceManager, checkMemgraphConnectivity } from "./services.js";
import { getSettings, updateSettings, saveSettingsToFile, getConfigFilePath, type CGRSettings } from "./settings.js";
import { hasValidCredentials, getAvailableProviders, getAvailableEmbeddingProviders } from "./auth.js";
import {
	getDockerStatus,
	startMemgraph,
	stopMemgraph,
	restartMemgraph,
	waitForMemgraph,
	getMemgraphLogs,
	getDockerComposePath,
} from "./docker.js";

// Keep old executor imports for backward compatibility during transition
import { checkCGRAvailable } from "./executor.js";
import { getConfig } from "./config.js";

/**
 * Save settings and notify user
 */
function saveSettings(ctx: ExtensionContext): void {
	const result = saveSettingsToFile();
	if (!result.success) {
		ctx.ui.notify(`Failed to save config: ${result.error}`, "error");
	}
}

/**
 * Register the /cgs command
 */
export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cgs", {
		description: "Code Graph RAG - /cgs <command> [args]. Commands: config, status, query, index, docker, clear, help",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "help";
			const subargs = parts.slice(1).join(" ");

			switch (subcommand) {
				case "config":
				case "c":
					await handleConfig(pi, ctx);
					break;

				case "status":
				case "s":
					await handleStatus(ctx);
					break;

				case "query":
				case "q":
					await handleQuery(ctx, subargs);
					break;

				case "index":
				case "i":
					await handleIndex(ctx, subargs);
					break;

				case "docker":
				case "d":
					await handleDocker(ctx, subargs);
					break;

				case "clear":
					ctx.ui.setWidget("cgs", undefined);
					ctx.ui.notify("Widget cleared", "info");
					break;

				case "help":
				case "h":
				case "?":
					await handleHelp(ctx);
					break;

				default:
					ctx.ui.notify(
						`Unknown command: ${subcommand}\n\nRun /cgs help for available commands`,
						"warning"
					);
			}
		},
	});
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subcommand Handlers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * /cgs status - Check availability and configuration
 */
async function handleStatus(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();
	const config = getConfig(ctx.cwd);

	ctx.ui.setStatus("cgs", "Checking...");

	// Check Memgraph connectivity (using library directly)
	const mgStatus = await checkMemgraphConnectivity(
		settings.memgraphHost,
		parseInt(settings.memgraphPort, 10)
	);
	
	// Check CGR binary (for backward compatibility info)
	const cgrStatus = await checkCGRAvailable(config, ctx.cwd);
	
	// Check LLM credentials
	const credStatus = await hasValidCredentials(ctx);

	ctx.ui.setStatus("cgs", undefined);

	const lines = [
		"Code Graph RAG Status",
		"═════════════════════",
		"",
		"TypeScript Library (native):",
		`  Memgraph:  ${mgStatus.available ? "✓ Connected" : `✗ ${mgStatus.error || "not reachable"}`}`,
		`  LLM:       ${credStatus.valid ? `✓ ${credStatus.provider}` : `✗ ${credStatus.error || "no credentials"}`}`,
		"",
		"Python CLI (legacy/optional):",
		`  CGR CLI:   ${cgrStatus.available ? `✓ ${cgrStatus.version || "available"}` : `✗ ${cgrStatus.error || "not found"}`}`,
		"",
		`Memgraph:    ${settings.memgraphHost}:${settings.memgraphPort}`,
		`Config:      ${getConfigFilePath()}`,
	];

	// Show service manager status if initialized
	const manager = getServiceManager();
	if (manager.isInitialized()) {
		const status = await manager.getStatus(ctx);
		lines.push("");
		lines.push("Service Status:");
		lines.push(`  Initialized: ${status.initialized ? "✓" : "✗"}`);
	}

	ctx.ui.setWidget("cgs", lines, { placement: "aboveEditor" });
}

/**
 * /cgs query <question> - Quick query using the library
 */
async function handleQuery(ctx: ExtensionContext, query: string): Promise<void> {
	if (!query?.trim()) {
		ctx.ui.notify(
			"Usage: /cgs query <natural language question>\n\nExample: /cgs query What functions handle authentication?",
			"warning"
		);
		return;
	}

	const settings = getSettings();

	ctx.ui.setStatus("cgs", "Querying...");

	try {
		// Initialize services if needed
		const manager = getServiceManager();
		if (!manager.isInitialized()) {
			await manager.initialize({
				memgraphHost: settings.memgraphHost,
				memgraphPort: parseInt(settings.memgraphPort, 10),
				projectRoot: ctx.cwd,
				projectName: settings.projectName || basename(ctx.cwd),
			}, ctx);
		}

		const tools = await manager.getToolCollection();
		const result = await tools.codebaseQuery.queryCodebaseKnowledgeGraph(query);

		ctx.ui.setStatus("cgs", undefined);

		// Format results for widget display
		const lines: string[] = ["Query Results", "═════════════", ""];
		
		if (result.query_used) {
			lines.push("Cypher Query:", result.query_used, "");
		}
		
		if (result.results && result.results.length > 0) {
			lines.push(`Found ${result.results.length} result(s):`, "");
			for (const row of result.results.slice(0, 20)) {
				// Format each result row
				const rowStr = typeof row === "object" 
					? JSON.stringify(row, null, 2).split("\n").map(l => "  " + l).join("\n")
					: String(row);
				lines.push(rowStr);
			}
			if (result.results.length > 20) {
				lines.push(`... and ${result.results.length - 20} more results`);
			}
		} else if (result.summary) {
			lines.push(result.summary);
		} else {
			lines.push("No results found.");
		}

		ctx.ui.setWidget("cgs", lines, { placement: "aboveEditor" });
	} catch (err) {
		ctx.ui.setStatus("cgs", undefined);
		ctx.ui.notify(`Query error: ${err instanceof Error ? err.message : "Unknown"}`, "error");
	}
}

/**
 * /cgs index [--clean] - Index repository using the library
 */
async function handleIndex(ctx: ExtensionContext, args: string): Promise<void> {
	const settings = getSettings();

	if (!settings.allowIndex && process.env.CGR_ALLOW_INDEX !== "true") {
		ctx.ui.notify(
			"Indexing is disabled.\n\nEnable via /cgs config → Project Settings → Enable Indexing\nOr set CGR_ALLOW_INDEX=true",
			"warning"
		);
		return;
	}

	const projectName = settings.projectName || basename(ctx.cwd);
	const clean = args?.includes("--clean");

	const confirmed = await ctx.ui.confirm(
		"Index Repository",
		`This will ${clean ? "clean and re-index" : "update"} the code graph for "${projectName}".\n\nThis may take several minutes for large codebases. Continue?`,
	);

	if (!confirmed) {
		ctx.ui.notify("Indexing cancelled", "info");
		return;
	}

	ctx.ui.setStatus("cgs", "Indexing...");

	try {
		// Initialize services if needed
		const manager = getServiceManager();
		if (!manager.isInitialized()) {
			await manager.initialize({
				memgraphHost: settings.memgraphHost,
				memgraphPort: parseInt(settings.memgraphPort, 10),
				projectRoot: ctx.cwd,
				projectName,
			}, ctx);
		}

		// Update project context
		await manager.updateProjectContext(ctx.cwd, projectName);

		// Clean if requested
		if (clean) {
			ctx.ui.setStatus("cgs", "Cleaning...");
			const graphService = await manager.getMemgraphService();
			await graphService.deleteProject(projectName);
		}

		// Create and run the graph updater
		const updater = await manager.createGraphUpdater({
			force: clean,
			projectName,
			onProgress: (current, total, message) => {
				ctx.ui.setStatus("cgs", `[${current}/${total}] ${message.slice(0, 30)}...`);
			},
		});

		await updater.run();

		ctx.ui.setStatus("cgs", undefined);
		ctx.ui.notify(`Repository indexed successfully as "${projectName}"`, "info");
	} catch (err) {
		ctx.ui.setStatus("cgs", undefined);
		ctx.ui.notify(`Indexing error: ${err instanceof Error ? err.message : "Unknown"}`, "error");
	}
}

/**
 * /cgs docker <subcommand> - Manage Memgraph Docker container
 */
async function handleDocker(ctx: ExtensionContext, args: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const action = parts[0]?.toLowerCase() || "status";

	switch (action) {
		case "status":
		case "s": {
			const status = getDockerStatus();
			const lines = [
				"Docker Status",
				"═════════════",
				"",
				`Docker:          ${status.installed ? "✓ Installed" : "✗ Not installed"}`,
				`Docker Compose:  ${status.composeInstalled ? "✓ Installed" : "✗ Not installed"}`,
				`Memgraph:        ${status.memgraphRunning ? (status.memgraphHealthy ? "✓ Running (healthy)" : "⚠ Running (unhealthy)") : "✗ Not running"}`,
			];
			if (status.containerId) {
				lines.push(`Container ID:    ${status.containerId}`);
			}
			if (status.error) {
				lines.push("", `Error: ${status.error}`);
			}
			lines.push("", `Compose file: ${getDockerComposePath()}`);
			ctx.ui.setWidget("cgs", lines, { placement: "aboveEditor" });
			break;
		}

		case "start":
		case "up": {
			const status = getDockerStatus();
			if (!status.installed) {
				ctx.ui.notify("Docker is not installed. Please install Docker first.", "error");
				return;
			}
			if (status.memgraphRunning) {
				ctx.ui.notify("Memgraph is already running.", "info");
				return;
			}

			ctx.ui.setStatus("cgs", "Starting Memgraph...");
			const result = await startMemgraph();

			if (!result.success) {
				ctx.ui.setStatus("cgs", undefined);
				ctx.ui.notify(`Failed to start Memgraph: ${result.error}`, "error");
				return;
			}

			// Wait for healthy
			ctx.ui.setStatus("cgs", "Waiting for Memgraph to be ready...");
			const healthy = await waitForMemgraph(30000);

			ctx.ui.setStatus("cgs", undefined);
			if (healthy) {
				ctx.ui.notify("✓ Memgraph started and ready!", "info");
			} else {
				ctx.ui.notify("Memgraph started but not yet healthy. Check /cgs docker logs", "warning");
			}
			break;
		}

		case "stop":
		case "down": {
			const status = getDockerStatus();
			if (!status.memgraphRunning) {
				ctx.ui.notify("Memgraph is not running.", "info");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Stop Memgraph",
				"Are you sure you want to stop the Memgraph container?\nYour data will be preserved."
			);

			if (!confirmed) {
				return;
			}

			ctx.ui.setStatus("cgs", "Stopping Memgraph...");
			const result = await stopMemgraph();
			ctx.ui.setStatus("cgs", undefined);

			if (result.success) {
				ctx.ui.notify("✓ Memgraph stopped.", "info");
			} else {
				ctx.ui.notify(`Failed to stop Memgraph: ${result.error}`, "error");
			}
			break;
		}

		case "restart": {
			ctx.ui.setStatus("cgs", "Restarting Memgraph...");
			const result = await restartMemgraph();

			if (!result.success) {
				ctx.ui.setStatus("cgs", undefined);
				ctx.ui.notify(`Failed to restart Memgraph: ${result.error}`, "error");
				return;
			}

			ctx.ui.setStatus("cgs", "Waiting for Memgraph...");
			await waitForMemgraph(30000);
			ctx.ui.setStatus("cgs", undefined);
			ctx.ui.notify("✓ Memgraph restarted.", "info");
			break;
		}

		case "logs":
		case "log": {
			const lines = parseInt(parts[1], 10) || 50;
			const logs = getMemgraphLogs(lines);
			const logLines = ["Memgraph Logs", "═════════════", "", ...logs.split("\n").slice(0, 100)];
			ctx.ui.setWidget("cgs", logLines, { placement: "aboveEditor" });
			break;
		}

		default:
			ctx.ui.notify(
				`Usage: /cgs docker <command>\n\nCommands:\n  status  - Show Docker/Memgraph status\n  start   - Start Memgraph container\n  stop    - Stop Memgraph container\n  restart - Restart Memgraph container\n  logs    - Show Memgraph logs`,
				"info"
			);
	}
}

/**
 * /cgs help - Show help
 */
async function handleHelp(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const helpText = `
Code Graph RAG Extension
════════════════════════

Commands:
  /cgs config        Configure extension interactively
  /cgs status        Check Memgraph, LLM, and service availability
  /cgs query <q>     Query the code graph
  /cgs index         Index/update current repository
  /cgs docker        Manage Memgraph Docker container
  /cgs clear         Clear the results widget
  /cgs help          Show this help

Shortcuts:
  /cgs c             → config
  /cgs s             → status
  /cgs q <query>     → query
  /cgs i             → index

Tools (for LLM):
  • query_code_graph        Natural language queries
  • get_code_from_graph     Get source by qualified name
  • semantic_code_search    Find code by meaning
  • analyze_code_dependencies  Analyze callers/callees
  • list_graph_projects     List indexed projects
  ${settings.allowIndex ? "• index_repository        Index/update graph" : ""}

Config File:
  ${getConfigFilePath()}

Setup:
  1. docker run -d -p 7687:7687 memgraph/memgraph
  2. /cgs config  (configure LLM provider)
  3. /cgs index   (index your repository)
  4. Use query tools in conversations

Note: This extension now uses a native TypeScript library
instead of the Python CGR CLI for all operations.
`.trim();

	ctx.ui.setWidget("cgs", helpText.split("\n"), { placement: "aboveEditor" });
}

/**
 * /cgs config - Interactive configuration
 */
async function handleConfig(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await showConfigMenu(pi, ctx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration Menu
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Show interactive configuration menu
 */
async function showConfigMenu(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	// Main menu
	const mainChoice = await ctx.ui.select("Code Graph RAG Configuration", [
		"🤖 LLM Provider (Cypher/Orchestration)",
		"🧬 Embedding Model (Semantic Search)",
		"🗄️ Memgraph Connection",
		"📁 Project Settings",
		"🔧 Advanced",
		"📊 Show Current Config",
		"❌ Cancel",
	]);

	if (!mainChoice || mainChoice === "❌ Cancel") {
		return;
	}

	switch (mainChoice) {
		case "🤖 LLM Provider (Cypher/Orchestration)":
			await configureLLM(pi, ctx);
			break;
		case "🧬 Embedding Model (Semantic Search)":
			await configureEmbedding(pi, ctx);
			break;
		case "🗄️ Memgraph Connection":
			await configureMemgraph(pi, ctx);
			break;
		case "📁 Project Settings":
			await configureProject(pi, ctx);
			break;
		case "🔧 Advanced":
			await configureAdvanced(pi, ctx);
			break;
		case "📊 Show Current Config":
			await showCurrentConfig(ctx);
			break;
	}
}

/**
 * Configure LLM provider
 */
async function configureLLM(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	// Check what's available from pi
	const credStatus = await hasValidCredentials(ctx);
	const available = await getAvailableProviders(ctx);
	const availableStr = available.length > 0
		? available.map(p => `${p.provider}${p.isOAuth ? " (OAuth)" : ""}`).join(", ")
		: "none";

	const sourceChoice = await ctx.ui.select("LLM Provider Source", [
		`🔄 Auto (use pi's auth) [available: ${availableStr}]`,
		"🦙 Ollama (local, free)",
		"🔑 Manual API Key",
		"← Back",
	]);

	if (!sourceChoice || sourceChoice === "← Back") {
		return showConfigMenu(pi, ctx);
	}

	if (sourceChoice.startsWith("🔄")) {
		await configureAutoLLM(pi, ctx, available);
	} else if (sourceChoice.startsWith("🦙")) {
		await configureOllama(pi, ctx);
	} else if (sourceChoice.startsWith("🔑")) {
		await configureManualKey(pi, ctx);
	}
}

/**
 * Configure auto LLM - let user pick provider and model from pi's available providers
 */
async function configureAutoLLM(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	available: { provider: string; isOAuth: boolean; models: string[] }[],
): Promise<void> {
	const settings = getSettings();

	if (available.length === 0) {
		ctx.ui.notify("No providers found in pi. Use /login to authenticate with a provider first.", "warning");
		return configureLLM(pi, ctx);
	}

	// Let user pick provider
	const defaultModels: Record<string, string> = {
		google: "gemini-2.0-flash",
		openrouter: "google/gemini-2.0-flash-001",
		openai: "gpt-4o-mini",
		anthropic: "claude-sonnet-4-20250514",
	};

	const providerChoices = available.map(p => {
		const authType = p.isOAuth ? " 🔐 OAuth" : " 🔑 API Key";
		const current = settings.autoProvider === p.provider ? " [current]" : "";
		return `${p.provider}${authType}${current}`;
	});
	providerChoices.push("← Back");

	const providerChoice = await ctx.ui.select("Choose Provider (from pi's auth)", providerChoices);

	if (!providerChoice || providerChoice === "← Back") {
		return configureLLM(pi, ctx);
	}

	const selectedProvider = providerChoice.split(" ")[0];
	const providerInfo = available.find(p => p.provider === selectedProvider);

	if (!providerInfo) {
		return configureLLM(pi, ctx);
	}

	// Let user pick model
	const defaultModel = defaultModels[selectedProvider] || providerInfo.models[0];
	const modelChoices = [
		`${defaultModel} (default)`,
		...providerInfo.models.filter(m => m !== defaultModel).slice(0, 10),
		"Custom...",
	];

	const modelChoice = await ctx.ui.select(`Model for ${selectedProvider}`, modelChoices);

	let selectedModel: string | undefined;
	if (modelChoice === "Custom...") {
		const custom = await ctx.ui.input("Model ID", defaultModel);
		if (custom) selectedModel = custom;
	} else if (modelChoice) {
		selectedModel = modelChoice.replace(" (default)", "");
	}

	updateSettings({
		llmSource: "auto",
		autoProvider: selectedProvider as CGRSettings["autoProvider"],
		autoModel: selectedModel || defaultModel,
	});
	saveSettings(ctx);

	const authType = providerInfo.isOAuth ? "OAuth" : "API Key";
	ctx.ui.notify(
		`LLM: ${selectedProvider} (${authType}) → ${selectedModel || defaultModel}\n\nSaved to: ${getConfigFilePath()}`,
		"info",
	);
}

/**
 * Configure Ollama
 */
async function configureOllama(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const endpoint = await ctx.ui.input(
		"Ollama Endpoint",
		settings.ollamaEndpoint || "http://localhost:11434/v1",
	);

	if (!endpoint) {
		return configureLLM(pi, ctx);
	}

	const modelChoice = await ctx.ui.select("Ollama Model", [
		"codellama (recommended for Cypher)",
		"llama3.2",
		"mistral",
		"mixtral",
		"Custom...",
	]);

	let model = "codellama";
	if (modelChoice === "Custom...") {
		const customModel = await ctx.ui.input("Model Name", "codellama");
		if (customModel) {
			model = customModel;
		}
	} else if (modelChoice) {
		model = modelChoice.split(" ")[0];
	}

	updateSettings({
		llmSource: "ollama",
		ollamaEndpoint: endpoint,
		ollamaModel: model,
	});
	saveSettings(ctx);

	ctx.ui.notify(`Ollama configured: ${model} at ${endpoint}\n\nSaved to: ${getConfigFilePath()}`, "info");
}

/**
 * Configure manual API key
 */
async function configureManualKey(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const providerChoice = await ctx.ui.select("Provider", [
		"Google (Gemini)",
		"OpenAI",
		"OpenRouter",
		"Anthropic",
		"← Back",
	]);

	if (!providerChoice || providerChoice === "← Back") {
		return configureLLM(pi, ctx);
	}

	const providerMap: Record<string, "google" | "openai" | "anthropic" | "openrouter"> = {
		"Google (Gemini)": "google",
		"OpenAI": "openai",
		"OpenRouter": "openrouter",
		"Anthropic": "anthropic",
	};

	const provider = providerMap[providerChoice];

	const apiKey = await ctx.ui.input(
		`${providerChoice} API Key`,
		provider === "openrouter" ? "sk-or-v1-..." : "sk-... or AIza...",
	);

	if (!apiKey) {
		return configureLLM(pi, ctx);
	}

	// Default models per provider
	const defaultModels: Record<string, string> = {
		google: "gemini-2.0-flash",
		openai: "gpt-4o-mini",
		openrouter: "google/gemini-2.0-flash-001",
		anthropic: "claude-sonnet-4-20250514",
	};

	const model = await ctx.ui.input(
		"Model (leave empty for default)",
		defaultModels[provider],
	);

	updateSettings({
		llmSource: "manual",
		manualProvider: provider,
		manualApiKey: apiKey,
		manualModel: model || defaultModels[provider],
	});
	saveSettings(ctx);

	ctx.ui.notify(`${providerChoice} configured with ${model || defaultModels[provider]}\n\nSaved to: ${getConfigFilePath()}`, "info");
}

/**
 * Configure embedding model
 */
async function configureEmbedding(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();
	const embeddingProviders = await getAvailableEmbeddingProviders(ctx);
	const autoAvailable = embeddingProviders.length > 0
		? embeddingProviders.map(p => p.provider).join(", ")
		: "none";

	const sourceChoice = await ctx.ui.select("Embedding Model Source", [
		`🔄 Auto (use pi's auth) [available: ${autoAvailable}]${settings.embeddingSource === "auto" ? " [current]" : ""}`,
		`🌐 OpenAI API (manual key)${settings.embeddingSource === "openai" ? " [current]" : ""}`,
		`🌐 OpenRouter (manual key)${settings.embeddingSource === "openrouter" ? " [current]" : ""}`,
		`🦙 Ollama${settings.embeddingSource === "ollama" ? " [current]" : ""}`,
		"← Back",
	]);

	if (!sourceChoice || sourceChoice === "← Back") {
		return showConfigMenu(pi, ctx);
	}

	if (sourceChoice.startsWith("🔄")) {
		await configureAutoEmbedding(pi, ctx, embeddingProviders);
	} else if (sourceChoice.includes("OpenRouter (manual")) {
		await configureOpenRouterEmbedding(pi, ctx);
	} else if (sourceChoice.includes("OpenAI (manual")) {
		await configureOpenAIEmbedding(pi, ctx);
	} else if (sourceChoice.includes("Ollama")) {
		await configureOllamaEmbedding(pi, ctx);
	}
}

/**
 * Configure auto embedding - use pi's auth with model selection
 */
async function configureAutoEmbedding(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	available: { provider: string; apiKey: string; isOAuth: boolean }[],
): Promise<void> {
	const settings = getSettings();

	if (available.length === 0) {
		ctx.ui.notify("No embedding-capable providers found. Need OpenAI or OpenRouter auth in pi.", "warning");
		return configureEmbedding(pi, ctx);
	}

	// Let user pick provider if multiple
	let selectedProvider = available[0].provider;
	if (available.length > 1) {
		const choices = available.map(p => {
			const authType = p.isOAuth ? " 🔐 OAuth" : " 🔑 API Key";
			const current = settings.embeddingAutoProvider === p.provider ? " [current]" : "";
			return `${p.provider}${authType}${current}`;
		});
		choices.push("← Back");

		const choice = await ctx.ui.select("Embedding Provider", choices);
		if (!choice || choice === "← Back") {
			return configureEmbedding(pi, ctx);
		}
		selectedProvider = choice.split(" ")[0];
	}

	// Let user pick embedding model
	const defaultModels = selectedProvider === "openrouter"
		? ["openai/text-embedding-3-small", "openai/text-embedding-3-large", "openai/text-embedding-ada-002"]
		: ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"];

	const modelChoices = [
		`${defaultModels[0]} (recommended)`,
		...defaultModels.slice(1),
		"Custom...",
	];

	const modelChoice = await ctx.ui.select("Embedding Model", modelChoices);

	let selectedModel = defaultModels[0];
	if (modelChoice === "Custom...") {
		const custom = await ctx.ui.input("Model ID", defaultModels[0]);
		if (custom) selectedModel = custom;
	} else if (modelChoice) {
		selectedModel = modelChoice.replace(" (recommended)", "");
	}

	updateSettings({
		embeddingSource: "auto",
		embeddingAutoProvider: selectedProvider as "openai" | "openrouter",
		embeddingAutoModel: selectedModel,
	});
	saveSettings(ctx);

	ctx.ui.notify(`Embedding: ${selectedProvider} → ${selectedModel} (using pi's auth)\n\nSaved to: ${getConfigFilePath()}`, "info");
}

/**
 * Configure OpenRouter embedding
 */
async function configureOpenRouterEmbedding(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	// Try to reuse LLM API key if it's OpenRouter
	const existingKey = settings.manualProvider === "openrouter" ? settings.manualApiKey : undefined;

	const reuseKey = existingKey
		? await ctx.ui.confirm("Reuse API Key", "Use the same OpenRouter API key configured for LLM?")
		: false;

	let apiKey: string | undefined;
	if (reuseKey && existingKey) {
		apiKey = existingKey;
	} else {
		apiKey = await ctx.ui.input("OpenRouter API Key", "sk-or-v1-...");
		if (!apiKey) {
			return configureEmbedding(pi, ctx);
		}
	}

	const modelChoice = await ctx.ui.select("Embedding Model", [
		"openai/text-embedding-3-small (recommended)",
		"openai/text-embedding-3-large",
		"openai/text-embedding-ada-002",
		"cohere/embed-english-v3.0",
		"cohere/embed-multilingual-v3.0",
		"Custom...",
	]);

	let model = "openai/text-embedding-3-small";
	if (modelChoice === "Custom...") {
		const customModel = await ctx.ui.input("Model ID", "openai/text-embedding-3-small");
		if (customModel) {
			model = customModel;
		}
	} else if (modelChoice) {
		model = modelChoice.split(" ")[0];
	}

	updateSettings({
		embeddingSource: "openrouter",
		embeddingProvider: "openrouter",
		embeddingApiKey: apiKey,
		embeddingModel: model,
		embeddingEndpoint: "https://openrouter.ai/api/v1",
	});
	saveSettings(ctx);

	ctx.ui.notify(`OpenRouter embedding configured: ${model}`, "info");
}

/**
 * Configure OpenAI embedding
 */
async function configureOpenAIEmbedding(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	// Try to reuse LLM API key if it's OpenAI
	const existingKey = settings.manualProvider === "openai" ? settings.manualApiKey : undefined;

	const reuseKey = existingKey
		? await ctx.ui.confirm("Reuse API Key", "Use the same OpenAI API key configured for LLM?")
		: false;

	let apiKey: string | undefined;
	if (reuseKey && existingKey) {
		apiKey = existingKey;
	} else {
		apiKey = await ctx.ui.input("OpenAI API Key", "sk-...");
		if (!apiKey) {
			return configureEmbedding(pi, ctx);
		}
	}

	const modelChoice = await ctx.ui.select("Embedding Model", [
		"text-embedding-3-small (recommended)",
		"text-embedding-3-large",
		"text-embedding-ada-002",
	]);

	const model = modelChoice ? modelChoice.split(" ")[0] : "text-embedding-3-small";

	updateSettings({
		embeddingSource: "openai",
		embeddingProvider: "openai",
		embeddingApiKey: apiKey,
		embeddingModel: model,
		embeddingEndpoint: undefined,
	});
	saveSettings(ctx);

	ctx.ui.notify(`OpenAI embedding configured: ${model}`, "info");
}

/**
 * Configure Ollama embedding
 */
async function configureOllamaEmbedding(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const endpoint = await ctx.ui.input(
		"Ollama Endpoint",
		settings.ollamaEndpoint || "http://localhost:11434/v1",
	);

	if (!endpoint) {
		return configureEmbedding(pi, ctx);
	}

	const modelChoice = await ctx.ui.select("Embedding Model", [
		"nomic-embed-text (recommended)",
		"mxbai-embed-large",
		"all-minilm",
		"Custom...",
	]);

	let model = "nomic-embed-text";
	if (modelChoice === "Custom...") {
		const customModel = await ctx.ui.input("Model Name", "nomic-embed-text");
		if (customModel) {
			model = customModel;
		}
	} else if (modelChoice) {
		model = modelChoice.split(" ")[0];
	}

	updateSettings({
		embeddingSource: "ollama",
		embeddingProvider: "ollama",
		embeddingApiKey: undefined,
		embeddingModel: model,
		embeddingEndpoint: endpoint,
	});
	saveSettings(ctx);

	ctx.ui.notify(`Ollama embedding configured: ${model} at ${endpoint}`, "info");
}

/**
 * Configure Memgraph connection
 */
async function configureMemgraph(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const host = await ctx.ui.input(
		"Memgraph Host",
		settings.memgraphHost,
	);

	if (!host) {
		return showConfigMenu(pi, ctx);
	}

	const port = await ctx.ui.input(
		"Memgraph Port",
		settings.memgraphPort,
	);

	if (!port) {
		return showConfigMenu(pi, ctx);
	}

	updateSettings({
		memgraphHost: host,
		memgraphPort: port,
	});
	saveSettings(ctx);

	ctx.ui.notify(`Memgraph configured: ${host}:${port}`, "info");

	// Test connection using the library
	ctx.ui.setStatus("cgs", "Testing...");
	const mgStatus = await checkMemgraphConnectivity(host, parseInt(port, 10));
	ctx.ui.setStatus("cgs", undefined);

	if (mgStatus.available) {
		ctx.ui.notify(`✓ Connected to Memgraph at ${host}:${port}`, "info");
	} else {
		ctx.ui.notify(`✗ Could not connect: ${mgStatus.error}`, "warning");
	}
}

/**
 * Configure project settings
 */
async function configureProject(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();
	const defaultName = settings.projectName || basename(ctx.cwd);

	const projectName = await ctx.ui.input(
		"Project Name",
		defaultName,
	);

	if (projectName) {
		updateSettings({ projectName });
	}

	const allowIndex = await ctx.ui.confirm(
		"Enable Indexing",
		"Allow agents to index/update the code graph?\n\n⚠️ Only enable in single-agent environments.",
	);

	updateSettings({ allowIndex });
	saveSettings(ctx);

	ctx.ui.notify(
		`Project: ${projectName || defaultName}\nIndexing: ${allowIndex ? "Enabled" : "Disabled"}`,
		"info",
	);
}

/**
 * Configure advanced settings
 */
async function configureAdvanced(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const choice = await ctx.ui.select("Advanced Settings", [
		`CGR Binary (legacy): ${settings.cgrBinary}`,
		`Timeout: ${settings.timeout}ms`,
		"← Back",
	]);

	if (!choice || choice === "← Back") {
		return showConfigMenu(pi, ctx);
	}

	if (choice.startsWith("CGR Binary")) {
		const binary = await ctx.ui.input("CGR Binary Path (for legacy CLI fallback)", settings.cgrBinary);
		if (binary) {
			updateSettings({ cgrBinary: binary });
			saveSettings(ctx);
			ctx.ui.notify(`CGR binary set to: ${binary}`, "info");
		}
	} else if (choice.startsWith("Timeout")) {
		const timeoutStr = await ctx.ui.input("Timeout (ms)", String(settings.timeout));
		if (timeoutStr) {
			const timeout = parseInt(timeoutStr, 10);
			if (!isNaN(timeout) && timeout > 0) {
				updateSettings({ timeout });
				saveSettings(ctx);
				ctx.ui.notify(`Timeout set to: ${timeout}ms`, "info");
			}
		}
	}
}

/**
 * Show current configuration
 */
async function showCurrentConfig(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();
	const credStatus = await hasValidCredentials(ctx);

	const lines = [
		"Code Graph RAG Configuration",
		"═══════════════════════════════",
		"",
		"LLM Provider (Cypher/Orchestration):",
		`  Source:     ${settings.llmSource}`,
	];

	if (settings.llmSource === "auto") {
		lines.push(`  Detected:   ${credStatus.valid ? credStatus.provider : "none"}`);
		if (settings.autoProvider) {
			lines.push(`  Preferred:  ${settings.autoProvider}`);
		}
		if (settings.autoModel) {
			lines.push(`  Model:      ${settings.autoModel}`);
		}
	} else if (settings.llmSource === "ollama") {
		lines.push(`  Endpoint:   ${settings.ollamaEndpoint}`);
		lines.push(`  Model:      ${settings.ollamaModel}`);
	} else if (settings.llmSource === "manual") {
		lines.push(`  Provider:   ${settings.manualProvider}`);
		lines.push(`  Model:      ${settings.manualModel}`);
		lines.push(`  API Key:    ${settings.manualApiKey ? "********" : "not set"}`);
	}

	lines.push("");
	lines.push("Embedding Model (Semantic Search):");
	lines.push(`  Source:     ${settings.embeddingSource}`);
	if (settings.embeddingSource === "auto") {
		if (settings.embeddingAutoProvider) {
			lines.push(`  Provider:   ${settings.embeddingAutoProvider} (via pi's auth)`);
		}
		lines.push(`  Model:      ${settings.embeddingAutoModel || "text-embedding-3-small (default)"}`);
	} else if (settings.embeddingSource === "local") {
		lines.push(`  Model:      (API fallback when available)`);
	} else {
		lines.push(`  Provider:   ${settings.embeddingProvider || "not set"}`);
		lines.push(`  Model:      ${settings.embeddingModel || "not set"}`);
		lines.push(`  API Key:    ${settings.embeddingApiKey ? "********" : "not set"}`);
		if (settings.embeddingEndpoint) {
			lines.push(`  Endpoint:   ${settings.embeddingEndpoint}`);
		}
	}

	lines.push("");
	lines.push("Memgraph:");
	lines.push(`  Host:       ${settings.memgraphHost}`);
	lines.push(`  Port:       ${settings.memgraphPort}`);

	lines.push("");
	lines.push("Project:");
	lines.push(`  Name:       ${settings.projectName || "(auto)"}`);
	lines.push(`  Indexing:   ${settings.allowIndex ? "Enabled" : "Disabled"}`);

	lines.push("");
	lines.push("Advanced:");
	lines.push(`  Binary:     ${settings.cgrBinary} (legacy)`);
	lines.push(`  Timeout:    ${settings.timeout}ms`);

	lines.push("");
	lines.push(`Config file: ${getConfigFilePath()}`);
	lines.push("");
	lines.push("Note: This extension now uses native TypeScript library.");
	lines.push("The Python CGR CLI is no longer required for operation.");

	ctx.ui.setWidget("cgs", lines, { placement: "aboveEditor" });
	ctx.ui.notify("Configuration shown above editor. Use /cgs clear to dismiss.", "info");
}
