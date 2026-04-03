/**
 * Output formatters for pi-code-graph
 */

import type { ResultItem, CodeSnippetResult, DependencyResult } from "./types.js";

/**
 * Format query results for display
 */
export function formatResults(results: ResultItem[], query: string, maxResults = 20): string {
	if (!results || results.length === 0) {
		return `No results found for query: "${query}"`;
	}

	const lines: string[] = [`Found ${results.length} result(s):\n`];

	for (const result of results.slice(0, maxResults)) {
		const name = result.qualified_name || result.name || result.path || "unknown";
		const type = formatType(result);

		lines.push(`• ${name}${type ? ` (${type})` : ""}`);

		if (result.path) {
			lines.push(`  📁 ${result.path}`);
		}
		if (result.start_line) {
			const lineInfo = result.end_line ? `${result.start_line}-${result.end_line}` : String(result.start_line);
			lines.push(`  📍 Lines: ${lineInfo}`);
		}
		if (result.score !== undefined) {
			lines.push(`  📊 Score: ${(result.score * 100).toFixed(1)}%`);
		}
		if (result.docstring) {
			const doc = result.docstring.length > 100 ? result.docstring.slice(0, 100) + "..." : result.docstring;
			lines.push(`  📝 ${doc}`);
		}
		lines.push("");
	}

	if (results.length > maxResults) {
		lines.push(`... and ${results.length - maxResults} more results`);
	}

	return lines.join("\n");
}

/**
 * Format a single result item type
 */
function formatType(result: ResultItem): string {
	if (result.type) return result.type;
	if (result.labels && result.labels.length > 0) {
		return result.labels.join(", ");
	}
	return "";
}

/**
 * Format code snippet result
 */
export function formatCodeSnippet(result: CodeSnippetResult, qualifiedName: string): string {
	if (result.error) {
		return `Error: ${result.error}`;
	}

	if (!result.source_code) {
		return `No source code found for: ${qualifiedName}`;
	}

	const lines: string[] = [];

	// Header
	lines.push(`# ${qualifiedName}`);
	if (result.file_path) {
		lines.push(`# File: ${result.file_path}`);
	}
	if (result.start_line) {
		const lineInfo = result.end_line ? `${result.start_line}-${result.end_line}` : String(result.start_line);
		lines.push(`# Lines: ${lineInfo}`);
	}
	lines.push("");

	// Source code
	lines.push(result.source_code);

	return lines.join("\n");
}

/**
 * Format dependency analysis result
 */
export function formatDependencies(result: DependencyResult, target: string): string {
	const lines: string[] = [`Dependency Analysis: ${target}\n`];

	if (result.dependents && result.dependents.length > 0) {
		lines.push(`\n## Dependents (${result.dependents.length} items call/use this):\n`);
		for (const dep of result.dependents.slice(0, 15)) {
			const name = dep.qualified_name || dep.name || "unknown";
			lines.push(`  ← ${name}`);
		}
		if (result.dependents.length > 15) {
			lines.push(`  ... and ${result.dependents.length - 15} more`);
		}
	}

	if (result.dependencies && result.dependencies.length > 0) {
		lines.push(`\n## Dependencies (${result.dependencies.length} items this calls/uses):\n`);
		for (const dep of result.dependencies.slice(0, 15)) {
			const name = dep.qualified_name || dep.name || "unknown";
			lines.push(`  → ${name}`);
		}
		if (result.dependencies.length > 15) {
			lines.push(`  ... and ${result.dependencies.length - 15} more`);
		}
	}

	if ((!result.dependents || result.dependents.length === 0) && (!result.dependencies || result.dependencies.length === 0)) {
		if (result.output) {
			return result.output;
		}
		lines.push("No dependencies found.");
	}

	return lines.join("\n");
}

/**
 * Format project list
 */
export function formatProjectList(projects: string[]): string {
	if (!projects || projects.length === 0) {
		return "No projects indexed in the graph.";
	}

	const lines = [
		`Indexed Projects (${projects.length}):\n`,
		...projects.map((p) => `  • ${p}`),
	];

	return lines.join("\n");
}

/**
 * Format status output
 */
export function formatStatus(config: {
	binary: string;
	projectName: string;
	memgraphHost: string;
	memgraphPort: string;
	allowIndex: boolean;
	available: boolean;
	version?: string;
	error?: string;
}): string {
	const lines = [
		"Code Graph RAG Status",
		"═════════════════════",
		"",
		`Binary:     ${config.binary}`,
		`Version:    ${config.version || "unknown"}`,
		`Available:  ${config.available ? "✓ Yes" : "✗ No"}`,
		"",
		`Project:    ${config.projectName}`,
		`Memgraph:   ${config.memgraphHost}:${config.memgraphPort}`,
		`Indexing:   ${config.allowIndex ? "✓ Enabled" : "✗ Disabled (read-only)"}`,
	];

	if (!config.available && config.error) {
		lines.push("", `Error: ${config.error}`);
	}

	return lines.join("\n");
}
