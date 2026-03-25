import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AlensConfig } from './types';

const DEFAULT_CONFIG: AlensConfig = {
  adapter: 'claude-code',
  storage: {
    path: path.join(getGlobalConfigDir(), 'traces.db'),
    maxSize: '500mb',
  },
  display: {
    theme: 'dark',
    colors: true,
    unicode: true,
    pageSize: 20,
  },
  recording: {
    autoLabel: true,
    captureEnv: false,
    maxDuration: '30m',
  },
  memory: {
    staleDays: 14,
    healthCheck: true,
  },
  cost: {
    rates: {
      'claude-opus-4-6': { input: 15.0, output: 75.0 },
      'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
      'claude-haiku-4-5': { input: 0.8, output: 4.0 },
      'gpt-4o': { input: 2.5, output: 10.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
    },
  },
};

function getGlobalConfigDir(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || '~', '.agentlens');
}

function getLocalConfigDir(): string {
  return path.join(process.cwd(), '.agentlens');
}

function loadYamlConfig(filePath: string): Partial<AlensConfig> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(content) as Partial<AlensConfig>;
  } catch {
    return null;
  }
}

function deepMerge(base: AlensConfig, override: Partial<AlensConfig>): AlensConfig {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const val = (override as Record<string, unknown>)[key];
    if (val !== undefined && val !== null) {
      if (typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object') {
        result[key] = { ...(result[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        result[key] = val;
      }
    }
  }
  return result as unknown as AlensConfig;
}

export function loadConfig(): AlensConfig {
  let config = { ...DEFAULT_CONFIG };

  // Global config: ~/.agentlens/config.yaml
  const globalPath = path.join(getGlobalConfigDir(), 'config.yaml');
  const globalConfig = loadYamlConfig(globalPath);
  if (globalConfig) {
    config = deepMerge(config, globalConfig);
  }

  // Local config: .agentlens/config.yaml (takes precedence)
  const localPath = path.join(getLocalConfigDir(), 'config.yaml');
  const localConfig = loadYamlConfig(localPath);
  if (localConfig) {
    config = deepMerge(config, localConfig);
  }

  // Resolve storage path
  config.storage.path = config.storage.path.replace(/^~/, process.env.HOME || '');

  return config;
}

export function getConfigValue(key: string): unknown {
  const config = loadConfig();
  const parts = key.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setConfigValue(key: string, value: string): void {
  const localDir = getLocalConfigDir();
  const localPath = path.join(localDir, 'config.yaml');

  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(localPath)) {
    config = (yaml.load(fs.readFileSync(localPath, 'utf-8')) as Record<string, unknown>) || {};
  }

  // Set nested value
  const parts = key.split('.');
  let current = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  // Parse value type
  if (value === 'true') current[parts[parts.length - 1]] = true;
  else if (value === 'false') current[parts[parts.length - 1]] = false;
  else if (!isNaN(Number(value))) current[parts[parts.length - 1]] = Number(value);
  else current[parts[parts.length - 1]] = value;

  fs.writeFileSync(localPath, yaml.dump(config), 'utf-8');
}

export function ensureGlobalDir(): string {
  const dir = getGlobalConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export { getGlobalConfigDir, getLocalConfigDir, DEFAULT_CONFIG };
