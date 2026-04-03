/**
 * Command definitions for pi-code-graph
 *
 * Single /cgs command with subcommands:
 *   /cgs config    - Interactive configuration
 *   /cgs status    - Check availability
 *   /cgs query     - Quick query
 *   /cgs index     - Index repository
 *   /cgs help      - Show help
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";

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
import { getLogFilePath } from "./lib/logger.js";


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
		description: "Code Graph RAG - /cgs <command> [args]. Commands: config, status, query, index, docker, help",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "setup", label: "setup", description: "Guided first-time setup (Docker, LLM, indexing)" },
				{ value: "config", label: "config", description: "Configure extension (LLM, embedding, Memgraph)" },
				{ value: "status", label: "status", description: "Check Memgraph, LLM, embedding availability" },
				{ value: "query", label: "query", description: "Query the code graph" },
				{ value: "index", label: "index", description: "Index/update repository" },
				{ value: "docker", label: "docker", description: "Manage Memgraph Docker container" },
				{ value: "logs", label: "logs", description: "Show extension log file" },
				{ value: "help", label: "help", description: "Show help" },
			];
			return subs.filter(s => s.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const subargs = parts.slice(1).join(" ");

			if (!subcommand) {
				// Show interactive menu when no args provided
				const choice = await ctx.ui.select("Code Graph RAG", [
					"🚀 Setup — Guided first-time setup",
					"⚙️  Config — Configure LLM, embedding, Memgraph",
					"📊 Status — Check service availability",
					"🔍 Query — Query the code graph",
					"📥 Index — Index/update repository",
					"🐳 Docker — Manage Memgraph container",
				]);

				if (!choice) return;

				const menuMap: Record<string, string> = {
					"🚀 Setup — Guided first-time setup": "setup",
					"⚙️  Config — Configure LLM, embedding, Memgraph": "config",
					"📊 Status — Check service availability": "status",
					"🔍 Query — Query the code graph": "query",
					"📥 Index — Index/update repository": "index",
					"🐳 Docker — Manage Memgraph container": "docker",
				};

				const mapped = menuMap[choice];
				if (!mapped) return;

				// Dispatch to the selected subcommand
				switch (mapped) {
					case "setup": await handleSetup(pi, ctx); return;
					case "config": await handleConfig(pi, ctx); return;
					case "status": await handleStatus(ctx); return;
					case "query": await handleQuery(ctx, ""); return;
					case "index": await handleIndex(ctx, ""); return;
					case "docker": await handleDocker(ctx, ""); return;
				}
				return;
			}

			switch (subcommand) {
				case "setup":
					await handleSetup(pi, ctx);
					break;

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

				case "logs":
				case "log":
				case "l":
					await handleLogs(ctx, subargs);
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
 * /cgs setup - Guided first-time setup
 */
async function handleSetup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	ctx.ui.notify(
		"Code Graph RAG — Setup\n\n" +
		"This will walk you through setting up Memgraph, LLM, and indexing.\n" +
		"You can re-run this anytime with /cgs setup.",
		"info",
	);

	// ── Step 1: Docker / Memgraph ────────────────────────────────────────────
	ctx.ui.setStatus("cgs", "Checking Memgraph...");
	const mgStatus = await checkMemgraphConnectivity(
		settings.memgraphHost,
		parseInt(settings.memgraphPort, 10),
	);
	ctx.ui.setStatus("cgs", undefined);

	if (mgStatus.available) {
		ctx.ui.notify("✓ Memgraph is already running and reachable.", "info");
	} else {
		// Check Docker
		const dockerStatus = getDockerStatus();

		if (!dockerStatus.installed) {
			ctx.ui.notify(
				"Docker is not installed.\n\n" +
				"Memgraph requires Docker. Please install Docker first:\n" +
				"  https://docs.docker.com/get-docker/\n\n" +
				"Then re-run /cgs setup.",
				"error",
			);
			return;
		}

		if (!dockerStatus.composeInstalled) {
			ctx.ui.notify(
				"Docker Compose is not installed.\n\n" +
				"Please install Docker Compose, then re-run /cgs setup.",
				"error",
			);
			return;
		}

		if (dockerStatus.memgraphRunning) {
			ctx.ui.notify("Memgraph container is running but not reachable. Check /cgs docker logs.", "warning");
		} else {
			const startConfirm = await ctx.ui.confirm(
				"Start Memgraph",
				"Memgraph is not running. Start it now via Docker Compose?\n\n" +
				"This will create and start a Memgraph container.",
			);

			if (!startConfirm) {
				ctx.ui.notify("Setup cancelled. Run /cgs setup when ready.", "info");
				return;
			}

			ctx.ui.setStatus("cgs", "Starting Memgraph...");
			const startResult = await startMemgraph();

			if (!startResult.success) {
				ctx.ui.setStatus("cgs", undefined);
				ctx.ui.notify(`Failed to start Memgraph: ${startResult.error}`, "error");
				return;
			}

			ctx.ui.setStatus("cgs", "Waiting for Memgraph...");
			const healthy = await waitForMemgraph(30000);
			ctx.ui.setStatus("cgs", undefined);

			if (healthy) {
				ctx.ui.notify("✓ Memgraph started and ready!", "info");
			} else {
				ctx.ui.notify(
					"Memgraph started but not yet healthy. It may need a moment.\n" +
					"Check /cgs docker logs if it doesn't come up.",
					"warning",
				);
			}
		}
	}

	// ── Step 2: LLM Provider ─────────────────────────────────────────────────
	const credStatus = await hasValidCredentials(ctx);
	const currentSettings = getSettings();

	if (credStatus.valid && currentSettings.llmSource !== "auto") {
		// Already explicitly configured
		ctx.ui.notify(`✓ LLM provider configured: ${credStatus.provider}`, "info");
	} else {
		// Auto-detect: check available providers, prefer OpenRouter
		const available = await getAvailableProviders(ctx);
		const openrouterProvider = available.find(p => p.provider === "openrouter");

		if (openrouterProvider) {
			// OpenRouter key found — offer model selection
			const orModels = [
				"google/gemini-2.0-flash-001 (recommended, fast & cheap)",
				"anthropic/claude-sonnet-4-20250514",
				"openai/gpt-4o-mini",
				"google/gemini-2.5-pro-preview-03-25",
				"anthropic/claude-3.5-haiku-20241022",
				"Custom...",
			];

			const modelChoice = await ctx.ui.select(
				"OpenRouter API key found. Choose LLM model for code graph queries:",
				orModels,
			);

			let selectedModel = "google/gemini-2.0-flash-001";
			if (modelChoice === "Custom...") {
				const custom = await ctx.ui.input("OpenRouter model ID", "google/gemini-2.0-flash-001");
				if (custom) selectedModel = custom;
			} else if (modelChoice) {
				selectedModel = modelChoice.split(" (")[0]; // strip description
			}

			updateSettings({
				llmSource: "auto",
				autoProvider: "openrouter",
				autoModel: selectedModel,
			});
			saveSettings(ctx);
			ctx.ui.notify(`✓ LLM: OpenRouter → ${selectedModel}`, "info");
		} else if (available.length > 0) {
			// Other provider available
			const first = available[0];
			ctx.ui.notify(`✓ LLM provider auto-detected: ${first.provider}`, "info");
			updateSettings({
				llmSource: "auto",
				autoProvider: first.provider as CGRSettings["autoProvider"],
			});
			saveSettings(ctx);
		} else {
			// No provider found — offer manual config
			const configureLlm = await ctx.ui.confirm(
				"Configure LLM",
				"No LLM API key found. Configure one now?\n\n" +
				"An LLM is needed for natural-language code graph queries.\n" +
				"Tip: /login openrouter to add an OpenRouter API key.",
			);

			if (configureLlm) {
				await configureLLMSetup(pi, ctx);
			}
		}
	}

	// ── Step 3: Initialize services ──────────────────────────────────────────
	try {
		const updatedSettings = getSettings();
		const mgRecheck = await checkMemgraphConnectivity(
			updatedSettings.memgraphHost,
			parseInt(updatedSettings.memgraphPort, 10),
		);

		if (mgRecheck.available) {
			const manager = getServiceManager();
			await manager.initialize({
				memgraphHost: updatedSettings.memgraphHost,
				memgraphPort: parseInt(updatedSettings.memgraphPort, 10),
				projectRoot: ctx.cwd,
				projectName: updatedSettings.projectName || basename(ctx.cwd),
			}, ctx);
		}
	} catch (err) {
		// Non-fatal, services can be initialized later
		console.warn(`[pi-code-graph] Failed to initialize services during setup: ${err}`);
	}

	// ── Step 4: Offer to index ───────────────────────────────────────────────
	const updatedSettings2 = getSettings();
	const indexEnabled = updatedSettings2.allowIndex || process.env.CGR_ALLOW_INDEX === "true";

	if (!indexEnabled) {
		const enableIndex = await ctx.ui.confirm(
			"Enable Indexing",
			"Indexing is currently disabled. Enable it so agents can index the codebase?\n\n" +
			"⚠️ Only enable in single-agent environments.",
		);

		if (enableIndex) {
			updateSettings({ allowIndex: true });
			saveSettings(ctx);
		}
	}

	const finalSettings = getSettings();
	if (finalSettings.allowIndex) {
		const doIndex = await ctx.ui.confirm(
			"Index Repository",
			`Index the current repository "${finalSettings.projectName || basename(ctx.cwd)}" now?\n\n` +
			"This may take several minutes for large codebases.",
		);

		if (doIndex) {
			await handleIndex(ctx, "");
		}
	}

	// ── Done ─────────────────────────────────────────────────────────────────
	ctx.ui.notify(
		"Setup complete!\n\n" +
		"Use /cgs status to check service availability.\n" +
		"Use /cgs config to change settings anytime.\n" +
		"Use /cgs docker start|stop to manage Memgraph.",
		"info",
	);
}

/**
 * LLM configuration helper for the setup flow (delegates to configureLLM)
 */
async function configureLLMSetup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await configureLLM(pi, ctx);
}

/**
 * /cgs status - Check availability and configuration
 */
async function handleStatus(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	ctx.ui.setStatus("cgs", "Checking...");

	// Check Memgraph connectivity (using library directly)
	const mgStatus = await checkMemgraphConnectivity(
		settings.memgraphHost,
		parseInt(settings.memgraphPort, 10)
	);
	
	// Check LLM credentials
	const credStatus = await hasValidCredentials(ctx);

	ctx.ui.setStatus("cgs", undefined);

	const lines = [
		"Code Graph RAG Status",
		"",
		`Memgraph:  ${mgStatus.available ? "✓ Connected" : `✗ ${mgStatus.error || "not reachable"}`}`,
		`LLM:       ${credStatus.valid ? `✓ ${credStatus.provider}` : `✗ ${credStatus.error || "no credentials"}`}`,
		`Memgraph:  ${settings.memgraphHost}:${settings.memgraphPort}`,
		`Config:    ${getConfigFilePath()}`,
	];

	const manager = getServiceManager();
	if (manager.isInitialized()) {
		lines.push(`Services:  ✓ Initialized`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
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

		const lines: string[] = [];
		
		if (result.query_used) {
			lines.push(`Cypher: ${result.query_used}`, "");
		}
		
		if (result.results && result.results.length > 0) {
			lines.push(`Found ${result.results.length} result(s):`);
			for (const row of result.results.slice(0, 20)) {
				const rowStr = typeof row === "object" 
					? JSON.stringify(row, null, 2)
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

		ctx.ui.notify(lines.join("\n"), "info");
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
	const action = parts[0]?.toLowerCase();

	if (!action) {
		// Show interactive menu when no docker subcommand provided
		const choice = await ctx.ui.select("Docker — Memgraph Container", [
			"▶️  Start — Start Memgraph container",
			"⏹️  Stop — Stop Memgraph container",
			"🔄 Restart — Restart Memgraph container",
			"📊 Status — Show Docker/Memgraph status",
			"📋 Logs — Show Memgraph logs",
		]);

		if (!choice) return;

		const dockerMenuMap: Record<string, string> = {
			"▶️  Start — Start Memgraph container": "start",
			"⏹️  Stop — Stop Memgraph container": "stop",
			"🔄 Restart — Restart Memgraph container": "restart",
			"📊 Status — Show Docker/Memgraph status": "status",
			"📋 Logs — Show Memgraph logs": "logs",
		};

		// Re-dispatch with the selected action
		const mapped = dockerMenuMap[choice];
		if (mapped) {
			return handleDocker(ctx, mapped);
		}
		return;
	}

	switch (action) {
		case "status":
		case "s": {
			const status = getDockerStatus();
			const lines = [
				`Docker:          ${status.installed ? "✓ Installed" : "✗ Not installed"}`,
				`Docker Compose:  ${status.composeInstalled ? "✓ Installed" : "✗ Not installed"}`,
				`Memgraph:        ${status.memgraphRunning ? (status.memgraphHealthy ? "✓ Running (healthy)" : "⚠ Running (unhealthy)") : "✗ Not running"}`,
			];
			if (status.containerId) {
				lines.push(`Container ID:    ${status.containerId}`);
			}
			if (status.error) {
				lines.push(`Error: ${status.error}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
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
			const logLines = parseInt(parts[1], 10) || 50;
			const logs = getMemgraphLogs(logLines);
			ctx.ui.notify(logs.split("\n").slice(0, 50).join("\n"), "info");
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
 * /cgs logs - Show extension log file
 */
async function handleLogs(ctx: ExtensionContext, args: string): Promise<void> {
	const logPath = getLogFilePath();

	if (!existsSync(logPath)) {
		ctx.ui.notify(`No log file found at: ${logPath}`, "info");
		return;
	}

	const lines = parseInt(args, 10) || 50;

	try {
		const content = readFileSync(logPath, "utf-8");
		const allLines = content.split("\n");
		const tail = allLines.slice(-lines).join("\n");

		ctx.ui.notify(
			`Log file: ${logPath} (last ${lines} lines)\n\n${tail}`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(`Failed to read log: ${err}`, "error");
	}
}

/**
 * /cgs help - Show help
 */
async function handleHelp(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();

	const helpText = [
		"Code Graph RAG — /cgs",
		"",
		"/cgs              Interactive menu",
		"/cgs setup        Guided first-time setup (Docker, LLM, indexing)",
		"/cgs config (c)   Configure LLM, embedding, Memgraph",
		"/cgs status (s)   Check service availability",
		"/cgs query (q)    Query the code graph",
		"/cgs index (i)    Index/update repository",
		"/cgs docker (d)   Manage Memgraph container",
		"/cgs logs (l)     Show extension log",
		"",
		`Config: ${getConfigFilePath()}`,
		`Log:    ${getLogFilePath()}`,
	].join("\n");

	ctx.ui.notify(helpText, "info");
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
/**
 * Show current configuration
 */
async function showCurrentConfig(ctx: ExtensionContext): Promise<void> {
	const settings = getSettings();
	const credStatus = await hasValidCredentials(ctx);

	const lines = [
		"Code Graph RAG Configuration",
		"",
		"LLM Provider:",
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
	lines.push(`Config: ${getConfigFilePath()}`);

	ctx.ui.notify(lines.join("\n"), "info");
}
