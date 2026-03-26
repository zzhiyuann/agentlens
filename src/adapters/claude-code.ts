import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import { AgentAdapter, RecordOptions, RecordingHandle, Session, Span, MemorySnapshot, MemoryEntry } from '../core/types';
import { sessionId, spanId } from '../core/ids';
import { calculateCost } from '../core/cost';
import { createSession, updateSession, insertSpan, getSession } from '../core/storage';

/**
 * Shape of a Claude Code stream-json event.
 * Events come as newline-delimited JSON on stdout when running with
 * `--output-format stream-json`.
 */
interface StreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
  tools?: unknown[];
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Content block inside an assistant message */
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  name = 'claude-code';
  version = '1.0.0';

  async detect(): Promise<boolean> {
    // Check for claude binary on PATH first
    try {
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      // Binary not on PATH — fall back to checking config dir
    }
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

    const isClaudeCommand = this.isClaudeCommand(options.command);

    if (isClaudeCommand) {
      return this.startClaudeRecording(id, startTime, options);
    } else {
      return this.startGenericRecording(id, startTime, options);
    }
  }

  // ─── Claude Code mode ───────────────────────────────────────────────
  // Runs claude with --output-format stream-json -p and parses structured events

  private startClaudeRecording(
    id: string,
    startTime: string,
    options: RecordOptions,
  ): RecordingHandle {
    const { cmd, args } = this.buildClaudeArgs(options.command);

    let child: ChildProcess | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let model = '';
    let resultCost: number | undefined;

    // Pending tool_use blocks keyed by tool_use id — filled when we see
    // the tool_use content block, closed when a tool_result arrives.
    const pendingTools = new Map<string, { span: Span; startMs: number }>();

    const proc = new Promise<void>((resolve, reject) => {
      child = spawn(cmd, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENTLENS_SESSION: id,
          AGENTLENS_RECORDING: '1',
        },
      });

      // Buffer stdout data manually — no pipe+readline double-consume.
      let stdoutBuf = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuf += text;

        // Process complete lines
        let nlIdx: number;
        while ((nlIdx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nlIdx).trim();
          stdoutBuf = stdoutBuf.slice(nlIdx + 1);
          if (!line) continue;

          try {
            const event = JSON.parse(line) as StreamJsonEvent;
            this.processStreamEvent(event, id, pendingTools, (span) => {
              insertSpan(span);
              if (span.type === 'llm' && span.llm) {
                totalInputTokens += span.llm.inputTokens;
                totalOutputTokens += span.llm.outputTokens;
                llmCalls++;
                if (span.llm.model) model = span.llm.model;
              } else if (span.type === 'tool') {
                toolCalls++;
              }
            });

            // Capture result-level totals
            if (event.type === 'result') {
              if (event.total_cost_usd != null) {
                resultCost = event.total_cost_usd;
              }
              if (event.usage) {
                // Prefer result-level totals — they are authoritative
                totalInputTokens = event.usage.input_tokens ?? totalInputTokens;
                totalOutputTokens = event.usage.output_tokens ?? totalOutputTokens;
              }
              if (event.model) {
                model = event.model;
              }
            }
          } catch {
            // Not JSON — write through to terminal so user sees output
            process.stdout.write(line + '\n');
          }
        }
      });

      // Pass stderr through directly
      child.stderr!.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      child.on('close', (code: number | null) => {
        // Flush any remaining incomplete tool spans
        for (const [, pending] of pendingTools) {
          pending.span.endTime = new Date().toISOString();
          pending.span.duration = Date.now() - pending.startMs;
          pending.span.status = 'error';
          insertSpan(pending.span);
          toolCalls++;
        }
        pendingTools.clear();

        const endTime = new Date().toISOString();
        const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
        const cost = resultCost ?? calculateCost(
          model || 'claude-sonnet-4-6',
          totalInputTokens,
          totalOutputTokens,
        );

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

  // ─── Generic mode ───────────────────────────────────────────────────
  // For non-Claude commands: capture stdout data events, write through to
  // terminal, and attempt JSONL parsing per line.

  private startGenericRecording(
    id: string,
    startTime: string,
    options: RecordOptions,
  ): RecordingHandle {
    const parts = options.command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    let child: ChildProcess | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let model = '';

    const proc = new Promise<void>((resolve, reject) => {
      child = spawn(cmd, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENTLENS_SESSION: id,
          AGENTLENS_RECORDING: '1',
        },
      });

      // Buffer stdout — no pipe+readline double-consume
      let stdoutBuf = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        // Write through to terminal immediately
        process.stdout.write(chunk);

        stdoutBuf += text;

        let nlIdx: number;
        while ((nlIdx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nlIdx).trim();
          stdoutBuf = stdoutBuf.slice(nlIdx + 1);
          if (!line) continue;

          try {
            const entry = JSON.parse(line) as StreamJsonEvent;
            const span = this.processGenericLogEntry(entry, id);
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
          } catch {
            // Not JSONL — already written through above
          }
        }
      });

      // Pass stderr through directly
      child.stderr!.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      child.on('close', (code: number | null) => {
        const endTime = new Date().toISOString();
        const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
        const cost = calculateCost(
          model || 'claude-sonnet-4-6',
          totalInputTokens,
          totalOutputTokens,
        );

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

  // ─── Stream-JSON event processing (Claude Code mode) ───────────────

  private processStreamEvent(
    event: StreamJsonEvent,
    sessId: string,
    pendingTools: Map<string, { span: Span; startMs: number }>,
    onSpan: (span: Span) => void,
  ): void {
    const now = new Date().toISOString();

    // Assistant message — contains LLM response and possibly tool_use blocks
    if (event.type === 'assistant' && event.message) {
      const usage = event.usage || {};
      const contentBlocks = Array.isArray(event.message.content)
        ? event.message.content
        : [];

      // Extract text response from content blocks
      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }

      // Create LLM span for the assistant turn
      if (usage.input_tokens || usage.output_tokens) {
        const llmModel = event.model || 'unknown';
        const inputTok = usage.input_tokens || 0;
        const outputTok = usage.output_tokens || 0;

        onSpan({
          id: spanId(),
          sessionId: sessId,
          type: 'llm',
          name: 'chat_completion',
          startTime: now,
          endTime: now,
          duration: 0,
          status: 'ok',
          attributes: {},
          llm: {
            model: llmModel,
            provider: 'anthropic',
            inputTokens: inputTok,
            outputTokens: outputTok,
            messages: [],
            response: textParts.join('\n'),
            cost: calculateCost(llmModel, inputTok, outputTok),
          },
        });
      }

      // Process tool_use content blocks — open pending tool spans
      for (const block of contentBlocks) {
        if (block.type === 'tool_use' && block.id && block.name) {
          const toolSpan: Span = {
            id: spanId(),
            sessionId: sessId,
            type: 'tool',
            name: block.name,
            startTime: now,
            endTime: now,
            duration: 0,
            status: 'ok',
            attributes: {},
            tool: {
              name: block.name,
              arguments: block.input,
              result: undefined,
            },
          };
          pendingTools.set(block.id, { span: toolSpan, startMs: Date.now() });
        }
      }

      return;
    }

    // Content block delta (tool_result) — close pending tool span
    if (event.type === 'content_block_start' || event.type === 'tool_result') {
      // Some stream formats emit tool_result at the event level
      const toolUseId = (event as Record<string, unknown>).tool_use_id as string | undefined;
      if (toolUseId && pendingTools.has(toolUseId)) {
        const pending = pendingTools.get(toolUseId)!;
        pending.span.endTime = now;
        pending.span.duration = Date.now() - pending.startMs;
        if (pending.span.tool) {
          pending.span.tool.result = event.content ?? (event as Record<string, unknown>).output;
          if ((event as Record<string, unknown>).is_error) {
            pending.span.status = 'error';
            pending.span.tool.error = String(event.content ?? 'tool error');
          }
        }
        onSpan(pending.span);
        pendingTools.delete(toolUseId);
      }
      return;
    }

    // User message with tool_result content blocks
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (pendingTools.has(block.tool_use_id)) {
            const pending = pendingTools.get(block.tool_use_id)!;
            pending.span.endTime = now;
            pending.span.duration = Date.now() - pending.startMs;
            if (pending.span.tool) {
              pending.span.tool.result = block.content;
              if ((block as Record<string, unknown>).is_error) {
                pending.span.status = 'error';
                pending.span.tool.error = typeof block.content === 'string'
                  ? block.content
                  : 'tool error';
              }
            }
            onSpan(pending.span);
            pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }

    // result event is handled by the caller for session-level totals
  }

  // ─── Generic JSONL entry processing (non-Claude mode) ──────────────

  private processGenericLogEntry(entry: StreamJsonEvent, sessId: string): Span | null {
    const now = new Date().toISOString();

    if (entry.type === 'assistant' && entry.usage) {
      const inputTok = entry.usage.input_tokens || 0;
      const outputTok = entry.usage.output_tokens || 0;
      const entryModel = (entry.model as string) || 'unknown';
      const contentStr = typeof entry.message?.content === 'string'
        ? entry.message.content
        : '';

      return {
        id: spanId(),
        sessionId: sessId,
        type: 'llm',
        name: 'chat_completion',
        startTime: now,
        endTime: now,
        duration: 0,
        status: 'ok',
        attributes: {},
        llm: {
          model: entryModel,
          provider: 'anthropic',
          inputTokens: inputTok,
          outputTokens: outputTok,
          messages: [],
          response: contentStr,
          cost: calculateCost(entryModel, inputTok, outputTok),
        },
      };
    }

    if (entry.type === 'tool_use' || (entry as Record<string, unknown>).tool_name) {
      const toolName = ((entry as Record<string, unknown>).tool_name as string) || 'unknown_tool';
      return {
        id: spanId(),
        sessionId: sessId,
        type: 'tool',
        name: toolName,
        startTime: now,
        endTime: now,
        duration: 0,
        status: 'ok',
        attributes: {},
        tool: {
          name: toolName,
          arguments: (entry as Record<string, unknown>).tool_input,
          result: (entry as Record<string, unknown>).tool_result,
          error: (entry as Record<string, unknown>).error as string | undefined,
        },
      };
    }

    return null;
  }

  // ─── Command building helpers ──────────────────────────────────────

  /**
   * Detect whether the user's command targets the Claude CLI.
   * Matches "claude", "/path/to/claude", or "npx claude" etc.
   */
  private isClaudeCommand(command: string): boolean {
    const parts = command.trim().split(/\s+/);
    const bin = parts[0];
    // Direct invocation: "claude ..." or absolute/relative path ending in /claude
    if (bin === 'claude' || bin.endsWith('/claude')) return true;
    // npx/bunx invocation: "npx claude ..."
    if ((bin === 'npx' || bin === 'bunx') && parts[1] === 'claude') return true;
    return false;
  }

  /**
   * Build the final command and args for Claude Code recording.
   * Injects --output-format stream-json and -p if not already present.
   */
  private buildClaudeArgs(command: string): { cmd: string; args: string[] } {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    // Ensure we have -p (print/non-interactive mode)
    const hasPrintFlag = args.some(a => a === '-p' || a === '--print');

    // Ensure we have --output-format stream-json
    const hasOutputFormat = args.some(a =>
      a === '--output-format' || a.startsWith('--output-format='),
    );

    const finalArgs = [...args];
    if (!hasOutputFormat) {
      finalArgs.unshift('--output-format', 'stream-json');
    }
    if (!hasPrintFlag) {
      finalArgs.unshift('-p');
    }

    return { cmd, args: finalArgs };
  }

  // ─── Private helpers (unchanged) ────────────────────────────────────

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
