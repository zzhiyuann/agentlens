import chalk from 'chalk';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin.toString().padStart(2, '0')}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString();
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

export function padRight(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

export function padLeft(str: string, len: number): string {
  if (str.length >= len) return str;
  return ' '.repeat(len - str.length) + str;
}

// Color helpers for consistent theming
export const dim = chalk.dim;
export const bold = chalk.bold;
export const cyan = chalk.cyan;
export const green = chalk.green;
export const red = chalk.red;
export const yellow = chalk.yellow;
export const blue = chalk.blue;
export const magenta = chalk.magenta;
export const white = chalk.white;

export function sessionIdColor(id: string): string {
  return chalk.dim.cyan(id);
}

export function costColor(cost: number): string {
  if (cost === 0) return chalk.dim('$0.00');
  if (cost < 0.10) return chalk.green(`$${cost.toFixed(2)}`);
  if (cost < 1.00) return chalk.yellow(`$${cost.toFixed(2)}`);
  return chalk.red(`$${cost.toFixed(2)}`);
}

export function statusColor(status: string): string {
  switch (status) {
    case 'completed': return chalk.green(status);
    case 'recording': return chalk.yellow(status);
    case 'error': return chalk.red(status);
    case 'interrupted': return chalk.yellow(status);
    case 'pass': return chalk.green('PASS');
    case 'fail': return chalk.red('FAIL');
    case 'skip': return chalk.yellow('SKIP');
    default: return status;
  }
}

export function spanTypeColor(type: string): string {
  switch (type) {
    case 'llm': return chalk.blue(type.toUpperCase());
    case 'tool': return chalk.green(type.toUpperCase());
    case 'agent': return chalk.magenta(type.toUpperCase());
    case 'chain': return chalk.cyan(type.toUpperCase());
    case 'error': return chalk.red(type.toUpperCase());
    default: return type.toUpperCase();
  }
}

export function bar(value: number, max: number, width: number = 20): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return chalk.green('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
}

export function heading(text: string): string {
  return chalk.bold.white(text);
}

export function label(text: string): string {
  return chalk.dim(text);
}

export function printLogo(): void {
  console.log(chalk.bold.cyan(' AgentLens') + chalk.dim(` v${getVersion()}`));
}

function getVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../package.json').version;
  } catch {
    return '0.1.0';
  }
}
