# cortex-recall Development Guide

## Project Overview
Semantic code + git history search CLI with a **signal detection layer** that detects patterns, computes risk, and produces actionable warnings. Tree-sitter parsing → pluggable embeddings → LanceDB vector store → signal detection → warning synthesis. Supports local (Ollama) and remote (OpenAI-compatible) embedding providers, local or remote (S3/GCS) storage, text or JSON output, and MCP server integration with Claude Code.

## Tech Stack
- **Runtime:** Node 22, ESM (`"type": "module"`)
- **Language:** TypeScript (strict), compiled with tsx for dev
- **Parser:** web-tree-sitter@0.25.3 (pinned) + vendored WASM grammars
- **Embeddings:** Pluggable — Ollama (default) or OpenAI-compatible APIs
- **Vector DB:** @lancedb/lancedb (local `.lance/`, or S3/GCS via URI)
- **CLI:** Commander.js
- **MCP:** @modelcontextprotocol/sdk (stdio transport)

## Key Constraints
- **web-tree-sitter must stay at 0.25.3** — 0.26.x breaks ABI compat with vendored WASM grammars
- WASM files loaded via `readFileSync` + bytes (not path) to work around ESM dynamic require issues
- `createRequire(import.meta.url)` used to resolve node_modules paths in ESM
- LanceDB vectors stored as `number[]` (not Float32Array) — LanceDB auto-converts to FixedSizeList<Float32>
- OpenAI model must be explicit in config (no auto-default)
- State files (`.cortex-recall-state.json`, `.git-search-state.json`, `.analyze-state.json`) stay local — no cross-machine incremental
- All signal detectors are heuristic-based — no LLM calls during analysis

## Module Map
| File | Purpose |
|------|---------|
| **Core** | |
| `src/types.ts` | Core interfaces + `CodeSearchConfig` + `DEFAULT_CONFIG` |
| `src/store.ts` | LanceDB CRUD (chunks + git_history); supports local/remote URI |
| `src/index.ts` | CLI entry point (registers plugins, all commands) |
| **Embeddings** | |
| `src/embeddings/provider.ts` | `EmbeddingProvider` interface + `createProvider()` factory |
| `src/embeddings/ollama.ts` | `OllamaProvider` — Ollama `/api/embed`, prefix support, batch fallback |
| `src/embeddings/openai.ts` | `OpenAIProvider` — OpenAI `/v1/embeddings`, native fetch |
| **Language Plugins** | |
| `src/lang/plugin.ts` | `LanguagePlugin` interface + `PluginRegistry` |
| `src/lang/typescript/` | TS/TSX parser, chunker (NextJS rules), vendored WASM grammars |
| `src/lang/python/` | Python parser, chunker (class/decorator-aware), vendored WASM |
| `src/parser.ts` | Re-export from lang/typescript (compat) |
| `src/chunker.ts` | Re-export from lang/typescript (compat) |
| **Code Search** | |
| `src/indexer.ts` | Full/incremental code index (uses PluginRegistry + provider) |
| `src/search.ts` | Code query embed + vector search |
| **Git Search** | |
| `src/git/extractor.ts` | Git commit streaming for indexer |
| `src/git/chunker.ts` | Commit → embeddable chunks (3 levels) + `decision_class` tagging |
| `src/git/enricher.ts` | Low-quality message enrichment (no LLM) |
| `src/git/indexer.ts` | Git history index pipeline |
| `src/git/search.ts` | Semantic vector search with metadata filters, sort, dedup |
| `src/git/cross-ref.ts` | Code ↔ git cross-referencing; `explain()` returns `ExplainResult` |
| **Signal Detection** | |
| `src/signals/types.ts` | `SignalRecord`, `FileProfile`, `Warning`, `AssessmentResult` interfaces |
| `src/signals/detector.ts` | `DetectorPipeline` orchestrator |
| `src/signals/detectors/revert.ts` | Finds revert pairs and time-to-revert |
| `src/signals/detectors/churn.ts` | Identifies file churn hotspots (>2σ above mean) |
| `src/signals/detectors/ownership.ts` | Computes per-file/directory ownership |
| `src/signals/detectors/fix-chain.ts` | Finds feature → fix cascades (7-day window) |
| `src/signals/detectors/adoption.ts` | Detects dependency adoption/abandonment cycles |
| `src/signals/detectors/stability.ts` | Detects stability shifts over 30-day windows |
| `src/signals/detectors/breaking.ts` | Detects multi-author fix cascades within 48 hours |
| `src/signals/store.ts` | LanceDB CRUD for `signals` + `file_profiles` tables |
| `src/signals/synthesizer.ts` | Warning synthesis rules + temporal decay scoring |
| `src/signals/indexer.ts` | `analyze` pipeline: loads git history → runs detectors → stores signals + profiles |
| **Signal Detection** | |
| `src/assess.ts` | `assess()` function: file profile lookup → signal retrieval → warning synthesis |
| `src/mcp.ts` | MCP server: exposes `cortex_assess`, `cortex_search`, `cortex_git_search`, `cortex_explain`, `cortex_file_profile` |

## Config (`CodeSearchConfig`)
Set via `.cortexrc.json` in repo root, CLI flags, or env vars:

| Field | Default | CLI flag | Env var |
|-------|---------|----------|---------|
| `embeddingProvider` | `'ollama'` | `--provider` | — |
| `embeddingModel` | `'nomic-embed-text'` | `--model` | — |
| `embeddingApiKey` | — | — | `OPENAI_API_KEY` |
| `embeddingBaseUrl` | — | — | `OLLAMA_BASE_URL` / `OPENAI_BASE_URL` |
| `storeUri` | local `.lance/` | — | `CORTEX_RECALL_STORE_URI` |

## Running
```bash
# Code search (default: Ollama)
npx tsx src/index.ts index --full --repo <path>
npx tsx src/index.ts query "<search>" --repo <path>
npx tsx src/index.ts stats --repo <path>

# Git history search
npx tsx src/index.ts git-index --full --repo <path> --max-commits 250
npx tsx src/index.ts git-search "<search>" --repo <path>
npx tsx src/index.ts git-search "<search>" --repo <path> --after 2025-06-01 --before 2026-01-01
npx tsx src/index.ts git-search "<search>" --repo <path> --sort date --unique-commits
npx tsx src/index.ts git-stats --repo <path>
npx tsx src/index.ts explain "<search>" --repo <path>

# Signal analysis (requires git-index first)
npx tsx src/index.ts analyze --full --repo <path>
npx tsx src/index.ts assess --files src/foo.ts,src/bar.ts --repo <path>
npx tsx src/index.ts assess --files src/foo.ts --change-type refactor --format json --repo <path>

# JSON output (query, stats, git-search, git-stats, explain, assess)
npx tsx src/index.ts query "<search>" --repo <path> --format json

# MCP server (for Claude Code integration)
npx tsx src/mcp.ts

# CI/CD mode with OpenAI + remote store
OPENAI_API_KEY=sk-... CORTEX_RECALL_STORE_URI=s3://bucket/cortex \
  npx tsx src/index.ts index --full --repo . \
    --provider openai --model text-embedding-3-small
```

## When to Use Which Command
- **`query`** — find code by what it does ("authentication middleware", "database model")
- **`git-search`** — find commits by why/when ("why did we switch providers", "auth changes last month")
- **`explain`** — combined view: code context + git history for a symbol or concept
- **`analyze`** — detect patterns (reverts, churn, ownership, fix cascades) from git history
- **`assess`** — get warnings before modifying files (stability, ownership, pattern alerts)

## Signal Detection Architecture
```
[git-index] → git_history table (commits + diffs)
      |
      v
[analyze] → loads all git_history rows, sorted by date
      |
      ├── RevertDetector: regex on subjects + SHA matching
      ├── ChurnDetector: per-file counts, flag >2σ
      ├── OwnershipDetector: author-file grouping, percentage calc
      ├── FixAfterFeatureDetector: feat→fix 7-day window
      ├── AdoptionCycleDetector: package.json add/remove patterns
      ├── StabilityShiftDetector: 30-day windowed comparison
      └── BreakingChangeDetector: multi-author fix cascades <48h
      |
      v
[embed] → signal summaries get embedded for semantic search
      |
      v
[store] → signals table + file_profiles table in LanceDB
```

Each `GitHistoryChunk` carries a `decision_class` tag:
- `decision`: feat/refactor/revert prefix, >10 files, touches config
- `routine`: small fix (≤3 files), lockfile-only
- `unknown`: everything else

## MCP Server Tools
| Tool | Purpose | When Claude should use it |
|------|---------|--------------------------|
| `cortex_assess` | Full assessment with warnings | Before planning changes to a file/module |
| `cortex_search` | Semantic code search | Understanding current code |
| `cortex_git_search` | Semantic git history search | Understanding why code is the way it is |
| `cortex_explain` | Cross-reference (code + history) | Deep-dive on a specific symbol/concept |
| `cortex_file_profile` | Direct file profile lookup | Quick ownership/stability check |

## Data Locations
- `.lance/` — LanceDB storage: `chunks`, `git_history`, `signals`, `file_profiles` tables (gitignored)
- `.cortex-recall-state.json` — code index state (gitignored, always local)
- `.git-search-state.json` — git index state (gitignored, always local)
- `.analyze-state.json` — signal detection state (gitignored, always local)

## Embedding Provider Architecture
```
createProvider(config) → OllamaProvider | OpenAIProvider
  ├── healthCheck()     — verify connectivity + model availability
  ├── probeDimension()  — probe vector dimensionality
  ├── embedBatch()      — batch embed with fallback to 1-by-1
  └── embedSingle()     — single text embed (query time)
```
- `OllamaProvider`: `supportsPrefixes = true` — nomic uses `search_document:`/`search_query:` prefixes
- `OpenAIProvider`: `supportsPrefixes = false` — prefix param silently ignored
- Both providers: progressive truncation fallback (8000 → 4000 → 2000 → 500 chars), zero-vector last resort

## Common Pitfalls
- Plugins are registered in `src/index.ts` and initialized via `registry.initAll()`
- For direct parser use: call `initParser()` / `initPythonParser()` before parsing
- Always call `initStore()` before any store operations — pass `storeUri` when config is available
- Call `initGitHistoryTable()` after `initStore()` for git operations
- For signals: call `initSignalsStore()` then `initSignalsTable()` + `initFileProfilesTable()`
- Ollama must be running (`ollama serve`) when using default provider
- Embedding batch size of 50 for code, 20 for git and signals (larger chunks)
- Git embedder uses `search_document:` prefix at index, `search_query:` at query (nomic-embed-text optimization; ignored by OpenAI provider)
- Git extractor streams commits — never loads all into memory
- `explain()` returns `ExplainResult` struct — CLI formats via `formatExplainResult()` (text) or `JSON.stringify` (json)
- `assess()` returns `AssessmentResult` — CLI formats via `formatAssessResult()` (text) or `JSON.stringify` (json)
- Signal detectors run on GitHistoryChunk arrays (commit_summary + file_diff), sorted by date
- `analyze` must run after `git-index` — it reads from the git_history table
- `assess` must run after `analyze` — it reads from signals + file_profiles tables
