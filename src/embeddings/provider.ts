import type { CodeSearchConfig } from '../types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';

export interface EmbedBatchOptions {
  batchSize?: number;
  dimension?: number;
  verbose?: boolean;
  prefix?: string;
  concurrency?: number;
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly supportsPrefixes: boolean;
  healthCheck(): Promise<void>;
  probeDimension(): Promise<number>;
  embedBatch(texts: string[], opts: EmbedBatchOptions): Promise<number[][]>;
  embedSingle(text: string, prefix?: string): Promise<number[]>;
}

export function createProvider(config: CodeSearchConfig): EmbeddingProvider {
  switch (config.embeddingProvider ?? 'ollama') {
    case 'ollama':
      return new OllamaProvider({
        model: config.embeddingModel,
        baseUrl: config.embeddingBaseUrl,
      });
    case 'openai':
      return new OpenAIProvider({
        model: config.embeddingModel,
        apiKey: config.embeddingApiKey,
        baseUrl: config.embeddingBaseUrl,
      });
    default:
      throw new Error(`Unknown embedding provider: ${config.embeddingProvider}`);
  }
}
