import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeChunk, SearchResult, GitHistoryChunk, GitHistorySearchResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(__dirname); // cortex-recall repo root
const TABLE_NAME = 'chunks';
const GIT_TABLE_NAME = 'git_history';

let db: Connection;
const tables = new Map<string, Table>();

export async function initStore(storeUri?: string): Promise<void> {
  const dbPath = storeUri
    || process.env.CORTEX_RECALL_STORE_URI
    || `${TOOL_ROOT}/.lance`;
  db = await connect(dbPath);
  const tableNames = await db.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    tables.set(TABLE_NAME, await db.openTable(TABLE_NAME));
  }
}

export async function initGitHistoryTable(): Promise<void> {
  if (!db) throw new Error('Store not initialized. Call initStore() first.');
  const tableNames = await db.tableNames();
  if (tableNames.includes(GIT_TABLE_NAME)) {
    tables.set(GIT_TABLE_NAME, await db.openTable(GIT_TABLE_NAME));
  }
}

// --- Code chunk helpers (unchanged signatures) ---

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
    framework_role: (record.framework_role as CodeChunk['framework_role']) || undefined,
  };
}

// --- Code chunk CRUD (unchanged) ---

export async function insertChunks(
  chunks: CodeChunk[],
  vectors: number[][],
  overwrite: boolean = false,
): Promise<void> {
  const records = chunks.map((chunk, i) => chunkToRecord(chunk, vectors[i]));
  const table = tables.get(TABLE_NAME);

  if (overwrite || !table) {
    tables.set(TABLE_NAME, await db.createTable(TABLE_NAME, records, { mode: 'overwrite' }));
  } else {
    await table.add(records);
  }
}

export async function deleteByFilePath(filePath: string): Promise<void> {
  const table = tables.get(TABLE_NAME);
  if (!table) return;
  await table.delete(`file_path = '${filePath.replace(/'/g, "''")}'`);
}

export async function search(
  queryVector: number[],
  limit: number,
  fileFilter?: string,
): Promise<SearchResult[]> {
  const table = tables.get(TABLE_NAME);
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
    score: 1 - (row._distance as number),
  }));
}

export async function getStats(): Promise<{ totalChunks: number; uniqueFiles: number }> {
  const table = tables.get(TABLE_NAME);
  if (!table) return { totalChunks: 0, uniqueFiles: 0 };
  const totalChunks = await table.countRows();
  const rows = await table.query().select(['file_path']).toArray();
  const uniqueFiles = new Set(rows.map((r: Record<string, unknown>) => r.file_path)).size;
  return { totalChunks, uniqueFiles };
}

export function resetStore(): void {
  db = null as unknown as Connection;
  tables.clear();
}

export async function dropTable(): Promise<void> {
  const tableNames = await db.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
    tables.delete(TABLE_NAME);
  }
}

// --- Git history helpers ---

function gitChunkToRecord(chunk: GitHistoryChunk, vector: number[]): Record<string, unknown> {
  return {
    id: chunk.id,
    sha: chunk.sha,
    author: chunk.author,
    email: chunk.email,
    date: chunk.date,
    subject: chunk.subject,
    body: chunk.body,
    chunk_type: chunk.chunk_type,
    commit_type: chunk.commit_type,
    scope: chunk.scope,
    file_path: chunk.file_path,
    text: chunk.text,
    files_changed: chunk.files_changed,
    additions: chunk.additions,
    deletions: chunk.deletions,
    branch: chunk.branch,
    vector,
  };
}

function recordToGitChunk(record: Record<string, unknown>): GitHistoryChunk {
  return {
    id: record.id as string,
    sha: record.sha as string,
    author: record.author as string,
    email: record.email as string,
    date: record.date as string,
    subject: record.subject as string,
    body: record.body as string,
    chunk_type: record.chunk_type as GitHistoryChunk['chunk_type'],
    commit_type: record.commit_type as string,
    scope: record.scope as string,
    file_path: record.file_path as string,
    text: record.text as string,
    files_changed: record.files_changed as number,
    additions: record.additions as number,
    deletions: record.deletions as number,
    branch: record.branch as string,
  };
}

// --- Git history CRUD ---

export async function insertGitChunks(
  chunks: GitHistoryChunk[],
  vectors: number[][],
  overwrite: boolean = false,
): Promise<void> {
  const records = chunks.map((chunk, i) => gitChunkToRecord(chunk, vectors[i]));
  const table = tables.get(GIT_TABLE_NAME);

  if (overwrite || !table) {
    tables.set(GIT_TABLE_NAME, await db.createTable(GIT_TABLE_NAME, records, { mode: 'overwrite' }));
  } else {
    await table.add(records);
  }
}

export async function deleteGitChunksBySha(sha: string): Promise<void> {
  const table = tables.get(GIT_TABLE_NAME);
  if (!table) return;
  await table.delete(`sha = '${sha.replace(/'/g, "''")}'`);
}

export async function searchGitHistory(
  queryVector: number[],
  limit: number,
  filter?: string,
): Promise<GitHistorySearchResult[]> {
  const table = tables.get(GIT_TABLE_NAME);
  if (!table) return [];

  let query = table
    .vectorSearch(Float32Array.from(queryVector))
    .distanceType('cosine')
    .limit(limit);

  if (filter) {
    query = query.where(filter);
  }

  const results = await query.toArray();

  return results.map((row: Record<string, unknown>) => ({
    chunk: recordToGitChunk(row),
    score: 1 - (row._distance as number),
    retrieval_method: 'vector' as const,
  }));
}

export async function getGitStats(): Promise<{
  totalChunks: number;
  uniqueCommits: number;
  dateRange: { earliest: string; latest: string } | null;
}> {
  const table = tables.get(GIT_TABLE_NAME);
  if (!table) return { totalChunks: 0, uniqueCommits: 0, dateRange: null };

  const totalChunks = await table.countRows();
  const rows = await table.query().select(['sha', 'date']).toArray();

  const uniqueCommits = new Set(rows.map((r: Record<string, unknown>) => r.sha)).size;

  let dateRange: { earliest: string; latest: string } | null = null;
  if (rows.length > 0) {
    const dates = rows.map((r: Record<string, unknown>) => r.date as string).sort();
    dateRange = { earliest: dates[0], latest: dates[dates.length - 1] };
  }

  return { totalChunks, uniqueCommits, dateRange };
}

export async function dropGitTable(): Promise<void> {
  const tableNames = await db.tableNames();
  if (tableNames.includes(GIT_TABLE_NAME)) {
    await db.dropTable(GIT_TABLE_NAME);
    tables.delete(GIT_TABLE_NAME);
  }
}
