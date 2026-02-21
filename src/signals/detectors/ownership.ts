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
  shas: string[];
}

export class OwnershipDetector implements SignalDetector {
  readonly name = 'ownership';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Group by file, then by author
    const fileAuthors = new Map<string, Map<string, OwnershipEntry>>();

    for (const chunk of fileDiffs) {
      if (!fileAuthors.has(chunk.file_path)) {
        fileAuthors.set(chunk.file_path, new Map());
      }
      const authors = fileAuthors.get(chunk.file_path)!;

      const entry = authors.get(chunk.author) || {
        author: chunk.author,
        commits: 0,
        lastChange: chunk.date,
        shas: [],
      };
      entry.commits++;
      if (chunk.date > entry.lastChange) entry.lastChange = chunk.date;
      if (!entry.shas.includes(chunk.sha)) entry.shas.push(chunk.sha);
      authors.set(chunk.author, entry);
    }

    // Emit ownership signals for files with a clear owner (>30%)
    for (const [filePath, authors] of fileAuthors) {
      const totalCommits = [...authors.values()].reduce((sum, e) => sum + e.commits, 0);
      if (totalCommits < 3) continue; // skip files with very few changes

      const sorted = [...authors.values()].sort((a, b) => b.commits - a.commits);
      const top = sorted[0];
      const percentage = Math.round((top.commits / totalCommits) * 100);

      if (percentage < 30) continue;

      const dir = dirname(filePath);

      signals.push({
        id: signalId('ownership', filePath, top.author),
        type: 'ownership',
        summary: `${top.author} owns ${filePath} (${percentage}% of ${totalCommits} changes, last active ${top.lastChange.slice(0, 10)}).`,
        severity: 'info',
        confidence: Math.min(0.95, 0.5 + percentage / 200),
        directory_scope: dir === '.' ? '.' : dir,
        contributing_shas: top.shas.slice(0, 10),
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
        },
        created_at: new Date().toISOString(),
      });
    }

    // Also compute directory-level ownership
    const dirAuthors = new Map<string, Map<string, { commits: number; lastChange: string; shas: string[] }>>();

    for (const chunk of fileDiffs) {
      const dir = dirname(chunk.file_path);
      if (dir === '.') continue;

      if (!dirAuthors.has(dir)) {
        dirAuthors.set(dir, new Map());
      }
      const authors = dirAuthors.get(dir)!;
      const entry = authors.get(chunk.author) || { commits: 0, lastChange: chunk.date, shas: [] };
      entry.commits++;
      if (chunk.date > entry.lastChange) entry.lastChange = chunk.date;
      if (!entry.shas.includes(chunk.sha)) entry.shas.push(chunk.sha);
      authors.set(chunk.author, entry);
    }

    for (const [dir, authors] of dirAuthors) {
      const totalCommits = [...authors.values()].reduce((sum, e) => sum + e.commits, 0);
      if (totalCommits < 5) continue;

      const sorted = [...authors.entries()]
        .map(([author, data]) => ({ author, ...data }))
        .sort((a, b) => b.commits - a.commits);
      const top = sorted[0];
      const percentage = Math.round((top.commits / totalCommits) * 100);

      if (percentage < 30) continue;

      signals.push({
        id: signalId('ownership', dir + '/', top.author),
        type: 'ownership',
        summary: `${top.author} owns ${dir}/ (${percentage}% of ${totalCommits} changes across directory).`,
        severity: 'info',
        confidence: Math.min(0.95, 0.5 + percentage / 200),
        directory_scope: dir,
        contributing_shas: top.shas.slice(0, 10),
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
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
