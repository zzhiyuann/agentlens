import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { createSession, insertSpan } from '../core/storage';
import { sessionId, spanId } from '../core/ids';
import { calculateCost, formatCost } from '../core/cost';
import { Session, Span, SessionMetadata } from '../core/types';
import { formatDuration, formatTokens, dim } from '../utils/format';

// --- JSONL Format Detection ---

type JsonlFormat = 'claude-code' | 'generic' | 'unknown';

interface ParsedEntry {
  type: 'llm' | 'tool' | 'result' | 'human' | 'system';
  timestamp?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolUseId?: string;
  response?: string;
}

interface ImportSummary {
  format: string;
  totalEntries: number;
  llmCalls: number;
  toolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  model?: string;
  sessionId: string;
  duration: number;
  firstUserMessage?: string;
}

// --- Format Detection ---

function detectFormat(entries: Record<string, unknown>[]): JsonlFormat {
  for (const entry of entries) {
    // Claude Code format: has type "human" or "assistant" with message property
    if (
      (entry.type === 'human' || entry.type === 'assistant') &&
      entry.message !== undefined
    ) {
      return 'claude-code';
    }
    // Claude Code result type
    if (entry.type === 'result' && entry.subtype !== undefined) {
      return 'claude-code';
    }
    // Generic format: has type "llm" or "tool" at top level
    if (entry.type === 'llm' || entry.type === 'tool') {
      return 'generic';
    }
  }
  return 'unknown';
}

// --- Claude Code Format Parsing ---

function parseClaudeCodeEntry(entry: Record<string, unknown>): ParsedEntry[] {
  const results: ParsedEntry[] = [];

  if (entry.type === 'human') {
    const message = entry.message as Record<string, unknown> | undefined;
    const content = extractContent(message?.content);
    results.push({
      type: 'human',
      timestamp: entry.timestamp as string | undefined,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      content,
    });
  } else if (entry.type === 'assistant') {
    const message = entry.message as Record<string, unknown> | undefined;
    const usage = entry.usage as Record<string, number> | undefined;
    const model = (entry.model as string) || undefined;
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;

    // Extract text and tool_use from content array
    const contentArray = message?.content;
    let responseText = '';
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];

    if (Array.isArray(contentArray)) {
      for (const block of contentArray) {
        if (typeof block === 'string') {
          responseText += block;
        } else if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
            responseText += b.text as string;
          } else if (b.type === 'tool_use') {
            toolUses.push({
              id: b.id as string,
              name: b.name as string,
              input: b.input,
            });
          }
        }
      }
    } else if (typeof contentArray === 'string') {
      responseText = contentArray;
    }

    // Compute cost from model + tokens
    const cost = model ? calculateCost(model, inputTokens, outputTokens) : 0;

    // LLM span for the assistant message
    results.push({
      type: 'llm',
      timestamp: entry.timestamp as string | undefined,
      model,
      inputTokens,
      outputTokens,
      cost,
      response: responseText,
    });

    // Tool use spans from the content blocks
    for (const tu of toolUses) {
      results.push({
        type: 'tool',
        timestamp: entry.timestamp as string | undefined,
        toolName: tu.name,
        toolArgs: tu.input,
        toolUseId: tu.id,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      });
    }
  } else if (entry.type === 'tool_result') {
    const content = extractContent(entry.content);
    results.push({
      type: 'tool',
      timestamp: entry.timestamp as string | undefined,
      toolUseId: entry.tool_use_id as string | undefined,
      toolResult: content,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  } else if (entry.type === 'result') {
    // Summary entry — extract total cost and usage
    const totalCost = (entry.total_cost_usd as number) || 0;
    const usage = entry.usage as Record<string, number> | undefined;
    results.push({
      type: 'result',
      timestamp: entry.timestamp as string | undefined,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      cost: totalCost,
    });
  }

  return results;
}

// --- Generic Format Parsing ---

function parseGenericEntry(entry: Record<string, unknown>): ParsedEntry[] {
  if (entry.type === 'llm') {
    const inputTokens = (entry.input_tokens as number) || 0;
    const outputTokens = (entry.output_tokens as number) || 0;
    const model = (entry.model as string) || undefined;
    const cost = model ? calculateCost(model, inputTokens, outputTokens) : 0;
    return [{
      type: 'llm',
      timestamp: entry.timestamp as string | undefined,
      model,
      inputTokens,
      outputTokens,
      cost,
      response: (entry.response as string) || '',
    }];
  } else if (entry.type === 'tool') {
    return [{
      type: 'tool',
      timestamp: entry.timestamp as string | undefined,
      toolName: entry.name as string,
      toolArgs: entry.arguments,
      toolResult: entry.result,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    }];
  }
  return [];
}

// --- Helpers ---

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const obj = c as Record<string, unknown>;
          if (obj.type === 'text') return obj.text as string;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content !== null && content !== undefined) {
    return String(content);
  }
  return '';
}

function deriveLabel(firstUserMessage: string | undefined, filePath: string): string {
  if (firstUserMessage) {
    // Use first ~50 chars of user message as label
    const clean = firstUserMessage.replace(/\n/g, ' ').trim();
    if (clean.length > 50) return clean.slice(0, 47) + '...';
    return clean;
  }
  // Fall back to filename without extension
  return path.basename(filePath, path.extname(filePath));
}

function getFileMtime(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// --- Main Import Logic ---

export function importCommand(filePath: string, options: { label?: string; agent?: string }): void {
  // Validate file exists
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n File not found: ${resolvedPath}\n`));
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    console.error(chalk.red(`\n Not a file: ${resolvedPath}\n`));
    process.exit(1);
  }

  console.log(chalk.bold.cyan('\n Importing: ') + dim(path.basename(resolvedPath)));

  // Read and parse JSONL
  const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
  const lines = rawContent.split('\n').filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    console.error(chalk.red('\n File is empty.\n'));
    process.exit(1);
  }

  // Parse all valid JSON lines
  const rawEntries: Record<string, unknown>[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      rawEntries.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  if (rawEntries.length === 0) {
    console.error(chalk.red('\n No valid JSON lines found in file.\n'));
    process.exit(1);
  }

  // Detect format
  const format = detectFormat(rawEntries);
  if (format === 'unknown') {
    console.error(chalk.red('\n Unrecognized JSONL format.'));
    console.log(dim('   Supported: Claude Code conversations, generic LLM/tool JSONL'));
    console.log('');
    process.exit(1);
  }

  const formatLabel = format === 'claude-code' ? 'Claude Code conversation' : 'Generic JSONL';
  console.log(dim(`\n   Format: ${formatLabel}`));

  // Parse entries according to format
  const parsedEntries: ParsedEntry[] = [];
  for (const raw of rawEntries) {
    const parsed = format === 'claude-code'
      ? parseClaudeCodeEntry(raw)
      : parseGenericEntry(raw);
    parsedEntries.push(...parsed);
  }

  if (parsedEntries.length === 0) {
    console.error(chalk.red('\n No parseable entries found.\n'));
    process.exit(1);
  }

  // Aggregate stats
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let primaryModel: string | undefined;
  let firstUserMessage: string | undefined;
  let resultEntry: ParsedEntry | undefined;

  for (const entry of parsedEntries) {
    if (entry.type === 'llm') {
      llmCalls++;
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
      totalCost += entry.cost;
      if (entry.model && !primaryModel) primaryModel = entry.model;
    } else if (entry.type === 'tool') {
      toolCalls++;
    } else if (entry.type === 'human' && !firstUserMessage && entry.content) {
      firstUserMessage = entry.content;
    } else if (entry.type === 'result') {
      resultEntry = entry;
    }
  }

  // Use result entry cost if available (more accurate than sum of per-call estimates)
  if (resultEntry && resultEntry.cost > 0) {
    totalCost = resultEntry.cost;
  }
  // Use result entry tokens if available
  if (resultEntry && resultEntry.inputTokens > 0) {
    totalInputTokens = resultEntry.inputTokens;
  }
  if (resultEntry && resultEntry.outputTokens > 0) {
    totalOutputTokens = resultEntry.outputTokens;
  }

  const totalTokens = totalInputTokens + totalOutputTokens;

  console.log(dim(`   Entries: ${parsedEntries.length}`) +
    dim(` (${llmCalls} LLM calls, ${toolCalls} tool calls)`));

  if (parseErrors > 0) {
    console.log(chalk.yellow(`   Skipped: ${parseErrors} invalid JSON lines`));
  }

  // Build session
  const sid = sessionId();
  const fileMtime = getFileMtime(resolvedPath);
  const sessionLabel = options.label || deriveLabel(firstUserMessage, resolvedPath);
  const agent = options.agent || (primaryModel ? deriveAgent(primaryModel) : 'unknown');

  // Estimate duration from timestamps if available, otherwise 0
  const timestamps = parsedEntries
    .filter(e => e.timestamp)
    .map(e => new Date(e.timestamp!).getTime())
    .filter(t => !isNaN(t));

  let duration = 0;
  let startTime = fileMtime;
  let endTime = fileMtime;

  if (timestamps.length >= 2) {
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    duration = maxTime - minTime;
    startTime = new Date(minTime).toISOString();
    endTime = new Date(maxTime).toISOString();
  }

  const metadata: SessionMetadata = {
    totalTokens,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    estimatedCost: totalCost,
    llmCalls,
    toolCalls,
  };

  const session: Omit<Session, 'spans'> = {
    id: sid,
    label: sessionLabel,
    command: `imported from ${path.basename(resolvedPath)}`,
    agent,
    model: primaryModel,
    startTime,
    endTime,
    duration,
    status: 'completed',
    formatVersion: '0.1',
    metadata,
  };

  // Store session
  createSession(session);

  // Build and store spans
  let spanIndex = 0;
  // Track tool_use spans by id for linking tool_result
  const toolUseSpans = new Map<string, string>(); // toolUseId -> spanId

  for (const entry of parsedEntries) {
    if (entry.type === 'human' || entry.type === 'result') continue;

    const sid_span = spanId();
    const entryTime = entry.timestamp || startTime;
    spanIndex++;

    if (entry.type === 'llm') {
      const span: Span = {
        id: sid_span,
        sessionId: sid,
        type: 'llm',
        name: `chat_completion_${spanIndex}`,
        startTime: entryTime,
        endTime: entryTime,
        duration: 0,
        status: 'ok',
        attributes: { model: entry.model },
        llm: {
          model: entry.model || 'unknown',
          provider: deriveProvider(entry.model),
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          temperature: undefined,
          messages: [],
          response: entry.response || '',
          cost: entry.cost,
        },
      };
      insertSpan(span);
    } else if (entry.type === 'tool') {
      // If this is a tool_use (has toolName), record it
      if (entry.toolName) {
        const span: Span = {
          id: sid_span,
          sessionId: sid,
          type: 'tool',
          name: entry.toolName,
          startTime: entryTime,
          endTime: entryTime,
          duration: 0,
          status: 'ok',
          attributes: {},
          tool: {
            name: entry.toolName,
            arguments: entry.toolArgs,
            result: entry.toolResult || null,
          },
        };
        insertSpan(span);
        if (entry.toolUseId) {
          toolUseSpans.set(entry.toolUseId, sid_span);
        }
      } else if (entry.toolUseId && entry.toolResult !== undefined) {
        // This is a tool_result — skip creating a separate span
        // (tool results are attached to tool_use spans during export/replay)
        // We store it as a minimal span for completeness
        const parentSpanId = toolUseSpans.get(entry.toolUseId);
        const span: Span = {
          id: sid_span,
          sessionId: sid,
          parentId: parentSpanId,
          type: 'tool',
          name: 'tool_result',
          startTime: entryTime,
          endTime: entryTime,
          duration: 0,
          status: 'ok',
          attributes: { toolUseId: entry.toolUseId },
          tool: {
            name: 'tool_result',
            arguments: null,
            result: entry.toolResult,
          },
        };
        insertSpan(span);
      }
    }
  }

  // Print summary
  console.log('');
  console.log(chalk.green(' Session imported: ') + chalk.bold.cyan(sid));
  if (duration > 0) {
    console.log(dim(`   Duration: ${formatDuration(duration)}`));
  }
  console.log(dim(`   LLM calls: ${llmCalls}`) +
    dim('  |  ') +
    dim(`Tool calls: ${toolCalls}`));
  console.log(dim(`   Tokens: ${formatTokens(totalTokens)}`) +
    dim('  |  ') +
    dim(`Cost: ${formatCost(totalCost)}`));
  console.log('');
}

// --- Model/Provider Helpers ---

function deriveAgent(model: string): string {
  if (model.startsWith('claude')) return 'claude';
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return 'unknown';
}

function deriveProvider(model: string | undefined): string {
  if (!model) return 'unknown';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return 'unknown';
}
