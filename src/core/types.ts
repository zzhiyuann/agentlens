// OTel-aligned trace format for AgentLens

export interface Session {
  id: string;                // ses_<nanoid>
  label?: string;            // User-provided label
  command: string;           // Original command
  agent: string;             // Detected agent framework
  model?: string;            // Primary model used
  startTime: string;         // ISO 8601
  endTime?: string;          // ISO 8601
  duration: number;          // milliseconds
  status: SessionStatus;
  formatVersion: string;     // "0.1" for forward compatibility
  spans: Span[];
  metadata: SessionMetadata;
}

export type SessionStatus = 'recording' | 'completed' | 'error' | 'interrupted';

export interface SessionMetadata {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;     // USD
  llmCalls: number;
  toolCalls: number;
}

export interface Span {
  id: string;                // spn_<nanoid>
  sessionId: string;
  parentId?: string;
  type: SpanType;
  name: string;              // e.g., "chat_completion", "read_file"
  startTime: string;
  endTime: string;
  duration: number;          // milliseconds
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
  llm?: LLMSpanData;
  tool?: ToolSpanData;
}

export type SpanType = 'llm' | 'tool' | 'agent' | 'chain' | 'retrieval' | 'embedding';

export interface LLMSpanData {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  temperature?: number;
  messages: Message[];
  response: string;
  cost: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ToolSpanData {
  name: string;
  arguments: unknown;
  result: unknown;
  error?: string;
}

// Memory types

export interface MemorySnapshot {
  agentId: string;
  timestamp: string;
  source: string;
  format: 'markdown' | 'json' | 'yaml';
  entries: MemoryEntry[];
  metadata: {
    totalSize: number;
    fileCount: number;
    healthScore: number;
  };
}

export interface MemoryEntry {
  id: string;
  file: string;
  title: string;
  content: string;
  size: number;
  lastModified: string;
  status: 'fresh' | 'active' | 'stale';
  references: string[];
}

// Test harness types

export interface TestScenario {
  name: string;
  description?: string;
  agents: TestAgent[];
  scenario: ScenarioStep[];
  settings?: TestSettings;
}

export interface TestAgent {
  role: string;
  model?: string;
  memory?: string;
  config?: Record<string, unknown>;
}

export type ScenarioStep =
  | { user: string }
  | { assert: AssertionBlock }
  | { mock_tool_response: Record<string, unknown> }
  | { wait: number }
  | { checkpoint: string };

export interface AssertionBlock {
  tool_called?: string;
  tool_args?: Record<string, unknown>;
  response_contains?: string;
  response_matches?: string;
  cost_under?: number;
  duration_under?: number;
  tokens_under?: number;
  memory_updated?: boolean;
  memory_contains?: string;
  custom?: string;
}

export interface TestSettings {
  timeout?: number;
  retries?: number;
  parallel?: boolean;
  session?: string;  // Replay against this specific session ID
}

export interface TestContext {
  sessionId?: string;
  spans: Span[];
  currentSpanIndex: number;
  lastResponse: string;
  toolsCalled: string[];
  toolArgs: Record<string, unknown>[];
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  memoryBefore?: MemorySnapshot;
  memoryAfter?: MemorySnapshot;
}

export interface TestResult {
  scenario: string;
  status: 'pass' | 'fail' | 'error';
  assertions: AssertionResult[];
  duration: number;
  cost: number;
}

export interface AssertionResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  expected?: string;
  actual?: string;
  message?: string;
}

// Adapter interface

export interface RecordOptions {
  command: string;
  label?: string;
  adapter?: string;
}

export interface RecordingHandle {
  sessionId: string;
  stop: () => Promise<Session>;
}

export interface AgentAdapter {
  name: string;
  version: string;
  detect(): Promise<boolean>;
  startRecording(options: RecordOptions): Promise<RecordingHandle>;
  stopRecording(handle: RecordingHandle): Promise<Session>;
  getMemory?(agentId: string): Promise<MemorySnapshot>;
  getMemoryHistory?(agentId: string, since: Date): Promise<MemorySnapshot[]>;
}

// Configuration

export interface AlensConfig {
  adapter: string;
  storage: {
    path: string;
    maxSize: string;
  };
  display: {
    theme: 'dark' | 'light' | 'auto';
    colors: boolean;
    unicode: boolean;
    pageSize: number;
  };
  recording: {
    autoLabel: boolean;
    captureEnv: boolean;
    maxDuration: string;
  };
  memory: {
    staleDays: number;
    healthCheck: boolean;
  };
  cost: {
    rates: Record<string, { input: number; output: number }>;
  };
}
