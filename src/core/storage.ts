import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Session, Span, SessionStatus } from './types';
import { loadConfig } from './config';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const config = loadConfig();
  const dbPath = config.storage.path;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      label TEXT,
      command TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'recording',
      format_version TEXT NOT NULL DEFAULT '0.1',
      total_tokens INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      llm_calls INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS spans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      attributes TEXT NOT NULL DEFAULT '{}',
      llm_data TEXT,
      tool_data TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_label ON sessions(label);
  `);
}

// Session operations

export function createSession(session: Omit<Session, 'spans'>): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO sessions (id, label, command, agent, model, start_time, end_time, duration, status, format_version,
      total_tokens, input_tokens, output_tokens, estimated_cost, llm_calls, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    session.id,
    session.label || null,
    session.command,
    session.agent,
    session.model || null,
    session.startTime,
    session.endTime || null,
    session.duration,
    session.status,
    session.formatVersion,
    session.metadata.totalTokens,
    session.metadata.inputTokens,
    session.metadata.outputTokens,
    session.metadata.estimatedCost,
    session.metadata.llmCalls,
    session.metadata.toolCalls
  );
}

export function updateSession(id: string, updates: Partial<{
  endTime: string;
  duration: number;
  status: SessionStatus;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  llmCalls: number;
  toolCalls: number;
}>): void {
  const database = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    endTime: 'end_time',
    duration: 'duration',
    status: 'status',
    model: 'model',
    totalTokens: 'total_tokens',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    estimatedCost: 'estimated_cost',
    llmCalls: 'llm_calls',
    toolCalls: 'tool_calls',
  };

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined && fieldMap[key]) {
      setClauses.push(`${fieldMap[key]} = ?`);
      values.push(val);
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  database.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function getSession(id: string): Session | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return null;

  const spans = getSpansForSession(id);
  return rowToSession(row, spans);
}

export function listSessions(options: {
  limit?: number;
  offset?: number;
  label?: string;
  agent?: string;
  since?: string;
  minCost?: number;
} = {}): { sessions: Session[]; total: number } {
  const database = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.label) {
    conditions.push('label LIKE ?');
    params.push(options.label.replace(/\*/g, '%'));
  }
  if (options.agent) {
    conditions.push('agent = ?');
    params.push(options.agent);
  }
  if (options.since) {
    conditions.push('start_time >= ?');
    params.push(options.since);
  }
  if (options.minCost) {
    conditions.push('estimated_cost >= ?');
    params.push(options.minCost);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit || 20;
  const offset = options.offset || 0;

  const countRow = database.prepare(`SELECT COUNT(*) as count FROM sessions ${where}`).get(...params) as { count: number };
  const total = countRow.count;

  const rows = database.prepare(
    `SELECT * FROM sessions ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as SessionRow[];

  const sessions = rows.map(row => rowToSession(row, []));
  return { sessions, total };
}

export function deleteSession(id: string): boolean {
  const database = getDb();
  const result = database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

// Span operations

export function insertSpan(span: Span): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO spans (id, session_id, parent_id, type, name, start_time, end_time, duration, status, attributes, llm_data, tool_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    span.id,
    span.sessionId,
    span.parentId || null,
    span.type,
    span.name,
    span.startTime,
    span.endTime,
    span.duration,
    span.status,
    JSON.stringify(span.attributes),
    span.llm ? JSON.stringify(span.llm) : null,
    span.tool ? JSON.stringify(span.tool) : null
  );
}

export function getSpansForSession(sessionId: string): Span[] {
  const database = getDb();
  const rows = database.prepare(
    'SELECT * FROM spans WHERE session_id = ? ORDER BY start_time ASC'
  ).all(sessionId) as SpanRow[];

  return rows.map(rowToSpan);
}

// Aggregate stats

export function getStats(since?: string): {
  sessionCount: number;
  totalDuration: number;
  llmCalls: number;
  toolCalls: number;
  totalTokens: number;
  totalCost: number;
  byAgent: { agent: string; sessions: number; cost: number }[];
  dailyCost: { date: string; cost: number }[];
} {
  const database = getDb();
  const where = since ? 'WHERE start_time >= ?' : '';
  const params = since ? [since] : [];

  const summary = database.prepare(`
    SELECT
      COUNT(*) as session_count,
      COALESCE(SUM(duration), 0) as total_duration,
      COALESCE(SUM(llm_calls), 0) as llm_calls,
      COALESCE(SUM(tool_calls), 0) as tool_calls,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost), 0) as total_cost
    FROM sessions ${where}
  `).get(...params) as Record<string, number>;

  const byAgent = database.prepare(`
    SELECT agent, COUNT(*) as sessions, COALESCE(SUM(estimated_cost), 0) as cost
    FROM sessions ${where}
    GROUP BY agent ORDER BY cost DESC
  `).all(...params) as { agent: string; sessions: number; cost: number }[];

  const dailyCost = database.prepare(`
    SELECT DATE(start_time) as date, COALESCE(SUM(estimated_cost), 0) as cost
    FROM sessions ${where}
    GROUP BY DATE(start_time) ORDER BY date ASC
  `).all(...params) as { date: string; cost: number }[];

  return {
    sessionCount: summary.session_count,
    totalDuration: summary.total_duration,
    llmCalls: summary.llm_calls,
    toolCalls: summary.tool_calls,
    totalTokens: summary.total_tokens,
    totalCost: summary.total_cost,
    byAgent,
    dailyCost,
  };
}

// Internal helpers

interface SessionRow {
  id: string;
  label: string | null;
  command: string;
  agent: string;
  model: string | null;
  start_time: string;
  end_time: string | null;
  duration: number;
  status: string;
  format_version: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  llm_calls: number;
  tool_calls: number;
}

interface SpanRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  type: string;
  name: string;
  start_time: string;
  end_time: string;
  duration: number;
  status: string;
  attributes: string;
  llm_data: string | null;
  tool_data: string | null;
}

function rowToSession(row: SessionRow, spans: Span[]): Session {
  return {
    id: row.id,
    label: row.label || undefined,
    command: row.command,
    agent: row.agent,
    model: row.model || undefined,
    startTime: row.start_time,
    endTime: row.end_time || undefined,
    duration: row.duration,
    status: row.status as SessionStatus,
    formatVersion: row.format_version,
    spans,
    metadata: {
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCost: row.estimated_cost,
      llmCalls: row.llm_calls,
      toolCalls: row.tool_calls,
    },
  };
}

function rowToSpan(row: SpanRow): Span {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id || undefined,
    type: row.type as Span['type'],
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    status: row.status as 'ok' | 'error',
    attributes: JSON.parse(row.attributes),
    llm: row.llm_data ? JSON.parse(row.llm_data) : undefined,
    tool: row.tool_data ? JSON.parse(row.tool_data) : undefined,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
