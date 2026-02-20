import type { LanguagePlugin } from '../plugin.js';
import type { CodeChunk } from '../../types.js';
import { initParser } from './parser.js';
import { chunkFile } from './chunker.js';

export class TypeScriptPlugin implements LanguagePlugin {
  name = 'typescript';

  extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']);

  testPatterns = [
    /\.(test|spec)\.(ts|tsx|js|jsx)$/,
    /__tests__\//,
    /__mocks__\//,
  ];

  async init(): Promise<void> {
    await initParser();
  }

  chunkFile(filePath: string, content: string, repoRoot: string, maxTokens: number): CodeChunk[] {
    return chunkFile(filePath, content, repoRoot, maxTokens);
  }
}
