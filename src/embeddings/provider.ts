import type { CodeSearchConfig } from '../types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';

export interface EmbedBatchOptions {
  batchSize?: number;
  dimension?: number;
  verbose?: boolean;
  prefix?: string;
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
