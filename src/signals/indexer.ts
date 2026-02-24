import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { createProvider } from '../embeddings/provider.js';
import { initStore, initGitHistoryTable } from '../store.js';
import type { CodeSearchConfig, GitHistoryChunk } from '../types.js';
import type { AnalyzeState, FileProfile, SignalRecord } from './types.js';
import { DetectorPipeline } from './detector.js';
import { RevertDetector } from './detectors/revert.js';
import { ChurnDetector } from './detectors/churn.js';
import { OwnershipDetector } from './detectors/ownership.js';
import { FixAfterFeatureDetector } from './detectors/fix-chain.js';
import { AdoptionCycleDetector } from './detectors/adoption.js';
import { StabilityShiftDetector } from './detectors/stability.js';
import { BreakingChangeDetector } from './detectors/breaking.js';
import {
  initSignalsStore,
  initSignalsTable,
  initFileProfilesTable,
  insertSignals,
  replaceSignalsByType,
  upsertFileProfiles,
  dropSignalsTable,
  dropFileProfilesTable,
  getSignalStats,
} from './store.js';
import { connect } from '@lancedb/lancedb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(dirname(__dirname));

function getAnalyzeStatePath(): string {
  return join(TOOL_ROOT, '.analyze-state.json');
}

function loadAnalyzeState(): AnalyzeState | null {
  const statePath = getAnalyzeStatePath();
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveAnalyzeState(state: AnalyzeState): void {
  writeFileSync(getAnalyzeStatePath(), JSON.stringify(state, null, 2));
}

async function loadAllGitHistory(storeUri?: string): Promise<GitHistoryChunk[]> {
  const dbPath = storeUri
    || process.env.CORTEX_RECALL_STORE_URI
    || `${TOOL_ROOT}/.lance`;
  const db = await connect(dbPath);
  const tableNames = await db.tableNames();
  if (!tableNames.includes('git_history')) return [];

  const table = await db.openTable('git_history');
  const rows = await table.query()
    .select([
      'id', 'sha', 'author', 'email', 'date', 'subject', 'body',
      'chunk_type', 'commit_type', 'scope', 'file_path', 'text',
      'files_changed', 'additions', 'deletions', 'branch', 'decision_class',
    ])
    .toArray();

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    sha: row.sha as string,
    author: row.author as string,
    email: row.email as string,
    date: row.date as string,
    subject: row.subject as string,
    body: row.body as string,
    chunk_type: row.chunk_type as GitHistoryChunk['chunk_type'],
    commit_type: row.commit_type as string,
    scope: row.scope as string,
    file_path: row.file_path as string,
    text: row.text as string,
    files_changed: row.files_changed as number,
    additions: row.additions as number,
    deletions: row.deletions as number,
    branch: row.branch as string,
    decision_class: (row.decision_class as GitHistoryChunk['decision_class']) || 'unknown',
  }));
}

function computeFileProfiles(
  commits: GitHistoryChunk[],
  signals: SignalRecord[],
): FileProfile[] {
  const fileDiffs = commits.filter(c => c.chunk_type === 'file_diff' && c.file_path);

  // Aggregate per file
  const fileData = new Map<string, {
    authors: Map<string, { commits: number; lastChange: string }>;
    dates: string[];
    revertCount: number;
    fixAfterFeatureCount: number;
  }>();

  for (const chunk of fileDiffs) {
    if (!fileData.has(chunk.file_path)) {
      fileData.set(chunk.file_path, {
        authors: new Map(),
        dates: [],
        revertCount: 0,
        fixAfterFeatureCount: 0,
      });
    }
    const data = fileData.get(chunk.file_path)!;
    data.dates.push(chunk.date);

    const entry = data.authors.get(chunk.author) || { commits: 0, lastChange: chunk.date };
    entry.commits++;
    if (chunk.date > entry.lastChange) entry.lastChange = chunk.date;
    data.authors.set(chunk.author, entry);
  }

  // Augment with signal data
  for (const signal of signals) {
    if (signal.type === 'revert_pair') {
      const files = (signal.metadata.affected_files as string[]) || [];
      for (const f of files) {
        const data = fileData.get(f);
        if (data) data.revertCount++;
      }
      // Also try matching by directory
      for (const [filePath, data] of fileData) {
        if (filePath.startsWith(signal.directory_scope + '/')) {
          data.revertCount++;
        }
      }
    }
    if (signal.type === 'fix_chain') {
      const files = (signal.metadata.affected_files as string[]) || [];
      for (const f of files) {
        const data = fileData.get(f);
        if (data) data.fixAfterFeatureCount++;
      }
    }
  }

  const profiles: FileProfile[] = [];

  for (const [filePath, data] of fileData) {
    const totalChanges = data.dates.length;
    if (totalChanges < 2) continue; // skip rarely-touched files

    // Compute primary owner
    const sortedAuthors = [...data.authors.entries()]
      .sort((a, b) => b[1].commits - a[1].commits);
    const topAuthor = sortedAuthors[0];
    const topPercentage = Math.round((topAuthor[1].commits / totalChanges) * 100);

    const primaryOwner = topPercentage >= 30 ? {
      author: topAuthor[0],
      percentage: topPercentage,
      commits: topAuthor[1].commits,
      last_change: topAuthor[1].lastChange,
    } : null;

    // Compute change frequency
    const sortedDates = data.dates.sort();
    const firstDate = new Date(sortedDates[0]);
    const lastDate = new Date(sortedDates[sortedDates.length - 1]);
    const daySpan = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));
    const changesPerDay = totalChanges / daySpan;

    let changeFrequency: FileProfile['change_frequency'];
    if (changesPerDay >= 1) changeFrequency = 'daily';
    else if (changesPerDay >= 1 / 7) changeFrequency = 'weekly';
    else if (changesPerDay >= 1 / 30) changeFrequency = 'monthly';
    else changeFrequency = 'rare';

    // Compute stability score (0-100, higher = more stable)
    // Factors: revert count, fix-after-feature count, total changes relative to age
    const revertPenalty = Math.min(30, data.revertCount * 10);
    const fixChainPenalty = Math.min(20, data.fixAfterFeatureCount * 5);
    const churnPenalty = Math.min(30, Math.max(0, (changesPerDay - 0.1) * 100));
    const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - revertPenalty - fixChainPenalty - churnPenalty)));

    // Compute risk score (0-100, higher = more risky)
    const riskScore = Math.max(0, Math.min(100, Math.round(
      (100 - stabilityScore) * 0.5 +
      (data.authors.size > 5 ? 15 : 0) +
      (data.revertCount > 0 ? 20 : 0) +
      (data.fixAfterFeatureCount > 0 ? 15 : 0)
    )));

    // Collect active signal IDs for this file
    const activeSignalIds = signals
      .filter(s => {
        if (s.metadata.file === filePath) return true;
        if (filePath.startsWith(s.directory_scope + '/')) return true;
        return false;
      })
      .map(s => s.id);

    profiles.push({
      path: filePath,
      primary_owner: primaryOwner,
      contributor_count: data.authors.size,
      stability_score: stabilityScore,
      total_changes: totalChanges,
      revert_count: data.revertCount,
      fix_after_feature_count: data.fixAfterFeatureCount,
      change_frequency: changeFrequency,
      risk_score: riskScore,
      last_modified: sortedDates[sortedDates.length - 1],
      active_signal_ids: activeSignalIds,
    });
  }

  return profiles;
}

export async function analyzeFullPipeline(
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<void> {
  console.log(chalk.blue('Starting full analysis pipeline...'));

  // Step 1: Load all git history
  console.log(chalk.dim('Loading git history from index...'));
  const allCommits = await loadAllGitHistory(config.storeUri);

  if (allCommits.length === 0) {
    console.error(chalk.red('No git history found. Run git-index first.'));
    return;
  }

  console.log(chalk.dim(`Loaded ${allCommits.length} chunks from git history`));

  // Sort by date for temporal analysis (pre-parse dates to avoid repeated parsing in sort comparator)
  const dateCache = new Map<string, number>();
  for (const c of allCommits) {
    if (!dateCache.has(c.date)) dateCache.set(c.date, new Date(c.date).getTime());
  }
  allCommits.sort((a, b) => dateCache.get(a.date)! - dateCache.get(b.date)!);

  // Step 2: Run detector pipeline
  console.log(chalk.dim('Running signal detectors...'));
  const pipeline = new DetectorPipeline([
    new RevertDetector(),
    new ChurnDetector(),
    new OwnershipDetector(),
    new FixAfterFeatureDetector(),
    new AdoptionCycleDetector(),
    new StabilityShiftDetector(),
    new BreakingChangeDetector(),
  ]);

  const signals = pipeline.run(allCommits);
  console.log(chalk.dim(`Total signals detected: ${signals.length}`));

  // Step 3: Embed signal summaries
  if (signals.length > 0) {
    console.log(chalk.dim('Embedding signal summaries...'));
    const provider = createProvider(config);
    await provider.healthCheck();
    const dimension = await provider.probeDimension();

    const texts = signals.map(s => s.summary);
    const vectors = await provider.embedBatch(texts, {
      batchSize: 20,
      dimension,
      verbose,
      prefix: 'search_document: ',
    });

    // Step 4: Store signals
    console.log(chalk.dim('Storing signals...'));
    await initSignalsStore(config.storeUri);
    await initSignalsTable();
    await dropSignalsTable();
    await insertSignals(signals, vectors, true);
  }

  // Step 5: Compute and store file profiles
  console.log(chalk.dim('Computing file profiles...'));
  const profiles = computeFileProfiles(allCommits, signals);

  if (profiles.length > 0) {
    await initSignalsStore(config.storeUri);
    await initFileProfilesTable();
    await dropFileProfilesTable();
    await upsertFileProfiles(profiles, true);
  }

  // Step 6: Save state
  const state: AnalyzeState = {
    lastAnalyzedCommit: allCommits[allCommits.length - 1]?.sha || 'unknown',
    lastAnalyzedAt: new Date().toISOString(),
    totalSignals: signals.length,
    totalProfiles: profiles.length,
  };
  saveAnalyzeState(state);

  // Report results
  console.log('');
  console.log(chalk.green('Analysis complete'));
  console.log(`  Signals:  ${chalk.white(signals.length.toString())}`);
  console.log(`  Profiles: ${chalk.white(profiles.length.toString())}`);

  // Signal breakdown
  const counts: Record<string, number> = {};
  for (const s of signals) {
    counts[s.type] = (counts[s.type] || 0) + 1;
  }
  if (Object.keys(counts).length > 0) {
    console.log(chalk.dim('  Signal breakdown:'));
    for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(chalk.dim(`    ${type}: ${count}`));
    }
  }
}

export async function analyzeIncrementalPipeline(
  repoPath: string,
  config: CodeSearchConfig,
  verbose: boolean = false,
): Promise<void> {
  const state = loadAnalyzeState();

  if (!state) {
    console.log(chalk.yellow('No existing analysis state. Running full analysis...'));
    return analyzeFullPipeline(repoPath, config, verbose);
  }

  // For incremental, we still need all commits for windowed detectors
  // but we can skip full-history detectors (revert, fix-chain)
  console.log(chalk.blue(`Starting incremental analysis (since ${state.lastAnalyzedCommit.slice(0, 8)})...`));

  const allCommits = await loadAllGitHistory(config.storeUri);
  if (allCommits.length === 0) {
    console.log(chalk.green('No git history found.'));
    return;
  }

  const dateCache2 = new Map<string, number>();
  for (const c of allCommits) {
    if (!dateCache2.has(c.date)) dateCache2.set(c.date, new Date(c.date).getTime());
  }
  allCommits.sort((a, b) => dateCache2.get(a.date)! - dateCache2.get(b.date)!);

  // Run only windowed detectors on full set
  const pipeline = new DetectorPipeline([
    new ChurnDetector(),
    new OwnershipDetector(),
  ]);

  console.log(chalk.dim('Running windowed detectors...'));
  const signals = pipeline.run(allCommits);

  if (signals.length > 0) {
    const provider = createProvider(config);
    await provider.healthCheck();
    const dimension = await provider.probeDimension();

    const texts = signals.map(s => s.summary);
    const vectors = await provider.embedBatch(texts, {
      batchSize: 20,
      dimension,
      verbose,
      prefix: 'search_document: ',
    });

    await initSignalsStore(config.storeUri);
    await initSignalsTable();
    await replaceSignalsByType(['churn_hotspot', 'ownership'], signals, vectors);
  }

  const profiles = computeFileProfiles(allCommits, signals);
  if (profiles.length > 0) {
    await initSignalsStore(config.storeUri);
    await initFileProfilesTable();
    await upsertFileProfiles(profiles, true);
  }

  const newState: AnalyzeState = {
    lastAnalyzedCommit: allCommits[allCommits.length - 1]?.sha || state.lastAnalyzedCommit,
    lastAnalyzedAt: new Date().toISOString(),
    totalSignals: signals.length,
    totalProfiles: profiles.length,
  };
  saveAnalyzeState(newState);

  console.log(chalk.green(`Incremental analysis: ${signals.length} signals, ${profiles.length} profiles`));
}
