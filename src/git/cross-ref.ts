import chalk from 'chalk';
import type { CodeSearchConfig, GitHistorySearchResult, SearchResult } from '../types.js';
import { initStore, initGitHistoryTable, searchGitHistory } from '../store.js';
import { searchCode } from '../search.js';
import { createProvider } from '../embeddings/provider.js';

export interface ExplainCodeResult extends SearchResult {
  fileHistory: GitHistorySearchResult[];
}

export interface ExplainResult {
  codeResults: ExplainCodeResult[];
  gitResults: GitHistorySearchResult[];
}

async function ensureStores(storeUri?: string): Promise<void> {
  await initStore(storeUri);
  await initGitHistoryTable();
}

export async function getHistoryForFile(
  filePath: string,
  repoPath: string,
  config: CodeSearchConfig,
  limit: number = 10,
): Promise<GitHistorySearchResult[]> {
  await ensureStores(config.storeUri);

  const escapedPath = filePath.replace(/'/g, "''");
  const provider = createProvider(config);
  const vector = await provider.embedSingle(filePath, 'search_query: ');
  return searchGitHistory(vector, limit, `file_path = '${escapedPath}'`);
}

export async function explain(
  query: string,
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<ExplainResult> {
  await ensureStores(config.storeUri);

  const result: ExplainResult = { codeResults: [], gitResults: [] };

  // Search code index
  try {
    const codeResults = await searchCode(query, repoPath, 5, undefined, verbose);
    for (const cr of codeResults) {
      let fileHistory: GitHistorySearchResult[] = [];
      try {
        fileHistory = await getHistoryForFile(cr.chunk.file_path, repoPath, config, 3);
      } catch {
        // Git index may not exist
      }
      result.codeResults.push({ ...cr, fileHistory });
    }
  } catch {
    // Code index may not exist
  }

  // Direct git history search
  try {
    const provider = createProvider(config);
    const vector = await provider.embedSingle(query, 'search_query: ');
    result.gitResults = await searchGitHistory(vector, 5);
  } catch {
    // Git index may not exist
  }

  return result;
}

export function formatExplainResult(result: ExplainResult, query: string): string {
  const lines: string[] = [];
  const hasCodeResults = result.codeResults.length > 0;
  const hasGitResults = result.gitResults.length > 0 ||
    result.codeResults.some(cr => cr.fileHistory.length > 0);

  if (result.codeResults.length > 0) {
    lines.push(chalk.bold(`Code matches for "${query}":`));
    lines.push('');

    for (let i = 0; i < result.codeResults.length; i++) {
      const { chunk, score, fileHistory } = result.codeResults[i];
      lines.push(
        `${chalk.dim(`${i + 1}.`)} ${chalk.cyan(`[${score.toFixed(2)}]`)} ${chalk.white(chunk.file_path)}:${chunk.line_start}-${chunk.line_end} ${chalk.dim('—')} ${chunk.name} (${chunk.chunk_type}${chunk.exported ? ', exported' : ''})`,
      );

      if (fileHistory.length > 0) {
        lines.push(`   ${chalk.dim('Recent commits:')}`);
        for (const { chunk: gc } of fileHistory) {
          lines.push(
            `     ${chalk.dim('-')} ${chalk.yellow(gc.sha.slice(0, 7))} ${gc.date.slice(0, 10)} ${chalk.green(gc.author)}: ${gc.subject}`,
          );
        }
      }

      lines.push('');
    }
  }

  if (result.gitResults.length > 0) {
    lines.push(chalk.bold(`Git history matches for "${query}":`));
    lines.push('');
    for (let i = 0; i < result.gitResults.length; i++) {
      const { chunk, score } = result.gitResults[i];
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

  if (!hasCodeResults && !hasGitResults) {
    lines.push(chalk.yellow(`No results found for "${query}"`));
    lines.push('');
    if (!hasCodeResults) {
      lines.push(chalk.dim('Tip: Run "cortex-recall index --full --repo <path>" to build the code index.'));
    }
    if (!hasGitResults) {
      lines.push(chalk.dim('Tip: Run "cortex-recall git-index --full --repo <path>" to build the git history index.'));
    }
  } else if (!hasCodeResults) {
    lines.push(chalk.dim('Note: No code index found. Run "cortex-recall index --full --repo <path>" for combined results.'));
  } else if (!hasGitResults) {
    lines.push(chalk.dim('Note: No git index found. Run "cortex-recall git-index --full --repo <path>" for combined results.'));
  }

  return lines.join('\n');
}
