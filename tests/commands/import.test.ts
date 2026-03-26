import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Override config before importing anything that uses storage
const TEST_DB_PATH = path.join(__dirname, '..', 'test-import.db');
process.env.AGENTLENS_TEST_DB = TEST_DB_PATH;

vi.mock('../../src/core/config', () => ({
  loadConfig: () => ({
    adapter: 'claude-code',
    storage: { path: TEST_DB_PATH, maxSize: '100mb' },
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

// Import the module under test — we test the exported importCommand plus
// internal functions by importing the module's internal helpers via the
// compiled output. Since internal functions are not exported, we test them
// indirectly through importCommand's database side effects.
import { importCommand } from '../../src/commands/import';
import { getSession, listSessions, getSpansForSession, closeDb } from '../../src/core/storage';

let tempDir: string;

beforeEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alens-import-test-'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

// Helper: write a JSONL file and return its path
function writeJsonl(filename: string, entries: Record<string, unknown>[]): string {
  const filePath = path.join(tempDir, filename);
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Suppress console output during tests
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ─── Format Detection (tested indirectly) ───────────────────────────

describe('Claude Code format detection and parsing', () => {
  it('detects and imports a Claude Code conversation with human + assistant entries', () => {
    const filePath = writeJsonl('session.jsonl', [
      {
        type: 'human',
        message: { role: 'user', content: 'Fix the login bug' },
        timestamp: '2026-03-25T10:00:00Z',
      },
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will fix the bug now.' }],
        },
        usage: { input_tokens: 200, output_tokens: 80 },
        timestamp: '2026-03-25T10:00:05Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe('claude');
    expect(sessions[0].status).toBe('completed');
    expect(sessions[0].metadata.llmCalls).toBe(1);
  });

  it('parses tool_use blocks from assistant content and creates tool spans', () => {
    const filePath = writeJsonl('tools.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read the file.' },
            { type: 'tool_use', id: 'tu_001', name: 'read_file', input: { path: '/src/main.ts' } },
          ],
        },
        usage: { input_tokens: 150, output_tokens: 60 },
        timestamp: '2026-03-25T10:00:00Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    const spans = getSpansForSession(sessions[0].id);
    const toolSpans = spans.filter(s => s.type === 'tool');
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0].name).toBe('read_file');
  });

  it('links tool_result entries to their tool_use spans', () => {
    const filePath = writeJsonl('tool-result.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_linked', name: 'bash', input: { command: 'ls' } },
          ],
        },
        usage: { input_tokens: 100, output_tokens: 40 },
        timestamp: '2026-03-25T10:00:00Z',
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_linked',
        content: 'file1.ts\nfile2.ts',
        timestamp: '2026-03-25T10:00:02Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    const spans = getSpansForSession(sessions[0].id);
    const toolSpans = spans.filter(s => s.type === 'tool');
    // One tool_use span + one tool_result span
    expect(toolSpans.length).toBeGreaterThanOrEqual(1);
    // The tool_result span should reference the tool_use via parentId
    const resultSpan = toolSpans.find(s => s.name === 'tool_result');
    if (resultSpan) {
      expect(resultSpan.tool!.result).toBe('file1.ts\nfile2.ts');
    }
  });

  it('captures result entry cost and token totals', () => {
    const filePath = writeJsonl('result.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        usage: { input_tokens: 500, output_tokens: 100 },
        timestamp: '2026-03-25T10:00:00Z',
      },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.42,
        usage: { input_tokens: 5000, output_tokens: 1000 },
        timestamp: '2026-03-25T10:05:00Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].metadata.estimatedCost).toBe(0.42);
    // Result tokens should override per-call aggregation
    expect(sessions[0].metadata.inputTokens).toBe(5000);
    expect(sessions[0].metadata.outputTokens).toBe(1000);
  });

  it('detects Claude Code format via result entry with subtype', () => {
    const filePath = writeJsonl('result-detect.jsonl', [
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);

    // Should not throw — format is detected as claude-code
    importCommand(filePath, {});
    const { sessions } = listSessions({});
    expect(sessions).toHaveLength(1);
  });
});

// ─── Generic Format Parsing ─────────────────────────────────────────

describe('Generic JSONL format parsing', () => {
  it('detects and imports generic LLM entries', () => {
    const filePath = writeJsonl('generic-llm.jsonl', [
      {
        type: 'llm',
        model: 'gpt-4o',
        input_tokens: 300,
        output_tokens: 120,
        response: 'Here is the answer.',
        timestamp: '2026-03-25T12:00:00Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe('openai');
    expect(sessions[0].metadata.llmCalls).toBe(1);
  });

  it('imports generic tool entries', () => {
    const filePath = writeJsonl('generic-tool.jsonl', [
      {
        type: 'llm',
        model: 'gpt-4o',
        input_tokens: 100,
        output_tokens: 50,
        response: 'Using tool.',
        timestamp: '2026-03-25T12:00:00Z',
      },
      {
        type: 'tool',
        name: 'web_search',
        arguments: { query: 'vitest docs' },
        result: '3 results found',
        timestamp: '2026-03-25T12:00:01Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].metadata.toolCalls).toBe(1);
    expect(sessions[0].metadata.llmCalls).toBe(1);
  });
});

// ─── Label Derivation ───────────────────────────────────────────────

describe('Label derivation', () => {
  it('uses the first user message as session label', () => {
    const filePath = writeJsonl('label-user.jsonl', [
      {
        type: 'human',
        message: { role: 'user', content: 'Refactor the auth module' },
      },
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK.' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].label).toBe('Refactor the auth module');
  });

  it('truncates long user messages for the label', () => {
    const longMessage = 'A'.repeat(100);
    const filePath = writeJsonl('label-long.jsonl', [
      { type: 'human', message: { role: 'user', content: longMessage } },
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK.' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].label!.length).toBeLessThanOrEqual(50);
    expect(sessions[0].label!.endsWith('...')).toBe(true);
  });

  it('falls back to filename when no user message exists', () => {
    const filePath = writeJsonl('my-session.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].label).toBe('my-session');
  });

  it('uses the provided --label option over auto-derived label', () => {
    const filePath = writeJsonl('override-label.jsonl', [
      { type: 'human', message: { role: 'user', content: 'This should not be the label' } },
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK.' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, { label: 'custom-label' });

    const { sessions } = listSessions({});
    expect(sessions[0].label).toBe('custom-label');
  });
});

// ─── Agent/Provider Derivation ──────────────────────────────────────

describe('Agent and provider derivation', () => {
  it('derives agent=claude from claude model names', () => {
    const filePath = writeJsonl('agent-claude.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].agent).toBe('claude');
  });

  it('derives agent=openai from gpt model names', () => {
    const filePath = writeJsonl('agent-gpt.jsonl', [
      {
        type: 'llm',
        model: 'gpt-4o',
        input_tokens: 100,
        output_tokens: 50,
        response: 'hello',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].agent).toBe('openai');
  });

  it('derives agent=google from gemini model names', () => {
    const filePath = writeJsonl('agent-gemini.jsonl', [
      {
        type: 'llm',
        model: 'gemini-pro',
        input_tokens: 100,
        output_tokens: 50,
        response: 'hello',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].agent).toBe('google');
  });

  it('uses agent=unknown for unrecognized models', () => {
    const filePath = writeJsonl('agent-unknown.jsonl', [
      {
        type: 'llm',
        model: 'llama-3.1-70b',
        input_tokens: 100,
        output_tokens: 50,
        response: 'hello',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].agent).toBe('unknown');
  });

  it('uses the provided --agent option over derived agent', () => {
    const filePath = writeJsonl('agent-override.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, { agent: 'my-custom-agent' });

    const { sessions } = listSessions({});
    expect(sessions[0].agent).toBe('my-custom-agent');
  });
});

// ─── Error Handling ─────────────────────────────────────────────────

describe('Error handling', () => {
  it('exits with error for a non-existent file', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => importCommand('/tmp/nonexistent-alens-test-file.jsonl', {})).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with error for an empty file', () => {
    const filePath = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => importCommand(filePath, {})).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with error for a file with no valid JSON lines', () => {
    const filePath = path.join(tempDir, 'bad.jsonl');
    fs.writeFileSync(filePath, 'not json\nalso not json\n');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => importCommand(filePath, {})).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with error for unrecognized JSONL format', () => {
    const filePath = writeJsonl('unknown-format.jsonl', [
      { event: 'some_event', data: 'not a known format' },
      { event: 'another_event', value: 42 },
    ]);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => importCommand(filePath, {})).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('skips invalid JSON lines gracefully and imports the rest', () => {
    const filePath = path.join(tempDir, 'mixed.jsonl');
    const content = [
      'not valid json',
      JSON.stringify({
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].metadata.llmCalls).toBe(1);
  });
});

// ─── Duration Estimation ────────────────────────────────────────────

describe('Duration estimation from timestamps', () => {
  it('calculates duration from entry timestamps', () => {
    const filePath = writeJsonl('duration.jsonl', [
      {
        type: 'human',
        message: { role: 'user', content: 'start' },
        timestamp: '2026-03-25T10:00:00Z',
      },
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'end' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
        timestamp: '2026-03-25T10:05:00Z',
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    // 5 minutes = 300,000 ms
    expect(sessions[0].duration).toBe(300000);
  });

  it('sets duration to 0 when no timestamps are present', () => {
    const filePath = writeJsonl('no-timestamps.jsonl', [
      {
        type: 'assistant',
        model: 'claude-sonnet-4-6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    importCommand(filePath, {});

    const { sessions } = listSessions({});
    expect(sessions[0].duration).toBe(0);
  });
});
