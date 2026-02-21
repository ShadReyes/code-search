// --- Signal Detection Types ---

export type SignalType =
  | 'revert_pair'
  | 'fix_chain'
  | 'churn_hotspot'
  | 'ownership'
  | 'adoption_cycle'
  | 'stability_shift'
  | 'breaking_change';

export type Severity = 'info' | 'caution' | 'warning';

export interface SignalRecord {
  id: string;
  type: SignalType;
  summary: string; // embeddable text
  severity: Severity;
  confidence: number; // 0-1
  directory_scope: string;
  contributing_shas: string[];
  temporal_scope: { start: string; end: string }; // ISO 8601
  metadata: Record<string, unknown>;
  created_at: string; // ISO 8601
}

export interface FileProfile {
  path: string;
  primary_owner: {
    author: string;
    percentage: number;
    commits: number;
    last_change: string; // ISO 8601
  } | null;
  contributor_count: number;
  stability_score: number; // 0-100
  total_changes: number;
  revert_count: number;
  fix_after_feature_count: number;
  change_frequency: 'daily' | 'weekly' | 'monthly' | 'rare';
  risk_score: number; // 0-100
  last_modified: string; // ISO 8601
  active_signal_ids: string[];
}

export type WarningCategory = 'stability' | 'ownership' | 'pattern' | 'churn' | 'breaking';

export interface Warning {
  severity: Severity;
  category: WarningCategory;
  message: string;
  evidence: string[]; // SHAs
}

export interface JudgmentResult {
  warnings: Warning[];
  file_profiles: FileProfile[];
  signals: SignalRecord[];
  owners: { author: string; percentage: number; last_change: string }[];
}

// --- Detector Interface ---

import type { GitHistoryChunk } from '../types.js';

export interface SignalDetector {
  readonly name: string;
  detect(commits: GitHistoryChunk[], existingSignals?: SignalRecord[]): SignalRecord[];
}

export interface DetectorPipelineConfig {
  detectors: string[]; // detector names to run
  fullAnalysis: boolean;
}

export interface AnalyzeState {
  lastAnalyzedCommit: string;
  lastAnalyzedAt: string;
  totalSignals: number;
  totalProfiles: number;
}
