import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the bench/fixtures/ directory. */
export const FIXTURE_DIR = join(__dirname, '..', 'fixtures');

/** In-memory cache of fixture file contents, keyed by filename. */
const cache = new Map<string, string>();

/**
 * Load a single fixture file by name and cache its contents.
 * Throws if the file does not exist.
 *
 * @param name - Filename relative to bench/fixtures/ (e.g. "small-function.ts")
 * @returns The file contents as a UTF-8 string
 */
export function loadFixture(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const fullPath = join(FIXTURE_DIR, name);
  const content = readFileSync(fullPath, 'utf-8');
  cache.set(name, content);
  return content;
}

/**
 * Load all `.ts` and `.tsx` fixture files from bench/fixtures/.
 * Results are cached — subsequent calls return the same Map instance
 * (with any previously loaded entries intact).
 *
 * @returns A Map of filename to file contents
 */
export function loadAllFixtures(): Map<string, string> {
  const entries = readdirSync(FIXTURE_DIR);

  for (const entry of entries) {
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      if (!cache.has(entry)) {
        const fullPath = join(FIXTURE_DIR, entry);
        const content = readFileSync(fullPath, 'utf-8');
        cache.set(entry, content);
      }
    }
  }

  return new Map(cache);
}

/**
 * Get the absolute path to a fixture file.
 *
 * @param name - Filename relative to bench/fixtures/
 * @returns Absolute path to the fixture
 */
export function getFixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}
