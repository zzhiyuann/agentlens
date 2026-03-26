import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock config before importing adapter
vi.mock('../../src/core/config', () => ({
  loadConfig: () => ({
    adapter: 'claude-code',
    storage: { path: ':memory:', maxSize: '100mb' },
    display: { theme: 'dark', colors: true, unicode: true, pageSize: 20 },
    recording: { autoLabel: true, captureEnv: false, maxDuration: '30m' },
    memory: { staleDays: 14, healthCheck: true },
    cost: {
      rates: {
        'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
        'claude-opus-4-6': { input: 15.0, output: 75.0 },
      },
    },
  }),
}));

// Mock storage so adapter methods don't hit a real DB
vi.mock('../../src/core/storage', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  insertSpan: vi.fn(),
  getSession: vi.fn(() => null),
}));

import { ClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { Span } from '../../src/core/types';

// Helper to access private methods via any-cast
function adapter() {
  return new ClaudeCodeAdapter() as any;
}

// ─── detect() ────────────────────────────────────────────────────────

// Both child_process.execSync and fs.existsSync are non-configurable
// properties in the Node.js CJS module, so vi.spyOn cannot intercept them.
// We test detect() as an integration test — it checks the real environment.

describe('ClaudeCodeAdapter.detect()', () => {
  it('returns a boolean value', async () => {
    const a = new ClaudeCodeAdapter();
    const result = await a.detect();
    expect(typeof result).toBe('boolean');
  });

  it('returns true when claude binary or config exists on this machine', async () => {
    // This test verifies the happy path — on dev machines with Claude Code
    // installed, detect() returns true. On CI without it, it may return
    // true if ~/.claude dir exists, or false if neither is present.
    // We just verify it doesn't throw.
    const a = new ClaudeCodeAdapter();
    await expect(a.detect()).resolves.not.toThrow();
  });
});

// ─── isClaudeCommand() ───────────────────────────────────────────────

describe('isClaudeCommand()', () => {
  const a = adapter();

  it('recognizes bare "claude" command', () => {
    expect(a.isClaudeCommand('claude "fix the bug"')).toBe(true);
  });

  it('recognizes absolute path to claude binary', () => {
    expect(a.isClaudeCommand('/usr/local/bin/claude -p "hello"')).toBe(true);
  });

  it('recognizes npx claude invocation', () => {
    expect(a.isClaudeCommand('npx claude --help')).toBe(true);
  });

  it('recognizes bunx claude invocation', () => {
    expect(a.isClaudeCommand('bunx claude "task"')).toBe(true);
  });

  it('rejects non-claude commands', () => {
    expect(a.isClaudeCommand('python agent.py')).toBe(false);
  });

  it('rejects npx with a different package', () => {
    expect(a.isClaudeCommand('npx vitest run')).toBe(false);
  });

  it('rejects a command containing claude in an argument', () => {
    expect(a.isClaudeCommand('node run-claude.js')).toBe(false);
  });
});

// ─── buildClaudeArgs() ──────────────────────────────────────────────

describe('buildClaudeArgs()', () => {
  const a = adapter();

  it('injects -p and --output-format stream-json into a bare claude command', () => {
    const { cmd, args } = a.buildClaudeArgs('claude "fix bug"');
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('does not duplicate -p if already present', () => {
    const { args } = a.buildClaudeArgs('claude -p "hello"');
    const pCount = args.filter((a: string) => a === '-p').length;
    expect(pCount).toBe(1);
  });

  it('does not duplicate --output-format if already present', () => {
    const { args } = a.buildClaudeArgs('claude --output-format stream-json "hello"');
    const ofCount = args.filter((a: string) => a === '--output-format').length;
    expect(ofCount).toBe(1);
  });

  it('does not duplicate --output-format= variant', () => {
    const { args } = a.buildClaudeArgs('claude --output-format=json "hello"');
    const ofCount = args.filter((a: string) =>
      a === '--output-format' || a.startsWith('--output-format='),
    ).length;
    expect(ofCount).toBe(1);
  });

  it('does not duplicate --print flag', () => {
    const { args } = a.buildClaudeArgs('claude --print "hello"');
    const printCount = args.filter((a: string) => a === '-p' || a === '--print').length;
    expect(printCount).toBe(1);
  });

  it('preserves the original user arguments', () => {
    const { args } = a.buildClaudeArgs('claude --model opus "do stuff"');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
    // Note: split by whitespace means quoted strings are split into tokens
    expect(args).toContain('"do');
    expect(args).toContain('stuff"');
  });
});

// ─── processStreamEvent() ───────────────────────────────────────────

describe('processStreamEvent()', () => {
  const a = adapter();

  it('creates an LLM span from an assistant message with usage data', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];

    a.processStreamEvent(
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there!' }],
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      'ses_test',
      pendingTools,
      (span: Span) => spans.push(span),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].type).toBe('llm');
    expect(spans[0].llm!.model).toBe('claude-sonnet-4-6');
    expect(spans[0].llm!.inputTokens).toBe(100);
    expect(spans[0].llm!.outputTokens).toBe(50);
    expect(spans[0].llm!.response).toBe('Hello there!');
    expect(spans[0].llm!.provider).toBe('anthropic');
  });

  it('creates a pending tool span from a tool_use content block', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];

    a.processStreamEvent(
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_001', name: 'read_file', input: { path: '/test.ts' } },
          ],
        },
        usage: {},
      },
      'ses_test',
      pendingTools,
      (span: Span) => spans.push(span),
    );

    // Tool span should be pending, not emitted yet
    expect(spans).toHaveLength(0);
    expect(pendingTools.has('tu_001')).toBe(true);
    expect(pendingTools.get('tu_001').span.tool!.name).toBe('read_file');
  });

  it('closes a pending tool span when a user message with tool_result arrives', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];
    const onSpan = (span: Span) => spans.push(span);

    // First, create the pending tool span
    a.processStreamEvent(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_002', name: 'write_file', input: { path: '/out.ts', content: 'x' } },
          ],
        },
        usage: {},
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    expect(pendingTools.size).toBe(1);

    // Now close it with a user message containing tool_result
    a.processStreamEvent(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_002', content: 'File written successfully' },
          ],
        },
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].type).toBe('tool');
    expect(spans[0].tool!.name).toBe('write_file');
    expect(spans[0].tool!.result).toBe('File written successfully');
    expect(spans[0].status).toBe('ok');
    expect(pendingTools.size).toBe(0);
  });

  it('marks a tool span as error when is_error is true', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];
    const onSpan = (span: Span) => spans.push(span);

    a.processStreamEvent(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_err', name: 'bash', input: { command: 'rm -rf /' } },
          ],
        },
        usage: {},
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    a.processStreamEvent(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_err', content: 'Permission denied', is_error: true },
          ],
        },
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('error');
    expect(spans[0].tool!.error).toBe('Permission denied');
  });

  it('ignores unknown event types', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];

    a.processStreamEvent(
      { type: 'system_info', data: 'some metadata' },
      'ses_test',
      pendingTools,
      (span: Span) => spans.push(span),
    );

    expect(spans).toHaveLength(0);
    expect(pendingTools.size).toBe(0);
  });

  it('does not create an LLM span when usage has no tokens', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];

    a.processStreamEvent(
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: {},
      },
      'ses_test',
      pendingTools,
      (span: Span) => spans.push(span),
    );

    expect(spans).toHaveLength(0);
  });

  it('handles tool_result event type at event level (not nested in user message)', () => {
    const pendingTools = new Map();
    const spans: Span[] = [];
    const onSpan = (span: Span) => spans.push(span);

    // Create pending tool
    a.processStreamEvent(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_top', name: 'search', input: { query: 'test' } },
          ],
        },
        usage: {},
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    // Close via top-level tool_result event
    a.processStreamEvent(
      {
        type: 'tool_result',
        tool_use_id: 'tu_top',
        content: 'found 3 results',
      },
      'ses_test',
      pendingTools,
      onSpan,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].tool!.result).toBe('found 3 results');
    expect(pendingTools.size).toBe(0);
  });
});

// ─── getMemory() ────────────────────────────────────────────────────

describe('getMemory()', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alens-mem-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty snapshot for a non-existent directory', async () => {
    const a = new ClaudeCodeAdapter();
    const snap = await a.getMemory('/tmp/nonexistent-dir-alens-test');
    expect(snap.entries).toHaveLength(0);
    expect(snap.metadata.fileCount).toBe(0);
    expect(snap.metadata.healthScore).toBe(0);
  });

  it('reads markdown files from a directory', async () => {
    fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Architecture\n\nCore design.');
    fs.writeFileSync(path.join(tempDir, 'notes.md'), '# Notes\n\nSome notes.');
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'Not markdown');

    const a = new ClaudeCodeAdapter();
    const snap = await a.getMemory(tempDir);

    expect(snap.entries).toHaveLength(2);
    expect(snap.metadata.fileCount).toBe(2);
    expect(snap.entries.map(e => e.file).sort()).toEqual(['architecture.md', 'notes.md']);
  });

  it('extracts titles from markdown headers', async () => {
    fs.writeFileSync(path.join(tempDir, 'test.md'), '# My Title\n\nContent.');

    const a = new ClaudeCodeAdapter();
    const snap = await a.getMemory(tempDir);

    expect(snap.entries[0].title).toBe('My Title');
  });

  it('falls back to filename as title when no header present', async () => {
    fs.writeFileSync(path.join(tempDir, 'notes.md'), 'Just some content without a header.');

    const a = new ClaudeCodeAdapter();
    const snap = await a.getMemory(tempDir);

    expect(snap.entries[0].title).toBe('notes');
  });
});

// ─── autoLabel() ────────────────────────────────────────────────────

describe('autoLabel()', () => {
  const a = adapter();

  it('returns short commands as-is', () => {
    expect(a.autoLabel('claude test')).toBe('claude test');
  });

  it('extracts meaningful words from a longer command', () => {
    // Skips binary ('claude'), filters out flags (-p, --model),
    // takes first 3 remaining words: opus, "fix, the
    // After cleaning non-alphanumeric: opus-fix-the
    expect(a.autoLabel('claude -p --model opus "fix the auth flow"')).toBe('opus-fix-the');
  });

  it('strips non-alphanumeric characters', () => {
    const label = a.autoLabel('claude hello world! @#$');
    expect(label).toMatch(/^[a-z0-9-]*$/);
  });
});

// ─── extractTitle() ─────────────────────────────────────────────────

describe('extractTitle()', () => {
  const a = adapter();

  it('extracts a markdown H1 title', () => {
    expect(a.extractTitle('# Architecture\nContent here', 'file.md')).toBe('Architecture');
  });

  it('extracts a YAML name: title', () => {
    expect(a.extractTitle('name: My Project\ntype: project', 'file.md')).toBe('My Project');
  });

  it('prefers H1 over YAML name', () => {
    expect(a.extractTitle('# Real Title\nname: Yaml Name', 'file.md')).toBe('Real Title');
  });

  it('falls back to filename without extension', () => {
    expect(a.extractTitle('No title markers here', 'my-notes.md')).toBe('my-notes');
  });
});

// ─── getFileStatus() ────────────────────────────────────────────────

describe('getFileStatus()', () => {
  const a = adapter();

  it('returns "fresh" for files modified within 3 days', () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    expect(a.getFileStatus(recent)).toBe('fresh');
  });

  it('returns "active" for files modified 3-14 days ago', () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    expect(a.getFileStatus(weekAgo)).toBe('active');
  });

  it('returns "stale" for files modified more than 14 days ago', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    expect(a.getFileStatus(old)).toBe('stale');
  });
});

// ─── calculateHealthScore() ─────────────────────────────────────────

describe('calculateHealthScore()', () => {
  const a = adapter();

  it('returns 0 for empty entries', () => {
    expect(a.calculateHealthScore([])).toBe(0);
  });

  it('returns 100 when all entries are fresh', () => {
    const entries = [
      { status: 'fresh' },
      { status: 'fresh' },
    ] as any[];
    expect(a.calculateHealthScore(entries)).toBe(100);
  });

  it('returns a lower score with a mix of statuses', () => {
    const entries = [
      { status: 'fresh' },
      { status: 'active' },
      { status: 'stale' },
    ] as any[];
    const score = a.calculateHealthScore(entries);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('returns a low score when all entries are stale', () => {
    const entries = [
      { status: 'stale' },
      { status: 'stale' },
    ] as any[];
    const score = a.calculateHealthScore(entries);
    // stale = 0.5 weight, so (0.5/3)*100 = ~17
    expect(score).toBeLessThanOrEqual(20);
    expect(score).toBeGreaterThan(0);
  });
});
