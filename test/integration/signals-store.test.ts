import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSignalsStore,
  initSignalsTable,
  insertSignals,
  getSignalsByDirectory,
  replaceSignalsByType,
  resetSignalsStore,
} from '../../src/signals/store.js';
import type { SignalRecord } from '../../src/signals/types.js';

function makeSignal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig-1',
    type: 'revert_pair',
    summary: 'test signal',
    severity: 'caution',
    confidence: 0.9,
    directory_scope: '.',
    contributing_shas: ['aaa'],
    temporal_scope: { start: '2025-01-01T00:00:00Z', end: '2025-01-02T00:00:00Z' },
    metadata: {},
    created_at: '2025-01-02T00:00:00Z',
    ...overrides,
  };
}

function zeroVector(dims: number = 8): number[] {
  return new Array(dims).fill(0);
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'signals-store-test-'));
  await initSignalsStore(tmpDir);
});

afterAll(() => {
  resetSignalsStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getSignalsByDirectory — root-scoped visibility (Bug 3)', () => {
  beforeAll(async () => {
    const signals: SignalRecord[] = [
      makeSignal({ id: 'root-1', type: 'revert_pair', directory_scope: '.' }),
      makeSignal({ id: 'dir-1', type: 'churn_hotspot', directory_scope: 'src/auth' }),
      makeSignal({ id: 'dir-2', type: 'ownership', directory_scope: 'src/api' }),
    ];
    const vectors = signals.map(() => zeroVector());
    await insertSignals(signals, vectors, true);
    await initSignalsTable();
  });

  it('returns both dir-scoped AND root-scoped signals for a subdirectory', async () => {
    const results = await getSignalsByDirectory('src/auth');
    const ids = results.map(s => s.id);
    expect(ids).toContain('root-1');
    expect(ids).toContain('dir-1');
    expect(ids).not.toContain('dir-2');
  });

  it('returns all signals for root directory', async () => {
    const results = await getSignalsByDirectory('.');
    expect(results.length).toBe(3);
  });
});

describe('replaceSignalsByType — incremental analyze safety (Bug 4)', () => {
  beforeAll(async () => {
    // Seed with mixed signal types
    const signals: SignalRecord[] = [
      makeSignal({ id: 'revert-1', type: 'revert_pair', directory_scope: '.' }),
      makeSignal({ id: 'churn-old-1', type: 'churn_hotspot', directory_scope: 'src/auth' }),
      makeSignal({ id: 'churn-old-2', type: 'churn_hotspot', directory_scope: 'src/api' }),
      makeSignal({ id: 'own-old', type: 'ownership', directory_scope: 'src' }),
    ];
    const vectors = signals.map(() => zeroVector());
    await insertSignals(signals, vectors, true);
    await initSignalsTable();
  });

  it('preserves existing revert_pair signals when replacing churn_hotspot', async () => {
    const newChurn: SignalRecord[] = [
      makeSignal({ id: 'churn-new-1', type: 'churn_hotspot', directory_scope: 'src/core' }),
    ];
    const newVectors = newChurn.map(() => zeroVector());

    await replaceSignalsByType(['churn_hotspot'], newChurn, newVectors);

    const all = await getSignalsByDirectory('.');
    const ids = all.map(s => s.id);
    expect(ids).toContain('revert-1');
    expect(ids).toContain('own-old');
  });

  it('replaces churn signals without duplication', async () => {
    const all = await getSignalsByDirectory('.');
    const churnIds = all.filter(s => s.type === 'churn_hotspot').map(s => s.id);
    expect(churnIds).toEqual(['churn-new-1']);
    expect(churnIds).not.toContain('churn-old-1');
    expect(churnIds).not.toContain('churn-old-2');
  });
});
