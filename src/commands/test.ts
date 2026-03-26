import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { TestScenario, AssertionBlock, AssertionResult, TestResult, TestContext, Span } from '../core/types';
import { heading, dim, bold, green, red, yellow, padRight } from '../utils/format';
import { formatCost } from '../core/cost';
import { getSession, getSpansForSession, listSessions } from '../core/storage';

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

function resolveSession(scenario: TestScenario): { sessionId: string; spans: Span[] } | null {
  // 1. Explicit session ID in settings
  if (scenario.settings?.session) {
    const session = getSession(scenario.settings.session);
    if (session) {
      return { sessionId: session.id, spans: session.spans };
    }
    // Session ID specified but not found — try as a label
    const byLabel = findSessionByLabel(scenario.settings.session);
    if (byLabel) return byLabel;
    return null;
  }

  // 2. Auto-match by scenario name as label
  return findSessionByLabel(scenario.name);
}

function findSessionByLabel(label: string): { sessionId: string; spans: Span[] } | null {
  const { sessions } = listSessions({ label, limit: 1 });
  if (sessions.length > 0) {
    const session = sessions[0];
    const spans = getSpansForSession(session.id);
    return { sessionId: session.id, spans };
  }
  return null;
}

function buildInitialContext(sessionId: string, spans: Span[]): TestContext {
  const toolSpans = spans.filter(s => s.type === 'tool' && s.tool);
  const llmSpans = spans.filter(s => s.type === 'llm' && s.llm);

  const totalCost = llmSpans.reduce((sum, s) => sum + (s.llm?.cost ?? 0), 0);
  const totalTokens = llmSpans.reduce((sum, s) => sum + (s.llm?.inputTokens ?? 0) + (s.llm?.outputTokens ?? 0), 0);
  const totalDuration = spans.reduce((sum, s) => sum + s.duration, 0);

  return {
    sessionId,
    spans,
    currentSpanIndex: 0,
    lastResponse: '',
    toolsCalled: toolSpans.map(s => s.tool!.name),
    toolArgs: toolSpans.map(s => s.tool!.arguments as Record<string, unknown>),
    totalCost,
    totalTokens,
    totalDuration,
  };
}

function advanceContextToNextLLMSpan(context: TestContext): void {
  // Find the next LLM span from the current position
  for (let i = context.currentSpanIndex; i < context.spans.length; i++) {
    const span = context.spans[i];
    if (span.type === 'llm' && span.llm) {
      context.lastResponse = span.llm.response;
      context.currentSpanIndex = i + 1;

      // Accumulate tool calls from spans between the previous position and this LLM span
      for (let j = context.currentSpanIndex === 1 ? 0 : context.currentSpanIndex - 1; j < i; j++) {
        const toolSpan = context.spans[j];
        if (toolSpan.type === 'tool' && toolSpan.tool) {
          // These are already in the initial context, but we track the index
        }
      }
      return;
    }
  }
  // No more LLM spans — leave context unchanged
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

  // Attempt to resolve a recorded session for replay
  let context: TestContext | null = null;
  const resolved = resolveSession(scenario);

  if (resolved) {
    context = buildInitialContext(resolved.sessionId, resolved.spans);
    console.log(`   ${dim(`Replaying against session: ${resolved.sessionId} (${resolved.spans.length} spans)`)}`);
  } else {
    const reason = scenario.settings?.session
      ? `Specified session "${scenario.settings.session}" not found`
      : 'No matching recorded session found';
    console.log(`   ${dim(`Dry-run mode: ${reason}`)}`);
  }
  console.log('');

  const assertions: AssertionResult[] = [];
  const startTime = Date.now();
  let stepNum = 0;
  const totalSteps = scenario.scenario.filter(s => 'user' in s || 'assert' in s).length;
  let hasFailed = false;

  for (const step of scenario.scenario) {
    if ('user' in step) {
      stepNum++;
      console.log(`   ${dim(`Step ${stepNum}/${totalSteps}`)}  User message: "${truncate(step.user, 50)}"`);

      // In replay mode, advance context to the next LLM span
      if (context) {
        advanceContextToNextLLMSpan(context);
      }
    }

    if ('assert' in step) {
      const assertBlock = step.assert;
      const results = evaluateAssertions(assertBlock, context, hasFailed);
      for (const result of results) {
        const dotsStr = '.'.repeat(Math.max(1, 50 - result.name.length));
        const statusStr = result.status === 'pass' ? green('PASS') :
          result.status === 'fail' ? red('FAIL') : yellow('SKIP');
        console.log(`    Assert ${result.name} ${dim(dotsStr)} ${statusStr}`);

        if (result.status === 'fail') {
          hasFailed = true;
          if (result.expected) console.log(red(`      Expected: ${result.expected}`));
          if (result.actual) console.log(red(`      Actual: ${result.actual}`));
          if (result.message) console.log(dim(`      ${result.message}`));
        }
        if (result.status === 'skip' && result.message) {
          console.log(dim(`      ${result.message}`));
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
  const cost = context?.totalCost ?? 0;

  console.log(`\n ${statusStr}  ${filename} (${passed}/${assertions.length} assertions, ${(duration / 1000).toFixed(1)}s)\n`);

  return {
    scenario: filename,
    status,
    assertions,
    duration,
    cost,
  };
}

function deepPartialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) return true;
  if (actual === undefined || actual === null) return false;

  if (typeof expected !== 'object') {
    return String(actual) === String(expected);
  }

  if (typeof actual !== 'object') return false;

  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;

  for (const key of Object.keys(expectedObj)) {
    if (!(key in actualObj)) return false;
    if (!deepPartialMatch(actualObj[key], expectedObj[key])) return false;
  }
  return true;
}

function evaluateAssertions(block: AssertionBlock, context: TestContext | null, skipAll: boolean): AssertionResult[] {
  const results: AssertionResult[] = [];
  const noSession = context === null;
  const skipReason = skipAll ? 'Skipped due to prior failure' : 'No recorded session available for replay';

  if (block.tool_called !== undefined) {
    const name = `tool_called: ${block.tool_called}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const found = context.toolsCalled.includes(block.tool_called);
      results.push({
        name,
        status: found ? 'pass' : 'fail',
        expected: `Tool "${block.tool_called}" to be called`,
        actual: found ? undefined : `Tools called: [${context.toolsCalled.join(', ')}]`,
      });
    }
  }

  if (block.tool_args !== undefined) {
    const argsStr = JSON.stringify(block.tool_args);
    const name = `tool_args: ${truncate(argsStr, 30)}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const matched = context.toolArgs.some(args => deepPartialMatch(args, block.tool_args));
      results.push({
        name,
        status: matched ? 'pass' : 'fail',
        expected: `Tool args matching ${argsStr}`,
        actual: matched ? undefined : `No tool call matched the expected args`,
      });
    }
  }

  if (block.response_contains !== undefined) {
    const name = `response_contains: "${truncate(block.response_contains, 20)}"`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const found = context.lastResponse.includes(block.response_contains);
      results.push({
        name,
        status: found ? 'pass' : 'fail',
        expected: `Response to contain "${block.response_contains}"`,
        actual: found ? undefined : `Response: "${truncate(context.lastResponse, 80)}"`,
      });
    }
  }

  if (block.response_matches !== undefined) {
    const name = `response_matches: ${truncate(block.response_matches, 20)}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      let matched = false;
      let regexError: string | null = null;
      try {
        const regex = new RegExp(block.response_matches, 's');
        matched = regex.test(context.lastResponse);
      } catch (err) {
        regexError = (err as Error).message;
      }
      if (regexError) {
        results.push({
          name,
          status: 'fail',
          message: `Invalid regex: ${regexError}`,
        });
      } else {
        results.push({
          name,
          status: matched ? 'pass' : 'fail',
          expected: `Response to match /${block.response_matches}/`,
          actual: matched ? undefined : `Response: "${truncate(context.lastResponse, 80)}"`,
        });
      }
    }
  }

  if (block.cost_under !== undefined) {
    const name = `cost_under: ${formatCost(block.cost_under)}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const under = context.totalCost < block.cost_under;
      results.push({
        name,
        status: under ? 'pass' : 'fail',
        expected: `Cost < ${formatCost(block.cost_under)}`,
        actual: under ? undefined : `Cost: ${formatCost(context.totalCost)}`,
      });
    }
  }

  if (block.duration_under !== undefined) {
    const name = `duration_under: ${block.duration_under}ms`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const under = context.totalDuration < block.duration_under;
      results.push({
        name,
        status: under ? 'pass' : 'fail',
        expected: `Duration < ${block.duration_under}ms`,
        actual: under ? undefined : `Duration: ${context.totalDuration}ms`,
      });
    }
  }

  if (block.tokens_under !== undefined) {
    const name = `tokens_under: ${block.tokens_under}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      const under = context.totalTokens < block.tokens_under;
      results.push({
        name,
        status: under ? 'pass' : 'fail',
        expected: `Tokens < ${block.tokens_under}`,
        actual: under ? undefined : `Tokens: ${context.totalTokens}`,
      });
    }
  }

  if (block.memory_updated !== undefined) {
    const name = 'memory_updated';
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else if (!context.memoryBefore || !context.memoryAfter) {
      results.push({ name, status: 'skip', message: 'No memory snapshots available' });
    } else {
      const changed = JSON.stringify(context.memoryBefore.entries) !== JSON.stringify(context.memoryAfter.entries);
      const expected = block.memory_updated;
      const passed = changed === expected;
      results.push({
        name,
        status: passed ? 'pass' : 'fail',
        expected: expected ? 'Memory to be updated' : 'Memory to be unchanged',
        actual: passed ? undefined : (changed ? 'Memory was updated' : 'Memory was not updated'),
      });
    }
  }

  if (block.memory_contains !== undefined) {
    const name = `memory_contains: "${truncate(block.memory_contains, 20)}"`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else if (!context.memoryAfter) {
      results.push({ name, status: 'skip', message: 'No memory snapshot available' });
    } else {
      const found = context.memoryAfter.entries.some(
        entry => entry.content.includes(block.memory_contains!) || entry.title.includes(block.memory_contains!)
      );
      results.push({
        name,
        status: found ? 'pass' : 'fail',
        expected: `Memory to contain "${block.memory_contains}"`,
        actual: found ? undefined : `No memory entry matched`,
      });
    }
  }

  if (block.custom !== undefined) {
    const name = `custom: ${truncate(block.custom, 30)}`;
    if (skipAll || noSession) {
      results.push({ name, status: 'skip', message: skipReason });
    } else {
      try {
        // Evaluate expression with context variables available
        const fn = new Function(
          'ctx',
          'spans', 'toolsCalled', 'toolArgs', 'lastResponse',
          'totalCost', 'totalTokens', 'totalDuration',
          `return (${block.custom});`
        );
        const result = fn(
          context,
          context.spans, context.toolsCalled, context.toolArgs, context.lastResponse,
          context.totalCost, context.totalTokens, context.totalDuration
        );
        results.push({
          name,
          status: result ? 'pass' : 'fail',
          expected: `Expression to be truthy`,
          actual: result ? undefined : `Expression evaluated to ${JSON.stringify(result)}`,
        });
      } catch (err) {
        results.push({
          name,
          status: 'fail',
          message: `Expression error: ${(err as Error).message}`,
        });
      }
    }
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
