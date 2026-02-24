import { describe, bench, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { startMockOllama } from '../helpers/mock-ollama.js';
import { generateScalingRepo, cleanupRepo } from '../helpers/scaling-repo-generator.js';
import { initParser } from '../../src/parser.js';
import { chunkFile } from '../../src/chunker.js';
import { embedBatch } from '../../src/embedder.js';
import {
  initStore,
  insertChunks,
  deleteByFilePath,
  resetStore,
} from '../../src/store.js';
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
 * Perform a full index of all discovered files into the given LanceDB path.
 * Returns the list of discovered file paths for later incremental use.
 */
async function doFullIndex(
  repoPath: string,
  dbPath: string,
): Promise<string[]> {
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

  return files.map(f => f.path);
}

/**
 * Simulate an incremental re-index of N files:
 * 1. Delete old chunks for each file
 * 2. Re-read, re-chunk, re-embed, re-insert
 */
async function runIncrementalReindex(
  repoPath: string,
  dbPath: string,
  filesToReindex: string[],
): Promise<void> {
  const config = { ...DEFAULT_CONFIG };

  // Ensure store is connected to the existing DB
  await initStore(dbPath);

  // Delete old chunks for the changed files
  for (const filePath of filesToReindex) {
    const relPath = relative(repoPath, filePath);
    await deleteByFilePath(relPath);
  }

  // Re-chunk and re-embed
  const allChunks: CodeChunk[] = [];
  for (const filePath of filesToReindex) {
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
    await insertChunks(allChunks, vectors);
  }
}

// ---------------------------------------------------------------------------
// 3 changed files in a 100-file repo
// ---------------------------------------------------------------------------
describe('incremental-index: 3 changed / 100 total', () => {
  let repoPath: string;
  let dbPath: string;
  let changedFiles: string[];

  beforeAll(async () => {
    repoPath = await generateScalingRepo(100);
    dbPath = mkdtempSync(join(tmpdir(), 'bench-lance-inc-'));

    // Perform initial full index
    const allFiles = await doFullIndex(repoPath, dbPath);

    // Pick 3 files spread across the list to simulate changes
    changedFiles = [
      allFiles[0],
      allFiles[Math.floor(allFiles.length / 2)],
      allFiles[allFiles.length - 1],
    ];
  });

  afterAll(() => {
    resetStore();
    cleanupRepo(repoPath);
    rmSync(dbPath, { recursive: true, force: true });
  });

  bench(
    're-index 3 files in 100-file repo',
    async () => {
      await runIncrementalReindex(repoPath, dbPath, changedFiles);
    },
    { warmupIterations: 1, iterations: 5 },
  );
});

// ---------------------------------------------------------------------------
// 10 changed files in a 1000-file repo
// ---------------------------------------------------------------------------
describe('incremental-index: 10 changed / 1000 total', () => {
  let repoPath: string;
  let dbPath: string;
  let changedFiles: string[];

  beforeAll(async () => {
    repoPath = await generateScalingRepo(1000);
    dbPath = mkdtempSync(join(tmpdir(), 'bench-lance-inc-'));

    // Perform initial full index
    const allFiles = await doFullIndex(repoPath, dbPath);

    // Pick 10 files evenly distributed across the list
    changedFiles = [];
    const step = Math.floor(allFiles.length / 10);
    for (let i = 0; i < 10; i++) {
      changedFiles.push(allFiles[i * step]);
    }
  });

  afterAll(() => {
    resetStore();
    cleanupRepo(repoPath);
    rmSync(dbPath, { recursive: true, force: true });
  });

  bench(
    're-index 10 files in 1000-file repo',
    async () => {
      await runIncrementalReindex(repoPath, dbPath, changedFiles);
    },
    { warmupIterations: 1, iterations: 5 },
  );
});
