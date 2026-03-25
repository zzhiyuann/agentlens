import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ClaudeCodeAdapter } from '../adapters/claude-code';
import { MemoryEntry } from '../core/types';
import { heading, dim, bold, padRight, padLeft, green, red, yellow, bar } from '../utils/format';

export async function memoryShowCommand(memoryPath: string, options: { stats?: boolean }): Promise<void> {
  const adapter = new ClaudeCodeAdapter();
  const resolvedPath = memoryPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n Path not found: ${resolvedPath}\n`));
    return;
  }

  const snapshot = await adapter.getMemory(memoryPath);
  const { entries, metadata } = snapshot;

  if (entries.length === 0) {
    console.log(dim('\n No memory files found.\n'));
    return;
  }

  console.log(`\n ${heading('Memory:')} ${resolvedPath} ${dim(`(${metadata.fileCount} files, ${formatBytes(metadata.totalSize)})`)}`);
  console.log('');

  // Table header
  console.log(
    '   ' +
    dim(padRight('File', 30)) + '  ' +
    dim(padRight('Size', 8)) + '  ' +
    dim(padRight('Modified', 14)) + '  ' +
    dim(padRight('Lines', 6)) + '  ' +
    dim('Status')
  );

  for (const entry of entries) {
    const statusStr = entryStatusColor(entry.status);
    const lines = entry.content.split('\n').length;
    const modified = formatRelativeDate(entry.lastModified);

    console.log(
      '   ' +
      padRight(truncate(entry.file, 30), 30) + '  ' +
      padRight(formatBytes(entry.size), 8) + '  ' +
      padRight(modified, 14) + '  ' +
      padRight(lines.toString(), 6) + '  ' +
      statusStr
    );
  }

  // Health summary
  console.log('');
  console.log(` ${heading('Health Score:')} ${healthScoreColor(metadata.healthScore)}/100`);

  const fresh = entries.filter(e => e.status === 'fresh').length;
  const active = entries.filter(e => e.status === 'active').length;
  const stale = entries.filter(e => e.status === 'stale').length;

  console.log(`   ${green('Fresh (< 3 days):')} ${fresh} files (${pct(fresh, entries.length)}%)`);
  console.log(`   ${yellow('Active (< 2 weeks):')} ${active} files (${pct(active, entries.length)}%)`);
  console.log(`   ${dim('Stale (> 2 weeks):')} ${stale} files (${pct(stale, entries.length)}%)`);
  console.log(`\n   ${dim("Tip: Run 'alens memory health' for detailed recommendations")}\n`);
}

export async function memoryDiffCommand(memoryPath: string, options: { from?: string; to?: string }): Promise<void> {
  const resolvedPath = memoryPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n Path not found: ${resolvedPath}\n`));
    return;
  }

  // Check if path is in a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: resolvedPath, stdio: 'pipe' });
  } catch {
    console.error(chalk.red('\n Memory diff requires a git repository.\n'));
    return;
  }

  const fromRef = options.from || 'HEAD~5';
  const toRef = options.to || 'HEAD';

  console.log(`\n ${heading('Memory Diff:')} ${dim(`${fromRef} -> ${toRef}`)}\n`);

  try {
    // Get diff stats
    const diffOutput = execSync(
      `git diff --stat --name-status ${fromRef}..${toRef} -- "${resolvedPath}"`,
      { cwd: path.dirname(resolvedPath), encoding: 'utf-8' }
    ).trim();

    if (!diffOutput) {
      console.log(dim(' No changes in memory files.\n'));
      return;
    }

    const lines = diffOutput.split('\n');
    let added = 0, modified = 0, deleted = 0;

    for (const line of lines) {
      const [status, file] = line.split('\t');
      if (!file) continue;

      const basename = path.basename(file);
      if (status === 'A') {
        console.log(` ${green('+')} ${bold('Added:')} ${basename}`);
        added++;
      } else if (status === 'M') {
        // Get line diff
        try {
          const numstat = execSync(
            `git diff --numstat ${fromRef}..${toRef} -- "${file}"`,
            { cwd: path.dirname(resolvedPath), encoding: 'utf-8' }
          ).trim();
          const parts = numstat.split('\t');
          console.log(` ${yellow('~')} ${bold('Modified:')} ${basename} ${dim(`+${parts[0]} / -${parts[1]} lines`)}`);
        } catch {
          console.log(` ${yellow('~')} ${bold('Modified:')} ${basename}`);
        }
        modified++;
      } else if (status === 'D') {
        console.log(` ${red('-')} ${bold('Deleted:')} ${basename}`);
        deleted++;
      }
    }

    console.log(`\n ${dim('Summary:')} +${added} file${added !== 1 ? 's' : ''}, ~${modified} modified, -${deleted} deleted\n`);
  } catch (err) {
    console.error(chalk.red(` Git diff failed: ${(err as Error).message}`));
  }
}

export async function memoryTimelineCommand(memoryPath: string, options: { since?: string }): Promise<void> {
  const resolvedPath = memoryPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n Path not found: ${resolvedPath}\n`));
    return;
  }

  console.log(`\n ${heading('Memory Timeline:')} ${resolvedPath}\n`);

  try {
    const sinceArg = options.since ? `--since="${options.since}"` : '--since="1 month"';
    const logOutput = execSync(
      `git log ${sinceArg} --name-status --pretty=format:"%ad" --date=short -- "${resolvedPath}"`,
      { cwd: path.dirname(resolvedPath), encoding: 'utf-8' }
    ).trim();

    if (!logOutput) {
      console.log(dim(' No changes found in this period.\n'));
      return;
    }

    // Parse git log into timeline entries
    const entries: { date: string; file: string; action: string }[] = [];
    let currentDate = '';
    for (const line of logOutput.split('\n')) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
        currentDate = line;
      } else if (line.startsWith('A\t') || line.startsWith('M\t') || line.startsWith('D\t')) {
        const [action, file] = line.split('\t');
        entries.push({ date: currentDate, file: path.basename(file), action });
      }
    }

    // Group by date
    const byDate = new Map<string, { file: string; action: string }[]>();
    for (const entry of entries) {
      const list = byDate.get(entry.date) || [];
      list.push({ file: entry.file, action: entry.action });
      byDate.set(entry.date, list);
    }

    for (const [date, files] of byDate) {
      const dateStr = formatDateShort(date);
      for (const { file, action } of files) {
        const actionLabel = action === 'A' ? 'NEW' : action === 'D' ? 'DEL' : 'MOD';
        const actColor = action === 'A' ? green : action === 'D' ? red : yellow;
        const barWidth = Math.min(10, file.length);
        console.log(` ${dateStr} ${bar(barWidth, 10, 10)} ${file} ${actColor(`(${actionLabel})`)}`);
      }
    }

    console.log(`\n ${dim(`Activity: ${entries.length} changes`)}\n`);
  } catch {
    // Fall back to filesystem-only timeline
    const files = fs.readdirSync(resolvedPath).filter(f => f.endsWith('.md'));
    const sorted = files.map(f => {
      const stat = fs.statSync(path.join(resolvedPath, f));
      return { file: f, mtime: stat.mtime };
    }).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const { file, mtime } of sorted) {
      console.log(` ${formatDateShort(mtime.toISOString().slice(0, 10))} ${file} ${dim(`(${formatRelativeDate(mtime.toISOString())})`)}`);
    }
    console.log('');
  }
}

export async function memoryHealthCommand(memoryPath: string): Promise<void> {
  const adapter = new ClaudeCodeAdapter();
  const resolvedPath = memoryPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n Path not found: ${resolvedPath}\n`));
    return;
  }

  const snapshot = await adapter.getMemory(memoryPath);
  const { entries, metadata } = snapshot;

  console.log(`\n ${heading('Memory Health Report')}\n`);
  console.log(` ${bold('Overall Score:')} ${healthScoreColor(metadata.healthScore)}/100\n`);

  if (entries.length === 0) {
    console.log(dim(' No memory files found.\n'));
    return;
  }

  const issues: { severity: string; message: string; detail: string; recommendation: string }[] = [];

  // Check for stale files
  const staleFiles = entries.filter(e => e.status === 'stale');
  if (staleFiles.length > 0) {
    issues.push({
      severity: 'STALE',
      message: `${staleFiles.length} file${staleFiles.length > 1 ? 's' : ''} haven't been updated in 2+ weeks`,
      detail: staleFiles.map(f => f.file).join(', '),
      recommendation: 'Review and update or archive',
    });
  }

  // Check for orphaned files (not referenced in index)
  const indexFile = path.join(resolvedPath, '..', 'MEMORY.md');
  let indexContent = '';
  try {
    const altIndex = path.join(resolvedPath, '..', '.agent-memory-index.md');
    if (fs.existsSync(indexFile)) {
      indexContent = fs.readFileSync(indexFile, 'utf-8');
    } else if (fs.existsSync(altIndex)) {
      indexContent = fs.readFileSync(altIndex, 'utf-8');
    }
  } catch { /* no index */ }

  if (indexContent) {
    const orphans = entries.filter(e => !indexContent.includes(e.file));
    if (orphans.length > 0) {
      issues.push({
        severity: 'ORPHAN',
        message: `${orphans.length} file${orphans.length > 1 ? 's' : ''} not referenced in index`,
        detail: orphans.map(f => f.file).join(', '),
        recommendation: 'Add to index or remove if obsolete',
      });
    }
  }

  // Check for potential duplicates (simple content overlap)
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const overlap = calculateOverlap(entries[i].content, entries[j].content);
      if (overlap > 0.3) {
        issues.push({
          severity: 'DUPE',
          message: `${entries[i].file} and ${entries[j].file} have ${Math.round(overlap * 100)}% content overlap`,
          detail: '',
          recommendation: 'Consolidate into one file',
        });
      }
    }
  }

  // Check for oversized files
  const largeFiles = entries.filter(e => e.size > 3000);
  for (const f of largeFiles) {
    issues.push({
      severity: 'SIZE',
      message: `${f.file} is ${formatBytes(f.size)} — approaching unwieldy`,
      detail: '',
      recommendation: 'Split into topic-specific files',
    });
  }

  if (issues.length === 0) {
    console.log(green(' No issues found! Memory is in good health.\n'));
    return;
  }

  console.log(` ${heading('Issues Found:')}\n`);
  for (const issue of issues) {
    const color = issue.severity === 'STALE' ? yellow : issue.severity === 'ORPHAN' ? chalk.magenta : issue.severity === 'DUPE' ? chalk.cyan : red;
    console.log(`   ${color(issue.severity)}  ${issue.message}`);
    if (issue.detail) console.log(`          ${dim(issue.detail)}`);
    console.log(`          ${dim('Recommendation:')} ${issue.recommendation}`);
    console.log('');
  }
}

// Helpers

function entryStatusColor(status: string): string {
  switch (status) {
    case 'fresh': return chalk.green('Fresh');
    case 'active': return chalk.yellow('Active');
    case 'stale': return chalk.dim('Stale');
    default: return status;
  }
}

function healthScoreColor(score: number): string {
  if (score >= 80) return chalk.green(score.toString());
  if (score >= 50) return chalk.yellow(score.toString());
  return chalk.red(score.toString());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`;
  return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? 's' : ''} ago`;
}

function formatDateShort(dateStr: string): string {
  const parts = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2]).toString().padStart(2, ' ')}`;
}

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 100);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

function calculateOverlap(a: string, b: string): number {
  // Simple line-based overlap calculation
  const linesA = new Set(a.split('\n').filter(l => l.trim().length > 10));
  const linesB = new Set(b.split('\n').filter(l => l.trim().length > 10));
  if (linesA.size === 0 || linesB.size === 0) return 0;

  let overlap = 0;
  for (const line of linesA) {
    if (linesB.has(line)) overlap++;
  }

  return overlap / Math.min(linesA.size, linesB.size);
}
