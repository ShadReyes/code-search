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
  index.ts      CLI entry point (Commander.js)
  types.ts      Core types: CodeChunk, SearchResult, IndexState, Config
  parser.ts     Tree-sitter WASM initialization + file parsing
  chunker.ts    AST → CodeChunk[] with NextJS-aware extraction
  embedder.ts   Ollama API client (batch embed, health check)
  store.ts      LanceDB vector store wrapper
  indexer.ts    Full + incremental indexing orchestration
  search.ts     Query embedding + vector search + formatting
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

## Using with Claude Code

Add to your monorepo's `CLAUDE.md`:

```markdown
## Semantic Code Search

Search the codebase semantically using the code-search CLI:
  npx tsx ~/code-search/src/index.ts query "<search>" --repo .
  npx tsx ~/code-search/src/index.ts index --repo .

Use `code-search query` before exploring unfamiliar parts of the codebase.
Run `code-search index` after significant changes to keep the index fresh.
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

**Slow indexing**
- Large repos take time on first index. Subsequent incremental indexes are fast.
- Reduce `embeddingBatchSize` if Ollama is running out of memory.
- Increase `exclude` patterns to skip irrelevant files.
