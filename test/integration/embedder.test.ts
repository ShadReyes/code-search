import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startMockOllama } from '../../bench/helpers/mock-ollama.js';

let mockServer: { url: string; close: () => Promise<void> };

// Must set env before importing embedder (OLLAMA_BASE_URL is read at module load)
beforeAll(async () => {
  mockServer = await startMockOllama();
  vi.stubEnv('OLLAMA_URL', mockServer.url);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await mockServer.close();
});

// Dynamic import so env var is set first
async function getEmbedder() {
  return await import('../../src/embedder.js');
}

describe('embedder with mock Ollama', () => {
  it('checkOllamaHealth — server running → resolves', async () => {
    const { checkOllamaHealth } = await getEmbedder();
    await expect(checkOllamaHealth('nomic-embed-text')).resolves.toBeUndefined();
  });

  it('checkOllamaHealth — model missing → throws', async () => {
    const { checkOllamaHealth } = await getEmbedder();
    await expect(checkOllamaHealth('nonexistent-model')).rejects.toThrow('not available');
  });

  it('probeEmbeddingDimension → returns 768', async () => {
    const { probeEmbeddingDimension } = await getEmbedder();
    const dim = await probeEmbeddingDimension('nomic-embed-text');
    expect(dim).toBe(768);
  });

  it('embedBatch — returns correct count of vectors', async () => {
    const { embedBatch } = await getEmbedder();
    const texts = ['hello world', 'foo bar', 'test input'];
    const vectors = await embedBatch(texts, 'nomic-embed-text', 50, 768);
    expect(vectors).toHaveLength(3);
  });

  it('embedBatch — vectors are 768-dim', async () => {
    const { embedBatch } = await getEmbedder();
    const texts = ['hello world'];
    const vectors = await embedBatch(texts, 'nomic-embed-text', 50, 768);
    expect(vectors[0]).toHaveLength(768);
  });

  it('embedSingle — returns a vector', async () => {
    const { embedSingle } = await getEmbedder();
    const vec = await embedSingle('test text', 'nomic-embed-text');
    expect(vec).toHaveLength(768);
    expect(typeof vec[0]).toBe('number');
  });
});

describe('embedder — server down', () => {
  it('checkOllamaHealth — server down → throws with setup instructions', async () => {
    // Use a port that's not listening
    vi.stubEnv('OLLAMA_URL', 'http://127.0.0.1:1');
    // Need fresh import to pick up new env
    const mod = await import('../../src/embedder.js?down');
    await expect(mod.checkOllamaHealth('nomic-embed-text')).rejects.toThrow(
      /Cannot connect to Ollama/,
    );
  });
});
