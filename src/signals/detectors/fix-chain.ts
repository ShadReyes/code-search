import { createHash } from 'node:crypto';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class FixAfterFeatureDetector implements SignalDetector {
  readonly name = 'fix_chain';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    const summaries = commits.filter(c => c.chunk_type === 'commit_summary');
    const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

    // Build a map of SHA -> files touched
    const shaFiles = new Map<string, Set<string>>();
    for (const chunk of fileDiffs) {
      if (!shaFiles.has(chunk.sha)) shaFiles.set(chunk.sha, new Set());
      shaFiles.get(chunk.sha)!.add(chunk.file_path);
    }

    // Sort summaries by date ascending
    const sorted = [...summaries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Find feat commits and look for subsequent fix commits on same files within 7 days
    const featCommits = sorted.filter(c => c.commit_type === 'feat');

    for (const feat of featCommits) {
      const featDate = new Date(feat.date).getTime();
      const featFiles = shaFiles.get(feat.sha);
      if (!featFiles || featFiles.size === 0) continue;

      // Find fix commits within 7-day window that touch overlapping files
      const fixChain: GitHistoryChunk[] = [];
      for (const candidate of sorted) {
        if (candidate.commit_type !== 'fix') continue;
        const candDate = new Date(candidate.date).getTime();
        if (candDate <= featDate) continue; // must be after the feat
        if (candDate - featDate > SEVEN_DAYS_MS) continue; // within 7 days

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
        (new Date(lastFix.date).getTime() - featDate) / (1000 * 60 * 60 * 24)
      );

      const allShas = [feat.sha, ...fixChain.map(c => c.sha)];
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
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
