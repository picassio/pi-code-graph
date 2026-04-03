/**
 * Runtime settings management for pi-code-graph
 *
 * Allows users to configure the extension via /cgr-config command
 * Settings are persisted to ~/.cgs/config.toml
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";

/** Config directory path */
const CGR_CONFIG_DIR = join(homedir(), ".cgs");

/** Config file path */
const CGR_CONFIG_FILE = join(CGR_CONFIG_DIR, "config.toml");

/**
 * Runtime settings (can be changed via /cgr-config)
 */
export interface CGRSettings {
	// LLM Configuration (for Cypher generation & orchestration)
	llmSource: "auto" | "manual" | "ollama";
	autoProvider?: "google" | "openai" | "anthropic" | "openrouter";  // Preferred provider in auto mode
	autoModel?: string;  // Model override in auto mode
	manualProvider?: "google" | "openai" | "anthropic" | "openrouter";
	manualApiKey?: string;
	manualModel?: string;
	ollamaEndpoint: string;
	ollamaModel: string;

	// Embedding Configuration (for semantic search)
	embeddingSource: "auto" | "local" | "openai" | "openrouter" | "ollama";
	embeddingAutoProvider?: "openai" | "openrouter";  // Preferred provider in auto mode
	embeddingAutoModel?: string;  // Model override in auto mode
	embeddingProvider?: "openai" | "openrouter" | "ollama";
	embeddingApiKey?: string;
	embeddingModel?: string;
	embeddingEndpoint?: string;

	// Memgraph Configuration
	memgraphHost: string;
	memgraphPort: string;

	// Project Configuration
	projectName?: string;
	allowIndex: boolean;

}

/**
 * Default settings
 */
const DEFAULT_SETTINGS: CGRSettings = {
	// LLM defaults
	llmSource: "auto",
	ollamaEndpoint: "http://localhost:11434/v1",
	ollamaModel: "codellama",

	// Embedding defaults (local UniXcoder)
	embeddingSource: "local",

	// Memgraph defaults
	memgraphHost: "localhost",
	memgraphPort: "7687",

	// Project defaults
	allowIndex: false,
};

// Current settings (runtime state)
let currentSettings: CGRSettings = { ...DEFAULT_SETTINGS };

/**
 * Get current settings
 */
export function getSettings(): CGRSettings {
	return { ...currentSettings };
}

/**
 * Update settings
 */
export function updateSettings(updates: Partial<CGRSettings>): void {
	currentSettings = { ...currentSettings, ...updates };
}

/**
 * Reset to defaults
 */
export function resetSettings(): void {
	currentSettings = { ...DEFAULT_SETTINGS };
}

/**
 * Load settings from environment variables (initial load)
 */
export function loadFromEnvironment(): void {

	if (process.env.CGR_PROJECT_NAME) {
		currentSettings.projectName = process.env.CGR_PROJECT_NAME;
	}
	if (process.env.CGR_ALLOW_INDEX === "true") {
		currentSettings.allowIndex = true;
	}

	if (process.env.MEMGRAPH_HOST) {
		currentSettings.memgraphHost = process.env.MEMGRAPH_HOST;
	}
	if (process.env.MEMGRAPH_PORT) {
		currentSettings.memgraphPort = process.env.MEMGRAPH_PORT;
	}

	// LLM source detection
	if (process.env.CGR_PROVIDER === "ollama" || process.env.ORCHESTRATOR_PROVIDER === "ollama") {
		currentSettings.llmSource = "ollama";
		if (process.env.ORCHESTRATOR_ENDPOINT) {
			currentSettings.ollamaEndpoint = process.env.ORCHESTRATOR_ENDPOINT;
		}
		if (process.env.ORCHESTRATOR_MODEL || process.env.CGR_MODEL) {
			currentSettings.ollamaModel = process.env.ORCHESTRATOR_MODEL || process.env.CGR_MODEL || "codellama";
		}
	} else if (process.env.ORCHESTRATOR_API_KEY || process.env.CYPHER_API_KEY) {
		currentSettings.llmSource = "manual";
		currentSettings.manualProvider = (process.env.ORCHESTRATOR_PROVIDER || "google") as "google" | "openai" | "anthropic" | "openrouter";
		currentSettings.manualApiKey = process.env.ORCHESTRATOR_API_KEY || process.env.CYPHER_API_KEY;
		currentSettings.manualModel = process.env.ORCHESTRATOR_MODEL || process.env.CGR_MODEL;
	}

	// Embedding source detection
	if (process.env.EMBEDDING_PROVIDER) {
		const provider = process.env.EMBEDDING_PROVIDER.toLowerCase();
		if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
			currentSettings.embeddingSource = provider;
			currentSettings.embeddingProvider = provider;
			currentSettings.embeddingApiKey = process.env.EMBEDDING_API_KEY;
			currentSettings.embeddingModel = process.env.EMBEDDING_MODEL;
			currentSettings.embeddingEndpoint = process.env.EMBEDDING_ENDPOINT;
		}
	}
}

/**
 * TOML structure for config file
 */
interface TOMLConfig {
	llm?: {
		source?: string;
		auto_provider?: string;  // Preferred provider in auto mode
		auto_model?: string;     // Model override in auto mode
		provider?: string;
		api_key?: string;
		model?: string;
		ollama_endpoint?: string;
		ollama_model?: string;
	};
	embedding?: {
		source?: string;
		auto_provider?: string;  // Preferred provider in auto mode
		auto_model?: string;     // Model override in auto mode
		provider?: string;
		api_key?: string;
		model?: string;
		endpoint?: string;
	};
	memgraph?: {
		host?: string;
		port?: string;
	};
	project?: {
		name?: string;
		allow_index?: boolean;
	};

}

/**
 * Save settings to ~/.cgs/config.toml
 */
export function saveSettingsToFile(): { success: boolean; error?: string } {
	try {
		// Ensure directory exists
		if (!existsSync(CGR_CONFIG_DIR)) {
			mkdirSync(CGR_CONFIG_DIR, { recursive: true });
		}

		// Build TOML structure
		const config: TOMLConfig = {
			llm: {
				source: currentSettings.llmSource,
			},
			embedding: {
				source: currentSettings.embeddingSource,
			},
			memgraph: {
				host: currentSettings.memgraphHost,
				port: currentSettings.memgraphPort,
			},
			project: {
				allow_index: currentSettings.allowIndex,
			},

		};

		// Add optional LLM fields
		if (currentSettings.llmSource === "auto") {
			if (currentSettings.autoProvider) {
				config.llm!.auto_provider = currentSettings.autoProvider;
			}
			if (currentSettings.autoModel) {
				config.llm!.auto_model = currentSettings.autoModel;
			}
		} else if (currentSettings.llmSource === "manual") {
			config.llm!.provider = currentSettings.manualProvider;
			config.llm!.api_key = currentSettings.manualApiKey;
			config.llm!.model = currentSettings.manualModel;
		} else if (currentSettings.llmSource === "ollama") {
			config.llm!.ollama_endpoint = currentSettings.ollamaEndpoint;
			config.llm!.ollama_model = currentSettings.ollamaModel;
		}

		// Add optional embedding fields
		if (currentSettings.embeddingSource === "auto") {
			if (currentSettings.embeddingAutoProvider) {
				config.embedding!.auto_provider = currentSettings.embeddingAutoProvider;
			}
			if (currentSettings.embeddingAutoModel) {
				config.embedding!.auto_model = currentSettings.embeddingAutoModel;
			}
		} else if (currentSettings.embeddingSource !== "local") {
			config.embedding!.provider = currentSettings.embeddingProvider;
			config.embedding!.api_key = currentSettings.embeddingApiKey;
			config.embedding!.model = currentSettings.embeddingModel;
			config.embedding!.endpoint = currentSettings.embeddingEndpoint;
		}

		// Add optional project name
		if (currentSettings.projectName) {
			config.project!.name = currentSettings.projectName;
		}

		// Generate TOML with header comment
		const tomlContent = `# pi-code-graph configuration
# Edit with /cgs config or manually

${TOML.stringify(config as TOML.JsonMap)}`;

		writeFileSync(CGR_CONFIG_FILE, tomlContent, "utf-8");
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Load settings from ~/.cgs/config.toml
 */
export function loadSettingsFromFile(): { success: boolean; error?: string } {
	try {
		if (!existsSync(CGR_CONFIG_FILE)) {
			return { success: true }; // No config file yet, use defaults
		}

		const content = readFileSync(CGR_CONFIG_FILE, "utf-8");
		const config = TOML.parse(content) as TOMLConfig;

		// Apply LLM settings
		if (config.llm) {
			if (config.llm.source === "auto" || config.llm.source === "manual" || config.llm.source === "ollama") {
				currentSettings.llmSource = config.llm.source;
			}
			if (config.llm.auto_provider) {
				currentSettings.autoProvider = config.llm.auto_provider as "google" | "openai" | "anthropic" | "openrouter";
			}
			if (config.llm.auto_model) {
				currentSettings.autoModel = config.llm.auto_model;
			}
			if (config.llm.provider) {
				currentSettings.manualProvider = config.llm.provider as "google" | "openai" | "anthropic" | "openrouter";
			}
			if (config.llm.api_key) {
				currentSettings.manualApiKey = config.llm.api_key;
			}
			if (config.llm.model) {
				currentSettings.manualModel = config.llm.model;
			}
			if (config.llm.ollama_endpoint) {
				currentSettings.ollamaEndpoint = config.llm.ollama_endpoint;
			}
			if (config.llm.ollama_model) {
				currentSettings.ollamaModel = config.llm.ollama_model;
			}
		}

		// Apply embedding settings
		if (config.embedding) {
			if (config.embedding.source === "auto" || config.embedding.source === "local" || config.embedding.source === "openai" ||
				config.embedding.source === "openrouter" || config.embedding.source === "ollama") {
				currentSettings.embeddingSource = config.embedding.source;
			}
			if (config.embedding.auto_provider) {
				currentSettings.embeddingAutoProvider = config.embedding.auto_provider as "openai" | "openrouter";
			}
			if (config.embedding.auto_model) {
				currentSettings.embeddingAutoModel = config.embedding.auto_model;
			}
			if (config.embedding.provider) {
				currentSettings.embeddingProvider = config.embedding.provider as "openai" | "openrouter" | "ollama";
			}
			if (config.embedding.api_key) {
				currentSettings.embeddingApiKey = config.embedding.api_key;
			}
			if (config.embedding.model) {
				currentSettings.embeddingModel = config.embedding.model;
			}
			if (config.embedding.endpoint) {
				currentSettings.embeddingEndpoint = config.embedding.endpoint;
			}
		}

		// Apply memgraph settings
		if (config.memgraph) {
			if (config.memgraph.host) {
				currentSettings.memgraphHost = config.memgraph.host;
			}
			if (config.memgraph.port) {
				currentSettings.memgraphPort = config.memgraph.port;
			}
		}

		// Apply project settings
		if (config.project) {
			if (config.project.name) {
				currentSettings.projectName = config.project.name;
			}
			if (config.project.allow_index !== undefined) {
				currentSettings.allowIndex = config.project.allow_index;
			}
		}

		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Get config file path
 */
export function getConfigFilePath(): string {
	return CGR_CONFIG_FILE;
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
	return CGR_CONFIG_DIR;
}




