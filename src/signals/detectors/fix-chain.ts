import { createHash } from 'node:crypto';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function upperBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class FixAfterFeatureDetector implements SignalDetector {
  readonly name = 'fix_chain';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    const summaries = commits.filter(c => c.chunk_type === 'commit_summary');
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Build SHA → decision_class map for dominant class computation
    const shaClass = new Map<string, GitHistoryChunk['decision_class']>();
    for (const c of summaries) shaClass.set(c.sha, c.decision_class);

    // Build a map of SHA -> files touched
    const shaFiles = new Map<string, Set<string>>();
    for (const chunk of fileDiffs) {
      if (!shaFiles.has(chunk.sha)) shaFiles.set(chunk.sha, new Set());
      shaFiles.get(chunk.sha)!.add(chunk.file_path);
    }

    // Pre-parse all timestamps
    const tsCache = new Map<string, number>();
    for (const c of summaries) {
      if (!tsCache.has(c.sha)) tsCache.set(c.sha, new Date(c.date).getTime());
    }

    // Sort summaries by date ascending
    const sorted = [...summaries].sort(
      (a, b) => tsCache.get(a.sha)! - tsCache.get(b.sha)!
    );

    // Pre-filter fix commits sorted by date, with pre-parsed timestamps
    const fixSorted = sorted.filter(c => c.commit_type === 'fix');
    const fixTimestamps = fixSorted.map(c => tsCache.get(c.sha)!);

    // Find feat commits and look for subsequent fix commits on same files within 7 days
    const featCommits = sorted.filter(c => c.commit_type === 'feat');

    for (const feat of featCommits) {
      const featDate = tsCache.get(feat.sha)!;
      const featFiles = shaFiles.get(feat.sha);
      if (!featFiles || featFiles.size === 0) continue;

      // Binary search to find first fix where timestamp > featDate
      const startIdx = upperBound(fixTimestamps, featDate);

      // Find fix commits within 7-day window that touch overlapping files
      const fixChain: GitHistoryChunk[] = [];
      for (let i = startIdx; i < fixSorted.length; i++) {
        const candDate = fixTimestamps[i];
        if (candDate - featDate > SEVEN_DAYS_MS) break;

        const candidate = fixSorted[i];
        const candFiles = shaFiles.get(candidate.sha);
        if (!candFiles) continue;

        // Check file overlap
        const overlap = [...candFiles].some(f => featFiles.has(f));
        if (overlap) {
          fixChain.push(candidate);
        }
      }

      if (fixChain.length === 0) continue;

      const lastFix = fixChain[fixChain.length - 1];
      const daySpan = Math.round(
        (tsCache.get(lastFix.sha)! - featDate) / (1000 * 60 * 60 * 24)
      );

      const allShas = [feat.sha, ...fixChain.map(c => c.sha)];

      // Compute dominant decision_class
      const classCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of allShas) {
        const cls = shaClass.get(sha) || 'unknown';
        classCounts[cls]++;
      }
      const dominantDecisionClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];

      // Collect all affected files from the fix chain
      const affectedFiles = new Set<string>();
      for (const sha of allShas) {
        const files = shaFiles.get(sha);
        if (files) for (const f of files) affectedFiles.add(f);
      }

      // Determine directory scope from affected files
      const dirs = new Set([...affectedFiles].map(f => {
        const parts = f.split('/');
        return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      }));
      const dirScope = dirs.size === 1 ? [...dirs][0] : [...dirs][0]; // use first dir if multiple

      signals.push({
        id: signalId('fix_chain', feat.sha),
        type: 'fix_chain',
        summary: `Feature "${feat.subject}" (${feat.sha.slice(0, 7)}) required ${fixChain.length} follow-up fix${fixChain.length > 1 ? 'es' : ''} over ${daySpan} day${daySpan !== 1 ? 's' : ''}, affecting ${affectedFiles.size} files.`,
        severity: fixChain.length >= 3 ? 'warning' : 'caution',
        confidence: Math.min(0.9, 0.5 + fixChain.length * 0.15),
        directory_scope: dirScope,
        contributing_shas: allShas,
        temporal_scope: {
          start: feat.date,
          end: lastFix.date,
        },
        metadata: {
          feature_sha: feat.sha,
          feature_subject: feat.subject,
          fix_count: fixChain.length,
          day_span: daySpan,
          affected_files: [...affectedFiles],
          fix_shas: fixChain.map(c => c.sha),
          fix_subjects: fixChain.map(c => c.subject),
          dominant_decision_class: dominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
