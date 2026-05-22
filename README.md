# pi-code-graph

A native TypeScript extension for [pi-coding-agent](https://github.com/earendil-works/pi) that builds and queries **code knowledge graphs** — enabling AI agents to understand codebase structure, relationships, and dependencies before making changes.

Ported from [code-graph-rag](https://github.com/picassio/code-graph-rag) (Python) to pure TypeScript. No Python dependency required.

## What It Does

```
You: "What functions call UserService.create_user?"
Pi:  → query_code_graph → Cypher → Memgraph
     → AuthController.register(), AdminAPI.bulk_create(), tests/test_users.py::test_create()

You: "What would break if I change validate_input?"
Pi:  → analyze_code_dependencies → finds all callers
     → 12 functions across 5 modules depend on validate_input()

You: "Find code that handles email validation"
Pi:  → semantic_code_search → embedding → zvec HNSW search
     → utils/validators.py::validate_email(), models/user.py::User.set_email()
```

## Features

- **Natural Language Queries** — Ask about code structure, relationships, call graphs via LLM-generated Cypher
- **Semantic Code Search** — Find code by meaning using vector embeddings ([zvec](https://github.com/alibaba/zvec) HNSW index)
- **Dependency Analysis** — Understand callers, callees, and blast radius before refactoring
- **Source Retrieval** — Get source code by qualified name directly from the graph
- **Multi-Language** — Python, TypeScript, JavaScript, Java, Rust, Go, C++, C#, PHP (via tree-sitter WASM)
- **Incremental Indexing** — SHA-256 file hashing, only re-parses changed files and re-embeds changed functions
- **Multi-Project** — Index and query multiple projects in one Memgraph instance
- **Auto-Auth** — Uses pi's OAuth/API keys automatically (OpenRouter, Google, OpenAI, Anthropic)
- **Read-Only by Default** — Safe for multi-agent environments; indexing must be explicitly enabled

## Quick Start

### 1. Install

```bash
# As a pi package
npm install pi-code-graph

# Or clone for development
git clone https://github.com/picassio/pi-code-graph
```

### 2. Setup

```bash
pi
/cgs setup    # Guided wizard: starts Memgraph, configures LLM, indexes repo
```

Or manually:
```bash
/cgs docker start    # Start Memgraph via Docker Compose
/cgs config          # Configure LLM provider + embedding model
/cgs index           # Index the current repository
```

### 3. Query

The agent automatically uses the graph tools. You can also query directly:
```bash
/cgs query "What classes inherit from BaseService?"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      pi-code-graph                          │
│                                                             │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │  Tree-sitter   │  │  LLM Service   │  │  Embedding   │  │
│  │  (WASM)        │  │ (Cypher gen)   │  │  Service     │  │
│  │                │  │                │  │              │  │
│  │ Parse → AST →  │  │ NL → Cypher   │  │ Code →       │  │
│  │ graph nodes    │  │ via OpenRouter │  │ vectors      │  │
│  └───────┬────────┘  └───────┬────────┘  └──────┬───────┘  │
│          │                   │                   │          │
│          ▼                   ▼                   ▼          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Memgraph (Bolt protocol)                │   │
│  │  Nodes: Project, Module, Class, Function, Method     │   │
│  │  Edges: CALLS, IMPORTS, INHERITS, DEFINES,           │   │
│  │         DEFINES_METHOD, CONTAINS                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           zvec (in-process vector DB)                │   │
│  │  HNSW index, cosine similarity, per-project storage  │   │
│  │  ~/.cgs/vectors/{project}/                           │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Graph Schema

**Nodes:**
- `Project` — top-level project container
- `Package` — language package (e.g., npm package, Python package)
- `Module` — source file as a module
- `File`, `Folder` — file system structure
- `Class`, `Interface`, `Enum`, `Type` — type definitions
- `Function`, `Method` — callable code elements
- `ExternalPackage` — third-party dependencies

**Relationships:**
- `CALLS` — function/method call edges (resolved via AST + type inference)
- `DEFINES` — module defines a function/class
- `DEFINES_METHOD` — class defines a method
- `IMPORTS` — module imports from another module
- `INHERITS` — class extends another class
- `IMPLEMENTS` — class implements an interface
- `CONTAINS_*` — structural containment (project→package→folder→file→module)
- `DEPENDS_ON_EXTERNAL` — dependency on third-party package

### Indexing Pipeline

1. **File scan** — walks project, hashes files (SHA-256), compares against `~/.cgs/cache/{project}.json`
2. **Tree-sitter** — parses changed files into ASTs (9 languages via WASM)
3. **Definition extraction** — extracts Classes, Functions, Methods, Interfaces, Enums, Types
4. **Call resolution** — resolves function calls to qualified names (handles `this.method()`, imports, builtins)
5. **Graph write** — batched upserts to Memgraph via Bolt protocol (sequential to avoid transaction conflicts)
6. **Embedding generation** — generates vectors for changed functions via OpenRouter/OpenAI API
7. **Vector storage** — upserts into zvec HNSW index at `~/.cgs/vectors/{project}/`

### Query Pipeline

1. User asks a natural language question
2. **LLM** generates a read-only Cypher query (validated against dangerous keywords)
3. Cypher executes against **Memgraph**
4. Results formatted and returned to the agent

### Semantic Search Pipeline

1. User describes what code does (e.g., "handles authentication")
2. **Embedding Service** generates a query vector
3. **zvec** performs HNSW nearest-neighbor search (cosine similarity)
4. Results enriched with source code from disk

## Tools

Pi automatically discovers and uses these tools:

| Tool | Description | When the Agent Uses It |
|------|-------------|----------------------|
| `query_code_graph` | Natural language → Cypher → graph results | Understanding structure, relationships, call graphs |
| `semantic_code_search` | Vector similarity search by meaning | Finding code by what it does, not by name |
| `analyze_code_dependencies` | Callers/callees/blast radius analysis | Before refactoring — know what would break |
| `get_code_from_graph` | Retrieve source code by qualified name | After finding items via query, read the actual code |
| `list_graph_projects` | List all indexed projects | Checking what's available to query |
| `index_repository` | Index/update the code graph | Keeping the graph up to date after code changes |

### System Prompt Integration

The extension injects context into pi's system prompt so the agent:
- Knows the current project and available tools
- Runs `index_repository` before querying if code has changed (incremental, fast)
- Uses qualified name prefixes for cross-project queries
- Checks dependencies before suggesting refactors

## Incremental Updates

The indexer tracks file changes via SHA-256 hashes stored at `~/.cgs/cache/{project}.json`.

| What | Full Index | Incremental Update |
|------|-----------|-------------------|
| File scan | Hash all files | Hash all files |
| Parsing | All source files | Only changed/new files |
| Graph | Delete project + recreate | Delete changed modules + recreate |
| Embeddings | All functions | Only functions from changed files |
| Deleted files | N/A | Removed from graph automatically |

```bash
/cgs index           # Incremental (fast — only changed files)
/cgs index --clean   # Full re-index (delete + rebuild everything)
```

## Multi-Project Support

All projects share one Memgraph instance, separated by qualified name prefixes:

```
pi-code-graph.src.services.ServiceManager    → project: pi-code-graph
pi-squad.src.scheduler.Scheduler             → project: pi-squad
```

Each project gets isolated storage:
```
~/.cgs/
├── config.toml                    # Global settings
├── cgs.log                        # Log file (no console output)
├── cache/
│   ├── pi-code-graph.json         # Hash cache
│   └── pi-squad.json
├── docker/
│   └── docker-compose.yml         # Memgraph compose
└── vectors/
    ├── pi-code-graph/             # zvec HNSW index
    └── pi-squad/
```

Index any project from anywhere:
```bash
# Index current directory
/cgs index

# Index a different project
index_repository(project_root="/path/to/other-project")
```

Query across projects:
```
query_code_graph("classes where qualified_name starts with pi-squad")
analyze_code_dependencies(target="Scheduler")   # finds it in pi-squad
```

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/cgs` | | Interactive menu |
| `/cgs setup` | | Guided first-time setup (Docker, LLM, indexing) |
| `/cgs config` | `/cgs c` | Configure LLM provider, embedding, Memgraph |
| `/cgs status` | `/cgs s` | Check service availability |
| `/cgs query <q>` | `/cgs q` | Quick graph query |
| `/cgs index` | `/cgs i` | Index/update current repository |
| `/cgs docker` | `/cgs d` | Manage Memgraph container (start/stop/restart/logs) |
| `/cgs logs` | `/cgs l` | View extension log file |
| `/cgs help` | `/cgs h` | Show help |

## Configuration

### Authentication (Automatic)

pi-code-graph uses pi's existing auth — no separate API keys needed. If you're logged in via `/login`, it works automatically.

Provider priority: **OpenRouter → Google → OpenAI → Anthropic → Ollama**

Configure via `/cgs config` or edit `~/.cgs/config.toml`:

```toml
[llm]
source = "auto"
auto_provider = "openrouter"
auto_model = "google/gemini-2.0-flash-001"

[embedding]
source = "auto"
auto_provider = "openrouter"
auto_model = "openai/text-embedding-3-small"

[memgraph]
host = "localhost"
port = "7687"

[project]
allow_index = true
```

### Docker (Memgraph)

The extension manages Memgraph via Docker Compose (`~/.cgs/docker/docker-compose.yml`):

- **memgraph/memgraph-mage** — graph database (port 7687)
- **memgraph/lab** — web UI at http://localhost:23000 (port 23000)

```bash
/cgs docker start    # Start both containers
/cgs docker stop     # Stop (data preserved in Docker volumes)
/cgs docker logs     # View Memgraph logs
```

## Supported Languages

| Language | Extensions | WASM Grammar |
|----------|-----------|-------------|
| Python | `.py` | tree-sitter-python |
| TypeScript | `.ts`, `.tsx` | tree-sitter-typescript |
| JavaScript | `.js`, `.jsx`, `.mjs` | tree-sitter-javascript |
| Java | `.java` | tree-sitter-java |
| Rust | `.rs` | tree-sitter-rust |
| Go | `.go` | tree-sitter-go |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | tree-sitter-cpp |
| C# | `.cs` | tree-sitter-c-sharp |
| PHP | `.php` | tree-sitter-php |

All grammars loaded via `@vscode/tree-sitter-wasm` — no native compilation needed.

## Safety: Read-Only by Default

Indexing is **disabled by default**. Agents can query the graph but cannot modify it.

Enable via:
- `/cgs config` → Project Settings → Enable Indexing
- `/cgs setup` (offers to enable during guided setup)
- `CGR_ALLOW_INDEX=true` environment variable

This is intentional for multi-agent environments where you want a stable graph.

## Development

```bash
npm install          # Install dependencies
npm run check        # Type check (tsc --noEmit)
npm test             # Run tests (289 tests)
npm run test:watch   # Watch mode

# Link for local development with pi
# Add to ~/.pi/agent/settings.json packages:
#   "../../path/to/pi-code-graph"
```

## Tech Stack

- **[Memgraph](https://memgraph.com/)** — in-memory graph database (Bolt protocol)
- **[zvec](https://github.com/alibaba/zvec)** — in-process vector database (HNSW, by Alibaba)
- **[web-tree-sitter](https://github.com/nicolo-ribaudo/tree-sitter-wasm-build)** — WASM-based code parsing
- **[neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver)** — Bolt protocol client
- **[@vscode/tree-sitter-wasm](https://github.com/nicolo-ribaudo/vscode-tree-sitter-wasm)** — pre-built WASM grammars

## License

MIT

## Credits

- [code-graph-rag](https://github.com/vitali87/code-graph-rag) by [@vitali87](https://github.com/vitali87) — original code-graph-rag concept and implementation
- [code-graph-rag](https://github.com/picassio/code-graph-rag) by [@picassio](https://github.com/picassio) — enhanced Python implementation (forked from vitali87)
- [pi-coding-agent](https://github.com/earendil-works/pi) — the coding agent platform
- [zvec](https://github.com/alibaba/zvec) — vector database engine
