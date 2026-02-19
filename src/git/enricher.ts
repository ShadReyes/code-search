import type { GitHistoryChunk, GitConfig } from '../types.js';

const LOW_QUALITY_PATTERN = /^(fix|wip|update|tmp|test|cleanup|minor|typo|\.)/i;

function inferScope(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split('/');
  const srcIdx = parts.indexOf('src');
  if (srcIdx !== -1 && srcIdx + 2 < parts.length) {
    return parts.slice(srcIdx + 1, srcIdx + 3).join('/');
  }
  return parts[0] || '';
}

function buildEnrichedText(chunk: GitHistoryChunk): string {
  const lines: string[] = [
    `search_document: Commit by ${chunk.author} on ${chunk.date}: "${chunk.subject}"`,
  ];

  if (chunk.body) {
    lines.push(chunk.body);
  }

  lines.push(
    `Files changed: ${chunk.files_changed} (${chunk.additions} additions, ${chunk.deletions} deletions)`,
  );

  if (chunk.file_path) {
    lines.push(`Primary file: ${chunk.file_path}`);
  }

  const scope = inferScope(chunk.file_path);
  if (scope) {
    lines.push(`Change scope: ${scope}`);
  }

  return lines.join('\n');
}

function isLowQuality(subject: string, threshold: number): boolean {
  return subject.length < threshold || LOW_QUALITY_PATTERN.test(subject);
}

export function enrichChunk(chunk: GitHistoryChunk, config: GitConfig): GitHistoryChunk {
  if (chunk.chunk_type !== 'commit_summary') return chunk;
  if (!config.enrichLowQualityMessages) return chunk;
  if (!isLowQuality(chunk.subject, config.lowQualityThreshold)) return chunk;

  return { ...chunk, text: buildEnrichedText(chunk) };
}
