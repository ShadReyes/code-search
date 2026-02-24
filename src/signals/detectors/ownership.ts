import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

interface OwnershipEntry {
  author: string;
  commits: number;
  lastChange: string;
  shas: Set<string>;
}

export class OwnershipDetector implements SignalDetector {
  readonly name = 'ownership';

  constructor(private config: { minPercent: number; minCommits: number } = { minPercent: 30, minCommits: 3 }) {}

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];

    // Build SHA → decision_class map for dominant class computation
    const shaClass = new Map<string, GitHistoryChunk['decision_class']>();
    for (const c of commits) {
      if (c.chunk_type === 'commit_summary') shaClass.set(c.sha, c.decision_class);
    }

    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Group by file and directory in a single pass
    const fileAuthors = new Map<string, Map<string, OwnershipEntry>>();
    const dirAuthors = new Map<string, Map<string, OwnershipEntry>>();

    for (const chunk of fileDiffs) {
      // File-level
      if (!fileAuthors.has(chunk.file_path)) {
        fileAuthors.set(chunk.file_path, new Map());
      }
      const authors = fileAuthors.get(chunk.file_path)!;

      const entry = authors.get(chunk.author) || {
        author: chunk.author,
        commits: 0,
        lastChange: chunk.date,
        shas: new Set<string>(),
      };
      entry.commits++;
      if (chunk.date > entry.lastChange) entry.lastChange = chunk.date;
      entry.shas.add(chunk.sha);
      authors.set(chunk.author, entry);

      // Directory-level
      const dir = dirname(chunk.file_path);
      if (dir === '.') continue;

      if (!dirAuthors.has(dir)) {
        dirAuthors.set(dir, new Map());
      }
      const dAuthors = dirAuthors.get(dir)!;
      const dEntry = dAuthors.get(chunk.author) || {
        author: chunk.author,
        commits: 0,
        lastChange: chunk.date,
        shas: new Set<string>(),
      };
      dEntry.commits++;
      if (chunk.date > dEntry.lastChange) dEntry.lastChange = chunk.date;
      dEntry.shas.add(chunk.sha);
      dAuthors.set(chunk.author, dEntry);
    }

    // Emit ownership signals for files with a clear owner (>30%)
    for (const [filePath, authors] of fileAuthors) {
      const totalCommits = [...authors.values()].reduce((sum, e) => sum + e.commits, 0);
      if (totalCommits < this.config.minCommits) continue; // skip files with very few changes

      const sorted = [...authors.values()].sort((a, b) => b.commits - a.commits);
      const top = sorted[0];
      const percentage = Math.round((top.commits / totalCommits) * 100);

      if (percentage < this.config.minPercent) continue;

      const dir = dirname(filePath);

      // Compute dominant decision_class
      const classCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of top.shas) {
        const cls = shaClass.get(sha) || 'unknown';
        classCounts[cls]++;
      }
      const dominantDecisionClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];

      signals.push({
        id: signalId('ownership', filePath, top.author),
        type: 'ownership',
        summary: `${top.author} owns ${filePath} (${percentage}% of ${totalCommits} changes, last active ${top.lastChange.slice(0, 10)}).`,
        severity: 'info',
        confidence: Math.min(0.95, 0.5 + percentage / 200),
        directory_scope: dir === '.' ? '.' : dir,
        contributing_shas: [...top.shas].slice(0, 10),
        temporal_scope: {
          start: sorted[sorted.length - 1].lastChange,
          end: top.lastChange,
        },
        metadata: {
          file: filePath,
          primary_author: top.author,
          percentage,
          total_commits: totalCommits,
          contributor_count: authors.size,
          last_change: top.lastChange,
          contributors: sorted.slice(0, 5).map(e => ({
            author: e.author,
            percentage: Math.round((e.commits / totalCommits) * 100),
            commits: e.commits,
          })),
          dominant_decision_class: dominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    for (const [dir, authors] of dirAuthors) {
      const totalCommits = [...authors.values()].reduce((sum, e) => sum + e.commits, 0);
      if (totalCommits < this.config.minCommits + 2) continue;

      const sorted = [...authors.entries()]
        .map(([author, data]) => ({ author, ...data }))
        .sort((a, b) => b.commits - a.commits);
      const top = sorted[0];
      const percentage = Math.round((top.commits / totalCommits) * 100);

      if (percentage < this.config.minPercent) continue;

      // Compute dominant decision_class for directory
      const dirClassCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of top.shas) {
        const cls = shaClass.get(sha) || 'unknown';
        dirClassCounts[cls]++;
      }
      const dirDominantDecisionClass = Object.entries(dirClassCounts).sort((a, b) => b[1] - a[1])[0][0];

      signals.push({
        id: signalId('ownership', dir + '/', top.author),
        type: 'ownership',
        summary: `${top.author} owns ${dir}/ (${percentage}% of ${totalCommits} changes across directory).`,
        severity: 'info',
        confidence: Math.min(0.95, 0.5 + percentage / 200),
        directory_scope: dir,
        contributing_shas: [...top.shas].slice(0, 10),
        temporal_scope: {
          start: sorted[sorted.length - 1].lastChange,
          end: top.lastChange,
        },
        metadata: {
          directory: dir,
          primary_author: top.author,
          percentage,
          total_commits: totalCommits,
          contributor_count: authors.size,
          last_change: top.lastChange,
          contributors: sorted.slice(0, 5).map(e => ({
            author: e.author,
            percentage: Math.round((e.commits / totalCommits) * 100),
            commits: e.commits,
          })),
          dominant_decision_class: dirDominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
