import chalk from 'chalk';
import type { EmbeddingProvider, EmbedBatchOptions } from './provider.js';
import { runWithConcurrency } from './provider.js';

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
    const maxBatchChars = opts.maxBatchChars ?? 300_000;
    const dimension = opts.dimension ?? 0;
    const verbose = opts.verbose ?? false;
    // prefix is silently ignored for OpenAI
    const concurrency = opts.concurrency ?? 3;

    // Prepare all texts upfront (truncate)
    const prepared = texts.map(truncateForEmbedding);

    // Build batches by both count AND character budget
    const batchTasks: Array<{ index: number; start: number; end: number; batch: string[] }> = [];
    let batchStart = 0;
    let currentChars = 0;
    let currentBatch: string[] = [];

    for (let i = 0; i < prepared.length; i++) {
      const textLen = prepared[i].length;
      if (currentBatch.length > 0 && (currentChars + textLen > maxBatchChars || currentBatch.length >= batchSize)) {
        batchTasks.push({ index: batchTasks.length, start: batchStart, end: i, batch: currentBatch });
        currentBatch = [];
        currentChars = 0;
        batchStart = i;
      }
      currentBatch.push(prepared[i]);
      currentChars += textLen;
    }
    if (currentBatch.length > 0) {
      batchTasks.push({ index: batchTasks.length, start: batchStart, end: prepared.length, batch: currentBatch });
    }

    const totalBatches = batchTasks.length;
    const allEmbeddings: number[][] = new Array(texts.length);
    let fallbackCount = 0;
    let completedBatches = 0;

    // Process with concurrency limiter
    const processBatch = async (task: typeof batchTasks[0]) => {
      const { start, batch } = task;
      const results = await this.embedBatchRecursive(batch, dimension, verbose);
      for (let j = 0; j < results.embeddings.length; j++) {
        allEmbeddings[start + j] = results.embeddings[j];
      }
      fallbackCount += results.fallbackCount;
      completedBatches++;
      process.stdout.write(
        `\r${chalk.dim(`Embedding batch ${completedBatches}/${totalBatches} (chunks ${task.end}/${texts.length})...`)}`
      );
    };

    const tasks = batchTasks.map(t => () => processBatch(t));
    await runWithConcurrency(tasks, concurrency);

    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    if (fallbackCount > 0) {
      console.log(chalk.yellow(`${fallbackCount} chunks required individual embedding (batch too large)`));
    }
    return allEmbeddings;
  }

  private async embedBatchRecursive(
    texts: string[],
    dimension: number,
    verbose: boolean,
  ): Promise<{ embeddings: number[][]; fallbackCount: number }> {
    try {
      const embeddings = await this.embedOneBatch(texts);
      return { embeddings, fallbackCount: 0 };
    } catch (err) {
      if (texts.length > 1) {
        // Binary split: retry each half
        if (verbose) {
          console.log(chalk.yellow(
            `\n  Batch of ${texts.length} failed, splitting in half...`
          ));
        }
        const mid = Math.ceil(texts.length / 2);
        const [left, right] = await Promise.all([
          this.embedBatchRecursive(texts.slice(0, mid), dimension, verbose),
          this.embedBatchRecursive(texts.slice(mid), dimension, verbose),
        ]);
        return {
          embeddings: [...left.embeddings, ...right.embeddings],
          fallbackCount: left.fallbackCount + right.fallbackCount,
        };
      }
      // Single text — progressive truncation
      if (verbose) {
        console.log(chalk.yellow(
          `\n  Single text failed: ${err instanceof Error ? err.message : err}`
        ));
      }
      const embedding = await this.embedSingleText(texts[0], dimension, verbose);
      return { embeddings: [embedding], fallbackCount: 1 };
    }
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
