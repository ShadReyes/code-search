import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { RevertDetector } from '../../src/signals/detectors/revert.js';

function makeChunk(overrides: Partial<GitHistoryChunk> = {}): GitHistoryChunk {
  return {
    id: 'chunk-1',
    sha: 'aaaa1111',
    author: 'Alice',
    email: 'alice@test.com',
    date: '2025-01-10T10:00:00Z',
    subject: 'feat(auth): add login',
    body: '',
    chunk_type: 'commit_summary',
    commit_type: 'feat',
    scope: 'auth',
    file_path: '',
    text: 'feat(auth): add login',
    files_changed: 2,
    additions: 40,
    deletions: 5,
    branch: 'main',
    decision_class: 'decision',
    ...overrides,
  };
}

describe('RevertDetector', () => {
  const detector = new RevertDetector();

  it('sets affected_files from file_diff chunks of original commit', () => {
    const chunks: GitHistoryChunk[] = [
      // Original commit summary
      makeChunk({ id: 'c1-summary', sha: 'aaaa1111', subject: 'feat(auth): add login' }),
      // Original commit file diffs
      makeChunk({ id: 'c1-diff1', sha: 'aaaa1111', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'c1-diff2', sha: 'aaaa1111', chunk_type: 'file_diff', file_path: 'src/auth/types.ts' }),
      // Revert commit summary
      makeChunk({
        id: 'c2-summary',
        sha: 'bbbb2222',
        date: '2025-01-11T10:00:00Z',
        subject: 'Revert "feat(auth): add login"',
        body: 'This reverts commit aaaa1111.',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    const affected = signals[0].metadata.affected_files as string[];
    expect(affected).toContain('src/auth/login.ts');
    expect(affected).toContain('src/auth/types.ts');
    expect(affected).toHaveLength(2);
  });

  it('sets directory_scope to common ancestor directory', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1-summary', sha: 'aaaa1111', subject: 'feat(auth): add login' }),
      makeChunk({ id: 'c1-diff1', sha: 'aaaa1111', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'c1-diff2', sha: 'aaaa1111', chunk_type: 'file_diff', file_path: 'src/auth/types.ts' }),
      makeChunk({
        id: 'c2-summary',
        sha: 'bbbb2222',
        date: '2025-01-11T10:00:00Z',
        subject: 'Revert "feat(auth): add login"',
        body: 'This reverts commit aaaa1111.',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].directory_scope).toBe('src/auth');
  });

  it('falls back to directory_scope = "." when no file_diff chunks exist', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1-summary', sha: 'aaaa1111', subject: 'feat(auth): add login' }),
      // No file_diff chunks for aaaa1111
      makeChunk({
        id: 'c2-summary',
        sha: 'bbbb2222',
        date: '2025-01-11T10:00:00Z',
        subject: 'Revert "feat(auth): add login"',
        body: 'This reverts commit aaaa1111.',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].directory_scope).toBe('.');
  });

  it('sets affected_files to [] when no file_diff chunks exist', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1-summary', sha: 'aaaa1111', subject: 'feat(auth): add login' }),
      makeChunk({
        id: 'c2-summary',
        sha: 'bbbb2222',
        date: '2025-01-11T10:00:00Z',
        subject: 'Revert "feat(auth): add login"',
        body: 'This reverts commit aaaa1111.',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.affected_files).toEqual([]);
  });
});
