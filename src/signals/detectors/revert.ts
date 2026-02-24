import { createHash } from 'node:crypto';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

function commonDirectory(filePaths: string[]): string {
  if (filePaths.length === 0) return '.';
  const dirs = filePaths.map(p => p.split('/').slice(0, -1));
  const first = dirs[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (dirs.every(d => d[i] === first[i])) {
      common.push(first[i]);
    } else break;
  }
  return common.length > 0 ? common.join('/') : '.';
}

export class RevertDetector implements SignalDetector {
  readonly name = 'revert';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];
    // Only look at commit_summary chunks
    const summaries = commits.filter(c => c.chunk_type === 'commit_summary');

    // Build SHA → decision_class map for dominant class computation
    const shaClass = new Map<string, GitHistoryChunk['decision_class']>();
    for (const c of summaries) shaClass.set(c.sha, c.decision_class);

    // Build SHA → file paths map from file_diff chunks
    const shaFiles = new Map<string, string[]>();
    for (const c of commits) {
      if (c.chunk_type === 'file_diff' && c.file_path) {
        const files = shaFiles.get(c.sha) || [];
        files.push(c.file_path);
        shaFiles.set(c.sha, files);
      }
    }

    // Build SHA lookup for matching reverts to originals
    const bySha = new Map<string, GitHistoryChunk>();
    for (const c of summaries) {
      bySha.set(c.sha, c);
    }

    // Build lookup maps for O(1) revert matching
    // 1. SHA prefix (7-char) -> full SHA
    const shaPrefix = new Map<string, string>();
    for (const sha of bySha.keys()) {
      shaPrefix.set(sha.slice(0, 7), sha);
    }

    // 2. Subject -> SHA for quoted subject matching
    const subjectToSha = new Map<string, string>();
    for (const c of summaries) {
      subjectToSha.set(c.subject, c.sha);
    }

    for (const commit of summaries) {
      const subject = commit.subject.toLowerCase();
      if (!subject.includes('revert')) continue;

      // Try to extract the reverted SHA from the subject or body
      // Common patterns: 'Revert "original subject"', 'This reverts commit abc123'
      let originalSha: string | null = null;

      // Pattern 1: "This reverts commit <sha>"
      const revertMatch = (commit.subject + ' ' + commit.body).match(/reverts?\s+commit\s+([0-9a-f]{7,40})/i);
      if (revertMatch) {
        const candidateSha = revertMatch[1];
        // Try exact match first
        if (bySha.has(candidateSha)) {
          originalSha = candidateSha;
        } else if (candidateSha.length >= 7) {
          // Try prefix lookup
          const fullSha = shaPrefix.get(candidateSha.slice(0, 7));
          if (fullSha && fullSha.startsWith(candidateSha)) {
            originalSha = fullSha;
          }
        }
      }

      // Pattern 2: Match by quoted subject - 'Revert "some original subject"'
      if (!originalSha) {
        const quotedMatch = commit.subject.match(/[Rr]evert\s+"([^"]+)"/);
        if (quotedMatch) {
          const originalSubject = quotedMatch[1];
          const matchedSha = subjectToSha.get(originalSubject);
          if (matchedSha && matchedSha !== commit.sha) {
            originalSha = matchedSha;
          }
        }
      }

      const original = originalSha ? bySha.get(originalSha) : undefined;
      const timeToRevert = original
        ? Math.round((new Date(commit.date).getTime() - new Date(original.date).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      const shas = original ? [original.sha, commit.sha] : [commit.sha];

      // Compute dominant decision_class
      const classCounts: Record<string, number> = { decision: 0, routine: 0, unknown: 0 };
      for (const sha of shas) {
        const cls = shaClass.get(sha) || 'unknown';
        classCounts[cls]++;
      }
      const dominantDecisionClass = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0];

      const affectedFiles = originalSha ? (shaFiles.get(originalSha) || []) : [];
      const dirScope = affectedFiles.length > 0
        ? commonDirectory(affectedFiles)
        : '.';

      const summaryText = original
        ? `Revert detected: "${original.subject}" (${original.sha.slice(0, 7)}) was reverted by ${commit.sha.slice(0, 7)} after ${timeToRevert} days. ${original.files_changed} files affected.`
        : `Revert detected: ${commit.subject} (${commit.sha.slice(0, 7)}). Original commit not found in indexed history.`;

      signals.push({
        id: signalId('revert_pair', ...shas),
        type: 'revert_pair',
        summary: summaryText,
        severity: 'caution',
        confidence: original ? 0.9 : 0.6,
        directory_scope: dirScope,
        contributing_shas: shas,
        temporal_scope: {
          start: original?.date ?? commit.date,
          end: commit.date,
        },
        metadata: {
          original_sha: originalSha ?? null,
          revert_sha: commit.sha,
          time_to_revert_days: timeToRevert,
          original_subject: original?.subject ?? null,
          files_changed: original?.files_changed ?? commit.files_changed,
          affected_files: affectedFiles,
          dominant_decision_class: dominantDecisionClass,
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
