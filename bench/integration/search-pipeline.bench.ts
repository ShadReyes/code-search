import { describe, bench, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startMockOllama } from '../helpers/mock-ollama.js';
import { generateScalingRepo, cleanupRepo } from '../helpers/scaling-repo-generator.js';
import { initParser } from '../../src/parser.js';
import { chunkFile } from '../../src/chunker.js';
import { embedBatch, embedSingle } from '../../src/embedder.js';
import { initStore, insertChunks, search, resetStore } from '../../src/store.js';
import { discoverFiles } from '../../src/indexer.js';
import { DEFAULT_CONFIG } from '../../src/types.js';
import type { CodeChunk } from '../../src/types.js';

const QUERY = 'handle user authentication';
const MODEL = DEFAULT_CONFIG.embeddingModel;

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
 * Perform a full index of all discovered files into the given LanceDB path.
 */
async function doFullIndex(repoPath: string, dbPath: string): Promise<void> {
  await initStore(dbPath);

  const config = { ...DEFAULT_CONFIG };
  const files = discoverFiles(repoPath, config);

  const allChunks: CodeChunk[] = [];
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
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
}

// ---------------------------------------------------------------------------
// Search benchmarks against a 100-file index
// ---------------------------------------------------------------------------
describe('search-pipeline: 100-file index', () => {
  let repoPath: string;
  let dbPath: string;

  beforeAll(async () => {
    repoPath = await generateScalingRepo(100);
    dbPath = mkdtempSync(join(tmpdir(), 'bench-lance-search-'));
    await doFullIndex(repoPath, dbPath);
  });

  afterAll(() => {
    resetStore();
    cleanupRepo(repoPath);
    rmSync(dbPath, { recursive: true, force: true });
  });

  bench('cold search (resetStore + initStore + embed + search)', async () => {
    resetStore();
    await initStore(dbPath);
    const vector = await embedSingle(QUERY, MODEL);
    await search(vector, 5);
  });

  bench('warm search (embed + search)', async () => {
    const vector = await embedSingle(QUERY, MODEL);
    await search(vector, 5);
  });

  bench('warm search with fileFilter', async () => {
    const vector = await embedSingle(QUERY, MODEL);
    await search(vector, 5, 'src/');
  });
});

// ---------------------------------------------------------------------------
// Search benchmark against a larger 1000-file index
// ---------------------------------------------------------------------------
describe('search-pipeline: 1000-file index', () => {
  let repoPath: string;
  let dbPath: string;

  beforeAll(async () => {
    repoPath = await generateScalingRepo(1000);
    dbPath = mkdtempSync(join(tmpdir(), 'bench-lance-search-'));
    await doFullIndex(repoPath, dbPath);
  });

  afterAll(() => {
    resetStore();
    cleanupRepo(repoPath);
    rmSync(dbPath, { recursive: true, force: true });
  });

  bench('warm search in 1000-chunk index', async () => {
    const vector = await embedSingle(QUERY, MODEL);
    await search(vector, 5);
  });
});
