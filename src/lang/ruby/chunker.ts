import { createHash } from 'node:crypto';
import { relative, basename } from 'node:path';
import { parseRubyFile, type Node } from './parser.js';
import type { CodeChunk } from '../../types.js';

function chunkId(filePath: string, lineStart: number, lineEnd: number): string {
  return createHash('sha256')
    .update(`${filePath}:${lineStart}:${lineEnd}`)
    .digest('hex')
    .slice(0, 16);
}

function getImportLines(content: string, max: number = 10): string[] {
  const lines = content.split('\n');
  const imports: string[] = [];
  for (const line of lines) {
    if (imports.length >= max) break;
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith('require ') ||
      trimmed.startsWith('require_relative ') ||
      trimmed.startsWith('include ') ||
      trimmed.startsWith('extend ') ||
      trimmed.startsWith('prepend ')
    ) {
      imports.push(line);
    }
  }
  return imports;
}

function buildChunkContent(relativePath: string, imports: string[], code: string): string {
  const parts = [`# file: ${relativePath}`];
  if (imports.length > 0) {
    parts.push(imports.join('\n'));
    parts.push('');
  }
  parts.push(code);
  return parts.join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type ChunkType = CodeChunk['chunk_type'];

function getChunkName(node: Node): string {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text || 'anonymous';
}

export function chunkFile(
  filePath: string,
  content: string,
  repoRoot: string,
  maxTokens: number = 8000,
): CodeChunk[] {
  const relativePath = relative(repoRoot, filePath);
  const lines = content.split('\n');
  const imports = getImportLines(content);

  // Small file rule: <50 lines → single chunk
  if (lines.length < 50) {
    return [{
      id: chunkId(filePath, 1, lines.length),
      file_path: relativePath,
      package_name: 'root',
      name: basename(filePath),
      chunk_type: 'other',
      line_start: 1,
      line_end: lines.length,
      content: buildChunkContent(relativePath, imports, content),
      language: 'ruby',
      exported: false,
    }];
  }

  const tree = parseRubyFile(content);
  const chunks: CodeChunk[] = [];

  walkNode(tree.rootNode, chunks, {
    filePath,
    relativePath,
    imports,
    maxTokens,
  });

  // If AST walk produced nothing, fall back to file-level chunk
  if (chunks.length === 0) {
    return [{
      id: chunkId(filePath, 1, lines.length),
      file_path: relativePath,
      package_name: 'root',
      name: basename(filePath),
      chunk_type: 'other',
      line_start: 1,
      line_end: lines.length,
      content: buildChunkContent(relativePath, imports, content),
      language: 'ruby',
      exported: false,
    }];
  }

  return chunks;
}

interface WalkContext {
  filePath: string;
  relativePath: string;
  imports: string[];
  maxTokens: number;
}

function walkNode(node: Node, chunks: CodeChunk[], ctx: WalkContext): void {
  for (const child of node.children) {
    const chunk = tryExtractChunk(child, ctx);
    if (chunk) {
      if (estimateTokens(chunk.content) > ctx.maxTokens) {
        chunk.content = chunk.content.slice(0, ctx.maxTokens * 4) + '\n# ... truncated';
      }
      chunks.push(chunk);
    }
  }
}

function tryExtractChunk(node: Node, ctx: WalkContext): CodeChunk | null {
  const { filePath, relativePath, imports } = ctx;

  switch (node.type) {
    case 'method': {
      const name = getChunkName(node);
      return {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: 'root',
        name,
        chunk_type: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: 'ruby',
        exported: false,
      };
    }

    case 'singleton_method': {
      const name = getChunkName(node);
      return {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: 'root',
        name,
        chunk_type: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: 'ruby',
        exported: false,
      };
    }

    case 'class': {
      const name = getChunkName(node);
      const chunk: CodeChunk = {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: 'root',
        name,
        chunk_type: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: 'ruby',
        exported: false,
      };
      if (estimateTokens(node.text) > 500) {
        chunk.content = chunk.content.slice(0, ctx.maxTokens * 4) + '\n# ... truncated';
      }
      return chunk;
    }

    case 'module': {
      const name = getChunkName(node);
      const chunk: CodeChunk = {
        id: chunkId(filePath, node.startPosition.row + 1, node.endPosition.row + 1),
        file_path: relativePath,
        package_name: 'root',
        name,
        chunk_type: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        content: buildChunkContent(relativePath, imports, node.text),
        language: 'ruby',
        exported: false,
      };
      if (estimateTokens(node.text) > 500) {
        chunk.content = chunk.content.slice(0, ctx.maxTokens * 4) + '\n# ... truncated';
      }
      return chunk;
    }

    default:
      return null;
  }
}
