import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitConfig } from '../../src/types.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

const { validateGitRepo, extractAllCommits, extractCommitsSince, getCommitDiffs } =
  await import('../../src/git/extractor.js');
const { spawn, execSync } = await import('node:child_process');
const { createInterface } = await import('node:readline');

const COMMIT_SEP = 'COMMIT_SEP';

function makeConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return {
    includeFileChunks: true,
    includeMergeGroups: true,
    maxDiffLinesPerFile: 50,
    enrichLowQualityMessages: true,
    lowQualityThreshold: 10,
    skipBotAuthors: ['dependabot', 'renovate', 'github-actions'],
    skipMessagePatterns: ['^Merge branch', 'lock file'],
    maxCommits: 0,
    ...overrides,
  };
}

function makeCommitLine(fields: {
  sha?: string;
  author?: string;
  email?: string;
  date?: string;
  subject?: string;
  body?: string;
  parents?: string;
  refs?: string;
}): string {
  const {
    sha = 'abc123',
    author = 'Alice',
    email = 'alice@test.com',
    date = '2024-06-15T10:00:00Z',
    subject = 'feat: add feature',
    body = '',
    parents = '',
    refs = '',
  } = fields;
  return `${COMMIT_SEP}\x00${sha}\x00${author}\x00${email}\x00${date}\x00${subject}\x00${body}\x00${parents}\x00${refs}`;
}

function mockSpawnWithLines(lines: string[]) {
  const stdout = {
    [Symbol.asyncIterator]: async function* () {
      for (const line of lines) yield line;
    },
  };
  const proc = {
    stdout,
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') setTimeout(() => cb(0), 0);
      return proc;
    }),
  };
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: execSync succeeds (valid git repo)
  vi.mocked(execSync).mockReturnValue('true\n' as any);
  // createInterface passes through the async iterator from stdout
  vi.mocked(createInterface).mockImplementation(({ input }: any) => input as any);
});

describe('validateGitRepo', () => {
  it('throws if execSync fails (not a git repo)', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not a git repo'); });

    expect(() => validateGitRepo('/not/a/repo')).toThrow('Not a git repository: /not/a/repo');
  });
});

describe('extractAllCommits', () => {
  it('parses well-formed commit block', async () => {
    const lines = [
      makeCommitLine({ sha: 'deadbeef123', author: 'Bob', subject: 'fix: bug' }),
      '10\t5\tsrc/foo.ts',
      '3\t1\tsrc/bar.ts',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('deadbeef123');
    expect(commits[0].author).toBe('Bob');
    expect(commits[0].subject).toBe('fix: bug');
    expect(commits[0].files).toHaveLength(2);
    expect(commits[0].files[0]).toEqual({ path: 'src/foo.ts', additions: 10, deletions: 5, status: 'M' });
  });

  it('skips merge commits (parents.length > 1)', async () => {
    const lines = [
      makeCommitLine({ sha: 'merge1', parents: 'parent1 parent2', subject: 'merge commit' }),
      '5\t2\tsrc/merged.ts',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(0);
  });

  it('replaces invalid UTF-8 (U+FFFD) characters', async () => {
    const lines = [
      makeCommitLine({ sha: 'utf8test', subject: 'fix: bad\uFFFD chars' }),
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('fix: bad chars');
  });

  it('numstat binary files show additions=0, deletions=0', async () => {
    const lines = [
      makeCommitLine({ sha: 'bintest' }),
      '-\t-\timage.png',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(1);
    expect(commits[0].files[0]).toEqual({ path: 'image.png', additions: 0, deletions: 0, status: 'M' });
  });

  it('shouldSkipCommit filters bot authors', async () => {
    const lines = [
      makeCommitLine({ sha: 'botcommit', author: 'dependabot[bot]', subject: 'chore: bump deps' }),
      '1\t1\tpackage.json',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(0);
  });

  it('shouldSkipCommit filters message patterns', async () => {
    const lines = [
      makeCommitLine({ sha: 'mergemsg', subject: "Merge branch 'feature' into main" }),
      '5\t2\tsrc/file.ts',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(0);
  });

  it('lock-file-only commits are skipped', async () => {
    const lines = [
      makeCommitLine({ sha: 'lockonly', subject: 'chore: update deps' }),
      '100\t50\tpackage-lock.json',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig())) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(0);
  });

  it('maxCommits reached kills process', async () => {
    const lines = [
      makeCommitLine({ sha: 'first', subject: 'first commit' }),
      '1\t0\tsrc/a.ts',
      makeCommitLine({ sha: 'second', subject: 'second commit' }),
      '1\t0\tsrc/b.ts',
    ];
    const proc = mockSpawnWithLines(lines);
    vi.mocked(spawn).mockReturnValue(proc as any);

    const commits = [];
    for await (const commit of extractAllCommits('/repo', makeConfig({ maxCommits: 1 }))) {
      commits.push(commit);
    }

    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('first');
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe('getCommitDiffs', () => {
  it('truncates large diffs and detects binary', async () => {
    const largeDiff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n');
    const binaryDiff = `diff --git a/image.png b/image.png\nBinary files /dev/null and b/image.png differ`;
    const codeDiff = `diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n${largeDiff}`;
    const fullOutput = `${codeDiff}\n${binaryDiff}`;

    vi.mocked(execSync).mockReturnValue(fullOutput as any);

    const diffs = await getCommitDiffs('/repo', 'abc123', 10);

    // Binary file detected
    expect(diffs.get('image.png')).toBe('[binary file]');

    // Large diff truncated
    const mainDiff = diffs.get('src/main.ts');
    expect(mainDiff).toBeDefined();
    expect(mainDiff).toContain('truncated');
  });
});
