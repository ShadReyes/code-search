import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class StabilityShiftDetector implements SignalDetector {
  readonly name = 'stability_shift';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];

    // Build SHA → decision_class map for dominant class computation
    const shaClass = new Map<string, GitHistoryChunk['decision_class']>();
    for (const c of commits) {
      if (c.chunk_type === 'commit_summary') shaClass.set(c.sha, c.decision_class);
    }

    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    if (fileDiffs.length === 0) return signals;

    // Group by directory
    const dirChanges = new Map<string, { date: string; sha: string }[]>();

    for (const chunk of fileDiffs) {
      const dir = dirname(chunk.file_path);
      if (dir === '.') continue;
      // Use top-level directory for aggregation
      const topDir = dir.split('/').slice(0, 2).join('/');
      if (!dirChanges.has(topDir)) dirChanges.set(topDir, []);
      dirChanges.get(topDir)!.push({ date: chunk.date, sha: chunk.sha });
    }

    const now = Date.now();
    const thirtyDaysAgo = now - THIRTY_DAYS_MS;
    const sixtyDaysAgo = now - 2 * THIRTY_DAYS_MS;
    const ninetyDaysAgo = now - 3 * THIRTY_DAYS_MS;

    for (const [dir, changes] of dirChanges) {
      if (changes.length < 10) continue; // need enough data

      // Single-pass date filtering
      let recent = 0, previous = 0, older = 0;
      const recentShas: string[] = [];
      for (const c of changes) {
        const t = new Date(c.date).getTime();
        if (t >= thirtyDaysAgo) {
          recent++;
          recentShas.push(c.sha);
        } else if (t >= sixtyDaysAgo) {
          previous++;
        } else if (t >= ninetyDaysAgo) {
          older++;
        }
      }

      // Detect significant shift (>50% change in frequency)
      if (previous === 0) continue;

      const recentRatio = recent / previous;
      const olderRatio = older > 0 ? previous / older : 1;

      let shift: 'stabilized' | 'destabilized' | null = null;
      if (recentRatio < 0.5 && previous >= 3) {
        shift = 'stabilized';
      } else if (recentRatio > 2.0 && recent >= 3) {
        shift = 'destabilized';
      }

      if (!shift) continue;

      // Compute dominant decision_class from recent SHAs
      const classCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of recentShas) {
        const cls = shaClass.get(sha) || 'unknown';
        classCounts[cls]++;
      }
      const dominantDecisionClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];

      signals.push({
        id: signalId('stability_shift', dir),
        type: 'stability_shift',
        summary: `${dir} has ${shift}: went from ${previous} changes/month to ${recent} changes/month (${shift === 'stabilized' ? 'decreasing' : 'increasing'} activity).`,
        severity: shift === 'destabilized' ? 'caution' : 'info',
        confidence: Math.min(0.85, 0.5 + Math.abs(recentRatio - 1) * 0.2),
        directory_scope: dir,
        contributing_shas: recentShas.slice(0, 10),
        temporal_scope: {
          start: new Date(sixtyDaysAgo).toISOString(),
          end: new Date().toISOString(),
        },
        metadata: {
          directory: dir,
          shift,
          recent_30d: recent,
          previous_30d: previous,
          older_30d: older,
          ratio: parseFloat(recentRatio.toFixed(2)),
          dominant_decision_class: dominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
