/**
 * Authentication bridge between pi-coding-agent and code-graph-rag
 *
 * Uses pi's modelRegistry to get API keys (including OAuth tokens) and passes them to the LLM service.
 * Supports both API key and OAuth authentication methods.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Provider mapping from pi providers to CGR providers
 */
const PROVIDER_MAP: Record<string, string> = {
	// pi provider -> CGR provider
	google: "google",
	anthropic: "anthropic",
	openai: "openai",
	openrouter: "openrouter",
	// Ollama doesn't need API key
};

/**
 * CGR provider to pi provider mapping (reverse)
 */
const CGR_TO_PI_PROVIDER: Record<string, string> = {
	google: "google",
	anthropic: "anthropic",
	openai: "openai",
	openrouter: "openrouter",
};

/**
 * Authentication result from pi's modelRegistry
 */
export interface PiAuthResult {
	apiKey?: string;
	headers?: Record<string, string>;
	isOAuth?: boolean;
}

/** Default models per provider */
const DEFAULT_MODELS: Record<string, string> = {
	google: "gemini-2.0-flash",
	openrouter: "google/gemini-2.0-flash-001",
	openai: "gpt-4o-mini",
	anthropic: "claude-sonnet-4-20250514",
};

/** Default endpoints per provider */
const DEFAULT_ENDPOINTS: Record<string, string | undefined> = {
	openrouter: "https://openrouter.ai/api/v1",
};

/** Provider search order — OpenRouter first since it supports many models */
const PROVIDER_ORDER = [
	{ pi: "openrouter", cgr: "openrouter" },
	{ pi: "google", cgr: "google" },
	{ pi: "openai", cgr: "openai" },
	{ pi: "anthropic", cgr: "anthropic" },
];

/**
 * Get the preferred LLM provider for CGR based on available API keys or OAuth tokens.
 * 
 * If preferProvider is set, tries that provider first.
 * If modelOverride is set, uses that model instead of the default.
 */
export async function getPreferredProvider(
	ctx: ExtensionContext,
	preferProvider?: string,
	modelOverride?: string,
): Promise<{
	provider: string;
	apiKey: string | undefined;
	headers?: Record<string, string>;
	model: string;
	endpoint?: string;
	isOAuth?: boolean;
} | null> {
	const modelRegistry = ctx.modelRegistry;

	// Build provider order: preferred provider first, then defaults
	let providerOrder = [...PROVIDER_ORDER];
	if (preferProvider) {
		const preferred = providerOrder.find(p => p.cgr === preferProvider || p.pi === preferProvider);
		if (preferred) {
			providerOrder = [preferred, ...providerOrder.filter(p => p !== preferred)];
		}
	}

	for (const prov of providerOrder) {
		try {
			// Try to get a model from this provider to check auth
			const models = modelRegistry.getAvailable().filter(m => m.provider === prov.pi);
			if (models.length === 0) continue;

			// Use the first available model to get auth
			const model = models[0];
			const authResult = await modelRegistry.getApiKeyAndHeaders(model);

			if (authResult.ok && authResult.apiKey) {
				const isOAuth = modelRegistry.isUsingOAuth(model);
				return {
					provider: prov.cgr,
					apiKey: authResult.apiKey,
					headers: authResult.headers,
					model: modelOverride || DEFAULT_MODELS[prov.cgr] || models[0].id,
					endpoint: DEFAULT_ENDPOINTS[prov.cgr],
					isOAuth,
				};
			}
		} catch {
			// Provider not available, try next
		}
	}

	return null;
}

/**
 * Get available providers from pi's modelRegistry (for UI selection)
 */
export async function getAvailableProviders(ctx: ExtensionContext): Promise<{
	provider: string;
	isOAuth: boolean;
	models: string[];
}[]> {
	const modelRegistry = ctx.modelRegistry;
	const available: { provider: string; isOAuth: boolean; models: string[] }[] = [];

	for (const prov of PROVIDER_ORDER) {
		try {
			const models = modelRegistry.getAvailable().filter(m => m.provider === prov.pi);
			if (models.length === 0) continue;

			// Check if auth is available
			const authResult = await modelRegistry.getApiKeyAndHeaders(models[0]);
			if (authResult.ok && authResult.apiKey) {
				const isOAuth = modelRegistry.isUsingOAuth(models[0]);
				available.push({
					provider: prov.cgr,
					isOAuth,
					models: models.map(m => m.id),
				});
			}
		} catch {
			// Skip
		}
	}

	return available;
}

/**
 * Get available embedding providers from pi's modelRegistry
 */
export async function getAvailableEmbeddingProviders(ctx: ExtensionContext): Promise<{
	provider: string;
	apiKey: string;
	headers?: Record<string, string>;
	isOAuth: boolean;
}[]> {
	const modelRegistry = ctx.modelRegistry;
	const available: { provider: string; apiKey: string; headers?: Record<string, string>; isOAuth: boolean }[] = [];

	// Only OpenAI and OpenRouter support embeddings
	const embeddingProviders = PROVIDER_ORDER.filter(p => p.cgr === "openai" || p.cgr === "openrouter");

	for (const prov of embeddingProviders) {
		try {
			const models = modelRegistry.getAvailable().filter(m => m.provider === prov.pi);
			if (models.length === 0) continue;

			const authResult = await modelRegistry.getApiKeyAndHeaders(models[0]);
			if (authResult.ok && authResult.apiKey) {
				available.push({
					provider: prov.cgr,
					apiKey: authResult.apiKey,
					headers: authResult.headers,
					isOAuth: modelRegistry.isUsingOAuth(models[0]),
				});
			}
		} catch {
			// Skip
		}
	}

	return available;
}

/**
 * Get API key for a specific provider from pi's auth system
 */
export async function getApiKeyFromPi(
	ctx: ExtensionContext,
	cgrProvider: string,
): Promise<string | undefined> {
	const piProvider = CGR_TO_PI_PROVIDER[cgrProvider];
	if (!piProvider) {
		return undefined;
	}

	try {
		return await ctx.modelRegistry.getApiKeyForProvider(piProvider);
	} catch {
		return undefined;
	}
}

/**
 * Check if we have valid LLM credentials for CGR
 */
export async function hasValidCredentials(ctx: ExtensionContext): Promise<{
	valid: boolean;
	provider?: string;
	error?: string;
}> {
	// Check for Ollama first (no API key needed)
	if (process.env.CGR_PROVIDER === "ollama") {
		return { valid: true, provider: "ollama" };
	}

	const preferred = await getPreferredProvider(ctx);

	if (preferred) {
		return { valid: true, provider: preferred.provider };
	}

	// Check if Ollama endpoint is configured
	if (process.env.ORCHESTRATOR_PROVIDER === "ollama" || process.env.CYPHER_PROVIDER === "ollama") {
		return { valid: true, provider: "ollama" };
	}

	return {
		valid: false,
		error: "No LLM API key found. Configure Google, OpenAI, or Anthropic in pi, or use Ollama.",
	};
}
