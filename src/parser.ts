import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Parser, Language, Tree, Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

function resolveWasmPath(pkg: string, subpath: string): string {
  // Resolve the package entry point, then navigate relative to its directory
  const pkgEntry = require.resolve(pkg);
  return join(dirname(pkgEntry), subpath);
}

let tsLanguage: Language;
let tsxLanguage: Language;
let initialized = false;

export async function initParser(): Promise<void> {
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
    const tsWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');
    const tsxWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm');
    const tsWasmBytes = readFileSync(tsWasmPath);
    const tsxWasmBytes = readFileSync(tsxWasmPath);
    tsLanguage = await Language.load(tsWasmBytes);
    tsxLanguage = await Language.load(tsxWasmBytes);
  } catch (err) {
    throw new Error(
      `Failed to load tree-sitter WASM grammars: ${err instanceof Error ? err.message : err}\n` +
      'Ensure tree-sitter-wasms@^0.1.13 is installed and compatible with web-tree-sitter@0.25.3.'
    );
  }

  initialized = true;
}

const TSX_EXTENSIONS = new Set(['.tsx', '.jsx']);
const TS_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.mts']);

export function parseFile(filePath: string, content: string): Tree {
  if (!initialized) {
    throw new Error('Parser not initialized. Call initParser() first.');
  }

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const parser = new Parser();

  if (TSX_EXTENSIONS.has(ext)) {
    parser.setLanguage(tsxLanguage);
  } else if (TS_EXTENSIONS.has(ext)) {
    parser.setLanguage(tsLanguage);
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }

  return parser.parse(content);
}

export function _resetForBenchmark(): void {
  initialized = false;
}

export type { Tree, Node };
