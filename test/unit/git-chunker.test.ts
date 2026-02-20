import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitCommitRaw, GitConfig } from '../../src/types.js';

// Mock extractor before importing chunker
vi.mock('../../src/git/extractor.js', () => ({
  getCommitDiffs: vi.fn().mockResolvedValue(new Map()),
  getFileDiff: vi.fn().mockResolvedValue(''),
}));

const { chunkCommit } = await import('../../src/git/chunker.js');

function makeCommit(overrides: Partial<GitCommitRaw> = {}): GitCommitRaw {
  return {
    sha: 'abc123def456',
    author: 'Alice',
    email: 'alice@test.com',
    date: '2024-06-15T10:30:00Z',
    subject: 'feat(auth): add login flow',
    body: '',
    parents: ['parent1'],
    refs: '',
    files: [
      { path: 'src/auth/login.ts', additions: 30, deletions: 5, status: 'M' },
      { path: 'src/auth/types.ts', additions: 10, deletions: 0, status: 'A' },
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return {
    includeFileChunks: false,
    includeMergeGroups: false,
    maxDiffLinesPerFile: 50,
    enrichLowQualityMessages: true,
    lowQualityThreshold: 10,
    skipBotAuthors: [],
    skipMessagePatterns: [],
    maxCommits: 500,
    ...overrides,
  };
}

describe('chunkCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always produces a commit_summary chunk', async () => {
    const chunks = await chunkCommit(makeCommit(), '/repo', makeConfig());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const summary = chunks.find(c => c.chunk_type === 'commit_summary');
    expect(summary).toBeDefined();
    expect(summary!.sha).toBe('abc123def456');
    expect(summary!.author).toBe('Alice');
    expect(summary!.text).toContain('Alice');
    expect(summary!.text).toContain('feat(auth): add login flow');
  });

  it('parses conventional commit — "feat(auth): add login" → commitType=feat, scope=auth', async () => {
    const chunks = await chunkCommit(makeCommit(), '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.commit_type).toBe('feat');
    expect(summary.scope).toBe('auth');
  });

  it('handles non-conventional commit — empty commitType and scope', async () => {
    const commit = makeCommit({ subject: 'random change to stuff' });
    const chunks = await chunkCommit(commit, '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.commit_type).toBe('');
    expect(summary.scope).toBe('');
  });

  it('includeFileChunks=true → produces file_diff chunks', async () => {
    const config = makeConfig({ includeFileChunks: true });
    const chunks = await chunkCommit(makeCommit(), '/repo', config);
    const fileDiffs = chunks.filter(c => c.chunk_type === 'file_diff');
    expect(fileDiffs).toHaveLength(2);
    expect(fileDiffs[0].file_path).toBe('src/auth/login.ts');
    expect(fileDiffs[1].file_path).toBe('src/auth/types.ts');
  });

  it('includeFileChunks=false → no file_diff chunks', async () => {
    const config = makeConfig({ includeFileChunks: false });
    const chunks = await chunkCommit(makeCommit(), '/repo', config);
    const fileDiffs = chunks.filter(c => c.chunk_type === 'file_diff');
    expect(fileDiffs).toHaveLength(0);
  });

  it('merge commit + includeMergeGroups=true → merge_group chunk', async () => {
    const commit = makeCommit({ parents: ['parent1', 'parent2'] });
    const config = makeConfig({ includeMergeGroups: true });
    const chunks = await chunkCommit(commit, '/repo', config);
    const mergeGroup = chunks.find(c => c.chunk_type === 'merge_group');
    expect(mergeGroup).toBeDefined();
    expect(mergeGroup!.text).toContain('parent1');
    expect(mergeGroup!.text).toContain('parent2');
    expect(mergeGroup!.text).toContain('Files changed');
  });

  it('merge commit + includeMergeGroups=false → no merge_group', async () => {
    const commit = makeCommit({ parents: ['parent1', 'parent2'] });
    const config = makeConfig({ includeMergeGroups: false });
    const chunks = await chunkCommit(commit, '/repo', config);
    const mergeGroup = chunks.find(c => c.chunk_type === 'merge_group');
    expect(mergeGroup).toBeUndefined();
  });

  it('non-merge commit → no merge_group even when enabled', async () => {
    const commit = makeCommit({ parents: ['parent1'] });
    const config = makeConfig({ includeMergeGroups: true });
    const chunks = await chunkCommit(commit, '/repo', config);
    const mergeGroup = chunks.find(c => c.chunk_type === 'merge_group');
    expect(mergeGroup).toBeUndefined();
  });

  it('extracts branch from refs — "HEAD -> main"', async () => {
    const commit = makeCommit({ refs: 'HEAD -> main, origin/main' });
    const chunks = await chunkCommit(commit, '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.branch).toBe('main');
  });

  it('extracts branch from merge message — "from feature-x"', async () => {
    const commit = makeCommit({
      subject: 'Merge pull request from feature-x',
      refs: '',
    });
    const chunks = await chunkCommit(commit, '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.branch).toBe('feature-x');
  });

  it('summary text includes files, directories, and author', async () => {
    const chunks = await chunkCommit(makeCommit(), '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.text).toContain('src/auth/login.ts');
    expect(summary.text).toContain('src/auth/types.ts');
    expect(summary.text).toContain('Alice');
    expect(summary.text).toContain('src/auth');
  });

  it('tracks additions and deletions correctly', async () => {
    const chunks = await chunkCommit(makeCommit(), '/repo', makeConfig());
    const summary = chunks.find(c => c.chunk_type === 'commit_summary')!;
    expect(summary.additions).toBe(40); // 30 + 10
    expect(summary.deletions).toBe(5);
    expect(summary.files_changed).toBe(2);
  });
});
