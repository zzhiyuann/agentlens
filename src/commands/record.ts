import chalk from 'chalk';
import { ClaudeCodeAdapter } from '../adapters/claude-code';
import { formatDuration, formatTokens, costColor, sessionIdColor } from '../utils/format';

export async function recordCommand(commandArgs: string[], options: { label?: string }): Promise<void> {
  if (commandArgs.length === 0) {
    console.error(chalk.red(' Error: No command specified.'));
    console.log('\n Usage: alens record <command> [args...]');
    console.log(' Example: alens record claude "Fix the login bug"');
    process.exit(1);
  }

  const command = commandArgs.join(' ');
  const adapter = new ClaudeCodeAdapter();

  const detected = await adapter.detect();
  if (!detected) {
    console.error(chalk.red(' No compatible agent adapter detected.'));
    console.log('\n Supported adapters:');
    console.log('   claude-code   Claude Code CLI (install: npm install -g @anthropic-ai/claude-code)');
    console.log('\n Manual adapter: alens config set adapter claude-code');
    process.exit(1);
  }

  console.log(chalk.dim(' Recording session...'));
  if (options.label) {
    console.log(chalk.dim(` Label: ${options.label}`));
  }

  const handle = await adapter.startRecording({
    command,
    label: options.label,
  });

  console.log(chalk.dim(` Session ID: ${handle.sessionId}`));
  console.log('');

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    console.log('\n' + chalk.dim(' Stopping recording...'));
    const session = await handle.stop();
    printSessionSummary(session.id, session.duration, session.metadata.llmCalls,
      session.metadata.toolCalls, session.metadata.totalTokens, session.metadata.estimatedCost);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    const session = await handle.stop();
    console.log('');
    printSessionSummary(session.id, session.duration, session.metadata.llmCalls,
      session.metadata.toolCalls, session.metadata.totalTokens, session.metadata.estimatedCost);
  } catch (err) {
    console.error(chalk.red(` Recording error: ${(err as Error).message}`));
    console.log('\n Troubleshooting:');
    console.log('   1. Ensure Claude Code is installed: claude --version');
    console.log('   2. Check permissions: ls -la ~/.claude/');
    console.log('\n Report: https://github.com/zzhiyuann/agentlens/issues');
    process.exit(1);
  }
}

function printSessionSummary(id: string, duration: number, llmCalls: number,
  toolCalls: number, totalTokens: number, cost: number): void {
  console.log(chalk.green(' Session recorded: ') + sessionIdColor(id));
  console.log(`   Duration: ${formatDuration(duration)}`);
  console.log(`   LLM calls: ${llmCalls}  |  Tool calls: ${toolCalls}`);
  console.log(`   Tokens: ${formatTokens(totalTokens)}  |  Cost: ${costColor(cost)}`);
}
