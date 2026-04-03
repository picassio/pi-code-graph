/**
 * Service manager for pi-code-graph
 * 
 * Manages initialization and lifecycle of the ported TypeScript library services.
 * Replaces CLI subprocess calls with direct library integration.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import {
	MemgraphService,
	createMemgraphService,
	type MemgraphConfig,
} from "./lib/graph-service.js";
import {
	CypherGenerator,
	createCypherGenerator,
	getBestAvailableProvider,
	type LLMProvider,
	type CypherGeneratorConfig,
} from "./lib/llm-service.js";
import {
	EmbeddingService,
	SemanticSearchService,
	type EmbeddingConfig,
} from "./lib/embeddings.js";
import {
	GraphUpdater,
	createGraphUpdater,
	type GraphUpdaterConfig,
	type ProgressCallback,
} from "./lib/graph-updater.js";
import {
	createAllTools,
	type ToolCollection,
} from "./lib/tools/index.js";

import { getSettings, type CGRSettings } from "./settings.js";
import { hasValidCredentials, getPreferredProvider } from "./auth.js";

// =============================================================================
// Types
// =============================================================================

export interface ServiceManagerConfig {
	memgraphHost?: string;
	memgraphPort?: number;
	projectName?: string;
	projectRoot?: string;
}

export interface ServiceStatus {
	memgraph: { available: boolean; error?: string };
	llm: { available: boolean; provider?: string; error?: string };
	embedding: { available: boolean; provider?: string; error?: string };
	initialized: boolean;
}

// =============================================================================
// ServiceManager Class
// =============================================================================

/**
 * ServiceManager - manages shared service instances for the extension
 * 
 * Services are lazily initialized and cached for reuse across tool calls.
 */
export class ServiceManager {
	private static instance: ServiceManager | null = null;
	
	private memgraphService: MemgraphService | null = null;
	private cypherGenerator: CypherGenerator | null = null;
	private embeddingService: EmbeddingService | null = null;
	private semanticSearchService: SemanticSearchService | null = null;
	private toolCollection: ToolCollection | null = null;
	
	private initialized = false;
	private projectRoot: string = process.cwd();
	private projectName: string = basename(process.cwd());
	
	private constructor() {}
	
	/**
	 * Get the singleton instance
	 */
	static getInstance(): ServiceManager {
		if (!ServiceManager.instance) {
			ServiceManager.instance = new ServiceManager();
		}
		return ServiceManager.instance;
	}
	
	/**
	 * Reset the singleton (for testing or re-initialization)
	 */
	static reset(): void {
		if (ServiceManager.instance) {
			ServiceManager.instance.dispose().catch(console.error);
		}
		ServiceManager.instance = null;
	}
	
	/**
	 * Initialize services with the given configuration
	 */
	async initialize(config: ServiceManagerConfig = {}, ctx?: ExtensionContext): Promise<void> {
		const settings = getSettings();
		
		// Determine project info
		this.projectRoot = config.projectRoot || process.cwd();
		this.projectName = config.projectName || settings.projectName || basename(this.projectRoot);
		
		// Initialize Memgraph service
		const memgraphConfig: MemgraphConfig = {
			host: config.memgraphHost || settings.memgraphHost || "localhost",
			port: config.memgraphPort || parseInt(settings.memgraphPort || "7687", 10),
		};
		
		this.memgraphService = createMemgraphService(memgraphConfig, {
			logLevel: "warn",
		});
		
		// Connect to Memgraph
		await this.memgraphService.connect();
		
		// Initialize CypherGenerator based on settings
		const cypherConfig = await this.buildCypherConfig(ctx);
		if (cypherConfig) {
			this.cypherGenerator = createCypherGenerator(cypherConfig);
		}
		
		// Initialize EmbeddingService and SemanticSearchService based on settings
		const embeddingConfig = await this.buildEmbeddingConfig(ctx);
		if (embeddingConfig) {
			this.embeddingService = new EmbeddingService(embeddingConfig);
			
			// Create SemanticSearchService with zvec-backed vector store
			const vectorStoragePath = join(homedir(), '.cgs', 'vectors', this.projectName);
			this.semanticSearchService = new SemanticSearchService(embeddingConfig, {
				storagePath: vectorStoragePath,
				projectName: this.projectName,
			});
		}
		
		this.initialized = true;
	}
	
	/**
	 * Update configuration when working directory changes
	 */
	async updateProjectContext(projectRoot: string, projectName?: string): Promise<void> {
		this.projectRoot = projectRoot;
		this.projectName = projectName || basename(projectRoot);
		
		// Reset tool collection to use new project context
		this.toolCollection = null;
	}
	
	/**
	 * Get or create the MemgraphService
	 */
	async getMemgraphService(): Promise<MemgraphService> {
		if (!this.memgraphService) {
			await this.initialize();
		}
		return this.memgraphService!;
	}
	
	/**
	 * Get or create the CypherGenerator
	 */
	async getCypherGenerator(): Promise<CypherGenerator | null> {
		if (!this.initialized) {
			await this.initialize();
		}
		return this.cypherGenerator;
	}
	
	/**
	 * Get or create the EmbeddingService
	 */
	async getEmbeddingService(): Promise<EmbeddingService | null> {
		if (!this.initialized) {
			await this.initialize();
		}
		return this.embeddingService;
	}
	
	/**
	 * Get the SemanticSearchService (if available)
	 */
	async getSemanticSearchService(): Promise<SemanticSearchService | null> {
		if (!this.initialized) {
			await this.initialize();
		}
		return this.semanticSearchService;
	}
	
	/**
	 * Get or create the ToolCollection
	 */
	async getToolCollection(): Promise<ToolCollection> {
		if (this.toolCollection) {
			return this.toolCollection;
		}
		
		const graphService = await this.getMemgraphService();
		const cypherGenerator = await this.getCypherGenerator();
		const semanticSearchService = await this.getSemanticSearchService();
		
		this.toolCollection = await createAllTools({
			projectRoot: this.projectRoot,
			projectName: this.projectName,
			graphService,
			cypherGenerator: cypherGenerator || undefined,
			semanticSearchService: semanticSearchService || undefined,
		});
		
		return this.toolCollection;
	}
	
	/**
	 * Create a GraphUpdater for indexing
	 */
	async createGraphUpdater(
		config: GraphUpdaterConfig = {}
	): Promise<GraphUpdater> {
		const graphService = await this.getMemgraphService();
		const semanticSearchService = await this.getSemanticSearchService();
		
		return createGraphUpdater(graphService, this.projectRoot, {
			projectName: this.projectName,
			semanticSearchService: semanticSearchService || undefined,
			...config,
		});
	}
	
	/**
	 * Check service availability status
	 */
	async getStatus(ctx?: ExtensionContext): Promise<ServiceStatus> {
		const status: ServiceStatus = {
			memgraph: { available: false },
			llm: { available: false },
			embedding: { available: false },
			initialized: this.initialized,
		};
		
		// Check Memgraph
		try {
			if (this.memgraphService) {
				// Simple connectivity check
				await this.memgraphService.fetchAll("RETURN 1 as n;");
				status.memgraph.available = true;
			} else {
				status.memgraph.error = "Service not initialized";
			}
		} catch (err) {
			status.memgraph.available = false;
			status.memgraph.error = err instanceof Error ? err.message : "Unknown error";
		}
		
		// Check LLM
		if (this.cypherGenerator) {
			status.llm.available = true;
			const settings = getSettings();
			if (settings.llmSource === "ollama") {
				status.llm.provider = "ollama";
			} else if (settings.llmSource === "manual") {
				status.llm.provider = settings.manualProvider;
			} else if (ctx) {
				const creds = await hasValidCredentials(ctx);
				status.llm.provider = creds.provider;
			}
		} else {
			status.llm.error = "No LLM provider configured";
		}
		
		// Check Embedding
		if (this.embeddingService) {
			status.embedding.available = true;
			const settings = getSettings();
			status.embedding.provider = settings.embeddingSource;
		} else {
			status.embedding.error = "Embedding service not configured";
		}
		
		return status;
	}
	
	/**
	 * Get project information
	 */
	getProjectInfo(): { root: string; name: string } {
		return {
			root: this.projectRoot,
			name: this.projectName,
		};
	}
	
	/**
	 * Check if services are initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}
	
	/**
	 * Dispose all services and cleanup
	 */
	async dispose(): Promise<void> {
		if (this.memgraphService) {
			await this.memgraphService.close();
			this.memgraphService = null;
		}
		this.cypherGenerator = null;
		this.embeddingService = null;
		if (this.semanticSearchService) {
			await this.semanticSearchService.close();
			this.semanticSearchService = null;
		}
		this.toolCollection = null;
		this.initialized = false;
	}
	
	// ─────────────────────────────────────────────────────────────────────────────
	// Private Helpers
	// ─────────────────────────────────────────────────────────────────────────────
	
	/**
	 * Build CypherGenerator configuration from settings
	 */
	private async buildCypherConfig(ctx?: ExtensionContext): Promise<CypherGeneratorConfig | null> {
		const settings = getSettings();
		
		if (settings.llmSource === "ollama") {
			return {
				provider: "ollama",
				model: settings.ollamaModel || "codellama",
				endpoint: settings.ollamaEndpoint || "http://localhost:11434/v1",
			};
		}
		
		if (settings.llmSource === "manual" && settings.manualApiKey) {
			return {
				provider: settings.manualProvider as LLMProvider,
				model: settings.manualModel,
				apiKey: settings.manualApiKey,
			};
		}
		
		// Auto-detect from pi's auth system (supports both API key and OAuth)
		if (settings.llmSource === "auto" && ctx) {
			const preferred = await getPreferredProvider(ctx, settings.autoProvider, settings.autoModel);
			if (preferred) {
				return {
					provider: preferred.provider as LLMProvider,
					model: preferred.model,
					apiKey: preferred.apiKey,
					endpoint: preferred.endpoint,
					headers: preferred.headers,  // Pass OAuth/custom headers
				};
			}
		}
		
		// Fall back to best available provider
		const bestProvider = getBestAvailableProvider();
		if (bestProvider) {
			return { provider: bestProvider };
		}
		
		return null;
	}
	
	/**
	 * Build EmbeddingService configuration from settings
	 */
	private async buildEmbeddingConfig(ctx?: ExtensionContext): Promise<EmbeddingConfig | null> {
		const settings = getSettings();
		
		// Auto mode: detect from pi's auth system
		if (settings.embeddingSource === "auto" || settings.embeddingSource === "local") {
			if (ctx) {
				const { getAvailableEmbeddingProviders } = await import("./auth.js");
				const embeddingProviders = await getAvailableEmbeddingProviders(ctx);
				
				// Prefer the user's chosen provider, or first available
				const preferred = settings.embeddingAutoProvider
					? embeddingProviders.find(p => p.provider === settings.embeddingAutoProvider)
					: embeddingProviders[0];
				
				if (preferred) {
					return {
						provider: preferred.provider as "openai" | "openrouter",
						apiKey: preferred.apiKey,
						model: settings.embeddingAutoModel || (preferred.provider === "openrouter" ? "openai/text-embedding-3-small" : "text-embedding-3-small"),
						baseUrl: preferred.provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined,
					};
				}
			}
			
			// Fallback: check env
			const envApiKey = process.env.OPENAI_API_KEY;
			if (envApiKey) {
				return {
					provider: "openai",
					apiKey: envApiKey,
					model: settings.embeddingAutoModel || "text-embedding-3-small",
				};
			}
			
			return null;
		}
		
		if (settings.embeddingSource === "openai" && settings.embeddingApiKey) {
			return {
				provider: "openai",
				apiKey: settings.embeddingApiKey,
				model: settings.embeddingModel,
			};
		}
		
		if (settings.embeddingSource === "openrouter" && settings.embeddingApiKey) {
			return {
				provider: "openrouter",
				apiKey: settings.embeddingApiKey,
				model: settings.embeddingModel,
				baseUrl: settings.embeddingEndpoint,
			};
		}
		
		return null;
	}
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get the shared ServiceManager instance
 */
export function getServiceManager(): ServiceManager {
	return ServiceManager.getInstance();
}

/**
 * Initialize services (call on extension load)
 */
export async function initializeServices(
	config?: ServiceManagerConfig,
	ctx?: ExtensionContext
): Promise<ServiceManager> {
	const manager = ServiceManager.getInstance();
	await manager.initialize(config, ctx);
	return manager;
}

/**
 * Check if Memgraph is available (quick connectivity check)
 */
export async function checkMemgraphConnectivity(
	host: string = "localhost",
	port: number = 7687,
	username?: string,
	password?: string
): Promise<{ available: boolean; error?: string }> {
	const settings = getSettings();
	const tempService = createMemgraphService({
		host,
		port,
		username: username,
		password: password,
	}, { logLevel: "silent" });
	
	try {
		await tempService.connect();
		await tempService.fetchAll("RETURN 1;");
		await tempService.close();
		return { available: true };
	} catch (err) {
		return {
			available: false,
			error: err instanceof Error ? err.message : "Connection failed",
		};
	}
}
