import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { OwnershipDetector } from '../../src/signals/detectors/ownership.js';

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

describe('OwnershipDetector', () => {
  const detector = new OwnershipDetector();

  it('returns empty for no file_diff chunks', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1', sha: 'aaa1' }),
      makeChunk({ id: 'c2', sha: 'aaa2', subject: 'fix(auth): patch' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('skips files with fewer than 3 changes', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice' }),
    ];

    const signals = detector.detect(chunks);
    // No file-level ownership signal because only 2 changes
    const fileSignals = signals.filter(s => s.metadata.file !== undefined);
    expect(fileSignals).toHaveLength(0);
  });

  it('emits file ownership when top author >= 30%', () => {
    const chunks: GitHistoryChunk[] = [
      // Alice: 4 commits
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-13T10:00:00Z' }),
      // Bob: 1 commit
      makeChunk({ id: 'd5', sha: 'sha5', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Bob', date: '2025-01-14T10:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    const fileSignals = signals.filter(s => s.metadata.file !== undefined);
    expect(fileSignals).toHaveLength(1);
    expect(fileSignals[0].metadata.primary_author).toBe('Alice');
    expect(fileSignals[0].metadata.percentage).toBe(80);
    expect(fileSignals[0].metadata.total_commits).toBe(5);
  });

  it('no signal when top author < 30%', () => {
    // 4 authors, each with 1 commit on same file (25% each) -- total 4 >= 3
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Bob' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Charlie' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Diana' }),
    ];

    const signals = detector.detect(chunks);
    const fileSignals = signals.filter(s => s.metadata.file !== undefined);
    expect(fileSignals).toHaveLength(0);
  });

  it('emits directory ownership signal', () => {
    // Alice dominant in src/auth/ directory, total >= 5
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/types.ts', author: 'Alice', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/types.ts', author: 'Alice', date: '2025-01-13T10:00:00Z' }),
      makeChunk({ id: 'd5', sha: 'sha5', chunk_type: 'file_diff', file_path: 'src/auth/middleware.ts', author: 'Bob', date: '2025-01-14T10:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    const dirSignals = signals.filter(s => s.metadata.directory !== undefined);
    expect(dirSignals).toHaveLength(1);
    expect(dirSignals[0].metadata.directory).toBe('src/auth');
    expect(dirSignals[0].metadata.primary_author).toBe('Alice');
    expect(dirSignals[0].metadata.percentage).toBe(80);
  });

  it('skips directory with fewer than 5 commits', () => {
    // Only 4 commits total in the directory
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/types.ts', author: 'Alice' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/types.ts', author: 'Bob' }),
    ];

    const signals = detector.detect(chunks);
    const dirSignals = signals.filter(s => s.metadata.directory !== undefined);
    expect(dirSignals).toHaveLength(0);
  });

  it('skips root directory (.)', () => {
    // Files without subdirectory (file_path like "index.ts") -> dirname is "."
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'index.ts', author: 'Alice' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'index.ts', author: 'Alice' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'index.ts', author: 'Alice' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'config.ts', author: 'Alice' }),
      makeChunk({ id: 'd5', sha: 'sha5', chunk_type: 'file_diff', file_path: 'config.ts', author: 'Alice' }),
      makeChunk({ id: 'd6', sha: 'sha6', chunk_type: 'file_diff', file_path: 'config.ts', author: 'Alice' }),
    ];

    const signals = detector.detect(chunks);
    // No directory-level signal for root "."
    const dirSignals = signals.filter(s => s.metadata.directory !== undefined);
    expect(dirSignals).toHaveLength(0);
  });

  it('custom minPercent=50 raises the ownership bar', () => {
    // Alice: 2 commits, Bob: 1 commit → Alice at 67%
    // With default minPercent=30: Alice qualifies
    // With minPercent=50: Alice still qualifies (67% >= 50%)
    // But if Alice: 2, Bob: 2, Charlie: 1 → Alice at 40%
    // With minPercent=30: Alice qualifies (40% >= 30%)
    // With minPercent=50: Alice does NOT qualify (40% < 50%)
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Bob', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Bob', date: '2025-01-13T10:00:00Z' }),
      makeChunk({ id: 'd5', sha: 'sha5', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Charlie', date: '2025-01-14T10:00:00Z' }),
    ];

    const defaultDetector = new OwnershipDetector();
    const strictDetector = new OwnershipDetector({ minPercent: 50, minCommits: 1 });

    const defaultSignals = defaultDetector.detect(chunks);
    const strictSignals = strictDetector.detect(chunks);

    const defaultFileSignals = defaultSignals.filter(s => s.metadata.file !== undefined);
    const strictFileSignals = strictSignals.filter(s => s.metadata.file !== undefined);

    // Default: Alice at 40% >= 30% → signal emitted
    expect(defaultFileSignals).toHaveLength(1);
    expect(defaultFileSignals[0].metadata.primary_author).toBe('Alice');

    // Strict: Alice at 40% < 50% → no signal
    expect(strictFileSignals).toHaveLength(0);
  });

  it('temporal_scope uses correct date range', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'd1', sha: 'sha1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-05T10:00:00Z' }),
      makeChunk({ id: 'd2', sha: 'sha2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'd3', sha: 'sha3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Alice', date: '2025-01-15T10:00:00Z' }),
      makeChunk({ id: 'd4', sha: 'sha4', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', author: 'Bob', date: '2025-01-20T10:00:00Z' }),
    ];

    const signals = detector.detect(chunks);
    const fileSignals = signals.filter(s => s.metadata.file !== undefined);
    expect(fileSignals).toHaveLength(1);
    // temporal_scope start and end should span the date range of the ownership entries
    expect(fileSignals[0].temporal_scope.start).toBeDefined();
    expect(fileSignals[0].temporal_scope.end).toBeDefined();
    // The end should be the top author's last change
    expect(fileSignals[0].temporal_scope.end).toBe('2025-01-15T10:00:00Z');
  });
});
