import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

function upperBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class BreakingChangeDetector implements SignalDetector {
  readonly name = 'breaking_change';
  private readonly windowMs: number;

  constructor(private config: { windowHours: number } = { windowHours: 48 }) {
    this.windowMs = this.config.windowHours * 60 * 60 * 1000;
  }

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    const summaries = commits.filter(c => c.chunk_type === 'commit_summary');
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Build SHA → decision_class map for dominant class computation
    const shaClass = new Map<string, GitHistoryChunk['decision_class']>();
    for (const c of summaries) shaClass.set(c.sha, c.decision_class);

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

    // Pre-parse all timestamps
    const tsCache = new Map<string, number>();
    for (const c of summaries) {
      if (!tsCache.has(c.sha)) tsCache.set(c.sha, new Date(c.date).getTime());
    }

    // Sort summaries by date
    const sorted = [...summaries].sort(
      (a, b) => tsCache.get(a.sha)! - tsCache.get(b.sha)!
    );

    // Pre-filter and sort fix commits with their timestamps
    const fixSorted = sorted.filter(c => c.commit_type === 'fix');
    const fixTimestamps = fixSorted.map(c => tsCache.get(c.sha)!);

    // For each non-fix commit, look for multi-author fix responses within 48h
    for (const commit of sorted) {
      if (commit.commit_type === 'fix') continue;

      const commitDate = tsCache.get(commit.sha)!;
      const commitFiles = shaFiles.get(commit.sha);
      if (!commitFiles || commitFiles.size === 0) continue;

      // Pre-compute commit dirs once per outer commit
      const commitDirs = new Set([...commitFiles].map(f => dirname(f)));

      // Binary search to find first fix where timestamp > commitDate
      const startIdx = upperBound(fixTimestamps, commitDate);

      const fixResponses: { sha: string; author: string; date: string }[] = [];
      const fixAuthors = new Set<string>();

      for (let i = startIdx; i < fixSorted.length; i++) {
        const candidate = fixSorted[i];
        const candDate = fixTimestamps[i];
        if (candDate - commitDate > this.windowMs) break;
        if (candidate.author === commit.author) continue; // same author doesn't count

        const candFiles = shaFiles.get(candidate.sha);
        if (!candFiles) continue;

        // Check for file overlap with original or its directories
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

      // Compute dominant decision_class
      const classCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of allShas) {
        const cls = shaClass.get(sha) || 'unknown';
        classCounts[cls]++;
      }
      const dominantDecisionClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];

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
          dominant_decision_class: dominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
