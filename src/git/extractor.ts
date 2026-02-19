import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GitCommitRaw, GitFileChange, BlameResult, GitLogResult, GitConfig } from '../types.js';

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

function shouldSkipCommit(commit: GitCommitRaw, config: GitConfig): boolean {
  // Skip bot authors (case-insensitive)
  if (config.skipBotAuthors.some(bot => commit.author.toLowerCase().includes(bot.toLowerCase()))) {
    return true;
  }

  // Skip if subject matches any skip pattern
  if (config.skipMessagePatterns.some(pat => new RegExp(pat, 'i').test(commit.subject))) {
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

function parseCommitBlock(headerLine: string, numstatLines: string[]): GitCommitRaw | null {
  // Header: %H%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%P%x00%D
  const fields = headerLine.split('\x00');
  if (fields.length < 8) return null;

  const [sha, author, email, date, subject, body, parentStr, refs] = fields;

  const parents = parentStr.trim() ? parentStr.trim().split(' ') : [];
  const files: GitFileChange[] = [];

  for (const line of numstatLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const change = parseNumstatLine(trimmed);
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
        if (commit && !shouldSkipCommit(commit, config)) {
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
    if (commit && !shouldSkipCommit(commit, config)) {
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

export async function gitBlame(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<BlameResult[]> {
  try {
    const output = execSync(
      `git blame -L ${startLine},${endLine} --porcelain ${filePath}`,
      { cwd: repoPath, ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const results: BlameResult[] = [];
    const lines = output.split('\n');
    let i = 0;

    while (i < lines.length) {
      const headerMatch = lines[i].match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?/);
      if (!headerMatch) {
        i++;
        continue;
      }

      const sha = headerMatch[1];
      const finalLine = parseInt(headerMatch[3], 10);
      const numLines = headerMatch[4] ? parseInt(headerMatch[4], 10) : 1;

      let author = '';
      let email = '';
      let date = '';
      let content = '';
      i++;

      // Read key-value pairs until we hit a tab-prefixed content line
      while (i < lines.length) {
        if (lines[i].startsWith('\t')) {
          content = lines[i].slice(1);
          i++;
          break;
        }
        const line = lines[i];
        if (line.startsWith('author ')) author = line.slice(7);
        else if (line.startsWith('author-mail ')) email = line.slice(12).replace(/[<>]/g, '');
        else if (line.startsWith('author-time ')) {
          const timestamp = parseInt(line.slice(12), 10);
          date = new Date(timestamp * 1000).toISOString();
        }
        i++;
      }

      results.push({
        sha,
        author,
        email,
        date,
        lineStart: finalLine,
        lineEnd: finalLine + numLines - 1,
        content,
      });
    }

    return results;
  } catch {
    return [];
  }
}

function parseLogWithFiles(output: string): GitLogResult[] {
  const results: GitLogResult[] = [];
  // Split on double newlines to separate commit blocks
  const blocks = output.trim().split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const firstLine = lines[0];
    const fields = firstLine.split('\x00');
    if (fields.length < 4) continue;

    const [sha, author, date, subject] = fields;
    const files = lines.slice(1).filter(l => l.trim() !== '');

    results.push({ sha, author, date, subject, files });
  }

  return results;
}

export async function pickaxeSearch(
  repoPath: string,
  searchString: string,
  limit: number = 20,
): Promise<GitLogResult[]> {
  try {
    const output = execSync(
      `git log -S "${searchString.replace(/"/g, '\\"')}" --format="%H%x00%an%x00%aI%x00%s" --name-only -n ${limit}`,
      { cwd: repoPath, ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 },
    );

    return parseLogWithFiles(output);
  } catch {
    return [];
  }
}

export async function grepLog(
  repoPath: string,
  pattern: string,
  limit: number = 20,
): Promise<GitLogResult[]> {
  try {
    const output = execSync(
      `git log --grep="${pattern.replace(/"/g, '\\"')}" --format="%H%x00%an%x00%aI%x00%s" --name-only -n ${limit}`,
      { cwd: repoPath, ...EXEC_OPTS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 },
    );

    return parseLogWithFiles(output);
  } catch {
    return [];
  }
}
