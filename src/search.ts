import chalk from 'chalk';
import { embedSingle } from './embedder.js';
import { initStore, search as vectorSearch } from './store.js';
import { loadConfig } from './indexer.js';
import type { SearchResult } from './types.js';

export async function searchCode(
  query: string,
  repoRoot: string,
  limit?: number,
  fileFilter?: string,
  verbose: boolean = false,
): Promise<SearchResult[]> {
  const config = loadConfig(repoRoot, verbose);
  const effectiveLimit = limit || config.searchLimit;

  await initStore();

  // Embed query
  if (verbose) console.log(chalk.dim(`Embedding query: "${query}"`));
  const queryVector = await embedSingle(query, config.embeddingModel);

  // Search
  const results = await vectorSearch(queryVector, effectiveLimit, fileFilter);

  return results;
}

export function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return chalk.yellow(`No results found for "${query}"`);
  }

  const lines: string[] = [
    chalk.blue(`Found ${results.length} results for "${query}"\n`),
  ];

  results.forEach((r, i) => {
    const score = r.score.toFixed(2);
    const exported = r.chunk.exported ? ', exported' : '';
    const role = r.chunk.framework_role ? `, ${r.chunk.framework_role}` : '';

    lines.push(
      `${chalk.white(`${i + 1}.`)} ${chalk.green(`[${score}]`)} ` +
      `${chalk.cyan(r.chunk.file_path)} → ${chalk.white(r.chunk.name)} ` +
      `${chalk.dim(`(${r.chunk.chunk_type}${exported}${role})`)}`
    );
    lines.push(`   ${chalk.dim(`Lines ${r.chunk.line_start}-${r.chunk.line_end}`)}`);

    // Preview: first meaningful line of content (skip file comment and imports)
    const contentLines = r.chunk.content.split('\n');
    const previewLine = contentLines.find(l =>
      l.trim() && !l.startsWith('// file:') && !l.startsWith('import ')
    ) || contentLines[0];
    if (previewLine) {
      const preview = previewLine.length > 100
        ? previewLine.slice(0, 100) + '...'
        : previewLine;
      lines.push(`   ${chalk.dim('Preview:')} ${preview}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
