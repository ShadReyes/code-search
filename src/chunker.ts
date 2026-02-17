import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, basename } from 'node:path';
import { parseFile, type Node } from './parser.js';
import type { CodeChunk } from './types.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const NEXTJS_CONFIG_FILES = new Set([
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'tailwind.config.js', 'tailwind.config.ts',
  'postcss.config.js', 'postcss.config.mjs',
]);

function chunkId(filePath: string, lineStart: number, lineEnd: number): string {
  return createHash('sha256')
    .update(`${filePath}:${lineStart}:${lineEnd}`)
    .digest('hex')
    .slice(0, 16);
}

function detectPackageName(filePath: string): string {
  let dir = dirname(filePath);
  while (dir !== '/' && dir !== '.') {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.name || 'unknown';
      } catch {
        return 'unknown';
      }
    }
    dir = dirname(dir);
  }
  return 'root';
}

function getImportLines(content: string, max: number = 10): string[] {
  const lines = content.split('\n');
  const imports: string[] = [];
  for (const line of lines) {
    if (imports.length >= max) break;
    if (line.startsWith('import ') || line.startsWith('import{')) {
      imports.push(line);
    }
  }
  return imports;
}

function buildChunkContent(relativePath: string, imports: string[], code: string): string {
  const parts = [`// file: ${relativePath}`];
  if (imports.length > 0) {
    parts.push(imports.join('\n'));
    parts.push('');
  }
  parts.push(code);
  return parts.join('\n');
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function nodeContainsJSX(node: Node): boolean {
  if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element' || node.type === 'jsx_fragment') {
    return true;
  }
  for (const child of node.children) {
    if (nodeContainsJSX(child)) return true;
  }
  return false;
}

function isArrowFunction(node: Node): boolean {
  return node.type === 'arrow_function';
}

function isFunctionExpression(node: Node): boolean {
  return node.type === 'function' || node.type === 'function_expression';
}

function getDeclaratorInfo(node: Node): { name: string; valueNode: Node | null } | null {
  const nameNode = node.childForFieldName('name');
  const valueNode = node.childForFieldName('value');
  if (!nameNode) return null;
  return { name: nameNode.text, valueNode };
}

type ChunkType = CodeChunk['chunk_type'];

function determineChunkType(
  name: string,
  nodeType: string,
  valueNode: Node | null,
  filePath: string,
): ChunkType {
  if (nodeType === 'interface_declaration') return 'interface';
  if (nodeType === 'type_alias_declaration') return 'type';
  if (nodeType === 'class_declaration' || nodeType === 'abstract_class_declaration') return 'class';

  // Route handler detection
  if (HTTP_METHODS.has(name)) return 'route';

  // Hook detection
  if (name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase()) return 'hook';

  // Component detection
  if (isPascalCase(name) && valueNode) {
    if (isArrowFunction(valueNode) || isFunctionExpression(valueNode)) {
      if (nodeContainsJSX(valueNode)) return 'component';
    }
  }
  if (isPascalCase(name) && nodeType === 'function_declaration') {
    // Check function body for JSX
    const body = valueNode || node_body_fallback(name);
    return 'component'; // PascalCase functions are typically components in Next.js
  }

  // Config detection
  if (isConfigFile(filePath)) return 'config';

  if (nodeType === 'function_declaration' || nodeType === 'arrow_function' || nodeType === 'function_expression') {
    return 'function';
  }

  return 'function';
}

// Placeholder — not used in flow, but keeps type checker happy
function node_body_fallback(_name: string): null {
  return null;
}

function isConfigFile(filePath: string): boolean {
  return NEXTJS_CONFIG_FILES.has(basename(filePath));
}

function getFrameworkRole(
  relativePath: string,
): CodeChunk['framework_role'] | undefined {
  const parts = relativePath.split('/');
  const fileName = parts[parts.length - 1];
  const nameNoExt = fileName.replace(/\.(tsx?|jsx?|mts|mjs)$/, '');

  if (nameNoExt === 'page') return 'page';
  if (nameNoExt === 'layout') return 'layout';
  if (nameNoExt === 'middleware') return 'middleware';
  if (nameNoExt === 'route' && relativePath.includes('api')) return 'api_route';
  if (isConfigFile(fileName)) return 'config';
  return undefined;
}

function deriveRoutePath(relativePath: string): string {
  // e.g. app/dashboard/settings/page.tsx → /dashboard/settings
  const parts = relativePath.split('/');
  const appIdx = parts.indexOf('app');
  if (appIdx === -1) return '/' + parts.slice(0, -1).join('/');
  const routeParts = parts.slice(appIdx + 1, -1); // exclude 'app' and filename
  // Strip route groups (parenthesized)
  const clean = routeParts.filter(p => !p.startsWith('('));
  return '/' + clean.join('/') || '/';
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

export function chunkFile(
  filePath: string,
  content: string,
  repoRoot: string,
  maxTokens: number = 8000,
): CodeChunk[] {
  const relativePath = relative(repoRoot, filePath);
  const lines = content.split('\n');
  const packageName = detectPackageName(filePath);
  const imports = getImportLines(content);
  const frameworkRole = getFrameworkRole(relativePath);

  // Small file rule: <50 lines → single chunk
  if (lines.length < 50) {
    return [makeFileChunk(filePath, relativePath, content, packageName, imports, frameworkRole)];
  }

  // NextJS page/layout/middleware → single file chunk
  if (frameworkRole === 'page' || frameworkRole === 'layout' || frameworkRole === 'middleware') {
    const name = frameworkRole === 'page' ? deriveRoutePath(relativePath) : basename(filePath);
    return [{
      id: chunkId(filePath, 1, lines.length),
      file_path: relativePath,
      package_name: packageName,
      name,
      chunk_type: frameworkRole === 'page' ? 'component' : frameworkRole === 'middleware' ? 'function' : 'component',
      line_start: 1,
      line_end: lines.length,
      content: buildChunkContent(relativePath, imports, content),
      language: getLanguage(filePath),
      exported: true,
      framework_role: frameworkRole,
    }];
  }

  // Parse and walk AST
  const tree = parseFile(filePath, content);
  const chunks: CodeChunk[] = [];

  // For API route files, extract per-method chunks
  if (frameworkRole === 'api_route') {
    return extractApiRouteChunks(tree.rootNode, filePath, relativePath, content, packageName, imports, lines);
  }

  walkNode(tree.rootNode, chunks, {
    filePath,
    relativePath,
    content,
    packageName,
    imports,
    lines,
    maxTokens,
    exported: false,
  });

  // If AST walk produced nothing, fall back to file-level chunk
  if (chunks.length === 0) {
    return [makeFileChunk(filePath, relativePath, content, packageName, imports, frameworkRole)];
  }

  return chunks;
}

interface WalkContext {
  filePath: string;
  relativePath: string;
  content: string;
  packageName: string;
  imports: string[];
  lines: string[];
  maxTokens: number;
  exported: boolean;
}

function walkNode(node: Node, chunks: CodeChunk[], ctx: WalkContext): void {
  for (const child of node.children) {
    const exported = ctx.exported || child.type === 'export_statement';

    if (child.type === 'export_statement') {
      const decl = child.childForFieldName('declaration') || child.namedChildren[0];
      if (decl && decl.type !== 'export_statement') {
        walkNode(child, chunks, { ...ctx, exported: true });
      }
      continue;
    }

    const chunk = tryExtractChunk(child, ctx, exported);
    if (chunk) {
      // Truncate if too large
      if (estimateTokens(chunk.content) > ctx.maxTokens) {
        chunk.content = chunk.content.slice(0, ctx.maxTokens * 4) + '\n// ... truncated';
      }
      chunks.push(chunk);
    }
  }
}

function tryExtractChunk(node: Node, ctx: WalkContext, exported: boolean): CodeChunk | null {
  const { filePath, relativePath, packageName, imports, content } = ctx;

  switch (node.type) {
    case 'function_declaration': {
      const name = node.childForFieldName('name')?.text || 'anonymous';
      const code = node.text;
      const chunkType = determineChunkType(name, node.type, node, filePath);
      return {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: packageName,
        name,
        chunk_type: chunkType,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, code),
        language: getLanguage(filePath),
        exported,
        framework_role: getFrameworkRole(relativePath),
      };
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = node.childForFieldName('name')?.text || 'AnonymousClass';
      const code = node.text;
      const chunk: CodeChunk = {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: packageName,
        name,
        chunk_type: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, code),
        language: getLanguage(filePath),
        exported,
        framework_role: getFrameworkRole(relativePath),
      };
      // If class is large, we still keep it as one chunk (could split methods later)
      if (estimateTokens(code) > 500) {
        chunk.content = chunk.content.slice(0, ctx.maxTokens * 4) + '\n// ... truncated';
      }
      return chunk;
    }

    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text || 'AnonymousInterface';
      return {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: packageName,
        name,
        chunk_type: 'interface',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: getLanguage(filePath),
        exported,
        framework_role: getFrameworkRole(relativePath),
      };
    }

    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text || 'AnonymousType';
      return {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: packageName,
        name,
        chunk_type: 'type',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: getLanguage(filePath),
        exported,
        framework_role: getFrameworkRole(relativePath),
      };
    }

    case 'lexical_declaration': {
      // const/let with arrow function or function expression
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const info = getDeclaratorInfo(declarator);
        if (!info || !info.valueNode) continue;
        if (isArrowFunction(info.valueNode) || isFunctionExpression(info.valueNode)) {
          const chunkType = determineChunkType(info.name, info.valueNode.type, info.valueNode, filePath);
          return {
            id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
            file_path: relativePath,
            package_name: packageName,
            name: info.name,
            chunk_type: chunkType,
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            content: buildChunkContent(relativePath, imports, node.text),
            language: getLanguage(filePath),
            exported,
            framework_role: getFrameworkRole(relativePath),
          };
        }
      }
      return null;
    }

    default:
      return null;
  }
}

function extractApiRouteChunks(
  rootNode: Node,
  filePath: string,
  relativePath: string,
  content: string,
  packageName: string,
  imports: string[],
  lines: string[],
): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (const child of rootNode.children) {
    let targetNode = child;
    let exported = false;

    if (child.type === 'export_statement') {
      exported = true;
      targetNode = child.childForFieldName('declaration') || child.namedChildren[0] || child;
    }

    // Look for exported function declarations like `export async function GET`
    if (targetNode.type === 'function_declaration') {
      const name = targetNode.childForFieldName('name')?.text || '';
      if (HTTP_METHODS.has(name)) {
        chunks.push({
          id: chunkId(filePath, child.startPosition.row + 1, child.endPosition.row + 1),
          file_path: relativePath,
          package_name: packageName,
          name,
          chunk_type: 'route',
          line_start: child.startPosition.row + 1,
          line_end: child.endPosition.row + 1,
          content: buildChunkContent(relativePath, imports, child.text),
          language: getLanguage(filePath),
          exported,
          framework_role: 'api_route',
        });
        continue;
      }
    }

    // Look for `export const GET = ...`
    if (targetNode.type === 'lexical_declaration') {
      for (const decl of targetNode.namedChildren) {
        if (decl.type !== 'variable_declarator') continue;
        const info = getDeclaratorInfo(decl);
        if (info && HTTP_METHODS.has(info.name)) {
          chunks.push({
            id: chunkId(filePath, child.startPosition.row + 1, child.endPosition.row + 1),
            file_path: relativePath,
            package_name: packageName,
            name: info.name,
            chunk_type: 'route',
            line_start: child.startPosition.row + 1,
            line_end: child.endPosition.row + 1,
            content: buildChunkContent(relativePath, imports, child.text),
            language: getLanguage(filePath),
            exported,
            framework_role: 'api_route',
          });
        }
      }
    }
  }

  // If no methods extracted, fallback to whole file
  if (chunks.length === 0) {
    return [makeFileChunk(filePath, relativePath, content, packageName, imports, 'api_route')];
  }

  return chunks;
}

function makeFileChunk(
  filePath: string,
  relativePath: string,
  content: string,
  packageName: string,
  imports: string[],
  frameworkRole?: CodeChunk['framework_role'],
): CodeChunk {
  const lines = content.split('\n');
  return {
    id: chunkId(filePath, 1, lines.length),
    file_path: relativePath,
    package_name: packageName,
    name: basename(filePath),
    chunk_type: frameworkRole === 'config' ? 'config' : 'other',
    line_start: 1,
    line_end: lines.length,
    content: buildChunkContent(relativePath, imports, content),
    language: getLanguage(filePath),
    exported: false,
    framework_role: frameworkRole,
  };
}

function getLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  return 'typescript';
}
