#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { recordCommand } from './commands/record';
import { listCommand } from './commands/list';
import { inspectCommand } from './commands/inspect';
import { replayCommand } from './commands/replay';
import { diffCommand } from './commands/diff';
import { memoryShowCommand, memoryDiffCommand, memoryTimelineCommand, memoryHealthCommand } from './commands/memory';
import { testRunCommand, testValidateCommand, testListCommand } from './commands/test';
import { statsCommand } from './commands/stats';
import { initCommand } from './commands/init';
import { configCommand } from './commands/config-cmd';
import { exportCommand } from './commands/export';
import { importCommand } from './commands/import';

const program = new Command();

program
  .name('alens')
  .description('Chrome DevTools for AI agents — record, replay, inspect, and test agent sessions')
  .version('0.1.0');

// Default action (no command) — show getting started
program.action(() => {
  console.log(chalk.bold.cyan('\n AgentLens') + chalk.dim(' v0.1.0') + chalk.dim(' — Chrome DevTools for AI agents'));
  console.log('');
  console.log(' Getting started:');
  console.log(`   1. Record a session:    ${chalk.cyan('alens record claude "your task"')}`);
  console.log(`   2. List recordings:     ${chalk.cyan('alens list')}`);
  console.log(`   3. Replay a session:    ${chalk.cyan('alens replay <session-id>')}`);
  console.log('');
  console.log(' More commands:');
  console.log(`   ${chalk.cyan('alens memory show <path>')}    Inspect agent memory`);
  console.log(`   ${chalk.cyan('alens test run <file>')}       Run test scenarios`);
  console.log(`   ${chalk.cyan('alens --help')}                Full command reference`);
  console.log('');
});

// --- Session Debugger ---

program
  .command('record')
  .description('Record an agent session')
  .option('-l, --label <label>', 'Session label')
  .argument('[command...]', 'Command to record')
  .action((commandArgs: string[], opts: { label?: string }) => {
    recordCommand(commandArgs, opts);
  });

program
  .command('list')
  .description('List recorded sessions')
  .option('-l, --label <pattern>', 'Filter by label (supports wildcards)')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('-s, --since <duration>', 'Show sessions since (e.g., 2h, 3d, 1w)')
  .option('-c, --cost <threshold>', 'Filter by cost (e.g., ">0.50")')
  .option('-n, --limit <number>', 'Number of sessions to show', '20')
  .action((opts: { label?: string; agent?: string; since?: string; cost?: string; limit?: string }) => {
    listCommand({ ...opts, limit: opts.limit ? parseInt(opts.limit) : undefined });
  });

program
  .command('inspect')
  .description('Detailed view of a session')
  .argument('<session-id>', 'Session ID')
  .option('-s, --section <section>', 'Show specific section (calls, tools, cost, summary)')
  .option('-v, --verbose', 'Show expanded details')
  .action((sessionId: string, opts: { section?: string; verbose?: boolean }) => {
    inspectCommand(sessionId, opts);
  });

program
  .command('replay')
  .description('Interactive step-through replay')
  .argument('<session-id>', 'Session ID')
  .option('--step <number>', 'Start at step number')
  .action((sessionId: string, opts: { step?: string }) => {
    replayCommand(sessionId, { step: opts.step ? parseInt(opts.step) : undefined });
  });

program
  .command('diff')
  .description('Compare two sessions side by side')
  .argument('<session-a>', 'First session ID')
  .argument('<session-b>', 'Second session ID')
  .action((a: string, b: string) => {
    diffCommand(a, b);
  });

program
  .command('export')
  .description('Export session (json, markdown, html)')
  .argument('<session-id>', 'Session ID')
  .option('-f, --format <format>', 'Output format (json, markdown, html)', 'json')
  .action((sessionId: string, opts: { format?: string }) => {
    exportCommand(sessionId, opts);
  });

program
  .command('import')
  .description('Import a JSONL session file')
  .argument('<file>', 'JSONL file to import')
  .option('-l, --label <label>', 'Session label')
  .option('-a, --agent <agent>', 'Agent name override')
  .action((file: string, opts: { label?: string; agent?: string }) => {
    importCommand(file, opts);
  });

// --- Memory Inspector ---

const memory = program
  .command('memory')
  .description('Inspect agent memory');

memory
  .command('show')
  .description('View memory state')
  .argument('<path>', 'Path to memory directory')
  .option('--stats', 'Show statistics')
  .action((memPath: string, opts: { stats?: boolean }) => {
    memoryShowCommand(memPath, opts);
  });

memory
  .command('diff')
  .description('Show memory changes over time')
  .argument('<path>', 'Path to memory directory')
  .option('--from <ref>', 'Start reference (git ref or date)')
  .option('--to <ref>', 'End reference (default: HEAD)')
  .action((memPath: string, opts: { from?: string; to?: string }) => {
    memoryDiffCommand(memPath, opts);
  });

memory
  .command('timeline')
  .description('Memory evolution timeline')
  .argument('<path>', 'Path to memory directory')
  .option('--since <duration>', 'Show timeline since (e.g., "1 month")')
  .action((memPath: string, opts: { since?: string }) => {
    memoryTimelineCommand(memPath, opts);
  });

memory
  .command('health')
  .description('Memory quality report')
  .argument('<path>', 'Path to memory directory')
  .action((memPath: string) => {
    memoryHealthCommand(memPath);
  });

// --- Test Harness ---

const test = program
  .command('test')
  .description('Multi-agent test harness');

test
  .command('run')
  .description('Run test scenarios')
  .argument('<path>', 'Scenario file or directory')
  .option('-p, --parallel', 'Run scenarios in parallel')
  .action((scenarioPath: string, opts: { parallel?: boolean }) => {
    testRunCommand(scenarioPath, opts);
  });

test
  .command('validate')
  .description('Validate scenario files')
  .argument('<path>', 'Scenario file')
  .action((scenarioPath: string) => {
    testValidateCommand(scenarioPath);
  });

test
  .command('list')
  .description('List available test scenarios')
  .action(() => {
    testListCommand();
  });

// --- Global Commands ---

program
  .command('stats')
  .description('Aggregate statistics')
  .option('-s, --since <duration>', 'Show stats since (e.g., 1w, 1m)')
  .action((opts: { since?: string }) => {
    statsCommand(opts);
  });

program
  .command('config')
  .description('View or update configuration')
  .argument('[key]', 'Config key to get/set')
  .argument('[value]', 'Value to set')
  .action((key?: string, value?: string) => {
    configCommand({ key, value });
  });

program
  .command('init')
  .description('Initialize AgentLens in a project')
  .action(() => {
    initCommand();
  });

// Parse and execute
program.parse(process.argv);
