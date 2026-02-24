import { describe, it, expect } from 'vitest';
import type { FileProfile, SignalRecord } from '../../src/signals/types.js';
import { synthesizeWarnings } from '../../src/signals/synthesizer.js';

function makeProfile(overrides: Partial<FileProfile> = {}): FileProfile {
  return {
    path: 'src/foo.ts',
    primary_owner: null,
    contributor_count: 0,
    stability_score: 80,
    total_changes: 10,
    revert_count: 0,
    fix_after_feature_count: 0,
    change_frequency: 'weekly',
    risk_score: 20,
    last_modified: '2025-06-01T00:00:00Z',
    active_signal_ids: [],
    ...overrides,
  };
}

function makeSignal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig-default',
    type: 'revert_pair',
    summary: 'test signal',
    severity: 'caution',
    confidence: 0.8,
    directory_scope: 'src',
    contributing_shas: ['aaaa1111', 'bbbb2222'],
    temporal_scope: {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString(),
    },
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('synthesizeWarnings signal_ids', () => {
  it('profile-based stability warning includes active_signal_ids', () => {
    const profile = makeProfile({
      stability_score: 20,
      total_changes: 50,
      revert_count: 3,
      active_signal_ids: ['sig1', 'sig2'],
    });

    const warnings = synthesizeWarnings([profile], []);
    const stabilityWarnings = warnings.filter(w => w.category === 'stability');
    expect(stabilityWarnings.length).toBeGreaterThanOrEqual(1);
    expect(stabilityWarnings[0].signal_ids).toEqual(['sig1', 'sig2']);
  });

  it('profile-based ownership warning includes active_signal_ids', () => {
    const profile = makeProfile({
      primary_owner: {
        author: 'Alice',
        percentage: 80,
        commits: 20,
        last_change: '2025-06-01T00:00:00Z',
      },
      active_signal_ids: ['sig3'],
    });

    const warnings = synthesizeWarnings([profile], []);
    const ownershipWarnings = warnings.filter(w => w.category === 'ownership');
    expect(ownershipWarnings.length).toBeGreaterThanOrEqual(1);
    expect(ownershipWarnings[0].signal_ids).toEqual(['sig3']);
  });

  it('signal-based revert_pair warning includes signal.id', () => {
    const signal = makeSignal({
      id: 'revert-123',
      type: 'revert_pair',
      metadata: {
        original_sha: 'aaaa1111',
        time_to_revert_days: 2,
        original_subject: 'feat: something',
        dominant_decision_class: 'decision',
      },
    });

    const warnings = synthesizeWarnings([], [signal]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].signal_ids).toEqual(['revert-123']);
  });

  it('signal-based fix_chain warning includes signal.id', () => {
    const signal = makeSignal({
      id: 'fix-456',
      type: 'fix_chain',
      severity: 'caution',
      metadata: {
        feature_subject: 'add auth',
        feature_sha: 'cccc3333',
        fix_count: 3,
        day_span: 5,
        dominant_decision_class: 'decision',
      },
    });

    const warnings = synthesizeWarnings([], [signal]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].signal_ids).toEqual(['fix-456']);
  });

  it('signal-based churn_hotspot warning includes signal.id', () => {
    const signal = makeSignal({
      id: 'churn-789',
      type: 'churn_hotspot',
      severity: 'info',
      metadata: {
        file: 'src/hot.ts',
        count: 50,
        sigma: 3.5,
        trend: 'increasing',
        dominant_decision_class: 'decision',
      },
    });

    const warnings = synthesizeWarnings([], [signal]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].signal_ids).toEqual(['churn-789']);
  });

  it('signal-based breaking_change warning includes signal.id', () => {
    const signal = makeSignal({
      id: 'break-001',
      type: 'breaking_change',
      severity: 'warning',
      metadata: {
        trigger_sha: 'dddd4444',
        author_count: 3,
        affected_files: 12,
        dominant_decision_class: 'decision',
      },
    });

    const warnings = synthesizeWarnings([], [signal]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].signal_ids).toEqual(['break-001']);
  });

  it('signal-based adoption_cycle warning includes signal.id', () => {
    const signal = makeSignal({
      id: 'adopt-002',
      type: 'adoption_cycle',
      severity: 'warning',
      metadata: {
        subject: 'lodash',
        cycle_count: 3,
        current_status: 'removed',
        dominant_decision_class: 'decision',
      },
    });

    const warnings = synthesizeWarnings([], [signal]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].signal_ids).toEqual(['adopt-002']);
  });

  it('empty signal_ids when profile has no active_signal_ids', () => {
    const profile = makeProfile({
      stability_score: 20,
      total_changes: 50,
      revert_count: 3,
      active_signal_ids: [],
    });

    const warnings = synthesizeWarnings([profile], []);
    const stabilityWarnings = warnings.filter(w => w.category === 'stability');
    expect(stabilityWarnings.length).toBeGreaterThanOrEqual(1);
    expect(stabilityWarnings[0].signal_ids).toEqual([]);
  });

  it('refactor changeType with volatile profile includes signal_ids', () => {
    const profile = makeProfile({
      stability_score: 40,
      active_signal_ids: ['sig-refactor'],
    });

    const warnings = synthesizeWarnings([profile], [], 'refactor');
    const stabilityWarnings = warnings.filter(w => w.category === 'stability');
    expect(stabilityWarnings.length).toBeGreaterThanOrEqual(1);
    expect(stabilityWarnings[0].signal_ids).toEqual(['sig-refactor']);
  });
});
