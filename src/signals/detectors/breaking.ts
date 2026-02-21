import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

export class BreakingChangeDetector implements SignalDetector {
  readonly name = 'breaking_change';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    const summaries = commits.filter(c => c.chunk_type === 'commit_summary');
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Build SHA -> files and SHA -> author maps
    const shaFiles = new Map<string, Set<string>>();
    const shaAuthor = new Map<string, string>();

    for (const chunk of fileDiffs) {
      if (!shaFiles.has(chunk.sha)) shaFiles.set(chunk.sha, new Set());
      shaFiles.get(chunk.sha)!.add(chunk.file_path);
    }

    for (const chunk of summaries) {
      shaAuthor.set(chunk.sha, chunk.author);
    }

    // Sort summaries by date
    const sorted = [...summaries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // For each non-fix commit, look for multi-author fix responses within 48h
    for (const commit of sorted) {
      if (commit.commit_type === 'fix') continue;

      const commitDate = new Date(commit.date).getTime();
      const commitFiles = shaFiles.get(commit.sha);
      if (!commitFiles || commitFiles.size === 0) continue;

      // Find fix commits within 48h that touch overlapping files from different authors
      const fixResponses: { sha: string; author: string; date: string }[] = [];
      const fixAuthors = new Set<string>();

      for (const candidate of sorted) {
        if (candidate.commit_type !== 'fix') continue;
        const candDate = new Date(candidate.date).getTime();
        if (candDate <= commitDate) continue;
        if (candDate - commitDate > FORTY_EIGHT_HOURS_MS) continue;
        if (candidate.author === commit.author) continue; // same author doesn't count

        const candFiles = shaFiles.get(candidate.sha);
        if (!candFiles) continue;

        // Check for file overlap with original or its directories
        const commitDirs = new Set([...commitFiles].map(f => dirname(f)));
        const hasOverlap = [...candFiles].some(f =>
          commitFiles.has(f) || commitDirs.has(dirname(f))
        );

        if (hasOverlap) {
          fixResponses.push({ sha: candidate.sha, author: candidate.author, date: candidate.date });
          fixAuthors.add(candidate.author);
        }
      }

      // Require fixes from at least 2 different authors (not counting original author)
      if (fixAuthors.size < 2) continue;

      const allAffectedFiles = new Set<string>();
      for (const f of commitFiles) allAffectedFiles.add(f);
      for (const fix of fixResponses) {
        const files = shaFiles.get(fix.sha);
        if (files) for (const f of files) allAffectedFiles.add(f);
      }

      const allShas = [commit.sha, ...fixResponses.map(f => f.sha)];
      const dirs = new Set([...allAffectedFiles].map(f => dirname(f)));
      const dirScope = dirs.size === 1 ? [...dirs][0] : [...dirs][0];

      signals.push({
        id: signalId('breaking_change', commit.sha),
        type: 'breaking_change',
        summary: `"${commit.subject}" (${commit.sha.slice(0, 7)}) triggered fixes from ${fixAuthors.size} different authors within 48 hours. Blast radius: ${allAffectedFiles.size} files.`,
        severity: 'warning',
        confidence: Math.min(0.95, 0.6 + fixAuthors.size * 0.1),
        directory_scope: dirScope,
        contributing_shas: allShas,
        temporal_scope: {
          start: commit.date,
          end: fixResponses[fixResponses.length - 1].date,
        },
        metadata: {
          trigger_sha: commit.sha,
          trigger_subject: commit.subject,
          trigger_author: commit.author,
          author_count: fixAuthors.size,
          fix_count: fixResponses.length,
          affected_files: allAffectedFiles.size,
          fix_authors: [...fixAuthors],
          fix_shas: fixResponses.map(f => f.sha),
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
