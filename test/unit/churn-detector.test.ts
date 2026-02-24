import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { ChurnDetector } from '../../src/signals/detectors/churn.js';

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

// Helper: create N file_diff chunks for a given file path
function fileDiffs(filePath: string, count: number, prefix: string): GitHistoryChunk[] {
  return Array.from({ length: count }, (_, i) =>
    makeChunk({
      id: `${prefix}-${i}`,
      sha: `sha-${prefix}${i}`,
      chunk_type: 'file_diff',
      file_path: filePath,
    }),
  );
}

describe('ChurnDetector', () => {
  const detector = new ChurnDetector();

  it('returns empty for no file_diff chunks', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1', sha: 'aaa1' }),
      makeChunk({ id: 'c2', sha: 'aaa2', subject: 'fix(auth): patch' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty when all files have equal changes (stddev=0)', () => {
    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 2, 'a'),
      ...fileDiffs('src/b.ts', 2, 'b'),
      ...fileDiffs('src/c.ts', 2, 'c'),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  // With fileA=20 and 8 filler files at 1 each:
  // mean=(20+8)/9≈3.11, stddev≈5.97, threshold≈15.05 → 20>15 ✓
  it('flags files >2σ above mean', () => {
    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 20, 'a'),
      ...fileDiffs('src/b.ts', 1, 'b'),
      ...fileDiffs('src/c.ts', 1, 'c'),
      ...fileDiffs('src/d.ts', 1, 'd'),
      ...fileDiffs('src/e.ts', 1, 'e'),
      ...fileDiffs('src/f.ts', 1, 'f'),
      ...fileDiffs('src/g.ts', 1, 'g'),
      ...fileDiffs('src/h.ts', 1, 'h'),
      ...fileDiffs('src/i.ts', 1, 'i'),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.file).toBe('src/a.ts');
  });

  // With fileA=50 and 10 fillers at 1:
  // mean≈5.45, stddev≈14.09, sigma≈3.16, threshold≈33.6 → 50>33.6 ✓, sigma>3 ✓
  it('severity is warning when sigma > 3', () => {
    const fillers = Array.from({ length: 10 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 50, 'a'),
      ...fillers,
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('warning');
    expect((signals[0].metadata.sigma as number)).toBeGreaterThan(3);
  });

  // With fileA=10 and 8 fillers at 1:
  // mean=2, stddev≈2.83, sigma≈2.83, threshold≈7.66 → 10>7.66 ✓, sigma≤3 ✓
  it('severity is caution when sigma <= 3', () => {
    const fillers = Array.from({ length: 8 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 10, 'a'),
      ...fillers,
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('caution');
    expect((signals[0].metadata.sigma as number)).toBeLessThanOrEqual(3);
  });

  it('computes trend as increasing when recent changes dominate', () => {
    const now = Date.now();
    // fileA: 20 changes in last 30 days
    const recentChunks = Array.from({ length: 20 }, (_, i) =>
      makeChunk({
        id: `a-${i}`,
        sha: `sha-a${i}`,
        chunk_type: 'file_diff',
        file_path: 'src/a.ts',
        date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const fillers = Array.from({ length: 8 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [...recentChunks, ...fillers];
    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.trend).toBe('increasing');
  });

  it('computes trend as decreasing when older changes dominate', () => {
    const now = Date.now();
    // fileA: 20 changes all 31-50 days ago (previous window), 0 recent
    const oldChunks = Array.from({ length: 20 }, (_, i) =>
      makeChunk({
        id: `a-${i}`,
        sha: `sha-a${i}`,
        chunk_type: 'file_diff',
        file_path: 'src/a.ts',
        date: new Date(now - (31 + i) * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const fillers = Array.from({ length: 8 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [...oldChunks, ...fillers];
    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.trend).toBe('decreasing');
  });

  it('metadata fields are correct', () => {
    const fillers = Array.from({ length: 8 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 20, 'a'),
      ...fillers,
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    const meta = signals[0].metadata;
    expect(meta.file).toBe('src/a.ts');
    expect(meta.count).toBe(20);
    expect(typeof meta.sigma).toBe('number');
    expect((meta.sigma as number)).toBeGreaterThan(2);
    expect(typeof meta.mean).toBe('number');
    expect(['increasing', 'decreasing', 'stable']).toContain(meta.trend);
  });

  it('custom sigmaThreshold=1 flags more files than default', () => {
    // With fileA=10 and 8 fillers at 1:
    // mean=2, stddev~2.83
    // Default threshold (2σ): mean + 2*2.83 = 7.66 → only fileA (10) is flagged
    // Custom threshold (1σ): mean + 1*2.83 = 4.83 → only fileA (10) is flagged (fillers still below)
    // Need a scenario where lowering sigma catches more:
    // fileA=10, fileB=6, 6 fillers at 1 each → mean=3, stddev~3.0
    // Default (2σ): threshold=9 → only fileA(10) flagged
    // Custom (1σ): threshold=6 → fileA(10) and fileB(6) flagged (6 <= 6, not >, so we need 7)
    // Actually: 6 > 6 is false. Let's use fileB=7.
    // mean=(10+7+6)/8=3.625, stddev~2.82, threshold@1σ=6.45 → fileA(10) and fileB(7) flagged
    // threshold@2σ=9.27 → only fileA(10) flagged
    const fillers = Array.from({ length: 6 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 10, 'a'),
      ...fileDiffs('src/b.ts', 7, 'b'),
      ...fillers,
    ];

    const defaultDetector = new ChurnDetector();
    const looseDetector = new ChurnDetector({ sigmaThreshold: 1 });

    const defaultSignals = defaultDetector.detect(chunks);
    const looseSignals = looseDetector.detect(chunks);

    expect(looseSignals.length).toBeGreaterThan(defaultSignals.length);
  });

  it('results sorted by sigma descending', () => {
    // fileA: 50, fileB: 30, 30 fillers at 1
    // mean≈3.44, stddev≈9.76, threshold≈22.96 → both A(50) and B(30) exceed
    const fillers = Array.from({ length: 30 }, (_, i) =>
      fileDiffs(`src/filler${i}.ts`, 1, `f${i}`),
    ).flat();

    const chunks: GitHistoryChunk[] = [
      ...fileDiffs('src/a.ts', 50, 'a'),
      ...fileDiffs('src/b.ts', 30, 'b'),
      ...fillers,
    ];

    const signals = detector.detect(chunks);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < signals.length; i++) {
      expect((signals[i - 1].metadata.sigma as number)).toBeGreaterThanOrEqual(
        (signals[i].metadata.sigma as number),
      );
    }
  });
});
