import { describe, bench, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initStore,
  insertChunks,
  search,
  deleteByFilePath,
  getStats,
  resetStore,
  dropTable,
} from '../../src/store.js';
import { generateDeterministicVector } from '../helpers/mock-ollama.js';
import type { CodeChunk } from '../../src/types.js';

const DIMS = 768;

function makeChunk(index: number, filePath: string = `src/file-${index}.ts`): CodeChunk {
  return {
    id: `chunk-${index}`,
    file_path: filePath,
    package_name: 'bench-pkg',
    name: `item${index}`,
    chunk_type: 'function',
    line_start: 1,
    line_end: 10 + (index % 50),
    content: `export function item${index}(x: number): number { return x * ${index}; }`,
    language: 'typescript',
    exported: true,
  };
}

function makeChunksAndVectors(count: number, filePrefix: string = 'src/file'): {
  chunks: CodeChunk[];
  vectors: number[][];
} {
  const chunks: CodeChunk[] = [];
  const vectors: number[][] = [];
  for (let i = 0; i < count; i++) {
    const filePath = `${filePrefix}-${i}.ts`;
    const chunk = makeChunk(i, filePath);
    chunks.push(chunk);
    vectors.push(generateDeterministicVector(chunk.content, DIMS));
  }
  return { chunks, vectors };
}

const queryVector = generateDeterministicVector('search query', DIMS);

// ---------------------------------------------------------------------------
// Insert benchmarks
// ---------------------------------------------------------------------------

describe('store insert', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-insert-'));
    await initStore(tmpDir);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('insertChunks 10', async () => {
    const { chunks, vectors } = makeChunksAndVectors(10, 'src/ins10');
    await insertChunks(chunks, vectors, true);
  });

  bench('insertChunks 100', async () => {
    const { chunks, vectors } = makeChunksAndVectors(100, 'src/ins100');
    await insertChunks(chunks, vectors, true);
  });

  bench('insertChunks 1000', async () => {
    const { chunks, vectors } = makeChunksAndVectors(1000, 'src/ins1000');
    await insertChunks(chunks, vectors, true);
  });
});

// ---------------------------------------------------------------------------
// Search benchmarks — 100 chunks
// ---------------------------------------------------------------------------

describe('store search 100', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-s100-'));
    resetStore();
    await initStore(tmpDir);
    const { chunks, vectors } = makeChunksAndVectors(100);
    await insertChunks(chunks, vectors, true);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('search top-5 in 100-chunk table', async () => {
    await search(queryVector, 5);
  });
});

// ---------------------------------------------------------------------------
// Search benchmarks — 1000 chunks
// ---------------------------------------------------------------------------

describe('store search 1000', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-s1k-'));
    resetStore();
    await initStore(tmpDir);
    const { chunks, vectors } = makeChunksAndVectors(1000);
    await insertChunks(chunks, vectors, true);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('search top-5 in 1000-chunk table', async () => {
    await search(queryVector, 5);
  });

  bench('search top-5 with fileFilter in 1000-chunk table', async () => {
    await search(queryVector, 5, 'src/file-5');
  });
});

// ---------------------------------------------------------------------------
// Search benchmarks — 10000 chunks
// ---------------------------------------------------------------------------

describe('store search 10000', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-s10k-'));
    resetStore();
    await initStore(tmpDir);
    const { chunks, vectors } = makeChunksAndVectors(10000);
    await insertChunks(chunks, vectors, true);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('search top-5 in 10000-chunk table', async () => {
    await search(queryVector, 5);
  });
});

// ---------------------------------------------------------------------------
// deleteByFilePath benchmark
// ---------------------------------------------------------------------------

describe('store deleteByFilePath', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-del-'));
    resetStore();
    await initStore(tmpDir);
    const { chunks, vectors } = makeChunksAndVectors(1000);
    await insertChunks(chunks, vectors, true);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('deleteByFilePath in 1000-chunk table', async () => {
    await deleteByFilePath('src/file-0.ts');
  });
});

// ---------------------------------------------------------------------------
// getStats benchmark
// ---------------------------------------------------------------------------

describe('store getStats', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-store-stats-'));
    resetStore();
    await initStore(tmpDir);
    const { chunks, vectors } = makeChunksAndVectors(1000);
    await insertChunks(chunks, vectors, true);
  });

  afterAll(async () => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench('getStats on 1000-chunk table', async () => {
    await getStats();
  });
});
