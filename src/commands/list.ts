import chalk from 'chalk';
import { listSessions } from '../core/storage';
import {
  formatDuration, formatRelativeTime, truncate, costColor, sessionIdColor,
  statusColor, formatTokens, padRight, padLeft, heading
} from '../utils/format';

export function listCommand(options: {
  label?: string;
  agent?: string;
  since?: string;
  cost?: string;
  limit?: number;
}): void {
  // Parse --since to ISO date
  let sinceDate: string | undefined;
  if (options.since) {
    sinceDate = parseSince(options.since);
  }

  // Parse --cost to number
  let minCost: number | undefined;
  if (options.cost) {
    const match = options.cost.match(/[>]?\s*([\d.]+)/);
    if (match) minCost = parseFloat(match[1]);
  }

  const { sessions, total } = listSessions({
    limit: options.limit || 20,
    label: options.label,
    agent: options.agent,
    since: sinceDate,
    minCost,
  });

  if (sessions.length === 0) {
    console.log(chalk.dim('\n No recorded sessions found.\n'));
    console.log(' Record your first session:');
    console.log(chalk.cyan('   alens record claude "your task"\n'));
    return;
  }

  const showing = sessions.length < total ? `showing ${sessions.length}` : 'all';
  console.log(`\n ${heading(`Sessions`)} ${chalk.dim(`(${total} total, ${showing})`)}\n`);

  // Table header
  const cols = {
    id: 12,
    label: 20,
    agent: 10,
    duration: 9,
    calls: 7,
    cost: 8,
    date: 14,
  };

  console.log(
    '   ' +
    chalk.dim(padRight('ID', cols.id)) + '  ' +
    chalk.dim(padRight('Label', cols.label)) + '  ' +
    chalk.dim(padRight('Agent', cols.agent)) + '  ' +
    chalk.dim(padRight('Duration', cols.duration)) + '  ' +
    chalk.dim(padRight('Calls', cols.calls)) + '  ' +
    chalk.dim(padLeft('Cost', cols.cost)) + '  ' +
    chalk.dim('Date')
  );

  for (const session of sessions) {
    const totalCalls = session.metadata.llmCalls + session.metadata.toolCalls;
    console.log(
      '   ' +
      sessionIdColor(truncate(session.id, cols.id)) + '  ' +
      padRight(truncate(session.label || '-', cols.label), cols.label) + '  ' +
      padRight(truncate(session.agent, cols.agent), cols.agent) + '  ' +
      padRight(formatDuration(session.duration), cols.duration) + '  ' +
      padRight(totalCalls.toString(), cols.calls) + '  ' +
      padLeft(costColor(session.metadata.estimatedCost), cols.cost + 10) + '  ' + // +10 for ANSI codes
      chalk.dim(formatRelativeTime(session.startTime))
    );
  }

  // Total line
  const totalCost = sessions.reduce((sum, s) => sum + s.metadata.estimatedCost, 0);
  const totalDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
  console.log(`\n   ${chalk.dim('Total:')} ${total} sessions | ${costColor(totalCost)} total cost | ${formatDuration(totalDuration)} total time\n`);
}

function parseSince(since: string): string {
  const match = since.match(/^(\d+)\s*(h|d|w|m)$/);
  if (!match) {
    // Try as-is date
    return since;
  }

  const amount = parseInt(match[1]);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case 'h': now.setHours(now.getHours() - amount); break;
    case 'd': now.setDate(now.getDate() - amount); break;
    case 'w': now.setDate(now.getDate() - amount * 7); break;
    case 'm': now.setMonth(now.getMonth() - amount); break;
  }

  return now.toISOString();
}
