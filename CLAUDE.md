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
| `src/types.ts` | Core interfaces + default config |
| `src/parser.ts` | Tree-sitter init + parse (singleton) |
| `src/chunker.ts` | AST → CodeChunk[] with NextJS rules |
| `src/embedder.ts` | Ollama embed API client |
| `src/store.ts` | LanceDB CRUD wrapper |
| `src/indexer.ts` | Full/incremental index orchestration |
| `src/search.ts` | Query embed + vector search |
| `src/index.ts` | CLI entry point |

## Running
```bash
npx tsx src/index.ts index --full --repo <path>
npx tsx src/index.ts query "<search>" --repo <path>
npx tsx src/index.ts stats --repo <path>
```

## Data Locations
- `.lance/` — LanceDB storage (gitignored)
- `.code-search-state.json` — index state (gitignored)

## Common Pitfalls
- Always call `initParser()` before `parseFile()` — it's async and loads WASM
- Always call `initStore()` before any store operations
- Ollama must be running (`ollama serve`) before index/search
- Embedding batch size of 50 balances throughput and memory
