# code-search

Local semantic code search CLI for NextJS monorepos. Primary consumer: Claude Code.

Uses tree-sitter AST parsing, nomic-embed-text embeddings (via Ollama), and LanceDB vector storage.

## Prerequisites

```bash
brew install ollama
ollama serve          # or: brew services start ollama
ollama pull nomic-embed-text
```

## Installation

```bash
git clone https://github.com/ShadReyes/code-search.git
cd code-search
npm install
```

## CLI Reference

All commands accept `--repo <path>` or use the `CODE_SEARCH_REPO` env var.

### Index

```bash
# Full re-index (parses all files, embeds, stores)
npx tsx src/index.ts index --full --repo /path/to/monorepo

# Incremental (only changed files since last index)
npx tsx src/index.ts index --repo /path/to/monorepo

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
```

### Stats

```bash
npx tsx src/index.ts stats --repo /path/to/monorepo
```

### Init Config

```bash
# Generate .code-searchrc.json with defaults
npx tsx src/index.ts init --repo /path/to/monorepo
```

## Configuration

Create `.code-searchrc.json` at the repo root (or use `code-search init`):

```json
{
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules/**", "dist/**", ".next/**"],
  "excludePatterns": ["**/generated/**"],
  "maxFileLines": 2000,
  "indexTests": false,
  "chunkMaxTokens": 8000,
  "embeddingModel": "nomic-embed-text",
  "embeddingBatchSize": 50,
  "searchLimit": 5
}
```

- `excludePatterns` is additive to `exclude`
- `indexTests` controls whether `.test.ts`, `.spec.ts`, `__tests__/` files are indexed

## Architecture

```
src/
  index.ts        CLI entry point (Commander.js)
  types.ts        Core types: CodeChunk, SearchResult, IndexState, Config, Git types
  parser.ts       Tree-sitter WASM initialization + file parsing
  chunker.ts      AST → CodeChunk[] with NextJS-aware extraction
  embedder.ts     Ollama API client (batch embed, health check, prefix support)
  store.ts        LanceDB vector store wrapper (code + git tables)
  indexer.ts      Full + incremental code indexing orchestration
  search.ts       Code query embedding + vector search + formatting
  git/
    extractor.ts  Git command wrappers (log, blame, pickaxe, grep, diff)
    chunker.ts    GitCommitRaw → GitHistoryChunk[] (3 chunk levels)
    enricher.ts   Low-quality commit message enrichment
    indexer.ts     Git history indexing pipeline orchestration
    search.ts     Hybrid query router (5 strategies)
    cross-ref.ts  Code ↔ git history cross-referencing
```

### Chunking Rules

**Extraction targets** (tree-sitter node types):
- `function_declaration` — standalone functions
- `class_declaration` / `abstract_class_declaration` — classes
- `interface_declaration` — TypeScript interfaces
- `type_alias_declaration` — TypeScript type aliases
- `lexical_declaration` — const/let with arrow functions or function expressions
- `export_statement` — unwrapped to inner declaration

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

- Model: `nomic-embed-text` (768 dimensions)
- Batched in groups of 50 via Ollama `/api/embed`
- Dimension verified at runtime via probe embed

### Storage

- LanceDB at `code-search/.lance/`
- Cosine distance for similarity
- State tracked in `code-search/.code-search-state.json`

## Git History Search

Semantic search over git commit history. Indexes commits into a separate LanceDB table and provides hybrid search across 5 strategies.

### Chunk Levels

- **commit_summary** — natural language description of each commit (always generated)
- **file_diff** — per-file diff content for each changed file (configurable)
- **merge_group** — aggregated merge commit summaries (configurable)

### Git Commands

```bash
# Full git history index
npx tsx src/index.ts git-index --full --repo /path/to/repo

# Incremental (new commits since last index)
npx tsx src/index.ts git-index --repo /path/to/repo

# Semantic git search
npx tsx src/index.ts git-search "why did we switch auth providers" --repo /path/to/repo

# Search with filters
npx tsx src/index.ts git-search "auth changes" --after 2025-01-01 --repo /path/to/repo
npx tsx src/index.ts git-search "API updates" --author "John" --type feat --repo /path/to/repo

# Line-level blame
npx tsx src/index.ts git-blame src/auth/login.ts 45 60 --repo /path/to/repo

# Find when a string was introduced
npx tsx src/index.ts git-pickaxe "getUserById" --repo /path/to/repo

# Git index statistics
npx tsx src/index.ts git-stats --repo /path/to/repo

# Combined code + git history search (the killer feature)
npx tsx src/index.ts explain "authenticateUser" --repo /path/to/repo
```

### Query Router Strategies

The git search automatically classifies queries:

| Strategy | Trigger Examples | What It Does |
|----------|-----------------|--------------|
| `vector` | "why did we...", general questions | Semantic vector search |
| `temporal_vector` | "recently", "last month", "since 2025" | Vector search + date filter |
| `pickaxe` | "when was X introduced" | `git log -S` + LanceDB lookup |
| `blame` | "who wrote", "blame" | `git blame` + LanceDB lookup |
| `structured_git` | "what changed in", "commits by" | File/author filters + grep |

### The `explain` Command

Bridges code search and git history. For each code match, it finds related commits. Shows both code context and change history in one view — ideal for understanding *what* code does and *why* it was written.

### Git Config Options

Add to `.code-searchrc.json`:

```json
{
  "git": {
    "includeFileChunks": true,
    "includeMergeGroups": true,
    "maxDiffLinesPerFile": 200,
    "enrichLowQualityMessages": true,
    "lowQualityThreshold": 10,
    "skipBotAuthors": ["dependabot", "renovate", "github-actions"],
    "skipMessagePatterns": ["^Merge branch", "lock file"],
    "maxCommits": 0
  }
}
```

### Scaling Notes

- Streams commits via async generators — memory stays flat regardless of repo size
- Batch embedding (50 chunks) with progressive flush to LanceDB
- Incremental indexing only processes commits since last index
- `maxCommits` can limit initial indexing for very large repos

## Using with Claude Code

Add to your monorepo's `CLAUDE.md`:

```markdown
## Semantic Code Search

Search the codebase semantically using the code-search CLI:
  npx tsx ~/code-search/src/index.ts query "<search>" --repo .
  npx tsx ~/code-search/src/index.ts index --repo .
  npx tsx ~/code-search/src/index.ts git-search "<search>" --repo .
  npx tsx ~/code-search/src/index.ts explain "<search>" --repo .

Use `code-search query` before exploring unfamiliar parts of the codebase.
Use `code-search git-search` to understand why code was changed.
Use `code-search explain` for combined code + history context.
Run `code-search index` after significant changes to keep the index fresh.
Run `code-search git-index` after pulling to index new commits.
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
- Set `"maxCommits": 5000` in config to limit initial indexing
- Disable `"includeFileChunks": false` to skip per-file diffs (fastest)
- Incremental re-indexes are fast after initial index

**Slow indexing**
- Large repos take time on first index. Subsequent incremental indexes are fast.
- Reduce `embeddingBatchSize` if Ollama is running out of memory.
- Increase `exclude` patterns to skip irrelevant files.
