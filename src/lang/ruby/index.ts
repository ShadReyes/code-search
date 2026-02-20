import type { LanguagePlugin } from '../plugin.js';
import type { CodeChunk } from '../../types.js';
import { initRubyParser } from './parser.js';
import { chunkFile } from './chunker.js';

export class RubyPlugin implements LanguagePlugin {
  name = 'ruby';

  extensions = new Set(['.rb', '.rake']);

  testPatterns = [
    /spec\/.*_spec\.rb$/,
    /_spec\.rb$/,
    /test\/.*_test\.rb$/,
    /_test\.rb$/,
  ];

  async init(): Promise<void> {
    await initRubyParser();
  }

  chunkFile(filePath: string, content: string, repoRoot: string, maxTokens: number): CodeChunk[] {
    return chunkFile(filePath, content, repoRoot, maxTokens);
  }
}
