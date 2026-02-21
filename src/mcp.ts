#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { loadConfig } from './indexer.js';
import { searchCode } from './search.js';
import { searchGitHistoryQuery } from './git/search.js';
import { explain } from './git/cross-ref.js';
import { assess } from './assess.js';
import { getFileProfile } from './signals/store.js';
import { registry } from './lang/plugin.js';
import { TypeScriptPlugin } from './lang/typescript/index.js';
import { PythonPlugin } from './lang/python/index.js';
import { RubyPlugin } from './lang/ruby/index.js';

registry.register(new TypeScriptPlugin());
registry.register(new PythonPlugin());
registry.register(new RubyPlugin());

const server = new McpServer({
  name: 'cortex-recall',
  version: '0.1.0',
});

function getRepoPath(repo?: string): string {
  return resolve(repo || process.env.CORTEX_RECALL_REPO || process.cwd());
}

// --- Tool: cortex_assess ---
server.tool(
  'cortex_assess',
  'Get judgment and warnings for files you plan to modify. Returns stability warnings, ownership info, pattern alerts, and risk scores.',
  {
    files: z.array(z.string()).describe('File paths to assess (relative to repo root)'),
    change_type: z.string().optional().describe('Type of change: feat, fix, refactor, etc.'),
    query: z.string().optional().describe('Natural language context for the change'),
    repo: z.string().optional().describe('Repository root path'),
  },
  async ({ files, change_type, query, repo }) => {
    const repoPath = getRepoPath(repo);
    const config = loadConfig(repoPath, false);
    const result = await assess(files, repoPath, config, {
      changeType: change_type,
      query,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Tool: cortex_search ---
server.tool(
  'cortex_search',
  'Semantic code search. Find code by what it does (e.g., "authentication middleware", "database model").',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().optional().describe('Maximum results (default 5)'),
    filter: z.string().optional().describe('File path prefix filter'),
    repo: z.string().optional().describe('Repository root path'),
  },
  async ({ query, limit, filter, repo }) => {
    const repoPath = getRepoPath(repo);
    const results = await searchCode(query, repoPath, limit, filter);
    return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
  },
);

// --- Tool: cortex_git_search ---
server.tool(
  'cortex_git_search',
  'Semantic git history search. Find commits by why/when (e.g., "why did we switch providers", "auth changes last month").',
  {
    query: z.string().describe('Natural language search query'),
    after: z.string().optional().describe('Filter commits after date (ISO 8601)'),
    before: z.string().optional().describe('Filter commits before date (ISO 8601)'),
    author: z.string().optional().describe('Filter by author name'),
    file: z.string().optional().describe('Filter by file path'),
    type: z.string().optional().describe('Filter by commit type (feat, fix, refactor)'),
    limit: z.number().optional().describe('Maximum results (default 10)'),
    sort: z.enum(['relevance', 'date']).optional().describe('Sort order'),
    unique_commits: z.boolean().optional().describe('One result per commit'),
    repo: z.string().optional().describe('Repository root path'),
  },
  async ({ query, after, before, author, file, type, limit, sort, unique_commits, repo }) => {
    const repoPath = getRepoPath(repo);
    const config = loadConfig(repoPath, false);
    const results = await searchGitHistoryQuery(query, repoPath, config, {
      after, before, author, file, type, limit, sort,
      uniqueCommits: unique_commits,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ query, results }, null, 2) }] };
  },
);

// --- Tool: cortex_explain ---
server.tool(
  'cortex_explain',
  'Combined code + git history search. Explains a symbol or concept with both current code and the history behind it.',
  {
    query: z.string().describe('Symbol, concept, or question to explain'),
    repo: z.string().optional().describe('Repository root path'),
  },
  async ({ query, repo }) => {
    const repoPath = getRepoPath(repo);
    const config = loadConfig(repoPath, false);
    const result = await explain(query, repoPath, config);
    return { content: [{ type: 'text', text: JSON.stringify({ query, ...result }, null, 2) }] };
  },
);

// --- Tool: cortex_file_profile ---
server.tool(
  'cortex_file_profile',
  'Quick lookup of a file\'s ownership, stability, risk score, and active signals.',
  {
    path: z.string().describe('File path to look up'),
    repo: z.string().optional().describe('Repository root path'),
  },
  async ({ path, repo }) => {
    const repoPath = getRepoPath(repo);
    const config = loadConfig(repoPath, false);
    // Ensure signals store is initialized
    const { initSignalsStore, initFileProfilesTable } = await import('./signals/store.js');
    await initSignalsStore(config.storeUri);
    await initFileProfilesTable();
    const profile = await getFileProfile(path);
    if (!profile) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `No profile found for ${path}. Run 'analyze' first.` }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  },
);

// --- Start server ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
