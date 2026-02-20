import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchResult, CodeChunk } from '../../src/types.js';

vi.mock('../../src/embeddings/provider.js', () => ({
  createProvider: vi.fn(),
}));

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/indexer.js', () => ({
  loadConfig: vi.fn(),
}));

const { searchCode, formatResults } = await import('../../src/search.js');
const { createProvider } = await import('../../src/embeddings/provider.js');
const { initStore, search } = await import('../../src/store.js');
const { loadConfig } = await import('../../src/indexer.js');

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: 'chunk-1',
    file_path: 'src/utils.ts',
    package_name: '',
    name: 'myFunction',
    chunk_type: 'function',
    line_start: 1,
    line_end: 10,
    content: 'export function myFunction() { return 1; }',
    language: 'typescript',
    exported: true,
    ...overrides,
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    chunk: makeChunk(),
    score: 0.95,
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchCode', () => {
  it('embeds query via provider.embedSingle and passes vector to vectorSearch', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2]);
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: mockEmbedSingle,
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });
    vi.mocked(search).mockResolvedValue([makeResult()]);

    await searchCode('find utils', '/repo');

    expect(mockEmbedSingle).toHaveBeenCalledWith('find utils');
    expect(search).toHaveBeenCalledWith([0.1, 0.2], 5, undefined);
  });

  it('passes limit and fileFilter to vectorSearch', async () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: vi.fn().mockResolvedValue([0.1, 0.2]),
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });
    vi.mocked(search).mockResolvedValue([]);

    await searchCode('query', '/repo', 10, 'src/auth');

    expect(search).toHaveBeenCalledWith([0.1, 0.2], 10, 'src/auth');
  });

  it('returns SearchResult[] shaped correctly', async () => {
    const expected = [makeResult(), makeResult({ score: 0.8 })];
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: vi.fn().mockResolvedValue([0.1]),
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });
    vi.mocked(search).mockResolvedValue(expected);

    const results = await searchCode('query', '/repo');

    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.95);
    expect(results[0].chunk.file_path).toBe('src/utils.ts');
    expect(results[1].score).toBe(0.8);
  });

  it('empty results from search returns empty array', async () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: vi.fn().mockResolvedValue([0.1]),
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });
    vi.mocked(search).mockResolvedValue([]);

    const results = await searchCode('nothing', '/repo');

    expect(results).toEqual([]);
  });

  it('provider.embedSingle throws propagates error', async () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: vi.fn().mockRejectedValue(new Error('embed failed')),
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });

    await expect(searchCode('query', '/repo')).rejects.toThrow('embed failed');
  });

  it('verbose flag passes through to loadConfig', async () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(createProvider).mockReturnValue({
      embedSingle: vi.fn().mockResolvedValue([0.1]),
      embedBatch: vi.fn(),
      healthCheck: vi.fn(),
      probeDimension: vi.fn(),
      name: 'mock',
      supportsPrefixes: false,
    });
    vi.mocked(search).mockResolvedValue([]);

    await searchCode('query', '/my-repo', undefined, undefined, true);

    expect(loadConfig).toHaveBeenCalledWith('/my-repo', true);
  });
});

describe('formatResults', () => {
  it('formats scored results with truncated previews', () => {
    const longContent = 'x'.repeat(150);
    const results = [makeResult({ chunk: makeChunk({ content: longContent }) })];

    const output = formatResults(results, 'test query');

    expect(output).toContain('...');
    expect(output).toContain('src/utils.ts');
    expect(output).toContain('0.95');
  });

  it('empty results returns "No results" message', () => {
    const output = formatResults([], 'test query');

    expect(output).toContain('No results');
    expect(output).toContain('test query');
  });
});
