// AgentLens — Chrome DevTools for AI agents
// Public API exports

export {
  Session,
  Span,
  SpanType,
  SessionStatus,
  SessionMetadata,
  LLMSpanData,
  ToolSpanData,
  Message,
  MemorySnapshot,
  MemoryEntry,
  TestScenario,
  TestAgent,
  AgentAdapter,
  RecordOptions,
  RecordingHandle,
  AlensConfig,
} from './core/types';

export { loadConfig, getConfigValue, setConfigValue } from './core/config';
export { createSession, getSession, listSessions, insertSpan, getSpansForSession, getStats, closeDb } from './core/storage';
export { sessionId, spanId } from './core/ids';
export { calculateCost, formatCost, getModelRates } from './core/cost';
export { ClaudeCodeAdapter } from './adapters/claude-code';
