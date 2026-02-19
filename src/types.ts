export interface CodeChunk {
  id: string;
  file_path: string;
  package_name: string;
  name: string;
  chunk_type: 'function' | 'class' | 'component' | 'hook' | 'type' | 'interface' | 'route' | 'config' | 'other';
  line_start: number;
  line_end: number;
  content: string;
  language: string;
  exported: boolean;
  framework_role?: 'page' | 'layout' | 'api_route' | 'middleware' | 'config';
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
}

// --- Git History Types ---

export interface GitFileChange {
  path: string;
  additions: number;
  deletions: number;
  status: 'A' | 'M' | 'D' | 'R' | 'C';
}

export interface GitCommitRaw {
  sha: string;
  author: string;
  email: string;
  date: string; // ISO 8601
  subject: string;
  body: string;
  parents: string[];
  refs: string;
  files: GitFileChange[];
}

export interface GitHistoryChunk {
  id: string;
  sha: string;
  author: string;
  email: string;
  date: string; // ISO 8601
  subject: string;
  body: string;
  chunk_type: 'commit_summary' | 'file_diff' | 'merge_group';
  commit_type: string; // feat, fix, refactor, etc.
  scope: string;
  file_path: string; // empty for commit_summary/merge_group
  text: string;
  files_changed: number;
  additions: number;
  deletions: number;
  branch: string;
}

export interface GitHistorySearchResult {
  chunk: GitHistoryChunk;
  score: number;
  retrieval_method: 'vector' | 'temporal_vector' | 'pickaxe' | 'blame' | 'structured_git';
}

export interface GitIndexState {
  lastCommit: string;
  lastIndexedAt: string;
  totalChunks: number;
  totalCommits: number;
  embeddingDimension: number;
}

export interface BlameResult {
  sha: string;
  author: string;
  email: string;
  date: string;
  lineStart: number;
  lineEnd: number;
  content: string;
}

export interface GitLogResult {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

export interface GitConfig {
  includeFileChunks: boolean;
  includeMergeGroups: boolean;
  maxDiffLinesPerFile: number;
  enrichLowQualityMessages: boolean;
  lowQualityThreshold: number;
  skipBotAuthors: string[];
  skipMessagePatterns: string[];
  maxCommits: number; // 0 = unlimited
}

export interface IndexState {
  lastCommit: string;
  lastIndexedAt: string;
  totalChunks: number;
  totalFiles: number;
  embeddingDimension: number;
}

export interface CodeSearchConfig {
  include: string[];
  exclude: string[];
  excludePatterns: string[];
  maxFileLines: number;
  indexTests: boolean;
  chunkMaxTokens: number;
  embeddingModel: string;
  embeddingBatchSize: number;
  searchLimit: number;
  git?: GitConfig;
}

export const DEFAULT_CONFIG: CodeSearchConfig = {
  include: [
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.mjs',
    '**/*.mts',
  ],
  exclude: [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.next/**',
    'coverage/**',
    '*.d.ts',
    '*.min.js',
    '*.bundle.js',
  ],
  excludePatterns: [],
  maxFileLines: 2000,
  indexTests: false,
  chunkMaxTokens: 8000,
  embeddingModel: 'nomic-embed-text',
  embeddingBatchSize: 50,
  searchLimit: 5,
  git: {
    includeFileChunks: true,
    includeMergeGroups: true,
    maxDiffLinesPerFile: 50,
    enrichLowQualityMessages: true,
    lowQualityThreshold: 10,
    skipBotAuthors: ['dependabot', 'renovate', 'github-actions'],
    skipMessagePatterns: ['^Merge branch', 'lock file'],
    maxCommits: 500,
  },
};
