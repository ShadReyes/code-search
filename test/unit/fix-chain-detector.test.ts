import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { FixAfterFeatureDetector } from '../../src/signals/detectors/fix-chain.js';

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

describe('FixAfterFeatureDetector', () => {
  const detector = new FixAfterFeatureDetector();

  it('returns empty when no feat commits', () => {
    const chunks: GitHistoryChunk[] = [
      // Only fix commits
      makeChunk({ id: 'c1-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): patch login', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'c1-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when no file overlap between feat and fix', () => {
    const chunks: GitHistoryChunk[] = [
      // feat touches fileA
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix touches fileB (no overlap)
      makeChunk({ id: 'fix-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(db): patch query', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'fix-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/db/query.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when fix is outside 7-day window', () => {
    const chunks: GitHistoryChunk[] = [
      // feat on day 1
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix 8 days later (outside window)
      makeChunk({ id: 'fix-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): patch login', date: '2025-01-18T11:00:00Z' }),
      makeChunk({ id: 'fix-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('detects single fix after feature', () => {
    const chunks: GitHistoryChunk[] = [
      // feat on day 1
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix on day 3
      makeChunk({ id: 'fix-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): patch login', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'fix-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('fix_chain');
    expect(signals[0].metadata.feature_sha).toBe('feat1');
    expect(signals[0].metadata.fix_count).toBe(1);
  });

  it('detects multiple fixes in chain', () => {
    const chunks: GitHistoryChunk[] = [
      // feat on day 1
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix on day 2
      makeChunk({ id: 'fix1-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): null check', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'fix1-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix on day 5
      makeChunk({ id: 'fix2-summary', sha: 'fix2', commit_type: 'fix', subject: 'fix(auth): edge case', date: '2025-01-14T10:00:00Z' }),
      makeChunk({ id: 'fix2-diff', sha: 'fix2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.fix_count).toBe(2);
  });

  it('severity is caution with fewer than 3 fixes', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // 2 fixes
      makeChunk({ id: 'fix1-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): null check', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'fix1-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'fix2-summary', sha: 'fix2', commit_type: 'fix', subject: 'fix(auth): edge case', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'fix2-diff', sha: 'fix2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('caution');
  });

  it('severity is warning with 3 or more fixes', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // 3 fixes within 7 days
      makeChunk({ id: 'fix1-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): null check', date: '2025-01-11T10:00:00Z' }),
      makeChunk({ id: 'fix1-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'fix2-summary', sha: 'fix2', commit_type: 'fix', subject: 'fix(auth): edge case', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'fix2-diff', sha: 'fix2', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'fix3-summary', sha: 'fix3', commit_type: 'fix', subject: 'fix(auth): validation', date: '2025-01-13T10:00:00Z' }),
      makeChunk({ id: 'fix3-diff', sha: 'fix3', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('warning');
  });

  it('day_span is correct', () => {
    const chunks: GitHistoryChunk[] = [
      // feat on Jan 10
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix on Jan 15 (5 days later)
      makeChunk({ id: 'fix-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): patch', date: '2025-01-15T10:00:00Z' }),
      makeChunk({ id: 'fix-diff', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.day_span).toBe(5);
  });

  it('affected_files is union of all files', () => {
    const chunks: GitHistoryChunk[] = [
      // feat touches fileA
      makeChunk({ id: 'feat-summary', sha: 'feat1', commit_type: 'feat', subject: 'feat(auth): add login', date: '2025-01-10T10:00:00Z' }),
      makeChunk({ id: 'feat-diff', sha: 'feat1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      // fix touches fileA + fileB
      makeChunk({ id: 'fix-summary', sha: 'fix1', commit_type: 'fix', subject: 'fix(auth): patch', date: '2025-01-12T10:00:00Z' }),
      makeChunk({ id: 'fix-diff1', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts' }),
      makeChunk({ id: 'fix-diff2', sha: 'fix1', chunk_type: 'file_diff', file_path: 'src/auth/types.ts' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    const affected = signals[0].metadata.affected_files as string[];
    expect(affected).toContain('src/auth/login.ts');
    expect(affected).toContain('src/auth/types.ts');
    expect(affected).toHaveLength(2);
  });
});
