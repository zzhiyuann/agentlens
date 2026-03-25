import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Override config before importing storage
const TEST_DB_PATH = path.join(__dirname, '..', 'test-traces.db');
process.env.AGENTLENS_TEST_DB = TEST_DB_PATH;

// Mock config to use test DB
import { vi } from 'vitest';
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

import {
  createSession, getSession, listSessions, updateSession,
  insertSpan, getSpansForSession, deleteSession, getStats, closeDb
} from '../../src/core/storage';

beforeEach(() => {
  // Clean up test DB
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
  if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
  if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
});

describe('Session storage', () => {
  it('creates and retrieves a session', () => {
    createSession({
      id: 'ses_test001',
      label: 'test-session',
      command: 'claude "test"',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 5000,
      status: 'completed',
      formatVersion: '0.1',
      metadata: {
        totalTokens: 1000,
        inputTokens: 700,
        outputTokens: 300,
        estimatedCost: 0.05,
        llmCalls: 3,
        toolCalls: 5,
      },
    });

    const session = getSession('ses_test001');
    expect(session).toBeTruthy();
    expect(session!.id).toBe('ses_test001');
    expect(session!.label).toBe('test-session');
    expect(session!.agent).toBe('claude-code');
    expect(session!.metadata.totalTokens).toBe(1000);
    expect(session!.metadata.estimatedCost).toBe(0.05);
  });

  it('returns null for non-existent session', () => {
    const session = getSession('ses_nonexistent');
    expect(session).toBeNull();
  });

  it('updates a session', () => {
    createSession({
      id: 'ses_update001',
      command: 'claude "update test"',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 0,
      status: 'recording',
      formatVersion: '0.1',
      metadata: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, llmCalls: 0, toolCalls: 0 },
    });

    updateSession('ses_update001', {
      status: 'completed',
      duration: 10000,
      totalTokens: 2000,
      estimatedCost: 0.10,
    });

    const session = getSession('ses_update001');
    expect(session!.status).toBe('completed');
    expect(session!.duration).toBe(10000);
    expect(session!.metadata.totalTokens).toBe(2000);
    expect(session!.metadata.estimatedCost).toBe(0.10);
  });

  it('lists sessions with pagination', () => {
    for (let i = 0; i < 5; i++) {
      createSession({
        id: `ses_list${i}`,
        command: `claude "task ${i}"`,
        agent: 'claude-code',
        label: `task-${i}`,
        startTime: new Date(Date.now() - i * 60000).toISOString(),
        duration: 1000,
        status: 'completed',
        formatVersion: '0.1',
        metadata: { totalTokens: 100, inputTokens: 70, outputTokens: 30, estimatedCost: 0.01, llmCalls: 1, toolCalls: 1 },
      });
    }

    const { sessions, total } = listSessions({ limit: 3 });
    expect(total).toBe(5);
    expect(sessions.length).toBe(3);
    // Should be ordered by start_time DESC
    expect(sessions[0].id).toBe('ses_list0');
  });

  it('filters sessions by label', () => {
    createSession({
      id: 'ses_filter1',
      command: 'claude "a"',
      agent: 'claude-code',
      label: 'auth-refactor',
      startTime: new Date().toISOString(),
      duration: 0,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, llmCalls: 0, toolCalls: 0 },
    });
    createSession({
      id: 'ses_filter2',
      command: 'claude "b"',
      agent: 'claude-code',
      label: 'fix-bug',
      startTime: new Date().toISOString(),
      duration: 0,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, llmCalls: 0, toolCalls: 0 },
    });

    const { sessions } = listSessions({ label: 'auth*' });
    expect(sessions.length).toBe(1);
    expect(sessions[0].label).toBe('auth-refactor');
  });

  it('deletes a session', () => {
    createSession({
      id: 'ses_delete1',
      command: 'claude "del"',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 0,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, llmCalls: 0, toolCalls: 0 },
    });

    const deleted = deleteSession('ses_delete1');
    expect(deleted).toBe(true);
    expect(getSession('ses_delete1')).toBeNull();
  });
});

describe('Span storage', () => {
  it('inserts and retrieves spans', () => {
    createSession({
      id: 'ses_span1',
      command: 'claude "span test"',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 0,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, llmCalls: 0, toolCalls: 0 },
    });

    insertSpan({
      id: 'spn_test1',
      sessionId: 'ses_span1',
      type: 'llm',
      name: 'chat_completion',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      duration: 500,
      status: 'ok',
      attributes: {},
      llm: {
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        messages: [{ role: 'user', content: 'hello' }],
        response: 'Hi there!',
        cost: 0.001,
      },
    });

    insertSpan({
      id: 'spn_test2',
      sessionId: 'ses_span1',
      type: 'tool',
      name: 'read_file',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      duration: 50,
      status: 'ok',
      attributes: {},
      tool: {
        name: 'read_file',
        arguments: { path: '/test/file.ts' },
        result: 'file content here',
      },
    });

    const spans = getSpansForSession('ses_span1');
    expect(spans.length).toBe(2);
    expect(spans[0].type).toBe('llm');
    expect(spans[0].llm!.model).toBe('claude-sonnet-4-6');
    expect(spans[1].type).toBe('tool');
    expect(spans[1].tool!.name).toBe('read_file');
  });
});

describe('Stats', () => {
  it('calculates aggregate stats', () => {
    createSession({
      id: 'ses_stats1',
      command: 'claude "s1"',
      agent: 'claude-code',
      startTime: new Date().toISOString(),
      duration: 5000,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 1000, inputTokens: 700, outputTokens: 300, estimatedCost: 0.10, llmCalls: 2, toolCalls: 5 },
    });
    createSession({
      id: 'ses_stats2',
      command: 'gpt "s2"',
      agent: 'openai',
      startTime: new Date().toISOString(),
      duration: 3000,
      status: 'completed',
      formatVersion: '0.1',
      metadata: { totalTokens: 500, inputTokens: 400, outputTokens: 100, estimatedCost: 0.05, llmCalls: 1, toolCalls: 2 },
    });

    const stats = getStats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.totalDuration).toBe(8000);
    expect(stats.llmCalls).toBe(3);
    expect(stats.toolCalls).toBe(7);
    expect(stats.totalTokens).toBe(1500);
    expect(stats.totalCost).toBeCloseTo(0.15);
    expect(stats.byAgent.length).toBe(2);
  });
});
