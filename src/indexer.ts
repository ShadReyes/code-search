import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import merge from 'lodash.merge';
import chalk from 'chalk';
import { initParser } from './parser.js';
import { chunkFile } from './chunker.js';
import { checkOllamaHealth, embedBatch, probeEmbeddingDimension } from './embedder.js';
import { initStore, insertChunks, deleteByFilePath, dropTable } from './store.js';
import { DEFAULT_CONFIG, type CodeSearchConfig, type IndexState, type CodeChunk } from './types.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(__dirname);

function getStatePath(): string {
  return join(TOOL_ROOT, '.code-search-state.json');
}

export function loadConfig(repoRoot: string, verbose: boolean = false): CodeSearchConfig {
  const configPath = join(repoRoot, '.code-searchrc.json');
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

function discoverFiles(repoRoot: string, config: CodeSearchConfig): string[] {
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

  // Filter by maxFileLines
  return unique.filter(filePath => {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    if (lines > config.maxFileLines) return false;

    // Skip test files if indexTests is false
    if (!config.indexTests) {
      const rel = relative(repoRoot, filePath);
      if (isTestFile(rel)) return false;
    }

    return true;
  });
}

function isTestFile(relativePath: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(relativePath) ||
    relativePath.includes('__tests__/') ||
    relativePath.includes('__mocks__/');
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
): Promise<void> {
  const config = loadConfig(repoRoot, verbose);

  console.log(chalk.blue('Starting full index...'));

  // Health check
  await checkOllamaHealth(config.embeddingModel);
  const dimension = await probeEmbeddingDimension(config.embeddingModel);
  if (verbose) console.log(chalk.dim(`Embedding dimension: ${dimension}`));

  // Initialize
  await initParser();
  await initStore();

  // Discover files
  const files = discoverFiles(repoRoot, config);
  console.log(chalk.blue(`Found ${files.length} files to index`));

  // Parse and chunk all files
  const allChunks: CodeChunk[] = [];
  let skipped = 0;

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const chunks = chunkFile(filePath, content, repoRoot, config.chunkMaxTokens);
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

  // Embed in batches
  const contents = allChunks.map(c => c.content);
  const vectors: number[][] = [];

  for (let i = 0; i < contents.length; i += config.embeddingBatchSize) {
    const batch = contents.slice(i, i + config.embeddingBatchSize);
    const batchEnd = Math.min(i + config.embeddingBatchSize, contents.length);
    console.log(chalk.dim(`Embedding chunks ${i + 1}-${batchEnd}/${contents.length}...`));
    const batchVectors = await embedBatch(batch, config.embeddingModel, config.embeddingBatchSize);
    vectors.push(...batchVectors);
  }

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
): Promise<void> {
  const state = loadState();

  if (!state) {
    console.log(chalk.yellow('No existing index state found. Running full index...'));
    return indexFull(repoRoot, verbose);
  }

  const config = loadConfig(repoRoot, verbose);

  console.log(chalk.blue('Starting incremental index...'));

  // Health check
  await checkOllamaHealth(config.embeddingModel);

  // Initialize
  await initParser();
  await initStore();

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

      const chunks = chunkFile(absPath, content, repoRoot, config.chunkMaxTokens);
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
    const vectors = await embedBatch(contents, config.embeddingModel, config.embeddingBatchSize);
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
