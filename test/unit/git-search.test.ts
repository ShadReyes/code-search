import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHistoryChunk, GitHistorySearchResult } from '../../src/types.js';

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  initGitHistoryTable: vi.fn(),
  searchGitHistory: vi.fn(),
}));

vi.mock('../../src/embeddings/provider.js', () => ({
  createProvider: vi.fn(),
}));

function makeGitChunk(overrides: Partial<GitHistoryChunk> = {}): GitHistoryChunk {
  return {
    id: 'chunk-1',
    sha: 'abc1234567890',
    author: 'Alice',
    email: 'alice@test.com',
    date: '2024-06-15T10:00:00Z',
    subject: 'feat(auth): add login',
    body: '',
    chunk_type: 'commit_summary',
    commit_type: 'feat',
    scope: 'auth',
    file_path: '',
    text: 'feat(auth): add login',
    files_changed: 3,
    additions: 50,
    deletions: 10,
    branch: 'main',
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<GitHistorySearchResult> = {}): GitHistorySearchResult {
  return {
    chunk: makeGitChunk(),
    score: 0.9,
    retrieval_method: 'vector',
    ...overrides,
  };
}

const mockConfig = {
  include: ['**/*.ts'],
  exclude: ['node_modules/**'],
  excludePatterns: [],
  maxFileLines: 2000,
  indexTests: false,
  chunkMaxTokens: 8000,
  embeddingProvider: 'ollama' as const,
  embeddingModel: 'nomic-embed-text',
  embeddingBatchSize: 50,
  searchLimit: 5,
  storeUri: undefined,
};

const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
const mockProvider = {
  embedSingle: mockEmbedSingle,
  embedBatch: vi.fn(),
  healthCheck: vi.fn(),
  probeDimension: vi.fn(),
  name: 'mock',
  supportsPrefixes: true,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('searchGitHistoryQuery', () => {
  async function loadModules() {
    // Re-mock after resetModules
    vi.mock('../../src/store.js', () => ({
      initStore: vi.fn(),
      initGitHistoryTable: vi.fn(),
      searchGitHistory: vi.fn(),
    }));
    vi.mock('../../src/embeddings/provider.js', () => ({
      createProvider: vi.fn(),
    }));

    const { searchGitHistoryQuery, formatGitResults } = await import('../../src/git/search.js');
    const { createProvider } = await import('../../src/embeddings/provider.js');
    const { initStore, initGitHistoryTable, searchGitHistory } = await import('../../src/store.js');

    return { searchGitHistoryQuery, formatGitResults, createProvider, initStore, initGitHistoryTable, searchGitHistory };
  }

  it('embeds query with search_query: prefix', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    const embedSingle = vi.fn().mockResolvedValue([0.1, 0.2]);
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    await searchGitHistoryQuery('auth changes', '/repo', mockConfig);

    expect(embedSingle).toHaveBeenCalledWith('auth changes', 'search_query: ');
  });

  it('passes limit from options, falls back to config.searchLimit', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.1]) });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    // Uses options.limit when provided
    await searchGitHistoryQuery('query', '/repo', mockConfig, { limit: 20 });
    expect(searchGitHistory).toHaveBeenCalledWith([0.1], 20, undefined);

    vi.mocked(searchGitHistory).mockClear();

    // Falls back to config.searchLimit
    await searchGitHistoryQuery('query', '/repo', { ...mockConfig, searchLimit: 15 });
    expect(searchGitHistory).toHaveBeenCalledWith([0.1], 15, undefined);
  });

  it('no filters passes undefined WHERE clause', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.5]) });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    await searchGitHistoryQuery('query', '/repo', mockConfig);

    expect(searchGitHistory).toHaveBeenCalledWith([0.5], 5, undefined);
  });

  it('after/author/file/type filters produce correct WHERE clause', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.5]) });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    await searchGitHistoryQuery('query', '/repo', mockConfig, {
      after: '2024-01-01',
      author: 'Alice',
      file: 'src/auth.ts',
      type: 'feat',
    });

    const filterArg = vi.mocked(searchGitHistory).mock.calls[0][2];
    expect(filterArg).toContain("date > '2024-01-01'");
    expect(filterArg).toContain("author = 'Alice'");
    expect(filterArg).toContain("file_path = 'src/auth.ts'");
    expect(filterArg).toContain("commit_type = 'feat'");
    expect(filterArg).toContain(' AND ');
  });

  it('SQL escaping: single quotes in filter values are doubled', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.5]) });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    await searchGitHistoryQuery('query', '/repo', mockConfig, {
      author: "O'Brien",
    });

    const filterArg = vi.mocked(searchGitHistory).mock.calls[0][2];
    expect(filterArg).toContain("author = 'O''Brien'");
  });

  it('empty results returns empty array', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.5]) });
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    const results = await searchGitHistoryQuery('nothing', '/repo', mockConfig);

    expect(results).toEqual([]);
  });

  it('results are sorted by score descending', async () => {
    const { searchGitHistoryQuery, createProvider, searchGitHistory } = await loadModules();
    vi.mocked(createProvider).mockReturnValue({ ...mockProvider, embedSingle: vi.fn().mockResolvedValue([0.5]) });
    vi.mocked(searchGitHistory).mockResolvedValue([
      makeSearchResult({ score: 0.5 }),
      makeSearchResult({ score: 0.9 }),
      makeSearchResult({ score: 0.7 }),
    ]);

    const results = await searchGitHistoryQuery('query', '/repo', mockConfig);

    expect(results[0].score).toBe(0.9);
    expect(results[1].score).toBe(0.7);
    expect(results[2].score).toBe(0.5);
  });
});

describe('formatGitResults', () => {
  it('formats commit results with sha slice and subject', async () => {
    vi.mock('../../src/store.js', () => ({
      initStore: vi.fn(),
      initGitHistoryTable: vi.fn(),
      searchGitHistory: vi.fn(),
    }));
    vi.mock('../../src/embeddings/provider.js', () => ({
      createProvider: vi.fn(),
    }));

    const { formatGitResults } = await import('../../src/git/search.js');

    const results = [
      makeSearchResult({
        chunk: makeGitChunk({ sha: 'deadbeef1234567890', subject: 'fix: resolve crash' }),
        score: 0.85,
      }),
    ];

    const output = formatGitResults(results, 'crash bug');

    expect(output).toContain('deadbee'); // 7-char sha slice
    expect(output).toContain('fix: resolve crash');
    expect(output).toContain('0.85');
  });
});
