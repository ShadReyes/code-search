import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { StabilityShiftDetector } from '../../src/signals/detectors/stability.js';

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

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

describe('StabilityShiftDetector', () => {
  const detector = new StabilityShiftDetector();

  it('returns empty for no file_diff chunks', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1', chunk_type: 'commit_summary' }),
      makeChunk({ id: 'c2', chunk_type: 'commit_summary' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty with fewer than 10 changes', () => {
    const chunks: GitHistoryChunk[] = [];
    for (let i = 0; i < 9; i++) {
      chunks.push(makeChunk({
        id: `c${i}`,
        sha: `sha${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(5 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('detects destabilized (ratio > 2.0)', () => {
    const chunks: GitHistoryChunk[] = [];
    // 8 recent changes (within last 30 days)
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk({
        id: `recent-${i}`,
        sha: `recent${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(2 + i),
      }));
    }
    // 3 previous changes (30-60 days ago)
    for (let i = 0; i < 3; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('stability_shift');
    expect(signals[0].metadata.shift).toBe('destabilized');
    expect(signals[0].metadata.recent_30d).toBe(8);
    expect(signals[0].metadata.previous_30d).toBe(3);
  });

  it('detects stabilized (ratio < 0.5)', () => {
    const chunks: GitHistoryChunk[] = [];
    // 1 recent change (within last 30 days)
    chunks.push(makeChunk({
      id: 'recent-0',
      sha: 'recent0',
      chunk_type: 'file_diff',
      file_path: 'src/auth/file0.ts',
      date: daysAgo(5),
    }));
    // 8 previous changes (30-60 days ago) — need previous >= 3
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }
    // 2 older changes (60-90 days ago) to hit >= 10 total (1 + 8 + 2 = 11)
    for (let i = 0; i < 2; i++) {
      chunks.push(makeChunk({
        id: `older-${i}`,
        sha: `older${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(65 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.shift).toBe('stabilized');
    expect(signals[0].metadata.recent_30d).toBe(1);
    expect(signals[0].metadata.previous_30d).toBe(8);
  });

  it('no signal for ratio between 0.5 and 2.0', () => {
    const chunks: GitHistoryChunk[] = [];
    // 4 recent changes
    for (let i = 0; i < 4; i++) {
      chunks.push(makeChunk({
        id: `recent-${i}`,
        sha: `recent${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(2 + i),
      }));
    }
    // 4 previous changes
    for (let i = 0; i < 4; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }
    // 3 older changes to reach >= 10 total (4 + 4 + 3 = 11)
    for (let i = 0; i < 3; i++) {
      chunks.push(makeChunk({
        id: `older-${i}`,
        sha: `older${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(65 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('severity is caution for destabilized', () => {
    const chunks: GitHistoryChunk[] = [];
    // 8 recent, 3 previous = 11 total, ratio 2.67
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk({
        id: `recent-${i}`,
        sha: `recent${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(2 + i),
      }));
    }
    for (let i = 0; i < 3; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('caution');
  });

  it('severity is info for stabilized', () => {
    const chunks: GitHistoryChunk[] = [];
    // 1 recent, 8 previous, 2 older = 11 total
    chunks.push(makeChunk({
      id: 'recent-0',
      sha: 'recent0',
      chunk_type: 'file_diff',
      file_path: 'src/auth/file0.ts',
      date: daysAgo(5),
    }));
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }
    for (let i = 0; i < 2; i++) {
      chunks.push(makeChunk({
        id: `older-${i}`,
        sha: `older${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/file${i}.ts`,
        date: daysAgo(65 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('info');
  });

  it('uses top-level directory (first 2 segments)', () => {
    const chunks: GitHistoryChunk[] = [];
    // All files under src/auth/ but with deeper paths
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk({
        id: `recent-${i}`,
        sha: `recent${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/nested/deep/file${i}.ts`,
        date: daysAgo(2 + i),
      }));
    }
    for (let i = 0; i < 3; i++) {
      chunks.push(makeChunk({
        id: `prev-${i}`,
        sha: `prev${i}`,
        chunk_type: 'file_diff',
        file_path: `src/auth/other/file${i}.ts`,
        date: daysAgo(35 + i),
      }));
    }

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    // All aggregate under src/auth regardless of deeper nesting
    expect(signals[0].directory_scope).toBe('src/auth');
    expect(signals[0].metadata.directory).toBe('src/auth');
  });
});
