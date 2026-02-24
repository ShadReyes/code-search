import chalk from 'chalk';
import type { EmbeddingProvider, EmbedBatchOptions } from './provider.js';
import { runWithConcurrency } from './provider.js';

const MAX_EMBED_CHARS = 8000;

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  return text.slice(0, MAX_EMBED_CHARS);
}

export class OllamaProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly supportsPrefixes = true;

  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { model: string; baseUrl?: string }) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl
      || process.env.OLLAMA_BASE_URL
      || process.env.OLLAMA_URL
      || 'http://localhost:11434';
  }

  async healthCheck(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot connect to Ollama at ${this.baseUrl}: ${reason}\n\n` +
        'To fix this:\n' +
        '  1. Install Ollama:   brew install ollama\n' +
        '  2. Start the server: ollama serve  (or: brew services start ollama)\n' +
        `  3. Pull the model:   ollama pull ${this.model}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Ollama returned HTTP ${response.status}.\n` +
        'The Ollama server may be starting up — wait a few seconds and retry.\n' +
        'If the problem persists, restart with: brew services restart ollama'
      );
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    const found = models.some(m => m.name === this.model || m.name.startsWith(`${this.model}:`));

    if (!found) {
      const available = models.map(m => m.name).join(', ') || '(none)';
      throw new Error(
        `Model "${this.model}" is not available in Ollama.\n\n` +
        `Available models: ${available}\n\n` +
        `To fix this:\n  ollama pull ${this.model}`
      );
    }
  }

  async probeDimension(): Promise<number> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: ['dimension probe'] }),
      });
    } catch (err) {
      throw new Error(
        `Failed to connect to Ollama for embedding probe: ${err instanceof Error ? err.message : err}\n` +
        'Ensure Ollama is running: ollama serve'
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to probe embedding dimension (HTTP ${response.status}).\n` +
        `Response: ${body}\n` +
        `Ensure model "${this.model}" supports embeddings.`
      );
    }

    const data = await response.json() as { embeddings: number[][] };
    if (!data.embeddings?.[0]?.length) {
      throw new Error(
        `Unexpected response from Ollama embed API — no embeddings returned.\n` +
        `Model "${this.model}" may not be an embedding model.`
      );
    }
    return data.embeddings[0].length;
  }

  async embedBatch(texts: string[], opts: EmbedBatchOptions): Promise<number[][]> {
    const batchSize = opts.batchSize ?? 50;
    const maxBatchChars = opts.maxBatchChars ?? 150_000;
    const dimension = opts.dimension ?? 768;
    const verbose = opts.verbose ?? false;
    const prefix = this.supportsPrefixes ? opts.prefix : undefined;
    const concurrency = opts.concurrency ?? 2;

    // Prepare all texts upfront (prefix + truncate)
    const prepared = texts.map(t => truncateForEmbedding(prefix ? prefix + t : t));

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

  async embedSingle(text: string, prefix?: string): Promise<number[]> {
    const prefixed = (this.supportsPrefixes && prefix) ? prefix + text : text;
    const truncated = truncateForEmbedding(prefixed);
    const [embedding] = await this.embedOneBatch([truncated]);
    return embedding;
  }

  private async embedOneBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
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
