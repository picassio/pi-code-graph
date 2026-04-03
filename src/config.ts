/**
 * Configuration management for pi-code-graph
 */

import { basename } from "node:path";
import type { CGRConfig } from "./types.js";

/**
 * Default configuration values
 */
const DEFAULTS = {
	binary: "cgr",
	memgraphHost: "localhost",
	memgraphPort: "7687",
	timeout: 120000, // 2 minutes
	allowIndex: false,
} as const;

/**
 * Get configuration from environment variables and defaults
 */
export function getConfig(cwd: string): CGRConfig {
	return {
		binary: process.env.CGR_BINARY || DEFAULTS.binary,
		projectName: process.env.CGR_PROJECT_NAME || basename(cwd),
		allowIndex: process.env.CGR_ALLOW_INDEX === "true",
		memgraphHost: process.env.MEMGRAPH_HOST || DEFAULTS.memgraphHost,
		memgraphPort: process.env.MEMGRAPH_PORT || DEFAULTS.memgraphPort,
		timeout: parseInt(process.env.CGR_TIMEOUT || String(DEFAULTS.timeout), 10),
	};
}

/**
 * Environment variable documentation
 */
export const ENV_DOCS = {
	CGR_BINARY: "Path to cgr binary (default: 'cgr')",
	CGR_PROJECT_NAME: "Project name in the graph (default: current directory name)",
	CGR_ALLOW_INDEX: "Set to 'true' to enable indexing tools (default: false)",
	CGR_TIMEOUT: "Request timeout in milliseconds (default: 120000)",
	MEMGRAPH_HOST: "Memgraph host (default: 'localhost')",
	MEMGRAPH_PORT: "Memgraph port (default: '7687')",
} as const;
