import { describe, it, expect } from 'vitest';
import { sessionId, spanId } from '../../src/core/ids';

describe('ID generation', () => {
  it('sessionId starts with ses_ prefix', () => {
    const id = sessionId();
    expect(id).toMatch(/^ses_[a-zA-Z0-9_-]+$/);
  });

  it('spanId starts with spn_ prefix', () => {
    const id = spanId();
    expect(id).toMatch(/^spn_[a-zA-Z0-9_-]+$/);
  });

  it('generates unique session IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => sessionId()));
    expect(ids.size).toBe(100);
  });

  it('generates unique span IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => spanId()));
    expect(ids.size).toBe(100);
  });
});
