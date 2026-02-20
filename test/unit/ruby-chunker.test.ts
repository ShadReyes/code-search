import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initRubyParser } from '../../src/lang/ruby/parser.js';
import { chunkFile } from '../../src/lang/ruby/chunker.js';
import { RubyPlugin } from '../../src/lang/ruby/index.js';

const FIXTURES = join(import.meta.dirname, '../../bench/fixtures');
const REPO_ROOT = join(import.meta.dirname, '../../bench/fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

beforeAll(async () => {
  await initRubyParser();
});

describe('Ruby chunkFile', () => {
  describe('small files', () => {
    it('small file (<50 lines) → single chunk', () => {
      const content = loadFixture('simple-service.rb');
      const chunks = chunkFile(join(FIXTURES, 'simple-service.rb'), content, REPO_ROOT);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk_type).toBe('other');
      expect(chunks[0].line_start).toBe(1);
      expect(chunks[0].language).toBe('ruby');
    });
  });

  describe('class extraction', () => {
    it('class → class chunk', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      const classChunks = chunks.filter(c => c.chunk_type === 'class');
      const names = classChunks.map(c => c.name);
      expect(names).toContain('User');
    });
  });

  describe('module extraction', () => {
    it('module → class chunk', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      const classChunks = chunks.filter(c => c.chunk_type === 'class');
      const names = classChunks.map(c => c.name);
      expect(names).toContain('Authenticatable');
    });
  });

  describe('method extraction', () => {
    it('method → function chunk (root-level only)', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      // Only root-level methods are extracted; methods inside class/module are part of their parent chunk
      const funcChunks = chunks.filter(c => c.chunk_type === 'function');
      // The singleton_method `self.create_default_admin` is at root level
      expect(funcChunks.length).toBeGreaterThanOrEqual(1);
    });

    it('singleton_method → function chunk', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      const funcChunks = chunks.filter(c => c.chunk_type === 'function');
      const names = funcChunks.map(c => c.name);
      expect(names).toContain('create_default_admin');
    });
  });

  describe('content format', () => {
    it('content includes # file: header', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      for (const chunk of chunks) {
        expect(chunk.content).toContain('# file:');
      }
    });

    it('all chunks have language=ruby', () => {
      const content = loadFixture('rails-model.rb');
      const chunks = chunkFile(join(FIXTURES, 'rails-model.rb'), content, REPO_ROOT);
      for (const chunk of chunks) {
        expect(chunk.language).toBe('ruby');
      }
    });
  });

  describe('plugin', () => {
    it('.rake extension matched by plugin', () => {
      const plugin = new RubyPlugin();
      expect(plugin.extensions.has('.rb')).toBe(true);
      expect(plugin.extensions.has('.rake')).toBe(true);
    });
  });
});
