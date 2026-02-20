import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Tree, Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveWasmPath(pkg: string, subpath: string): string {
  const pkgEntry = require.resolve(pkg);
  return join(dirname(pkgEntry), subpath);
}

let pyLanguage: Language;
let initialized = false;

export async function initPythonParser(): Promise<void> {
  if (initialized) return;

  try {
    await Parser.init({
      locateFile: (scriptName: string) => {
        return resolveWasmPath('web-tree-sitter', scriptName);
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to initialize tree-sitter WASM runtime: ${err instanceof Error ? err.message : err}\n` +
      'Ensure web-tree-sitter@0.25.3 is installed.'
    );
  }

  try {
    const pyWasmPath = join(__dirname, 'grammars', 'tree-sitter-python.wasm');
    const pyWasmBytes = readFileSync(pyWasmPath);
    pyLanguage = await Language.load(pyWasmBytes);
  } catch (err) {
    throw new Error(
      `Failed to load Python WASM grammar: ${err instanceof Error ? err.message : err}\n` +
      'Ensure vendored .wasm file exists in src/lang/python/grammars/.'
    );
  }

  initialized = true;
}

export function parsePythonFile(content: string): Tree {
  if (!initialized) {
    throw new Error('Python parser not initialized. Call initPythonParser() first.');
  }

  const parser = new Parser();
  parser.setLanguage(pyLanguage);
  return parser.parse(content);
}

export type { Tree, Node };
