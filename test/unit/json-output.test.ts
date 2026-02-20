import { describe, it, expect } from 'vitest';
import type { SearchResult, GitHistorySearchResult } from '../../src/types.js';
import type { ExplainResult } from '../../src/git/cross-ref.js';

// ANSI escape code regex
const ANSI_RE = /\u001b\[\d+m/;

describe('JSON output shapes', () => {
  it('query results are JSON.parse-able and contain no ANSI codes', () => {
    const results: SearchResult[] = [
      {
        chunk: {
          id: 'test-1',
          file_path: 'src/index.ts',
          package_name: 'cortex-recall',
          name: 'main',
          chunk_type: 'function',
          line_start: 1,
          line_end: 10,
          content: 'function main() {}',
          language: 'typescript',
          exported: true,
        },
        score: 0.95,
      },
    ];

    const json = JSON.stringify({ query: 'auth', results }, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.query).toBe('auth');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].score).toBe(0.95);
    expect(parsed.results[0].chunk.file_path).toBe('src/index.ts');
    expect(json).not.toMatch(ANSI_RE);
  });

  it('git-search results are JSON.parse-able and contain no ANSI codes', () => {
    const results: GitHistorySearchResult[] = [
      {
        chunk: {
          id: 'git-1',
          sha: 'abc1234567890',
          author: 'Test Author',
          email: 'test@test.com',
          date: '2024-01-15T10:00:00Z',
          subject: 'feat: add auth',
          body: '',
          chunk_type: 'commit_summary',
          commit_type: 'feat',
          scope: 'auth',
          file_path: '',
          text: 'feat: add auth',
          files_changed: 3,
          additions: 50,
          deletions: 10,
          branch: 'main',
        },
        score: 0.88,
        retrieval_method: 'vector',
      },
    ];

    const json = JSON.stringify({ query: 'auth', results }, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.query).toBe('auth');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].chunk.sha).toBe('abc1234567890');
    expect(parsed.results[0].score).toBe(0.88);
    expect(json).not.toMatch(ANSI_RE);
  });

  it('stats are JSON.parse-able', () => {
    const stats = { totalChunks: 100, uniqueFiles: 20 };
    const json = JSON.stringify(stats, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.totalChunks).toBe(100);
    expect(parsed.uniqueFiles).toBe(20);
    expect(json).not.toMatch(ANSI_RE);
  });

  it('git-stats are JSON.parse-able', () => {
    const stats = {
      totalChunks: 200,
      uniqueCommits: 50,
      dateRange: { earliest: '2024-01-01', latest: '2024-06-01' },
    };
    const json = JSON.stringify(stats, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.totalChunks).toBe(200);
    expect(parsed.uniqueCommits).toBe(50);
    expect(parsed.dateRange.earliest).toBe('2024-01-01');
    expect(json).not.toMatch(ANSI_RE);
  });

  it('explain result is JSON.parse-able and has correct shape', () => {
    const result: ExplainResult = {
      codeResults: [
        {
          chunk: {
            id: 'test-1',
            file_path: 'src/auth.ts',
            package_name: 'pkg',
            name: 'authenticate',
            chunk_type: 'function',
            line_start: 10,
            line_end: 30,
            content: 'function authenticate() {}',
            language: 'typescript',
            exported: true,
          },
          score: 0.92,
          fileHistory: [
            {
              chunk: {
                id: 'git-1',
                sha: 'def4567890abc',
                author: 'Dev',
                email: 'dev@test.com',
                date: '2024-02-01T10:00:00Z',
                subject: 'refactor: update auth',
                body: '',
                chunk_type: 'file_diff',
                commit_type: 'refactor',
                scope: 'auth',
                file_path: 'src/auth.ts',
                text: 'refactor auth module',
                files_changed: 1,
                additions: 20,
                deletions: 15,
                branch: 'main',
              },
              score: 0.85,
              retrieval_method: 'vector',
            },
          ],
        },
      ],
      gitResults: [],
    };

    const json = JSON.stringify({ query: 'auth', ...result }, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.query).toBe('auth');
    expect(parsed.codeResults).toHaveLength(1);
    expect(parsed.codeResults[0].fileHistory).toHaveLength(1);
    expect(parsed.codeResults[0].chunk.name).toBe('authenticate');
    expect(parsed.gitResults).toHaveLength(0);
    expect(json).not.toMatch(ANSI_RE);
  });
});
