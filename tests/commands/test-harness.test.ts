import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Test DB path — must be set before any storage import
const TEST_DB_PATH = path.join(__dirname, '..', 'test-harness-traces.db');

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
import { testRunCommand, testValidateCommand, testListCommand } from '../../src/commands/test';

// Temp directory for YAML scenario files
let tempDir: string;

function cleanDb(): void {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function seedSession(): void {
  const now = new Date().toISOString();

  createSession({
    id: 'ses_harness001',
    label: 'refund-flow-test',
    command: 'claude "test refund"',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
    startTime: now,
    duration: 4500,
    status: 'completed',
    formatVersion: '0.1',
    metadata: {
      totalTokens: 8000,
      inputTokens: 5000,
      outputTokens: 3000,
      estimatedCost: 0.35,
      llmCalls: 2,
      toolCalls: 3,
    },
  });

  // LLM span 1
  insertSpan({
    id: 'spn_h_llm1',
    sessionId: 'ses_harness001',
    type: 'llm',
    name: 'chat_completion',
    startTime: now,
    endTime: now,
    duration: 1500,
    status: 'ok',
    attributes: {},
    llm: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 2500,
      outputTokens: 1500,
      messages: [{ role: 'user', content: 'Process a refund for order 123' }],
      response: 'I will process the refund for order 123. Let me read the relevant file first.',
      cost: 0.15,
    },
  });

  // Tool span: Read
  insertSpan({
    id: 'spn_h_tool1',
    sessionId: 'ses_harness001',
    type: 'tool',
    name: 'Read',
    startTime: now,
    endTime: now,
    duration: 50,
    status: 'ok',
    attributes: {},
    tool: {
      name: 'Read',
      arguments: { file_path: '/src/orders/refund.ts' },
      result: 'export function processRefund() { ... }',
    },
  });

  // Tool span: Edit
  insertSpan({
    id: 'spn_h_tool2',
    sessionId: 'ses_harness001',
    type: 'tool',
    name: 'Edit',
    startTime: now,
    endTime: now,
    duration: 30,
    status: 'ok',
    attributes: {},
    tool: {
      name: 'Edit',
      arguments: { file_path: '/src/orders/refund.ts', old_string: 'abc', new_string: 'def' },
      result: 'ok',
    },
  });

  // Tool span: Bash
  insertSpan({
    id: 'spn_h_tool3',
    sessionId: 'ses_harness001',
    type: 'tool',
    name: 'Bash',
    startTime: now,
    endTime: now,
    duration: 200,
    status: 'ok',
    attributes: {},
    tool: {
      name: 'Bash',
      arguments: { command: 'npm test' },
      result: 'All tests passed',
    },
  });

  // LLM span 2
  insertSpan({
    id: 'spn_h_llm2',
    sessionId: 'ses_harness001',
    type: 'llm',
    name: 'chat_completion',
    startTime: now,
    endTime: now,
    duration: 1200,
    status: 'ok',
    attributes: {},
    llm: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 2500,
      outputTokens: 1500,
      messages: [{ role: 'user', content: 'continue' }],
      response: 'The refund for order 123 has been processed successfully. All tests pass.',
      cost: 0.20,
    },
  });
}

function writeScenario(name: string, content: object): string {
  const filePath = path.join(tempDir, `${name}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(content), 'utf-8');
  return filePath;
}

// Capture console output
let consoleOutput: string[];
let consoleErrors: string[];
const origLog = console.log;
const origError = console.error;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-test-harness-'));
});

beforeEach(() => {
  cleanDb();
  seedSession();
  consoleOutput = [];
  consoleErrors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterAll(() => {
  cleanDb();
  vi.restoreAllMocks();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────
// testRunCommand — assertion evaluation via YAML
// ──────────────────────────────────────────────

describe('testRunCommand — assertion evaluation via replay', () => {
  it('passes tool_called when tool is in spans', async () => {
    const filePath = writeScenario('tool-called-pass', {
      name: 'tool-called-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { tool_called: 'Read' } },
      ],
    });

    // testRunCommand calls process.exit — we catch it
    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
    const output = consoleOutput.join('\n');
    expect(output).toContain('PASS');
  });

  it('fails tool_called when tool is NOT in spans', async () => {
    const filePath = writeScenario('tool-called-fail', {
      name: 'tool-called-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { tool_called: 'Write' } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
    const output = consoleOutput.join('\n');
    expect(output).toContain('FAIL');
  });

  it('passes response_contains when text is in LLM response', async () => {
    const filePath = writeScenario('response-contains-pass', {
      name: 'response-contains-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { response_contains: 'refund' } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails response_contains when text is NOT in response', async () => {
    const filePath = writeScenario('response-contains-fail', {
      name: 'response-contains-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { response_contains: 'elephant' } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('passes response_matches with valid regex', async () => {
    const filePath = writeScenario('response-matches-pass', {
      name: 'response-matches-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { response_matches: 'refund.*order\\s+123' } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails response_matches when pattern does not match', async () => {
    const filePath = writeScenario('response-matches-fail', {
      name: 'response-matches-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { response_matches: '^ZZZZZ' } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('passes cost_under when cost is below threshold', async () => {
    // Session cost is 0.35 total
    const filePath = writeScenario('cost-under-pass', {
      name: 'cost-under-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { cost_under: 0.50 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails cost_under when cost exceeds threshold', async () => {
    const filePath = writeScenario('cost-under-fail', {
      name: 'cost-under-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { cost_under: 0.10 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('passes duration_under when duration is below threshold', async () => {
    // Total duration from spans: 1500 + 50 + 30 + 200 + 1200 = 2980
    const filePath = writeScenario('duration-under-pass', {
      name: 'duration-under-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Check' },
        { assert: { duration_under: 5000 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails duration_under when duration exceeds threshold', async () => {
    const filePath = writeScenario('duration-under-fail', {
      name: 'duration-under-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Check' },
        { assert: { duration_under: 100 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('passes tokens_under when tokens are below threshold', async () => {
    // Total tokens from LLM spans: (2500+1500) + (2500+1500) = 8000
    const filePath = writeScenario('tokens-under-pass', {
      name: 'tokens-under-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Check' },
        { assert: { tokens_under: 10000 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails tokens_under when tokens exceed threshold', async () => {
    const filePath = writeScenario('tokens-under-fail', {
      name: 'tokens-under-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Check' },
        { assert: { tokens_under: 1000 } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('passes tool_args partial match', async () => {
    const filePath = writeScenario('tool-args-pass', {
      name: 'tool-args-pass',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { tool_args: { file_path: '/src/orders/refund.ts' } } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('fails tool_args when no tool call matches', async () => {
    const filePath = writeScenario('tool-args-fail', {
      name: 'tool-args-fail',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Process a refund' },
        { assert: { tool_args: { file_path: '/nonexistent/path.ts' } } },
      ],
    });

    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(1)');
  });

  it('skips all assertions in dry-run mode (no matching session)', async () => {
    const filePath = writeScenario('dry-run', {
      name: 'dry-run-nonexistent',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_does_not_exist' },
      scenario: [
        { user: 'Hello' },
        { assert: { tool_called: 'Read' } },
        { assert: { response_contains: 'test' } },
        { assert: { cost_under: 1.0 } },
      ],
    });

    // All skipped means 0 failures — exit 0
    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
    const output = consoleOutput.join('\n');
    expect(output).toContain('SKIP');
    expect(output).toContain('Dry-run');
  });

  it('runs a directory of scenarios', async () => {
    // Create a subdirectory with multiple scenarios
    const subDir = path.join(tempDir, 'multi');
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);

    const s1 = {
      name: 'scenario-a',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Hello' },
        { assert: { tool_called: 'Read' } },
      ],
    };
    const s2 = {
      name: 'scenario-b',
      agents: [{ role: 'assistant' }],
      settings: { session: 'ses_harness001' },
      scenario: [
        { user: 'Hello' },
        { assert: { tool_called: 'Edit' } },
      ],
    };

    fs.writeFileSync(path.join(subDir, 'a.yaml'), yaml.dump(s1), 'utf-8');
    fs.writeFileSync(path.join(subDir, 'b.yml'), yaml.dump(s2), 'utf-8');

    await expect(testRunCommand(subDir, {})).rejects.toThrow('process.exit(0)');
    const output = consoleOutput.join('\n');
    // Both should pass
    expect(output).toContain('a.yaml');
    expect(output).toContain('b.yml');
  });

  it('handles invalid YAML gracefully', async () => {
    const filePath = path.join(tempDir, 'bad.yaml');
    fs.writeFileSync(filePath, '{{{{invalid yaml!!!', 'utf-8');

    // Should not crash — returns error status
    await expect(testRunCommand(filePath, {})).rejects.toThrow('process.exit(0)');
  });

  it('exits 1 when scenario path does not exist', async () => {
    await expect(testRunCommand('/nonexistent/path/scenario.yaml', {})).rejects.toThrow('process.exit(1)');
  });
});

// ──────────────────────────────────────────────
// testValidateCommand
// ──────────────────────────────────────────────

describe('testValidateCommand', () => {
  it('validates a well-formed scenario', () => {
    const filePath = writeScenario('valid', {
      name: 'valid-scenario',
      agents: [{ role: 'assistant', model: 'claude-sonnet-4-6' }],
      scenario: [
        { user: 'Hello' },
        { assert: { response_contains: 'hi' } },
      ],
    });

    // Valid scenario does not call process.exit(1)
    testValidateCommand(filePath);
    const output = consoleOutput.join('\n');
    expect(output).toContain('PASS');
    expect(output).toContain('Valid');
  });

  it('rejects scenario missing name', () => {
    const filePath = writeScenario('no-name', {
      agents: [{ role: 'assistant' }],
      scenario: [{ user: 'Hello' }],
    });

    expect(() => testValidateCommand(filePath)).toThrow('process.exit(1)');
    const output = consoleOutput.join('\n');
    expect(output).toContain('FAIL');
  });

  it('rejects scenario missing agents', () => {
    const filePath = writeScenario('no-agents', {
      name: 'no-agents',
      scenario: [{ user: 'Hello' }],
    });

    expect(() => testValidateCommand(filePath)).toThrow('process.exit(1)');
  });

  it('warns when no assertions found', () => {
    const filePath = writeScenario('no-asserts', {
      name: 'no-asserts',
      agents: [{ role: 'assistant' }],
      scenario: [{ user: 'Hello' }],
    });

    // Warning does not cause process.exit(1) — just prints WARN
    testValidateCommand(filePath);
    const output = consoleOutput.join('\n');
    expect(output).toContain('WARN');
    expect(output).toContain('No assertions');
  });

  it('exits 1 for non-existent file', () => {
    expect(() => testValidateCommand('/nonexistent/foo.yaml')).toThrow('process.exit(1)');
  });
});

// ──────────────────────────────────────────────
// testListCommand
// ──────────────────────────────────────────────

describe('testListCommand', () => {
  it('reports no scenarios when directory is empty', () => {
    // testListCommand searches cwd/tests, cwd/.agentlens/tests, cwd/test
    // We set cwd to a temp dir with no YAML files
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-empty-'));
    const origCwd = process.cwd();
    vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);

    testListCommand();
    const output = consoleOutput.join('\n');
    expect(output).toContain('No test scenarios found');

    vi.mocked(process.cwd).mockReturnValue(origCwd);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('lists scenarios from the tests/ directory', () => {
    // Create a temp project dir with tests/ containing YAML files
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-proj-'));
    const testsDir = path.join(projDir, 'tests');
    fs.mkdirSync(testsDir);

    const scenario = {
      name: 'my-test',
      agents: [{ role: 'assistant' }],
      scenario: [
        { user: 'Hello' },
        { assert: { tool_called: 'Read' } },
      ],
    };
    fs.writeFileSync(path.join(testsDir, 'example.yaml'), yaml.dump(scenario), 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(projDir);

    testListCommand();
    const output = consoleOutput.join('\n');
    expect(output).toContain('Test Scenarios');
    expect(output).toContain('example.yaml');

    vi.mocked(process.cwd).mockReturnValue(process.cwd());
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});
