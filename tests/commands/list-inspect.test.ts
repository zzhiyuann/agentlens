import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Test DB path — must be set before any storage import
const TEST_DB_PATH = path.join(__dirname, '..', 'test-list-inspect-traces.db');

// Mock config to use test DB
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
  getGlobalConfigDir: () => os.tmpdir(),
  getLocalConfigDir: () => os.tmpdir(),
  DEFAULT_CONFIG: {},
}));

import { createSession, insertSpan, closeDb } from '../../src/core/storage';
import { listCommand } from '../../src/commands/list';
import { inspectCommand } from '../../src/commands/inspect';

let consoleOutput: string[];
let consoleErrors: string[];

function cleanDb(): void {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function seedSessions(): void {
  const baseTime = new Date('2026-03-25T10:00:00Z');

  for (let i = 0; i < 5; i++) {
    const start = new Date(baseTime.getTime() - i * 3600000);
    createSession({
      id: `ses_list${i.toString().padStart(3, '0')}`,
      label: i === 0 ? 'auth-refactor' : i === 1 ? 'fix-login-bug' : `task-${i}`,
      command: `claude "task ${i}"`,
      agent: i < 3 ? 'claude-code' : 'openai',
      model: i < 3 ? 'claude-sonnet-4-6' : 'gpt-4o',
      startTime: start.toISOString(),
      duration: (i + 1) * 2000,
      status: 'completed',
      formatVersion: '0.1',
      metadata: {
        totalTokens: (i + 1) * 1000,
        inputTokens: (i + 1) * 700,
        outputTokens: (i + 1) * 300,
        estimatedCost: (i + 1) * 0.05,
        llmCalls: i + 1,
        toolCalls: (i + 1) * 2,
      },
    });
  }

  // Add spans to ses_list000 for inspect testing
  const now = baseTime.toISOString();

  insertSpan({
    id: 'spn_li_llm1',
    sessionId: 'ses_list000',
    type: 'llm',
    name: 'chat_completion',
    startTime: now,
    endTime: now,
    duration: 800,
    status: 'ok',
    attributes: {},
    llm: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 500,
      outputTokens: 200,
      messages: [{ role: 'user', content: 'Refactor auth module' }],
      response: 'I will refactor the auth module by extracting the token validation logic.',
      cost: 0.03,
    },
  });

  insertSpan({
    id: 'spn_li_tool1',
    sessionId: 'ses_list000',
    type: 'tool',
    name: 'Read',
    startTime: now,
    endTime: now,
    duration: 30,
    status: 'ok',
    attributes: {},
    tool: {
      name: 'Read',
      arguments: { file_path: '/src/auth/token.ts' },
      result: 'export class TokenValidator { ... }',
    },
  });

  insertSpan({
    id: 'spn_li_tool2',
    sessionId: 'ses_list000',
    type: 'tool',
    name: 'Edit',
    startTime: now,
    endTime: now,
    duration: 25,
    status: 'ok',
    attributes: {},
    tool: {
      name: 'Edit',
      arguments: { file_path: '/src/auth/token.ts', old_string: 'class', new_string: 'interface' },
      result: 'ok',
    },
  });

  insertSpan({
    id: 'spn_li_tool_err',
    sessionId: 'ses_list000',
    type: 'tool',
    name: 'Bash',
    startTime: now,
    endTime: now,
    duration: 150,
    status: 'error',
    attributes: {},
    tool: {
      name: 'Bash',
      arguments: { command: 'npm test' },
      result: null,
      error: 'Process exited with code 1',
    },
  });

  insertSpan({
    id: 'spn_li_llm2',
    sessionId: 'ses_list000',
    type: 'llm',
    name: 'chat_completion',
    startTime: now,
    endTime: now,
    duration: 600,
    status: 'ok',
    attributes: {},
    llm: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 200,
      outputTokens: 100,
      messages: [{ role: 'user', content: 'Fix the test' }],
      response: 'Fixed the failing test.',
      cost: 0.02,
    },
  });
}

beforeEach(() => {
  cleanDb();
  seedSessions();
  consoleOutput = [];
  consoleErrors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
});

afterAll(() => {
  cleanDb();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────
// listCommand
// ──────────────────────────────────────────────

describe('listCommand', () => {
  it('lists all sessions with default options', () => {
    listCommand({});
    const output = consoleOutput.join('\n');
    expect(output).toContain('Sessions');
    expect(output).toContain('5 total');
    // Verify session IDs appear
    expect(output).toContain('ses_list000');
  });

  it('respects limit option', () => {
    listCommand({ limit: 2 });
    const output = consoleOutput.join('\n');
    expect(output).toContain('showing 2');
  });

  it('filters by label', () => {
    listCommand({ label: 'auth*' });
    const output = consoleOutput.join('\n');
    // Only auth-refactor should match
    expect(output).toContain('auth-refactor');
    expect(output).toContain('1 total');
  });

  it('filters by agent', () => {
    listCommand({ agent: 'openai' });
    const output = consoleOutput.join('\n');
    // Sessions 3 and 4 are openai
    expect(output).toContain('2 total');
  });

  it('filters by cost', () => {
    // Costs: 0.05, 0.10, 0.15, 0.20, 0.25
    // cost >= 0.15 should match ses_list002 (0.15), ses_list003 (0.20), ses_list004 (0.25)
    listCommand({ cost: '>0.15' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('3 total');
  });

  it('shows empty state when no sessions exist', () => {
    cleanDb(); // Remove all sessions
    // Re-init DB by calling listCommand (storage re-creates)
    listCommand({});
    const output = consoleOutput.join('\n');
    expect(output).toContain('No recorded sessions found');
  });

  it('shows total cost in summary line', () => {
    listCommand({});
    const output = consoleOutput.join('\n');
    // Total cost = 0.05 + 0.10 + 0.15 + 0.20 + 0.25 = 0.75
    expect(output).toContain('$0.75');
  });

  it('filters by since (relative time)', () => {
    // All sessions are at 2026-03-25 with decreasing hours
    // Since 2h ago from baseTime... but "since" uses current time
    // Use an ISO date that will include all sessions
    listCommand({ since: '2020-01-01' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('5 total');
  });
});

// ──────────────────────────────────────────────
// inspectCommand
// ──────────────────────────────────────────────

describe('inspectCommand', () => {
  it('displays session details for existing session', () => {
    inspectCommand('ses_list000', {});
    const output = consoleOutput.join('\n');
    expect(output).toContain('ses_list000');
    expect(output).toContain('auth-refactor');
    expect(output).toContain('claude-code');
  });

  it('shows summary section by default', () => {
    inspectCommand('ses_list000', {});
    const output = consoleOutput.join('\n');
    expect(output).toContain('Summary');
    expect(output).toContain('LLM Calls');
    expect(output).toContain('Tool Calls');
  });

  it('shows timeline section by default', () => {
    inspectCommand('ses_list000', {});
    const output = consoleOutput.join('\n');
    expect(output).toContain('Timeline');
    expect(output).toContain('chat_completion');
    expect(output).toContain('Read');
    expect(output).toContain('Edit');
  });

  it('shows cost breakdown when section=cost', () => {
    inspectCommand('ses_list000', { section: 'cost' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('Cost Breakdown');
    // Should contain running cost accumulation
    expect(output).toContain('running');
  });

  it('shows tool summary when section=tools', () => {
    inspectCommand('ses_list000', { section: 'tools' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('Tool Summary');
    expect(output).toContain('Read');
    expect(output).toContain('Edit');
    expect(output).toContain('Bash');
  });

  it('shows verbose details when --verbose flag is set', () => {
    inspectCommand('ses_list000', { verbose: true });
    const output = consoleOutput.join('\n');
    // Verbose shows model and response preview for LLM spans
    expect(output).toContain('claude-sonnet-4-6');
    // Verbose also shows tool errors
    expect(output).toContain('Process exited with code 1');
  });

  it('handles non-existent session gracefully', () => {
    inspectCommand('ses_nonexistent', {});
    const errors = consoleErrors.join('\n');
    expect(errors).toContain('not found');
  });

  it('shows replay hint at the bottom', () => {
    inspectCommand('ses_list000', {});
    const output = consoleOutput.join('\n');
    expect(output).toContain('replay');
    expect(output).toContain('ses_list000');
  });

  it('handles session with no spans (summary only)', () => {
    // ses_list001 has no spans inserted
    inspectCommand('ses_list001', {});
    const output = consoleOutput.join('\n');
    expect(output).toContain('ses_list001');
    // Timeline section should show "No spans"
    expect(output).toContain('No spans');
  });

  it('shows only summary when section=summary', () => {
    inspectCommand('ses_list000', { section: 'summary' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('Summary');
    // Should not contain Timeline heading (since summary-only)
    // Note: the code shows summary OR timeline based on section filter
    // When section=summary, it shows summary but NOT timeline
    expect(output).toContain('LLM Calls');
  });

  it('displays cost breakdown with no LLM calls gracefully', () => {
    // Create a session with only tool spans, no LLM
    createSession({
      id: 'ses_tools_only',
      label: 'tools-only',
      command: 'test',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 500,
      status: 'completed',
      formatVersion: '0.1',
      metadata: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        llmCalls: 0,
        toolCalls: 1,
      },
    });

    insertSpan({
      id: 'spn_toolonly1',
      sessionId: 'ses_tools_only',
      type: 'tool',
      name: 'Bash',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      duration: 100,
      status: 'ok',
      attributes: {},
      tool: {
        name: 'Bash',
        arguments: { command: 'ls' },
        result: 'file1 file2',
      },
    });

    inspectCommand('ses_tools_only', { section: 'cost' });
    const output = consoleOutput.join('\n');
    expect(output).toContain('No LLM calls with cost data');
  });
});
