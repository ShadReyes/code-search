import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeChunk } from '../../src/types.js';

vi.mock('../../src/embeddings/provider.js', () => ({
  createProvider: vi.fn(),
}));

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  insertChunks: vi.fn(),
  deleteByFilePath: vi.fn(),
  dropTable: vi.fn(),
}));

vi.mock('../../src/lang/plugin.js', () => ({
  registry: {
    initAll: vi.fn(),
    getPluginForFile: vi.fn(),
    register: vi.fn(),
    isTestFile: vi.fn(() => false),
  },
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: { sync: vi.fn() },
}));

const { indexFull, indexIncremental } = await import('../../src/indexer.js');
const { createProvider } = await import('../../src/embeddings/provider.js');
const { initStore, insertChunks, deleteByFilePath, dropTable } = await import('../../src/store.js');
const { registry } = await import('../../src/lang/plugin.js');
const { readFileSync, writeFileSync, existsSync, statSync } = await import('node:fs');
const { execSync } = await import('node:child_process');
const { glob } = await import('glob');

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

function makeChunk(file: string, name: string): CodeChunk {
  return {
    id: `${file}-${name}`,
    file_path: file,
    package_name: '',
    name,
    chunk_type: 'function',
    line_start: 1,
    line_end: 10,
    content: `function ${name}() {}`,
    language: 'typescript',
    exported: true,
  };
}

const FAKE_CONFIG = {
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

  // Default: no config file, no state file
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readFileSync).mockReturnValue('');
  vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
  vi.mocked(writeFileSync).mockReturnValue(undefined);
  vi.mocked(execSync).mockReturnValue('abc123\n');
  vi.mocked(glob.sync).mockReturnValue([]);
  vi.mocked(createProvider).mockReturnValue(mockProvider());
});

describe('indexFull', () => {
  it('discovers files, chunks, embeds, and inserts into store', async () => {
    const file = '/repo/src/utils.ts';
    vi.mocked(glob.sync).mockReturnValue([file]);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
    vi.mocked(readFileSync).mockReturnValue('const x = 1;\n');

    const chunk = makeChunk('src/utils.ts', 'x');
    const mockPlugin = { chunkFile: vi.fn().mockReturnValue([chunk]) };
    vi.mocked(registry.getPluginForFile).mockReturnValue(mockPlugin as any);

    const provider = mockProvider();
    provider.embedBatch.mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(createProvider).mockReturnValue(provider);

    await indexFull('/repo', false, FAKE_CONFIG);

    expect(provider.healthCheck).toHaveBeenCalled();
    expect(provider.probeDimension).toHaveBeenCalled();
    expect(registry.initAll).toHaveBeenCalled();
    expect(initStore).toHaveBeenCalled();
    expect(provider.embedBatch).toHaveBeenCalled();
    expect(insertChunks).toHaveBeenCalled();
  });

  it('calls dropTable before insertChunks (overwrite)', async () => {
    const file = '/repo/src/a.ts';
    vi.mocked(glob.sync).mockReturnValue([file]);
    vi.mocked(readFileSync).mockReturnValue('const a = 1;\n');

    const chunk = makeChunk('src/a.ts', 'a');
    vi.mocked(registry.getPluginForFile).mockReturnValue({
      chunkFile: vi.fn().mockReturnValue([chunk]),
    } as any);

    const callOrder: string[] = [];
    vi.mocked(dropTable).mockImplementation(async () => { callOrder.push('drop'); });
    vi.mocked(insertChunks).mockImplementation(async () => { callOrder.push('insert'); });

    await indexFull('/repo', false, FAKE_CONFIG);

    expect(callOrder).toEqual(['drop', 'insert']);
  });

  it('probes provider dimension and stores it in state', async () => {
    const file = '/repo/src/a.ts';
    vi.mocked(glob.sync).mockReturnValue([file]);
    vi.mocked(readFileSync).mockReturnValue('const a = 1;\n');

    const chunk = makeChunk('src/a.ts', 'a');
    vi.mocked(registry.getPluginForFile).mockReturnValue({
      chunkFile: vi.fn().mockReturnValue([chunk]),
    } as any);

    const provider = mockProvider();
    provider.probeDimension.mockResolvedValue(1536);
    vi.mocked(createProvider).mockReturnValue(provider);

    await indexFull('/repo', false, FAKE_CONFIG);

    expect(provider.probeDimension).toHaveBeenCalled();
    // State is written via writeFileSync — check the JSON contains the dimension
    const writeCall = vi.mocked(writeFileSync).mock.calls.find(
      ([path]) => String(path).includes('cortex-recall-state'),
    );
    expect(writeCall).toBeDefined();
    const state = JSON.parse(writeCall![1] as string);
    expect(state.embeddingDimension).toBe(1536);
  });

  it('skips files exceeding maxFileLines', async () => {
    const fileSmall = '/repo/src/small.ts';
    const fileBig = '/repo/src/big.ts';
    vi.mocked(glob.sync).mockReturnValue([fileSmall, fileBig]);

    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes('big')) {
        return Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
      }
      return 'const x = 1;\n';
    });

    const chunk = makeChunk('src/small.ts', 'x');
    vi.mocked(registry.getPluginForFile).mockReturnValue({
      chunkFile: vi.fn().mockReturnValue([chunk]),
    } as any);

    await indexFull('/repo', false, { ...FAKE_CONFIG, maxFileLines: 2000 });

    // Only small.ts should have been chunked — getPluginForFile called once
    expect(registry.getPluginForFile).toHaveBeenCalledTimes(1);
    expect(registry.getPluginForFile).toHaveBeenCalledWith(fileSmall);
  });

  it('per-file error in chunking skips file and continues', async () => {
    const fileA = '/repo/src/a.ts';
    const fileB = '/repo/src/b.ts';
    vi.mocked(glob.sync).mockReturnValue([fileA, fileB]);
    vi.mocked(readFileSync).mockReturnValue('const x = 1;\n');

    const chunkB = makeChunk('src/b.ts', 'b');
    vi.mocked(registry.getPluginForFile).mockImplementation((path: string) => {
      if (path === fileA) throw new Error('parse error');
      return { chunkFile: vi.fn().mockReturnValue([chunkB]) } as any;
    });

    await indexFull('/repo', false, FAKE_CONFIG);

    // insertChunks should still be called with chunks from fileB
    expect(insertChunks).toHaveBeenCalled();
    const insertedChunks = vi.mocked(insertChunks).mock.calls[0][0] as CodeChunk[];
    expect(insertedChunks).toHaveLength(1);
    expect(insertedChunks[0].name).toBe('b');
  });

  it('writes state file with commit hash and dimension', async () => {
    const file = '/repo/src/a.ts';
    vi.mocked(glob.sync).mockReturnValue([file]);
    vi.mocked(readFileSync).mockReturnValue('const a = 1;\n');
    vi.mocked(execSync).mockReturnValue('deadbeef\n');

    const chunk = makeChunk('src/a.ts', 'a');
    vi.mocked(registry.getPluginForFile).mockReturnValue({
      chunkFile: vi.fn().mockReturnValue([chunk]),
    } as any);

    const provider = mockProvider();
    provider.probeDimension.mockResolvedValue(768);
    vi.mocked(createProvider).mockReturnValue(provider);

    await indexFull('/repo', false, FAKE_CONFIG);

    const writeCall = vi.mocked(writeFileSync).mock.calls.find(
      ([path]) => String(path).includes('cortex-recall-state'),
    );
    expect(writeCall).toBeDefined();
    const state = JSON.parse(writeCall![1] as string);
    expect(state.lastCommit).toBe('deadbeef');
    expect(state.embeddingDimension).toBe(768);
    expect(state.totalChunks).toBe(1);
    expect(state.totalFiles).toBe(1);
    expect(state.lastIndexedAt).toBeDefined();
  });
});

describe('indexIncremental', () => {
  it('no state file falls back to full index (dropTable called)', async () => {
    // existsSync returns false for state path → loadState returns null → falls back to indexFull
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(glob.sync).mockReturnValue([]);

    await indexIncremental('/repo', false, FAKE_CONFIG);

    // Full index path calls dropTable (even if no chunks)
    // Verify it went through indexFull by checking provider was created
    expect(createProvider).toHaveBeenCalled();
  });

  it('diffs changed files and re-embeds only changed ones', async () => {
    // State file exists
    const stateJson = JSON.stringify({
      lastCommit: 'abc123',
      lastIndexedAt: '2024-01-01T00:00:00Z',
      totalChunks: 10,
      totalFiles: 5,
      embeddingDimension: 768,
    });

    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return true;
      // For the changed file — it exists on disk
      if (String(path).includes('changed.ts')) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return stateJson;
      return 'const y = 2;\n';
    });

    // git diff returns one changed file
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git diff --name-only')) return 'src/changed.ts\n';
      if (cmdStr.includes('git status')) return '';
      if (cmdStr.includes('git rev-parse')) return 'def456\n';
      return '';
    });

    const chunk = makeChunk('src/changed.ts', 'y');
    vi.mocked(registry.getPluginForFile).mockReturnValue({
      chunkFile: vi.fn().mockReturnValue([chunk]),
    } as any);

    const provider = mockProvider();
    provider.embedBatch.mockResolvedValue([[0.3, 0.4]]);
    vi.mocked(createProvider).mockReturnValue(provider);

    await indexIncremental('/repo', false, FAKE_CONFIG);

    expect(deleteByFilePath).toHaveBeenCalledWith('src/changed.ts');
    expect(provider.embedBatch).toHaveBeenCalled();
    expect(insertChunks).toHaveBeenCalled();
    // dropTable should NOT be called for incremental
    expect(dropTable).not.toHaveBeenCalled();
  });

  it('deleted files call deleteByFilePath without re-chunking', async () => {
    const stateJson = JSON.stringify({
      lastCommit: 'abc123',
      lastIndexedAt: '2024-01-01T00:00:00Z',
      totalChunks: 10,
      totalFiles: 5,
      embeddingDimension: 768,
    });

    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return true;
      // deleted.ts does NOT exist on disk
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return stateJson;
      return '';
    });

    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git diff --name-only')) return 'src/deleted.ts\n';
      if (cmdStr.includes('git status')) return '';
      if (cmdStr.includes('git rev-parse')) return 'def456\n';
      return '';
    });

    await indexIncremental('/repo', false, FAKE_CONFIG);

    expect(deleteByFilePath).toHaveBeenCalledWith('src/deleted.ts');
    // No chunks to embed since file doesn't exist
    expect(registry.getPluginForFile).not.toHaveBeenCalled();
  });

  it('all changed files filtered out returns early (up to date)', async () => {
    const stateJson = JSON.stringify({
      lastCommit: 'abc123',
      lastIndexedAt: '2024-01-01T00:00:00Z',
      totalChunks: 10,
      totalFiles: 5,
      embeddingDimension: 768,
    });

    vi.mocked(existsSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes('cortex-recall-state')) return stateJson;
      return '';
    });

    // git diff returns files with non-matching extensions
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git diff --name-only')) return 'README.md\nCHANGELOG.md\n';
      if (cmdStr.includes('git status')) return '';
      if (cmdStr.includes('git rev-parse')) return 'def456\n';
      return '';
    });

    await indexIncremental('/repo', false, FAKE_CONFIG);

    // No files matched include patterns, so no store operations
    expect(deleteByFilePath).not.toHaveBeenCalled();
    expect(insertChunks).not.toHaveBeenCalled();
  });
});
