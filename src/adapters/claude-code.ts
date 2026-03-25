import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import { AgentAdapter, RecordOptions, RecordingHandle, Session, Span, MemorySnapshot, MemoryEntry } from '../core/types';
import { sessionId, spanId } from '../core/ids';
import { calculateCost } from '../core/cost';
import { createSession, updateSession, insertSpan, getSession } from '../core/storage';

interface ClaudeLogEntry {
  type: string;
  timestamp?: string;
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: string;
  [key: string]: unknown;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  name = 'claude-code';
  version = '1.0.0';

  async detect(): Promise<boolean> {
    // Check if Claude Code CLI is available
    try {
      const claudeDir = path.join(process.env.HOME || '', '.claude');
      return fs.existsSync(claudeDir);
    } catch {
      return false;
    }
  }

  async startRecording(options: RecordOptions): Promise<RecordingHandle> {
    const id = sessionId();
    const startTime = new Date().toISOString();
    const label = options.label || this.autoLabel(options.command);

    // Create session in DB
    createSession({
      id,
      label,
      command: options.command,
      agent: 'claude-code',
      startTime,
      duration: 0,
      status: 'recording',
      formatVersion: '0.1',
      metadata: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        llmCalls: 0,
        toolCalls: 0,
      },
    });

    // Parse the command to run
    const parts = options.command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    let child: ChildProcess | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let model = '';

    // Spawn the command and capture output for JSONL parsing
    const proc = new Promise<void>((resolve, reject) => {
      child = spawn(cmd, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENTLENS_SESSION: id,
          AGENTLENS_RECORDING: '1',
        },
      });

      // Create a line reader for stdout to capture JSONL
      const stdoutLines = readline.createInterface({ input: child.stdout! });
      const stderrLines = readline.createInterface({ input: child.stderr! });

      // Pass through to console while capturing
      child.stdout!.pipe(process.stdout);
      child.stderr!.pipe(process.stderr);

      stdoutLines.on('line', (line: string) => {
        // Try to parse JSONL entries from Claude Code output
        try {
          const entry = JSON.parse(line) as ClaudeLogEntry;
          this.processLogEntry(entry, id, startTime).then(span => {
            if (span) {
              insertSpan(span);
              if (span.type === 'llm' && span.llm) {
                totalInputTokens += span.llm.inputTokens;
                totalOutputTokens += span.llm.outputTokens;
                llmCalls++;
                if (span.llm.model) model = span.llm.model;
              } else if (span.type === 'tool') {
                toolCalls++;
              }
            }
          }).catch(() => {});
        } catch {
          // Not JSONL — normal output, ignore
        }
      });

      stderrLines.on('line', () => {
        // Capture stderr for error detection
      });

      child.on('close', (code: number | null) => {
        const endTime = new Date().toISOString();
        const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
        const cost = calculateCost(model || 'claude-sonnet-4-6', totalInputTokens, totalOutputTokens);

        updateSession(id, {
          endTime,
          duration,
          status: code === 0 ? 'completed' : (code === null ? 'interrupted' : 'error'),
          model: model || undefined,
          totalTokens: totalInputTokens + totalOutputTokens,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          estimatedCost: cost,
          llmCalls,
          toolCalls,
        });

        resolve();
      });

      child.on('error', (err: Error) => {
        updateSession(id, { status: 'error' });
        reject(err);
      });
    });

    return {
      sessionId: id,
      stop: async () => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
        await proc;
        return getSession(id)!;
      },
    };
  }

  async stopRecording(handle: RecordingHandle): Promise<Session> {
    return handle.stop();
  }

  async getMemory(agentPath: string): Promise<MemorySnapshot> {
    const resolvedPath = agentPath.replace(/^~/, process.env.HOME || '');
    const entries: MemoryEntry[] = [];
    let totalSize = 0;

    if (!fs.existsSync(resolvedPath)) {
      return {
        agentId: path.basename(resolvedPath),
        timestamp: new Date().toISOString(),
        source: resolvedPath,
        format: 'markdown',
        entries: [],
        metadata: { totalSize: 0, fileCount: 0, healthScore: 0 },
      };
    }

    const files = fs.readdirSync(resolvedPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(resolvedPath, file);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const title = this.extractTitle(content, file);
      const status = this.getFileStatus(stat.mtime);
      const refs = this.extractReferences(content);

      entries.push({
        id: file,
        file,
        title,
        content,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
        status,
        references: refs,
      });

      totalSize += stat.size;
    }

    const healthScore = this.calculateHealthScore(entries);

    return {
      agentId: path.basename(path.dirname(resolvedPath)),
      timestamp: new Date().toISOString(),
      source: resolvedPath,
      format: 'markdown',
      entries,
      metadata: {
        totalSize,
        fileCount: entries.length,
        healthScore,
      },
    };
  }

  // Private helpers

  private async processLogEntry(entry: ClaudeLogEntry, sessId: string, _sessionStart: string): Promise<Span | null> {
    const now = new Date().toISOString();

    if (entry.type === 'assistant' && entry.usage) {
      return {
        id: spanId(),
        sessionId: sessId,
        type: 'llm',
        name: 'chat_completion',
        startTime: entry.timestamp || now,
        endTime: now,
        duration: 0,
        status: entry.error ? 'error' : 'ok',
        attributes: {},
        llm: {
          model: (entry.model as string) || 'unknown',
          provider: 'anthropic',
          inputTokens: entry.usage?.input_tokens || 0,
          outputTokens: entry.usage?.output_tokens || 0,
          messages: [],
          response: typeof entry.message?.content === 'string' ? entry.message.content : '',
          cost: calculateCost(
            (entry.model as string) || 'claude-sonnet-4-6',
            entry.usage?.input_tokens || 0,
            entry.usage?.output_tokens || 0
          ),
        },
      };
    }

    if (entry.type === 'tool_use' || entry.tool_name) {
      return {
        id: spanId(),
        sessionId: sessId,
        type: 'tool',
        name: entry.tool_name || 'unknown_tool',
        startTime: entry.timestamp || now,
        endTime: now,
        duration: 0,
        status: entry.error ? 'error' : 'ok',
        attributes: {},
        tool: {
          name: entry.tool_name || 'unknown_tool',
          arguments: entry.tool_input,
          result: entry.tool_result,
          error: entry.error,
        },
      };
    }

    return null;
  }

  private autoLabel(command: string): string {
    // Generate a label from the command
    const parts = command.split(' ');
    if (parts.length <= 2) return command;
    // Skip the binary name, take first few meaningful words
    const meaningful = parts.slice(1).filter(p => !p.startsWith('-')).slice(0, 3);
    return meaningful.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  private extractTitle(content: string, filename: string): string {
    const match = content.match(/^#\s+(.+)$/m);
    if (match) return match[1];
    const yamlMatch = content.match(/^name:\s*(.+)$/m);
    if (yamlMatch) return yamlMatch[1];
    return filename.replace('.md', '');
  }

  private getFileStatus(mtime: Date): 'fresh' | 'active' | 'stale' {
    const now = Date.now();
    const diffDays = (now - mtime.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 3) return 'fresh';
    if (diffDays < 14) return 'active';
    return 'stale';
  }

  private extractReferences(content: string): string[] {
    const refs: string[] = [];
    const linkRegex = /\[.*?\]\((.*?\.md)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    return refs;
  }

  private calculateHealthScore(entries: MemoryEntry[]): number {
    if (entries.length === 0) return 0;

    const fresh = entries.filter(e => e.status === 'fresh').length;
    const active = entries.filter(e => e.status === 'active').length;
    const stale = entries.filter(e => e.status === 'stale').length;
    const total = entries.length;

    // Weighted score: fresh=3, active=2, stale=0.5
    const rawScore = (fresh * 3 + active * 2 + stale * 0.5) / total;

    // Normalize to 0-100 (max raw score is 3 when all fresh)
    const normalized = (rawScore / 3) * 100;

    return Math.min(100, Math.round(normalized));
  }
}
