import chalk from 'chalk';
import type { CodeSearchConfig, GitHistorySearchResult, SearchResult } from '../types.js';
import { initStore, initGitHistoryTable, searchGitHistory } from '../store.js';
import { searchCode } from '../search.js';
import { embedSingle } from '../embedder.js';
import { pickaxeSearch } from './extractor.js';

async function ensureStores(): Promise<void> {
  await initStore();
  await initGitHistoryTable();
}

export async function getHistoryForFile(
  filePath: string,
  repoPath: string,
  config: CodeSearchConfig,
  limit: number = 10,
): Promise<GitHistorySearchResult[]> {
  await ensureStores();

  const escapedPath = filePath.replace(/'/g, "''");
  const vector = await embedSingle(filePath, config.embeddingModel, 'search_query: ');
  return searchGitHistory(vector, limit, `file_path = '${escapedPath}'`);
}

export async function getHistoryForSymbol(
  symbolName: string,
  repoPath: string,
  config: CodeSearchConfig,
  limit: number = 10,
): Promise<GitHistorySearchResult[]> {
  await ensureStores();

  const pickaxeResults = await pickaxeSearch(repoPath, symbolName, limit);
  if (pickaxeResults.length === 0) return [];

  const results: GitHistorySearchResult[] = [];
  const seenShas = new Set<string>();

  for (const log of pickaxeResults) {
    if (seenShas.has(log.sha)) continue;
    seenShas.add(log.sha);

    const vector = await embedSingle(symbolName, config.embeddingModel, 'search_query: ');
    const found = await searchGitHistory(vector, 3, `sha = '${log.sha.replace(/'/g, "''")}'`);

    if (found.length > 0) {
      results.push(...found);
    } else {
      results.push({
        chunk: {
          id: `pickaxe-${log.sha}`,
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
          text: `${log.subject}\nFiles: ${log.files.join(', ')}`,
          files_changed: log.files.length,
          additions: 0,
          deletions: 0,
          branch: '',
        },
        score: 0,
        retrieval_method: 'pickaxe',
      });
    }

    if (results.length >= limit) break;
  }

  return results;
}

export async function explain(
  query: string,
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<string> {
  await ensureStores();

  const lines: string[] = [];
  let hasCodeResults = false;
  let hasGitResults = false;

  // Search code index
  let codeResults: SearchResult[] = [];
  try {
    codeResults = await searchCode(query, repoPath, 5, undefined, verbose);
    hasCodeResults = codeResults.length > 0;
  } catch {
    codeResults = [];
  }

  // For each code result, find related git commits
  if (codeResults.length > 0) {
    lines.push(chalk.bold(`Code matches for "${query}":`));
    lines.push('');

    for (let i = 0; i < codeResults.length; i++) {
      const { chunk, score } = codeResults[i];
      lines.push(
        `${chalk.dim(`${i + 1}.`)} ${chalk.cyan(`[${score.toFixed(2)}]`)} ${chalk.white(chunk.file_path)}:${chunk.line_start}-${chunk.line_end} ${chalk.dim('—')} ${chunk.name} (${chunk.chunk_type}${chunk.exported ? ', exported' : ''})`,
      );

      // Find git history for this file
      try {
        const fileHistory = await getHistoryForFile(chunk.file_path, repoPath, config, 3);
        if (fileHistory.length > 0) {
          hasGitResults = true;
          lines.push(`   ${chalk.dim('Recent commits:')}`);
          for (const { chunk: gc } of fileHistory) {
            lines.push(
              `     ${chalk.dim('-')} ${chalk.yellow(gc.sha.slice(0, 7))} ${gc.date.slice(0, 10)} ${chalk.green(gc.author)}: ${gc.subject}`,
            );
          }
        }
      } catch {
        // Git index may not exist
      }

      lines.push('');
    }
  }

  // Also do a direct git history search
  try {
    const vector = await embedSingle(query, config.embeddingModel, 'search_query: ');
    const gitResults = await searchGitHistory(vector, 5);
    if (gitResults.length > 0) {
      hasGitResults = true;
      lines.push(chalk.bold(`Git history matches for "${query}":`));
      lines.push('');
      for (let i = 0; i < gitResults.length; i++) {
        const { chunk, score } = gitResults[i];
        lines.push(
          `${chalk.dim(`${i + 1}.`)} ${chalk.cyan(`[${score.toFixed(2)}]`)} ${chalk.yellow(chunk.sha.slice(0, 7))} ${chunk.date.slice(0, 10)} ${chalk.green(chunk.author)}`,
        );
        lines.push(`   ${chunk.subject}`);
        if (chunk.file_path) {
          lines.push(`   ${chalk.dim(`File: ${chunk.file_path}`)}`);
        }
        lines.push(`   ${chalk.dim(`Files: ${chunk.files_changed} changed (+${chunk.additions}/-${chunk.deletions})`)}`);
        lines.push('');
      }
    }
  } catch {
    // Git index may not exist
  }

  if (!hasCodeResults && !hasGitResults) {
    lines.push(chalk.yellow(`No results found for "${query}"`));
    lines.push('');
    if (!hasCodeResults) {
      lines.push(chalk.dim('Tip: Run "code-search index --full --repo <path>" to build the code index.'));
    }
    if (!hasGitResults) {
      lines.push(chalk.dim('Tip: Run "code-search git-index --full --repo <path>" to build the git history index.'));
    }
  } else if (!hasCodeResults) {
    lines.push(chalk.dim('Note: No code index found. Run "code-search index --full --repo <path>" for combined results.'));
  } else if (!hasGitResults) {
    lines.push(chalk.dim('Note: No git index found. Run "code-search git-index --full --repo <path>" for combined results.'));
  }

  return lines.join('\n');
}
