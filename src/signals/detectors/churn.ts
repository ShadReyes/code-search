import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

export class ChurnDetector implements SignalDetector {
  readonly name = 'churn';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];

    // Count changes per file from file_diff chunks
    const fileCounts = new Map<string, { count: number; dates: string[]; shas: string[] }>();
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    for (const chunk of fileDiffs) {
      const entry = fileCounts.get(chunk.file_path) || { count: 0, dates: [], shas: [] };
      entry.count++;
      entry.dates.push(chunk.date);
      if (!entry.shas.includes(chunk.sha)) entry.shas.push(chunk.sha);
      fileCounts.set(chunk.file_path, entry);
    }

    if (fileCounts.size === 0) return signals;

    // Compute mean and standard deviation
    const counts = [...fileCounts.values()].map(e => e.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) return signals;

    // Flag files >2σ above mean
    const threshold = mean + 2 * stddev;

    for (const [filePath, entry] of fileCounts) {
      if (entry.count <= threshold) continue;

      const sigma = (entry.count - mean) / stddev;
      const sortedDates = entry.dates.sort();

      // Compute trend: compare last 30 days vs previous 30 days
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      const recent = entry.dates.filter(d => new Date(d) >= thirtyDaysAgo).length;
      const previous = entry.dates.filter(d => {
        const dt = new Date(d);
        return dt >= sixtyDaysAgo && dt < thirtyDaysAgo;
      }).length;

      let trend: 'increasing' | 'decreasing' | 'stable';
      if (previous === 0) {
        trend = recent > 0 ? 'increasing' : 'stable';
      } else {
        const ratio = recent / previous;
        if (ratio > 1.5) trend = 'increasing';
        else if (ratio < 0.5) trend = 'decreasing';
        else trend = 'stable';
      }

      const dir = dirname(filePath);

      signals.push({
        id: signalId('churn_hotspot', filePath),
        type: 'churn_hotspot',
        summary: `Churn hotspot: ${filePath} changed ${entry.count} times (${sigma.toFixed(1)}σ above mean of ${mean.toFixed(0)}). Trend: ${trend}.`,
        severity: sigma > 3 ? 'warning' : 'caution',
        confidence: Math.min(0.95, 0.6 + sigma * 0.1),
        directory_scope: dir === '.' ? '.' : dir,
        contributing_shas: entry.shas.slice(0, 20), // cap at 20 most relevant
        temporal_scope: {
          start: sortedDates[0],
          end: sortedDates[sortedDates.length - 1],
        },
        metadata: {
          file: filePath,
          count: entry.count,
          sigma: parseFloat(sigma.toFixed(2)),
          mean: parseFloat(mean.toFixed(1)),
          trend,
          recent_30d: recent,
          previous_30d: previous,
        },
        created_at: new Date().toISOString(),
      });
    }

    // Sort by sigma descending
    signals.sort((a, b) => (b.metadata.sigma as number) - (a.metadata.sigma as number));
    return signals;
  }
}
