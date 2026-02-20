import { describe, it, expect } from 'vitest';
import { classifyQuery } from '../../src/git/search.js';

describe('classifyQuery', () => {
  // --- pickaxe ---
  it('"when was X introduced" → pickaxe', () => {
    const result = classifyQuery('when was useAuth introduced');
    expect(result.strategy).toBe('pickaxe');
    expect(result.extractedParams.searchString).toBe('useAuth');
  });

  it('"when was X removed" → pickaxe', () => {
    const result = classifyQuery('when was legacyLogin removed');
    expect(result.strategy).toBe('pickaxe');
    expect(result.extractedParams.searchString).toBe('legacyLogin');
  });

  it('"when was X added" → pickaxe', () => {
    const result = classifyQuery('when was the helper function added');
    expect(result.strategy).toBe('pickaxe');
    expect(result.extractedParams.searchString).toBe('the helper function');
  });

  it('"first introduced X" → pickaxe', () => {
    const result = classifyQuery('first introduced validateEmail');
    expect(result.strategy).toBe('pickaxe');
    expect(result.extractedParams.searchString).toBe('validateEmail');
  });

  // --- blame ---
  it('"who wrote file.ts" → blame', () => {
    const result = classifyQuery('who wrote auth.ts');
    expect(result.strategy).toBe('blame');
    expect(result.extractedParams.file).toBe('auth.ts');
  });

  it('"blame for util.js line 42" → blame with line', () => {
    const result = classifyQuery('blame for util.js line 42');
    expect(result.strategy).toBe('blame');
    expect(result.extractedParams.file).toBe('util.js');
    expect(result.extractedParams.line).toBe('42');
  });

  // --- temporal_vector ---
  it('"changes last month" → temporal_vector', () => {
    const result = classifyQuery('changes last month');
    expect(result.strategy).toBe('temporal_vector');
    expect(result.extractedParams.after).toBeDefined();
  });

  it('"recently" → temporal_vector with ~30 day window', () => {
    const result = classifyQuery('what happened recently');
    expect(result.strategy).toBe('temporal_vector');
    expect(result.extractedParams.after).toBeDefined();
    // Should be roughly 30 days ago
    const afterDate = new Date(result.extractedParams.after);
    const now = new Date();
    const diffDays = (now.getTime() - afterDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  it('"in 2024" → temporal_vector with year', () => {
    const result = classifyQuery('changes in 2024');
    expect(result.strategy).toBe('temporal_vector');
    expect(result.extractedParams.after).toBe('2024-01-01');
  });

  // --- structured_git ---
  it('"what changed in store.ts" → structured_git', () => {
    const result = classifyQuery('what changed in store.ts');
    expect(result.strategy).toBe('structured_git');
    expect(result.extractedParams.file).toBe('store.ts');
  });

  it('"commits by alice" → structured_git', () => {
    const result = classifyQuery('commits by alice');
    expect(result.strategy).toBe('structured_git');
    expect(result.extractedParams.author).toBe('alice');
  });

  // --- vector (default fallback) ---
  it('"authentication middleware" → vector', () => {
    const result = classifyQuery('authentication middleware');
    expect(result.strategy).toBe('vector');
    expect(result.extractedParams).toEqual({});
  });
});
