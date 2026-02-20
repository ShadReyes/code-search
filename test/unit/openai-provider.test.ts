import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { OpenAIProvider } from '../../src/embeddings/openai.js';

let server: http.Server;
let baseUrl: string;

function randomVector(dims: number): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];

      const data = inputs.map((_, index) => ({
        embedding: randomVector(1536),
        index,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data, usage: { prompt_tokens: 10, total_tokens: 10 } }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('bad addr')); return; }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(err => err ? rej(err) : res()));
});

function makeProvider() {
  return new OpenAIProvider({
    model: 'text-embedding-3-small',
    apiKey: 'sk-test-key',
    baseUrl,
  });
}

describe('OpenAIProvider', () => {
  it('healthCheck — mock server → resolves', async () => {
    const provider = makeProvider();
    await expect(provider.healthCheck()).resolves.toBeUndefined();
  });

  it('probeDimension → returns 1536', async () => {
    const provider = makeProvider();
    const dim = await provider.probeDimension();
    expect(dim).toBe(1536);
  });

  it('embedBatch — returns correct count', async () => {
    const provider = makeProvider();
    const vectors = await provider.embedBatch(
      ['hello', 'world', 'test'],
      { batchSize: 50, dimension: 1536 },
    );
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toHaveLength(1536);
  });

  it('embedSingle — returns a vector', async () => {
    const provider = makeProvider();
    const vec = await provider.embedSingle('test text');
    expect(vec).toHaveLength(1536);
    expect(typeof vec[0]).toBe('number');
  });

  it('embedSingle — prefix is silently ignored', async () => {
    const provider = makeProvider();
    const vec = await provider.embedSingle('test text', 'search_query: ');
    expect(vec).toHaveLength(1536);
  });

  it('supportsPrefixes = false', () => {
    const provider = makeProvider();
    expect(provider.supportsPrefixes).toBe(false);
  });

  it('name = openai', () => {
    const provider = makeProvider();
    expect(provider.name).toBe('openai');
  });

  it('constructor without apiKey → throws', () => {
    expect(() => new OpenAIProvider({
      model: 'text-embedding-3-small',
      baseUrl,
    })).toThrow('API key is required');
  });

  it('healthCheck — unreachable server → throws', async () => {
    const provider = new OpenAIProvider({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseUrl: 'http://127.0.0.1:1',
    });
    await expect(provider.healthCheck()).rejects.toThrow('health check failed');
  });
});
