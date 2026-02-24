import { describe, bench, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startMockOllama } from '../helpers/mock-ollama.js';
import { generateScalingRepo, cleanupRepo } from '../helpers/scaling-repo-generator.js';
import { initParser } from '../../src/parser.js';
import { chunkFile } from '../../src/chunker.js';
import { embedBatch } from '../../src/embedder.js';
import { initStore, insertChunks, resetStore } from '../../src/store.js';
import { discoverFiles } from '../../src/indexer.js';
import { DEFAULT_CONFIG } from '../../src/types.js';
import type { CodeChunk } from '../../src/types.js';

let mockClose: () => Promise<void>;

beforeAll(async () => {
  const mock = await startMockOllama();
  process.env.OLLAMA_URL = mock.url;
  process.env.MOCK_OLLAMA = '1';
  mockClose = mock.close;
  await initParser();
});

afterAll(async () => {
  await mockClose();
  delete process.env.OLLAMA_URL;
  delete process.env.MOCK_OLLAMA;
});

/**
 * Run the full indexing pipeline manually:
 * discover files -> read -> chunk -> embed -> store
 */
async function runFullPipeline(repoPath: string): Promise<void> {
  const dbPath = mkdtempSync(join(tmpdir(), 'bench-lance-'));

  try {
    await initStore(dbPath);

    const config = { ...DEFAULT_CONFIG };
    const files = discoverFiles(repoPath, config);

    const allChunks: CodeChunk[] = [];
    for (const { path: filePath, content } of files) {
      try {
        const chunks = chunkFile(filePath, content, repoPath, config.chunkMaxTokens);
        allChunks.push(...chunks);
      } catch {
        // skip unreadable files
      }
    }

    if (allChunks.length > 0) {
      const contents = allChunks.map((c) => c.content);
      const vectors = await embedBatch(
        contents,
        config.embeddingModel,
        config.embeddingBatchSize,
      );
      await insertChunks(allChunks, vectors, true);
    }
  } finally {
    resetStore();
    rmSync(dbPath, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 10 files
// ---------------------------------------------------------------------------
describe('full-index-pipeline: 10 files', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await generateScalingRepo(10);
  });

  afterAll(() => {
    cleanupRepo(repoPath);
  });

  bench('index 10 files end-to-end', async () => {
    await runFullPipeline(repoPath);
  });
});

// ---------------------------------------------------------------------------
// 100 files
// ---------------------------------------------------------------------------
describe('full-index-pipeline: 100 files', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await generateScalingRepo(100);
  });

  afterAll(() => {
    cleanupRepo(repoPath);
  });

  bench('index 100 files end-to-end', async () => {
    await runFullPipeline(repoPath);
  });
});

// ---------------------------------------------------------------------------
// 1000 files
// ---------------------------------------------------------------------------
describe('full-index-pipeline: 1000 files', () => {
  let repoPath: string;

  beforeAll(async () => {
    repoPath = await generateScalingRepo(1000);
  });

  afterAll(() => {
    cleanupRepo(repoPath);
  });

  bench(
    'index 1000 files end-to-end',
    async () => {
      await runFullPipeline(repoPath);
    },
    { warmupIterations: 1, iterations: 3 },
  );
});
