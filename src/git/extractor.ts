import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GitCommitRaw, GitFileChange, GitConfig } from '../types.js';

const LOCK_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
]);

const COMMIT_SEP = 'COMMIT_SEP';
const EXEC_OPTS = { encoding: 'utf8' as const, timeout: 30000 };

const compiledPatternCache = new Map<string, RegExp>();

function getCompiledPatterns(patterns: string[]): RegExp[] {
  return patterns.map(pat => {
    if (!compiledPatternCache.has(pat)) {
      compiledPatternCache.set(pat, new RegExp(pat, 'i'));
    }
    return compiledPatternCache.get(pat)!;
  });
}

export function validateGitRepo(repoPath: string): void {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, ...EXEC_OPTS, stdio: 'pipe' });
  } catch {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
}

function isLockFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  return LOCK_FILES.has(basename);
}

function shouldSkipCommit(commit: GitCommitRaw, config: GitConfig, compiledPatterns: RegExp[]): boolean {
  // Skip bot authors (case-insensitive)
  if (config.skipBotAuthors.some(bot => commit.author.toLowerCase().includes(bot.toLowerCase()))) {
    return true;
  }

  // Skip if subject matches any skip pattern (pre-compiled)
  if (compiledPatterns.some(re => re.test(commit.subject))) {
    return true;
  }

  // Skip merge commits — child commits already cover the same diffs
  if (commit.parents.length > 1) {
    return true;
  }

  // Skip if ALL files are lock files (and there is at least one file)
  if (commit.files.length > 0 && commit.files.every(f => isLockFile(f.path))) {
    return true;
  }

  return false;
}

function parseNumstatLine(line: string): GitFileChange | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;

  const [addStr, delStr, ...pathParts] = parts;
  const filePath = pathParts.join('\t');
  if (!filePath) return null;

  // Binary files show as "-" for additions/deletions
  const additions = addStr === '-' ? 0 : parseInt(addStr, 10);
  const deletions = delStr === '-' ? 0 : parseInt(delStr, 10);

  if (isNaN(additions) || isNaN(deletions)) return null;

  return {
    path: filePath,
    additions,
    deletions,
    status: 'M', // numstat doesn't give status directly; default to M
  };
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t.+/;

function parseCommitBlock(headerLine: string, numstatLines: string[]): GitCommitRaw | null {
  // Header: %H%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%P%x00%D
  // The body (%b) can be multi-line, so \x00 delimiters for parents/refs
  // may end up in numstatLines. Rejoin non-numstat lines with the header.
  const bodyLines: string[] = [];
  const actualNumstat: string[] = [];

  for (const line of numstatLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // blank lines before numstat are part of body
      if (actualNumstat.length === 0) bodyLines.push('');
      continue;
    }
    if (NUMSTAT_RE.test(trimmed)) {
      actualNumstat.push(trimmed);
    } else {
      // Non-numstat lines are continuation of header/body
      bodyLines.push(line);
    }
  }

  // Rejoin header with body continuation lines
  const fullHeader = bodyLines.length > 0
    ? headerLine + '\n' + bodyLines.join('\n')
    : headerLine;

  const fields = fullHeader.split('\x00');
  if (fields.length < 8) return null;

  const [sha, author, email, date, subject, body, parentStr, refs] = fields;

  const parents = parentStr.trim() ? parentStr.trim().split(' ') : [];
  const files: GitFileChange[] = [];

  for (const line of actualNumstat) {
    const change = parseNumstatLine(line);
    if (change) files.push(change);
  }

  return {
    sha,
    author,
    email,
    date,
    subject,
    body: body.trim(),
    parents,
    refs: refs ?? '',
    files,
  };
}

async function* streamCommits(
  repoPath: string,
  args: string[],
  config: GitConfig,
): AsyncGenerator<GitCommitRaw> {
  validateGitRepo(repoPath);

  const compiledPatterns = getCompiledPatterns(config.skipMessagePatterns);

  const proc = spawn('git', args, {
    cwd: repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: proc.stdout });

  let currentHeader: string | null = null;
  let numstatLines: string[] = [];
  let commitCount = 0;

  for await (const line of rl) {
    // Replace invalid UTF-8 chars
    const cleaned = line.replace(/\uFFFD/g, '');

    if (cleaned.startsWith(COMMIT_SEP)) {
      // Flush previous commit
      if (currentHeader !== null) {
        const commit = parseCommitBlock(currentHeader, numstatLines);
        if (commit && !shouldSkipCommit(commit, config, compiledPatterns)) {
          yield commit;
          commitCount++;
          if (config.maxCommits > 0 && commitCount >= config.maxCommits) {
            proc.kill();
            return;
          }
        }
      }

      // Start new commit: strip the COMMIT_SEP prefix, rest is the header after \x00
      currentHeader = cleaned.slice(COMMIT_SEP.length);
      // The header starts with \x00 separator from the format string
      if (currentHeader.startsWith('\x00')) {
        currentHeader = currentHeader.slice(1);
      }
      numstatLines = [];
    } else {
      // numstat line (or blank separator between header and numstat)
      numstatLines.push(cleaned);
    }
  }

  // Flush last commit
  if (currentHeader !== null) {
    const commit = parseCommitBlock(currentHeader, numstatLines);
    if (commit && !shouldSkipCommit(commit, config, compiledPatterns)) {
      if (config.maxCommits === 0 || commitCount < config.maxCommits) {
        yield commit;
      }
    }
  }

  // Wait for process to exit
  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // code 141 = SIGPIPE from us killing the process, which is fine
        if (code !== 141) {
          reject(new Error(`git log exited with code ${code}`));
          return;
        }
      }
      resolve();
    });
    proc.on('error', reject);
  });
}

export async function* extractAllCommits(
  repoPath: string,
  config: GitConfig,
): AsyncGenerator<GitCommitRaw> {
  const args = [
    'log',
    '--all',
    `--format=${COMMIT_SEP}%x00%H%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%P%x00%D`,
    '--numstat',
  ];

  yield* streamCommits(repoPath, args, config);
}

export async function* extractCommitsSince(
  repoPath: string,
  sinceCommit: string,
  config: GitConfig,
): AsyncGenerator<GitCommitRaw> {
  const args = [
    'log',
    `${sinceCommit}..HEAD`,
    `--format=${COMMIT_SEP}%x00%H%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%P%x00%D`,
    '--numstat',
  ];

  yield* streamCommits(repoPath, args, config);
}

export async function getCommitDiffs(
  repoPath: string,
  sha: string,
  maxLinesPerFile: number = 50,
): Promise<Map<string, string>> {
  const diffs = new Map<string, string>();
  try {
    const output = execSync(
      `git show --format="" --patch ${sha}`,
      { cwd: repoPath, ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 },
    );

    // Split on "diff --git a/" headers
    const parts = output.split(/^diff --git a\//m);

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // First line: "path/to/file b/path/to/file\n..."
      const newlineIdx = part.indexOf('\n');
      if (newlineIdx === -1) continue;

      const header = part.slice(0, newlineIdx);
      // Extract file path from "path b/path" — use the b/ side
      const bIdx = header.indexOf(' b/');
      const filePath = bIdx !== -1 ? header.slice(bIdx + 3) : header.split(' ')[0];

      const diffBody = 'diff --git a/' + part;

      if (diffBody.includes('Binary files')) {
        diffs.set(filePath, '[binary file]');
        continue;
      }

      const lines = diffBody.split('\n');
      if (lines.length > maxLinesPerFile) {
        diffs.set(filePath, lines.slice(0, maxLinesPerFile).join('\n') + `\n... truncated (${lines.length - maxLinesPerFile} more lines)`);
      } else {
        diffs.set(filePath, diffBody);
      }
    }
  } catch {
    // Return empty map — caller should fall back to per-file extraction
  }
  return diffs;
}

export async function getFileDiff(
  repoPath: string,
  sha: string,
  filePath: string,
  maxLines: number = 200,
): Promise<string> {
  try {
    const output = execSync(
      `git show --format="" --patch --function-context ${sha} -- ${filePath}`,
      { cwd: repoPath, ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 },
    );

    // Skip binary diffs
    if (output.includes('Binary files')) {
      return '[binary file]';
    }

    const lines = output.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... truncated (${lines.length - maxLines} more lines)`;
    }
    return output;
  } catch {
    return '';
  }
}

