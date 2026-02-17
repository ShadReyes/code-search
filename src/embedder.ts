import type { CodeSearchConfig } from './types.js';

const OLLAMA_BASE_URL = 'http://localhost:11434';

export async function checkOllamaHealth(model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch {
    throw new Error(
      'Ollama is not running. Start with:\n' +
      '  ollama serve\n' +
      `Then pull the model:\n  ollama pull ${model}`
    );
  }

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}. Is Ollama running correctly?`);
  }

  const data = await response.json() as { models?: Array<{ name: string }> };
  const models = data.models || [];
  const found = models.some(m => m.name === model || m.name.startsWith(`${model}:`));

  if (!found) {
    throw new Error(
      `Model "${model}" not found in Ollama. Pull it with:\n  ollama pull ${model}\n` +
      `Available models: ${models.map(m => m.name).join(', ') || '(none)'}`
    );
  }
}

export async function probeEmbeddingDimension(model: string): Promise<number> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: ['test'] }),
  });

  if (!response.ok) {
    throw new Error(`Failed to probe embedding dimension: HTTP ${response.status}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings[0].length;
}

export async function embedBatch(
  texts: string[],
  model: string,
  batchSize: number = 50,
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed failed (HTTP ${response.status}): ${body}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    allEmbeddings.push(...data.embeddings);
  }

  return allEmbeddings;
}

export async function embedSingle(text: string, model: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], model, 1);
  return embedding;
}
