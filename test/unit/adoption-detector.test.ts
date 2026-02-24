import { describe, it, expect } from 'vitest';
import type { GitHistoryChunk } from '../../src/types.js';
import { AdoptionCycleDetector } from '../../src/signals/detectors/adoption.js';

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

describe('AdoptionCycleDetector', () => {
  const detector = new AdoptionCycleDetector();

  it('returns empty for no package.json diffs', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({ id: 'c1', chunk_type: 'file_diff', file_path: 'src/auth/login.ts', text: '+  "lodash": "^4.17.21"' }),
      makeChunk({ id: 'c2', chunk_type: 'file_diff', file_path: 'tsconfig.json', text: '-  "lodash": "^4.17.21"' }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('returns empty with fewer than 2 transitions', () => {
    // Only 1 add event - no transitions at all
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
    ];
    expect(detector.detect(chunks)).toHaveLength(0);

    // Two adds for same dep - 0 transitions (same event type)
    const chunks2: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'aaa2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-11T10:00:00Z',
        text: '+  "lodash": "^4.18.0"',
      }),
    ];
    expect(detector.detect(chunks2)).toHaveLength(0);
  });

  it('detects add-remove-add cycle', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('adoption_cycle');
    expect(signals[0].metadata.subject).toBe('lodash');
    expect(signals[0].metadata.cycle_count).toBe(1);
    expect(signals[0].metadata.transitions).toBe(2);
  });

  it('ignores @types/ dependencies', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "@types/node": "^20.0.0"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "@types/node": "^20.0.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "@types/node": "^20.0.0"',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('ignores version and name fields', () => {
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "version": "1.0.0"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "version": "1.0.0"\n+  "version": "2.0.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "name": "my-app"',
      }),
      makeChunk({
        id: 'c4',
        sha: 'ddd4',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-04-10T10:00:00Z',
        text: '-  "name": "my-app"\n+  "name": "new-app"',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('current_status tracks last event', () => {
    // Last event is 'add' -> current_status should be 'active'
    const chunksAddLast: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "axios": "^1.0.0"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "axios": "^1.0.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "axios": "^1.1.0"',
      }),
    ];

    const signalsAdd = detector.detect(chunksAddLast);
    expect(signalsAdd).toHaveLength(1);
    expect(signalsAdd[0].metadata.current_status).toBe('active');

    // Last event is 'remove' -> current_status should be 'removed'
    const chunksRemoveLast: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "axios": "^1.0.0"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "axios": "^1.0.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "axios": "^1.1.0"',
      }),
      makeChunk({
        id: 'c4',
        sha: 'ddd4',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-04-10T10:00:00Z',
        text: '-  "axios": "^1.1.0"',
      }),
    ];

    const signalsRemove = detector.detect(chunksRemoveLast);
    expect(signalsRemove).toHaveLength(1);
    expect(signalsRemove[0].metadata.current_status).toBe('removed');
  });

  it('severity is warning when cycleCount >= 3', () => {
    // 6 events alternating: add, remove, add, remove, add, remove = 5 transitions, ceil(5/2) = 3 cycles
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-01T10:00:00Z',
        text: '+  "moment": "^2.29.0"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-01T10:00:00Z',
        text: '-  "moment": "^2.29.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-01T10:00:00Z',
        text: '+  "moment": "^2.29.1"',
      }),
      makeChunk({
        id: 'c4',
        sha: 'ddd4',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-04-01T10:00:00Z',
        text: '-  "moment": "^2.29.1"',
      }),
      makeChunk({
        id: 'c5',
        sha: 'eee5',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-05-01T10:00:00Z',
        text: '+  "moment": "^2.30.0"',
      }),
      makeChunk({
        id: 'c6',
        sha: 'fff6',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-06-01T10:00:00Z',
        text: '-  "moment": "^2.30.0"',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.cycle_count).toBe(3);
    expect(signals[0].severity).toBe('warning');
  });

  it('ignores version bumps (same dep with + and - in same chunk)', () => {
    // A version bump has both a removed and added line for the same dep in one chunk.
    // This should NOT count as an add or remove event.
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "lodash": "^4.17.21"\n+  "lodash": "^4.18.0"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '-  "lodash": "^4.18.0"\n+  "lodash": "^4.19.0"',
      }),
    ];

    // Only 1 real event (the initial add). Version bumps are ignored.
    // Fewer than 2 transitions → no signal.
    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(0);
  });

  it('severity is caution when cycleCount < 3', () => {
    // 3 events: add, remove, add = 2 transitions, ceil(2/2) = 1 cycle
    const chunks: GitHistoryChunk[] = [
      makeChunk({
        id: 'c1',
        sha: 'aaa1',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-01-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c2',
        sha: 'bbb2',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-02-10T10:00:00Z',
        text: '-  "lodash": "^4.17.21"',
      }),
      makeChunk({
        id: 'c3',
        sha: 'ccc3',
        chunk_type: 'file_diff',
        file_path: 'package.json',
        date: '2025-03-10T10:00:00Z',
        text: '+  "lodash": "^4.17.21"',
      }),
    ];

    const signals = detector.detect(chunks);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata.cycle_count).toBe(1);
    expect(signals[0].severity).toBe('caution');
  });
});
