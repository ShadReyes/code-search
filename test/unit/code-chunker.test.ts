import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initParser } from '../../src/lang/typescript/parser.js';
import { chunkFile } from '../../src/lang/typescript/chunker.js';

const FIXTURES = join(import.meta.dirname, '../../bench/fixtures');
const REPO_ROOT = join(import.meta.dirname, '../../bench/fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

beforeAll(async () => {
  await initParser();
});

describe('chunkFile', () => {
  describe('small files', () => {
    it('small file (<50 lines) → single chunk', () => {
      const content = loadFixture('small-function.ts');
      const chunks = chunkFile(join(FIXTURES, 'small-function.ts'), content, REPO_ROOT);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].line_start).toBe(1);
    });
  });

  describe('function detection', () => {
    it('function declaration → function chunk', () => {
      const content = loadFixture('medium-module.ts');
      const chunks = chunkFile(join(FIXTURES, 'medium-module.ts'), content, REPO_ROOT);
      const funcChunks = chunks.filter(c => c.chunk_type === 'function');
      expect(funcChunks.length).toBeGreaterThan(0);
      const names = funcChunks.map(c => c.name);
      expect(names).toContain('paginate');
    });

    it('arrow function → function chunk', () => {
      const content = loadFixture('medium-module.ts');
      const chunks = chunkFile(join(FIXTURES, 'medium-module.ts'), content, REPO_ROOT);
      // sortBy is an arrow function
      const funcNames = chunks.filter(c => c.chunk_type === 'function').map(c => c.name);
      expect(funcNames).toContain('sortBy');
    });
  });

  describe('class detection', () => {
    it('class declaration → class chunk', () => {
      const content = loadFixture('large-class.ts');
      const chunks = chunkFile(join(FIXTURES, 'large-class.ts'), content, REPO_ROOT);
      const classChunks = chunks.filter(c => c.chunk_type === 'class');
      expect(classChunks.length).toBeGreaterThan(0);
      expect(classChunks[0].name).toBe('EventEmitter');
    });
  });

  describe('interface and type detection', () => {
    it('interface → interface chunk', () => {
      const content = loadFixture('complex-component.tsx');
      const chunks = chunkFile(join(FIXTURES, 'complex-component.tsx'), content, REPO_ROOT);
      const ifaces = chunks.filter(c => c.chunk_type === 'interface');
      const names = ifaces.map(c => c.name);
      expect(names).toContain('DataTableProps');
    });

    it('type alias → type chunk', () => {
      const content = loadFixture('large-class.ts');
      const chunks = chunkFile(join(FIXTURES, 'large-class.ts'), content, REPO_ROOT);
      const typeChunks = chunks.filter(c => c.chunk_type === 'type');
      const names = typeChunks.map(c => c.name);
      expect(names).toContain('EventHandler');
    });
  });

  describe('export detection', () => {
    it('exported function → exported=true', () => {
      const content = loadFixture('medium-module.ts');
      const chunks = chunkFile(join(FIXTURES, 'medium-module.ts'), content, REPO_ROOT);
      const paginate = chunks.find(c => c.name === 'paginate');
      expect(paginate).toBeDefined();
      expect(paginate!.exported).toBe(true);
    });
  });

  describe('React component detection', () => {
    it('PascalCase function with JSX → component chunk', () => {
      const content = loadFixture('complex-component.tsx');
      const chunks = chunkFile(join(FIXTURES, 'complex-component.tsx'), content, REPO_ROOT);
      const components = chunks.filter(c => c.chunk_type === 'component');
      const names = components.map(c => c.name);
      expect(names).toContain('DataTable');
    });
  });

  describe('hook detection', () => {
    it('useXxx function → hook chunk', () => {
      const content = loadFixture('complex-component.tsx');
      const chunks = chunkFile(join(FIXTURES, 'complex-component.tsx'), content, REPO_ROOT);
      const hooks = chunks.filter(c => c.chunk_type === 'hook');
      const names = hooks.map(c => c.name);
      expect(names).toContain('useFormState');
    });
  });

  describe('API route detection', () => {
    it('GET/POST → route chunks with api_route framework_role', () => {
      // Simulate api route path: needs "api" in path and file named "route.ts"
      const content = loadFixture('nextjs-api-route.ts');
      const fakePath = join(REPO_ROOT, 'app/api/items/route.ts');
      const chunks = chunkFile(fakePath, content, REPO_ROOT);
      const routes = chunks.filter(c => c.chunk_type === 'route');
      const names = routes.map(c => c.name);
      expect(names).toContain('GET');
      expect(names).toContain('POST');
      expect(routes[0].framework_role).toBe('api_route');
    });
  });

  describe('NextJS page detection', () => {
    it('page file → single page chunk', () => {
      const content = loadFixture('nextjs-page.tsx');
      const fakePath = join(REPO_ROOT, 'app/dashboard/page.tsx');
      const chunks = chunkFile(fakePath, content, REPO_ROOT);
      // Page files get special treatment — single chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0].framework_role).toBe('page');
    });
  });

  describe('config file detection', () => {
    it('next.config.ts → config chunk', () => {
      const content = loadFixture('config-file.ts');
      const fakePath = join(REPO_ROOT, 'next.config.ts');
      const chunks = chunkFile(fakePath, content, REPO_ROOT);
      // Config file is small (<50 lines) so single chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk_type).toBe('config');
      expect(chunks[0].framework_role).toBe('config');
    });
  });

  describe('content format', () => {
    it('content includes file comment and imports', () => {
      const content = loadFixture('medium-module.ts');
      const chunks = chunkFile(join(FIXTURES, 'medium-module.ts'), content, REPO_ROOT);
      // All chunks should have the file comment header
      for (const chunk of chunks) {
        expect(chunk.content).toContain('// file:');
      }
    });

    it('large chunk → truncated', () => {
      const content = loadFixture('heavy-imports.ts');
      const chunks = chunkFile(
        join(FIXTURES, 'heavy-imports.ts'),
        content,
        REPO_ROOT,
        200, // very low maxTokens to force truncation
      );
      const truncated = chunks.filter(c => c.content.includes('truncated'));
      expect(truncated.length).toBeGreaterThan(0);
    });
  });
});
