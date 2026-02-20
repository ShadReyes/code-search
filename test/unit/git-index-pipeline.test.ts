import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/git/extractor.js', () => ({
  extractAllCommits: vi.fn(),
  extractCommitsSince: vi.fn(),
  validateGitRepo: vi.fn(),
}));

vi.mock('../../src/git/chunker.js', () => ({
  chunkCommit: vi.fn(),
}));

vi.mock('../../src/git/enricher.js', () => ({
  enrichChunk: vi.fn(),
}));

vi.mock('../../src/embeddings/provider.js', () => ({
  createProvider: vi.fn(),
}));

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  initGitHistoryTable: vi.fn(),
  insertGitChunks: vi.fn(),
  dropGitTable: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

async function* asyncIterFromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function mockProvider() {
  return {
    healthCheck: vi.fn().mockResolvedValue(undefined),
    probeDimension: vi.fn().mockResolvedValue(768),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    embedSingle: vi.fn().mockResolvedValue([0.1, 0.2]),
    name: 'mock',
    supportsPrefixes: false,
  };
}

const testConfig = {
  embeddingBatchSize: 50,
  storeUri: undefined,
  git: {
    includeFileChunks: false,
    includeMergeGroups: false,
    maxDiffLinesPerFile: 50,
    enrichLowQualityMessages: true,
    lowQualityThreshold: 10,
    skipBotAuthors: [],
    skipMessagePatterns: [],
    maxCommits: 0,
  },
};

function makeGitChunk(id: string): any {
  return {
    id,
    sha: 'abc123',
    author: 'Alice',
    email: 'a@test.com',
    date: '2024-06-15',
    subject: 'feat: add feature',
    body: '',
    chunk_type: 'commit_summary',
    commit_type: 'feat',
    scope: '',
    file_path: '',
    text: 'chunk text',
    files_changed: 1,
    additions: 10,
    deletions: 2,
    branch: 'main',
  };
}

const { indexGitFull, indexGitIncremental } = await import('../../src/git/indexer.js');

const { extractAllCommits, extractCommitsSince, validateGitRepo } = await import(
  '../../src/git/extractor.js'
);
const { chunkCommit } = await import('../../src/git/chunker.js');
const { enrichChunk } = await import('../../src/git/enricher.js');
const { createProvider } = await import('../../src/embeddings/provider.js');
const { insertGitChunks, dropGitTable } = await import('../../src/store.js');
const { existsSync, writeFileSync, readFileSync } = await import('node:fs');
const { execSync } = await import('node:child_process');

beforeEach(() => {
  vi.clearAllMocks();

  // Default mock setup: provider factory returns a mock provider
  const provider = mockProvider();
  vi.mocked(createProvider).mockReturnValue(provider as any);

  // execSync returns a fake HEAD sha
  vi.mocked(execSync).mockReturnValue('deadbeef1234\n');

  // enrichChunk passes through
  vi.mocked(enrichChunk).mockImplementation((c: any) => c);
});

describe('indexGitFull', () => {
  it('validates repo, streams commits, chunks, enriches, embeds, and inserts', async () => {
    const commit = { sha: 'abc123', subject: 'feat: thing' };
    vi.mocked(extractAllCommits).mockReturnValue(asyncIterFromArray([commit]) as any);

    const chunk = makeGitChunk('chunk-1');
    vi.mocked(chunkCommit).mockResolvedValue([chunk]);

    await indexGitFull('/tmp/repo', testConfig as any, false);

    expect(validateGitRepo).toHaveBeenCalledWith('/tmp/repo');
    expect(extractAllCommits).toHaveBeenCalledWith('/tmp/repo', testConfig.git);
    expect(chunkCommit).toHaveBeenCalledWith(commit, '/tmp/repo', testConfig.git);
    expect(enrichChunk).toHaveBeenCalledWith(chunk, testConfig.git);
    expect(insertGitChunks).toHaveBeenCalled();
  });

  it('flushes batch at 20 chunks', async () => {
    const commit1 = { sha: 'aaa', subject: 'feat: first' };
    const commit2 = { sha: 'bbb', subject: 'feat: second' };
    vi.mocked(extractAllCommits).mockReturnValue(
      asyncIterFromArray([commit1, commit2]) as any,
    );

    // First commit produces 20 chunks (triggers flush), second produces 1
    const batch1 = Array.from({ length: 20 }, (_, i) => makeGitChunk(`c1-${i}`));
    const batch2 = [makeGitChunk('c2-0')];
    vi.mocked(chunkCommit)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    await indexGitFull('/tmp/repo', testConfig as any, false);

    // Batch of 20 flushed in the loop, remaining 1 flushed at the end
    expect(insertGitChunks).toHaveBeenCalledTimes(2);
  });

  it('drops the git table before inserting', async () => {
    vi.mocked(extractAllCommits).mockReturnValue(asyncIterFromArray([]) as any);

    await indexGitFull('/tmp/repo', testConfig as any, false);

    expect(dropGitTable).toHaveBeenCalled();
  });

  it('writes state with HEAD sha and embedding dimension', async () => {
    vi.mocked(extractAllCommits).mockReturnValue(asyncIterFromArray([]) as any);
    vi.mocked(execSync).mockReturnValue('face0ff\n');

    await indexGitFull('/tmp/repo', testConfig as any, false);

    expect(writeFileSync).toHaveBeenCalled();
    const [, jsonStr] = vi.mocked(writeFileSync).mock.calls[0];
    const state = JSON.parse(jsonStr as string);
    expect(state.lastCommit).toBe('face0ff');
    expect(state.embeddingDimension).toBe(768);
  });
});

describe('indexGitIncremental', () => {
  it('falls back to full index when no state exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(extractAllCommits).mockReturnValue(asyncIterFromArray([]) as any);

    await indexGitIncremental('/tmp/repo', testConfig as any, false);

    // Should have fallen back to full: extractAllCommits (not extractCommitsSince)
    expect(extractAllCommits).toHaveBeenCalled();
    expect(extractCommitsSince).not.toHaveBeenCalled();
  });

  it('falls back to full index when extractCommitsSince throws', async () => {
    // State exists
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        lastCommit: 'oldsha123',
        lastIndexedAt: '2024-01-01',
        totalChunks: 10,
        totalCommits: 5,
        embeddingDimension: 768,
      }),
    );

    // extractCommitsSince yields then throws
    async function* failingGen() {
      throw new Error('bad object');
    }
    vi.mocked(extractCommitsSince).mockReturnValue(failingGen() as any);

    // Full index fallback path
    vi.mocked(extractAllCommits).mockReturnValue(asyncIterFromArray([]) as any);

    await indexGitIncremental('/tmp/repo', testConfig as any, false);

    expect(extractCommitsSince).toHaveBeenCalled();
    expect(extractAllCommits).toHaveBeenCalled();
  });

  it('returns early with "up to date" when no new commits exist', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        lastCommit: 'oldsha123',
        lastIndexedAt: '2024-01-01',
        totalChunks: 10,
        totalCommits: 5,
        embeddingDimension: 768,
      }),
    );

    // No new commits
    vi.mocked(extractCommitsSince).mockReturnValue(asyncIterFromArray([]) as any);

    await indexGitIncremental('/tmp/repo', testConfig as any, false);

    // Should not write new state or insert chunks
    expect(insertGitChunks).not.toHaveBeenCalled();
    // writeFileSync should NOT be called (no state update on 0 commits)
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
