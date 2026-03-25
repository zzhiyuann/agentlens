import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { heading, dim, green } from '../utils/format';

export function initCommand(): void {
  const projectDir = path.join(process.cwd(), '.agentlens');
  const testsDir = path.join(projectDir, 'tests');

  if (fs.existsSync(path.join(projectDir, 'config.yaml'))) {
    console.log(chalk.yellow('\n AgentLens is already initialized in this project.\n'));
    console.log(` Config: ${path.join(projectDir, 'config.yaml')}`);
    return;
  }

  console.log(` ${heading('Initializing AgentLens...')}\n`);

  // Create directories
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });

  // Write config
  const config = {
    adapter: 'claude-code',
    storage: {
      path: '~/.agentlens/traces.db',
      maxSize: '500mb',
    },
    display: {
      theme: 'dark',
      colors: true,
    },
    recording: {
      autoLabel: true,
      maxDuration: '30m',
    },
    memory: {
      staleDays: 14,
    },
  };

  fs.writeFileSync(
    path.join(projectDir, 'config.yaml'),
    yaml.dump(config),
    'utf-8'
  );
  console.log(green('   Created .agentlens/config.yaml'));

  // Write example test scenario
  const exampleScenario = {
    name: 'Example: Code review flow',
    description: 'Tests that the agent performs a code review with expected tool calls',
    agents: [
      { role: 'code-reviewer', model: 'claude-sonnet-4-6' },
    ],
    scenario: [
      { user: 'Review the changes in auth.ts for security issues' },
      {
        assert: {
          tool_called: 'read_file',
          response_contains: 'security',
        },
      },
      {
        assert: {
          cost_under: 0.10,
        },
      },
    ],
    settings: {
      timeout: 30000,
    },
  };

  fs.writeFileSync(
    path.join(testsDir, 'example.yaml'),
    yaml.dump(exampleScenario),
    'utf-8'
  );
  console.log(green('   Created .agentlens/tests/example.yaml'));

  // Write .gitignore
  const gitignore = `# AgentLens local data
traces.db
*.db-wal
*.db-shm
`;
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore, 'utf-8');
  console.log(green('   Created .agentlens/.gitignore'));

  console.log(`\n ${heading('Next steps:')}`);
  console.log(`   1. Record your first session:  ${chalk.cyan('alens record claude "your task"')}`);
  console.log(`   2. View the recording:         ${chalk.cyan('alens inspect <session-id>')}`);
  console.log(`   3. Step through it:            ${chalk.cyan('alens replay <session-id>')}`);
  console.log('');
}
