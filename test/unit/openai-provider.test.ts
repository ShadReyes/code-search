import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

describe('OpenAIProvider — char-budget batching', () => {
  let batchServer: http.Server;
  let batchUrl: string;
  let apiCallCount: number;

  beforeAll(async () => {
    batchServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        apiCallCount++;
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
      batchServer.listen(0, '127.0.0.1', () => {
        const addr = batchServer.address();
        if (!addr || typeof addr === 'string') { reject(new Error('bad addr')); return; }
        batchUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
      batchServer.on('error', reject);
    });
  });

  afterAll(async () => {
    await new Promise<void>((res, rej) => batchServer.close(err => err ? rej(err) : res()));
  });

  beforeEach(() => { apiCallCount = 0; });

  it('maxBatchChars splits large texts into multiple API calls', async () => {
    const provider = new OpenAIProvider({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseUrl: batchUrl,
    });
    // 10 texts × 2000 chars each = 20000 total; maxBatchChars 5000 → ~5 batches of 2
    const texts = Array.from({ length: 10 }, () => 'x'.repeat(2000));
    const vectors = await provider.embedBatch(texts, {
      batchSize: 50,
      maxBatchChars: 5000,
      dimension: 1536,
    });
    expect(vectors).toHaveLength(10);
    vectors.forEach(v => expect(v).toHaveLength(1536));
    expect(apiCallCount).toBeGreaterThan(1);
  });

  it('small texts batch into a single API call', async () => {
    const provider = new OpenAIProvider({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseUrl: batchUrl,
    });
    const texts = Array.from({ length: 10 }, (_, i) => `short text ${i}`);
    const vectors = await provider.embedBatch(texts, {
      batchSize: 50,
      maxBatchChars: 300_000,
      dimension: 1536,
    });
    expect(vectors).toHaveLength(10);
    expect(apiCallCount).toBe(1);
  });
});

describe('OpenAIProvider — binary-split retry', () => {
  let limitServer: http.Server;
  let limitUrl: string;
  let rejectServer: http.Server;
  let rejectUrl: string;

  beforeAll(async () => {
    // Server that rejects batches with > 2 inputs, succeeds for ≤ 2
    limitServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];

        if (inputs.length > 2) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'batch too large' } }));
          return;
        }

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

    // Server that always returns 500
    rejectServer = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'always fail' } }));
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        limitServer.listen(0, '127.0.0.1', () => {
          const addr = limitServer.address();
          if (!addr || typeof addr === 'string') { reject(new Error('bad addr')); return; }
          limitUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
        limitServer.on('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        rejectServer.listen(0, '127.0.0.1', () => {
          const addr = rejectServer.address();
          if (!addr || typeof addr === 'string') { reject(new Error('bad addr')); return; }
          rejectUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
        rejectServer.on('error', reject);
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((res, rej) => limitServer.close(err => err ? rej(err) : res())),
      new Promise<void>((res, rej) => rejectServer.close(err => err ? rej(err) : res())),
    ]);
  });

  it('batch of 4 with max-2 server → succeeds via binary split', async () => {
    const provider = new OpenAIProvider({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseUrl: limitUrl,
    });
    const texts = ['text one', 'text two', 'text three', 'text four'];
    const vectors = await provider.embedBatch(texts, {
      batchSize: 50,
      dimension: 1536,
    });
    expect(vectors).toHaveLength(4);
    vectors.forEach(v => expect(v).toHaveLength(1536));
  });

  it('single text failure → progressive truncation → zero vector', async () => {
    const provider = new OpenAIProvider({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseUrl: rejectUrl,
    });
    const vectors = await provider.embedBatch(['will fail'], {
      batchSize: 50,
      dimension: 1536,
    });
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1536);
    expect(vectors[0].every(v => v === 0)).toBe(true);
  });

  it('fallbackCount tracked correctly in console message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const provider = new OpenAIProvider({
        model: 'text-embedding-3-small',
        apiKey: 'sk-test',
        baseUrl: rejectUrl,
      });
      const vectors = await provider.embedBatch(['a', 'b', 'c'], {
        batchSize: 50,
        dimension: 1536,
      });
      expect(vectors).toHaveLength(3);
      const calls = logSpy.mock.calls.map(args => String(args[0]));
      expect(calls.some(msg => msg.includes('3') && msg.includes('individual embedding'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
