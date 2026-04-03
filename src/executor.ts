/**
 * CGR CLI executor - DEPRECATED
 * 
 * This module is deprecated and kept only for backward compatibility.
 * The extension now uses the native TypeScript library instead of
 * invoking the Python CGR CLI subprocess.
 * 
 * For new code, use the services from ./services.ts instead:
 * - getServiceManager() for access to all services
 * - checkMemgraphConnectivity() for connection testing
 * 
 * @deprecated Use services.ts instead
 */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CGRConfig, ExecResult } from "./types.js";
import { buildCGREnvironment } from "./auth.js";

/**
 * Execute a CGR CLI command (simple version without pi auth)
 * @deprecated Use the native TypeScript library via services.ts instead
 */
export async function execCGRSimple(
	config: CGRConfig,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<ExecResult> {
	console.warn("[pi-code-graph] execCGRSimple is deprecated. Use the native TypeScript library instead.");
	return execCGRWithEnv(config, args, cwd, {
		...process.env,
		MEMGRAPH_HOST: config.memgraphHost,
		MEMGRAPH_PORT: config.memgraphPort,
	}, signal);
}

/**
 * Execute a CGR CLI command with pi authentication
 * @deprecated Use the native TypeScript library via services.ts instead
 */
export async function execCGR(
	config: CGRConfig,
	args: string[],
	cwd: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ExecResult> {
	console.warn("[pi-code-graph] execCGR is deprecated. Use the native TypeScript library instead.");
	const env = await buildCGREnvironment(ctx, config);
	return execCGRWithEnv(config, args, cwd, env, signal);
}

/**
 * Execute a CGR CLI command with custom environment
 * @deprecated Use the native TypeScript library via services.ts instead
 */
function execCGRWithEnv(
	config: CGRConfig,
	args: string[],
	cwd: string,
	env: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(config.binary, args, {
			cwd,
			env,
			signal,
			timeout: config.timeout,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1 });
		});

		proc.on("error", (err) => {
			if (err.name === "AbortError") {
				resolve({ stdout, stderr, code: -1 });
			} else {
				reject(err);
			}
		});
	});
}

/**
 * Parse JSON output from CGR CLI
 * Handles various output formats and extracts JSON
 * 
 * Note: This is still useful for parsing structured output,
 * but the native library returns typed objects directly.
 */
export function parseJSONOutput<T>(output: string): T | null {
	if (!output?.trim()) return null;

	try {
		// Try parsing the whole output first
		return JSON.parse(output.trim()) as T;
	} catch {
		// CGR may output logs before JSON, try to find JSON in the output
		const lines = output.trim().split("\n");

		// Search from the end for JSON
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (line.startsWith("{") || line.startsWith("[")) {
				try {
					// Try to parse from this line to the end
					const jsonStr = lines.slice(i).join("\n");
					return JSON.parse(jsonStr) as T;
				} catch {
					// Try just this line
					try {
						return JSON.parse(line) as T;
					} catch {
						continue;
					}
				}
			}
		}

		return null;
	}
}

/**
 * Check if CGR is available and working
 * 
 * Note: This checks the Python CLI availability.
 * The extension no longer requires the CLI to function,
 * but this is kept for status reporting.
 */
export async function checkCGRAvailable(config: CGRConfig, cwd: string): Promise<{ available: boolean; error?: string; version?: string }> {
	try {
		const result = await execCGRWithEnv(
			config,
			["--version"],
			cwd,
			{ ...process.env },
		);

		if (result.code === 0) {
			const version = result.stdout.trim().split("\n")[0];
			return { available: true, version };
		}

		return {
			available: false,
			error: result.stderr || "CGR exited with non-zero code",
		};
	} catch (err) {
		return {
			available: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Check if Memgraph is reachable
 * @deprecated Use checkMemgraphConnectivity from services.ts instead
 */
export async function checkMemgraphAvailable(config: CGRConfig, cwd: string): Promise<{ available: boolean; error?: string }> {
	console.warn("[pi-code-graph] checkMemgraphAvailable is deprecated. Use checkMemgraphConnectivity from services.ts instead.");
	
	// Try to use the native library first
	try {
		const { checkMemgraphConnectivity } = await import("./services.js");
		return await checkMemgraphConnectivity(
			config.memgraphHost,
			parseInt(config.memgraphPort, 10)
		);
	} catch {
		// Fall back to CLI-based check
		try {
			const result = await execCGRWithEnv(
				config,
				["doctor"],
				cwd,
				{
					...process.env,
					MEMGRAPH_HOST: config.memgraphHost,
					MEMGRAPH_PORT: config.memgraphPort,
				},
			);

			// Doctor returns 0 if all checks pass
			if (result.code === 0) {
				return { available: true };
			}

			// Check if Memgraph-specific check failed
			if (result.stdout.includes("Memgraph") && result.stdout.includes("✗")) {
				return {
					available: false,
					error: "Memgraph not reachable",
				};
			}

			return { available: true };
		} catch (err) {
			return {
				available: false,
				error: err instanceof Error ? err.message : "Unknown error",
			};
		}
	}
}
