import { loadConfig } from './config';

// Default rates per million tokens (USD)
const FALLBACK_RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const config = loadConfig();
  const rates = config.cost.rates[model] || FALLBACK_RATES[model];

  if (!rates) {
    // Unknown model — return 0, we can't estimate
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal precision
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function getModelRates(model: string): { input: number; output: number } | null {
  const config = loadConfig();
  return config.cost.rates[model] || FALLBACK_RATES[model] || null;
}
