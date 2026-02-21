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

      const recent = changes.filter(c => new Date(c.date).getTime() >= thirtyDaysAgo).length;
      const previous = changes.filter(c => {
        const t = new Date(c.date).getTime();
        return t >= sixtyDaysAgo && t < thirtyDaysAgo;
      }).length;
      const older = changes.filter(c => {
        const t = new Date(c.date).getTime();
        return t >= ninetyDaysAgo && t < sixtyDaysAgo;
      }).length;

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

      const recentShas = changes
        .filter(c => new Date(c.date).getTime() >= thirtyDaysAgo)
        .map(c => c.sha);

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
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
