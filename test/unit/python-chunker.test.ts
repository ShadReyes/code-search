import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPythonParser } from '../../src/lang/python/parser.js';
import { chunkFile } from '../../src/lang/python/chunker.js';

const FIXTURES = join(import.meta.dirname, '../../bench/fixtures');
const REPO_ROOT = join(import.meta.dirname, '../../bench/fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

beforeAll(async () => {
  await initPythonParser();
});

describe('Python chunkFile', () => {
  describe('small files', () => {
    it('small file (<50 lines) → single chunk', () => {
      const content = loadFixture('simple-function.py');
      const chunks = chunkFile(join(FIXTURES, 'simple-function.py'), content, REPO_ROOT);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].line_start).toBe(1);
      expect(chunks[0].language).toBe('python');
    });
  });

  describe('function extraction', () => {
    it('function_definition → function chunk', () => {
      const content = loadFixture('class-module.py');
      const chunks = chunkFile(join(FIXTURES, 'class-module.py'), content, REPO_ROOT);
      const funcChunks = chunks.filter(c => c.chunk_type === 'function');
      const names = funcChunks.map(c => c.name);
      expect(names).toContain('retry');
    });
  });

  describe('class extraction', () => {
    it('class_definition → class chunk', () => {
      const content = loadFixture('class-module.py');
      const chunks = chunkFile(join(FIXTURES, 'class-module.py'), content, REPO_ROOT);
      const classChunks = chunks.filter(c => c.chunk_type === 'class');
      const names = classChunks.map(c => c.name);
      expect(names).toContain('ConnectionPool');
      expect(names).toContain('QueryBuilder');
    });
  });

  describe('decorator handling', () => {
    it('decorated_definition → decorator chunk', () => {
      const content = loadFixture('class-module.py');
      const chunks = chunkFile(join(FIXTURES, 'class-module.py'), content, REPO_ROOT);
      const decoratorChunks = chunks.filter(c => c.chunk_type === 'decorator');
      const names = decoratorChunks.map(c => c.name);
      expect(names).toContain('Config');
    });
  });

  describe('content format', () => {
    it('content includes file comment and imports', () => {
      const content = loadFixture('class-module.py');
      const chunks = chunkFile(join(FIXTURES, 'class-module.py'), content, REPO_ROOT);
      for (const chunk of chunks) {
        expect(chunk.content).toContain('# file:');
      }
    });

    it('all chunks have language=python', () => {
      const content = loadFixture('class-module.py');
      const chunks = chunkFile(join(FIXTURES, 'class-module.py'), content, REPO_ROOT);
      for (const chunk of chunks) {
        expect(chunk.language).toBe('python');
      }
    });
  });
});
