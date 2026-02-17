#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { indexFull, indexIncremental } from './indexer.js';
import { searchCode, formatResults } from './search.js';
import { initStore, getStats } from './store.js';
import { DEFAULT_CONFIG } from './types.js';

const program = new Command();

function resolveRepo(repo?: string): string {
  const resolved = repo || process.env.CODE_SEARCH_REPO;
  if (!resolved) {
    console.error(chalk.red('Error: --repo is required (or set CODE_SEARCH_REPO env var)'));
    process.exit(1);
  }
  return resolved;
}

program
  .name('code-search')
  .description('Local semantic code search CLI for NextJS monorepos')
  .version('0.1.0');

program
  .command('index')
  .description('Index a repository for semantic search')
  .option('--full', 'Force a full re-index (default: incremental)')
  .option('--repo <path>', 'Path to the repository root')
  .option('--verbose', 'Show detailed output')
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      if (opts.full) {
        await indexFull(repoRoot, opts.verbose);
      } else {
        await indexIncremental(repoRoot, opts.verbose);
      }
    } catch (err) {
      console.error(chalk.red(`Index failed: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

program
  .command('query <search>')
  .description('Search the index for relevant code')
  .option('--repo <path>', 'Path to the repository root')
  .option('--limit <n>', 'Maximum number of results', parseInt)
  .option('--filter <path-prefix>', 'Filter results by file path prefix')
  .option('--verbose', 'Show detailed output')
  .action(async (search, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const results = await searchCode(search, repoRoot, opts.limit, opts.filter, opts.verbose);
      console.log(formatResults(results, search));
    } catch (err) {
      console.error(chalk.red(`Search failed: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show index statistics')
  .option('--repo <path>', 'Path to the repository root')
  .action(async (opts) => {
    try {
      resolveRepo(opts.repo); // validate
      await initStore();
      const stats = await getStats();
      console.log(chalk.blue('Index Statistics'));
      console.log(`  Total chunks: ${chalk.white(stats.totalChunks.toString())}`);
      console.log(`  Unique files: ${chalk.white(stats.uniqueFiles.toString())}`);
    } catch (err) {
      console.error(chalk.red(`Stats failed: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Generate a .code-searchrc.json config file with defaults')
  .option('--repo <path>', 'Path to the repository root')
  .action((opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const configPath = join(repoRoot, '.code-searchrc.json');

    if (existsSync(configPath)) {
      console.log(chalk.yellow(`Config already exists at ${configPath}`));
      return;
    }

    const configWithComments = {
      _comment: 'Configuration for code-search CLI. See README.md for details.',
      ...DEFAULT_CONFIG,
    };

    writeFileSync(configPath, JSON.stringify(configWithComments, null, 2) + '\n');
    console.log(chalk.green(`Created config at ${configPath}`));
    console.log(chalk.dim('Edit this file to customize indexing behavior.'));
  });

program.parse();
