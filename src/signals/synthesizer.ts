import type { FileProfile, SignalRecord, Warning } from './types.js';

/**
 * Temporal decay: returns 0-1 weight based on age.
 * halfLifeDays=90 for general signals, 180 for reverts/breaking changes.
 */
export function temporalDecay(date: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(date).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function decayForSignal(signal: SignalRecord): number {
  const halfLife = signal.type === 'revert_pair' || signal.type === 'breaking_change' ? 180 : 90;
  return temporalDecay(signal.temporal_scope.end, halfLife);
}

function decisionWeight(metadata: Record<string, unknown>): number {
  const cls = metadata.dominant_decision_class;
  if (cls === 'decision') return 1.5;
  if (cls === 'routine') return 0.5;
  return 1.0;
}

/**
 * Synthesize warnings from file profiles and signals.
 * Returns sorted warnings (warning > caution > info).
 */
export function synthesizeWarnings(
  fileProfiles: FileProfile[],
  signals: SignalRecord[],
  changeType?: string,
): Warning[] {
  const warnings: Warning[] = [];

  // --- Stability warnings ---
  for (const profile of fileProfiles) {
    if (profile.stability_score < 30) {
      warnings.push({
        severity: 'warning',
        category: 'stability',
        message: `${profile.path} has a stability score of ${profile.stability_score}/100. Changed ${profile.total_changes} times with ${profile.revert_count} revert${profile.revert_count !== 1 ? 's' : ''}.`,
        evidence: [],
      });
    } else if (profile.stability_score < 50 && changeType === 'refactor') {
      warnings.push({
        severity: 'caution',
        category: 'stability',
        message: `Refactoring a volatile area: ${profile.path} (stability ${profile.stability_score}/100). Consider smaller incremental changes.`,
        evidence: [],
      });
    }
  }

  // --- Ownership warnings ---
  for (const profile of fileProfiles) {
    if (profile.primary_owner && profile.primary_owner.percentage >= 30) {
      warnings.push({
        severity: 'info',
        category: 'ownership',
        message: `${profile.primary_owner.author} owns ${profile.path} (${profile.primary_owner.percentage}% of changes, ${profile.primary_owner.commits} commits). Last active: ${profile.primary_owner.last_change.slice(0, 10)}.`,
        evidence: [],
      });
    } else if (profile.contributor_count > 0 && (!profile.primary_owner || profile.primary_owner.percentage < 30)) {
      warnings.push({
        severity: 'info',
        category: 'ownership',
        message: `No clear owner for ${profile.path}. ${profile.contributor_count} contributors${profile.primary_owner ? `, highest is ${profile.primary_owner.percentage}%` : ''}.`,
        evidence: [],
      });
    }
  }

  // --- Pattern warnings from signals ---
  for (const signal of signals) {
    const decay = decayForSignal(signal);
    const weight = decisionWeight(signal.metadata);
    if (decay * weight < 0.1) continue; // too old or too routine to matter

    switch (signal.type) {
      case 'revert_pair': {
        const meta = signal.metadata;
        const timeStr = meta.time_to_revert_days != null
          ? `${meta.time_to_revert_days} days after landing`
          : 'timing unknown';
        warnings.push({
          severity: 'caution',
          category: 'pattern',
          message: `A previous change to this area was reverted (${(meta.original_sha as string)?.slice(0, 7) || 'unknown'}, ${timeStr}). ${meta.original_subject || ''}`,
          evidence: signal.contributing_shas,
        });
        break;
      }

      case 'fix_chain': {
        const meta = signal.metadata;
        warnings.push({
          severity: signal.severity,
          category: 'pattern',
          message: `Feature "${meta.feature_subject}" (${(meta.feature_sha as string)?.slice(0, 7)}) required ${meta.fix_count} follow-up fix${(meta.fix_count as number) > 1 ? 'es' : ''} over ${meta.day_span} day${(meta.day_span as number) !== 1 ? 's' : ''}.`,
          evidence: signal.contributing_shas,
        });
        break;
      }

      case 'churn_hotspot': {
        const meta = signal.metadata;
        warnings.push({
          severity: 'info',
          category: 'churn',
          message: `${meta.file} is a churn hotspot (${meta.count} changes, ${meta.sigma}σ above repo mean). Trend: ${meta.trend}.`,
          evidence: signal.contributing_shas.slice(0, 5),
        });
        break;
      }

      case 'breaking_change': {
        const meta = signal.metadata;
        warnings.push({
          severity: 'warning',
          category: 'breaking',
          message: `A previous change here (${(meta.trigger_sha as string)?.slice(0, 7)}) caused fixes from ${meta.author_count} different authors within 48 hours. Blast radius: ${meta.affected_files} files.`,
          evidence: signal.contributing_shas,
        });
        break;
      }

      case 'adoption_cycle': {
        const meta = signal.metadata;
        warnings.push({
          severity: 'warning',
          category: 'pattern',
          message: `${meta.subject || 'This dependency'} has gone through ${meta.cycle_count} adoption cycles. Current status: ${meta.current_status}.`,
          evidence: signal.contributing_shas,
        });
        break;
      }

      // ownership and stability_shift are handled via file profiles above
      default:
        break;
    }
  }

  // Sort: warning > caution > info, then by confidence/decay
  const severityOrder: Record<string, number> = { warning: 0, caution: 1, info: 2 };
  warnings.sort((a, b) => {
    const sa = severityOrder[a.severity] ?? 3;
    const sb = severityOrder[b.severity] ?? 3;
    return sa - sb;
  });

  return warnings;
}
