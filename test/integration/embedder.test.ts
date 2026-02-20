import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startMockOllama } from '../../bench/helpers/mock-ollama.js';

let mockServer: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  mockServer = await startMockOllama();
  vi.stubEnv('OLLAMA_URL', mockServer.url);
  vi.stubEnv('OLLAMA_BASE_URL', mockServer.url);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await mockServer.close();
});

async function getProvider() {
  const { OllamaProvider } = await import('../../src/embeddings/ollama.js');
  return new OllamaProvider({ model: 'nomic-embed-text', baseUrl: mockServer.url });
}

describe('OllamaProvider with mock Ollama', () => {
  it('healthCheck — server running → resolves', async () => {
    const provider = await getProvider();
    await expect(provider.healthCheck()).resolves.toBeUndefined();
  });

  it('healthCheck — model missing → throws', async () => {
    const { OllamaProvider } = await import('../../src/embeddings/ollama.js');
    const provider = new OllamaProvider({ model: 'nonexistent-model', baseUrl: mockServer.url });
    await expect(provider.healthCheck()).rejects.toThrow('not available');
  });

  it('probeDimension → returns 768', async () => {
    const provider = await getProvider();
    const dim = await provider.probeDimension();
    expect(dim).toBe(768);
  });

  it('embedBatch — returns correct count of vectors', async () => {
    const provider = await getProvider();
    const texts = ['hello world', 'foo bar', 'test input'];
    const vectors = await provider.embedBatch(texts, { batchSize: 50, dimension: 768 });
    expect(vectors).toHaveLength(3);
  });

  it('embedBatch — vectors are 768-dim', async () => {
    const provider = await getProvider();
    const texts = ['hello world'];
    const vectors = await provider.embedBatch(texts, { batchSize: 50, dimension: 768 });
    expect(vectors[0]).toHaveLength(768);
  });

  it('embedSingle — returns a vector', async () => {
    const provider = await getProvider();
    const vec = await provider.embedSingle('test text');
    expect(vec).toHaveLength(768);
    expect(typeof vec[0]).toBe('number');
  });

  it('embedSingle with prefix — returns a vector', async () => {
    const provider = await getProvider();
    const vec = await provider.embedSingle('test text', 'search_query: ');
    expect(vec).toHaveLength(768);
  });
});

describe('OllamaProvider — server down', () => {
  it('healthCheck — server down → throws with setup instructions', async () => {
    const { OllamaProvider } = await import('../../src/embeddings/ollama.js');
    const provider = new OllamaProvider({ model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:1' });
    await expect(provider.healthCheck()).rejects.toThrow(
      /Cannot connect to Ollama/,
    );
  });
});
