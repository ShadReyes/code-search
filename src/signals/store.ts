import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { SignalRecord, FileProfile } from './types.js';

const SIGNALS_TABLE = 'signals';
const PROFILES_TABLE = 'file_profiles';

let db: Connection;
const tables = new Map<string, Table>();

export async function initSignalsStore(storeUri?: string): Promise<void> {
  const dbPath = storeUri
    || process.env.CORTEX_RECALL_STORE_URI
    || `${process.cwd()}/.lance`;
  db = await connect(dbPath);
}

export async function initSignalsTable(): Promise<void> {
  if (!db) throw new Error('Store not initialized. Call initSignalsStore() first.');
  const tableNames = await db.tableNames();
  if (tableNames.includes(SIGNALS_TABLE)) {
    tables.set(SIGNALS_TABLE, await db.openTable(SIGNALS_TABLE));
  }
}

export async function initFileProfilesTable(): Promise<void> {
  if (!db) throw new Error('Store not initialized. Call initSignalsStore() first.');
  const tableNames = await db.tableNames();
  if (tableNames.includes(PROFILES_TABLE)) {
    tables.set(PROFILES_TABLE, await db.openTable(PROFILES_TABLE));
  }
}

// --- Signals CRUD ---

function signalToRecord(signal: SignalRecord, vector: number[]): Record<string, unknown> {
  return {
    id: signal.id,
    type: signal.type,
    summary: signal.summary,
    severity: signal.severity,
    confidence: signal.confidence,
    directory_scope: signal.directory_scope,
    contributing_shas: JSON.stringify(signal.contributing_shas),
    temporal_start: signal.temporal_scope.start,
    temporal_end: signal.temporal_scope.end,
    metadata_json: JSON.stringify(signal.metadata),
    created_at: signal.created_at,
    vector,
  };
}

function recordToSignal(record: Record<string, unknown>): SignalRecord {
  return {
    id: record.id as string,
    type: record.type as SignalRecord['type'],
    summary: record.summary as string,
    severity: record.severity as SignalRecord['severity'],
    confidence: record.confidence as number,
    directory_scope: record.directory_scope as string,
    contributing_shas: JSON.parse(record.contributing_shas as string),
    temporal_scope: {
      start: record.temporal_start as string,
      end: record.temporal_end as string,
    },
    metadata: JSON.parse(record.metadata_json as string),
    created_at: record.created_at as string,
  };
}

export async function insertSignals(
  signals: SignalRecord[],
  vectors: number[][],
  overwrite: boolean = false,
): Promise<void> {
  const records = signals.map((s, i) => signalToRecord(s, vectors[i]));
  const table = tables.get(SIGNALS_TABLE);

  if (overwrite || !table) {
    tables.set(SIGNALS_TABLE, await db.createTable(SIGNALS_TABLE, records, { mode: 'overwrite' }));
  } else {
    await table.add(records);
  }
}

export async function replaceSignalsByType(
  types: string[],
  signals: SignalRecord[],
  vectors: number[][],
): Promise<void> {
  const table = tables.get(SIGNALS_TABLE);
  if (!table) {
    // No existing table — just create with the new signals
    if (signals.length > 0) {
      const records = signals.map((s, i) => signalToRecord(s, vectors[i]));
      tables.set(SIGNALS_TABLE, await db.createTable(SIGNALS_TABLE, records, { mode: 'overwrite' }));
    }
    return;
  }

  // Delete rows matching the given types
  for (const type of types) {
    await table.delete(`type = '${type.replace(/'/g, "''")}'`);
  }

  // Append new signals
  if (signals.length > 0) {
    const records = signals.map((s, i) => signalToRecord(s, vectors[i]));
    await table.add(records);
  }
}

export async function searchSignals(
  queryVector: number[],
  limit: number,
  filter?: string,
): Promise<{ signal: SignalRecord; score: number }[]> {
  const table = tables.get(SIGNALS_TABLE);
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
    signal: recordToSignal(row),
    score: 1 - (row._distance as number),
  }));
}

export async function getSignalsByDirectory(directory: string): Promise<SignalRecord[]> {
  const table = tables.get(SIGNALS_TABLE);
  if (!table) return [];

  const escaped = directory.replace(/'/g, "''");
  const filter = directory === '.'
    ? undefined
    : `directory_scope = '${escaped}' OR directory_scope = '.'`;

  let query = table.query();
  if (filter) {
    query = query.where(filter);
  }
  const rows = await query.toArray();
  return rows.map((row: Record<string, unknown>) => recordToSignal(row));
}

export async function getSignalsByType(type: string): Promise<SignalRecord[]> {
  const table = tables.get(SIGNALS_TABLE);
  if (!table) return [];

  const rows = await table.query()
    .where(`type = '${type.replace(/'/g, "''")}'`)
    .toArray();
  return rows.map((row: Record<string, unknown>) => recordToSignal(row));
}

export async function getSignalStats(): Promise<Record<string, number>> {
  const table = tables.get(SIGNALS_TABLE);
  if (!table) return {};

  const rows = await table.query().select(['type']).toArray();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const type = row.type as string;
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

export async function dropSignalsTable(): Promise<void> {
  const tableNames = await db.tableNames();
  if (tableNames.includes(SIGNALS_TABLE)) {
    await db.dropTable(SIGNALS_TABLE);
    tables.delete(SIGNALS_TABLE);
  }
}

// --- File Profiles CRUD ---

function profileToRecord(profile: FileProfile): Record<string, unknown> {
  return {
    path: profile.path,
    primary_owner_json: JSON.stringify(profile.primary_owner),
    contributor_count: profile.contributor_count,
    stability_score: profile.stability_score,
    total_changes: profile.total_changes,
    revert_count: profile.revert_count,
    fix_after_feature_count: profile.fix_after_feature_count,
    change_frequency: profile.change_frequency,
    risk_score: profile.risk_score,
    last_modified: profile.last_modified,
    active_signal_ids: JSON.stringify(profile.active_signal_ids),
  };
}

function recordToProfile(record: Record<string, unknown>): FileProfile {
  return {
    path: record.path as string,
    primary_owner: JSON.parse(record.primary_owner_json as string),
    contributor_count: record.contributor_count as number,
    stability_score: record.stability_score as number,
    total_changes: record.total_changes as number,
    revert_count: record.revert_count as number,
    fix_after_feature_count: record.fix_after_feature_count as number,
    change_frequency: record.change_frequency as FileProfile['change_frequency'],
    risk_score: record.risk_score as number,
    last_modified: record.last_modified as string,
    active_signal_ids: JSON.parse(record.active_signal_ids as string),
  };
}

export async function upsertFileProfiles(
  profiles: FileProfile[],
  overwrite: boolean = false,
): Promise<void> {
  if (profiles.length === 0) return;
  const records = profiles.map(p => profileToRecord(p));
  const table = tables.get(PROFILES_TABLE);

  if (overwrite || !table) {
    tables.set(PROFILES_TABLE, await db.createTable(PROFILES_TABLE, records, { mode: 'overwrite' }));
  } else {
    // Delete existing profiles for these paths, then add
    for (const profile of profiles) {
      await table.delete(`path = '${profile.path.replace(/'/g, "''")}'`);
    }
    await table.add(records);
  }
}

export async function getFileProfile(path: string): Promise<FileProfile | null> {
  const table = tables.get(PROFILES_TABLE);
  if (!table) return null;

  const rows = await table.query()
    .where(`path = '${path.replace(/'/g, "''")}'`)
    .toArray();

  if (rows.length === 0) return null;
  return recordToProfile(rows[0] as Record<string, unknown>);
}

export async function getDirectoryProfiles(directory: string): Promise<FileProfile[]> {
  const table = tables.get(PROFILES_TABLE);
  if (!table) return [];

  const filter = directory === '.'
    ? undefined
    : `path LIKE '${directory.replace(/'/g, "''")}%'`;

  let query = table.query();
  if (filter) {
    query = query.where(filter);
  }
  const rows = await query.toArray();
  return rows.map((row: Record<string, unknown>) => recordToProfile(row));
}

export async function dropFileProfilesTable(): Promise<void> {
  const tableNames = await db.tableNames();
  if (tableNames.includes(PROFILES_TABLE)) {
    await db.dropTable(PROFILES_TABLE);
    tables.delete(PROFILES_TABLE);
  }
}

export function resetSignalsStore(): void {
  db = null as unknown as Connection;
  tables.clear();
}
