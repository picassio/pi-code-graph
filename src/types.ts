/**
 * Type definitions for pi-code-graph extension
 */

export interface CGRConfig {
	/** Path to cgr binary */
	binary: string;
	/** Project name in the graph */
	projectName: string;
	/** Whether indexing tools are enabled */
	allowIndex: boolean;
	/** Memgraph host */
	memgraphHost: string;
	/** Memgraph port */
	memgraphPort: string;
	/** Request timeout in milliseconds */
	timeout: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface QueryResult {
	results?: ResultItem[];
	output?: string;
	error?: string;
	query_used?: string;
	summary?: string;
}

export interface ResultItem {
	name?: string;
	qualified_name?: string;
	path?: string;
	type?: string;
	labels?: string[];
	start_line?: number;
	end_line?: number;
	docstring?: string;
	source_code?: string;
	file_path?: string;
	score?: number;
}

export interface CodeSnippetResult {
	source_code?: string;
	file_path?: string;
	start_line?: number;
	end_line?: number;
	qualified_name?: string;
	found?: boolean;
	error?: string;
}

export interface ProjectListResult {
	projects?: string[];
	count?: number;
	error?: string;
}

export interface DependencyResult {
	dependents?: ResultItem[];
	dependencies?: ResultItem[];
	target?: string;
	output?: string;
}
