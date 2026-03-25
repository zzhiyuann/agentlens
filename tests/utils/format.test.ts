import { describe, it, expect } from 'vitest';
import { formatDuration, formatTokens, truncate } from '../../src/utils/format';

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(272000)).toBe('4m 32s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3720000)).toBe('1h 02m');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokens(45230)).toBe('45.2K');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokens(1234567)).toBe('1.23M');
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings', () => {
    expect(truncate('hello world test', 10)).toBe('hello wor\u2026');
  });

  it('handles exact length', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});
