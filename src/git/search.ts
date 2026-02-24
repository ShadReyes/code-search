import chalk from 'chalk';
import type { GitHistorySearchResult, CodeSearchConfig } from '../types.js';
import { initStore, initGitHistoryTable, searchGitHistory } from '../store.js';
import { createProvider } from '../embeddings/provider.js';

let storeReady = false;

async function ensureStore(storeUri?: string): Promise<void> {
  if (storeReady) return;
  await initStore(storeUri);
  await initGitHistoryTable();
  storeReady = true;
}

interface SearchOptions {
  after?: string;
  before?: string;
  author?: string;
  file?: string;
  type?: string;
  decisionClass?: 'decision' | 'routine' | 'unknown';
  limit?: number;
  sort?: 'relevance' | 'date';
  uniqueCommits?: boolean;
}

export async function searchGitHistoryQuery(
  query: string,
  repoPath: string,
  config: CodeSearchConfig,
  options?: SearchOptions,
): Promise<GitHistorySearchResult[]> {
  await ensureStore(config.storeUri);

  const limit = options?.limit ?? config.searchLimit ?? 10;
  const provider = createProvider(config);
  const vector = await provider.embedSingle(query, 'search_query: ');
  const filter = buildWhereFilters(options);
  const results = await searchGitHistory(vector, limit, filter || undefined);

  for (const r of results) {
    r.retrieval_method = 'vector';
  }

  results.sort((a, b) => b.score - a.score);

  // Deduplicate by SHA (keep highest-scoring chunk per commit)
  let filtered = results;
  if (options?.uniqueCommits) {
    const seen = new Map<string, GitHistorySearchResult>();
    for (const r of filtered) {
      const existing = seen.get(r.chunk.sha);
      if (!existing || r.score > existing.score) {
        seen.set(r.chunk.sha, r);
      }
    }
    filtered = [...seen.values()];
  }

  // Sort
  if (options?.sort === 'date') {
    filtered.sort((a, b) => new Date(b.chunk.date).getTime() - new Date(a.chunk.date).getTime());
  }

  return filtered.slice(0, limit);
}

export function formatGitResults(
  results: GitHistorySearchResult[],
  query: string,
  sortOrder?: 'relevance' | 'date',
): string {
  if (results.length === 0) {
    return chalk.yellow(`No results found for "${query}"`);
  }

  const lines: string[] = [
    chalk.bold(`Found ${results.length} results for "${query}"`),
    '',
  ];

    if (sortOrder === 'date') {
      lines.push(chalk.dim('  (sorted by date, newest first)'));
    }

  for (let i = 0; i < results.length; i++) {
    const { chunk, score } = results[i];
    const shortSha = chunk.sha.slice(0, 7);
    const dateStr = chunk.date.slice(0, 10);
    const totalChanges = `${chunk.files_changed} changed (+${chunk.additions}/-${chunk.deletions})`;

    lines.push(
      `${chalk.dim(`${i + 1}.`)} ${chalk.cyan(`[${score.toFixed(2)}]`)} ${chalk.yellow(shortSha)} ${chalk.dim(dateStr)} ${chalk.green(chunk.author)}`,
    );
    lines.push(`   ${chunk.subject}`);
    lines.push(`   ${chalk.dim(`Files: ${totalChanges}`)}`);
    lines.push(chalk.dim('   ---'));
  }

  return lines.join('\n');
}

// --- Helpers ---

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWhereFilters(params?: {
  after?: string;
  before?: string;
  author?: string;
  file?: string;
  type?: string;
  decisionClass?: string;
}): string | null {
  if (!params) return null;
  const parts: string[] = [];
  if (params.after) parts.push(`date > '${params.after}'`);
  if (params.before) parts.push(`date < '${params.before}'`);
  if (params.author) parts.push(`author = '${escapeSql(params.author)}'`);
  if (params.file) parts.push(`file_path = '${escapeSql(params.file)}'`);
  if (params.type) parts.push(`commit_type = '${escapeSql(params.type)}'`);
  if (params.decisionClass) parts.push(`decision_class = '${escapeSql(params.decisionClass)}'`);
  return parts.length > 0 ? parts.join(' AND ') : null;
}
