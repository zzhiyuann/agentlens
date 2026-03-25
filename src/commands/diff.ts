import chalk from 'chalk';
import { getSession, getSpansForSession } from '../core/storage';
import {
  formatDuration, formatTokens, costColor, sessionIdColor, heading, dim, bold, padRight, padLeft
} from '../utils/format';

export function diffCommand(sessionA: string, sessionB: string): void {
  const a = getSession(sessionA);
  const b = getSession(sessionB);

  if (!a) {
    console.error(chalk.red(`\n Session '${sessionA}' not found.\n`));
    return;
  }
  if (!b) {
    console.error(chalk.red(`\n Session '${sessionB}' not found.\n`));
    return;
  }

  const spansA = getSpansForSession(sessionA);
  const spansB = getSpansForSession(sessionB);

  console.log(`\n ${heading('Session Diff')}`);
  console.log(` A: ${sessionIdColor(a.id)} ${dim(`(${a.label || 'unnamed'})`)}     B: ${sessionIdColor(b.id)} ${dim(`(${b.label || 'unnamed'})`)}`);
  console.log('');

  // Comparison table
  const rows: [string, string, string, string][] = [
    ['Duration', formatDuration(a.duration), formatDuration(b.duration), formatDelta(b.duration - a.duration, 'duration')],
    ['LLM Calls', a.metadata.llmCalls.toString(), b.metadata.llmCalls.toString(), formatIntDelta(b.metadata.llmCalls - a.metadata.llmCalls)],
    ['Tool Calls', a.metadata.toolCalls.toString(), b.metadata.toolCalls.toString(), formatIntDelta(b.metadata.toolCalls - a.metadata.toolCalls)],
    ['Total Tokens', formatTokens(a.metadata.totalTokens), formatTokens(b.metadata.totalTokens), formatIntDelta(b.metadata.totalTokens - a.metadata.totalTokens)],
    ['Cost', costColor(a.metadata.estimatedCost), costColor(b.metadata.estimatedCost), formatCostDelta(b.metadata.estimatedCost - a.metadata.estimatedCost)],
  ];

  console.log(
    '   ' + padRight('', 18) +
    padRight('Session A', 18) +
    padRight('Session B', 18) +
    'Delta'
  );

  for (const [label, valA, valB, delta] of rows) {
    console.log(
      '   ' + dim(padRight(label, 18)) +
      padRight(valA, 18) +
      padRight(valB, 18) +
      delta
    );
  }

  // Find divergence point
  const divergeIdx = findDivergencePoint(spansA, spansB);
  if (divergeIdx >= 0) {
    console.log(`\n ${heading('Divergence Point:')} Step ${divergeIdx + 1}`);
    if (divergeIdx < spansA.length) {
      console.log(`   A: ${spansA[divergeIdx].name}`);
    }
    if (divergeIdx < spansB.length) {
      console.log(`   B: ${spansB[divergeIdx].name}${spansA[divergeIdx]?.name !== spansB[divergeIdx]?.name ? chalk.yellow('  DIFFERENT') : ''}`);
    }
    console.log(`\n   ${dim(`Use 'alens replay <id> --step ${divergeIdx + 1}' to inspect the divergence point`)}`);
  }

  console.log('');
}

function findDivergencePoint(spansA: import('../core/types').Span[], spansB: import('../core/types').Span[]): number {
  const maxLen = Math.max(spansA.length, spansB.length);
  for (let i = 0; i < maxLen; i++) {
    if (i >= spansA.length || i >= spansB.length) return i;
    if (spansA[i].name !== spansB[i].name) return i;
    if (spansA[i].type !== spansB[i].type) return i;
  }
  return -1; // identical
}

function formatDelta(delta: number, type: 'duration'): string {
  const prefix = delta > 0 ? '+' : '';
  const str = `${prefix}${formatDuration(Math.abs(delta))}`;
  if (delta < 0) return chalk.green(str);
  if (delta > 0) return chalk.red(str);
  return dim(str);
}

function formatIntDelta(delta: number): string {
  const prefix = delta > 0 ? '+' : '';
  const str = `${prefix}${delta}`;
  if (delta < 0) return chalk.green(str);
  if (delta > 0) return chalk.red(str);
  return dim(str);
}

function formatCostDelta(delta: number): string {
  const prefix = delta > 0 ? '+' : '-';
  const str = `${prefix}$${Math.abs(delta).toFixed(2)}`;
  if (delta < 0) return chalk.green(str);
  if (delta > 0) return chalk.red(str);
  return dim(str);
}
