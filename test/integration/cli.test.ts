import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Capture action handlers registered by src/index.ts
const capturedActions = new Map<string, Function>();
const capturedOptions = new Map<string, any[]>();

vi.mock('commander', () => {
  const realCommand = class FakeCommand {
    private _name = '';
    private _desc = '';
    private _version = '';
    private _opts: any[] = [];
    private _action: Function | null = null;

    name(n: string) { this._name = n; return this; }
    description(d: string) { this._desc = d; return this; }
    version(v: string) { this._version = v; return this; }
    option(...args: any[]) { this._opts.push(args); return this; }

    command(name: string) {
      const sub = new FakeCommand();
      sub._name = name.split(' ')[0]; // strip <arg> from e.g. "query <search>"
      // Store reference so parse can find it
      capturedOptions.set(sub._name, sub._opts);
      return sub;
    }

    action(fn: Function) {
      this._action = fn;
      capturedActions.set(this._name, fn);
      return this;
    }

    parse() {
      // no-op: we call actions manually in tests
    }
  };

  return { Command: realCommand };
});

vi.mock('../../src/indexer.js', () => ({
  indexFull: vi.fn(),
  indexIncremental: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../../src/search.js', () => ({
  searchCode: vi.fn(),
  formatResults: vi.fn(),
}));

vi.mock('../../src/store.js', () => ({
  initStore: vi.fn(),
  getStats: vi.fn(),
  getGitStats: vi.fn(),
  initGitHistoryTable: vi.fn(),
}));

vi.mock('../../src/git/indexer.js', () => ({
  indexGitFull: vi.fn(),
  indexGitIncremental: vi.fn(),
}));

vi.mock('../../src/git/search.js', () => ({
  searchGitHistoryQuery: vi.fn(),
  formatGitResults: vi.fn(),
}));

vi.mock('../../src/git/cross-ref.js', () => ({
  explain: vi.fn(),
  formatExplainResult: vi.fn(),
}));

vi.mock('../../src/lang/plugin.js', () => ({
  registry: { register: vi.fn() },
}));

vi.mock('../../src/lang/typescript/index.js', () => ({
  TypeScriptPlugin: vi.fn(),
}));

vi.mock('../../src/lang/python/index.js', () => ({
  PythonPlugin: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

// Import the CLI module — this registers all commands via the mocked Commander
await import('../../src/index.js');

const { indexFull, indexIncremental, loadConfig } = await import('../../src/indexer.js');
const { indexGitFull, indexGitIncremental } = await import('../../src/git/indexer.js');
const { writeFileSync, existsSync, statSync } = await import('node:fs');

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(loadConfig).mockReturnValue({
    embeddingBatchSize: 50,
    storeUri: undefined,
    git: {
      includeFileChunks: false,
      includeMergeGroups: false,
      maxDiffLinesPerFile: 50,
      enrichLowQualityMessages: true,
      lowQualityThreshold: 10,
      skipBotAuthors: [],
      skipMessagePatterns: [],
      maxCommits: 0,
    },
  } as any);

  vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    throw new ExitError(typeof code === 'number' ? code : 1);
  });
});

// Helper to get a captured action by command name
function getAction(name: string): Function {
  const action = capturedActions.get(name);
  if (!action) throw new Error(`No action captured for command "${name}"`);
  return action;
}

describe('resolveRepo (via index command)', () => {
  it('calls process.exit when no --repo and no env var', async () => {
    delete process.env.CORTEX_RECALL_REPO;
    const action = getAction('index');

    await expect(action({ full: true })).rejects.toThrow(ExitError);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('calls process.exit when path is not a directory', async () => {
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);
    const action = getAction('index');

    await expect(action({ repo: '/tmp/not-a-dir', full: true })).rejects.toThrow(ExitError);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('calls process.exit when path does not exist', async () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const action = getAction('index');

    await expect(action({ repo: '/tmp/nonexistent', full: true })).rejects.toThrow(ExitError);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('formatError (via index command error handling)', () => {
  it('formats Error instances via .message', async () => {
    vi.mocked(indexFull).mockRejectedValue(new Error('Ollama not running'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const action = getAction('index');

    await expect(action({ repo: '/tmp/fakerepo', full: true })).rejects.toThrow(ExitError);

    const errorOutput = consoleSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(errorOutput).toContain('Ollama not running');

    consoleSpy.mockRestore();
  });

  it('formats non-Error values via String()', async () => {
    vi.mocked(indexFull).mockRejectedValue('raw string error');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const action = getAction('index');

    await expect(action({ repo: '/tmp/fakerepo', full: true })).rejects.toThrow(ExitError);

    const errorOutput = consoleSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(errorOutput).toContain('raw string error');

    consoleSpy.mockRestore();
  });
});

describe('init command', () => {
  it('writes default config when none exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const action = getAction('init');

    await action({ repo: '/tmp/fakerepo' });

    expect(writeFileSync).toHaveBeenCalled();
    const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
    expect(String(path)).toContain('.cortexrc.json');
    expect(String(content)).toContain('cortex-recall');
  });

  it('skips writing when config already exists', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const action = getAction('init');

    await action({ repo: '/tmp/fakerepo' });

    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe('index command', () => {
  it('calls indexFull when --full flag is set', async () => {
    vi.mocked(indexFull).mockResolvedValue(undefined);
    const action = getAction('index');

    await action({ repo: '/tmp/fakerepo', full: true });

    expect(indexFull).toHaveBeenCalled();
    expect(indexIncremental).not.toHaveBeenCalled();
  });
});
