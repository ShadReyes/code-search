import { describe, bench, beforeAll } from 'vitest';
import { initParser } from '../../src/parser.js';
import { chunkFile } from '../../src/chunker.js';
import { loadFixture, getFixturePath, FIXTURE_DIR } from '../helpers/fixture-loader.js';

const FIXTURES = [
  'small-function.ts',
  'medium-module.ts',
  'large-class.ts',
  'complex-component.tsx',
  'nextjs-page.tsx',
  'nextjs-api-route.ts',
  'heavy-imports.ts',
] as const;

describe('chunker', () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const name of FIXTURES) {
    bench(`chunkFile ${name}`, () => {
      const content = loadFixture(name);
      chunkFile(getFixturePath(name), content, FIXTURE_DIR);
    });
  }
});
