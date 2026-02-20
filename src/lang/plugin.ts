import type { CodeChunk } from '../types.js';

export interface LanguagePlugin {
  name: string;
  extensions: Set<string>;
  testPatterns: RegExp[];
  init(): Promise<void>;
  chunkFile(filePath: string, content: string, repoRoot: string, maxTokens: number): CodeChunk[];
}

export class PluginRegistry {
  private plugins: LanguagePlugin[] = [];

  register(plugin: LanguagePlugin): void {
    this.plugins.push(plugin);
  }

  getPluginForFile(filePath: string): LanguagePlugin | undefined {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    return this.plugins.find(p => p.extensions.has(ext));
  }

  isTestFile(relativePath: string): boolean {
    const ext = relativePath.slice(relativePath.lastIndexOf('.'));
    const plugin = this.plugins.find(p => p.extensions.has(ext));
    if (!plugin) return false;
    return plugin.testPatterns.some(re => re.test(relativePath));
  }

  async initAll(): Promise<void> {
    for (const p of this.plugins) {
      await p.init();
    }
  }
}

export const registry = new PluginRegistry();
