# cortex-recall

Semantic code & git history search CLI with a **signal detection layer** that detects patterns, computes risk, and produces actionable warnings. Primary consumer: Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

- **Multi-language** — TypeScript/TSX/JS/JSX, Python, and Ruby via tree-sitter AST parsing
- **Pluggable embeddings** — Ollama (local, default) or OpenAI-compatible APIs
- **Local + remote storage** — LanceDB on disk, or S3/GCS via URI
- **JSON output** — `--format json` on all read commands for tool integration
- **Git history search** — semantic search over commits, diffs, and cross-referenced code
- **Signal detection layer** — signal detection, file profiles, risk scoring, and actionable warnings
- **MCP server** — integrates directly with Claude Code as a tool provider

## How It Works

cortex-recall has three layers:

1. **Code Search** — tree-sitter parses source files into semantic chunks, embeds them, and stores in LanceDB for vector search
2. **Git History** — commits are streamed, chunked (summary + per-file diffs), embedded, and indexed with metadata (author, date, type, decision class)
3. **Signal Detection** — signal detectors scan git history for patterns (reverts, churn hotspots, ownership, fix cascades, adoption cycles, breaking changes), compute file profiles, and synthesize actionable warnings

## Supported Languages

**Code indexing** (`index`, `query`) parses source files with tree-sitter:

- TypeScript / TSX / JS / JSX (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.mts`) — React/NextJS-aware chunking (components, hooks, route handlers, pages, layouts)
- Python (`.py`) — class/decorator-aware chunking
- Ruby (`.rb`, `.rake`) — method/class-aware chunking

**Git history search** (`git-index`, `git-search`, `explain`, `analyze`, `assess`) indexes commit messages and diffs — works on any repo regardless of language.

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

## Quick Start

```bash
# 1. Index code
npx tsx src/index.ts index --full --repo /path/to/repo

# 2. Index git history
npx tsx src/index.ts git-index --full --repo /path/to/repo

# 3. Analyze patterns (requires git-index)
npx tsx src/index.ts analyze --full --repo /path/to/repo

# 4. Search code
npx tsx src/index.ts query "authentication middleware" --repo /path/to/repo

# 5. Search git history
npx tsx src/index.ts git-search "why did we switch providers" --repo /path/to/repo

# 6. Get assessment before modifying files
npx tsx src/index.ts assess --files src/payments/checkout.ts --change-type refactor --repo /path/to/repo
```

## CLI Reference

All commands accept `--repo <path>` or use the `CORTEX_RECALL_REPO` env var.

### Code Indexing & Search

```bash
# Full re-index
npx tsx src/index.ts index --full --repo /path/to/repo

# Incremental (only changed files)
npx tsx src/index.ts index --repo /path/to/repo

# Semantic code search
npx tsx src/index.ts query "database connection" --repo /path/to/repo --limit 10

# Filter by file path prefix
npx tsx src/index.ts query "user model" --repo /path/to/repo --filter packages/api/src

# Index statistics
npx tsx src/index.ts stats --repo /path/to/repo
```

### Git History

```bash
# Full git history index
npx tsx src/index.ts git-index --full --repo /path/to/repo

# Limit to recent commits
npx tsx src/index.ts git-index --full --repo /path/to/repo --max-commits 500

# Semantic git search
npx tsx src/index.ts git-search "auth changes" --repo /path/to/repo

# With date range filters
npx tsx src/index.ts git-search "auth changes" --after 2025-06-01 --before 2026-01-01 --repo /path/to/repo

# Sort by date, one result per commit
npx tsx src/index.ts git-search "API updates" --sort date --unique-commits --repo /path/to/repo

# Filter by author and type
npx tsx src/index.ts git-search "API updates" --author "John" --type feat --repo /path/to/repo

# Combined code + git history
npx tsx src/index.ts explain "authenticateUser" --repo /path/to/repo

# Git index stats
npx tsx src/index.ts git-stats --repo /path/to/repo
```

### Signal Analysis & Assessment

```bash
# Detect patterns from git history (requires git-index)
npx tsx src/index.ts analyze --full --repo /path/to/repo

# Get assessment for files you plan to modify (requires analyze)
npx tsx src/index.ts assess --files src/payments/checkout.ts,src/payments/processor.ts --repo /path/to/repo

# With change type context
npx tsx src/index.ts assess --files src/auth/middleware.ts --change-type refactor --repo /path/to/repo

# JSON output for tool consumption
npx tsx src/index.ts assess --files src/foo.ts --format json --repo /path/to/repo
```

### What `assess` Returns

When you run `assess`, you get:

- **Warnings** — prioritized by severity (warning > caution > info):
  - Stability alerts for volatile files
  - Ownership info (who owns the code)
  - Pattern alerts (previous reverts, fix cascades, breaking changes)
  - Churn hotspot flags
- **File profiles** — stability score, risk score, change frequency, contributor count
- **Active signals** — detected patterns relevant to the files
- **Owners** — who has been modifying the code and how recently

### Signal Detectors

| Detector | What it finds |
|----------|--------------|
| **RevertDetector** | Commits that were reverted and how quickly |
| **ChurnDetector** | Files changed far more than average (>2σ) |
| **OwnershipDetector** | Who actually owns what (per-file and per-directory) |
| **FixAfterFeatureDetector** | Features that needed follow-up fixes within 7 days |
| **AdoptionCycleDetector** | Dependencies that were added, removed, re-added |
| **StabilityShiftDetector** | Areas that recently stabilized or destabilized |
| **BreakingChangeDetector** | Changes that caused multi-author fix cascades within 48 hours |

## MCP Server (Claude Code Integration)

cortex-recall runs as an MCP server that Claude Code can connect to:

```bash
# Start the MCP server
npx tsx src/mcp.ts
```

### Claude Code Configuration

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "cortex-recall": {
      "command": "npx",
      "args": ["tsx", "/path/to/cortex-recall/src/mcp.ts"],
      "env": {
        "CORTEX_RECALL_REPO": "/path/to/your/repo"
      }
    }
  }
}
```

### MCP Tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| `cortex_assess` | Full assessment with warnings | Before planning changes to a file/module |
| `cortex_search` | Semantic code search | Understanding current code |
| `cortex_git_search` | Semantic git history search | Understanding why code is the way it is |
| `cortex_explain` | Cross-reference (code + history) | Deep-dive on a specific symbol/concept |
| `cortex_file_profile` | Direct file profile lookup | Quick ownership/stability check |

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
  "embeddingBatchSize": 50,
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

## Architecture

```
src/
  index.ts            CLI entry point (Commander.js)
  types.ts            Core types: CodeChunk, GitHistoryChunk, Config
  store.ts            LanceDB vector store (chunks + git_history)
  indexer.ts           Full + incremental code indexing
  search.ts           Code query embedding + vector search
  assess.ts           Assessment: file profiles → signals → warnings
  mcp.ts              MCP server entry point
  embeddings/
    provider.ts       EmbeddingProvider interface + factory
    ollama.ts         OllamaProvider — local Ollama embeddings
    openai.ts         OpenAIProvider — remote OpenAI embeddings
  lang/
    plugin.ts         LanguagePlugin interface + PluginRegistry
    typescript/       TS/TSX parser + chunker + WASM grammars
    python/           Python parser + chunker + WASM grammars
    ruby/             Ruby parser + chunker + WASM grammars
  git/
    extractor.ts      Git commit streaming (async generator)
    chunker.ts        Commit → embeddable chunks + decision_class
    enricher.ts       Low-quality message enrichment
    indexer.ts        Git history indexing pipeline
    search.ts         Semantic search with filters, sort, dedup
    cross-ref.ts      Code ↔ git cross-referencing (explain)
  signals/
    types.ts          SignalRecord, FileProfile, Warning, AssessmentResult
    detector.ts       DetectorPipeline orchestrator
    store.ts          LanceDB CRUD for signals + file_profiles
    synthesizer.ts    Warning synthesis rules + temporal decay
    indexer.ts        Analyze pipeline (git history → signals → profiles)
    detectors/
      revert.ts       RevertDetector
      churn.ts        ChurnDetector
      ownership.ts    OwnershipDetector
      fix-chain.ts    FixAfterFeatureDetector
      adoption.ts     AdoptionCycleDetector
      stability.ts    StabilityShiftDetector
      breaking.ts     BreakingChangeDetector
```

## Data Locations

- `.lance/` — LanceDB tables: `chunks`, `git_history`, `signals`, `file_profiles` (gitignored)
- `.cortex-recall-state.json` — code index state (gitignored)
- `.git-search-state.json` — git index state (gitignored)
- `.analyze-state.json` — signal detection state (gitignored)

## CI/CD

```bash
OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }} \
CORTEX_RECALL_STORE_URI=s3://my-bucket/cortex \
  npx tsx src/index.ts index --full --repo . \
    --provider openai --model text-embedding-3-small

npx tsx src/index.ts query "auth middleware" --repo . --format json > results.json
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
npx tsx src/index.ts index --full --repo /path/to/repo
```

**"Not a git repository"**
Ensure `--repo` points at a directory containing a `.git` folder.

**"No git history found"**
Run `git-index` before `analyze`:
```bash
npx tsx src/index.ts git-index --full --repo /path/to/repo
npx tsx src/index.ts analyze --full --repo /path/to/repo
```

**Slow indexing**
- Large repos take time on first index. Subsequent incremental indexes are fast.
- Set `"maxCommits": 1000` in config to limit git history.
- Disable `"includeFileChunks": false` to skip per-file diffs.
- Reduce `embeddingBatchSize` if Ollama runs out of memory.
