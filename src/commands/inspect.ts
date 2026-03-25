import chalk from 'chalk';
import { getSession, getSpansForSession } from '../core/storage';
import {
  formatDuration, formatTokens, costColor, sessionIdColor, spanTypeColor,
  heading, dim, bold, padLeft
} from '../utils/format';
import { formatCost } from '../core/cost';

export function inspectCommand(sessionId: string, options: { section?: string; verbose?: boolean }): void {
  const session = getSession(sessionId);
  if (!session) {
    printSessionNotFound(sessionId);
    return;
  }

  const spans = getSpansForSession(sessionId);

  // Session header
  console.log(`\n ${heading('Session:')} ${sessionIdColor(session.id)}`);
  if (session.label) console.log(` ${dim('Label:')} ${session.label}`);
  console.log(` ${dim('Agent:')} ${session.agent}${session.model ? ` (${session.model})` : ''}`);
  console.log(` ${dim('Duration:')} ${formatDuration(session.duration)}  |  ${dim('Started:')} ${session.startTime}`);

  if (!options.section || options.section === 'summary') {
    printSummary(session);
  }

  if (!options.section || options.section === 'calls' || options.section === 'timeline') {
    printTimeline(spans, options.verbose);
  }

  if (options.section === 'cost') {
    printCostBreakdown(spans);
  }

  if (options.section === 'tools') {
    printToolSummary(spans);
  }

  console.log(`\n ${dim(`Use 'alens replay ${session.id}' for interactive step-through`)}\n`);
}

function printSummary(session: import('../core/types').Session): void {
  const { metadata } = session;
  console.log(`\n ${heading('Summary')}`);
  console.log(`   LLM Calls: ${bold(metadata.llmCalls.toString())}  |  Tool Calls: ${bold(metadata.toolCalls.toString())}  |  Total Tokens: ${formatTokens(metadata.totalTokens)}`);
  console.log(`   Input: ${formatTokens(metadata.inputTokens)} tokens (${formatCost(calculateInputCost(metadata))})  |  Output: ${formatTokens(metadata.outputTokens)} tokens (${formatCost(calculateOutputCost(metadata))})`);
  console.log(`   Estimated Cost: ${costColor(metadata.estimatedCost)}`);
}

function printTimeline(spans: import('../core/types').Span[], verbose?: boolean): void {
  if (spans.length === 0) {
    console.log(`\n ${dim('No spans recorded.')}`);
    return;
  }

  console.log(`\n ${heading('Timeline')}`);

  for (const span of spans) {
    const time = new Date(span.startTime).toTimeString().slice(0, 8);
    const type = spanTypeColor(span.type);
    let desc = span.name;
    let costStr = dim('\u2014');

    if (span.llm) {
      desc = `${span.name} (${formatTokens(span.llm.inputTokens + span.llm.outputTokens)} tokens)`;
      costStr = costColor(span.llm.cost);
    }

    if (span.tool) {
      desc = span.tool.name;
      if (span.tool.arguments && typeof span.tool.arguments === 'object') {
        const args = Object.values(span.tool.arguments as Record<string, unknown>);
        if (args.length > 0 && typeof args[0] === 'string') {
          desc += ` ${dim(truncateArg(args[0] as string, 40))}`;
        }
      }
    }

    console.log(`   ${dim(time)}  ${type}   ${desc}${' '.repeat(Math.max(0, 50 - desc.length))}${costStr}`);

    // Show details in verbose mode
    if (verbose && span.llm) {
      console.log(dim(`            Model: ${span.llm.model} | Latency: ${formatDuration(span.duration)}`));
      if (span.llm.response) {
        const preview = span.llm.response.slice(0, 100).replace(/\n/g, ' ');
        console.log(dim(`            Response: ${preview}${span.llm.response.length > 100 ? '...' : ''}`));
      }
    }

    if (verbose && span.tool?.error) {
      console.log(chalk.red(`            Error: ${span.tool.error}`));
    }
  }

  if (!verbose && spans.length > 10) {
    console.log(dim(`\n   (+${spans.length - 10} more — expand with --verbose)`));
  }
}

function printCostBreakdown(spans: import('../core/types').Span[]): void {
  console.log(`\n ${heading('Cost Breakdown')}`);

  const llmSpans = spans.filter(s => s.llm);
  if (llmSpans.length === 0) {
    console.log(dim('   No LLM calls with cost data.'));
    return;
  }

  let runningCost = 0;
  for (const span of llmSpans) {
    runningCost += span.llm!.cost;
    const time = new Date(span.startTime).toTimeString().slice(0, 8);
    console.log(
      `   ${dim(time)}  ${span.name}` +
      `${' '.repeat(Math.max(0, 35 - span.name.length))}` +
      `${padLeft(formatCost(span.llm!.cost), 8)}` +
      `  ${dim('running:')} ${costColor(runningCost)}`
    );
  }

  console.log(`\n   ${bold('Total:')} ${costColor(runningCost)}`);
}

function printToolSummary(spans: import('../core/types').Span[]): void {
  console.log(`\n ${heading('Tool Summary')}`);

  const toolSpans = spans.filter(s => s.tool);
  if (toolSpans.length === 0) {
    console.log(dim('   No tool calls recorded.'));
    return;
  }

  // Group by tool name
  const byTool = new Map<string, number>();
  for (const span of toolSpans) {
    const name = span.tool!.name;
    byTool.set(name, (byTool.get(name) || 0) + 1);
  }

  const sorted = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`   ${name}${' '.repeat(Math.max(0, 30 - name.length))}${count}x`);
  }
}

function printSessionNotFound(id: string): void {
  console.error(chalk.red(`\n Session '${id}' not found.\n`));
  console.log(' Use ' + chalk.cyan('alens list') + ' to see available sessions.\n');
}

function truncateArg(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

function calculateInputCost(meta: import('../core/types').SessionMetadata): number {
  // Rough split based on token ratio
  if (meta.totalTokens === 0) return 0;
  return meta.estimatedCost * (meta.inputTokens / meta.totalTokens);
}

function calculateOutputCost(meta: import('../core/types').SessionMetadata): number {
  if (meta.totalTokens === 0) return 0;
  return meta.estimatedCost * (meta.outputTokens / meta.totalTokens);
}
