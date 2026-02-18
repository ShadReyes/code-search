import http from 'node:http';

/**
 * Simple string hash (djb2). Fast, non-crypto, deterministic.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // ensure unsigned 32-bit
}

/**
 * Mulberry32 PRNG — returns a function that produces floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a deterministic unit-length vector from a text string.
 * Uses a simple hash as PRNG seed, produces `dims` floats in [-1, 1],
 * then normalizes to unit length.
 */
export function generateDeterministicVector(
  text: string,
  dims: number = 768,
): number[] {
  const seed = hashString(text);
  const rng = mulberry32(seed);

  const vec = new Array<number>(dims);
  let sumSq = 0;

  for (let i = 0; i < dims; i++) {
    // Map [0,1) to [-1,1)
    const val = rng() * 2 - 1;
    vec[i] = val;
    sumSq += val * val;
  }

  // Normalize to unit length
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Read the full request body as a string.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start a mock Ollama HTTP server on a random available port.
 *
 * Supported endpoints:
 *   GET  /api/tags  — returns a model list containing nomic-embed-text
 *   POST /api/embed — returns deterministic 768-dim embeddings for each input text
 */
export async function startMockOllama(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/tags') {
        const payload = JSON.stringify({
          models: [{ name: 'nomic-embed-text:latest' }],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/embed') {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { input: string[] };
        const inputs = Array.isArray(parsed.input)
          ? parsed.input
          : [parsed.input];

        const embeddings = inputs.map((text: string) =>
          generateDeterministicVector(String(text)),
        );

        const payload = JSON.stringify({ embeddings });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}`;

      const close = (): Promise<void> =>
        new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });

      resolve({ url, close });
    });

    server.on('error', reject);
  });
}
