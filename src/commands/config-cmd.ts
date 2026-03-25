import chalk from 'chalk';
import * as yaml from 'js-yaml';
import { loadConfig, getConfigValue, setConfigValue, getLocalConfigDir, getGlobalConfigDir } from '../core/config';
import { heading, dim, bold } from '../utils/format';

export function configCommand(options: { key?: string; value?: string }): void {
  if (options.key && options.value) {
    // Set mode
    setConfigValue(options.key, options.value);
    console.log(chalk.green(` Set ${options.key} = ${options.value}`));
    return;
  }

  if (options.key) {
    // Get single value
    const val = getConfigValue(options.key);
    if (val === undefined) {
      console.error(chalk.red(` Unknown config key: ${options.key}`));
      process.exit(1);
    }
    console.log(typeof val === 'object' ? yaml.dump(val).trim() : String(val));
    return;
  }

  // Show all config
  const config = loadConfig();
  console.log(`\n ${heading('AgentLens Configuration')}\n`);
  console.log(` ${dim('Global config:')} ${getGlobalConfigDir()}/config.yaml`);
  console.log(` ${dim('Local config:')}  ${getLocalConfigDir()}/config.yaml`);
  console.log('');
  console.log(yaml.dump(config).split('\n').map(l => `   ${l}`).join('\n'));
}
