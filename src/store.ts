import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeChunk, SearchResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(__dirname); // code-search repo root
const TABLE_NAME = 'chunks';

let db: Connection;
let table: Table | null = null;

export async function initStore(): Promise<void> {
  const dbPath = `${TOOL_ROOT}/.lance`;
  db = await connect(dbPath);
  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  }
}

function chunkToRecord(chunk: CodeChunk, vector: number[]): Record<string, unknown> {
  return {
    id: chunk.id,
    file_path: chunk.file_path,
    package_name: chunk.package_name,
    name: chunk.name,
    chunk_type: chunk.chunk_type,
    line_start: chunk.line_start,
    line_end: chunk.line_end,
    content: chunk.content,
    language: chunk.language,
    exported: chunk.exported,
    framework_role: chunk.framework_role || '',
    vector,
  };
}

function recordToChunk(record: Record<string, unknown>): CodeChunk {
  return {
    id: record.id as string,
    file_path: record.file_path as string,
    package_name: record.package_name as string,
    name: record.name as string,
    chunk_type: record.chunk_type as CodeChunk['chunk_type'],
    line_start: record.line_start as number,
    line_end: record.line_end as number,
    content: record.content as string,
    language: record.language as string,
    exported: record.exported as boolean,
    framework_role: (record.framework_role as string) || undefined,
  };
}

export async function insertChunks(
  chunks: CodeChunk[],
  vectors: number[][],
  overwrite: boolean = false,
): Promise<void> {
  const records = chunks.map((chunk, i) => chunkToRecord(chunk, vectors[i]));

  if (overwrite || !table) {
    table = await db.createTable(TABLE_NAME, records, { mode: 'overwrite' });
  } else {
    await table.add(records);
  }
}

export async function deleteByFilePath(filePath: string): Promise<void> {
  if (!table) return;
  await table.delete(`file_path = '${filePath.replace(/'/g, "''")}'`);
}

export async function search(
  queryVector: number[],
  limit: number,
  fileFilter?: string,
): Promise<SearchResult[]> {
  if (!table) return [];

  let query = table
    .vectorSearch(Float32Array.from(queryVector))
    .distanceType('cosine')
    .limit(limit);

  if (fileFilter) {
    query = query.where(`file_path LIKE '${fileFilter.replace(/'/g, "''")}%'`);
  }

  const results = await query.toArray();

  return results.map((row: Record<string, unknown>) => ({
    chunk: recordToChunk(row),
    score: 1 - (row._distance as number), // cosine distance → similarity
  }));
}

export async function getStats(): Promise<{ totalChunks: number; uniqueFiles: number }> {
  if (!table) return { totalChunks: 0, uniqueFiles: 0 };
  const totalChunks = await table.countRows();
  // Get unique files by querying all file_path values
  const rows = await table.query().select(['file_path']).toArray();
  const uniqueFiles = new Set(rows.map((r: Record<string, unknown>) => r.file_path)).size;
  return { totalChunks, uniqueFiles };
}

export async function dropTable(): Promise<void> {
  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
    table = null;
  }
}
