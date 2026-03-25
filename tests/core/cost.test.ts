import { describe, it, expect } from 'vitest';
import { calculateCost, formatCost, getModelRates } from '../../src/core/cost';

describe('Cost calculation', () => {
  it('calculates cost for claude-sonnet-4-6', () => {
    const cost = calculateCost('claude-sonnet-4-6', 10000, 5000);
    // Input: 10000 / 1M * 3.0 = 0.03
    // Output: 5000 / 1M * 15.0 = 0.075
    // Total: 0.105
    expect(cost).toBeCloseTo(0.105, 4);
  });

  it('calculates cost for claude-opus-4-6', () => {
    const cost = calculateCost('claude-opus-4-6', 10000, 5000);
    // Input: 10000 / 1M * 15.0 = 0.15
    // Output: 5000 / 1M * 75.0 = 0.375
    // Total: 0.525
    expect(cost).toBeCloseTo(0.525, 4);
  });

  it('returns 0 for unknown models', () => {
    const cost = calculateCost('unknown-model-123', 10000, 5000);
    expect(cost).toBe(0);
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', 0, 0);
    expect(cost).toBe(0);
  });
});

describe('formatCost', () => {
  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('formats small costs with precision', () => {
    expect(formatCost(0.003)).toBe('$0.0030');
  });

  it('formats normal costs', () => {
    expect(formatCost(0.47)).toBe('$0.47');
  });

  it('formats large costs', () => {
    expect(formatCost(12.34)).toBe('$12.34');
  });
});

describe('getModelRates', () => {
  it('returns rates for known models', () => {
    const rates = getModelRates('claude-sonnet-4-6');
    expect(rates).toBeTruthy();
    expect(rates!.input).toBe(3.0);
    expect(rates!.output).toBe(15.0);
  });

  it('returns null for unknown models', () => {
    const rates = getModelRates('nonexistent-model');
    expect(rates).toBeNull();
  });
});
