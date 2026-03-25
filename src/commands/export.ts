import chalk from 'chalk';
import { getSession, getSpansForSession } from '../core/storage';
import { Session, Span } from '../core/types';
import { formatDuration, formatTokens } from '../utils/format';
import { formatCost } from '../core/cost';

export function exportCommand(sessionId: string, options: { format?: string }): void {
  const session = getSession(sessionId);
  if (!session) {
    console.error(chalk.red(`\n Session '${sessionId}' not found.\n`));
    process.exit(1);
  }

  const spans = getSpansForSession(sessionId);
  const fullSession = { ...session, spans };
  const format = options.format || 'json';

  switch (format) {
    case 'json':
      console.log(JSON.stringify(fullSession, null, 2));
      break;
    case 'markdown':
    case 'md':
      console.log(toMarkdown(fullSession, spans));
      break;
    case 'html':
      console.log(toHtml(fullSession, spans));
      break;
    default:
      console.error(chalk.red(`\n Unknown format: ${format}`));
      console.log(' Supported formats: json, markdown, html');
      process.exit(1);
  }
}

function toMarkdown(session: Session, spans: Span[]): string {
  const lines: string[] = [];

  lines.push(`# Session: ${session.id}`);
  lines.push('');
  if (session.label) lines.push(`**Label:** ${session.label}`);
  lines.push(`**Agent:** ${session.agent}${session.model ? ` (${session.model})` : ''}`);
  lines.push(`**Command:** \`${session.command}\``);
  lines.push(`**Duration:** ${formatDuration(session.duration)}`);
  lines.push(`**Status:** ${session.status}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| LLM Calls | ${session.metadata.llmCalls} |`);
  lines.push(`| Tool Calls | ${session.metadata.toolCalls} |`);
  lines.push(`| Total Tokens | ${formatTokens(session.metadata.totalTokens)} |`);
  lines.push(`| Input Tokens | ${formatTokens(session.metadata.inputTokens)} |`);
  lines.push(`| Output Tokens | ${formatTokens(session.metadata.outputTokens)} |`);
  lines.push(`| Estimated Cost | ${formatCost(session.metadata.estimatedCost)} |`);
  lines.push('');

  lines.push('## Timeline');
  lines.push('');

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const time = new Date(span.startTime).toTimeString().slice(0, 8);
    lines.push(`### Step ${i + 1}: ${span.type.toUpperCase()} — ${span.name}`);
    lines.push(`*${time} | ${formatDuration(span.duration)}*`);
    lines.push('');

    if (span.llm) {
      lines.push(`**Model:** ${span.llm.model}`);
      lines.push(`**Tokens:** ${formatTokens(span.llm.inputTokens)} in / ${formatTokens(span.llm.outputTokens)} out`);
      lines.push(`**Cost:** ${formatCost(span.llm.cost)}`);
      if (span.llm.response) {
        lines.push('');
        lines.push('**Response:**');
        lines.push('```');
        lines.push(span.llm.response.slice(0, 500));
        if (span.llm.response.length > 500) lines.push('... (truncated)');
        lines.push('```');
      }
    }

    if (span.tool) {
      lines.push(`**Tool:** ${span.tool.name}`);
      if (span.tool.arguments) {
        lines.push('```json');
        lines.push(JSON.stringify(span.tool.arguments, null, 2));
        lines.push('```');
      }
    }

    lines.push('');
  }

  lines.push('---');
  lines.push(`*Exported by AgentLens v0.1.0*`);

  return lines.join('\n');
}

function toHtml(session: Session, spans: Span[]): string {
  const md = toMarkdown(session, spans);
  // Simple HTML wrapper — not a full markdown parser
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session: ${session.id}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; background: #0a0a0f; color: #e0e0e0; }
    pre { background: #1a1a2e; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    code { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #333; padding: 0.5rem 1rem; text-align: left; }
    th { background: #1a1a2e; }
    h1 { color: #818cf8; }
    h2 { color: #34d399; }
    h3 { color: #fbbf24; }
    a { color: #818cf8; }
  </style>
</head>
<body>
  <pre>${escapeHtml(md)}</pre>
  <footer><small>Exported by AgentLens v0.1.0</small></footer>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
