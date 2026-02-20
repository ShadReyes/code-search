import chalk from 'chalk';
import type { EmbeddingProvider, EmbedBatchOptions } from './provider.js';

const MAX_EMBED_CHARS = 8000;

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  return text.slice(0, MAX_EMBED_CHARS);
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly supportsPrefixes = false;

  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { model: string; apiKey?: string; baseUrl?: string }) {
    this.model = opts.model;
    this.apiKey = opts.apiKey
      || process.env.OPENAI_API_KEY
      || '';
    this.baseUrl = (opts.baseUrl
      || process.env.OPENAI_BASE_URL
      || 'https://api.openai.com').replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error(
        'OpenAI API key is required.\n\n' +
        'Provide it via:\n' +
        '  OPENAI_API_KEY=sk-... (env var)\n' +
        '  embeddingApiKey in .cortexrc.json'
      );
    }
  }

  async healthCheck(): Promise<void> {
    // Verify connectivity by making a minimal embedding request
    try {
      await this.embedOneBatch(['health check']);
    } catch (err) {
      throw new Error(
        `OpenAI API health check failed: ${err instanceof Error ? err.message : err}\n\n` +
        `Base URL: ${this.baseUrl}\n` +
        `Model: ${this.model}\n` +
        'Verify your API key and model name.'
      );
    }
  }

  async probeDimension(): Promise<number> {
    const embeddings = await this.embedOneBatch(['dimension probe']);
    return embeddings[0].length;
  }

  async embedBatch(texts: string[], opts: EmbedBatchOptions): Promise<number[][]> {
    const batchSize = opts.batchSize ?? 50;
    const dimension = opts.dimension ?? 0;
    const verbose = opts.verbose ?? false;
    // prefix is silently ignored for OpenAI

    const allEmbeddings: number[][] = [];
    const totalBatches = Math.ceil(texts.length / batchSize);
    let fallbackCount = 0;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batchEnd = Math.min(i + batchSize, texts.length);
      const batch = texts.slice(i, batchEnd).map(truncateForEmbedding);

      process.stdout.write(
        `\r${chalk.dim(`Embedding batch ${batchNum}/${totalBatches} (chunks ${i + 1}-${batchEnd}/${texts.length})...`)}`
      );

      try {
        const embeddings = await this.embedOneBatch(batch);
        allEmbeddings.push(...embeddings);
      } catch (err) {
        if (verbose) {
          console.log(chalk.yellow(
            `\n  Batch ${batchNum} failed: ${err instanceof Error ? err.message : err}`
          ));
          console.log(chalk.yellow('  Falling back to individual embedding...'));
        }
        for (const text of batch) {
          const embedding = await this.embedSingleText(text, dimension, verbose);
          allEmbeddings.push(embedding);
          fallbackCount++;
        }
      }
    }

    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    if (fallbackCount > 0) {
      console.log(chalk.yellow(`${fallbackCount} chunks required individual embedding (batch too large)`));
    }

    return allEmbeddings;
  }

  async embedSingle(text: string, _prefix?: string): Promise<number[]> {
    const truncated = truncateForEmbedding(text);
    const [embedding] = await this.embedOneBatch([truncated]);
    return embedding;
  }

  private async embedOneBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embeddings HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as OpenAIEmbeddingResponse;
    // OpenAI returns embeddings sorted by index
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  private async embedSingleText(
    text: string,
    dimension: number,
    verbose: boolean,
  ): Promise<number[]> {
    for (const limit of [MAX_EMBED_CHARS, 4000, 2000, 500]) {
      try {
        const truncated = text.slice(0, limit);
        const [embedding] = await this.embedOneBatch([truncated]);
        return embedding;
      } catch {
        if (verbose) {
          console.log(chalk.yellow(`  Retrying with ${limit > 500 ? 'shorter' : 'minimal'} truncation...`));
        }
        continue;
      }
    }
    if (verbose) {
      console.log(chalk.yellow('  Could not embed text — using zero vector'));
    }
    return new Array(dimension).fill(0);
  }
}
