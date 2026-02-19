import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { GitCommitRaw, GitHistoryChunk, GitConfig } from '../types.js';
import { getFileDiff } from './extractor.js';

const CONVENTIONAL_RE = /^(feat|fix|refactor|docs|style|test|chore|perf|ci|build|revert)(\(([^)]+)\))?!?:\s/;
const MERGE_BRANCH_RE = /from\s+(\S+)/i;

function chunkId(sha: string, chunkType: string, filePath: string): string {
  return createHash('sha256').update(sha + chunkType + filePath).digest('hex').slice(0, 16);
}

function parseConventional(subject: string): { commitType: string; scope: string } {
  const match = subject.match(CONVENTIONAL_RE);
  if (!match) return { commitType: '', scope: '' };
  return { commitType: match[1], scope: match[3] || '' };
}

function extractBranch(refs: string, subject: string): string {
  // Try refs first (e.g. "HEAD -> main, origin/feature-x")
  if (refs) {
    const parts = refs.split(',').map(r => r.trim());
    for (const part of parts) {
      const arrow = part.replace(/^HEAD -> /, '');
      if (arrow && !arrow.startsWith('tag:')) return arrow;
    }
  }
  // Try merge message
  const mergeMatch = subject.match(MERGE_BRANCH_RE);
  if (mergeMatch) return mergeMatch[1];
  return '';
}

function totalAdditions(commit: GitCommitRaw): number {
  return commit.files.reduce((sum, f) => sum + f.additions, 0);
}

function totalDeletions(commit: GitCommitRaw): number {
  return commit.files.reduce((sum, f) => sum + f.deletions, 0);
}

function uniqueDirs(commit: GitCommitRaw): string[] {
  const dirs = new Set(commit.files.map(f => dirname(f.path)).filter(d => d !== '.'));
  return [...dirs];
}

function buildSummaryText(commit: GitCommitRaw): string {
  const lines: string[] = [
    `search_document: Commit by ${commit.author} on ${commit.date}: "${commit.subject}"`,
  ];

  if (commit.body) {
    lines.push(commit.body);
  }

  if (commit.files.length > 0) {
    lines.push('');
    lines.push('Files changed:');
    for (const f of commit.files) {
      lines.push(`  ${f.path} (+${f.additions}/-${f.deletions})`);
    }
  }

  const dirs = uniqueDirs(commit);
  if (dirs.length > 0) {
    lines.push(`Directories affected: ${dirs.join(', ')}`);
  }

  return lines.join('\n');
}

function buildMergeText(commit: GitCommitRaw): string {
  const lines: string[] = [
    `search_document: Merge commit by ${commit.author} on ${commit.date}: "${commit.subject}"`,
  ];

  if (commit.body) {
    lines.push(commit.body);
  }

  lines.push(`Parents: ${commit.parents.join(', ')}`);
  lines.push(`Files changed: ${commit.files.length} (+${totalAdditions(commit)}/-${totalDeletions(commit)})`);

  return lines.join('\n');
}

export async function chunkCommit(
  commit: GitCommitRaw,
  repoPath: string,
  config: GitConfig,
): Promise<GitHistoryChunk[]> {
  const { commitType, scope } = parseConventional(commit.subject);
  const branch = extractBranch(commit.refs, commit.subject);
  const adds = totalAdditions(commit);
  const dels = totalDeletions(commit);
  const chunks: GitHistoryChunk[] = [];

  // 1. commit_summary (always)
  chunks.push({
    id: chunkId(commit.sha, 'commit_summary', ''),
    sha: commit.sha,
    author: commit.author,
    email: commit.email,
    date: commit.date,
    subject: commit.subject,
    body: commit.body,
    chunk_type: 'commit_summary',
    commit_type: commitType,
    scope,
    file_path: '',
    text: buildSummaryText(commit),
    files_changed: commit.files.length,
    additions: adds,
    deletions: dels,
    branch,
  });

  // 2. file_diff (if enabled)
  if (config.includeFileChunks) {
    for (const file of commit.files) {
      const diff = await getFileDiff(repoPath, commit.sha, file.path, config.maxDiffLinesPerFile);
      const text = diff
        ? `search_document: Diff for ${file.path} in commit ${commit.sha.slice(0, 8)} by ${commit.author}:\n${diff}`
        : `search_document: ${file.path} changed (+${file.additions}/-${file.deletions}) in commit ${commit.sha.slice(0, 8)} by ${commit.author}`;

      chunks.push({
        id: chunkId(commit.sha, 'file_diff', file.path),
        sha: commit.sha,
        author: commit.author,
        email: commit.email,
        date: commit.date,
        subject: commit.subject,
        body: '',
        chunk_type: 'file_diff',
        commit_type: commitType,
        scope,
        file_path: file.path,
        text,
        files_changed: 1,
        additions: file.additions,
        deletions: file.deletions,
        branch,
      });
    }
  }

  // 3. merge_group (if enabled and is merge commit)
  if (config.includeMergeGroups && commit.parents.length > 1) {
    chunks.push({
      id: chunkId(commit.sha, 'merge_group', ''),
      sha: commit.sha,
      author: commit.author,
      email: commit.email,
      date: commit.date,
      subject: commit.subject,
      body: commit.body,
      chunk_type: 'merge_group',
      commit_type: commitType,
      scope,
      file_path: '',
      text: buildMergeText(commit),
      files_changed: commit.files.length,
      additions: adds,
      deletions: dels,
      branch,
    });
  }

  return chunks;
}
