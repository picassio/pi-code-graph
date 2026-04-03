---
name: code-graph-rag
description: Query and understand codebase structure using a code knowledge graph. Use when you need to understand code relationships, find callers/callees, analyze dependencies before refactoring, or search code by meaning. Always run index_repository first to ensure the graph is up to date.
---

# Code Graph RAG

A code knowledge graph is available for understanding codebase structure, relationships, and dependencies.

## Critical: Always Index First

**Before using ANY query tool, run `index_repository` first.** This ensures the graph reflects the latest code. The update is incremental — only changed files are re-processed, so it's fast.

```
Step 1: index_repository              ← ALWAYS do this first
Step 2: query_code_graph / semantic_code_search / analyze_code_dependencies
```

Do NOT skip indexing. Do NOT query first and index later. Index first, then query.

## Workflow

### Understanding Code Structure

```
1. index_repository                                    # Update graph
2. query_code_graph("What classes exist?")             # Find components
3. get_code_from_graph("project.module.ClassName")     # Read source
```

### Before Refactoring

```
1. index_repository                                    # Update graph
2. analyze_code_dependencies(target="functionName")    # Find all callers
3. get_code_from_graph for each caller                 # Read affected code
4. Make changes knowing the full blast radius
```

### Finding Code by Meaning

```
1. index_repository                                    # Update graph
2. semantic_code_search("handles authentication")      # Vector search
3. get_code_from_graph for top results                 # Read source
```

## Available Tools

| Tool | Purpose |
|------|---------|
| `index_repository` | Update the code graph (run first!) |
| `query_code_graph` | Natural language → Cypher → graph results |
| `semantic_code_search` | Find code by what it does (vector search) |
| `analyze_code_dependencies` | Find callers/callees of a function/class |
| `get_code_from_graph` | Get source code by qualified name |
| `list_graph_projects` | List all indexed projects |

## Multi-Project

All projects share one graph. Nodes are prefixed by project name:

```
pi-code-graph.src.services.ServiceManager
pi-squad.src.scheduler.Scheduler
```

To query a specific project, include the prefix:
```
query_code_graph("classes where qualified_name starts with pi-squad")
```

To index another project:
```
index_repository(project_root="/path/to/other-project")
```

## Tips

- Qualified names use dots: `project.folder.file.ClassName.methodName`
- Use `ENDS WITH` or short names for classes: `analyze_code_dependencies(target="Scheduler")`
- Graph has: Function, Method, Class, Interface, Module, File, Folder nodes
- Relationships: CALLS, DEFINES, DEFINES_METHOD, IMPORTS, INHERITS, IMPLEMENTS
- Incremental index is fast (<1s for small changes), always safe to run
