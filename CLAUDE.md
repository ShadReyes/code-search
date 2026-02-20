# code-search Development Guide

## Project Overview
Local semantic code search CLI. Tree-sitter parsing → Ollama embeddings → LanceDB vector store.

## Tech Stack
- **Runtime:** Node 22, ESM (`"type": "module"`)
- **Language:** TypeScript (strict), compiled with tsx for dev
- **Parser:** web-tree-sitter@0.25.3 (pinned) + tree-sitter-wasms
- **Embeddings:** Ollama (nomic-embed-text, 768 dims)
- **Vector DB:** @lancedb/lancedb
- **CLI:** Commander.js

## Key Constraints
- **web-tree-sitter must stay at 0.25.3** — 0.26.x breaks ABI compat with tree-sitter-wasms WASM files
- WASM files loaded via `readFileSync` + bytes (not path) to work around ESM dynamic require issues
- `createRequire(import.meta.url)` used to resolve node_modules paths in ESM
- LanceDB vectors stored as `number[]` (not Float32Array) — LanceDB auto-converts to FixedSizeList<Float32>

## Module Map
| File | Purpose |
|------|---------|
| `src/types.ts` | Core interfaces + default config (code + git) |
| `src/parser.ts` | Tree-sitter init + parse (singleton) |
| `src/chunker.ts` | AST → CodeChunk[] with NextJS rules |
| `src/embedder.ts` | Ollama embed API client (prefix support for git) |
| `src/store.ts` | LanceDB CRUD wrapper (chunks + git_history tables) |
| `src/indexer.ts` | Full/incremental code index orchestration |
| `src/search.ts` | Code query embed + vector search |
| `src/index.ts` | CLI entry point (code + git commands) |
| `src/git/extractor.ts` | Git commit streaming for indexer |
| `src/git/chunker.ts` | Commit → embeddable chunks (3 levels) |
| `src/git/enricher.ts` | Low-quality message enrichment (no LLM) |
| `src/git/indexer.ts` | Git history index pipeline |
| `src/git/search.ts` | Semantic vector search with metadata filters |
| `src/git/cross-ref.ts` | Code ↔ git cross-referencing + explain |

## Running
```bash
# Code search
npx tsx src/index.ts index --full --repo <path>
npx tsx src/index.ts query "<search>" --repo <path>
npx tsx src/index.ts stats --repo <path>

# Git history search
npx tsx src/index.ts git-index --full --repo <path>
npx tsx src/index.ts git-search "<search>" --repo <path>
npx tsx src/index.ts git-stats --repo <path>
npx tsx src/index.ts explain "<search>" --repo <path>
```

## When to Use Git vs Code Search
- **`query`** — find code by what it does ("authentication middleware", "database model")
- **`git-search`** — find commits by why/when ("why did we switch providers", "auth changes last month")
- **`explain`** — combined view: code context + git history for a symbol or concept

## Data Locations
- `.lance/` — LanceDB storage, `chunks` + `git_history` tables (gitignored)
- `.code-search-state.json` — code index state (gitignored)
- `.git-search-state.json` — git index state (gitignored)

## Common Pitfalls
- Always call `initParser()` before `parseFile()` — it's async and loads WASM
- Always call `initStore()` before any store operations
- Call `initGitHistoryTable()` after `initStore()` for git operations
- Ollama must be running (`ollama serve`) before index/search
- Embedding batch size of 50 for code, 20 for git (git diff chunks are larger)
- Git embedder uses `search_document:` prefix at index, `search_query:` at query (nomic-embed-text optimization)
- Git extractor streams commits — never loads all into memory
