import { describe, bench, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, discoverFiles, isTestFile } from '../../src/indexer.js';
import { DEFAULT_CONFIG } from '../../src/types.js';
import { generateScalingRepo, cleanupRepo } from '../helpers/scaling-repo-generator.js';

// ---------------------------------------------------------------------------
// loadConfig benchmarks
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  let bareDir: string;
  let configuredDir: string;

  beforeAll(() => {
    bareDir = mkdtempSync(join(tmpdir(), 'bench-cfg-bare-'));

    configuredDir = mkdtempSync(join(tmpdir(), 'bench-cfg-custom-'));
    writeFileSync(
      join(configuredDir, '.code-searchrc.json'),
      JSON.stringify({
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['node_modules/**', 'dist/**', 'coverage/**'],
        maxFileLines: 1500,
        indexTests: true,
        chunkMaxTokens: 4000,
      }),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(configuredDir, { recursive: true, force: true });
  });

  bench('loadConfig without .code-searchrc.json', () => {
    loadConfig(bareDir);
  });

  bench('loadConfig with .code-searchrc.json', () => {
    loadConfig(configuredDir);
  });
});

// ---------------------------------------------------------------------------
// discoverFiles benchmarks
// ---------------------------------------------------------------------------

describe('discoverFiles scaling', () => {
  let repo10: string;
  let repo100: string;
  let repo1000: string;

  beforeAll(async () => {
    [repo10, repo100, repo1000] = await Promise.all([
      generateScalingRepo(10),
      generateScalingRepo(100),
      generateScalingRepo(1000),
    ]);
  });

  afterAll(() => {
    cleanupRepo(repo10);
    cleanupRepo(repo100);
    cleanupRepo(repo1000);
  });

  bench('discoverFiles 10 files', () => {
    discoverFiles(repo10, DEFAULT_CONFIG);
  });

  bench('discoverFiles 100 files', () => {
    discoverFiles(repo100, DEFAULT_CONFIG);
  });

  bench('discoverFiles 1000 files', () => {
    discoverFiles(repo1000, DEFAULT_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// isTestFile benchmarks
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  bench('isTestFile positive match', () => {
    isTestFile('src/utils.test.ts');
  });

  bench('isTestFile negative match', () => {
    isTestFile('src/utils.ts');
  });
});
