import { describe, bench, beforeAll, afterAll } from 'vitest';
import { embedSingle, embedBatch } from '../../src/embedder.js';
import { startMockOllama } from '../helpers/mock-ollama.js';

const SHORT_TEXT = 'export function add(a: number, b: number): number { return a + b; }';

const LONG_TEXT = Array.from({ length: 200 }, (_, i) =>
  `// Line ${i}: This is a realistic code comment that pads the text to simulate a large chunk of source code being embedded.`
).join('\n');

function generateTexts(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `export function handler${i}(req: Request): Response {\n` +
    `  const data = parseInput(req.body);\n` +
    `  const result = processData(data, { index: ${i} });\n` +
    `  return new Response(JSON.stringify(result), { status: 200 });\n` +
    `}`
  );
}

const MODEL = 'nomic-embed-text';

describe('embedder', () => {
  let mockClose: () => Promise<void>;

  beforeAll(async () => {
    const mock = await startMockOllama();
    process.env.OLLAMA_URL = mock.url;
    mockClose = mock.close;
  });

  afterAll(async () => {
    await mockClose();
    delete process.env.OLLAMA_URL;
  });

  bench('embedSingle short text (~50 chars)', async () => {
    await embedSingle(SHORT_TEXT, MODEL);
  });

  bench('embedSingle long text (~10000 chars)', async () => {
    await embedSingle(LONG_TEXT, MODEL);
  });

  bench('embedBatch 10 texts', async () => {
    await embedBatch(generateTexts(10), MODEL);
  });

  bench('embedBatch 50 texts', async () => {
    await embedBatch(generateTexts(50), MODEL);
  });

  bench('embedBatch 200 texts', async () => {
    await embedBatch(generateTexts(200), MODEL);
  });
});
