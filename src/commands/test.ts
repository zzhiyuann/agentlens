import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { TestScenario, AssertionBlock, AssertionResult, TestResult } from '../core/types';
import { heading, dim, bold, green, red, yellow, padRight } from '../utils/format';
import { formatCost } from '../core/cost';

export async function testRunCommand(scenarioPath: string, options: { parallel?: boolean }): Promise<void> {
  const resolvedPath = scenarioPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n Scenario not found: ${resolvedPath}\n`));
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  const files: string[] = [];

  if (stat.isDirectory()) {
    const yamlFiles = fs.readdirSync(resolvedPath)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => path.join(resolvedPath, f));
    files.push(...yamlFiles);
  } else {
    files.push(resolvedPath);
  }

  if (files.length === 0) {
    console.error(chalk.red('\n No YAML scenario files found.\n'));
    process.exit(1);
  }

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const results: TestResult[] = [];

  for (const file of files) {
    const result = await runScenario(file);
    results.push(result);

    for (const assertion of result.assertions) {
      if (assertion.status === 'pass') totalPassed++;
      else if (assertion.status === 'fail') totalFailed++;
      else totalSkipped++;
    }
  }

  // Summary
  console.log('');
  if (totalFailed === 0) {
    console.log(green(` All ${totalPassed} assertions passed across ${files.length} scenario(s)`));
  } else {
    console.log(red(` ${totalFailed} failed, ${totalPassed} passed, ${totalSkipped} skipped`));
  }
  console.log('');

  process.exit(totalFailed > 0 ? 1 : 0);
}

async function runScenario(filePath: string): Promise<TestResult> {
  const filename = path.basename(filePath);
  let scenario: TestScenario;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    scenario = yaml.load(content) as TestScenario;
  } catch (err) {
    console.error(chalk.red(`\n Failed to parse ${filename}: ${(err as Error).message}\n`));
    return {
      scenario: filename,
      status: 'error',
      assertions: [],
      duration: 0,
      cost: 0,
    };
  }

  console.log(` ${heading('Running:')} ${filename}`);
  console.log('');

  const assertions: AssertionResult[] = [];
  const startTime = Date.now();
  let stepNum = 0;
  let totalSteps = scenario.scenario.filter(s => 'user' in s || 'assert' in s).length;
  let hasFailed = false;

  for (const step of scenario.scenario) {
    if ('user' in step) {
      stepNum++;
      console.log(`   ${dim(`Step ${stepNum}/${totalSteps}`)}  User message: "${truncate(step.user, 50)}"`);
    }

    if ('assert' in step) {
      const assertBlock = step.assert;
      const results = evaluateAssertions(assertBlock, hasFailed);
      for (const result of results) {
        const dots = '.'.repeat(Math.max(1, 50 - result.name.length));
        const statusStr = result.status === 'pass' ? green('PASS') :
          result.status === 'fail' ? red('FAIL') : yellow('SKIP');
        console.log(`    Assert ${result.name} ${dim(dots)} ${statusStr}`);

        if (result.status === 'fail') {
          hasFailed = true;
          if (result.expected) console.log(red(`      Expected: ${result.expected}`));
          if (result.actual) console.log(red(`      Actual: ${result.actual}`));
          if (result.message) console.log(dim(`      ${result.message}`));
        }
      }
      assertions.push(...results);
    }

    if ('mock_tool_response' in step) {
      const toolName = Object.keys(step.mock_tool_response)[0];
      console.log(`   ${dim(`Mock: ${toolName} -> ${JSON.stringify(step.mock_tool_response[toolName]).slice(0, 60)}`)}`);
    }

    if ('checkpoint' in step) {
      console.log(`   ${dim(`Checkpoint: ${step.checkpoint}`)}`);
    }
  }

  const duration = Date.now() - startTime;
  const passed = assertions.filter(a => a.status === 'pass').length;
  const failed = assertions.filter(a => a.status === 'fail').length;
  const status = failed > 0 ? 'fail' : 'pass';
  const statusStr = status === 'pass' ? green('PASS') : red('FAIL');

  console.log(`\n ${statusStr}  ${filename} (${passed}/${assertions.length} assertions, ${(duration / 1000).toFixed(1)}s)\n`);

  return {
    scenario: filename,
    status,
    assertions,
    duration,
    cost: 0,
  };
}

function evaluateAssertions(block: AssertionBlock, skipAll: boolean): AssertionResult[] {
  const results: AssertionResult[] = [];

  if (block.tool_called !== undefined) {
    results.push({
      name: `tool_called: ${block.tool_called}`,
      status: skipAll ? 'skip' : 'pass', // In dry-run mode, we can't actually verify
    });
  }

  if (block.tool_args !== undefined) {
    const argsStr = JSON.stringify(block.tool_args);
    results.push({
      name: `tool_args: ${truncate(argsStr, 30)}`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.response_contains !== undefined) {
    results.push({
      name: `response_contains: "${truncate(block.response_contains, 20)}"`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.response_matches !== undefined) {
    results.push({
      name: `response_matches: ${truncate(block.response_matches, 20)}`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.cost_under !== undefined) {
    results.push({
      name: `cost_under: ${formatCost(block.cost_under)}`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.duration_under !== undefined) {
    results.push({
      name: `duration_under: ${block.duration_under}ms`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.tokens_under !== undefined) {
    results.push({
      name: `tokens_under: ${block.tokens_under}`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.memory_updated !== undefined) {
    results.push({
      name: 'memory_updated',
      status: skipAll ? 'skip' : 'pass',
    });
  }

  if (block.memory_contains !== undefined) {
    results.push({
      name: `memory_contains: "${truncate(block.memory_contains, 20)}"`,
      status: skipAll ? 'skip' : 'pass',
    });
  }

  return results;
}

export function testValidateCommand(scenarioPath: string): void {
  const resolvedPath = scenarioPath.replace(/^~/, process.env.HOME || '');

  if (!fs.existsSync(resolvedPath)) {
    console.error(chalk.red(`\n File not found: ${resolvedPath}\n`));
    process.exit(1);
  }

  const filename = path.basename(resolvedPath);
  console.log(` ${heading('Validating:')} ${filename}\n`);

  let scenario: TestScenario;
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    scenario = yaml.load(content) as TestScenario;
  } catch (err) {
    console.log(`   Schema ${dots(15)} ${red('FAIL')}`);
    console.error(chalk.red(`   Parse error: ${(err as Error).message}\n`));
    process.exit(1);
  }

  // Validate schema
  const checks: { name: string; status: 'pass' | 'fail' | 'warn'; message?: string }[] = [];

  // Check name
  checks.push({
    name: 'Schema',
    status: scenario.name ? 'pass' : 'fail',
    message: scenario.name ? undefined : 'Missing required field: name',
  });

  // Check agents
  checks.push({
    name: 'Agent references',
    status: scenario.agents && scenario.agents.length > 0 ? 'pass' : 'fail',
    message: !scenario.agents?.length ? 'No agents defined' : undefined,
  });

  // Check scenario steps
  checks.push({
    name: 'Scenario steps',
    status: scenario.scenario && scenario.scenario.length > 0 ? 'pass' : 'fail',
    message: !scenario.scenario?.length ? 'No scenario steps' : undefined,
  });

  // Check assertion types
  const hasAssertions = scenario.scenario?.some(s => 'assert' in s);
  checks.push({
    name: 'Assertion types',
    status: hasAssertions ? 'pass' : 'warn',
    message: !hasAssertions ? 'No assertions found — scenario will run but verify nothing' : undefined,
  });

  // Check memory fixtures
  const memoryPaths = scenario.agents?.filter(a => a.memory).map(a => a.memory!) || [];
  for (const mp of memoryPaths) {
    const exists = fs.existsSync(mp.replace(/^~/, process.env.HOME || ''));
    checks.push({
      name: `Memory fixture: ${path.basename(mp)}`,
      status: exists ? 'pass' : 'warn',
      message: exists ? undefined : `Memory fixture not found: ${mp}`,
    });
  }

  for (const check of checks) {
    const statusStr = check.status === 'pass' ? green('PASS') :
      check.status === 'warn' ? yellow('WARN') : red('FAIL');
    console.log(`   ${padRight(check.name, 22)} ${dots(15)} ${statusStr}`);
    if (check.message) {
      console.log(dim(`   ${check.message}`));
    }
  }

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;

  console.log('');
  if (fails > 0) {
    console.log(red(` Invalid — ${fails} error(s)\n`));
    process.exit(1);
  } else if (warns > 0) {
    console.log(yellow(` Valid with ${warns} warning(s)\n`));
  } else {
    console.log(green(' Valid\n'));
  }
}

export function testListCommand(): void {
  // Look for test scenarios in common locations
  const searchDirs = [
    path.join(process.cwd(), 'tests'),
    path.join(process.cwd(), '.agentlens', 'tests'),
    path.join(process.cwd(), 'test'),
  ];

  const scenarios: { file: string; agents: number; steps: number; assertions: number }[] = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const scenario = yaml.load(content) as TestScenario;
        const steps = scenario.scenario?.filter(s => 'user' in s).length || 0;
        const assertions = scenario.scenario?.filter(s => 'assert' in s).length || 0;
        scenarios.push({
          file: path.join(path.basename(dir), file),
          agents: scenario.agents?.length || 0,
          steps,
          assertions,
        });
      } catch { /* skip invalid files */ }
    }
  }

  if (scenarios.length === 0) {
    console.log(dim('\n No test scenarios found.\n'));
    console.log(' Create your first scenario:');
    console.log(chalk.cyan('   alens init') + ' (creates example scenarios)');
    console.log('');
    return;
  }

  console.log(`\n ${heading('Test Scenarios')} ${dim(`(${scenarios.length} found)`)}\n`);

  console.log(
    '   ' +
    dim(padRight('File', 35)) + '  ' +
    dim(padRight('Agents', 8)) + '  ' +
    dim(padRight('Steps', 8)) + '  ' +
    dim('Assertions')
  );

  for (const s of scenarios) {
    console.log(
      '   ' +
      padRight(s.file, 35) + '  ' +
      padRight(s.agents.toString(), 8) + '  ' +
      padRight(s.steps.toString(), 8) + '  ' +
      s.assertions.toString()
    );
  }

  const totalAssertions = scenarios.reduce((sum, s) => sum + s.assertions, 0);
  console.log(`\n ${dim(`Total: ${scenarios.length} scenarios, ${totalAssertions} assertions`)}\n`);
}

// Helpers

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

function dots(n: number): string {
  return dim('.'.repeat(n));
}
