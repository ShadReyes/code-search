# cortex-recall

Semantic code & git history search CLI. Primary consumer: Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

- **Multi-language** — TypeScript/TSX/JS/JSX and Python via tree-sitter AST parsing
- **Pluggable embeddings** — Ollama (local, default) or OpenAI-compatible APIs
- **Local + remote storage** — LanceDB on disk, or S3/GCS via URI
- **JSON output** — `--format json` on all read commands for tool integration
- **Git history search** — semantic search over commits, diffs, and cross-referenced code

## Supported Languages

**Code indexing** (`index`, `query`) parses source files with tree-sitter:

- TypeScript / TSX / JS / JSX (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.mts`) — React/NextJS-aware chunking (components, hooks, route handlers, pages, layouts)
- Python (`.py`) — class/decorator-aware chunking

**Git history search** (`git-index`, `git-search`, `explain`) indexes commit messages and diffs — works on any repo regardless of language.

## Prerequisites

**Ollama** (default, local):

```bash
brew install ollama
ollama serve          # or: brew services start ollama
ollama pull nomic-embed-text
```

**OpenAI** (remote — no local dependencies):

Set `OPENAI_API_KEY` in your environment and pass `--provider openai --model text-embedding-3-small` to index commands.

## Installation

```bash
git clone https://github.com/ShadReyes/cortex-recall.git
cd cortex-recall
npm install
```

## CLI Reference

All commands accept `--repo <path>` or use the `CORTEX_RECALL_REPO` env var.

### Index

```bash
# Full re-index (parses all files, embeds, stores)
npx tsx src/index.ts index --full --repo /path/to/monorepo

# Incremental (only changed files since last index)
npx tsx src/index.ts index --repo /path/to/monorepo

# With a specific provider/model
npx tsx src/index.ts index --full --repo /path/to/monorepo \
  --provider openai --model text-embedding-3-small

# With verbose output
npx tsx src/index.ts index --full --repo /path/to/monorepo --verbose
```

### Search

```bash
# Semantic search
npx tsx src/index.ts query "authentication middleware" --repo /path/to/monorepo

# Limit results
npx tsx src/index.ts query "database connection" --repo /path/to/monorepo --limit 10

# Filter by file path prefix
npx tsx src/index.ts query "user model" --repo /path/to/monorepo --filter packages/api/src

# JSON output (for tool consumption)
npx tsx src/index.ts query "auth" --repo /path/to/monorepo --format json
```

### Stats

```bash
npx tsx src/index.ts stats --repo /path/to/monorepo
npx tsx src/index.ts stats --repo /path/to/monorepo --format json
```

### Init Config

```bash
# Generate .cortexrc.json with defaults
npx tsx src/index.ts init --repo /path/to/monorepo
```

## Configuration

Create `.cortexrc.json` at the repo root (or use `cortex-recall init`):

```json
{
  "include": ["**/*.ts", "**/*.tsx", "**/*.py"],
  "exclude": ["node_modules/**", "dist/**", ".next/**"],
  "excludePatterns": ["**/generated/**"],
  "maxFileLines": 2000,
  "indexTests": false,
  "chunkMaxTokens": 8000,
  "embeddingProvider": "ollama",
  "embeddingModel": "nomic-embed-text",
  "embeddingApiKey": "",
  "embeddingBaseUrl": "",
  "embeddingBatchSize": 50,
  "storeUri": "",
  "searchLimit": 5
}
```

| Field | Default | CLI flag | Env var |
|-------|---------|----------|---------|
| `embeddingProvider` | `"ollama"` | `--provider` | — |
| `embeddingModel` | `"nomic-embed-text"` | `--model` | — |
| `embeddingApiKey` | — | — | `OPENAI_API_KEY` |
| `embeddingBaseUrl` | — | — | `OLLAMA_BASE_URL` / `OPENAI_BASE_URL` |
| `storeUri` | local `.lance/` | — | `CORTEX_RECALL_STORE_URI` |

- `excludePatterns` is additive to `exclude`
- `indexTests` controls whether `.test.ts`, `.spec.ts`, `__tests__/` files are indexed

## Architecture

```
src/
  index.ts           CLI entry point (Commander.js)
  types.ts           Core types: CodeChunk, SearchResult, IndexState, Config
  parser.ts          Re-export from lang/typescript (compat)
  chunker.ts         Re-export from lang/typescript (compat)
  store.ts           LanceDB vector store (local or remote URI)
  indexer.ts         Full + incremental code indexing orchestration
  search.ts          Code query embedding + vector search + formatting
  embeddings/
    provider.ts      EmbeddingProvider interface + createProvider() factory
    ollama.ts        OllamaProvider — Ollama /api/embed, prefix support
    openai.ts        OpenAIProvider — OpenAI /v1/embeddings
  lang/
    plugin.ts        LanguagePlugin interface + PluginRegistry
    typescript/      TS/TSX parser, chunker (NextJS rules), vendored WASM grammars
    python/          Python parser, chunker (class/decorator-aware), vendored WASM
  git/
    extractor.ts     Git commit streaming for indexer
    chunker.ts       GitCommitRaw → GitHistoryChunk[] (3 chunk levels)
    enricher.ts      Low-quality commit message enrichment
    indexer.ts       Git history indexing pipeline orchestration
    search.ts        Semantic vector search with metadata filters
    cross-ref.ts     Code ↔ git cross-referencing; explain() returns ExplainResult
```

### Chunking Rules

**Extraction targets** (tree-sitter node types):
- `function_declaration` — standalone functions
- `class_declaration` / `abstract_class_declaration` — classes
- `interface_declaration` — TypeScript interfaces
- `type_alias_declaration` — TypeScript type aliases
- `lexical_declaration` — const/let with arrow functions or function expressions
- `export_statement` — unwrapped to inner declaration
- Python: `function_definition`, `class_definition`, `decorated_definition`

**Chunk type detection:**
- PascalCase + arrow fn / returns JSX → `component`
- `use` prefix + PascalCase → `hook`
- HTTP method name (GET/POST/PUT/DELETE/PATCH) → `route`
- Config files → `config`
- Default → `function`

**NextJS-specific:**
- `**/page.{tsx,ts}` → single file chunk, `framework_role: 'page'`
- `**/layout.{tsx,ts}` → single file chunk, `framework_role: 'layout'`
- `**/route.{ts,tsx}` in api dirs → per-method chunks, `framework_role: 'api_route'`
- `middleware.ts` → file chunk, `framework_role: 'middleware'`

**Small file rule:** Files under 50 lines → single file-level chunk.

**Context:** Every chunk has `// file: <path>` and import lines prepended.

### Embedding

- Default model: `nomic-embed-text` (768 dimensions) via Ollama
- OpenAI option: `text-embedding-3-small` (1536 dimensions) or any compatible model
- Batched in groups of 50 (code) / 20 (git)
- Dimension verified at runtime via probe embed

### Storage

- LanceDB at `cortex-recall/.lance/` (default)
- Remote storage via `storeUri` or `CORTEX_RECALL_STORE_URI` (e.g. `s3://bucket/cortex`)
- Cosine distance for similarity
- State tracked in `cortex-recall/.cortex-recall-state.json`

## Git History Search

Semantic search over git commit history. Indexes commits into a separate LanceDB table and provides vector search with optional metadata filters.

### Chunk Levels

- **commit_summary** — natural language description of each commit (always generated)
- **file_diff** — per-file diff content for each changed file (configurable)

### Git Commands

```bash
# Full git history index
npx tsx src/index.ts git-index --full --repo /path/to/repo

# With a specific provider/model
npx tsx src/index.ts git-index --full --repo /path/to/repo \
  --provider openai --model text-embedding-3-small

# Incremental (new commits since last index)
npx tsx src/index.ts git-index --repo /path/to/repo

# Semantic git search
npx tsx src/index.ts git-search "why did we switch auth providers" --repo /path/to/repo

# Search with filters
npx tsx src/index.ts git-search "auth changes" --after 2025-01-01 --repo /path/to/repo
npx tsx src/index.ts git-search "API updates" --author "John" --type feat --repo /path/to/repo

# JSON output
npx tsx src/index.ts git-search "auth" --repo /path/to/repo --format json

# Git index statistics
npx tsx src/index.ts git-stats --repo /path/to/repo
npx tsx src/index.ts git-stats --repo /path/to/repo --format json

# Combined code + git history search
npx tsx src/index.ts explain "authenticateUser" --repo /path/to/repo
npx tsx src/index.ts explain "authenticateUser" --repo /path/to/repo --format json
```

### The `explain` Command

Bridges code search and git history. For each code match, it finds related commits. Shows both code context and change history in one view — ideal for understanding *what* code does and *why* it was written. Returns an `ExplainResult` struct.

### Git Config Options

Add to `.cortexrc.json`:

```json
{
  "git": {
    "includeFileChunks": true,
    "maxDiffLinesPerFile": 50,
    "enrichLowQualityMessages": true,
    "lowQualityThreshold": 10,
    "skipBotAuthors": ["dependabot", "renovate", "github-actions"],
    "skipMessagePatterns": ["^Merge branch", "lock file"],
    "maxCommits": 0
  }
}
```

### Scaling Notes

- Merge commits are skipped — child commits already cover the same diffs, avoiding massive chunk bloat
- Streams commits via async generators — memory stays flat regardless of repo size
- Batch embedding (20 chunks for git, 50 for code) with progressive flush to LanceDB
- Incremental indexing only processes commits since last index
- All commits are indexed by default; set `maxCommits` to limit for very large repos

## CI/CD

Example: OpenAI embeddings + S3 store + JSON output in a CI pipeline:

```bash
OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }} \
CORTEX_RECALL_STORE_URI=s3://my-bucket/cortex \
  npx tsx src/index.ts index --full --repo . \
    --provider openai --model text-embedding-3-small

npx tsx src/index.ts query "auth middleware" --repo . --format json > results.json
```

## Using with Claude Code

Add to your repo's `CLAUDE.md`:

```markdown
## Semantic Code Search

Search the codebase semantically using the cortex-recall CLI:
  npx tsx ~/cortex-recall/src/index.ts query "<search>" --repo . --format json
  npx tsx ~/cortex-recall/src/index.ts index --repo .
  npx tsx ~/cortex-recall/src/index.ts git-search "<search>" --repo . --format json
  npx tsx ~/cortex-recall/src/index.ts explain "<search>" --repo . --format json

Use `cortex-recall query` before exploring unfamiliar parts of the codebase.
Use `cortex-recall git-search` to understand why code was changed.
Use `cortex-recall explain` for combined code + history context.
Run `cortex-recall index` after significant changes to keep the index fresh.
Run `cortex-recall git-index` after pulling to index new commits.
```

## Troubleshooting

**"Ollama is not running"**
```bash
ollama serve   # or: brew services start ollama
```

**"Model not found"**
```bash
ollama pull nomic-embed-text
```

**"No vector column found"**
The index may be corrupted. Run a full re-index:
```bash
npx tsx src/index.ts index --full --repo /path/to/monorepo
```

**"Not a git repository"**
Ensure you're pointing `--repo` at a directory containing a `.git` folder.

**Slow git indexing**
- Large repos with thousands of commits take time on first index
- Set `"maxCommits": 1000` in config to limit initial indexing
- Disable `"includeFileChunks": false` to skip per-file diffs (fastest)
- Incremental re-indexes are fast after initial index

**Slow indexing**
- Large repos take time on first index. Subsequent incremental indexes are fast.
- Reduce `embeddingBatchSize` if Ollama is running out of memory.
- Increase `exclude` patterns to skip irrelevant files.
