import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/** Git env vars so commits work without a global git config. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'bench',
  GIT_AUTHOR_EMAIL: 'bench@test',
  GIT_COMMITTER_NAME: 'bench',
  GIT_COMMITTER_EMAIL: 'bench@test',
};

// ---------------------------------------------------------------------------
// File content templates
// ---------------------------------------------------------------------------

/**
 * Small function file (~10-20 lines).
 */
function smallFunctionTemplate(index: number): string {
  const name = `calculateValue${index}`;
  return `/**
 * Calculates a derived value based on the input parameters.
 * Generated file #${index} for scaling benchmarks.
 */
export function ${name}(x: number, y: number): number {
  if (x < 0) {
    throw new Error('x must be non-negative');
  }
  const base = x * ${index + 1};
  const factor = y > 0 ? y : 1;
  const result = Math.round((base / factor) * 100) / 100;
  return result;
}

export function is${name}Valid(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
`;
}

/**
 * Medium module file (~50-80 lines).
 */
function mediumModuleTemplate(index: number): string {
  const typeName = `Config${index}`;
  const fnName = `processData${index}`;
  return `export interface ${typeName} {
  id: string;
  label: string;
  threshold: number;
  enabled: boolean;
  tags: string[];
}

export const DEFAULT_${typeName.toUpperCase()}: ${typeName} = {
  id: 'default-${index}',
  label: 'Module ${index}',
  threshold: ${(index * 0.17).toFixed(2)},
  enabled: true,
  tags: ['auto', 'generated', 'bench-${index}'],
};

export function ${fnName}(items: ${typeName}[]): ${typeName}[] {
  return items
    .filter((item) => item.enabled)
    .map((item) => ({
      ...item,
      threshold: Math.min(item.threshold * ${1 + index * 0.1}, 1.0),
      tags: [...item.tags, 'processed'],
    }))
    .sort((a, b) => a.threshold - b.threshold);
}

export function merge${typeName}(
  base: ${typeName},
  overrides: Partial<${typeName}>,
): ${typeName} {
  return {
    ...base,
    ...overrides,
    tags: [...(base.tags ?? []), ...(overrides.tags ?? [])],
  };
}

export function validate${typeName}(config: unknown): config is ${typeName} {
  if (typeof config !== 'object' || config === null) return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.label === 'string' &&
    typeof c.threshold === 'number' &&
    typeof c.enabled === 'boolean' &&
    Array.isArray(c.tags)
  );
}

export function summarize${typeName}(configs: ${typeName}[]): string {
  const enabled = configs.filter((c) => c.enabled).length;
  const avgThreshold =
    configs.reduce((sum, c) => sum + c.threshold, 0) / (configs.length || 1);
  return \`Total: \${configs.length}, Enabled: \${enabled}, Avg threshold: \${avgThreshold.toFixed(3)}\`;
}
`;
}

/**
 * Class file (~100-150 lines).
 */
function classTemplate(index: number): string {
  const className = `DataProcessor${index}`;
  return `export interface ${className}Options {
  batchSize: number;
  maxRetries: number;
  timeout: number;
  verbose: boolean;
}

export interface ${className}Result {
  processed: number;
  skipped: number;
  errors: string[];
  duration: number;
}

export class ${className} {
  private readonly options: ${className}Options;
  private buffer: string[] = [];
  private processedCount = 0;
  private errorLog: string[] = [];

  constructor(options: Partial<${className}Options> = {}) {
    this.options = {
      batchSize: options.batchSize ?? ${10 + index * 5},
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeout ?? ${5000 + index * 1000},
      verbose: options.verbose ?? false,
    };
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  get totalProcessed(): number {
    return this.processedCount;
  }

  get errors(): readonly string[] {
    return this.errorLog;
  }

  add(item: string): void {
    if (!item || item.trim().length === 0) {
      this.errorLog.push('Attempted to add empty item');
      return;
    }
    this.buffer.push(item.trim());

    if (this.buffer.length >= this.options.batchSize) {
      this.flush();
    }
  }

  addMany(items: string[]): void {
    for (const item of items) {
      this.add(item);
    }
  }

  flush(): ${className}Result {
    const start = Date.now();
    const toProcess = [...this.buffer];
    this.buffer = [];

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of toProcess) {
      try {
        if (this.shouldSkip(item)) {
          skipped++;
          continue;
        }
        this.processItem(item);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        this.errorLog.push(msg);
      }
    }

    this.processedCount += processed;

    return {
      processed,
      skipped,
      errors,
      duration: Date.now() - start,
    };
  }

  reset(): void {
    this.buffer = [];
    this.processedCount = 0;
    this.errorLog = [];
  }

  private shouldSkip(item: string): boolean {
    return item.length < ${2 + (index % 5)} || item.startsWith('#');
  }

  private processItem(item: string): void {
    if (this.options.verbose) {
      console.log(\`[${className}] Processing: \${item.slice(0, 50)}\`);
    }
    // Simulate work — the actual transform is a no-op for benchmarks
    const _transformed = item
      .split('')
      .reverse()
      .join('')
      .toUpperCase();
  }

  toJSON(): Record<string, unknown> {
    return {
      className: '${className}',
      options: this.options,
      bufferSize: this.buffer.length,
      processedCount: this.processedCount,
      errorCount: this.errorLog.length,
    };
  }

  static create(overrides?: Partial<${className}Options>): ${className} {
    return new ${className}(overrides);
  }
}
`;
}

// ---------------------------------------------------------------------------
// Template cycling
// ---------------------------------------------------------------------------

type TemplateGenerator = (index: number) => string;

const templates: Array<{
  generate: TemplateGenerator;
  dir: string;
  prefix: string;
}> = [
  { generate: smallFunctionTemplate, dir: 'utils', prefix: 'calc' },
  { generate: mediumModuleTemplate, dir: 'modules', prefix: 'mod' },
  { generate: classTemplate, dir: 'services', prefix: 'svc' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a temporary git repo containing `fileCount` TypeScript files
 * distributed across util/module/class templates. The repo is initialized
 * with a single commit so that `git log` and `git diff` work correctly.
 *
 * @param fileCount - Number of .ts files to generate
 * @returns Absolute path to the temporary repo root
 */
export async function generateScalingRepo(
  fileCount: number,
): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'bench-scaling-'));

  // Create package.json
  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify({ name: 'scaling-repo', version: '0.0.1' }, null, 2),
    'utf-8',
  );

  // Create subdirectories
  const dirs = new Set(templates.map((t) => t.dir));
  for (const dir of dirs) {
    mkdirSync(join(repoDir, 'src', dir), { recursive: true });
  }

  // Generate files cycling through templates
  for (let i = 0; i < fileCount; i++) {
    const tpl = templates[i % templates.length];
    const fileName = `${tpl.prefix}-${i}.ts`;
    const filePath = join(repoDir, 'src', tpl.dir, fileName);
    const content = tpl.generate(i);
    writeFileSync(filePath, content, 'utf-8');
  }

  // Initialize git repo and create initial commit
  const execOpts = { cwd: repoDir, env: { ...process.env, ...GIT_ENV } };
  execSync('git init', execOpts);
  execSync('git add .', execOpts);
  execSync('git commit -m "initial commit"', execOpts);

  return repoDir;
}

/**
 * Remove a repo previously created by `generateScalingRepo`.
 *
 * @param repoPath - Absolute path to the repo root
 */
export function cleanupRepo(repoPath: string): void {
  rmSync(repoPath, { recursive: true, force: true });
}
