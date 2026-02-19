import chalk from 'chalk';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function checkOllamaHealth(model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_BASE_URL}: ${reason}\n\n` +
      'To fix this:\n' +
      '  1. Install Ollama:   brew install ollama\n' +
      '  2. Start the server: ollama serve  (or: brew services start ollama)\n' +
      `  3. Pull the model:   ollama pull ${model}`
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
  const found = models.some(m => m.name === model || m.name.startsWith(`${model}:`));

  if (!found) {
    const available = models.map(m => m.name).join(', ') || '(none)';
    throw new Error(
      `Model "${model}" is not available in Ollama.\n\n` +
      `Available models: ${available}\n\n` +
      `To fix this:\n  ollama pull ${model}`
    );
  }
}

export async function probeEmbeddingDimension(model: string): Promise<number> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: ['dimension probe'] }),
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
      `Ensure model "${model}" supports embeddings.`
    );
  }

  const data = await response.json() as { embeddings: number[][] };
  if (!data.embeddings?.[0]?.length) {
    throw new Error(
      `Unexpected response from Ollama embed API — no embeddings returned.\n` +
      `Model "${model}" may not be an embedding model.`
    );
  }
  return data.embeddings[0].length;
}

// nomic-embed-text context is 8192 tokens
// Code is ~3-4 chars/token → 8000 chars is a safe limit
const MAX_EMBED_CHARS = 8000;

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  return text.slice(0, MAX_EMBED_CHARS);
}

async function embedOneBatch(texts: string[], model: string): Promise<number[][]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embed HTTP ${response.status}: ${body}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings;
}

async function embedSingleText(
  text: string,
  model: string,
  dimension: number,
  verbose: boolean,
): Promise<number[]> {
  // Try progressively shorter truncations
  for (const limit of [MAX_EMBED_CHARS, 4000, 2000, 500]) {
    try {
      const truncated = text.slice(0, limit);
      const [embedding] = await embedOneBatch([truncated], model);
      return embedding;
    } catch {
      if (verbose) {
        console.log(chalk.yellow(`  Retrying with ${limit > 500 ? 'shorter' : 'minimal'} truncation...`));
      }
      continue;
    }
  }
  // Last resort: zero vector (chunk will rank poorly but won't crash)
  if (verbose) {
    console.log(chalk.yellow('  Could not embed text — using zero vector'));
  }
  return new Array(dimension).fill(0);
}

export async function embedBatch(
  texts: string[],
  model: string,
  batchSize: number = 50,
  dimension: number = 768,
  verbose: boolean = false,
  prefix?: string,
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);
  let fallbackCount = 0;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batchEnd = Math.min(i + batchSize, texts.length);
    const batch = texts.slice(i, batchEnd)
      .map(t => prefix ? prefix + t : t)
      .map(truncateForEmbedding);

    process.stdout.write(
      `\r${chalk.dim(`Embedding batch ${batchNum}/${totalBatches} (chunks ${i + 1}-${batchEnd}/${texts.length})...`)}`
    );

    try {
      const embeddings = await embedOneBatch(batch, model);
      allEmbeddings.push(...embeddings);
    } catch (err) {
      // Batch failed — fall back to one-by-one embedding
      if (verbose) {
        console.log(chalk.yellow(
          `\n  Batch ${batchNum} failed: ${err instanceof Error ? err.message : err}`
        ));
        console.log(chalk.yellow('  Falling back to individual embedding...'));
      }
      for (const text of batch) {
        const embedding = await embedSingleText(text, model, dimension, verbose);
        allEmbeddings.push(embedding);
        fallbackCount++;
      }
    }
  }

  // Clear the progress line
  process.stdout.write('\r' + ' '.repeat(80) + '\r');

  if (fallbackCount > 0) {
    console.log(chalk.yellow(`${fallbackCount} chunks required individual embedding (batch too large)`));
  }

  return allEmbeddings;
}

export async function embedSingle(text: string, model: string, prefix?: string): Promise<number[]> {
  const prefixed = prefix ? prefix + text : text;
  const truncated = truncateForEmbedding(prefixed);
  const [embedding] = await embedOneBatch([truncated], model);
  return embedding;
}
