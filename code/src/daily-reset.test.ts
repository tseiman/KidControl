import { describe, expect, it } from 'vitest';
import { nextDailyReset, resetOccurrence } from './daily-reset.js';

describe('Europe/Berlin daily reset scheduling', () => {
  it('chooses the next occurrence without treating an already-passed time as due', () => {
    expect(nextDailyReset(new Date('2026-07-31T12:00:00Z'), '09:30').toISOString()).toBe('2026-08-01T07:30:00.000Z');
    expect(nextDailyReset(new Date('2026-07-31T07:29:59Z'), '09:30').toISOString()).toBe('2026-07-31T07:30:00.000Z');
  });

  it('uses the first valid instant after a nonexistent spring-forward wall time', () => {
    expect(resetOccurrence('2026-03-29', '02:30').toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('uses only the first occurrence of a repeated fall-back wall time', () => {
    expect(resetOccurrence('2026-10-25', '02:30').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(nextDailyReset(new Date('2026-10-25T00:45:00Z'), '02:30').toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });
});
