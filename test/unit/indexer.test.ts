import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isTestFile, loadConfig, discoverFiles } from '../../src/indexer.js';
import { DEFAULT_CONFIG } from '../../src/types.js';

describe('isTestFile', () => {
  it('foo.test.ts → true', () => {
    expect(isTestFile('foo.test.ts')).toBe(true);
  });

  it('foo.spec.tsx → true', () => {
    expect(isTestFile('foo.spec.tsx')).toBe(true);
  });

  it('__tests__/foo.ts → true', () => {
    expect(isTestFile('__tests__/foo.ts')).toBe(true);
  });

  it('__mocks__/foo.ts → true', () => {
    expect(isTestFile('__mocks__/foo.ts')).toBe(true);
  });

  it('src/utils.ts → false', () => {
    expect(isTestFile('src/utils.ts')).toBe(false);
  });

  it('src/component.tsx → false', () => {
    expect(isTestFile('src/component.tsx')).toBe(false);
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'indexer-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no .code-searchrc.json → returns defaults', () => {
    const config = loadConfig(tmpDir);
    expect(config.include).toEqual(DEFAULT_CONFIG.include);
    expect(config.exclude).toEqual(DEFAULT_CONFIG.exclude);
    expect(config.maxFileLines).toBe(DEFAULT_CONFIG.maxFileLines);
    expect(config.embeddingModel).toBe('nomic-embed-text');
  });

  it('with .code-searchrc.json → merges overrides', () => {
    writeFileSync(
      join(tmpDir, '.code-searchrc.json'),
      JSON.stringify({ maxFileLines: 500, embeddingModel: 'custom-model' }),
    );
    const config = loadConfig(tmpDir);
    expect(config.maxFileLines).toBe(500);
    expect(config.embeddingModel).toBe('custom-model');
    // defaults preserved
    expect(config.include).toEqual(DEFAULT_CONFIG.include);
  });

  it('excludePatterns is additive', () => {
    writeFileSync(
      join(tmpDir, '.code-searchrc.json'),
      JSON.stringify({ excludePatterns: ['*.generated.ts'] }),
    );
    const config = loadConfig(tmpDir);
    expect(config.exclude).toEqual(
      expect.arrayContaining([...DEFAULT_CONFIG.exclude, '*.generated.ts']),
    );
  });
});

describe('discoverFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'discover-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string) {
    const absPath = join(tmpDir, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, content);
  }

  it('finds .ts files', () => {
    writeFile('src/index.ts', 'export const x = 1;');
    writeFile('src/utils.ts', 'export const y = 2;');
    const files = discoverFiles(tmpDir, { ...DEFAULT_CONFIG });
    expect(files).toHaveLength(2);
  });

  it('excludes node_modules', () => {
    writeFile('src/index.ts', 'export const x = 1;');
    writeFile('node_modules/pkg/index.ts', 'export const x = 1;');
    const files = discoverFiles(tmpDir, { ...DEFAULT_CONFIG });
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('src/index.ts');
  });

  it('skips test files by default (indexTests=false)', () => {
    writeFile('src/index.ts', 'export const x = 1;');
    writeFile('src/index.test.ts', 'test("x", () => {});');
    writeFile('__tests__/foo.ts', 'test("y", () => {});');
    const files = discoverFiles(tmpDir, { ...DEFAULT_CONFIG, indexTests: false });
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('src/index.ts');
  });

  it('includes test files when indexTests=true', () => {
    writeFile('src/index.ts', 'export const x = 1;');
    writeFile('src/index.test.ts', 'test("x", () => {});');
    const files = discoverFiles(tmpDir, { ...DEFAULT_CONFIG, indexTests: true });
    expect(files).toHaveLength(2);
  });

  it('skips oversized files (maxFileLines)', () => {
    writeFile('src/small.ts', 'const x = 1;\n');
    const bigContent = Array.from({ length: 3000 }, (_, i) => `const x${i} = ${i};`).join('\n');
    writeFile('src/big.ts', bigContent);
    const files = discoverFiles(tmpDir, { ...DEFAULT_CONFIG, maxFileLines: 2000 });
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('small.ts');
  });
});
