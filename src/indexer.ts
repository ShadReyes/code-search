import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import merge from 'lodash.merge';
import chalk from 'chalk';
import { registry } from './lang/plugin.js';
import { createProvider } from './embeddings/provider.js';
import { initStore, insertChunks, deleteByFilePath, dropTable } from './store.js';
import { DEFAULT_CONFIG, type CodeSearchConfig, type IndexState, type CodeChunk } from './types.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(__dirname);

function getStatePath(): string {
  return join(TOOL_ROOT, '.cortex-recall-state.json');
}

export function loadConfig(repoRoot: string, verbose: boolean = false): CodeSearchConfig {
  const configPath = join(repoRoot, '.cortexrc.json');
  let userConfig: Partial<CodeSearchConfig> = {};

  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (verbose) {
        console.log(chalk.dim(`Loaded config from ${configPath}`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`Warning: Failed to parse ${configPath}, using defaults`));
    }
  }

  const config = merge({}, DEFAULT_CONFIG, userConfig);

  // excludePatterns is additive
  if (userConfig.excludePatterns?.length) {
    config.exclude = [...config.exclude, ...userConfig.excludePatterns];
  }

  if (verbose) {
    console.log(chalk.dim('Effective config:'));
    console.log(chalk.dim(JSON.stringify(config, null, 2)));
  }

  return config;
}

export interface DiscoveredFile {
  path: string;
  content: string;
}

export function discoverFiles(repoRoot: string, config: CodeSearchConfig): DiscoveredFile[] {
  const allFiles: string[] = [];

  for (const pattern of config.include) {
    const matches = glob.sync(pattern, {
      cwd: repoRoot,
      absolute: true,
      nodir: true,
      ignore: config.exclude,
    });
    allFiles.push(...matches);
  }

  // Deduplicate
  const unique = [...new Set(allFiles)];

  // Filter by maxFileLines, skip directories/unreadable, keep content
  const results: DiscoveredFile[] = [];

  for (const filePath of unique) {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').length;
      if (lines > config.maxFileLines) continue;

      if (!config.indexTests) {
        const rel = relative(repoRoot, filePath);
        if (isTestFile(rel)) continue;
      }

      results.push({ path: filePath, content });
    } catch {
      continue;
    }
  }

  return results;
}

export function isTestFile(relativePath: string): boolean {
  return registry.isTestFile(relativePath);
}

function getGitCommitHash(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function loadState(): IndexState | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveState(state: IndexState): void {
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

export async function indexFull(
  repoRoot: string,
  verbose: boolean = false,
  configOverride?: CodeSearchConfig,
): Promise<void> {
  const config = configOverride ?? loadConfig(repoRoot, verbose);

  console.log(chalk.blue('Starting full index...'));

  // Initialize embedding provider
  const provider = createProvider(config);
  await provider.healthCheck();
  const dimension = await provider.probeDimension();
  if (verbose) console.log(chalk.dim(`Embedding dimension: ${dimension}`));

  // Initialize
  await registry.initAll();
  await initStore(config.storeUri);

  // Discover files
  const files = discoverFiles(repoRoot, config);
  console.log(chalk.blue(`Found ${files.length} files to index`));

  // Parse and chunk all files
  const allChunks: CodeChunk[] = [];
  let skipped = 0;

  for (const { path: filePath, content } of files) {
    try {
      const plugin = registry.getPluginForFile(filePath);
      if (!plugin) { skipped++; continue; }
      const chunks = plugin.chunkFile(filePath, content, repoRoot, config.chunkMaxTokens);
      allChunks.push(...chunks);
    } catch (err) {
      skipped++;
      if (verbose) {
        console.warn(chalk.yellow(`Skipped ${relative(repoRoot, filePath)}: ${err instanceof Error ? err.message : err}`));
      }
    }
  }

  console.log(chalk.blue(`Extracted ${allChunks.length} chunks from ${files.length - skipped} files`));

  if (allChunks.length === 0) {
    console.log(chalk.yellow('No chunks to index.'));
    return;
  }

  // Embed in batches (embedBatch handles internal batching + fallback)
  const contents = allChunks.map(c => c.content);
  console.log(chalk.dim(`Embedding ${contents.length} chunks (batch size ${config.embeddingBatchSize})...`));
  const vectors = await provider.embedBatch(contents, { batchSize: config.embeddingBatchSize, dimension, verbose });

  // Insert (overwrite)
  await dropTable();
  await insertChunks(allChunks, vectors, true);

  // Save state
  const state: IndexState = {
    lastCommit: getGitCommitHash(repoRoot),
    lastIndexedAt: new Date().toISOString(),
    totalChunks: allChunks.length,
    totalFiles: files.length - skipped,
    embeddingDimension: dimension,
  };
  saveState(state);

  console.log(chalk.green(`Full index complete: ${state.totalChunks} chunks from ${state.totalFiles} files`));
}

export async function indexIncremental(
  repoRoot: string,
  verbose: boolean = false,
  configOverride?: CodeSearchConfig,
): Promise<void> {
  const state = loadState();

  if (!state) {
    console.log(chalk.yellow('No existing index state found. Running full index...'));
    return indexFull(repoRoot, verbose, configOverride);
  }

  const config = configOverride ?? loadConfig(repoRoot, verbose);

  console.log(chalk.blue('Starting incremental index...'));

  // Initialize embedding provider
  const provider = createProvider(config);
  await provider.healthCheck();

  // Initialize
  await registry.initAll();
  await initStore(config.storeUri);

  // Get changed files
  let changedFiles: string[];
  try {
    const diffOutput = execSync(
      `git diff --name-only ${state.lastCommit} HEAD`,
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();
    const statusOutput = execSync(
      'git status --porcelain',
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();

    const diffFiles = diffOutput ? diffOutput.split('\n') : [];
    const statusFiles = statusOutput
      ? statusOutput.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      : [];

    changedFiles = [...new Set([...diffFiles, ...statusFiles])];
  } catch {
    console.log(chalk.yellow('Could not determine changed files. Running full index...'));
    return indexFull(repoRoot, verbose);
  }

  // Filter to relevant extensions
  const relevantFiles = changedFiles.filter(f => {
    const abs = join(repoRoot, f);
    return config.include.some(pattern => minimatch(f, pattern)) &&
      !config.exclude.some(pattern => minimatch(f, pattern)) &&
      (!isTestFile(f) || config.indexTests);
  });

  if (relevantFiles.length === 0) {
    console.log(chalk.green('No relevant files changed. Index is up to date.'));
    return;
  }

  console.log(chalk.blue(`Found ${relevantFiles.length} changed files`));

  // Process changed files
  const allChunks: CodeChunk[] = [];
  let deletedCount = 0;

  for (const relFile of relevantFiles) {
    const absPath = join(repoRoot, relFile);

    // Delete old chunks for this file
    await deleteByFilePath(relFile);

    if (!existsSync(absPath)) {
      deletedCount++;
      if (verbose) console.log(chalk.dim(`Deleted: ${relFile}`));
      continue;
    }

    try {
      const content = readFileSync(absPath, 'utf-8');
      const lines = content.split('\n').length;
      if (lines > config.maxFileLines) continue;

      const plugin = registry.getPluginForFile(absPath);
      if (!plugin) continue;
      const chunks = plugin.chunkFile(absPath, content, repoRoot, config.chunkMaxTokens);
      allChunks.push(...chunks);
    } catch (err) {
      if (verbose) {
        console.warn(chalk.yellow(`Skipped ${relFile}: ${err instanceof Error ? err.message : err}`));
      }
    }
  }

  if (allChunks.length > 0) {
    // Embed new chunks
    const contents = allChunks.map(c => c.content);
    const vectors = await provider.embedBatch(contents, { batchSize: config.embeddingBatchSize, dimension: state.embeddingDimension, verbose });
    await insertChunks(allChunks, vectors);
  }

  // Update state
  const newState: IndexState = {
    lastCommit: getGitCommitHash(repoRoot),
    lastIndexedAt: new Date().toISOString(),
    totalChunks: state.totalChunks + allChunks.length - deletedCount,
    totalFiles: state.totalFiles,
    embeddingDimension: state.embeddingDimension,
  };
  saveState(newState);

  console.log(chalk.green(
    `Re-indexed ${relevantFiles.length} files (${allChunks.length} chunks updated, ${deletedCount} files deleted)`
  ));
}

export async function indexRecent(
  repoRoot: string,
  verbose: boolean = false,
  configOverride?: CodeSearchConfig,
): Promise<void> {
  const config = configOverride ?? loadConfig(repoRoot, verbose);

  console.log(chalk.blue('Starting recent-changes index (last 30 days)...'));

  // Get files changed in last 30 days via git
  let recentFiles: string[];
  try {
    const output = execSync(
      'git log --since="30 days ago" --name-only --pretty=format: HEAD',
      { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    ).trim();
    recentFiles = [...new Set(output.split('\n').filter(Boolean))];
  } catch {
    console.log(chalk.yellow('Could not determine recent files. Running full index...'));
    return indexFull(repoRoot, verbose, configOverride);
  }

  // Filter to relevant extensions
  const relevantFiles = recentFiles.filter(f => {
    return config.include.some(pattern => minimatch(f, pattern)) &&
      !config.exclude.some(pattern => minimatch(f, pattern)) &&
      (!isTestFile(f) || config.indexTests);
  });

  if (relevantFiles.length === 0) {
    console.log(chalk.yellow('No recently changed files match indexing criteria.'));
    return;
  }

  console.log(chalk.blue(`Found ${relevantFiles.length} recently changed files`));

  // Initialize
  const provider = createProvider(config);
  await provider.healthCheck();
  const dimension = await provider.probeDimension();

  await registry.initAll();
  await initStore(config.storeUri);

  // Parse and chunk
  const allChunks: CodeChunk[] = [];
  let skipped = 0;

  for (const relFile of relevantFiles) {
    const absPath = join(repoRoot, relFile);
    if (!existsSync(absPath)) { skipped++; continue; }

    try {
      const content = readFileSync(absPath, 'utf-8');
      const lines = content.split('\n').length;
      if (lines > config.maxFileLines) continue;

      const plugin = registry.getPluginForFile(absPath);
      if (!plugin) { skipped++; continue; }
      const chunks = plugin.chunkFile(absPath, content, repoRoot, config.chunkMaxTokens);
      allChunks.push(...chunks);
    } catch (err) {
      skipped++;
      if (verbose) {
        console.warn(chalk.yellow(`Skipped ${relFile}: ${err instanceof Error ? err.message : err}`));
      }
    }
  }

  console.log(chalk.blue(`Extracted ${allChunks.length} chunks from ${relevantFiles.length - skipped} files`));

  if (allChunks.length === 0) {
    console.log(chalk.yellow('No chunks to index.'));
    return;
  }

  // Embed and insert (overwrite mode for clean start)
  const contents = allChunks.map(c => c.content);
  const vectors = await provider.embedBatch(contents, { batchSize: config.embeddingBatchSize, dimension, verbose });

  await dropTable();
  await insertChunks(allChunks, vectors, true);

  // Save state
  const state: IndexState = {
    lastCommit: getGitCommitHash(repoRoot),
    lastIndexedAt: new Date().toISOString(),
    totalChunks: allChunks.length,
    totalFiles: relevantFiles.length - skipped,
    embeddingDimension: dimension,
  };
  saveState(state);

  console.log(chalk.green(`Recent index complete: ${state.totalChunks} chunks from ${state.totalFiles} files`));
}
