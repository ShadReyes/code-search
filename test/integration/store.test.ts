import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initStore,
  initGitHistoryTable,
  insertChunks,
  deleteByFilePath,
  search,
  getStats,
  dropTable,
  insertGitChunks,
  deleteGitChunksBySha,
  searchGitHistory,
  getGitStats,
  resetStore,
} from '../../src/store.js';
import { generateDeterministicVector } from '../../bench/helpers/mock-ollama.js';
import type { CodeChunk, GitHistoryChunk } from '../../src/types.js';

function makeCodeChunk(id: string, filePath: string, name: string): CodeChunk {
  return {
    id,
    file_path: filePath,
    package_name: 'test-pkg',
    name,
    chunk_type: 'function',
    line_start: 1,
    line_end: 10,
    content: `function ${name}() {}`,
    language: 'typescript',
    exported: true,
  };
}

function makeGitChunk(id: string, sha: string, overrides: Partial<GitHistoryChunk> = {}): GitHistoryChunk {
  return {
    id,
    sha,
    author: 'Alice',
    email: 'alice@test.com',
    date: '2024-06-15T10:30:00Z',
    subject: 'feat: add feature',
    body: '',
    chunk_type: 'commit_summary',
    commit_type: 'feat',
    scope: '',
    file_path: '',
    text: `Commit ${sha}: add feature`,
    files_changed: 1,
    additions: 10,
    deletions: 2,
    branch: 'main',
    ...overrides,
  };
}

describe('store — code chunks', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'store-code-test-'));
    await initStore(tmpDir);
  });

  afterAll(() => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insertChunks + search round-trip', async () => {
    const chunks = [
      makeCodeChunk('c1', 'src/auth.ts', 'login'),
      makeCodeChunk('c2', 'src/utils.ts', 'format'),
    ];
    const vectors = chunks.map(c => generateDeterministicVector(c.content));
    await insertChunks(chunks, vectors, true);

    const queryVec = generateDeterministicVector('function login() {}');
    const results = await search(queryVec, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.id).toBeDefined();
    expect(results[0].score).toBeDefined();
  });

  it('search returns results sorted by score (descending)', async () => {
    const queryVec = generateDeterministicVector('function login() {}');
    const results = await search(queryVec, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('search with fileFilter', async () => {
    const queryVec = generateDeterministicVector('some query');
    const results = await search(queryVec, 5, 'src/auth');
    for (const r of results) {
      expect(r.chunk.file_path).toContain('src/auth');
    }
  });

  it('deleteByFilePath removes chunks', async () => {
    await deleteByFilePath('src/auth.ts');
    const queryVec = generateDeterministicVector('function login() {}');
    const results = await search(queryVec, 5, 'src/auth');
    expect(results).toHaveLength(0);
  });

  it('getStats returns correct counts', async () => {
    // Only src/utils.ts remains after delete
    const stats = await getStats();
    expect(stats.totalChunks).toBe(1);
    expect(stats.uniqueFiles).toBe(1);
  });

  it('dropTable + re-insert (overwrite mode)', async () => {
    await dropTable();
    const chunks = [makeCodeChunk('c3', 'src/new.ts', 'newFunc')];
    const vectors = chunks.map(c => generateDeterministicVector(c.content));
    await insertChunks(chunks, vectors, true);

    const stats = await getStats();
    expect(stats.totalChunks).toBe(1);
  });

  it('insertChunks overwrite=false appends', async () => {
    const chunks = [makeCodeChunk('c4', 'src/extra.ts', 'extraFunc')];
    const vectors = chunks.map(c => generateDeterministicVector(c.content));
    await insertChunks(chunks, vectors, false);

    const stats = await getStats();
    expect(stats.totalChunks).toBe(2);
  });
});

describe('store — git history', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'store-git-test-'));
    await initStore(tmpDir);
    await initGitHistoryTable();
  });

  afterAll(() => {
    resetStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insertGitChunks + searchGitHistory round-trip', async () => {
    const chunks = [
      makeGitChunk('g1', 'sha111', { text: 'Commit sha111: add authentication' }),
      makeGitChunk('g2', 'sha222', {
        author: 'Bob',
        text: 'Commit sha222: fix database query',
        date: '2024-07-01T12:00:00Z',
      }),
    ];
    const vectors = chunks.map(c => generateDeterministicVector(c.text));
    await insertGitChunks(chunks, vectors, true);

    const queryVec = generateDeterministicVector('authentication commit');
    const results = await searchGitHistory(queryVec, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.sha).toBeDefined();
  });

  it('searchGitHistory with filter', async () => {
    const queryVec = generateDeterministicVector('some query');
    const results = await searchGitHistory(queryVec, 5, "author = 'Bob'");
    for (const r of results) {
      expect(r.chunk.author).toBe('Bob');
    }
  });

  it('deleteGitChunksBySha removes chunks', async () => {
    await deleteGitChunksBySha('sha111');
    const queryVec = generateDeterministicVector('authentication');
    const results = await searchGitHistory(queryVec, 5, "sha = 'sha111'");
    expect(results).toHaveLength(0);
  });

  it('getGitStats returns correct counts and date range', async () => {
    const stats = await getGitStats();
    expect(stats.totalChunks).toBe(1); // sha111 was deleted
    expect(stats.uniqueCommits).toBe(1);
    expect(stats.dateRange).toBeDefined();
    expect(stats.dateRange!.earliest).toBe('2024-07-01T12:00:00Z');
    expect(stats.dateRange!.latest).toBe('2024-07-01T12:00:00Z');
  });
});
