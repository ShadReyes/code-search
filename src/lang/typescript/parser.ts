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

let tsLanguage: Language;
let tsxLanguage: Language;
let tsParser: Parser;
let tsxParser: Parser;
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
    const tsWasmPath = join(__dirname, 'grammars', 'tree-sitter-typescript.wasm');
    const tsxWasmPath = join(__dirname, 'grammars', 'tree-sitter-tsx.wasm');
    const tsWasmBytes = readFileSync(tsWasmPath);
    const tsxWasmBytes = readFileSync(tsxWasmPath);
    tsLanguage = await Language.load(tsWasmBytes);
    tsxLanguage = await Language.load(tsxWasmBytes);

    tsParser = new Parser();
    tsParser.setLanguage(tsLanguage);
    tsxParser = new Parser();
    tsxParser.setLanguage(tsxLanguage);
  } catch (err) {
    throw new Error(
      `Failed to load tree-sitter WASM grammars: ${err instanceof Error ? err.message : err}\n` +
      'Ensure vendored .wasm files exist in src/lang/typescript/grammars/.'
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

  if (TSX_EXTENSIONS.has(ext)) {
    return tsxParser.parse(content);
  } else if (TS_EXTENSIONS.has(ext)) {
    return tsParser.parse(content);
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
}

export function _resetForBenchmark(): void {
  initialized = false;
  tsParser = undefined as unknown as Parser;
  tsxParser = undefined as unknown as Parser;
}

export type { Tree, Node };
