/**
 * Runtime settings management for pi-code-graph
 *
 * Allows users to configure the extension via /cgr-config command
 * Settings are persisted to ~/.cgr/config.toml
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as TOML from "@iarna/toml";

/** Config directory path */
const CGR_CONFIG_DIR = join(homedir(), ".cgr");

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
	memgraphUser: string;
	memgraphPassword?: string;

	// Project Configuration
	projectName?: string;
	allowIndex: boolean;

	// CGR Binary
	cgrBinary: string;
	timeout: number;
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
	memgraphUser: "memgraph",
	memgraphPassword: undefined,

	// Project defaults
	allowIndex: false,
	cgrBinary: "cgr",
	timeout: 120000,
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
	if (process.env.CGR_BINARY) {
		currentSettings.cgrBinary = process.env.CGR_BINARY;
	}
	if (process.env.CGR_PROJECT_NAME) {
		currentSettings.projectName = process.env.CGR_PROJECT_NAME;
	}
	if (process.env.CGR_ALLOW_INDEX === "true") {
		currentSettings.allowIndex = true;
	}
	if (process.env.CGR_TIMEOUT) {
		currentSettings.timeout = parseInt(process.env.CGR_TIMEOUT, 10);
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
 * Build environment variables from current settings
 */
export function buildEnvironmentFromSettings(ctx: ExtensionContext): Record<string, string> {
	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		MEMGRAPH_HOST: currentSettings.memgraphHost,
		MEMGRAPH_PORT: currentSettings.memgraphPort,
	};

	// LLM configuration
	if (currentSettings.llmSource === "ollama") {
		env.ORCHESTRATOR_PROVIDER = "ollama";
		env.ORCHESTRATOR_MODEL = currentSettings.ollamaModel;
		env.ORCHESTRATOR_ENDPOINT = currentSettings.ollamaEndpoint;
		env.CYPHER_PROVIDER = "ollama";
		env.CYPHER_MODEL = currentSettings.ollamaModel;
		env.CYPHER_ENDPOINT = currentSettings.ollamaEndpoint;
	} else if (currentSettings.llmSource === "manual" && currentSettings.manualApiKey) {
		const provider = currentSettings.manualProvider || "google";
		env.ORCHESTRATOR_PROVIDER = provider;
		env.ORCHESTRATOR_API_KEY = currentSettings.manualApiKey;
		if (currentSettings.manualModel) {
			env.ORCHESTRATOR_MODEL = currentSettings.manualModel;
		}
		env.CYPHER_PROVIDER = provider;
		env.CYPHER_API_KEY = currentSettings.manualApiKey;
		if (currentSettings.manualModel) {
			env.CYPHER_MODEL = currentSettings.manualModel;
		}

		// OpenRouter needs base URL
		if (provider === "openrouter") {
			env.ORCHESTRATOR_ENDPOINT = "https://openrouter.ai/api/v1";
			env.CYPHER_ENDPOINT = "https://openrouter.ai/api/v1";
		}
	}
	// For "auto", the auth.ts module handles it via ctx.modelRegistry

	// Embedding configuration (for future CGR versions with API embedding support)
	if (currentSettings.embeddingSource !== "local") {
		env.EMBEDDING_PROVIDER = currentSettings.embeddingSource;
		if (currentSettings.embeddingApiKey) {
			env.EMBEDDING_API_KEY = currentSettings.embeddingApiKey;
		}
		if (currentSettings.embeddingModel) {
			env.EMBEDDING_MODEL = currentSettings.embeddingModel;
		}
		if (currentSettings.embeddingEndpoint) {
			env.EMBEDDING_ENDPOINT = currentSettings.embeddingEndpoint;
		} else if (currentSettings.embeddingSource === "openrouter") {
			env.EMBEDDING_ENDPOINT = "https://openrouter.ai/api/v1";
		}
	}

	return env;
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
		user?: string;
		password?: string;
	};
	project?: {
		name?: string;
		allow_index?: boolean;
	};
	advanced?: {
		binary?: string;
		timeout?: number;
	};
}

/**
 * Save settings to ~/.cgr/config.toml
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
				user: currentSettings.memgraphUser,
				password: currentSettings.memgraphPassword,
			},
			project: {
				allow_index: currentSettings.allowIndex,
			},
			advanced: {
				binary: currentSettings.cgrBinary,
				timeout: currentSettings.timeout,
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
		const tomlContent = `# Code Graph RAG Configuration
# Generated by pi-code-graph extension
# Edit with /cgr-config or manually

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
 * Load settings from ~/.cgr/config.toml
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
			if (config.memgraph.user) {
				currentSettings.memgraphUser = config.memgraph.user;
			}
			if (config.memgraph.password) {
				currentSettings.memgraphPassword = config.memgraph.password;
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

		// Apply advanced settings
		if (config.advanced) {
			if (config.advanced.binary) {
				currentSettings.cgrBinary = config.advanced.binary;
			}
			if (config.advanced.timeout) {
				currentSettings.timeout = config.advanced.timeout;
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

/**
 * Generate a secure random password
 */
export function generateSecurePassword(length: number = 24): string {
	// Use URL-safe base64 characters (no special chars that might cause issues)
	const bytes = randomBytes(length);
	return bytes.toString('base64').replace(/[+/=]/g, '').slice(0, length);
}

/**
 * Ensure Memgraph password is set (generate if not exists)
 * Returns true if a new password was generated
 */
export function ensureMemgraphPassword(): boolean {
	if (currentSettings.memgraphPassword) {
		return false; // Already has password
	}

	// Generate a new password
	currentSettings.memgraphPassword = generateSecurePassword();
	return true;
}

/**
 * Get Memgraph credentials
 */
export function getMemgraphCredentials(): { user: string; password: string | undefined } {
	return {
		user: currentSettings.memgraphUser,
		password: currentSettings.memgraphPassword,
	};
}

/**
 * Persist settings to ~/.cgr/config.toml
 * @deprecated Use saveSettingsToFile() for clearer naming
 */
export function persistSettings(_pi: ExtensionAPI): void {
	saveSettingsToFile();
}

/**
 * Restore settings from ~/.cgr/config.toml
 * @deprecated Use loadSettingsFromFile() for clearer naming
 */
export function restoreSettings(_ctx: ExtensionContext): void {
	loadSettingsFromFile();
}
