import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { checkOllamaHealth, embedBatch, probeEmbeddingDimension } from '../embedder.js';
import { initStore, initGitHistoryTable, insertGitChunks, dropGitTable } from '../store.js';
import { extractAllCommits, extractCommitsSince, validateGitRepo } from './extractor.js';
import { chunkCommit } from './chunker.js';
import { enrichChunk } from './enricher.js';
import type { CodeSearchConfig, GitHistoryChunk, GitIndexState } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(dirname(__dirname));

function getGitStatePath(): string {
  return join(TOOL_ROOT, '.git-search-state.json');
}

function loadGitState(): GitIndexState | null {
  const statePath = getGitStatePath();
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveGitState(state: GitIndexState): void {
  writeFileSync(getGitStatePath(), JSON.stringify(state, null, 2));
}

async function processBatch(
  batch: GitHistoryChunk[],
  model: string,
  batchSize: number,
  dimension: number,
  verbose: boolean,
  overwrite: boolean,
): Promise<void> {
  const texts = batch.map(c => c.text);
  const vectors = await embedBatch(texts, model, batchSize, dimension, verbose, 'search_document: ');
  await insertGitChunks(batch, vectors, overwrite);
}

export async function indexGitFull(
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<void> {
  const gitConfig = config.git!;

  validateGitRepo(repoPath);

  console.log(chalk.blue('Starting full git history index...'));

  // Health check
  await checkOllamaHealth(config.embeddingModel);
  const dimension = await probeEmbeddingDimension(config.embeddingModel);
  if (verbose) console.log(chalk.dim(`Embedding dimension: ${dimension}`));

  // Initialize store
  await initStore();
  await initGitHistoryTable();
  await dropGitTable();

  // Stream and process commits
  let commitCount = 0;
  let chunkCount = 0;
  let batch: GitHistoryChunk[] = [];
  let isFirstBatch = true;

  for await (const commit of extractAllCommits(repoPath, gitConfig)) {
    commitCount++;

    // Chunk the commit
    const chunks = await chunkCommit(commit, repoPath, gitConfig);

    // Enrich each chunk
    const enriched = chunks.map(c => enrichChunk(c, gitConfig));
    batch.push(...enriched);

    // Flush batch every 20 chunks (git diff chunks are larger than code chunks)
    if (batch.length >= 20) {
      await processBatch(batch, config.embeddingModel, config.embeddingBatchSize, dimension, verbose, isFirstBatch);
      chunkCount += batch.length;
      isFirstBatch = false;
      batch = [];

      process.stdout.write(
        `\r${chalk.dim(`Indexed ${commitCount} commits (${chunkCount} chunks)...`)}`,
      );
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    await processBatch(batch, config.embeddingModel, config.embeddingBatchSize, dimension, verbose, isFirstBatch);
    chunkCount += batch.length;
  }

  // Clear progress line
  process.stdout.write('\r' + ' '.repeat(80) + '\r');

  // Save state
  const state: GitIndexState = {
    lastCommit: getHeadSha(repoPath),
    lastIndexedAt: new Date().toISOString(),
    totalChunks: chunkCount,
    totalCommits: commitCount,
    embeddingDimension: dimension,
  };
  saveGitState(state);

  console.log(chalk.green(`Git index complete: ${commitCount} commits, ${chunkCount} chunks`));
}

export async function indexGitIncremental(
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<void> {
  const state = loadGitState();

  if (!state) {
    console.log(chalk.yellow('No existing git index state found. Running full index...'));
    return indexGitFull(repoPath, config, verbose);
  }

  const gitConfig = config.git!;

  validateGitRepo(repoPath);

  console.log(chalk.blue(`Starting incremental git index (since ${state.lastCommit.slice(0, 8)})...`));

  // Health check
  await checkOllamaHealth(config.embeddingModel);
  const dimension = state.embeddingDimension;

  // Initialize store
  await initStore();
  await initGitHistoryTable();

  // Stream new commits
  let commitCount = 0;
  let chunkCount = 0;
  let batch: GitHistoryChunk[] = [];

  try {
    for await (const commit of extractCommitsSince(repoPath, state.lastCommit, gitConfig)) {
      commitCount++;

      const chunks = await chunkCommit(commit, repoPath, gitConfig);
      const enriched = chunks.map(c => enrichChunk(c, gitConfig));
      batch.push(...enriched);

      if (batch.length >= 20) {
        await processBatch(batch, config.embeddingModel, config.embeddingBatchSize, dimension, verbose, false);
        chunkCount += batch.length;
        batch = [];

        process.stdout.write(
          `\r${chalk.dim(`Indexed ${commitCount} new commits (${chunkCount} chunks)...`)}`,
        );
      }
    }
  } catch {
    console.log(chalk.yellow('Could not find base commit. Running full index...'));
    return indexGitFull(repoPath, config, verbose);
  }

  // Flush remaining
  if (batch.length > 0) {
    await processBatch(batch, config.embeddingModel, config.embeddingBatchSize, dimension, verbose, false);
    chunkCount += batch.length;
  }

  process.stdout.write('\r' + ' '.repeat(80) + '\r');

  if (commitCount === 0) {
    console.log(chalk.green('Git index is up to date.'));
    return;
  }

  // Update state
  const newState: GitIndexState = {
    lastCommit: getHeadSha(repoPath),
    lastIndexedAt: new Date().toISOString(),
    totalChunks: state.totalChunks + chunkCount,
    totalCommits: state.totalCommits + commitCount,
    embeddingDimension: dimension,
  };
  saveGitState(newState);

  console.log(chalk.green(`Incremental git index: ${commitCount} new commits, ${chunkCount} chunks added`));
}

function getHeadSha(repoPath: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}
