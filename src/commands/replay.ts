import chalk from 'chalk';
import * as readline from 'readline';
import { getSession, getSpansForSession } from '../core/storage';
import { Span } from '../core/types';
import {
  formatDuration, formatTokens, costColor, sessionIdColor, spanTypeColor,
  heading, dim, bold
} from '../utils/format';
import { formatCost } from '../core/cost';

export function replayCommand(sessionId: string, options: { step?: number }): void {
  const session = getSession(sessionId);
  if (!session) {
    console.error(chalk.red(`\n Session '${sessionId}' not found.\n`));
    console.log(' Use ' + chalk.cyan('alens list') + ' to see available sessions.\n');
    return;
  }

  const spans = getSpansForSession(sessionId);
  if (spans.length === 0) {
    console.log(chalk.dim('\n No spans to replay.\n'));
    return;
  }

  const startStep = Math.max(0, Math.min((options.step || 1) - 1, spans.length - 1));
  startReplay(session, spans, startStep);
}

function startReplay(
  session: import('../core/types').Session,
  spans: Span[],
  initialStep: number
): void {
  let currentStep = initialStep;
  let showCost = true;
  let showTokens = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Enable raw mode for single key input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const render = () => {
    console.clear();
    const span = spans[currentStep];
    const totalCost = spans.slice(0, currentStep + 1)
      .reduce((sum, s) => sum + (s.llm?.cost || 0), 0);

    // Header
    console.log(` ${heading('Replaying:')} ${sessionIdColor(session.id)} ${dim(`(${session.label || 'unnamed'})`)}`);
    console.log(` ${bold(`Step ${currentStep + 1} of ${spans.length}`)}  |  ${dim(new Date(span.startTime).toTimeString().slice(0, 8))}  |  ${spanTypeColor(span.type)}`);
    console.log('');

    // Progress bar
    const progressWidth = 60;
    const filled = Math.round(((currentStep + 1) / spans.length) * progressWidth);
    const empty = progressWidth - filled;
    console.log(` ${chalk.cyan('\u2588'.repeat(filled))}${chalk.dim('\u2591'.repeat(empty))} ${currentStep + 1}/${spans.length}`);
    console.log('');

    // Span content
    if (span.llm) {
      renderLLMSpan(span, showTokens);
    } else if (span.tool) {
      renderToolSpan(span);
    } else {
      renderGenericSpan(span);
    }

    // Footer
    console.log('');
    if (showCost) {
      console.log(` ${dim('Cost so far:')} ${costColor(totalCost)} / ${costColor(session.metadata.estimatedCost)} ${dim('total')}`);
    }
    console.log('');
    console.log(` ${dim('[n]ext  [p]rev  [j]ump #  [e]xpand  [c]ost  [t]okens  [q]uit')}`);
  };

  render();

  process.stdin.on('data', (key: Buffer) => {
    const char = key.toString();

    switch (char) {
      case 'n':
      case '\r':
      case '\x1B[C': // right arrow
        if (currentStep < spans.length - 1) {
          currentStep++;
          render();
        }
        break;

      case 'p':
      case '\x1B[D': // left arrow
        if (currentStep > 0) {
          currentStep--;
          render();
        }
        break;

      case 'j': {
        // Jump mode — read a number
        process.stdout.write('\n Jump to step: ');
        rl.question('', (answer: string) => {
          const num = parseInt(answer);
          if (num >= 1 && num <= spans.length) {
            currentStep = num - 1;
          }
          render();
        });
        return;
      }

      case 'c':
        showCost = !showCost;
        render();
        break;

      case 't':
        showTokens = !showTokens;
        render();
        break;

      case 'e':
        renderExpanded(spans[currentStep]);
        break;

      case 'q':
      case '\x1B': // Escape
      case '\x03': // Ctrl+C
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        rl.close();
        console.log('');
        process.exit(0);
        break;
    }
  });
}

function renderLLMSpan(span: Span, showTokens: boolean): void {
  const llm = span.llm!;
  const totalTokens = llm.inputTokens + llm.outputTokens;

  console.log(` ${bold('LLM Call:')} ${span.name}`);
  console.log(` ${dim('Model:')} ${llm.model}  ${dim('|  Latency:')} ${formatDuration(span.duration)}`);
  if (showTokens) {
    console.log(` ${dim('Tokens:')} ${formatTokens(llm.inputTokens)} in + ${formatTokens(llm.outputTokens)} out = ${formatTokens(totalTokens)} total`);
  }
  console.log('');

  // Messages (prompt)
  if (llm.messages.length > 0) {
    console.log(` ${dim('Prompt')} ${dim(`(${formatTokens(llm.inputTokens)} tokens)`)}`);
    console.log(` ${chalk.dim('\u250C' + '\u2500'.repeat(60) + '\u2510')}`);
    for (const msg of llm.messages.slice(0, 3)) {
      const roleColor = msg.role === 'system' ? chalk.magenta : msg.role === 'user' ? chalk.cyan : chalk.green;
      const preview = (msg.content || '').slice(0, 200).replace(/\n/g, '\n \u2502 ');
      console.log(` \u2502 ${roleColor(msg.role + ':')} ${preview}`);
    }
    if (llm.messages.length > 3) {
      console.log(` \u2502 ${dim(`... +${llm.messages.length - 3} more messages`)}`);
    }
    console.log(` ${chalk.dim('\u2514' + '\u2500'.repeat(60) + '\u2518')}`);
  }

  // Response
  if (llm.response) {
    console.log('');
    console.log(` ${dim('Response')} ${dim(`(${formatTokens(llm.outputTokens)} tokens, ${formatDuration(span.duration)} latency)`)}`);
    console.log(` ${chalk.dim('\u250C' + '\u2500'.repeat(60) + '\u2510')}`);
    const preview = llm.response.slice(0, 500).replace(/\n/g, '\n \u2502 ');
    console.log(` \u2502 ${preview}`);
    if (llm.response.length > 500) {
      console.log(` \u2502 ${dim(`... +${llm.response.length - 500} chars (press 'e' to expand)`)}`);
    }
    console.log(` ${chalk.dim('\u2514' + '\u2500'.repeat(60) + '\u2518')}`);
  }
}

function renderToolSpan(span: Span): void {
  const tool = span.tool!;

  console.log(` ${bold('Tool Call:')} ${chalk.green(tool.name)}`);
  console.log(` ${dim('Duration:')} ${formatDuration(span.duration)}  ${dim('|  Status:')} ${span.status === 'ok' ? chalk.green('ok') : chalk.red('error')}`);
  console.log('');

  // Arguments
  if (tool.arguments) {
    console.log(` ${dim('Arguments:')}`);
    const argsStr = typeof tool.arguments === 'string'
      ? tool.arguments
      : JSON.stringify(tool.arguments, null, 2);
    const lines = argsStr.split('\n').slice(0, 10);
    for (const line of lines) {
      console.log(`   ${chalk.yellow(line)}`);
    }
  }

  // Result
  if (tool.result) {
    console.log('');
    console.log(` ${dim('Result:')}`);
    const resultStr = typeof tool.result === 'string'
      ? tool.result
      : JSON.stringify(tool.result, null, 2);
    const lines = resultStr.split('\n').slice(0, 15);
    for (const line of lines) {
      console.log(`   ${line}`);
    }
    const allLines = resultStr.split('\n');
    if (allLines.length > 15) {
      console.log(dim(`   ... +${allLines.length - 15} lines (press 'e' to expand)`));
    }
  }

  // Error
  if (tool.error) {
    console.log('');
    console.log(chalk.red(` Error: ${tool.error}`));
  }
}

function renderGenericSpan(span: Span): void {
  console.log(` ${bold(span.type.toUpperCase())} ${span.name}`);
  console.log(` ${dim('Duration:')} ${formatDuration(span.duration)}`);

  if (Object.keys(span.attributes).length > 0) {
    console.log('');
    console.log(` ${dim('Attributes:')}`);
    for (const [key, value] of Object.entries(span.attributes)) {
      console.log(`   ${key}: ${JSON.stringify(value)}`);
    }
  }
}

function renderExpanded(span: Span): void {
  console.clear();
  console.log(` ${heading('Expanded View')} — ${spanTypeColor(span.type)} ${span.name}\n`);

  if (span.llm) {
    if (span.llm.messages.length > 0) {
      console.log(bold(' === FULL PROMPT ===\n'));
      for (const msg of span.llm.messages) {
        console.log(chalk.cyan(` [${msg.role}]`));
        console.log(` ${msg.content}\n`);
      }
    }
    if (span.llm.response) {
      console.log(bold(' === FULL RESPONSE ===\n'));
      console.log(` ${span.llm.response}`);
    }
  }

  if (span.tool) {
    if (span.tool.arguments) {
      console.log(bold(' === ARGUMENTS ===\n'));
      console.log(JSON.stringify(span.tool.arguments, null, 2));
    }
    if (span.tool.result) {
      console.log(bold('\n === RESULT ===\n'));
      console.log(typeof span.tool.result === 'string' ? span.tool.result : JSON.stringify(span.tool.result, null, 2));
    }
  }

  console.log(dim('\n Press any key to return...'));
}
