import chalk from 'chalk';
import { getStats } from '../core/storage';
import { formatDuration, formatTokens, costColor, heading, dim, bold, bar, padRight, padLeft } from '../utils/format';

export function statsCommand(options: { since?: string }): void {
  let sinceDate: string | undefined;
  let sinceLabel = 'all time';

  if (options.since) {
    const match = options.since.match(/^(\d+)\s*(h|d|w|m)$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const now = new Date();
      switch (unit) {
        case 'h': now.setHours(now.getHours() - amount); sinceLabel = `last ${amount} hour${amount > 1 ? 's' : ''}`; break;
        case 'd': now.setDate(now.getDate() - amount); sinceLabel = `last ${amount} day${amount > 1 ? 's' : ''}`; break;
        case 'w': now.setDate(now.getDate() - amount * 7); sinceLabel = `last ${amount} week${amount > 1 ? 's' : ''}`; break;
        case 'm': now.setMonth(now.getMonth() - amount); sinceLabel = `last ${amount} month${amount > 1 ? 's' : ''}`; break;
      }
      sinceDate = now.toISOString();
    }
  }

  const stats = getStats(sinceDate);

  if (stats.sessionCount === 0) {
    console.log(dim('\n No sessions recorded yet.\n'));
    console.log(' Record your first session:');
    console.log(chalk.cyan('   alens record claude "your task"\n'));
    return;
  }

  console.log(`\n ${heading('AgentLens Stats')} ${dim(`(${sinceLabel})`)}\n`);

  console.log(`   Sessions: ${bold(stats.sessionCount.toString())}`);
  console.log(`   Total Duration: ${bold(formatDuration(stats.totalDuration))}`);
  console.log(`   LLM Calls: ${bold(stats.llmCalls.toString())}`);
  console.log(`   Tool Calls: ${bold(stats.toolCalls.toString())}`);
  console.log(`   Total Tokens: ${bold(formatTokens(stats.totalTokens))}`);
  console.log(`   Total Cost: ${costColor(stats.totalCost)}`);

  // By agent
  if (stats.byAgent.length > 0) {
    console.log(`\n ${heading('By Agent:')}`);
    const totalCost = stats.totalCost || 1;
    for (const agent of stats.byAgent) {
      const pct = Math.round((agent.cost / totalCost) * 100);
      console.log(`   ${padRight(agent.agent, 20)} ${agent.sessions} sessions    ${costColor(agent.cost)} (${pct}%)`);
    }
  }

  // Daily cost trend
  if (stats.dailyCost.length > 0) {
    console.log(`\n ${heading('Cost Trend:')}`);
    const maxCost = Math.max(...stats.dailyCost.map(d => d.cost), 0.01);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (const { date, cost } of stats.dailyCost.slice(-7)) {
      const dayName = days[new Date(date).getDay()];
      console.log(`   ${padRight(dayName, 4)} ${bar(cost, maxCost, 20)} ${costColor(cost)}`);
    }
  }

  console.log('');
}
