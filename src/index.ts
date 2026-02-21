#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexFull, indexIncremental, loadConfig } from './indexer.js';
import { searchCode, formatResults } from './search.js';
import { initStore, getStats, getGitStats, initGitHistoryTable } from './store.js';
import { DEFAULT_CONFIG } from './types.js';
import { registry } from './lang/plugin.js';
import { TypeScriptPlugin } from './lang/typescript/index.js';
import { PythonPlugin } from './lang/python/index.js';
import { RubyPlugin } from './lang/ruby/index.js';
import { indexGitFull, indexGitIncremental } from './git/indexer.js';
import { searchGitHistoryQuery, formatGitResults } from './git/search.js';
import { explain, formatExplainResult } from './git/cross-ref.js';
import { analyzeFullPipeline, analyzeIncrementalPipeline } from './signals/indexer.js';
import { assess, formatAssessResult } from './assess.js';

registry.register(new TypeScriptPlugin());
registry.register(new PythonPlugin());
registry.register(new RubyPlugin());

const program = new Command();

function resolveRepo(repo?: string): string {
  const raw = repo || process.env.CORTEX_RECALL_REPO;
  if (!raw) {
    console.error(chalk.red(
      'Error: Repository path is required.\n\n' +
      'Provide it via:\n' +
      '  --repo /path/to/your/repo\n' +
      '  CORTEX_RECALL_REPO=/path/to/your/repo (env var)'
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
  .name('cortex-recall')
  .description('Local semantic code search CLI for NextJS monorepos')
  .version('0.1.0');

program
  .command('index')
  .description('Index a repository for semantic search')
  .option('--full', 'Force a full re-index (default: incremental)')
  .option('--repo <path>', 'Path to the repository root')
  .option('--provider <name>', 'Embedding provider: ollama or openai')
  .option('--model <name>', 'Embedding model name')
  .option('--verbose', 'Show detailed output')
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, opts.verbose);
      if (opts.provider) config.embeddingProvider = opts.provider;
      if (opts.model) config.embeddingModel = opts.model;
      if (opts.full) {
        await indexFull(repoRoot, opts.verbose, config);
      } else {
        await indexIncremental(repoRoot, opts.verbose, config);
      }
    } catch (err) {
      console.error(chalk.red(`\nIndex failed:\n${formatError(err)}`));
      if (formatError(err).includes('Ollama') || formatError(err).includes('OpenAI')) {
        console.error(chalk.dim('\nTip: Make sure your embedding provider is running and configured.'));
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
  .option('--format <type>', 'Output format: text or json', 'text')
  .option('--verbose', 'Show detailed output')
  .action(async (search, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const results = await searchCode(search, repoRoot, opts.limit, opts.filter, opts.verbose);
      if (opts.format === 'json') {
        console.log(JSON.stringify({ query: search, results }, null, 2));
      } else {
        console.log(formatResults(results, search));
      }
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
  .option('--format <type>', 'Output format: text or json', 'text')
  .action(async (opts) => {
    try {
      const repoRoot = resolveRepo(opts.repo);
      const config = loadConfig(repoRoot, false);
      await initStore(config.storeUri);
      const stats = await getStats();
      if (opts.format === 'json') {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(chalk.blue('Index Statistics'));
        console.log(`  Total chunks: ${chalk.white(stats.totalChunks.toString())}`);
        console.log(`  Unique files: ${chalk.white(stats.uniqueFiles.toString())}`);

        if (stats.totalChunks === 0) {
          console.log(chalk.dim('\nNo data indexed yet. Run: cortex-recall index --full --repo <path>'));
        }
      }
    } catch (err) {
      console.error(chalk.red(`\nStats failed:\n${formatError(err)}`));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Generate a .cortexrc.json config file with defaults')
  .option('--repo <path>', 'Path to the repository root')
  .action((opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const configPath = join(repoRoot, '.cortexrc.json');

    if (existsSync(configPath)) {
      console.log(chalk.yellow(`Config already exists at ${configPath}`));
      console.log(chalk.dim('Delete it first if you want to regenerate defaults.'));
      return;
    }

    const configWithComments = {
      _comment: 'Configuration for cortex-recall CLI. See README.md for details.',
      ...DEFAULT_CONFIG,
    };

    writeFileSync(configPath, JSON.stringify(configWithComments, null, 2) + '\n');
    console.log(chalk.green(`Created config at ${configPath}`));
    console.log(chalk.dim('Edit this file to customize indexing behavior.'));
  });

// --- Git History Commands ---

program
  .command('git-index')
  .description('Index git history for semantic search')
  .option('--full', 'Force a full re-index (default: incremental)')
  .option('--repo <path>', 'Path to the repository root')
  .option('--provider <name>', 'Embedding provider: ollama or openai')
  .option('--model <name>', 'Embedding model name')
  .option('--max-commits <n>', 'Limit to the last N commits (default: all)', parseInt)
  .option('--verbose', 'Show detailed output')
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, false);
      if (opts.provider) config.embeddingProvider = opts.provider;
      if (opts.model) config.embeddingModel = opts.model;
      if (opts.maxCommits !== undefined) {
        config.git!.maxCommits = opts.maxCommits;
      }
      if (opts.verbose) {
        console.log(chalk.dim('Effective config:'));
        console.log(chalk.dim(JSON.stringify(config, null, 2)));
      }
      if (opts.full) {
        await indexGitFull(repoRoot, config, opts.verbose);
      } else {
        await indexGitIncremental(repoRoot, config, opts.verbose);
      }
    } catch (err) {
      console.error(chalk.red(`\nGit index failed:\n${formatError(err)}`));
      if (formatError(err).includes('Ollama') || formatError(err).includes('OpenAI')) {
        console.error(chalk.dim('\nTip: Make sure your embedding provider is running and configured.'));
      }
      process.exit(1);
    }
  });

program
  .command('git-search <query>')
  .description('Search git history semantically')
  .option('--repo <path>', 'Path to the repository root')
  .option('--after <date>', 'Filter commits after date (ISO 8601)')
  .option('--author <name>', 'Filter by author name')
  .option('--file <path>', 'Filter by file path')
  .option('--type <type>', 'Filter by commit type (feat, fix, refactor, ...)')
  .option('--before <date>', 'Filter commits before date (ISO 8601)')
  .option('--sort <order>', 'Sort order: relevance (default) or date', 'relevance')
  .option('--unique-commits', 'Show only one result per commit (highest scoring)')
  .option('--limit <n>', 'Maximum number of results', parseInt)
  .option('--format <type>', 'Output format: text or json', 'text')
  .option('--verbose', 'Show detailed output')
  .action(async (query, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, opts.verbose);
      const results = await searchGitHistoryQuery(query, repoRoot, config, {
        after: opts.after,
        before: opts.before,
        author: opts.author,
        file: opts.file,
        type: opts.type,
        limit: opts.limit,
        sort: opts.sort,
        uniqueCommits: opts.uniqueCommits,
      });
      if (opts.format === 'json') {
        console.log(JSON.stringify({ query, results }, null, 2));
      } else {
        console.log(formatGitResults(results, query, opts.sort));
      }
    } catch (err) {
      const msg = formatError(err);
      console.error(chalk.red(`\nGit search failed:\n${msg}`));
      if (msg.includes('table') || msg.includes('not found')) {
        console.error(chalk.dim(
          '\nTip: You need to index git history first:\n' +
          `  cortex-recall git-index --full --repo ${repoRoot}`
        ));
      }
      process.exit(1);
    }
  });

program
  .command('git-stats')
  .description('Show git history index statistics')
  .option('--repo <path>', 'Path to the repository root')
  .option('--format <type>', 'Output format: text or json', 'text')
  .action(async (opts) => {
    try {
      const repoRoot = resolveRepo(opts.repo);
      const config = loadConfig(repoRoot, false);
      await initStore(config.storeUri);
      await initGitHistoryTable();
      const stats = await getGitStats();
      if (opts.format === 'json') {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(chalk.blue('Git History Index Statistics'));
        console.log(`  Total chunks:   ${chalk.white(stats.totalChunks.toString())}`);
        console.log(`  Unique commits: ${chalk.white(stats.uniqueCommits.toString())}`);
        if (stats.dateRange) {
          console.log(`  Date range:     ${chalk.white(`${stats.dateRange.earliest.slice(0, 10)} to ${stats.dateRange.latest.slice(0, 10)}`)}`);
        }
        if (stats.totalChunks === 0) {
          console.log(chalk.dim('\nNo git history indexed yet. Run: cortex-recall git-index --full --repo <path>'));
        }
      }
    } catch (err) {
      console.error(chalk.red(`\nGit stats failed:\n${formatError(err)}`));
      process.exit(1);
    }
  });

program
  .command('explain <query>')
  .description('Combined code context + git history search')
  .option('--repo <path>', 'Path to the repository root')
  .option('--format <type>', 'Output format: text or json', 'text')
  .option('--verbose', 'Show detailed output')
  .action(async (query, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, opts.verbose);
      const result = await explain(query, repoRoot, config, opts.verbose);
      if (opts.format === 'json') {
        console.log(JSON.stringify({ query, ...result }, null, 2));
      } else {
        console.log(formatExplainResult(result, query));
      }
    } catch (err) {
      console.error(chalk.red(`\nExplain failed:\n${formatError(err)}`));
      process.exit(1);
    }
  });

// --- Signal Analysis Commands ---

program
  .command('analyze')
  .description('Detect patterns and signals from git history')
  .option('--full', 'Force a full re-analysis (default: incremental)')
  .option('--repo <path>', 'Path to the repository root')
  .option('--provider <name>', 'Embedding provider: ollama or openai')
  .option('--model <name>', 'Embedding model name')
  .option('--verbose', 'Show detailed output')
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, opts.verbose);
      if (opts.provider) config.embeddingProvider = opts.provider;
      if (opts.model) config.embeddingModel = opts.model;
      if (opts.full) {
        await analyzeFullPipeline(repoRoot, config, opts.verbose);
      } else {
        await analyzeIncrementalPipeline(repoRoot, config, opts.verbose);
      }
    } catch (err) {
      console.error(chalk.red(`\nAnalysis failed:\n${formatError(err)}`));
      if (formatError(err).includes('git history')) {
        console.error(chalk.dim('\nTip: Run git-index first:\n  cortex-recall git-index --full --repo <path>'));
      }
      process.exit(1);
    }
  });

program
  .command('assess')
  .description('Get judgment and warnings for files you plan to modify')
  .option('--files <paths>', 'Comma-separated file paths to assess')
  .option('--change-type <type>', 'Type of change: feat, fix, refactor, etc.')
  .option('--query <text>', 'Optional natural language context for the change')
  .option('--repo <path>', 'Path to the repository root')
  .option('--format <type>', 'Output format: text or json', 'text')
  .option('--verbose', 'Show detailed output')
  .action(async (opts) => {
    if (!opts.files) {
      console.error(chalk.red('Error: --files is required.\n  Usage: cortex-recall assess --files src/foo.ts,src/bar.ts'));
      process.exit(1);
    }
    const repoRoot = resolveRepo(opts.repo);
    try {
      const config = loadConfig(repoRoot, opts.verbose);
      const files = opts.files.split(',').map((f: string) => f.trim());
      const result = await assess(files, repoRoot, config, {
        changeType: opts.changeType,
        query: opts.query,
        verbose: opts.verbose,
        format: opts.format,
      });
      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatAssessResult(result));
      }
    } catch (err) {
      const msg = formatError(err);
      console.error(chalk.red(`\nAssess failed:\n${msg}`));
      if (msg.includes('signal') || msg.includes('profile')) {
        console.error(chalk.dim('\nTip: Run analyze first:\n  cortex-recall analyze --full --repo <path>'));
      }
      process.exit(1);
    }
  });

program.parse();
