import { describe, bench, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForBenchmark } from '../../src/parser.js';
import { loadFixture, getFixturePath } from '../helpers/fixture-loader.js';

describe('parser', () => {
  beforeAll(async () => {
    await initParser();
  });

  bench('initParser cold start', async () => {
    _resetForBenchmark();
    await initParser();
  });

  bench('parseFile small (~20 lines)', () => {
    const content = loadFixture('small-function.ts');
    parseFile(getFixturePath('small-function.ts'), content);
  });

  bench('parseFile medium (~150 lines)', () => {
    const content = loadFixture('medium-module.ts');
    parseFile(getFixturePath('medium-module.ts'), content);
  });

  bench('parseFile large (~500 lines)', () => {
    const content = loadFixture('large-class.ts');
    parseFile(getFixturePath('large-class.ts'), content);
  });

  bench('parseFile TSX (~200 lines)', () => {
    const content = loadFixture('complex-component.tsx');
    parseFile(getFixturePath('complex-component.tsx'), content);
  });
});
