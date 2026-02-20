import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHistoryChunk, GitHistorySearchResult, CodeChunk, SearchResult } from '../../src/types.js';

vi.mock('../../src/search.js', () => ({
  searchCode: vi.fn(),
}));

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  initGitHistoryTable: vi.fn(),
  searchGitHistory: vi.fn(),
}));

vi.mock('../../src/embeddings/provider.js', () => ({
  createProvider: vi.fn(),
}));

const { explain, formatExplainResult } = await import('../../src/git/cross-ref.js');
const { searchCode } = await import('../../src/search.js');
const { initStore, initGitHistoryTable, searchGitHistory } = await import('../../src/store.js');
const { createProvider } = await import('../../src/embeddings/provider.js');

function makeCodeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: 'chunk-1',
    file_path: 'src/auth/login.ts',
    package_name: '',
    name: 'loginHandler',
    chunk_type: 'function',
    line_start: 10,
    line_end: 30,
    content: 'export function loginHandler() {}',
    language: 'typescript',
    exported: true,
    ...overrides,
  };
}

function makeCodeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    chunk: makeCodeChunk(),
    score: 0.92,
    ...overrides,
  };
}

function makeGitChunk(overrides: Partial<GitHistoryChunk> = {}): GitHistoryChunk {
  return {
    id: 'git-1',
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

function makeGitResult(overrides: Partial<GitHistorySearchResult> = {}): GitHistorySearchResult {
  return {
    chunk: makeGitChunk(),
    score: 0.85,
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

const mockProvider = {
  embedSingle: vi.fn().mockResolvedValue([0.1, 0.2]),
  embedBatch: vi.fn(),
  healthCheck: vi.fn(),
  probeDimension: vi.fn(),
  name: 'mock',
  supportsPrefixes: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createProvider).mockReturnValue(mockProvider);
});

describe('explain', () => {
  it('happy path: returns both codeResults and gitResults', async () => {
    vi.mocked(searchCode).mockResolvedValue([makeCodeResult()]);
    vi.mocked(searchGitHistory).mockResolvedValue([makeGitResult()]);

    const result = await explain('auth login', '/repo', mockConfig);

    expect(result.codeResults).toHaveLength(1);
    expect(result.codeResults[0].chunk.file_path).toBe('src/auth/login.ts');
    expect(result.codeResults[0].fileHistory).toBeDefined();
    expect(result.gitResults).toHaveLength(1);
    expect(result.gitResults[0].chunk.sha).toBe('abc1234567890');
  });

  it('code index missing: catches error, returns empty codeResults', async () => {
    vi.mocked(searchCode).mockRejectedValue(new Error('table not found'));
    vi.mocked(searchGitHistory).mockResolvedValue([makeGitResult()]);

    const result = await explain('auth login', '/repo', mockConfig);

    expect(result.codeResults).toEqual([]);
    expect(result.gitResults).toHaveLength(1);
  });

  it('git index missing: catches error, returns empty gitResults', async () => {
    vi.mocked(searchCode).mockResolvedValue([makeCodeResult()]);
    // First call is for file history (inside explain's code loop), second is the direct git search
    // The direct git search uses createProvider + searchGitHistory
    // Make createProvider throw for the git search path
    vi.mocked(searchGitHistory)
      .mockResolvedValueOnce([]) // file history call
      .mockRejectedValueOnce(new Error('table not found')); // direct git search

    const result = await explain('auth login', '/repo', mockConfig);

    expect(result.codeResults).toHaveLength(1);
    expect(result.gitResults).toEqual([]);
  });

  it('both indexes missing: returns empty ExplainResult', async () => {
    vi.mocked(searchCode).mockRejectedValue(new Error('code table not found'));
    vi.mocked(createProvider).mockImplementation(() => { throw new Error('no provider'); });

    const result = await explain('auth login', '/repo', mockConfig);

    expect(result.codeResults).toEqual([]);
    expect(result.gitResults).toEqual([]);
  });

  it('per-file history fetch fails: codeResults still returned with empty fileHistory', async () => {
    vi.mocked(searchCode).mockResolvedValue([makeCodeResult()]);
    // File history call rejects, but direct git search succeeds
    vi.mocked(searchGitHistory)
      .mockRejectedValueOnce(new Error('history fetch failed')) // file history
      .mockResolvedValueOnce([makeGitResult()]); // direct git search

    const result = await explain('auth login', '/repo', mockConfig);

    expect(result.codeResults).toHaveLength(1);
    expect(result.codeResults[0].fileHistory).toEqual([]);
    expect(result.gitResults).toHaveLength(1);
  });

  it('ExplainResult shape matches interface', async () => {
    vi.mocked(searchCode).mockResolvedValue([]);
    vi.mocked(searchGitHistory).mockResolvedValue([]);

    const result = await explain('query', '/repo', mockConfig);

    expect(result).toHaveProperty('codeResults');
    expect(result).toHaveProperty('gitResults');
    expect(Array.isArray(result.codeResults)).toBe(true);
    expect(Array.isArray(result.gitResults)).toBe(true);
  });
});

describe('formatExplainResult', () => {
  it('shows helpful tips when no results', () => {
    const emptyResult = { codeResults: [], gitResults: [] };
    const output = formatExplainResult(emptyResult, 'nonexistent');

    expect(output).toContain('Tip:');
    expect(output).toContain('cortex-recall');
  });
});
