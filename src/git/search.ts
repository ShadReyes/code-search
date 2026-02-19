import chalk from 'chalk';
import type {
  GitHistorySearchResult,
  GitHistoryChunk,
  CodeSearchConfig,
  BlameResult,
  GitLogResult,
} from '../types.js';
import { initStore, initGitHistoryTable, searchGitHistory } from '../store.js';
import { embedSingle } from '../embedder.js';
import { pickaxeSearch, gitBlame, grepLog } from './extractor.js';

let storeReady = false;

async function ensureStore(): Promise<void> {
  if (storeReady) return;
  await initStore();
  await initGitHistoryTable();
  storeReady = true;
}

type Strategy = 'temporal_vector' | 'pickaxe' | 'blame' | 'structured_git' | 'vector';

export function classifyQuery(query: string): {
  strategy: Strategy;
  extractedParams: Record<string, string>;
} {
  const q = query.toLowerCase();

  // pickaxe — must check before structured_git since patterns can overlap
  const pickaxeMatch = query.match(
    /when was\s+(.+?)\s+(introduced|added|removed)/i,
  );
  if (pickaxeMatch) {
    return {
      strategy: 'pickaxe',
      extractedParams: { searchString: pickaxeMatch[1] },
    };
  }
  if (/first (introduced|added)/i.test(q)) {
    const term = query.replace(/.*first (introduced|added)\s*/i, '').trim();
    return {
      strategy: 'pickaxe',
      extractedParams: { searchString: term || query },
    };
  }

  // blame
  if (/who (wrote|changed|modified)|this (line|function)|blame/i.test(q)) {
    const params: Record<string, string> = {};
    const fileMatch = query.match(/(\S+\.\w{1,5})/);
    if (fileMatch) params.file = fileMatch[1];
    const lineMatch = query.match(/line\s*(\d+)/i);
    if (lineMatch) params.line = lineMatch[1];
    return { strategy: 'blame', extractedParams: params };
  }

  // temporal_vector
  if (
    /recently|last month|last week|yesterday|this year|when did|since\b/i.test(q) ||
    /\b20\d{2}\b/.test(q)
  ) {
    const now = new Date();
    let after: string | undefined;

    if (/last month/i.test(q)) {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      after = d.toISOString().slice(0, 10);
    } else if (/last week/i.test(q)) {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      after = d.toISOString().slice(0, 10);
    } else if (/yesterday/i.test(q)) {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      after = d.toISOString().slice(0, 10);
    } else if (/this year/i.test(q)) {
      after = `${now.getFullYear()}-01-01`;
    } else if (/recently/i.test(q)) {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      after = d.toISOString().slice(0, 10);
    } else {
      const yearMatch = q.match(/\b(20\d{2})\b/);
      if (yearMatch) after = `${yearMatch[1]}-01-01`;
    }

    return {
      strategy: 'temporal_vector',
      extractedParams: after ? { after } : {},
    };
  }

  // structured_git
  if (
    /what changed in|commits touching|changes to|commits by/i.test(q) ||
    /\S+\.\w{1,5}/.test(q) && /commit|change|modif/i.test(q)
  ) {
    const params: Record<string, string> = {};
    const fileMatch = query.match(/(\S+\.\w{1,5})/);
    if (fileMatch) params.file = fileMatch[1];
    const authorMatch = query.match(/(?:commits by|by)\s+(\S+)/i);
    if (authorMatch) params.author = authorMatch[1];
    return { strategy: 'structured_git', extractedParams: params };
  }

  // default: vector
  return { strategy: 'vector', extractedParams: {} };
}

interface SearchOptions {
  after?: string;
  author?: string;
  file?: string;
  type?: string;
  limit?: number;
}

export async function searchGitHistoryQuery(
  query: string,
  repoPath: string,
  config: CodeSearchConfig,
  options?: SearchOptions,
): Promise<GitHistorySearchResult[]> {
  await ensureStore();

  const { strategy, extractedParams } = classifyQuery(query);
  const limit = options?.limit ?? config.searchLimit ?? 10;

  // Merge explicit options over extracted params
  const after = options?.after ?? extractedParams.after;
  const author = options?.author ?? extractedParams.author;
  const file = options?.file ?? extractedParams.file;
  const type = options?.type ?? extractedParams.type;
  const searchString = extractedParams.searchString;

  let results: GitHistorySearchResult[] = [];

  switch (strategy) {
    case 'vector': {
      const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
      const filters = buildWhereFilters({ author, file, type });
      results = await searchGitHistory(vector, limit, filters || undefined);
      break;
    }

    case 'temporal_vector': {
      const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
      const parts: string[] = [];
      if (after) parts.push(`date > '${after}'`);
      if (author) parts.push(`author = '${escapeSql(author)}'`);
      if (file) parts.push(`file_path = '${escapeSql(file)}'`);
      if (type) parts.push(`commit_type = '${escapeSql(type)}'`);
      const filter = parts.length > 0 ? parts.join(' AND ') : undefined;
      results = await searchGitHistory(vector, limit, filter);
      break;
    }

    case 'pickaxe': {
      if (!searchString) {
        // Fall back to vector if we couldn't extract a search string
        const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
        results = await searchGitHistory(vector, limit);
        break;
      }
      const pickaxeResults = await pickaxeSearch(repoPath, searchString, limit);
      results = await resolveGitLogResults(pickaxeResults, query, config, limit);
      break;
    }

    case 'blame': {
      const blameFile = file ?? extractedParams.file;
      const blameLine = extractedParams.line;
      if (!blameFile) {
        // Can't blame without a file, fall back to vector
        const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
        results = await searchGitHistory(vector, limit);
        break;
      }
      const startLine = blameLine ? parseInt(blameLine, 10) : 1;
      const endLine = blameLine ? startLine + 10 : 50;
      const blameResults = await gitBlame(repoPath, blameFile, startLine, endLine);
      results = await resolveBlameResults(blameResults, query, config, limit);
      break;
    }

    case 'structured_git': {
      const parts: string[] = [];
      if (author) parts.push(`author = '${escapeSql(author)}'`);
      if (file) parts.push(`file_path = '${escapeSql(file)}'`);
      if (type) parts.push(`commit_type = '${escapeSql(type)}'`);
      if (after) parts.push(`date > '${after}'`);
      const filter = parts.length > 0 ? parts.join(' AND ') : undefined;

      const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
      results = await searchGitHistory(vector, limit, filter);

      // Also try grepLog for additional results
      const grepPattern = query
        .replace(/what changed in|commits touching|changes to|commits by\s*\S*/gi, '')
        .trim();
      if (grepPattern.length > 2) {
        const grepResults = await grepLog(repoPath, grepPattern, limit);
        const additional = await resolveGitLogResults(grepResults, query, config, limit);
        // Merge, deduplicating by chunk id
        const seen = new Set(results.map(r => r.chunk.id));
        for (const r of additional) {
          if (!seen.has(r.chunk.id)) {
            results.push(r);
            seen.add(r.chunk.id);
          }
        }
      }
      break;
    }
  }

  // Set retrieval_method on all results
  for (const r of results) {
    r.retrieval_method = strategy;
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

export function formatGitResults(
  results: GitHistorySearchResult[],
  query: string,
): string {
  if (results.length === 0) {
    return chalk.yellow(`No results found for "${query}"`);
  }

  const strategy = results[0]?.retrieval_method ?? 'vector';
  const lines: string[] = [
    chalk.bold(`Found ${results.length} results for "${query}" (strategy: ${strategy})`),
    '',
  ];

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

function buildWhereFilters(params: {
  author?: string;
  file?: string;
  type?: string;
}): string | null {
  const parts: string[] = [];
  if (params.author) parts.push(`author = '${escapeSql(params.author)}'`);
  if (params.file) parts.push(`file_path = '${escapeSql(params.file)}'`);
  if (params.type) parts.push(`commit_type = '${escapeSql(params.type)}'`);
  return parts.length > 0 ? parts.join(' AND ') : null;
}

async function resolveGitLogResults(
  logResults: GitLogResult[],
  query: string,
  config: CodeSearchConfig,
  limit: number,
): Promise<GitHistorySearchResult[]> {
  const results: GitHistorySearchResult[] = [];
  const seenShas = new Set<string>();

  for (const log of logResults) {
    if (seenShas.has(log.sha)) continue;
    seenShas.add(log.sha);

    const filter = `sha = '${escapeSql(log.sha)}'`;
    const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
    const found = await searchGitHistory(vector, 5, filter);

    if (found.length > 0) {
      results.push(...found);
    } else {
      // No LanceDB result for this SHA — return basic result with score 0
      results.push({
        chunk: {
          id: `git-${log.sha}`,
          sha: log.sha,
          author: log.author,
          email: '',
          date: log.date,
          subject: log.subject,
          body: '',
          chunk_type: 'commit_summary',
          commit_type: '',
          scope: '',
          file_path: '',
          text: `${log.subject}\n\nFiles: ${log.files.join(', ')}`,
          files_changed: log.files.length,
          additions: 0,
          deletions: 0,
          branch: '',
        },
        score: 0,
        retrieval_method: 'vector',
      });
    }

    if (results.length >= limit) break;
  }

  return results;
}

async function resolveBlameResults(
  blameResults: BlameResult[],
  query: string,
  config: CodeSearchConfig,
  limit: number,
): Promise<GitHistorySearchResult[]> {
  const results: GitHistorySearchResult[] = [];
  const seenShas = new Set<string>();

  for (const blame of blameResults) {
    if (seenShas.has(blame.sha)) continue;
    seenShas.add(blame.sha);

    const filter = `sha = '${escapeSql(blame.sha)}'`;
    const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
    const found = await searchGitHistory(vector, 5, filter);

    if (found.length > 0) {
      results.push(...found);
    } else {
      // No LanceDB result — return basic result from blame data
      results.push({
        chunk: {
          id: `blame-${blame.sha}-${blame.lineStart}`,
          sha: blame.sha,
          author: blame.author,
          email: blame.email,
          date: blame.date,
          subject: blame.content,
          body: '',
          chunk_type: 'commit_summary',
          commit_type: '',
          scope: '',
          file_path: '',
          text: `Lines ${blame.lineStart}-${blame.lineEnd}: ${blame.content}`,
          files_changed: 0,
          additions: 0,
          deletions: 0,
          branch: '',
        },
        score: 0,
        retrieval_method: 'vector',
      });
    }

    if (results.length >= limit) break;
  }

  return results;
}
