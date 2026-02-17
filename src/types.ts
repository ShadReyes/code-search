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
};
