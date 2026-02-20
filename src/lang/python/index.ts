import type { LanguagePlugin } from '../plugin.js';
import type { CodeChunk } from '../../types.js';
import { initPythonParser } from './parser.js';
import { chunkFile } from './chunker.js';

export class PythonPlugin implements LanguagePlugin {
  name = 'python';

  extensions = new Set(['.py']);

  testPatterns = [
    /test_.*\.py$/,
    /.*_test\.py$/,
    /tests\//,
    /conftest\.py$/,
  ];

  async init(): Promise<void> {
    await initPythonParser();
  }

  chunkFile(filePath: string, content: string, repoRoot: string, maxTokens: number): CodeChunk[] {
    return chunkFile(filePath, content, repoRoot, maxTokens);
  }
}
