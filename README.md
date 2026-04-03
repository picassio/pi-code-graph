# pi-code-graph

A native TypeScript extension for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) that builds and queries **code knowledge graphs** — enabling AI agents to understand codebase structure, relationships, and dependencies.

Ported from [code-graph-rag](https://github.com/picassio/code-graph-rag) (Python) to pure TypeScript. No Python dependency required.

## What It Does

```
You: "What functions call UserService.create_user?"
Pi:  Uses query_code_graph → generates Cypher → queries Memgraph
     → Returns: AuthController.register(), AdminAPI.bulk_create(), tests/test_users.py::test_create()

You: "What would break if I change validate_input?"
Pi:  Uses analyze_code_dependencies → finds all callers
     → Returns: 12 functions across 5 modules depend on validate_input()

You: "Find code that handles email validation"
Pi:  Uses semantic_code_search → vector similarity search
     → Returns: utils/validators.py::validate_email(), models/user.py::User.set_email()
```

## Features

- **🔍 Natural Language Queries** — Ask about code structure, relationships, call graphs
- **🧠 Semantic Search** — Find code by meaning using embeddings (OpenAI/OpenRouter)
- **🕸️ Dependency Analysis** — Understand callers, callees, and blast radius before refactoring
- **📄 Source Retrieval** — Get source code by qualified name from the graph
- **🌳 Multi-Language** — Python, TypeScript, JavaScript, Java, Rust, Go, C, C++ (via tree-sitter WASM)
- **⚡ Incremental Indexing** — SHA-256 file hashing, only re-parses changed files
- **🔐 Auto-Auth** — Uses pi's OAuth/API keys automatically (Anthropic, Google, OpenAI, OpenRouter)
- **🐳 Docker Auto-Start** — Memgraph starts automatically with secure password generation
- **🔒 Read-Only by Default** — Safe for multi-agent environments

## Quick Start

```bash
# Install the extension
npm install pi-code-graph

# Start pi — Memgraph auto-starts if Docker is available
pi

# Configure (picks up your existing pi auth automatically)
/cgs config

# Index your repository
/cgs index

# Query!
/cgs query "What classes inherit from BaseService?"
```

Or clone directly:

```bash
git clone https://github.com/picassio/pi-code-graph ~/.pi/agent/extensions/pi-code-graph
cd ~/.pi/agent/extensions/pi-code-graph && npm install
```

## How It Works

```
┌────────────────────────────────────────────────────────────────┐
│                        pi-code-graph                           │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │   Tree-sitter    │  │   LLM Service    │  │  Embedding  │  │
│  │   (WASM)         │  │  (Cypher gen)    │  │  Service    │  │
│  │                  │  │                  │  │             │  │
│  │  Parse code →    │  │  NL → Cypher     │  │  Code →     │  │
│  │  AST → Graph     │  │  via Claude/     │  │  Vectors    │  │
│  │  nodes & edges   │  │  Gemini/GPT      │  │  (OpenAI)   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬──────┘  │
│           │                     │                    │         │
│           ▼                     ▼                    ▼         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Memgraph (Bolt)                      │   │
│  │  Nodes: Project, Module, Class, Function, Method, ...  │   │
│  │  Edges: CALLS, IMPORTS, INHERITS, DEFINES, CONTAINS    │   │
│  └─────────────────────────────────────────────────────────┘   │
│           │                                      │             │
│  ┌────────┴──────────┐              ┌────────────┴──────────┐  │
│  │  Graph Queries    │              │  Vector Store (zvec)  │  │
│  │  (Cypher)         │              │  (~/.cgr/vectors)     │  │
│  └───────────────────┘              └───────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### Indexing Pipeline

1. **Tree-sitter** parses source files into ASTs (8 languages via WASM)
2. **Graph Updater** extracts nodes (functions, classes, modules) and edges (calls, imports, inherits)
3. Writes to **Memgraph** via Bolt protocol (neo4j-driver)
4. **Embedding Service** generates vectors for semantic search (OpenAI text-embedding-3-small)
5. Vectors stored in **zvec** (embedded HNSW index at `~/.cgr/vectors`)

### Query Pipeline

1. User asks a natural language question
2. **LLM Service** generates a Cypher query (using schema context + examples)
3. Cypher runs against **Memgraph**
4. Results formatted and returned to the agent

## Tools (LLM-Callable)

Pi automatically discovers and uses these tools:

| Tool | Description | When Pi Uses It |
|------|-------------|-----------------|
| `query_code_graph` | Natural language → Cypher → graph results | Understanding code structure, relationships, call graphs |
| `get_code_from_graph` | Get source code by qualified name | After finding items via query, to see actual code |
| `semantic_code_search` | Vector similarity search by meaning | Finding code by what it does, not its name |
| `analyze_code_dependencies` | Callers/callees analysis | Before refactoring, to understand blast radius |
| `list_graph_projects` | List indexed projects | Checking what's been indexed |
| `index_repository` | Index/update the code graph | Setting up or refreshing the graph (must be enabled) |

### Pi Knows the Workflow

The extension injects context into pi's system prompt, so pi knows:
- Whether the graph is set up or needs initialization
- How to guide you through setup (`/cgs docker start` → `/cgs config` → index)
- When to use graph tools vs regular file search
- To check dependencies before suggesting refactors

## Commands

Single `/cgs` command with subcommands:

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/cgs config` | `/cgs c` | Interactive configuration (provider, model, embedding) |
| `/cgs status` | `/cgs s` | Check Memgraph, LLM, embedding availability |
| `/cgs query <q>` | `/cgs q` | Quick query from the command line |
| `/cgs index` | `/cgs i` | Index/update current repository |
| `/cgs docker` | `/cgs d` | Manage Memgraph container |
| `/cgs clear` | | Clear results widget |
| `/cgs help` | `/cgs h` | Show help |

### Docker Subcommands

```bash
/cgs docker status    # Show Docker/Memgraph status
/cgs docker start     # Start Memgraph (auto-generates password)
/cgs docker stop      # Stop Memgraph (data preserved)
/cgs docker restart   # Restart Memgraph
/cgs docker logs      # View Memgraph logs
```

## Configuration

### Authentication (Automatic)

**pi-code-graph uses pi's existing auth** — no separate API keys needed.

If you're logged in to any provider via pi's `/login`, it's automatically available:

| Provider | Auth Method | Default Model (LLM) |
|----------|-------------|---------------------|
| Anthropic | OAuth or API key | `claude-sonnet-4-20250514` |
| Google | API key | `gemini-2.0-flash` |
| OpenRouter | API key | `google/gemini-2.0-flash-001` |
| OpenAI | API key | `gpt-4o-mini` |
| Ollama | None (local) | `codellama` |

You can choose which provider and model to use via `/cgs config`:

```
/cgs config → 🤖 LLM Provider → 🔄 Auto
  → Choose Provider: anthropic 🔰 OAuth
  → Choose Model: claude-sonnet-4-20250514
```

### Config File

Settings persist to `~/.cgr/config.toml`:

```toml
[llm]
source = "auto"
auto_provider = "anthropic"
auto_model = "claude-sonnet-4-20250514"

[embedding]
source = "auto"
auto_provider = "openai"
auto_model = "text-embedding-3-small"

[memgraph]
host = "localhost"
port = "7687"
user = "memgraph"
password = "xK9mL2pQrS5tU8vW"  # Auto-generated on first start

[project]
allow_index = false
```

### Embedding Models

Embeddings power semantic code search. Configure via `/cgs config → Embedding`:

| Mode | Provider | How |
|------|----------|-----|
| **Auto** | Uses pi's auth | OpenAI or OpenRouter from pi's login |
| **Manual** | OpenAI, OpenRouter, Ollama | Enter your own API key |

Default model: `text-embedding-3-small` (1536 dimensions, fast, good quality)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CGR_ALLOW_INDEX` | `false` | Enable indexing tools for agents |
| `CGR_PROJECT_NAME` | `<dirname>` | Project name in the graph |
| `MEMGRAPH_HOST` | `localhost` | Memgraph host |
| `MEMGRAPH_PORT` | `7687` | Memgraph port |

## Safety: Read-Only by Default

Indexing tools are **disabled by default**. This means agents can query the graph but cannot modify it.

Enable indexing via:
- `/cgs config` → Project Settings → Enable Indexing
- Or: `CGR_ALLOW_INDEX=true`

This is intentional for multi-agent environments where you want a stable graph indexed by CI/CD.

## Multi-Agent Setup

```
┌─────────────────────────────────────────────────┐
│                CI/CD Pipeline                    │
│  index_repository on merge → Memgraph           │
└──────────────────────┬──────────────────────────┘
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ Agent 1 │    │ Agent 2 │    │ Agent 3 │
  │ READ    │    │ READ    │    │ READ    │
  │ ONLY    │    │ ONLY    │    │ ONLY    │
  └─────────┘    └─────────┘    └─────────┘
```

## Supported Languages

| Language | File Extensions | Parser |
|----------|----------------|--------|
| Python | `.py` | tree-sitter-python |
| TypeScript | `.ts`, `.tsx` | tree-sitter-typescript |
| JavaScript | `.js`, `.jsx`, `.mjs` | tree-sitter-javascript |
| Java | `.java` | tree-sitter-java |
| Rust | `.rs` | tree-sitter-rust |
| Go | `.go` | tree-sitter-go |
| C | `.c`, `.h` | tree-sitter-c |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | tree-sitter-cpp |

## Development

```bash
# Install dependencies
npm install

# Type check
npm run check

# Run tests (289 tests)
npm test

# Watch mode
npm run test:watch
```

## Troubleshooting

### "Memgraph not reachable"

```bash
# Auto-start via extension
/cgs docker start

# Or manually
docker run -d --name cgr-memgraph -p 7687:7687 -p 3000:3000 memgraph/memgraph-platform
```

### "No results found"

The repository needs to be indexed first:
```bash
/cgs config    # Enable indexing under Project Settings
/cgs index     # Index the repository
```

### "Indexing is disabled"

This is by design. Enable via `/cgs config` → Project Settings → Enable Indexing.

### Query returns wrong results

The LLM generates Cypher queries from natural language. Try:
- Being more specific: "Find functions named `validate_*` in the auth module"
- Using semantic search for fuzzy queries: "find email validation code"
- Running `/cgs status` to check which LLM model is being used

## Tech Stack

- **[web-tree-sitter](https://github.com/nicolo-ribaudo/tree-sitter-wasm-build)** — WASM-based code parsing (8 languages)
- **[neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver)** — Bolt protocol for Memgraph
- **[zvec](https://github.com/nicolo-ribaudo/zvec)** — Embedded HNSW vector index
- **[Memgraph](https://memgraph.com/)** — In-memory graph database

## License

MIT

## Credits

- [code-graph-rag](https://github.com/picassio/code-graph-rag) by [@picassio](https://github.com/picassio) — Original Python implementation
- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — The coding agent platform
