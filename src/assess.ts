import { dirname } from 'node:path';
import chalk from 'chalk';
import type { CodeSearchConfig } from './types.js';
import type { AssessmentResult, Warning, FileProfile, SignalRecord } from './signals/types.js';
import { initStore, initGitHistoryTable, searchGitHistory, search } from './store.js';
import {
  initSignalsStore,
  initSignalsTable,
  initFileProfilesTable,
  getFileProfile,
  getDirectoryProfiles,
  getSignalsByDirectory,
  searchSignals,
} from './signals/store.js';
import { createProvider } from './embeddings/provider.js';
import { synthesizeWarnings } from './signals/synthesizer.js';

export interface AssessOptions {
  changeType?: string;
  query?: string;
  verbose?: boolean;
  format?: 'text' | 'json';
}

export async function assess(
  files: string[],
  repoPath: string,
  config: CodeSearchConfig,
  options?: AssessOptions,
): Promise<AssessmentResult> {
  const verbose = options?.verbose ?? false;

  // Initialize stores
  await initStore(config.storeUri);
  await initGitHistoryTable();
  await initSignalsStore(config.storeUri);
  await initSignalsTable();
  await initFileProfilesTable();

  // Step 1: Direct lookup - FileProfiles
  if (verbose) console.log(chalk.dim('Looking up file profiles...'));
  const fileProfiles: FileProfile[] = [];

  for (const file of files) {
    const profile = await getFileProfile(file);
    if (profile) {
      fileProfiles.push(profile);
    }

    // Also check parent directory
    const dir = dirname(file);
    if (dir !== '.') {
      const dirProfiles = await getDirectoryProfiles(dir);
      for (const dp of dirProfiles) {
        if (!fileProfiles.some(fp => fp.path === dp.path)) {
          fileProfiles.push(dp);
        }
      }
    }
  }

  // Step 2: Signal retrieval
  if (verbose) console.log(chalk.dim('Retrieving signals...'));
  const signals: SignalRecord[] = [];
  const seenSignalIds = new Set<string>();

  // Get signals by directory scope
  const dirs = new Set(files.map(f => {
    const d = dirname(f);
    return d === '.' ? '.' : d;
  }));

  for (const dir of dirs) {
    const dirSignals = await getSignalsByDirectory(dir);
    for (const s of dirSignals) {
      if (!seenSignalIds.has(s.id)) {
        seenSignalIds.add(s.id);
        signals.push(s);
      }
    }
  }

  // If query provided, also vector search on signals
  if (options?.query) {
    try {
      const provider = createProvider(config);
      const queryVector = await provider.embedSingle(options.query, 'search_query: ');
      const vectorSignals = await searchSignals(queryVector, 10);
      for (const { signal } of vectorSignals) {
        if (!seenSignalIds.has(signal.id)) {
          seenSignalIds.add(signal.id);
          signals.push(signal);
        }
      }
    } catch {
      if (verbose) console.log(chalk.dim('Signal vector search unavailable'));
    }
  }

  // Step 3: Warning synthesis
  if (verbose) console.log(chalk.dim('Synthesizing warnings...'));
  const warnings = synthesizeWarnings(fileProfiles, signals, options?.changeType);

  // Collect unique owners from profiles
  const ownerMap = new Map<string, { author: string; percentage: number; last_change: string }>();
  for (const profile of fileProfiles) {
    if (profile.primary_owner) {
      const key = `${profile.primary_owner.author}:${profile.path}`;
      if (!ownerMap.has(key)) {
        ownerMap.set(key, {
          author: profile.primary_owner.author,
          percentage: profile.primary_owner.percentage,
          last_change: profile.primary_owner.last_change,
        });
      }
    }
  }

  return {
    warnings,
    file_profiles: fileProfiles,
    signals,
    owners: [...ownerMap.values()].sort((a, b) => b.percentage - a.percentage),
  };
}

export function formatAssessResult(result: AssessmentResult): string {
  const lines: string[] = [];

  if (result.warnings.length === 0) {
    lines.push(chalk.green('No warnings detected for these files.'));
  } else {
    lines.push(chalk.bold(`${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''} detected`));
    lines.push('');

    for (const w of result.warnings) {
      const icon = w.severity === 'warning' ? chalk.red('WARNING')
        : w.severity === 'caution' ? chalk.yellow('CAUTION')
        : chalk.blue('INFO');

      lines.push(`${icon} [${w.category}] ${w.message}`);
      if (w.evidence.length > 0) {
        lines.push(chalk.dim(`  Evidence: ${w.evidence.map(s => s.slice(0, 7)).join(', ')}`));
      }
    }
  }

  if (result.owners.length > 0) {
    lines.push('');
    lines.push(chalk.dim('Owners:'));
    for (const o of result.owners) {
      lines.push(chalk.dim(`  ${o.author} (${o.percentage}%, last: ${o.last_change.slice(0, 10)})`));
    }
  }

  if (result.file_profiles.length > 0) {
    lines.push('');
    lines.push(chalk.dim('File profiles:'));
    for (const p of result.file_profiles) {
      lines.push(chalk.dim(
        `  ${p.path}: stability=${p.stability_score}/100, risk=${p.risk_score}/100, changes=${p.total_changes}, freq=${p.change_frequency}`
      ));
    }
  }

  return lines.join('\n');
}
