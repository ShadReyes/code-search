import { describe, it, expect } from 'vitest';
import { enrichChunk } from '../../src/git/enricher.js';
import type { GitHistoryChunk, GitConfig } from '../../src/types.js';

function makeChunk(overrides: Partial<GitHistoryChunk> = {}): GitHistoryChunk {
  return {
    id: 'abc123',
    sha: 'deadbeef',
    author: 'Alice',
    email: 'alice@test.com',
    date: '2024-06-15',
    subject: 'feat(auth): add login flow',
    body: '',
    chunk_type: 'commit_summary',
    commit_type: 'feat',
    scope: 'auth',
    file_path: '',
    text: 'original text',
    files_changed: 3,
    additions: 50,
    deletions: 10,
    branch: 'main',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return {
    includeFileChunks: true,
    includeMergeGroups: true,
    maxDiffLinesPerFile: 50,
    enrichLowQualityMessages: true,
    lowQualityThreshold: 10,
    skipBotAuthors: [],
    skipMessagePatterns: [],
    maxCommits: 500,
    ...overrides,
  };
}

describe('enrichChunk', () => {
  it('skips non-commit_summary chunks (file_diff)', () => {
    const chunk = makeChunk({ chunk_type: 'file_diff', subject: 'fix' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result).toBe(chunk);
  });

  it('skips non-commit_summary chunks (merge_group)', () => {
    const chunk = makeChunk({ chunk_type: 'merge_group', subject: 'fix' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result).toBe(chunk);
  });

  it('skips when enrichment disabled', () => {
    const chunk = makeChunk({ subject: 'fix' });
    const result = enrichChunk(chunk, makeConfig({ enrichLowQualityMessages: false }));
    expect(result).toBe(chunk);
  });

  it('skips high-quality messages', () => {
    const chunk = makeChunk({ subject: 'feat(auth): implement OAuth2 login with Google provider' });
    const result = enrichChunk(chunk, makeConfig());
    // Subject is long and doesn't match low-quality pattern
    expect(result.text).toBe('original text');
  });

  it('enriches short subjects (below threshold)', () => {
    const chunk = makeChunk({ subject: 'stuff', file_path: 'src/auth/login.ts' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toBe('original text');
    expect(result.text).toContain('Alice');
    expect(result.text).toContain('stuff');
  });

  it('enriches pattern-matched subjects — "fix"', () => {
    const chunk = makeChunk({ subject: 'fix' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toBe('original text');
  });

  it('enriches pattern-matched subjects — "wip"', () => {
    const chunk = makeChunk({ subject: 'wip' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toBe('original text');
  });

  it('enriches pattern-matched subjects — "update"', () => {
    const chunk = makeChunk({ subject: 'update' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toBe('original text');
  });

  it('enriches pattern-matched subjects — "typo"', () => {
    const chunk = makeChunk({ subject: 'typo' });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toBe('original text');
  });

  it('enriched text includes body when present', () => {
    const chunk = makeChunk({
      subject: 'fix',
      body: 'Fixed the auth bug in login flow',
    });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).toContain('Fixed the auth bug in login flow');
  });

  it('enriched text includes file count and stats', () => {
    const chunk = makeChunk({
      subject: 'fix',
      files_changed: 5,
      additions: 20,
      deletions: 3,
    });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).toContain('Files changed: 5');
    expect(result.text).toContain('20 additions');
    expect(result.text).toContain('3 deletions');
  });

  it('enriched text includes scope from src/X/Y path', () => {
    const chunk = makeChunk({
      subject: 'fix',
      file_path: 'src/auth/middleware.ts',
    });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).toContain('Change scope: auth/middleware.ts');
  });

  it('enriched text includes scope from non-src path (first component)', () => {
    const chunk = makeChunk({
      subject: 'fix',
      file_path: 'lib/utils.ts',
    });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).toContain('Change scope: lib');
  });

  it('enriched text omits scope for empty file_path', () => {
    const chunk = makeChunk({
      subject: 'fix',
      file_path: '',
    });
    const result = enrichChunk(chunk, makeConfig());
    expect(result.text).not.toContain('Change scope');
  });
});
