import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { BreakingChangeDetector } from '../../src/signals/detectors/breaking.js';

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

describe('BreakingChangeDetector', () => {
  const detector = new BreakingChangeDetector();

  it('returns empty when no non-fix commits exist', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1-summary', sha: 'aaa1', commit_type: 'fix', subject: 'fix(auth): patch login' }),
      makeChunk({ id: 'c1-diff', sha: 'aaa1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'c2-summary', sha: 'bbb2', commit_type: 'fix', author: 'Bob', subject: 'fix(auth): another fix' }),
      makeChunk({ id: 'c2-diff', sha: 'bbb2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when fixes are by the same author', () => {
    const chunks: GitHistoryChunk[] = [
      // Original by Alice
      makeChunk({ id: 'c1-summary', sha: 'aaa1', author: 'Alice', commit_type: 'feat', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'c1-diff', sha: 'aaa1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-10T10:00:00Z' }),
      // Fix by Bob (only 1 fix author, need >= 2)
      makeChunk({ id: 'c2-summary', sha: 'bbb2', author: 'Bob', commit_type: 'fix', date: '2025-01-10T22:00:00Z' }),
      makeChunk({ id: 'c2-diff', sha: 'bbb2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-10T22:00:00Z' }),
      // Another fix also by Bob
      makeChunk({ id: 'c3-summary', sha: 'ccc3', author: 'Bob', commit_type: 'fix', date: '2025-01-11T06:00:00Z' }),
      makeChunk({ id: 'c3-diff', sha: 'ccc3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-11T06:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when fewer than 2 fix authors', () => {
    const chunks: GitHistoryChunk[] = [
      // Original by Alice
      makeChunk({ id: 'c1-summary', sha: 'aaa1', author: 'Alice', commit_type: 'feat', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'c1-diff', sha: 'aaa1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-10T10:00:00Z' }),
      // Only 1 fix by Bob
      makeChunk({ id: 'c2-summary', sha: 'bbb2', author: 'Bob', commit_type: 'fix', date: '2025-01-10T22:00:00Z' }),
      makeChunk({ id: 'c2-diff', sha: 'bbb2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-10T22:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when fixes are outside 48h window', () => {
    const chunks: GitHistoryChunk[] = [
      // Original by Alice
      makeChunk({ id: 'c1-summary', sha: 'aaa1', author: 'Alice', commit_type: 'feat', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'c1-diff', sha: 'aaa1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-10T10:00:00Z' }),
      // Fix by Bob 3 days later (outside 48h)
      makeChunk({ id: 'c2-summary', sha: 'bbb2', author: 'Bob', commit_type: 'fix', date: '2025-01-13T10:00:00Z' }),
      makeChunk({ id: 'c2-diff', sha: 'bbb2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-13T10:00:00Z' }),
      // Fix by Charlie 4 days later (outside 48h)
      makeChunk({ id: 'c3-summary', sha: 'ccc3', author: 'Charlie', commit_type: 'fix', date: '2025-01-14T10:00:00Z' }),
      makeChunk({ id: 'c3-diff', sha: 'ccc3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', date: '2025-01-14T10:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('detects multi-author fix cascade', () => {
    const chunks: GitHistoryChunk[] = [
      // Original commit by Alice
      makeChunk({
        id: 'c1-summary',
        sha: 'aaa1',
        author: 'Alice',
        commit_type: 'feat',
        subject: 'feat(auth): add login',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c1-diff',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T10:00:00Z',
      }),
      // Fix by Bob 12h later
      makeChunk({
        id: 'c2-summary',
        sha: 'bbb2',
        author: 'Bob',
        commit_type: 'fix',
        subject: 'fix(auth): patch login crash',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c2-diff',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T22:00:00Z',
      }),
      // Fix by Charlie 24h later
      makeChunk({
        id: 'c3-summary',
        sha: 'ccc3',
        author: 'Charlie',
        commit_type: 'fix',
        subject: 'fix(auth): handle edge case',
        date: '2025-01-11T10:00:00Z',
      }),
      makeChunk({
        id: 'c3-diff',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-11T10:00:00Z',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('breaking_change');
    expect(signals[0].metadata.trigger_sha).toBe('aaa1');
    expect(signals[0].metadata.author_count).toBe(2);
    expect(signals[0].metadata.fix_count).toBe(2);
  });

  it('requires directory overlap not just file overlap', () => {
    const chunks: GitHistoryChunk[] = [
      // Original by Alice touches src/auth/login.ts
      makeChunk({
        id: 'c1-summary',
        sha: 'aaa1',
        author: 'Alice',
        commit_type: 'feat',
        subject: 'feat(auth): add login',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c1-diff',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T10:00:00Z',
      }),
      // Fix by Bob touches src/auth/other.ts (same directory, different file)
      makeChunk({
        id: 'c2-summary',
        sha: 'bbb2',
        author: 'Bob',
        commit_type: 'fix',
        subject: 'fix(auth): fix other module',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c2-diff',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'src/auth/other.ts',
        date: '2025-01-10T22:00:00Z',
      }),
      // Fix by Charlie touches src/auth/types.ts (same directory, different file)
      makeChunk({
        id: 'c3-summary',
        sha: 'ccc3',
        author: 'Charlie',
        commit_type: 'fix',
        subject: 'fix(auth): fix types',
        date: '2025-01-11T10:00:00Z',
      }),
      makeChunk({
        id: 'c3-diff',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'src/auth/types.ts',
        date: '2025-01-11T10:00:00Z',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('breaking_change');
  });

  it('metadata is correct', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1-summary',
        sha: 'aaa1',
        author: 'Alice',
        commit_type: 'feat',
        subject: 'feat(auth): add login',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c1-diff',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c2-summary',
        sha: 'bbb2',
        author: 'Bob',
        commit_type: 'fix',
        subject: 'fix(auth): patch login',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c2-diff',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c3-summary',
        sha: 'ccc3',
        author: 'Charlie',
        commit_type: 'fix',
        subject: 'fix(auth): edge case',
        date: '2025-01-11T10:00:00Z',
      }),
      makeChunk({
        id: 'c3-diff',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-11T10:00:00Z',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);

    const meta = signals[0].metadata;
    expect(meta.trigger_sha).toBe('aaa1');
    expect(meta.trigger_subject).toBe('feat(auth): add login');
    expect(meta.trigger_author).toBe('Alice');
    expect(meta.author_count).toBe(2);
    expect(meta.fix_count).toBe(2);
    expect(meta.affected_files).toBe(1); // all touch the same file
    expect(meta.fix_authors).toEqual(expect.arrayContaining(['Bob', 'Charlie']));
    expect(meta.fix_shas).toEqual(expect.arrayContaining(['bbb2', 'ccc3']));
  });

  it('severity is always warning', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1-summary',
        sha: 'aaa1',
        author: 'Alice',
        commit_type: 'feat',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c1-diff',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T10:00:00Z',
      }),
      makeChunk({
        id: 'c2-summary',
        sha: 'bbb2',
        author: 'Bob',
        commit_type: 'fix',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c2-diff',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-10T22:00:00Z',
      }),
      makeChunk({
        id: 'c3-summary',
        sha: 'ccc3',
        author: 'Charlie',
        commit_type: 'fix',
        date: '2025-01-11T10:00:00Z',
      }),
      makeChunk({
        id: 'c3-diff',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'src/auth/login.ts',
        date: '2025-01-11T10:00:00Z',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('warning');
  });
});
