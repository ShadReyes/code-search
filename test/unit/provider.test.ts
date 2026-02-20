import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProvider } from '../../src/embeddings/provider.js';
import { OllamaProvider } from '../../src/embeddings/ollama.js';
import { OpenAIProvider } from '../../src/embeddings/openai.js';
import { DEFAULT_CONFIG } from '../../src/types.js';

const origApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (origApiKey !== undefined) process.env.OPENAI_API_KEY = origApiKey;
  else delete process.env.OPENAI_API_KEY;
});

describe('createProvider', () => {
  it('default config → OllamaProvider', () => {
    const provider = createProvider({ ...DEFAULT_CONFIG });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
  });

  it('embeddingProvider: "ollama" → OllamaProvider', () => {
    const provider = createProvider({ ...DEFAULT_CONFIG, embeddingProvider: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('embeddingProvider: "openai" → OpenAIProvider', () => {
    const provider = createProvider({
      ...DEFAULT_CONFIG,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test',
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
  });

  it('unknown provider → throws', () => {
    expect(() => createProvider({
      ...DEFAULT_CONFIG,
      embeddingProvider: 'unknown' as 'ollama',
    })).toThrow('Unknown embedding provider');
  });

  it('OllamaProvider supportsPrefixes = true', () => {
    const provider = createProvider({ ...DEFAULT_CONFIG });
    expect(provider.supportsPrefixes).toBe(true);
  });

  it('OpenAIProvider supportsPrefixes = false', () => {
    const provider = createProvider({
      ...DEFAULT_CONFIG,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test',
    });
    expect(provider.supportsPrefixes).toBe(false);
  });

  it('OpenAI without API key → throws', () => {
    expect(() => createProvider({
      ...DEFAULT_CONFIG,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
    })).toThrow('API key is required');
  });
});
