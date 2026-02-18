#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexFull, indexIncremental } from './indexer.js';
import { searchCode, formatResults } from './search.js';
import { initStore, getStats } from './store.js';
import { DEFAULT_CONFIG } from './types.js';

const program = new Command();

function resolveRepo(repo?: string): string {
  const raw = repo || process.env.CODE_SEARCH_REPO;
  if (!raw) {
    console.error(chalk.red(
      'Error: Repository path is required.\n\n' +
      'Provide it via:\n' +
      '  --repo /path/to/your/repo\n' +
      '  CODE_SEARCH_REPO=/path/to/your/repo (env var)'
    ));
    process.exit(1);
  }

  const resolved = resolve(raw);

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      console.error(chalk.red(`Error: "${resolved}" is not a directory.`));
      process.exit(1);
    }
  } catch {
    console.error(chalk.red(
      `Error: Cannot access "${resolved}".\n` +
      'Check that the path exists and you have read permission.'
    ));
    process.exit(1);
  }

  return resolved;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
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
      console.error(chalk.red(`\nIndex failed:\n${formatError(err)}`));
      if (formatError(err).includes('Ollama')) {
        console.error(chalk.dim('\nTip: Make sure Ollama is running and the model is pulled.'));
      }
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
      const msg = formatError(err);
      console.error(chalk.red(`\nSearch failed:\n${msg}`));
      if (msg.includes('No existing dataset') || msg.includes('table') || msg.includes('not found')) {
        console.error(chalk.dim(
          '\nTip: You need to index the repo first:\n' +
          `  npx tsx ${process.argv[1]} index --full --repo ${repoRoot}`
        ));
      }
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

      if (stats.totalChunks === 0) {
        console.log(chalk.dim('\nNo data indexed yet. Run: code-search index --full --repo <path>'));
      }
    } catch (err) {
      console.error(chalk.red(`\nStats failed:\n${formatError(err)}`));
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
      console.log(chalk.dim('Delete it first if you want to regenerate defaults.'));
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
