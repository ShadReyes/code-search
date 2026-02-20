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

let rubyLanguage: Language;
let initialized = false;

export async function initRubyParser(): Promise<void> {
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
    const rubyWasmPath = join(__dirname, 'grammars', 'tree-sitter-ruby.wasm');
    const rubyWasmBytes = readFileSync(rubyWasmPath);
    rubyLanguage = await Language.load(rubyWasmBytes);
  } catch (err) {
    throw new Error(
      `Failed to load Ruby WASM grammar: ${err instanceof Error ? err.message : err}\n` +
      'Ensure vendored .wasm file exists in src/lang/ruby/grammars/.'
    );
  }

  initialized = true;
}

export function parseRubyFile(content: string): Tree {
  if (!initialized) {
    throw new Error('Ruby parser not initialized. Call initRubyParser() first.');
  }

  const parser = new Parser();
  parser.setLanguage(rubyLanguage);
  return parser.parse(content);
}

export type { Tree, Node };
